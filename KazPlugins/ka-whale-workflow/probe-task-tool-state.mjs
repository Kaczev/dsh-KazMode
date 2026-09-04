// ka-whale-workflow 探针：任务级工具状态（第三次升级）。
// 覆盖：stage-store round-trip / 损坏状态；进入 reconstruction 清旧状态；分类写状态；
// whale_report mode=goal 保留状态；直接 /goal 旁路清状态且 taskToolStateOf()=null；
// v0.8 Step B1：whale_report mode='plan' 被拒绝。
// 特性关闭不写状态。
// 运行：node KazPlugins/ka-whale-workflow/probe-task-tool-state.mjs
import plugin, {
  DEFAULT_RECONSTRUCTION_TOOLS,
  createStageStore,
  GOAL_ACTIVE_STAGE,
  normalizeTaskToolStateValue,
} from "./lib/index.js";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

const TMP = mkdtempSync(join(tmpdir(), "whale-task-tool-state-"));
const STORE_FILE = join(TMP, "ka-whale-workflow-stage.json");

// ---------------------------------------------------------------------------
// ① createStageStore taskToolState round-trip / 损坏回退
// ---------------------------------------------------------------------------
{
  const store = createStageStore(STORE_FILE);
  store.set("s-roundtrip", "done");
  const saved = store.setTaskToolState("s-roundtrip", {
    taskRunId: 3,
    mode: "plan",
    initialOptionalTools: [" safe_json_write ", "safe_json_write", ""],
    jitEnabledTools: [
      { tool: "read_image", reason: "need image", at: "2026-09-02T00:00:00.000Z" },
      { tool: "", reason: "bad" },
      null,
    ],
  });
  check("setTaskToolState 保存成功", saved === true);
  const got = store.getTaskToolState("s-roundtrip");
  check(
    "getTaskToolState 返回归一化副本",
    got !== null &&
      got.taskRunId === 3 &&
      got.mode === "plan" &&
      JSON.stringify(got.initialOptionalTools) === JSON.stringify(["safe_json_write"]) &&
      got.jitEnabledTools.length === 1 &&
      got.jitEnabledTools[0].tool === "read_image" &&
      got.jitEnabledTools[0].reason === "need image" &&
      got.jitEnabledTools[0].at === "2026-09-02T00:00:00.000Z",
  );
  const fileText = readFileSync(STORE_FILE, "utf8").replace(/^\uFEFF/, "");
  const parsed = JSON.parse(fileText);
  check("stage JSON version=5 且持久化 taskToolState", parsed?.version === 5 && parsed?.taskToolState?.["s-roundtrip"]?.mode === "plan");
  check("removeTaskToolState 删除后返回 null", store.removeTaskToolState("s-roundtrip") === true && store.getTaskToolState("s-roundtrip") === null);
  check("removeTaskToolState 再删返回 false", store.removeTaskToolState("s-roundtrip") === false);

  // 新 store 重读持久化文件
  const reloaded = createStageStore(STORE_FILE);
  check("reload 后仍能读 taskToolState（roundtrip 已删）", reloaded.getTaskToolState("s-roundtrip") === null);
  store.setTaskToolState("s-roundtrip", { taskRunId: 1, mode: "normal", initialOptionalTools: [], jitEnabledTools: [] });
  const reloaded2 = createStageStore(STORE_FILE);
  check("reload 后能读回已持久化状态", reloaded2.getTaskToolState("s-roundtrip")?.taskRunId === 1);
  store.removeTaskToolState("s-roundtrip");

  check(
    "normalizeTaskToolStateValue 损坏形状返回 null",
    normalizeTaskToolStateValue({ initialOptionalTools: "bad" }) === null &&
      normalizeTaskToolStateValue({ jitEnabledTools: {} }) === null &&
      normalizeTaskToolStateValue({ mode: "bad" }) === null &&
      normalizeTaskToolStateValue({ taskRunId: -1 }) === null &&
      normalizeTaskToolStateValue("x") === null,
  );
  check(
    "normalizeTaskToolStateValue 缺失字段默认 normal/0",
    normalizeTaskToolStateValue({})?.mode === "normal" &&
      normalizeTaskToolStateValue({})?.taskRunId === 0 &&
      JSON.stringify(normalizeTaskToolStateValue({})?.initialOptionalTools) === "[]",
  );

  // 损坏 JSON：新 store 当作空状态，不抛错。
  writeFileSync(STORE_FILE, "{ broken json", "utf8");
  const corrupt = createStageStore(STORE_FILE);
  check("JSON 损坏 → 无状态且不抛错", corrupt.getTaskToolState("any") === null && corrupt.get("any") === null);
}

