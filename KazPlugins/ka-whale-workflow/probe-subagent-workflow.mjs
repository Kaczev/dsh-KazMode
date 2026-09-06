// ka-whale-workflow v0.9 受控子代理 workflow 探针：
//   - includeSubagents=false 时受控 v0.9 子代理仍被治理（不跳过）；
//   - idle 初始化 role 首阶段（worker=assess-complexity，其余=assess-delegation）；
//   - role 专属 [ka-whale-workflow <stage>] 按 pending 注入一次；
//   - report 后等待期（awaitingParent=true）pre-step 不注入/不清 pending，
//     父主 send_message 清门后的下一 pre-step 才注入新 stage 文本；
//   - plugin create/update/retire 注入携带 lifecyclePath；
//   - 受控角色不注入旧通用 SUBAGENT_FLOW_TEXT；旧/未知子代理仅在 includeSubagents=true 时注入。
//   - tools/pre-execute 按 role/stage Allowed tools 软闸门。
// 运行：node KazPlugins/ka-whale-workflow/probe-subagent-workflow.mjs
import plugin, {
  createStageStore,
  SUBAGENT_FLOW_TEXT,
  V09_SUBAGENT_ROLE_INITIAL_STAGES,
} from "./lib/index.js";
import { stageDefinitionFor, stageInjectionText, STAGE_CONTEXT_NOTES } from "./lib/stage-defs.js";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

const TMP = mkdtempSync(join(tmpdir(), "whale-subagent-workflow-"));
const STORE_FILE = join(TMP, "stage.json");
const PLAN_FILE = join(TMP, "plan.json");
const LIFECYCLE_FILE = join(TMP, "PLUGIN_LIFECYCLE.md");
writeFileSync(LIFECYCLE_FILE, "fake lifecycle reference\n", "utf8");

function makeBase({ includeSubagents, stageStoreFile, planFile }) {
  const listeners = new Map();
  const registeredTools = new Map();
  const settings = {
    register(ns, _schema, opts = {}) {
      let current = { ...(opts.base ?? {}) };
      return {
        get: () => ({ ...current }),
        watch: () => () => {},
        update: (patch) => { current = { ...current, ...patch }; return Promise.resolve(); },
      };
    },
    get: () => ({ enabled: true, includeSubagents }),
    update: () => Promise.resolve(),
  };
  const toolsMock = {
    register(def) {
      registeredTools.set(def.name, def);
      return () => registeredTools.delete(def.name);
    },
    schemas() {
      return [...registeredTools.keys()].map((name) => ({ name, description: "", parameters: {} }));
    },
    get(name) {
      return registeredTools.get(name);
    },
  };
  const capturedReports = [];
  const roundReports = [];
  const mockKazMode = {
    pluginConfig: () => ({ enabled: true, includeSubagents }),
    toolVisible: () => true,
  };
  const base = {
    fiber: { state: 0 },
    logger: { info: () => {}, warn: (...a) => console.log("[mock:warn]", ...a), debug: () => {} },
    async plugin() { return; },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return () => {};
    },
    inject(deps, cb) {
      if (deps.includes("settings")) setImmediate(() => cb({ ...base, settings }));
    },
    effect(fn) {
      const dispose = fn();
      return () => { if (typeof dispose === "function") dispose(); };
    },
    provide() { return () => {}; },
    get(name) {
      if (name === "settings") return settings;
      if (name === "tools") return toolsMock;
      if (name === "kazMode") return mockKazMode;
      if (name === "goals") return { get: () => undefined };
      if (name === "roundDisplay") return { report: (payload) => roundReports.push(payload) };
      if (name === "subagents") {
        return {
          reportFrom: async (_child, content, options) => {
            capturedReports.push({ content, options });
            return "report-1";
          },
        };
      }
      return undefined;
    },
    systemPrompt: { section() { return () => {}; } },
    tools: toolsMock,
  };
  return { listeners, registeredTools, base, capturedReports, roundReports };
}

