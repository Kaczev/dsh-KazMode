// ka-whale-workflow v0.9 探针：主/子 stage 机 + tools/pre-execute 软闸门 + 注入格式。
// 运行：node KazPlugins/ka-whale-workflow/probe-v09-workflow.mjs
import plugin, {
  createStageStore,
  KA_SUB_WHALE_TOOL,
  WORK_SUB_WHALE_REPORT_TOOL,
} from "./lib/index.js";
import {
  MAIN_ROLE,
  MAIN_STAGE_IDS,
  GOAL_ACTIVE_STAGE,
  GOAL_ACTIVE_CONTEXT_TEXT,
  workingResumedContextText,
  WORKER_STAGE_IDS,
  MEMORY_MAINTAINER_STAGE_IDS,
  PLUGIN_MAINTAINER_STAGE_IDS,
  PLUGIN_CREATOR_STAGE_IDS,
  stageInjectionText,
  stageDefinitionFor,
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
const planStore = createTaskPlanStore(PLAN_FILE);
planStore.persistDraftItems([
  { planItemId: "p1", persona: "worker", task: "Do task", assignedTools: [] },
  { planItemId: "p-main", persona: "main", task: "Main line task", assignedTools: [] },
  { planItemId: "p-creator", persona: "pluginCreator", task: "Create private plugin", assignedTools: [] },
  { planItemId: "p-memory", persona: "memoryMaintainer", task: "Write memory", assignedTools: [] },
  { planItemId: "p-maintainer", persona: "pluginMaintainer", task: "Maintain plugin", assignedTools: [] },
  { planItemId: "p-draft", persona: "worker", task: "Draft only", assignedTools: [] },
]);
planStore.persistFinalPayload({
  status: "finalized",
  items: [
    { planItemId: "p1", persona: "worker", task: "Do task", assignedTools: [] },
    { planItemId: "p-main", persona: "main", task: "Main line task", assignedTools: [] },
    { planItemId: "p-creator", persona: "pluginCreator", task: "Create private plugin", assignedTools: [] },
    { planItemId: "p-memory", persona: "memoryMaintainer", task: "Write memory", assignedTools: [] },
    { planItemId: "p-maintainer", persona: "pluginMaintainer", task: "Maintain plugin", assignedTools: [] },
  ],
});

const rdReports = [];
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
  get: () => ({ enabled: true, includeSubagents: false }),
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
  pluginConfig: () => ({ enabled: true, includeSubagents: false }),
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
    if (name === "roundDisplay") return { report: (payload) => rdReports.push(payload) };
    if (name === "subagents") {
      return {
        startContinuable: async () => ({ childId: "child-v09-365" }),
        reportFrom: async () => "report-v09-365",
      };
    }
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
check("主 stage ids 与 v0.9 36.5 一致", JSON.stringify(MAIN_STAGE_IDS) === JSON.stringify(["assess-complexity","challenge-plan","decide-tools","plugin-preflight","write-plan","decide-goal","working","memory-maintenance","plugin-maintenance","communication"]));
check("worker/memory/plugin stage ids 齐全", WORKER_STAGE_IDS.includes("check-tools") && MEMORY_MAINTAINER_STAGE_IDS.includes("save-update") && PLUGIN_MAINTAINER_STAGE_IDS.includes("retire-plugin") && PLUGIN_CREATOR_STAGE_IDS.includes("create-plugin"));
check("goal-active 不在 MAIN_STAGE_IDS", !MAIN_STAGE_IDS.includes(GOAL_ACTIVE_STAGE) && MAIN_STAGE_IDS.length === 10);
check("plugin-preflight 边：decide-tools→plugin-preflight→decide-tools", canAdvance(MAIN_ROLE, "decide-tools", "plugin-preflight") === true && canAdvance(MAIN_ROLE, "decide-tools", "write-plan") === true && canAdvance(MAIN_ROLE, "plugin-preflight", "decide-tools") === true && canAdvance(MAIN_ROLE, "plugin-preflight", "write-plan") === false);
check("plugin-preflight 注入含 taskPlanPath 与 pluginCreator-only 口径", stageInjectionText(MAIN_ROLE, "plugin-preflight", { taskPlanPath: "C:/plan.json" }).includes("taskPlanPath: C:/plan.json") && stageInjectionText(MAIN_ROLE, "plugin-preflight").includes("only persona=pluginCreator") && stageInjectionText(MAIN_ROLE, "plugin-preflight").includes("Can advance to: [decide-tools]"));
check("decide-goal 可推进 working 与 goal-active", canAdvance(MAIN_ROLE, "decide-goal", "working") === true && canAdvance(MAIN_ROLE, "decide-goal", GOAL_ACTIVE_STAGE) === true);
check("decide-goal 注入含 goal-active task 口径", stageInjectionText(MAIN_ROLE, "decide-goal").includes("Can advance to: [working, goal-active]") && stageInjectionText(MAIN_ROLE, "decide-goal").includes("that enters goal-active"));
check("goal-active §3.1 上下文文本存在", GOAL_ACTIVE_CONTEXT_TEXT.includes("[ka-whale-workflow goal-active]") && GOAL_ACTIVE_CONTEXT_TEXT.includes("ordinary stage progression is suspended") && GOAL_ACTIVE_CONTEXT_TEXT.includes("get_goal/update_goal"));
check("working-resumed §3.1 上下文携带实际 taskPlanPath", workingResumedContextText("C:/actual-plan.json").includes("taskPlanPath: C:/actual-plan.json") && workingResumedContextText("C:/actual-plan.json").includes("workflow resumes as if working finished"));
check("write-plan 注入格式含 taskPlanPath", stageInjectionText(MAIN_ROLE, "write-plan", { taskPlanPath: "C:/plan.json" }).includes("taskPlanPath: C:/plan.json"));
check("create-plugin 注入格式含 lifecyclePath", stageInjectionText("pluginMaintainer", "create-plugin", { lifecyclePath: "C:/lifecycle.md" }).includes("lifecyclePath: C:/lifecycle.md"));
check("advance 校验拒绝非法边", canAdvance(MAIN_ROLE, "assess-complexity", "working") === false);
{
  const challengeDef = stageDefinitionFor(MAIN_ROLE, "challenge-plan");
  const workerChallengeDef = stageDefinitionFor("worker", "challenge-plan");
  const workerCheckToolsDef = stageDefinitionFor("worker", "check-tools");
  const workingText = stageInjectionText(MAIN_ROLE, "working", { taskPlanPath: "C:/plan.json" });
  const workingDef = stageDefinitionFor(MAIN_ROLE, "working");
  check("36.5 challenge-plan 不持有 ka_sub_whale 且任务禁止写/定稿 plan", !challengeDef?.allowedTools.includes("ka_sub_whale") && typeof challengeDef?.task === "string" && challengeDef.task.includes("Do not write or finalize task plans") && challengeDef.task.includes("do not call ka_sub_whale"));
  check("36.7 主 challenge-plan task 含批评纪律", typeof challengeDef?.task === "string" && challengeDef.task.includes("Critique the user's approach first") && challengeDef.task.includes("identify real weaknesses") && challengeDef.task.includes("do not manufacture criticism"));
  check("36.7 worker challenge-plan task 含批评纪律", typeof workerChallengeDef?.task === "string" && workerChallengeDef.task.includes("Critique the delegation first") && workerChallengeDef.task.includes("do not manufacture criticism"));
  check("36.8 worker challenge-plan 只可推进 check-tools", JSON.stringify(workerChallengeDef?.canAdvance) === JSON.stringify(["check-tools"]));
  check("36.8 worker challenge/check-tools 文本说明文件工具只在 working 且不得提前报告不足", typeof workerChallengeDef?.task === "string" && workerChallengeDef.task.includes("full working file-tool set (edit, write, pwsh, read) is granted in the working stage") && workerChallengeDef.task.includes("Do not report tool insufficiency before reaching working") && typeof workerCheckToolsDef?.task === "string" && workerCheckToolsDef.task.includes("do not report tool insufficiency before reaching working") && workerCheckToolsDef.task.includes("genuine blocker"));
  check("36.8 working 只可推进 write-plan/memory-maintenance", JSON.stringify(workingDef?.canAdvance) === JSON.stringify(["write-plan", "memory-maintenance"]));
  check("36.8 working task 含逐个 worker 委派/保留维护项/强制 memory gate", typeof workingDef?.task === "string" && workingDef.task.includes("delegate each persona=worker plan item individually via ka_sub_whale") && workingDef.task.includes("Do not delegate memoryMaintainer/pluginMaintainer/pluginCreator plan items in working") && workingDef.task.includes("always advance to memory-maintenance before any communication") && workingDef.task.includes("advance to plugin-maintenance from memory-maintenance only when plugin work remains"));
  check("36.8 write-plan task 含按 coherent task 拆分 planItems", typeof stageDefinitionFor(MAIN_ROLE, "write-plan")?.task === "string" && stageDefinitionFor(MAIN_ROLE, "write-plan").task.includes("separate planItems per coherent task") && stageDefinitionFor(MAIN_ROLE, "write-plan").task.includes("do not pack all work into one planItem"));
  check("36.7 主 working task 批判性评估子代理批评", typeof workingDef?.task === "string" && workingDef.task.includes("critically evaluates subagent reports and their critiques") && workingDef.task.includes("instead of accepting them blindly"));
  check("36.5 working 注入携带 taskPlanPath", workingText.includes("taskPlanPath: C:/plan.json"));
}

// Task plan draft/finalized 骨架（planStore 在 plugin.apply 前预写，plugin store 可见）
{
  check("draft 拒绝委派", resolvePlanItemForDelegation(planStore, "p-draft").ok === false);
  check("finalized 可解析", resolvePlanItemForDelegation(planStore, "p1").ok === true);
  check("task plan store 接受 persona=main", planStore.get("p-main")?.persona === "main" && planStore.get("p-main")?.status === "finalized" && resolvePlanItemForDelegation(planStore, "p-main").ok === true);
  const invalid = await kaSubWhale.execute({ planItemId: "missing" }, { agent });
  check("ka_sub_whale 无效 planItemId 结构化拒绝", invalid.ok === false && invalid.code === "plan-item-not-found");
  const mainRejected = await kaSubWhale.execute({ planItemId: "p-main" }, { agent });
  check("ka_sub_whale 拒绝 persona=main 委派（结构化）", mainRejected.ok === false && mainRejected.code === "main-persona-delegation-denied");
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

// 36.5 用户插话/新轮路由：终态 communication 重置；活动阶段保留。
await claimed({ agent, message: userMessage, turn: 2 });
check("36.5 communication 收到新一轮真实用户消息进入 assess-complexity", JSON.parse(readFileSync(STORE_FILE, "utf8")).sessions?.["s-v09"] === "assess-complexity");

// 36.5 plugin-preflight runtime: advance plugin-internal stage to plugin-preflight,
// then verify pluginCreator-only finalization/delegation and stage preservation.
await whaleReport.execute({ nextStage: "challenge-plan" }, { agent });
await whaleReport.execute({ nextStage: "decide-tools" }, { agent });
await whaleReport.execute({ nextStage: "plugin-preflight" }, { agent });
let badPayloadError = null;
try {
  await whaleReport.execute(
    { finalPlanPayload: { status: "finalized", items: [{ planItemId: "p1", persona: "worker", task: "Do task", assignedTools: [] }] } },
    { agent },
  );
} catch (error) {
  badPayloadError = error;
}
check("plugin-preflight 拒绝非 pluginCreator finalPlanPayload", badPayloadError !== null && String(badPayloadError.message).includes("pluginCreator"));
const preflightOk = await whaleReport.execute(
  { finalPlanPayload: { status: "finalized", items: [{ planItemId: "p-creator", persona: "pluginCreator", task: "Create private plugin", assignedTools: [] }] }, nextStage: "decide-tools" },
  { agent },
);
check("plugin-preflight 可 pre-finalize pluginCreator 并回到 decide-tools", preflightOk.ok === true && preflightOk.stage === "decide-tools");
await whaleReport.execute({ nextStage: "plugin-preflight" }, { agent });
const workerInPreflight = await kaSubWhale.execute({ planItemId: "p1" }, { agent });
check("plugin-preflight 拒绝非 pluginCreator ka_sub_whale 委派", workerInPreflight.ok === false && workerInPreflight.code === "stage-persona-mismatch");
const creatorInPreflight = await kaSubWhale.execute({ planItemId: "p-creator" }, { agent });
check("plugin-preflight 允许 pluginCreator ka_sub_whale 委派", creatorInPreflight.ok === true && creatorInPreflight.code === "subagent-created");
await claimed({ agent, message: userMessage, turn: 2 });
check("36.5 plugin-preflight 收到新一轮真实用户消息保留 plugin-preflight", JSON.parse(readFileSync(STORE_FILE, "utf8")).sessions?.["s-v09"] === "plugin-preflight");

// 36.8 stage-persona mapping runtime: reach working through write-plan/decide-goal,
// then verify each stage only delegates its mapped persona.
await whaleReport.execute(
  { finalPlanPayload: { status: "finalized", items: [{ planItemId: "p-creator", persona: "pluginCreator", task: "Create private plugin", assignedTools: [] }] }, nextStage: "decide-tools" },
  { agent },
);
await whaleReport.execute({ nextStage: "write-plan" }, { agent });
await whaleReport.execute(
  {
    finalPlanPayload: {
      status: "finalized",
      items: [
        { planItemId: "p1", persona: "worker", task: "Do task", assignedTools: [] },
        { planItemId: "p-main", persona: "main", task: "Main line task", assignedTools: [] },
        { planItemId: "p-creator", persona: "pluginCreator", task: "Create private plugin", assignedTools: [] },
        { planItemId: "p-memory", persona: "memoryMaintainer", task: "Write memory", assignedTools: [] },
        { planItemId: "p-maintainer", persona: "pluginMaintainer", task: "Maintain plugin", assignedTools: [] },
      ],
    },
    nextStage: "decide-goal",
  },
  { agent },
);
await whaleReport.execute({ nextStage: "working" }, { agent });
const memoryInWorking = await kaSubWhale.execute({ planItemId: "p-memory" }, { agent });
check("working 拒绝 memoryMaintainer 委派（stage-persona-mismatch）", memoryInWorking.ok === false && memoryInWorking.code === "stage-persona-mismatch");
const creatorInWorking = await kaSubWhale.execute({ planItemId: "p-creator" }, { agent });
check("working 拒绝 pluginCreator 委派（stage-persona-mismatch）", creatorInWorking.ok === false && creatorInWorking.code === "stage-persona-mismatch");
const workerInWorking = await kaSubWhale.execute({ planItemId: "p1" }, { agent });
check("working 允许 worker 委派", workerInWorking.ok === true && workerInWorking.code === "subagent-created");
const workingDefault = await whaleReport.execute({}, { agent });
check("whale_report 从 working 默认推进到 memory-maintenance", workingDefault.ok === true && workingDefault.stage === "memory-maintenance");
const workerInMemory = await kaSubWhale.execute({ planItemId: "p1" }, { agent });
check("memory-maintenance 拒绝 worker 委派（stage-persona-mismatch）", workerInMemory.ok === false && workerInMemory.code === "stage-persona-mismatch");
const memoryInMemory = await kaSubWhale.execute({ planItemId: "p-memory" }, { agent });
check("memory-maintenance 允许 memoryMaintainer 委派", memoryInMemory.ok === true && memoryInMemory.code === "subagent-created");
await whaleReport.execute({ nextStage: "plugin-maintenance" }, { agent });
const memoryInPlugin = await kaSubWhale.execute({ planItemId: "p-memory" }, { agent });
check("plugin-maintenance 拒绝 memoryMaintainer 委派（stage-persona-mismatch）", memoryInPlugin.ok === false && memoryInPlugin.code === "stage-persona-mismatch");
const maintainerInPlugin = await kaSubWhale.execute({ planItemId: "p-maintainer" }, { agent });
check("plugin-maintenance 允许 pluginMaintainer 委派", maintainerInPlugin.ok === true && maintainerInPlugin.code === "subagent-created");

check("v0.9 工具已注册", registeredTools.has("whale_report") && registeredTools.has(KA_SUB_WHALE_TOOL) && registeredTools.has(WORK_SUB_WHALE_REPORT_TOOL));
check("36.6 ka_sub_whale description 含异步等待提示", typeof kaSubWhale?.description === "string" && kaSubWhale.description.includes("end the current turn and await its report/finished message") && kaSubWhale.description.includes("do not use pwsh sleep or poll list_agents"));
check("36.6 ka_sub_whale 成功输出含 notice", creatorInPreflight?.ok === true && typeof creatorInPreflight?.notice === "string" && creatorInPreflight.notice.includes("End the current turn and await its report/finished message") && creatorInPreflight.notice.includes("not wait primitives"));

// 36.6 main-side subagent-report capture: parent agent receives subagent report
// and settled messages, and ka-whale-workflow reports one-line summaries to
// round-display keyed to the parent agent.
{
  const preStep = listeners.get("agent/pre-step")?.[0];
  const parent = { id: "s-parent-366", session: { id: "s-parent-366", events: [] } };
  const reportMessage = {
    role: "user",
    content: [{ type: "text", text: "parent report\nsecond line" }],
    source: { kind: "subagent-report", form: "relay" },
  };
  const settledMessage = {
    role: "user",
    content: [],
    source: { kind: "subagent-settled", form: "notice", summary: "settled summary here" },
  };
  const before = rdReports.length;
  const preDecision = { kind: "enter", messages: [reportMessage, settledMessage] };
  await preStep({ agent: parent, turn: 1 }, async () => preDecision);
  const subagentReports = rdReports
    .slice(before)
    .filter(
      (payload) =>
        payload?.category === "subagent-report" &&
        payload?.plugin === "ka-whale-workflow" &&
        payload?.agent?.id === parent.id,
    );
  check(
    "36.6 父代理 pre-step 收到 subagent-report/settled 产生主会话 round-display 记录",
    subagentReports.length === 2 &&
      subagentReports.some((payload) => payload.content === "parent report second line") &&
      subagentReports.some((payload) => payload.content === "settled summary here"),
  );
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nV09 WORKFLOW PROBE OK" : `\nV09 WORKFLOW PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