// ---------------------------------------------------------------------------
// ② 插件级生命周期：进入 reconstruction 清旧状态 / 分类写状态 / bypass / feature off
// ---------------------------------------------------------------------------
const listeners = new Map();
const registeredTools = new Map();
const roundReports = [];
const provided = {};
const goalsMock = {
  created: [],
  get: () => undefined,
  create(agent, payload) {
    this.created.push({ agent: agent.id, payload });
    return undefined;
  },
};

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
// v0.8 Step B1：不再注册 create_plan；whale_report mode='plan' 应被拒绝。

const mockKazMode = {
  pluginConfig: (agent) => {
    const baseCfg = { enabled: true, includeSubagents: false, reconstructionTools: [...DEFAULT_RECONSTRUCTION_TOOLS] };
    return agent?.id === "s-off" ? { ...baseCfg, taskToolSelectionEnabled: false } : { ...baseCfg, taskToolSelectionEnabled: true };
  },
  toolVisible: () => true,
  taskToolPoolOf: () => ["safe_json_write", "read_image"],
};

const base = {
  fiber: { state: 0 },
  logger: { info: (...a) => console.log("[mock:info]", ...a), warn: (...a) => console.log("[mock:warn]", ...a), debug: () => {} },
  async plugin() { return; },
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(fn);
    return () => {};
  },
  inject(deps, cb) {
    if (deps.includes("settings")) {
      setImmediate(() => cb({ ...base, settings }));
    }
  },
  effect(fn) {
    const dispose = fn();
    return () => {
      if (typeof dispose === "function") dispose();
    };
  },
  provide(name, value) {
    provided[name] = value;
    return () => {
      delete provided[name];
    };
  },
  get(name) {
    if (name in provided) return provided[name];
    if (name === "settings") return settings;
    if (name === "tools") return toolsMock;
    if (name === "kazMode") return mockKazMode;
    if (name === "goals") return goalsMock;
    if (name === "agents") return { roots: () => [], list: () => [], currentInitiator: () => undefined };
    if (name === "roundDisplay") return { report: (entry) => roundReports.push(entry) };
    if (name === "roundMinimal") return undefined;
    return undefined;
  },
  systemPrompt: { section() { return () => {}; } },
  tools: toolsMock,
};

const store = createStageStore(STORE_FILE);
for (const id of ["s-clear", "s-classify", "s-plan", "s-goal", "s-bypass", "s-off", "s-invalid"]) store.set(id, "done");
store.setTaskToolState("s-clear", { taskRunId: 99, mode: "normal", initialOptionalTools: ["safe_json_write"], jitEnabledTools: [] });
store.setTaskToolState("s-classify", { taskRunId: 99, mode: "normal", initialOptionalTools: ["safe_json_write"], jitEnabledTools: [] });
store.setTaskToolState("s-plan", { taskRunId: 99, mode: "normal", initialOptionalTools: ["safe_json_write"], jitEnabledTools: [] });
store.setTaskToolState("s-goal", { taskRunId: 99, mode: "normal", initialOptionalTools: ["safe_json_write"], jitEnabledTools: [] });
store.setTaskToolState("s-bypass", { taskRunId: 99, mode: "normal", initialOptionalTools: ["safe_json_write"], jitEnabledTools: [] });
store.setTaskToolState("s-off", { taskRunId: 99, mode: "normal", initialOptionalTools: ["safe_json_write"], jitEnabledTools: [] });

await plugin.apply(base, { stageStore: STORE_FILE });
await new Promise((resolve) => setTimeout(resolve, 20));
const workflowService = provided["kaWhaleWorkflow"];
check("kaWhaleWorkflow 服务已提供 taskToolStateOf", workflowService !== undefined && typeof workflowService.taskToolStateOf === "function");
check("enable_tool 已注册（供任务过滤使用）", registeredTools.has("enable_tool"));

