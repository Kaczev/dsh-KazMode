// ka-whale-workflow v0.9 受控子代理 workflow 探针：
//   - includeSubagents=false 时受控 v0.9 子代理仍被治理（不跳过）；
//   - idle 初始化 role 首阶段（worker=assess-complexity，其余=assess-delegation）；
//   - role 专属 [ka-whale-workflow <stage>] 按 pending 注入一次；
//   - plugin create/update/retire 注入携带 lifecyclePath；
//   - 受控角色不注入旧通用 SUBAGENT_FLOW_TEXT；旧/未知子代理仅在 includeSubagents=true 时注入。
//   - tools/pre-execute 按 role/stage Allowed tools 软闸门。
// 运行：node KazPlugins/ka-whale-workflow/probe-subagent-workflow.mjs
import plugin, {
  createStageStore,
  SUBAGENT_FLOW_TEXT,
  V09_SUBAGENT_ROLE_INITIAL_STAGES,
} from "./lib/index.js";
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
      if (name === "roundDisplay") return { report: () => {} };
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
  return { listeners, registeredTools, base, capturedReports };
}

function stageFromFile(file, sessionId) {
  const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw).sessions?.[sessionId] ?? null;
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
    finalTools: ["memory_search", "work_sub_whale_report"],
  });
  store.setSubagentRole("child-memory", {
    planItemId: "p-memory",
    persona: "memoryMaintainer",
    assignedTools: [],
    finalTools: ["memory_search", "memory_sub_whale_report"],
  });
  store.setSubagentRole("child-plugin-maintainer-create", {
    planItemId: "p-pm-create",
    persona: "pluginMaintainer",
    assignedTools: [],
    finalTools: ["read", "write", "plugin_maintainer_sub_whale_report"],
  });
  store.setSubagentRole("child-plugin-creator", {
    planItemId: "p-pc",
    persona: "pluginCreator",
    assignedTools: [],
    finalTools: ["read", "plugin_creator_sub_whale_report"],
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

check("V09_SUBAGENT_ROLE_INITIAL_STAGES 映射正确", V09_SUBAGENT_ROLE_INITIAL_STAGES.worker === "assess-complexity" && V09_SUBAGENT_ROLE_INITIAL_STAGES.memoryMaintainer === "assess-delegation" && V09_SUBAGENT_ROLE_INITIAL_STAGES.pluginMaintainer === "assess-delegation" && V09_SUBAGENT_ROLE_INITIAL_STAGES.pluginCreator === "assess-delegation");

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
  const deny = await preExecute({ name: "read", agent }, async () => ({ kind: "allow" }));
  const allow = await preExecute({ name: "memory_search", agent }, async () => ({ kind: "allow" }));
  check("worker assess-complexity 软闸门：read 拒绝、memory_search 放行", deny?.kind === "deny" && String(deny.reason).startsWith("workflow-stage-deny:") && allow?.kind === "allow");
}

// *_sub_whale_report：output + nextStage 应同时推进角色 workflow 并原生汇报给主模型。
{
  const agent = subagentAgent("child-worker");
  // child-worker 已在上一段进入 assess-complexity；这里验证推进能力。
  check("前置：child-worker 处于 assess-complexity", stageFromFile(STORE_FILE, "child-worker") === "assess-complexity");
  const workReport = h1.registeredTools.get("work_sub_whale_report");
  const beforeReports = h1.capturedReports.length;
  const result = await workReport.execute(
    { output: "assessed: complex delegation", nextStage: "challenge-plan" },
    { agent, signal: new AbortController().signal },
  );
  check("report+nextStage 推进 worker assess-complexity → challenge-plan", result?.stage === "challenge-plan" && result?.role === "worker" && stageFromFile(STORE_FILE, "child-worker") === "challenge-plan");
  check("report+nextStage 仍调用原生 reportFrom 汇报给主模型", result?.messageId === "report-1" && h1.capturedReports.length === beforeReports + 1);
  check("reportFrom 收到输出内容与 delivery=next-step", h1.capturedReports.at(-1)?.options?.delivery === "next-step" && JSON.stringify(h1.capturedReports.at(-1)?.content ?? []).includes("assessed: complex delegation"));
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

// pluginCreator: idle 进入 assess-delegation（不同于 worker 的 assess-complexity）。
{
  const agent = subagentAgent("child-plugin-creator");
  await claimed({ agent, message: userMessage, turn: 1 });
  check("includeSubagents=false：pluginCreator 受控子代理仍进入 assess-delegation", stageFromFile(STORE_FILE, "child-plugin-creator") === "assess-delegation");
  const decision = await preStep({ agent, turn: 1, messages: [] }, nextEnter);
  const text = messageText(decision?.messages ?? []);
  check("pluginCreator 注入 role stage 文本", text.includes("[ka-whale-workflow assess-delegation]") && text.includes("plugin_creator_sub_whale_report"));
  const deny = await preExecute({ name: "write", agent }, async () => ({ kind: "allow" }));
  const allow = await preExecute({ name: "read", agent }, async () => ({ kind: "allow" }));
  check("pluginCreator assess-delegation 软闸门：write 拒绝、read 放行", deny?.kind === "deny" && String(deny.reason).startsWith("workflow-stage-deny:") && allow?.kind === "allow");
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
  await claimed2({ agent, message: userMessage, turn: 1 });
  check("includeSubagents=true：旧/未知子代理可进入通用主 stage 外壳", stageFromFile(GEN_STORE, "legacy-child") === "assess-complexity");
  const decision = await preStep2({ agent, turn: 1, messages: [] }, nextEnter);
  const text = messageText(decision?.messages ?? []);
  check("includeSubagents=true：旧/未知子代理注入 SUBAGENT_FLOW_TEXT", text.includes("[ka-whale-workflow subagent flow]"));
  check("SUBAGENT_FLOW_TEXT 常量未被删除", typeof SUBAGENT_FLOW_TEXT === "string" && SUBAGENT_FLOW_TEXT.includes("work_sub_whale_report"));
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nSUBAGENT-WORKFLOW PROBE OK" : `\nSUBAGENT-WORKFLOW PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