function stageFromFile(file, sessionId) {
  const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw).sessions?.[sessionId] ?? null;
}
function roleRecordFromFile(file, sessionId) {
  const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw).subagentRoles?.[sessionId] ?? null;
}
function pendingFromFile(file, sessionId) {
  const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw).pendingStageInjection?.[sessionId] ?? null;
}
function messageText(messages) {
  return (messages ?? [])
    .map((message) => (message?.content ?? []).map((part) => part?.text ?? "").join("\n"))
    .join("\n");
}
function subagentAgent(id) {
  return { id, session: { id, events: [] }, options: { subagentDepth: 1 } };
}

{
  const roles = ["worker", "memoryMaintainer", "pluginMaintainer"];
  const contextTools = ["context_search", "context_read", "context_compress"];
  check(
    "M3.3 子代理 communication 均含 context_search/context_read/context_compress",
    roles.every((role) => JSON.stringify(stageDefinitionFor(role, "communication")?.allowedTools) === JSON.stringify(contextTools)),
  );
  check(
    "双层语义：受控子代理初始 stage allowedTools 含三 context 工具（Minimal 不再由 stage 收口）",
    roles.every((role) =>
      contextTools.every((tool) =>
        stageDefinitionFor(role, V09_SUBAGENT_ROLE_INITIAL_STAGES[role])?.allowedTools.includes(tool),
      ),
    ),
  );
  check(
    "受控子代理初始 stage allowedTools 仍不含 read",
    roles.every((role) => !stageDefinitionFor(role, V09_SUBAGENT_ROLE_INITIAL_STAGES[role])?.allowedTools.includes("read")),
  );
}

// ---------------------------------------------------------------------------
// Harness 1：includeSubagents=false，但受控 v0.9 子代理必须被治理。
// ---------------------------------------------------------------------------
const h1 = makeBase({ includeSubagents: false, stageStoreFile: STORE_FILE, planFile: PLAN_FILE });
{
  const store = createStageStore(STORE_FILE);
  store.setSubagentRole("child-worker", {
    planItemId: "p-worker",
    persona: "worker",
    assignedTools: [],
    finalTools: ["memory_search", "context_search"],
  });
  store.setSubagentRole("child-memory", {
    planItemId: "p-memory",
    persona: "memoryMaintainer",
    assignedTools: [],
    finalTools: ["memory_search", "context_search"],
  });
  store.setSubagentRole("child-plugin-maintainer-create", {
    planItemId: "p-pm-create",
    persona: "pluginMaintainer",
    assignedTools: [],
    finalTools: ["read", "context_read", "context_search", "write", "plugin_maintainer_sub_whale_report"],
  });
  // Seed one controlled subagent already at a plugin lifecycle stage so the probe
  // can assert lifecyclePath is injected through the runtime pre-step path.
  store.set("child-plugin-maintainer-create", "create-plugin");
  store.setPendingStageInjection("child-plugin-maintainer-create", "create-plugin");
}
await plugin.apply(h1.base, {
  stageStore: STORE_FILE,
  taskPlanStore: PLAN_FILE,
  lifecyclePath: LIFECYCLE_FILE,
});
await new Promise((resolve) => setTimeout(resolve, 20));

const claimed = h1.listeners.get("agent/inbox/claimed")?.[0];
const preExecute = h1.listeners.get("tools/pre-execute")?.[0];
const preStep = h1.listeners.get("agent/pre-step")?.[0];
const userMessage = { content: [{ type: "text", text: "delegation" }], source: { kind: "user" } };
const nextEnter = async () => ({ kind: "enter", messages: [] });

check("V09_SUBAGENT_ROLE_INITIAL_STAGES 映射正确且无 pluginCreator", V09_SUBAGENT_ROLE_INITIAL_STAGES.worker === "assess-complexity" && V09_SUBAGENT_ROLE_INITIAL_STAGES.memoryMaintainer === "assess-delegation" && V09_SUBAGENT_ROLE_INITIAL_STAGES.pluginMaintainer === "assess-delegation" && V09_SUBAGENT_ROLE_INITIAL_STAGES.pluginCreator === undefined);
check("plugin_creator_sub_whale_report 未注册", h1.registeredTools.has("plugin_creator_sub_whale_report") === false);

