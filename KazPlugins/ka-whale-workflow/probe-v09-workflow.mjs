// ka-whale-workflow v0.9 探针：主/子 stage 机 + tools/pre-execute 软闸门 + 注入格式。
// 运行：node KazPlugins/ka-whale-workflow/probe-v09-workflow.mjs
import plugin, {
  DEFAULT_RECONSTRUCTION_TOOLS,
  createStageStore,
  KA_SUB_WHALE_TOOL,
  WORK_SUB_WHALE_REPORT_TOOL,
} from "./lib/index.js";
import {
  MAIN_ROLE,
  MAIN_STAGE_IDS,
  WORKER_STAGE_IDS,
  MEMORY_MAINTAINER_STAGE_IDS,
  PLUGIN_MAINTAINER_STAGE_IDS,
  PLUGIN_CREATOR_STAGE_IDS,
  stageInjectionText,
  canAdvance,
} from "./lib/stage-defs.js";
import { createTaskPlanStore, resolvePlanItemForDelegation } from "./lib/task-plan-store.js";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

const TMP = mkdtempSync(join(tmpdir(), "whale-v09-"));
const STORE_FILE = join(TMP, "ka-whale-workflow-stage.json");
const PLAN_FILE = join(TMP, "ka-whale-workflow-task-plan.json");
const store = createStageStore(STORE_FILE);
store.set("s-v09", "done");

// --- minimal plugin mock ---
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
  get: () => ({ enabled: true, includeSubagents: false, reconstructionTools: [...DEFAULT_RECONSTRUCTION_TOOLS] }),
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
const mockKazMode = {
  pluginConfig: () => ({ enabled: true, includeSubagents: false, reconstructionTools: [...DEFAULT_RECONSTRUCTION_TOOLS] }),
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
    return undefined;
  },
  systemPrompt: { section() { return () => {}; } },
  tools: toolsMock,
};

await plugin.apply(base, { stageStore: STORE_FILE, taskPlanStore: PLAN_FILE });
await new Promise((resolve) => setTimeout(resolve, 20));

const agent = {
  id: "s-v09",
  session: { id: "s-v09", events: [] },
  steer() {},
};
const userMessage = { content: [{ type: "text", text: "任务" }], source: { kind: "user" } };
const claimed = listeners.get("agent/inbox/claimed")?.[0];
const preExecute = listeners.get("tools/pre-execute")?.[0];
const whaleReport = registeredTools.get("whale_report");
const kaSubWhale = registeredTools.get(KA_SUB_WHALE_TOOL);

// 纯函数层
check("主 stage ids 与 v0.9 一致", JSON.stringify(MAIN_STAGE_IDS) === JSON.stringify(["assess-complexity","challenge-plan","decide-tools","write-plan","decide-goal","working","memory-maintenance","plugin-maintenance","communication"]));
check("worker/memory/plugin stage ids 齐全", WORKER_STAGE_IDS.includes("check-tools") && MEMORY_MAINTAINER_STAGE_IDS.includes("save-update") && PLUGIN_MAINTAINER_STAGE_IDS.includes("retire-plugin") && PLUGIN_CREATOR_STAGE_IDS.includes("create-plugin"));
check("write-plan 注入格式含 taskPlanPath", stageInjectionText(MAIN_ROLE, "write-plan", { taskPlanPath: "C:/plan.json" }).includes("taskPlanPath: C:/plan.json"));
check("create-plugin 注入格式含 lifecyclePath", stageInjectionText("pluginMaintainer", "create-plugin", { lifecyclePath: "C:/lifecycle.md" }).includes("lifecyclePath: C:/lifecycle.md"));
check("advance 校验拒绝非法边", canAdvance(MAIN_ROLE, "assess-complexity", "working") === false);

// Task plan draft/finalized 骨架
{
  const planStore = createTaskPlanStore(PLAN_FILE);
  planStore.persistDraftItems([{ planItemId: "p1", persona: "worker", task: "Do task", assignedTools: [] }]);
  check("draft 拒绝委派", resolvePlanItemForDelegation(planStore, "p1").ok === false);
  planStore.persistFinalPayload({ status: "finalized", items: [{ planItemId: "p1", persona: "worker", task: "Do task", assignedTools: [] }] });
  check("finalized 可解析", resolvePlanItemForDelegation(planStore, "p1").ok === true);
  const invalid = await kaSubWhale.execute({ planItemId: "missing" }, { agent });
  check("ka_sub_whale 无效 planItemId 结构化拒绝", invalid.ok === false && invalid.code === "plan-item-not-found");
}

// 插件级：进入 assess → 软闸门
await claimed({ agent, message: userMessage, turn: 2 });
const stageNow = JSON.parse(readFileSync(STORE_FILE, "utf8")).sessions?.["s-v09"];
check("新一轮消息进入 assess-complexity", stageNow === "assess-complexity");
const deny = await preExecute({ name: "read", agent }, async () => ({ kind: "allow" }));
check("assess 中调用 read 返回 workflow-stage-deny", deny.kind === "deny" && String(deny.reason).startsWith("workflow-stage-deny:"));
const allowMem = await preExecute({ name: "memory_search", agent }, async () => ({ kind: "allow" }));
check("assess 中调用 memory_search 放行", allowMem.kind === "allow");

// whale_report 推进到 communication 后再闸门
const result = await whaleReport.execute({ nextStage: "communication" }, { agent });
check("whale_report assess→communication", result.ok === true && result.stage === "communication");
const denyComm = await preExecute({ name: "read", agent }, async () => ({ kind: "allow" }));
check("communication 中调用 read 返回 workflow-stage-deny", denyComm.kind === "deny" && String(denyComm.reason).startsWith("workflow-stage-deny:"));

check("v0.9 工具已注册", registeredTools.has("whale_report") && registeredTools.has(KA_SUB_WHALE_TOOL) && registeredTools.has(WORK_SUB_WHALE_REPORT_TOOL));

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nV09 WORKFLOW PROBE OK" : `\nV09 WORKFLOW PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
