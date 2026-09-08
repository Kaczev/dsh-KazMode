// ka-whale-workflow v0.9 受控子代理 workflow 探针：
//   - includeSubagents=false 时受控 v0.9 子代理仍被治理（不跳过）；
//   - idle 初始化 role planning 首阶段（worker=challenge-plan，
//     memoryMaintainer=plan-memory，pluginMaintainer=plan-plugin）；
//   - role 专属 [ka-whale-workflow <stage>] 按 pending 注入一次；首轮 Minimal（尚无
//     工具调用）时正文含 Minimal (first round only) 行，首次工具调用后不再出现；
//   - report 后等待期（awaitingParent=true）pre-step 不注入/不清 pending，
//     父主 send_message 清门后的下一 pre-step 才注入新 stage 文本；
//   - plugin create/update/retire 注入携带 lifecyclePath；
//   - 受控角色不注入旧通用 subagent-flow；旧/未知子代理的通用 subagent-flow 注入已删除。
//   - tools/pre-execute 按 role/stage Allowed tools 软闸门。
// 运行：node KazPlugins/ka-whale-workflow/probe-subagent-workflow.mjs
import plugin, {
  createStageStore,
  V09_SUBAGENT_ROLE_INITIAL_STAGES,
  PLAN_READ_TOOL,
} from "./lib/index.js";
import { stageDefinitionFor, stageInjectionText, STAGE_CONTEXT_NOTES, SUBAGENT_TERMINAL_STAGE } from "./lib/stage-defs.js";
import { runPlanFileFor, currentRunPointerFileFor, readRunPlanItems, persistFinalPlanRun, workLogFileFor } from "./lib/task-plan-store.js";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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
  const agentRegistry = new Map();
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
      if (name === "agents") return { get: (id) => agentRegistry.get(id) };
      if (name === "roundDisplay") return { report: (payload) => roundReports.push(payload) };
      if (name === "subagents") {
        return {
          reportFrom: async (_child, content, options) => {
            capturedReports.push({ content, options });
            return "report-1";
          },
          listChildren: async () => [],
          followup: async (_parent, childId, content) => `msg-${childId}`,
          startContinuable: async (spec) => ({ childId: spec?.childId }),
        };
      }
      return undefined;
    },
    systemPrompt: { section() { return () => {}; } },
    tools: toolsMock,
  };
  return { listeners, registeredTools, base, capturedReports, roundReports, agentRegistry };
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
function withToolCall(agent) {
  agent.session.events.push({ type: "tool/call", data: { name: "memory_search" } });
}