// Worker: includeSubagents=false 下 inbox claim 不跳过，idle 进入 assess-complexity。
{
  const agent = subagentAgent("child-worker");
  await claimed({ agent, message: userMessage, turn: 1 });
  check("includeSubagents=false：worker 受控子代理仍进入 assess-complexity", stageFromFile(STORE_FILE, "child-worker") === "assess-complexity");
  const decision = await preStep({ agent, turn: 1, messages: [] }, nextEnter);
  const text = messageText(decision?.messages ?? []);
  check("worker 注入 role stage 文本", text.includes("[ka-whale-workflow assess-complexity]") && text.includes("work_sub_whale_report"));
  check("worker 不注入旧通用 SUBAGENT_FLOW_TEXT", !text.includes("[ka-whale-workflow subagent flow]"));
  check("worker 注入后 pending 已清除", pendingFromFile(STORE_FILE, "child-worker") === null);
  check(
    "Context 注记：worker/maintenance 目标 stage 注入注记，无注记 stage 不输出",
    STAGE_CONTEXT_NOTES?.worker?.["assess-complexity"] !== undefined &&
      stageInjectionText("worker", "assess-complexity").includes("Context: ") &&
      stageInjectionText("worker", "challenge-plan").includes("Context: ") &&
      stageInjectionText("worker", "communication").includes("Context: ") &&
      stageInjectionText("memoryMaintainer", "communication").includes("Context: ") &&
      stageInjectionText("pluginMaintainer", "communication").includes("Context: ") &&
      !stageInjectionText("memoryMaintainer", "assess-delegation").includes("Context:") &&
      !stageInjectionText("pluginMaintainer", "create-plugin").includes("Context:"),
  );
  const deny = await preExecute({ name: "read", agent }, async () => ({ kind: "allow" }));
  const allow = await preExecute({ name: "memory_search", agent }, async () => ({ kind: "allow" }));
  const allowCtxRead = await preExecute({ name: "context_read", agent }, async () => ({ kind: "allow" }));
  const allowCtxCompress = await preExecute({ name: "context_compress", agent }, async () => ({ kind: "allow" }));
  check("worker assess-complexity 软闸门：read 拒绝、memory_search/context_read/context_compress 放行", deny?.kind === "deny" && String(deny.reason).startsWith("workflow-stage-deny:") && allow?.kind === "allow" && allowCtxRead?.kind === "allow" && allowCtxCompress?.kind === "allow");
}