function makeAgent(id, extraEvents = []) {
  return {
    id,
    session: { id, events: extraEvents },
  };
}
const whaleReport = () => registeredTools.get("whale_report");
const execute = async (def, args, agent) => def.execute(args, { agent });
const claimedHandler = listeners.get("agent/inbox/claimed")[0];
const userMessage = { content: [{ type: "text", text: "新任务" }], source: { kind: "user" } };
/** 插件内部阶段推进到 assess-complexity（外部 store 与插件实例不同步，必须走 handler）。 */
const enterAssess = async (agent) => {
  await claimedHandler({ agent, message: userMessage, turn: 2 });
  return workflowService.stageOf(agent);
};
/** 每次从文件新建 store 读取持久化真相（避免外部实例内存陈旧）。 */
const storeNow = () => createStageStore(STORE_FILE);

// 进入 assess-complexity 清旧状态
{
  const agent = makeAgent("s-clear");
  const stage = await enterAssess(agent);
  check("新一轮真实消息进入 assess-complexity", stage === "assess-complexity");
  check("进入 assess-complexity 清除旧 taskToolState", storeNow().getTaskToolState("s-clear") === null);
  check("assess-complexity 阶段 taskToolStateOf=null（非 done）", workflowService.taskToolStateOf(agent) === null);
}

// v0.9 whale_report 从 assess-complexity 走 legal 推进，不再写任务工具状态
{
  const agent = makeAgent("s-classify");
  await enterAssess(agent);
  const result = await execute(whaleReport(), { nextStage: "communication" }, agent);
  check("whale_report nextStage=communication 从 assess 到 communication", result.stage === "communication");
  check("whale_report communication 后 stage=communication 且不写 taskToolState", workflowService.stageOf(agent) === "communication" && storeNow().getTaskToolState("s-classify") === null);
  check("communication 阶段 taskToolStateOf=null（任务过滤已退役）", workflowService.taskToolStateOf(agent) === null);
}

// whale_report mode=plan：v0.8 Step B1 已拒绝（原生 Plan 移除）
{
  const agent = makeAgent("s-plan");
  await enterAssess(agent);
  let rejected = false;
  try {
    await execute(whaleReport(), { mode: "plan" }, agent);
  } catch {
    rejected = true;
  }
  check("whale_report mode=plan → 拒绝（原生 Plan 已移除）", rejected === true && storeNow().getTaskToolState("s-plan") === null);
}

// whale_report mode=goal：从非 v0.9 stage 创建 goal，不写任务工具状态
{
  const agent = makeAgent("s-goal");
  const result = await execute(whaleReport(), { mode: "goal", objective: "test goal" }, agent);
  check("whale_report mode=goal → goal-active 并创建 goal", result.stage === GOAL_ACTIVE_STAGE && goalsMock.created.some((item) => item.agent === "s-goal" && item.payload.objective === "test goal"));
}

// legacy optional_tools 参数在 v0.9 被忽略，不校验不阻塞
{
  const agent = makeAgent("s-invalid");
  await enterAssess(agent);
  const result = await execute(whaleReport(), { mode: "normal", nextStage: "communication", optional_tools: ["pwsh"] }, agent);
  check("legacy optional_tools 忽略：仍 communication 且不报池校验", result.stage === "communication" && workflowService.stageOf(agent) === "communication" && storeNow().getTaskToolState("s-invalid") === null);
}

// 直接 /goal 旁路清状态且 taskToolStateOf=null
{
  const bypassEvents = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "step/start", data: { turn: 1, step: 1 } },
    { type: "step/end", data: { turn: 1, step: 1 } },
    { type: "turn/end", data: { turn: 1 } },
    { type: "command/run", data: { name: "goal", args: "目标", commandId: "cmd-bypass" } },
    { type: "command/done", data: { commandId: "cmd-bypass", kind: "success" } },
  ];
  const agent = makeAgent("s-bypass", bypassEvents);
  await claimedHandler({ agent, message: userMessage, turn: 1 });
  check("manual bypass 清除旧 taskToolState", storeNow().getTaskToolState("s-bypass") === null);
  check("manual bypass 时 taskToolStateOf=null", workflowService.taskToolStateOf(agent) === null);
}

// 特性关闭不写状态
{
  const agent = makeAgent("s-off");
  await enterAssess(agent);
  await execute(whaleReport(), { mode: "normal", nextStage: "communication", optional_tools: ["safe_json_write"] }, agent);
  check("特性关闭：communication 后不写 taskToolState", workflowService.stageOf(agent) === "communication" && storeNow().getTaskToolState("s-off") === null);
  check("特性关闭：taskToolStateOf=null", workflowService.taskToolStateOf(agent) === null);
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nTASK-TOOL-STATE PROBE OK" : `\nTASK-TOOL-STATE PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