{
  const roles = ["worker", "memoryMaintainer", "pluginMaintainer"];
  const roleReportTools = {
    worker: "work_sub_whale_report",
    memoryMaintainer: "memory_sub_whale_report",
    pluginMaintainer: "plugin_maintainer_sub_whale_report",
  };
  check(
    "受控子代理 merged 终态 allowedTools = context_compress + 各自 report（新尾部）",
    roles.every((role) =>
      JSON.stringify(stageDefinitionFor(role, SUBAGENT_TERMINAL_STAGE)?.allowedTools) ===
      JSON.stringify(["context_compress", roleReportTools[role]]),
    ),
  );
  check(
    "双层语义：受控子代理初始 stage allowedTools 含 memory/context/report，不含 context_compress",
    roles.every((role) => {
      const allowed = stageDefinitionFor(role, V09_SUBAGENT_ROLE_INITIAL_STAGES[role])?.allowedTools ?? [];
      return (
        allowed.includes("memory_search") &&
        allowed.includes("context_search") &&
        allowed.includes("context_read") &&
        allowed.includes(roleReportTools[role]) &&
        !allowed.includes("context_compress")
      );
    }),
  );
  check(
    "受控子代理初始 planning stage 不放 write/edit/pwsh（文件执行工具在后续阶段才授予）",
    roles.every((role) => {
      const allowed = stageDefinitionFor(role, V09_SUBAGENT_ROLE_INITIAL_STAGES[role])?.allowedTools ?? [];
      return !allowed.includes("write") && !allowed.includes("edit") && !allowed.includes("pwsh");
    }),
  );
  check(
    "Minimal 提示由 stageInjectionText 可选 minimalTools 参数承载（memory/plugin 初始 stage）",
    roles.every((role) => {
      const initial = V09_SUBAGENT_ROLE_INITIAL_STAGES[role];
      return (
        stageInjectionText(role, initial, { minimalTools: ["memory_search", "context_search"] }).includes(
          "Minimal (first round only): [memory_search, context_search] until your first tool call; then the Allowed tools above unlock.",
        ) &&
        !stageInjectionText(role, initial).includes("Minimal (first round only):")
      );
    }),
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
  // memoryMaintainer 强制复用：parent→role→child 注册的 merged 终态 child（随后验证 dispose 清理）。
  store.setSubagentRole("child-dispose-reuse", {
    planItemId: "p-mem-reuse",
    persona: "memoryMaintainer",
    parentId: "parent-main",
    stage: SUBAGENT_TERMINAL_STAGE,
    assignedTools: [],
    finalTools: ["memory_search", "context_search"],
    awaitingParent: true,
  });
  store.set("child-dispose-reuse", SUBAGENT_TERMINAL_STAGE);
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

check("V09_SUBAGENT_ROLE_INITIAL_STAGES 映射正确且无 pluginCreator", V09_SUBAGENT_ROLE_INITIAL_STAGES.worker === "challenge-plan" && V09_SUBAGENT_ROLE_INITIAL_STAGES.memoryMaintainer === "plan-memory" && V09_SUBAGENT_ROLE_INITIAL_STAGES.pluginMaintainer === "plan-plugin" && V09_SUBAGENT_ROLE_INITIAL_STAGES.pluginCreator === undefined);
check("plugin_creator_sub_whale_report 未注册", h1.registeredTools.has("plugin_creator_sub_whale_report") === false);

// Worker: includeSubagents=false 下 inbox claim 治理；受控子代理与主模型一样，
// 首次 tool/call 前保持 idle + Minimal（只注入 startup hint），之后才进入
// challenge-plan 并注入 role stage 正文。
{
  const agent = subagentAgent("child-worker");
  await claimed({ agent, message: userMessage, turn: 1 });
  check("includeSubagents=false：worker 受控子代理首轮 Minimal 仍保持 idle", stageFromFile(STORE_FILE, "child-worker") === null);
  const preToolDecision = await preStep({ agent, turn: 1, messages: [userMessage] }, nextEnter);
  const preToolText = messageText(preToolDecision?.messages ?? []);
  check("worker 首轮 tool 前不注入 role stage 正文", !preToolText.includes("[ka-whale-workflow challenge-plan]"));
  check("worker 首轮 tool 前注入 startup hint（含 memory_search/report 解锁说明）", preToolText.includes("[ka-whale-workflow first-round]") && preToolText.includes("memory_search or context_search") && preToolText.includes("work_sub_whale_report"));
  // 模拟首次 tool/call：真实路径由 session/event 置 minimalDone 并进入 role 首阶段。
  withToolCall(agent);
  h1.agentRegistry.set(agent.id, agent);
  const sessionEvent = h1.listeners.get("session/event")?.[0];
  if (typeof sessionEvent === "function") {
    await sessionEvent({ id: agent.id }, { type: "tool/call", data: { name: "memory_search" } });
  }
  const postToolDecision = await preStep({ agent, turn: 1, messages: [] }, nextEnter);
  const postToolText = messageText(postToolDecision?.messages ?? []);
  check("首次 tool/call 后 worker 进入 challenge-plan", stageFromFile(STORE_FILE, "child-worker") === "challenge-plan");
  check("首次 tool/call 后注入 challenge-plan 且不再含 Minimal line", postToolText.includes("[ka-whale-workflow challenge-plan]") && postToolText.includes("work_sub_whale_report") && !postToolText.includes("Minimal (first round only):"));
  check("worker 不注入旧通用 subagent-flow 文本", !postToolText.includes("[ka-whale-workflow subagent flow]"));
  check("worker 注入后 pending 已清除", pendingFromFile(STORE_FILE, "child-worker") === null);
  check(
    "Context 注记：worker/maintenance 目标 stage 注入注记，无注记 stage 不输出",
    STAGE_CONTEXT_NOTES?.worker?.["challenge-plan"] !== undefined &&
      stageInjectionText("worker", "challenge-plan").includes("Context: ") &&
      stageInjectionText("worker", SUBAGENT_TERMINAL_STAGE).includes("Context: ") &&
      stageInjectionText("memoryMaintainer", SUBAGENT_TERMINAL_STAGE).includes("Context: ") &&
      stageInjectionText("pluginMaintainer", SUBAGENT_TERMINAL_STAGE).includes("Context: ") &&
      !stageInjectionText("memoryMaintainer", "plan-memory").includes("Context:") &&
      !stageInjectionText("pluginMaintainer", "create-plugin").includes("Context:"),
  );
  const deny = await preExecute({ name: "write", agent }, async () => ({ kind: "allow" }));
  const allow = await preExecute({ name: "read", agent }, async () => ({ kind: "allow" }));
  const allowCtxRead = await preExecute({ name: "context_read", agent }, async () => ({ kind: "allow" }));
  const allowCtxCompress = await preExecute({ name: "context_compress", agent }, async () => ({ kind: "allow" }));
  check("worker challenge-plan 软闸门：read/memory_search/context_read 放行、write/context_compress 拒绝", deny?.kind === "deny" && String(deny.reason).startsWith("workflow-stage-deny:") && allow?.kind === "allow" && allowCtxRead?.kind === "allow" && allowCtxCompress?.kind === "deny");
}

// *_sub_whale_report：单一 subagent-settled 通道。nextStage 推进角色 workflow，
// 工具不再接收 output、不调用 reportFrom、不 child-side 写摘要；置 awaitingParent
// 后由子代理把完整报告作为最终消息写出。
{
  const agent = subagentAgent("child-worker");
  // child-worker 已在上一段进入 challenge-plan（首阶段，不再有 assess-complexity）。
  check("前置：child-worker 处于 challenge-plan", stageFromFile(STORE_FILE, "child-worker") === "challenge-plan");
  const workReport = h1.registeredTools.get("work_sub_whale_report");
  check("work_sub_whale_report description 含硬停等/父回复恢复/terminal 新轮/single settled", typeof workReport?.description === "string" && workReport.description.includes("hard stop") && workReport.description.includes("awaitingParent") && workReport.description.includes("send_message, which resumes it") && workReport.description.includes("fresh delegation at challenge-plan") && workReport.description.includes("parent receives it as subagent-settled") && !Object.prototype.hasOwnProperty.call(workReport.parameters ?? {}, "output"));
  const beforeReports = h1.capturedReports.length;
  const beforeRoundReports = h1.roundReports.length;
  let badError = null;
  try {
    await workReport.execute(
      { nextStage: "decide-tools-before-writing-plan" },
      { agent, signal: new AbortController().signal },
    );
  } catch (error) {
    badError = error;
  }
  check("非法 nextStage 被拒绝且 stage 不变", badError !== null && String(badError.message).includes("cannot advance") && stageFromFile(STORE_FILE, "child-worker") === "challenge-plan");
  let earlyTailError = null;
  try {
    await workReport.execute(
      { nextStage: SUBAGENT_TERMINAL_STAGE },
      { agent, signal: new AbortController().signal },
    );
  } catch (error) {
    earlyTailError = error;
  }
  check("worker challenge-plan 不可直接推进 compress_context_then_communication", earlyTailError !== null && String(earlyTailError.message).includes("cannot advance") && stageFromFile(STORE_FILE, "child-worker") === "challenge-plan");

  // 硬等门：report 成功后 awaitingParent=true；等待期任何工具（含再次 report）被拒；
  // 父主 send_message 到达非终态仅清门；到达 merged 终态 terminal report 后重置新轮。
  const parentRelay = {
    content: [{ type: "text", text: "continue" }],
    source: { kind: "coordinator", form: "relay", senderSessionId: "main-parent-session" },
  };
  const toWorking = await workReport.execute(
    { nextStage: "working" },
    { agent, signal: new AbortController().signal },
  );
  check("report+nextStage challenge-plan → working 后返回等待 notice", toWorking?.stage === "working" && toWorking?.messageId === undefined && typeof toWorking?.notice === "string" && toWorking.notice.includes("Stage advanced; now output your full report as your final message") && toWorking.notice.includes("parent receives it as subagent-settled") && toWorking.notice.includes("do not call further tools"));
  check("report+nextStage 不再调用原生 reportFrom（单一 settled 通道）", h1.capturedReports.length === beforeReports);
  const childRdReports = h1.roundReports
    .slice(beforeRoundReports)
    .filter((payload) => payload?.category === "subagent-report" && payload?.agent?.id === "child-worker");
  check(
    "single settled：work_sub_whale_report 不再 child-side 写 subagent-report 摘要",
    childRdReports.length === 0,
  );
  check("report 成功后角色记录 awaitingParent=true", roleRecordFromFile(STORE_FILE, "child-worker")?.awaitingParent === true);
  const workingWaitingStep = await preStep({ agent, turn: 2, messages: [] }, nextEnter);
  const workingWaitingText = messageText(workingWaitingStep?.messages ?? []);
  check(
    "report 后等待期 pre-step 不注入新 stage 文本（working）",
    !workingWaitingText.includes("[ka-whale-workflow working]") &&
      pendingFromFile(STORE_FILE, "child-worker") === "working",
  );
  const waitDenyAgainReport = await preExecute({ name: "work_sub_whale_report", agent }, async () => ({ kind: "allow" }));
  const waitDenyAllowedTool = await preExecute({ name: "context_search", agent }, async () => ({ kind: "allow" }));
  check("awaitingParent 等待期任何工具（含再次 report）被结构化拒绝", waitDenyAgainReport?.kind === "deny" && waitDenyAgainReport?.code === "subagent-report-wait-deny" && String(waitDenyAgainReport.reason).includes("full final report will be received as subagent-settled") && String(waitDenyAgainReport.reason).includes("Write your full report as your final message") && waitDenyAllowedTool?.kind === "deny" && waitDenyAllowedTool?.code === "subagent-report-wait-deny");
  await claimed({ agent, message: parentRelay, turn: 2 });
  check("父主 send_message 到达非终态：仅清 awaitingParent、stage 保持不变", roleRecordFromFile(STORE_FILE, "child-worker")?.awaitingParent === false && stageFromFile(STORE_FILE, "child-worker") === "working");
  const workingRelayedStep = await preStep({ agent, turn: 2, messages: [] }, nextEnter);
  const workingRelayedText = messageText(workingRelayedStep?.messages ?? []);
  check(
    "父 relay 清门后的下一 pre-step 才注入 working 文本并清 pending",
    workingRelayedText.includes("[ka-whale-workflow working]") &&
      pendingFromFile(STORE_FILE, "child-worker") === null,
  );
  const reportAllowedAfterClear = await preExecute({ name: "work_sub_whale_report", agent }, async () => ({ kind: "allow" }));
  check("清门后允许继续调用 report（继续当前轮）", reportAllowedAfterClear?.kind === "allow");
  const toMerged = await workReport.execute(
    { nextStage: SUBAGENT_TERMINAL_STAGE },
    { agent, signal: new AbortController().signal },
  );
  check("report+nextStage working → compress_context_then_communication 中间态且 awaitingParent=true", toMerged?.stage === SUBAGENT_TERMINAL_STAGE && toMerged?.advanced === true && stageFromFile(STORE_FILE, "child-worker") === SUBAGENT_TERMINAL_STAGE && roleRecordFromFile(STORE_FILE, "child-worker")?.awaitingParent === true && pendingFromFile(STORE_FILE, "child-worker") === SUBAGENT_TERMINAL_STAGE);
  const mergedWaitingStep = await preStep({ agent, turn: 3, messages: [] }, nextEnter);
  check("merged 中间态等待期不注入 merged 正文、pending 保留", !messageText(mergedWaitingStep?.messages ?? []).includes(`[ka-whale-workflow ${SUBAGENT_TERMINAL_STAGE}]`) && pendingFromFile(STORE_FILE, "child-worker") === SUBAGENT_TERMINAL_STAGE);
  await claimed({ agent, message: parentRelay, turn: 3 });
  check("父主 send_message 到达 merged 中间态：仅清 awaitingParent、保持 merged stage（不重置新轮）", roleRecordFromFile(STORE_FILE, "child-worker")?.awaitingParent === false && stageFromFile(STORE_FILE, "child-worker") === SUBAGENT_TERMINAL_STAGE && pendingFromFile(STORE_FILE, "child-worker") === SUBAGENT_TERMINAL_STAGE);
  const mergedRelayedStep = await preStep({ agent, turn: 3, messages: [] }, nextEnter);
  const mergedRelayedText = messageText(mergedRelayedStep?.messages ?? []);
  check(
    "merged 中间态父回复后的下一 pre-step 注入 merged 正文并清 pending",
    mergedRelayedText.includes(`[ka-whale-workflow ${SUBAGENT_TERMINAL_STAGE}]`) &&
      pendingFromFile(STORE_FILE, "child-worker") === null,
  );
  const terminalResult = await workReport.execute(
    {},
    { agent, signal: new AbortController().signal },
  );
  check("terminal no-nextStage report 在 merged stage 置 awaitingParent 且 stage 不变", terminalResult?.stage === SUBAGENT_TERMINAL_STAGE && terminalResult?.advanced === false && roleRecordFromFile(STORE_FILE, "child-worker")?.awaitingParent === true && stageFromFile(STORE_FILE, "child-worker") === SUBAGENT_TERMINAL_STAGE && pendingFromFile(STORE_FILE, "child-worker") === null);
  await claimed({ agent, message: parentRelay, turn: 4 });
  check("父主 send_message 到达 merged terminal full report：重置 worker 初始 challenge-plan 并清门", stageFromFile(STORE_FILE, "child-worker") === "challenge-plan" && roleRecordFromFile(STORE_FILE, "child-worker")?.awaitingParent === false && pendingFromFile(STORE_FILE, "child-worker") === "challenge-plan");
  const newRoundDecision = await preStep({ agent, turn: 4, messages: [] }, nextEnter);
  const newRoundText = messageText(newRoundDecision?.messages ?? []);
  check("终态父消息后的新轮注入初始 stage 文本", newRoundText.includes("[ka-whale-workflow challenge-plan]") && newRoundText.includes("work_sub_whale_report"));
}

// memoryMaintainer: 与 worker 一致，首次 tool/call 前保持 idle + startup hint；
// 首次 tool/call 后才进入 plan-memory 并注入 role 专属文本。
{
  const agent = subagentAgent("child-memory");
  await claimed({ agent, message: userMessage, turn: 1 });
  check("includeSubagents=false：memoryMaintainer 受控子代理首轮 Minimal 仍保持 idle", stageFromFile(STORE_FILE, "child-memory") === null);
  const preToolDecision = await preStep({ agent, turn: 1, messages: [userMessage] }, nextEnter);
  const preToolText = messageText(preToolDecision?.messages ?? []);
  check("memoryMaintainer 首轮 tool 前不注入 role stage 正文", !preToolText.includes("[ka-whale-workflow plan-memory]"));
  check("memoryMaintainer 首轮 tool 前注入 startup hint（含 report 解锁说明）", preToolText.includes("[ka-whale-workflow first-round]") && preToolText.includes("memory_search or context_search") && preToolText.includes("memory_sub_whale_report"));
  withToolCall(agent);
  h1.agentRegistry.set(agent.id, agent);
  const sessionEvent = h1.listeners.get("session/event")?.[0];
  if (typeof sessionEvent === "function") {
    await sessionEvent({ id: agent.id }, { type: "tool/call", data: { name: "memory_search" } });
  }
  const postToolDecision = await preStep({ agent, turn: 1, messages: [] }, nextEnter);
  const postToolText = messageText(postToolDecision?.messages ?? []);
  check("首次 tool/call 后 memoryMaintainer 进入 plan-memory", stageFromFile(STORE_FILE, "child-memory") === "plan-memory");
  check("首次 tool/call 后注入 plan-memory 且不再含 Minimal line", postToolText.includes("[ka-whale-workflow plan-memory]") && postToolText.includes("memory_sub_whale_report") && !postToolText.includes("Minimal (first round only):"));
  check("memoryMaintainer 不注入旧通用 subagent-flow 文本", !postToolText.includes("[ka-whale-workflow subagent flow]"));
  const allowReadPlan = await preExecute({ name: "read", agent }, async () => ({ kind: "allow" }));
  const allowMemSearch = await preExecute({ name: "memory_search", agent }, async () => ({ kind: "allow" }));
  const allowCtxCompress = await preExecute({ name: "context_compress", agent }, async () => ({ kind: "allow" }));
  const denyMemSavePlan = await preExecute({ name: "memory_save", agent }, async () => ({ kind: "allow" }));
  check("memoryMaintainer plan-memory 软闸门：read/memory_search 放行、memory_save/context_compress 拒绝", allowReadPlan?.kind === "allow" && allowMemSearch?.kind === "allow" && denyMemSavePlan?.kind === "deny" && String(denyMemSavePlan.reason).startsWith("workflow-stage-deny:") && allowCtxCompress?.kind === "deny");

  // Bug regression：report+nextStage 到 save-update 置 awaitingParent；父主
  // send_message resume 后必须仍非 Minimal、注入 save-update、report 可用，
  // memory_save 在 save-update 才可用。
  const memoryReport = h1.registeredTools.get("memory_sub_whale_report");
  const saveReport = await memoryReport.execute(
    { nextStage: "save-update" },
    { agent, signal: new AbortController().signal },
  );
  check("memory report+nextStage plan-memory → save-update 且 awaitingParent=true", saveReport?.stage === "save-update" && stageFromFile(STORE_FILE, "child-memory") === "save-update" && roleRecordFromFile(STORE_FILE, "child-memory")?.awaitingParent === true);
  check("memoryMaintainer minimalDone 已持久化（resume 不再回 Minimal）", roleRecordFromFile(STORE_FILE, "child-memory")?.minimalDone === true);
  const parentRelayMemory = {
    content: [{ type: "text", text: "continue memory work" }],
    source: { kind: "coordinator", form: "relay", senderSessionId: "main-parent-session" },
  };
  const waitingMemoryStep = await preStep({ agent, turn: 2, messages: [] }, nextEnter);
  check("save-update 等待期 pre-step 不注入 save-update 正文", !messageText(waitingMemoryStep?.messages ?? []).includes("[ka-whale-workflow save-update]"));
  await claimed({ agent, message: parentRelayMemory, turn: 2 });
  check("父 relay 清门后 stage 保持 save-update", stageFromFile(STORE_FILE, "child-memory") === "save-update" && roleRecordFromFile(STORE_FILE, "child-memory")?.awaitingParent === false);
  const relayedMemoryStep = await preStep({ agent, turn: 2, messages: [] }, nextEnter);
  const relayedMemoryText = messageText(relayedMemoryStep?.messages ?? []);
  check("resume 后下一 pre-step 注入 save-update 正文且无 Minimal line", relayedMemoryText.includes("[ka-whale-workflow save-update]") && relayedMemoryText.includes("memory_sub_whale_report") && !relayedMemoryText.includes("Minimal (first round only):"));
  check("resume 后 pending 已清除", pendingFromFile(STORE_FILE, "child-memory") === null);
  const allowMemReport = await preExecute({ name: "memory_sub_whale_report", agent }, async () => ({ kind: "allow" }));
  const allowMemSearchSave = await preExecute({ name: "memory_search", agent }, async () => ({ kind: "allow" }));
  const allowMemSave = await preExecute({ name: "memory_save", agent }, async () => ({ kind: "allow" }));
  check("save-update 软闸门：report/memory_search/memory_save 放行", allowMemReport?.kind === "allow" && allowMemSearchSave?.kind === "allow" && allowMemSave?.kind === "allow");
}

// pluginMaintainer create-plugin: pre-step 注入 lifecyclePath。
{
  const agent = subagentAgent("child-plugin-maintainer-create");
  const decision = await preStep({ agent, turn: 1, messages: [] }, nextEnter);
  const text = messageText(decision?.messages ?? []);
  check("pluginMaintainer create-plugin 注入含 lifecyclePath", text.includes("[ka-whale-workflow create-plugin]") && text.includes(`lifecyclePath: ${LIFECYCLE_FILE}`));
  check("pluginMaintainer create-plugin 不注入旧通用 subagent-flow 文本", !text.includes("[ka-whale-workflow subagent flow]"));
  check("create-plugin 注入后 pending 已清除", pendingFromFile(STORE_FILE, "child-plugin-maintainer-create") === null);
  const allowWrite = await preExecute({ name: "write", agent }, async () => ({ kind: "allow" }));
  const allowMemSearch = await preExecute({ name: "memory_search", agent }, async () => ({ kind: "allow" }));
  const denyMemSave = await preExecute({ name: "memory_save", agent }, async () => ({ kind: "allow" }));
  check("pluginMaintainer create-plugin 软闸门：write/memory_search 放行、memory_save 拒绝", allowWrite?.kind === "allow" && allowMemSearch?.kind === "allow" && denyMemSave?.kind === "deny" && String(denyMemSave.reason).startsWith("workflow-stage-deny:"));
}

// agent/disposed：continuable 子代理 unload/ready 时不得清角色记录——否则
// 父主 send_message 恢复时 controlled role/pending 注入丢失。真正已移除子代理的
// 脏记录由 tryReuseMemoryMaintainer 经 listChildren 对账清理。
{
  const beforeRaw = readFileSync(STORE_FILE, "utf8").replace(/^\uFEFF/, "");
  const before = JSON.parse(beforeRaw);
  check(
    "dispose 前：child-dispose-reuse 已在 subagentRoles + subagentRoleParents 注册",
    before.subagentRoles?.["child-dispose-reuse"]?.parentId === "parent-main" &&
      before.subagentRoleParents?.["parent-main"]?.["memoryMaintainer"]?.includes("child-dispose-reuse") === true,
  );
  const disposed = h1.listeners.get("agent/disposed")?.[0];
  if (typeof disposed === "function") {
    await disposed({ agent: subagentAgent("child-dispose-reuse") });
  }
  const after = JSON.parse(readFileSync(STORE_FILE, "utf8").replace(/^\uFEFF/, ""));
  check(
    "agent/disposed（unload/ready）后：角色记录与 parent 复用索引保留，resume 仍可识别受控角色",
    after.subagentRoles?.["child-dispose-reuse"]?.parentId === "parent-main" &&
      after.subagentRoleParents?.["parent-main"]?.["memoryMaintainer"]?.includes("child-dispose-reuse") === true,
  );
}

// ---------------------------------------------------------------------------
// Harness 2：includeSubagents=true 的旧/未知子代理仍可进入 stage 外壳，但
// 不再注入旧通用 subagent-flow 文本（常量与注入路径已删除）。
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
  check("includeSubagents=true：旧/未知子代理不再注入通用 subagent-flow 文本", !text.includes("[ka-whale-workflow subagent flow]"));
}

// ---------------------------------------------------------------------------
// Harness 3：k10-project-store run mode（projectRoot override，无 taskPlanStore
// 单文件 override）。验证 run 文件 + current.json + plan_read + current-run ka_sub。
// ---------------------------------------------------------------------------
{
  const RUN_DIR = join(TMP, "run-mode-project");
  const RUN_STORE = join(RUN_DIR, "stage.json");
  const seedStore = createStageStore(RUN_STORE);
  seedStore.set("main-run-session", "write-plan");
  seedStore.beginWorkflowRun("main-run-session");
  seedStore.setSubagentRole("child-log", {
    planItemId: "p-current",
    persona: "worker",
    parentId: "main-run-session",
    stage: SUBAGENT_TERMINAL_STAGE,
    assignedTools: [],
    finalTools: [],
    awaitingParent: true,
  });
  seedStore.set("child-log", SUBAGENT_TERMINAL_STAGE);
  seedStore.setSubagentRole("child-log-2", {
    planItemId: "p-added",
    persona: "memoryMaintainer",
    parentId: "main-run-session",
    stage: SUBAGENT_TERMINAL_STAGE,
    assignedTools: [],
    finalTools: [],
    awaitingParent: true,
  });
  seedStore.set("child-log-2", SUBAGENT_TERMINAL_STAGE);
  const h3 = makeBase({
    includeSubagents: false,
    stageStoreFile: RUN_STORE,
    planFile: join(RUN_DIR, "legacy-should-not-be-used.json"),
  });
  await plugin.apply(h3.base, {
    stageStore: RUN_STORE,
    projectRoot: RUN_DIR,
    lifecyclePath: join(RUN_DIR, "LIFECYCLE.md"),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const mainAgent = {
    id: "main-run-session",
    session: { id: "main-run-session", header: { cwd: RUN_DIR }, events: [] },
    options: {},
  };
  const whale = h3.registeredTools.get("whale_report");
  const planRead = h3.registeredTools.get("plan_read");
  const kaSub = h3.registeredTools.get("ka_sub_whale");
  check("run-mode harness registers plan_read main-only tool", typeof planRead?.execute === "function" && h3.registeredTools.has("plan_read"));
  const runFile = runPlanFileFor(RUN_DIR, "main-run-session", 1);
  const currentFile = currentRunPointerFileFor(RUN_DIR);
  const writeResult = await whale.execute(
    {
      finalPlanPayload: {
        status: "finalized",
        items: [
          { planItemId: "p-current", persona: "worker", task: "Current run item", summary: "run", targets: ["src"], assignedTools: [] },
          { planItemId: "p-main", persona: "main", task: "Main current item", assignedTools: [] },
        ],
      },
    },
    { agent: mainAgent, signal: new AbortController().signal },
  );
  check(
    "run mode write-plan finalization writes run file + current.json with session/run",
    writeResult.ok === true &&
      existsSync(runFile) &&
      JSON.parse(readFileSync(currentFile, "utf8"))?.sessionId === "main-run-session" &&
      JSON.parse(readFileSync(currentFile, "utf8"))?.runId === 1 &&
      JSON.parse(readFileSync(currentFile, "utf8"))?.planFile === runFile,
  );
  const pr1 = await planRead.execute({}, { agent: mainAgent, signal: new AbortController().signal });
  check(
    "plan_read returns current run items and active run file (not historical/legacy items)",
    pr1.ok === true &&
      pr1.mode === "run" &&
      pr1.runId === "1" &&
      pr1.planFile === runFile &&
      pr1.items.some((item) => item.planItemId === "p-current") &&
      !pr1.items.some((item) => item.planItemId === "p-old-run"),
  );
  // k10-work-log：terminal subagent-settled delivery appends work-log entries.
  const preStepH3 = h3.listeners.get("agent/pre-step")?.[0];
  const logFile = workLogFileFor(RUN_DIR, "main-run-session", 1);
  const firstSettled = {
    content: [{ type: "text", text: "Worker terminal report full text" }],
    source: { kind: "subagent-settled", form: "notice", senderSessionId: "child-log", summary: "worker settled summary" },
  };
  await preStepH3(
    { agent: mainAgent, turn: 4 },
    async () => ({ kind: "enter", messages: [firstSettled] }),
  );
  const logRaw1 = JSON.parse(readFileSync(logFile, "utf8"));
  check(
    "terminal subagent-settled delivery writes work-log with role/planItemId/summary/report and seq 1",
    existsSync(logFile) &&
      logRaw1?.version === 1 &&
      logRaw1?.runId === 1 &&
      logRaw1?.entries?.length === 1 &&
      logRaw1.entries[0].seq === 1 &&
      logRaw1.entries[0].role === "worker" &&
      logRaw1.entries[0].planItemId === "p-current" &&
      logRaw1.entries[0].summary.includes("Worker terminal report") &&
      logRaw1.entries[0].report === "Worker terminal report full text",
  );
  const prLog = await planRead.execute({}, { agent: mainAgent, signal: new AbortController().signal });
  check(
    "plan_read returns workLogFile and current run work-log entries",
    prLog.ok === true &&
      prLog.workLogFile === logFile &&
      Array.isArray(prLog.workLog) &&
      prLog.workLog.length === 1 &&
      prLog.workLog[0].seq === 1,
  );
  const secondSettled = {
    content: [{ type: "text", text: "MemoryMaintainer terminal report full text" }],
    source: { kind: "subagent-settled", form: "notice", senderSessionId: "child-log-2", summary: "memory settled summary" },
  };
  await preStepH3(
    { agent: mainAgent, turn: 5 },
    async () => ({ kind: "enter", messages: [secondSettled] }),
  );
  const logRaw2 = JSON.parse(readFileSync(logFile, "utf8"));
  check(
    "second terminal report appends seq 2 and role/planItemId are captured",
    logRaw2?.entries?.length === 2 &&
      logRaw2.entries[1].seq === 2 &&
      logRaw2.entries[1].role === "memoryMaintainer" &&
      logRaw2.entries[1].planItemId === "p-added" &&
      logRaw2.entries[1].report.includes("MemoryMaintainer terminal report"),
  );
  // Legacy/no-run best-effort: settled from an unmanaged child must not throw or write a run log.
  const beforeLegacyLogExists = existsSync(logFile);
  const noRunPreStep = h3.listeners.get("agent/pre-step")?.[0];
  const orphanSettled = {
    content: [{ type: "text", text: "orphan report" }],
    source: { kind: "subagent-settled", form: "notice", senderSessionId: "no-run-child", summary: "orphan" },
  };
  await noRunPreStep(
    { agent: { id: "fresh-session", session: { id: "fresh-session", header: { cwd: RUN_DIR }, events: [] } }, turn: 1 },
    async () => ({ kind: "enter", messages: [orphanSettled] }),
  );
  check(
    "work-log legacy/no-run delivery does not throw and does not create a run log",
    beforeLegacyLogExists === true && existsSync(logFile) === true,
  );

  // 旧 run（同 session runId=2）存在时：ka_sub 只解析 current run（runId=1），
  // plan_read 可用 runId=2 显式读取历史 run，未知 runId 拒绝。
  persistFinalPlanRun({
    projectRoot: RUN_DIR,
    sessionId: "main-run-session",
    runId: 2,
    payload: {
      status: "finalized",
      items: [{ planItemId: "p-old-run", persona: "worker", task: "Old run item", assignedTools: [] }],
    },
  });
  const currentDelegation = await kaSub.execute({ planItemId: "p-current" }, { agent: mainAgent, signal: new AbortController().signal });
  const oldDelegation = await kaSub.execute({ planItemId: "p-old-run" }, { agent: mainAgent, signal: new AbortController().signal });
  const readOld = await planRead.execute({ runId: "2" }, { agent: mainAgent, signal: new AbortController().signal });
  const readUnknown = await planRead.execute({ runId: "999" }, { agent: mainAgent, signal: new AbortController().signal });
  check(
    "ka_sub_whale resolves current-run item and rejects old-run item; plan_read supports historical runId and rejects unknown runId",
    currentDelegation.ok === true &&
      currentDelegation.persona === "worker" &&
      oldDelegation.ok === false &&
      oldDelegation.code === "plan-item-not-found" &&
      readOld.ok === true &&
      readOld.items.some((item) => item.planItemId === "p-old-run") &&
      readUnknown.ok === false &&
      readUnknown.code === "plan-read-not-found",
  );
  // 主流程回 write-plan 做 amendment（同一 active run）。
  const backToWritePlan = await whale.execute(
    { nextStage: "write-plan" },
    { agent: mainAgent, signal: new AbortController().signal },
  );
  check("run mode revisits write-plan for amendment within same run", backToWritePlan.ok === true && backToWritePlan.stage === "write-plan");
  const amendResult = await whale.execute(
    {
      finalPlanPayload: {
        status: "finalized",
        items: [
          { planItemId: "p-current", persona: "worker", task: "Current run item amended", summary: "updated", assignedTools: [] },
          { planItemId: "p-added", persona: "memoryMaintainer", task: "Added in amendment", assignedTools: [] },
        ],
      },
    },
    { agent: mainAgent, signal: new AbortController().signal },
  );
  const pointerAfterAmend = JSON.parse(readFileSync(currentFile, "utf8"));
  const prAfterAmend = await planRead.execute({}, { agent: mainAgent, signal: new AbortController().signal });
  check(
    "write-plan amendment rewrites same run file and plan_read sees updated current-run items",
    amendResult.ok === true &&
      pointerAfterAmend?.runId === 1 &&
      pointerAfterAmend?.planFile === runFile &&
      prAfterAmend.ok === true &&
      prAfterAmend.items.some((item) => item.planItemId === "p-added") &&
      prAfterAmend.items.some((item) => item.planItemId === "p-current" && item.task.includes("amended")),
  );
  const noPlanRunSession = { id: "fresh-session", session: { id: "fresh-session", header: { cwd: RUN_DIR }, events: [] } };
  const prEmpty = await planRead.execute({}, { agent: noPlanRunSession, signal: new AbortController().signal });
  check("plan_read before a run finalizes returns empty items + notice without crash", prEmpty.ok === true && prEmpty.items.length === 0 && typeof prEmpty.notice === "string");
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nSUBAGENT-WORKFLOW PROBE OK" : `\nSUBAGENT-WORKFLOW PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