// *_sub_whale_report：output + nextStage 应同时推进角色 workflow 并原生汇报给主模型。
{
  const agent = subagentAgent("child-worker");
  // child-worker 已在上一段进入 assess-complexity；这里验证推进能力。
  check("前置：child-worker 处于 assess-complexity", stageFromFile(STORE_FILE, "child-worker") === "assess-complexity");
  const workReport = h1.registeredTools.get("work_sub_whale_report");
  check("work_sub_whale_report description 含硬停等/父回复恢复/terminal 新轮", typeof workReport?.description === "string" && workReport.description.includes("hard stop") && workReport.description.includes("awaitingParent") && workReport.description.includes("send_message, which resumes it") && workReport.description.includes("fresh delegation at assess-complexity"));
  const beforeReports = h1.capturedReports.length;
  const beforeRoundReports = h1.roundReports.length;
  const result = await workReport.execute(
    { output: "assessed: complex delegation", nextStage: "challenge-plan" },
    { agent, signal: new AbortController().signal },
  );
  check("report+nextStage 推进 worker assess-complexity → challenge-plan", result?.stage === "challenge-plan" && result?.role === "worker" && stageFromFile(STORE_FILE, "child-worker") === "challenge-plan");
  check("report+nextStage 仍调用原生 reportFrom 汇报给主模型", result?.messageId === "report-1" && h1.capturedReports.length === beforeReports + 1);
  check("reportFrom 收到输出内容与 delivery=next-step", h1.capturedReports.at(-1)?.options?.delivery === "next-step" && JSON.stringify(h1.capturedReports.at(-1)?.content ?? []).includes("assessed: complex delegation"));
  const childRdReports = h1.roundReports
    .slice(beforeRoundReports)
    .filter((payload) => payload?.category === "subagent-report" && payload?.agent?.id === "child-worker");
  check(
    "6.0.2 work_sub_whale_report child-side 写 child round-display 摘要",
    childRdReports.length >= 1 && childRdReports.some((payload) => payload?.content === "assessed: complex delegation"),
  );
  // 延迟注入守卫：report+nextStage 已置 awaitingParent=true 且挂 pending
  // challenge-plan；父主 send_message 清门前的 pre-step 不得注入或消费 pending。
  const waitingStep = await preStep({ agent, turn: 1, messages: [] }, nextEnter);
  const waitingText = messageText(waitingStep?.messages ?? []);
  check(
    "report 后等待期 pre-step 不注入新 stage 文本（challenge-plan）",
    !waitingText.includes("[ka-whale-workflow challenge-plan]") &&
      roleRecordFromFile(STORE_FILE, "child-worker")?.awaitingParent === true,
  );
  check(
    "report 后等待期 pending 仍保留（未 clear）",
    pendingFromFile(STORE_FILE, "child-worker") === "challenge-plan",
  );
  // report 成功已置 awaitingParent=true；先由父主 send_message 清门，才能验证
  // challenge-plan 本身的 stage 软闸门（read 放行、write 拒绝）。
  await claimed({
    agent,
    message: {
      content: [{ type: "text", text: "continue after challenge report" }],
      source: { kind: "coordinator", form: "relay", senderSessionId: "main-parent-session" },
    },
    turn: 1,
  });
  check("父主 send_message 清门后 stage 保持 challenge-plan", stageFromFile(STORE_FILE, "child-worker") === "challenge-plan" && roleRecordFromFile(STORE_FILE, "child-worker")?.awaitingParent === false);
  const relayedStep = await preStep({ agent, turn: 1, messages: [] }, nextEnter);
  const relayedText = messageText(relayedStep?.messages ?? []);
  check(
    "父 relay 清门后的下一 pre-step 才注入 challenge-plan 文本并清 pending",
    relayedText.includes("[ka-whale-workflow challenge-plan]") &&
      relayedText.includes("work_sub_whale_report") &&
      pendingFromFile(STORE_FILE, "child-worker") === null,
  );
  const readAllow = await preExecute({ name: "read", agent }, async () => ({ kind: "allow" }));
  const writeDeny = await preExecute({ name: "write", agent }, async () => ({ kind: "allow" }));
  check("推进后 challenge-plan 软闸门：read 放行、write 拒绝", readAllow?.kind === "allow" && writeDeny?.kind === "deny");
  let badError = null;
  try {
    await workReport.execute(
      { output: "bad advance", nextStage: "decide-tools" },
      { agent, signal: new AbortController().signal },
    );
  } catch (error) {
    badError = error;
  }
  check("非法 nextStage 被拒绝且 stage 不变", badError !== null && String(badError.message).includes("cannot advance") && stageFromFile(STORE_FILE, "child-worker") === "challenge-plan");
  let earlyCommError = null;
  try {
    await workReport.execute(
      { output: "early communication not allowed", nextStage: "communication" },
      { agent, signal: new AbortController().signal },
    );
  } catch (error) {
    earlyCommError = error;
  }
  check("36.8 worker challenge-plan 不可直接推进 communication", earlyCommError !== null && String(earlyCommError.message).includes("cannot advance") && stageFromFile(STORE_FILE, "child-worker") === "challenge-plan");

  // 硬等门：report 成功后 awaitingParent=true；等待期任何工具（含再次 report）被拒；
  // 父主 send_message 到达非终态仅清门；到达 communication 终态则重置新初始阶段。
  const parentRelay = {
    content: [{ type: "text", text: "continue" }],
    source: { kind: "coordinator", form: "relay", senderSessionId: "main-parent-session" },
  };
  const toCheckTools = await workReport.execute(
    { output: "tools verified", nextStage: "check-tools" },
    { agent, signal: new AbortController().signal },
  );
  check("report+nextStage 到 check-tools 后返回等待 notice", toCheckTools?.stage === "check-tools" && typeof toCheckTools?.notice === "string" && toCheckTools.notice.includes("Report delivered. Now waiting for the parent main model's reply") && toCheckTools.notice.includes("end your turn and do not call further tools"));
  check("report 成功后角色记录 awaitingParent=true", roleRecordFromFile(STORE_FILE, "child-worker")?.awaitingParent === true);
  const checkToolsWaitingStep = await preStep({ agent, turn: 2, messages: [] }, nextEnter);
  const checkToolsWaitingText = messageText(checkToolsWaitingStep?.messages ?? []);
  check(
    "report 后等待期 pre-step 不注入新 stage 文本（check-tools）",
    !checkToolsWaitingText.includes("[ka-whale-workflow check-tools]") &&
      pendingFromFile(STORE_FILE, "child-worker") === "check-tools",
  );
  const waitDenyAgainReport = await preExecute({ name: "work_sub_whale_report", agent }, async () => ({ kind: "allow" }));
  const waitDenyAllowedTool = await preExecute({ name: "context_search", agent }, async () => ({ kind: "allow" }));
  check("awaitingParent 等待期任何工具（含再次 report）被结构化拒绝", waitDenyAgainReport?.kind === "deny" && waitDenyAgainReport?.code === "subagent-report-wait-deny" && String(waitDenyAgainReport.reason).includes("report 已送达，等待主代理回复") && waitDenyAllowedTool?.kind === "deny" && waitDenyAllowedTool?.code === "subagent-report-wait-deny");
  await claimed({ agent, message: parentRelay, turn: 2 });
  check("父主 send_message 到达非终态：仅清 awaitingParent、stage 保持不变", roleRecordFromFile(STORE_FILE, "child-worker")?.awaitingParent === false && stageFromFile(STORE_FILE, "child-worker") === "check-tools");
  const checkToolsRelayedStep = await preStep({ agent, turn: 2, messages: [] }, nextEnter);
  const checkToolsRelayedText = messageText(checkToolsRelayedStep?.messages ?? []);
  check(
    "父 relay 清门后的下一 pre-step 才注入 check-tools 文本并清 pending",
    checkToolsRelayedText.includes("[ka-whale-workflow check-tools]") &&
      pendingFromFile(STORE_FILE, "child-worker") === null,
  );
  const reportAllowedAfterClear = await preExecute({ name: "work_sub_whale_report", agent }, async () => ({ kind: "allow" }));
  check("清门后允许继续调用 report（继续当前轮）", reportAllowedAfterClear?.kind === "allow");
  const toWorking = await workReport.execute(
    { output: "working started", nextStage: "working" },
    { agent, signal: new AbortController().signal },
  );
  check("继续轮 report→working 且再次置 awaitingParent", toWorking?.stage === "working" && stageFromFile(STORE_FILE, "child-worker") === "working" && roleRecordFromFile(STORE_FILE, "child-worker")?.awaitingParent === true);
  await claimed({ agent, message: parentRelay, turn: 3 });
  check("父主 send_message 到达非终态 working：清门且 stage 仍 working", roleRecordFromFile(STORE_FILE, "child-worker")?.awaitingParent === false && stageFromFile(STORE_FILE, "child-worker") === "working");
  const toCommunication = await workReport.execute(
    { output: "done", nextStage: "communication" },
    { agent, signal: new AbortController().signal },
  );
  check("report→communication 终态且 awaitingParent=true", toCommunication?.stage === "communication" && stageFromFile(STORE_FILE, "child-worker") === "communication" && roleRecordFromFile(STORE_FILE, "child-worker")?.awaitingParent === true);
  await claimed({ agent, message: parentRelay, turn: 4 });
  check("父主 send_message 到达 communication 终态：重置 worker 初始 assess-complexity 并清门", stageFromFile(STORE_FILE, "child-worker") === "assess-complexity" && roleRecordFromFile(STORE_FILE, "child-worker")?.awaitingParent === false && pendingFromFile(STORE_FILE, "child-worker") === "assess-complexity");
  const newRoundDecision = await preStep({ agent, turn: 4, messages: [] }, nextEnter);
  const newRoundText = messageText(newRoundDecision?.messages ?? []);
  check("终态父消息后的新轮注入初始 stage 文本", newRoundText.includes("[ka-whale-workflow assess-complexity]") && newRoundText.includes("work_sub_whale_report"));
}

// memoryMaintainer: idle 进入 assess-delegation 并注入 role 专属文本。
{
  const agent = subagentAgent("child-memory");
  await claimed({ agent, message: userMessage, turn: 1 });
  check("includeSubagents=false：memoryMaintainer 受控子代理仍进入 assess-delegation", stageFromFile(STORE_FILE, "child-memory") === "assess-delegation");
  const decision = await preStep({ agent, turn: 1, messages: [] }, nextEnter);
  const text = messageText(decision?.messages ?? []);
  check("memoryMaintainer 注入 role stage 文本", text.includes("[ka-whale-workflow assess-delegation]") && text.includes("memory_sub_whale_report"));
  check("memoryMaintainer 不注入旧通用 SUBAGENT_FLOW_TEXT", !text.includes("[ka-whale-workflow subagent flow]"));
  const deny = await preExecute({ name: "read", agent }, async () => ({ kind: "allow" }));
  const allow = await preExecute({ name: "memory_search", agent }, async () => ({ kind: "allow" }));
  check("memoryMaintainer assess-delegation 软闸门：read 拒绝、memory_search 放行", deny?.kind === "deny" && String(deny.reason).startsWith("workflow-stage-deny:") && allow?.kind === "allow");
}

// pluginMaintainer create-plugin: pre-step 注入 lifecyclePath。
{
  const agent = subagentAgent("child-plugin-maintainer-create");
  const decision = await preStep({ agent, turn: 1, messages: [] }, nextEnter);
  const text = messageText(decision?.messages ?? []);
  check("pluginMaintainer create-plugin 注入含 lifecyclePath", text.includes("[ka-whale-workflow create-plugin]") && text.includes(`lifecyclePath: ${LIFECYCLE_FILE}`));
  check("pluginMaintainer create-plugin 不注入旧通用 SUBAGENT_FLOW_TEXT", !text.includes("[ka-whale-workflow subagent flow]"));
  check("create-plugin 注入后 pending 已清除", pendingFromFile(STORE_FILE, "child-plugin-maintainer-create") === null);
  const allow = await preExecute({ name: "write", agent }, async () => ({ kind: "allow" }));
  const deny = await preExecute({ name: "memory_search", agent }, async () => ({ kind: "allow" }));
  check("pluginMaintainer create-plugin 软闸门：write 放行、memory_search 拒绝", allow?.kind === "allow" && deny?.kind === "deny" && String(deny.reason).startsWith("workflow-stage-deny:"));
}

// ---------------------------------------------------------------------------
// Harness 2：includeSubagents=true 时旧/未知子代理仍使用通用 SUBAGENT_FLOW_TEXT。
// ---------------------------------------------------------------------------
const GEN_DIR = join(TMP, "generic");
const GEN_STORE = join(GEN_DIR, "stage.json");
const GEN_PLAN = join(GEN_DIR, "plan.json");
{
  const h2 = makeBase({ includeSubagents: true, stageStoreFile: GEN_STORE, planFile: GEN_PLAN });
  await plugin.apply(h2.base, { stageStore: GEN_STORE, taskPlanStore: GEN_PLAN });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const claimed2 = h2.listeners.get("agent/inbox/claimed")?.[0];
  const preStep2 = h2.listeners.get("agent/pre-step")?.[0];
  const agent = subagentAgent("legacy-child");
  await claimed2({ agent, message: userMessage, turn: 2 });
  check("includeSubagents=true：旧/未知子代理可进入通用主 stage 外壳", stageFromFile(GEN_STORE, "legacy-child") === "assess-complexity");
  const decision = await preStep2({ agent, turn: 2, messages: [] }, nextEnter);
  const text = messageText(decision?.messages ?? []);
  check("includeSubagents=true：旧/未知子代理注入 SUBAGENT_FLOW_TEXT", text.includes("[ka-whale-workflow subagent flow]"));
  check("SUBAGENT_FLOW_TEXT 常量未被删除", typeof SUBAGENT_FLOW_TEXT === "string" && SUBAGENT_FLOW_TEXT.includes("work_sub_whale_report"));
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nSUBAGENT-WORKFLOW PROBE OK" : `\nSUBAGENT-WORKFLOW PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
