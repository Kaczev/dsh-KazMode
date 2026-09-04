// ka-whale-workflow 探针：enable_tool（第三次升级 · JIT 点亮）。
// 覆盖：点亮后 state 含 reason/at；重复点亮拒绝；初始已选拒绝；base/未知/池外拒绝；
// 空 reason 拒绝；无任务状态拒绝；round-display/audit 有记录。
// 运行：node KazPlugins/ka-whale-workflow/probe-enable-tool.mjs
import plugin, { DEFAULT_RECONSTRUCTION_TOOLS, createStageStore } from "./lib/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

const TMP = mkdtempSync(join(tmpdir(), "whale-enable-tool-"));
const STORE_FILE = join(TMP, "ka-whale-workflow-stage.json");
const store = createStageStore(STORE_FILE);
for (const id of ["s-add", "s-init", "s-none", "s-off"]) store.set(id, "done");
store.setTaskToolState("s-add", { taskRunId: 1, mode: "normal", initialOptionalTools: [], jitEnabledTools: [] });
store.setTaskToolState("s-init", { taskRunId: 1, mode: "normal", initialOptionalTools: ["safe_json_write"], jitEnabledTools: [] });

const listeners = new Map();
const registeredTools = new Map();
const roundReports = [];
const provided = {};

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
// v0.8 Step B1：create_plan 已移除，不再注册。
const mockKazMode = {
  pluginConfig: (agent) => {
    const baseCfg = { enabled: true, includeSubagents: false, reconstructionTools: [...DEFAULT_RECONSTRUCTION_TOOLS], taskToolSelectionEnabled: true };
    return agent?.id === "s-off" ? { ...baseCfg, taskToolSelectionEnabled: false } : baseCfg;
  },
  toolVisible: () => true,
  taskToolPoolOf: () => ["safe_json_write", "read_image"],
};
const goalsMock = { get: () => undefined, create: () => undefined };
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

await plugin.apply(base, { stageStore: STORE_FILE });
await new Promise((resolve) => setTimeout(resolve, 20));
const workflowService = provided["kaWhaleWorkflow"];
const enableTool = registeredTools.get("enable_tool");
check("enable_tool 已注册", enableTool !== undefined && enableTool.name === "enable_tool");
check("kaWhaleWorkflow.taskToolStateOf 可用", typeof workflowService.taskToolStateOf === "function");

function makeAgent(id) {
  return { id, session: { id, events: [] } };
}
const callEnable = async (agent, tool, reason) => enableTool.execute({ tool, reason }, { agent });
const rejectedWith = async (promise, pattern) => {
  try {
    await promise;
    return false;
  } catch (error) {
    return pattern.test(error.message);
  }
};

// ① 正常点亮：写 jitEnabledTools（tool/reason/at 审计）
{
  const agent = makeAgent("s-add");
  const result = await callEnable(agent, "safe_json_write", "需要安全写 JSON");
  check("enable_tool ok 返回 { ok, tool, reason }", result?.ok === true && result.tool === "safe_json_write" && result.reason === "需要安全写 JSON");
  const state = workflowService.taskToolStateOf(agent);
  check("点亮后 state.jitEnabledTools 含 reason/at", Array.isArray(state?.jitEnabledTools) && state.jitEnabledTools.length === 1 && state.jitEnabledTools[0].tool === "safe_json_write" && state.jitEnabledTools[0].reason === "需要安全写 JSON" && typeof state.jitEnabledTools[0].at === "string" && state.jitEnabledTools[0].at.length > 0);
  check("round-display 上报 enable_tool 审计", roundReports.some((entry) => entry?.plugin === "ka-whale-workflow" && entry?.title === "任务工具面" && typeof entry?.content === "string" && entry.content.includes("enable_tool: safe_json_write")));

  // ② 重复点亮拒绝
  check("重复点亮拒绝", await rejectedWith(callEnable(agent, "safe_json_write", "again"), /already enabled/));
  check("重复拒绝后 state 仍只有一条", workflowService.taskToolStateOf(agent).jitEnabledTools.length === 1);
}

// ③ 已在 initialOptionalTools 中 → 拒绝
{
  const agent = makeAgent("s-init");
  check("初始已选工具不可再 enable_tool", await rejectedWith(callEnable(agent, "safe_json_write", "redundant"), /already enabled as an initial optional tool/));
}

// ④ base 工具拒绝
{
  const agent = makeAgent("s-add");
  check("base 工具不在可选池 → 拒绝", await rejectedWith(callEnable(agent, "pwsh", "base"), /not in the current optional tool pool/));
}

// ⑤ 未知/当前 Kaz 面外工具拒绝
{
  const agent = makeAgent("s-add");
  check("未知工具拒绝", await rejectedWith(callEnable(agent, "not_a_tool", "why"), /not in the current optional tool pool/));
}

// ⑥ 空 reason / 缺失 reason 拒绝
{
  const agent = makeAgent("s-add");
  check("空 reason 拒绝", await rejectedWith(callEnable(agent, "read_image", "   "), /missing reason/));
  check("缺失/空白 tool 拒绝", await rejectedWith(enableTool.execute({ tool: "   ", reason: "x" }, { agent }), /missing tool/));
}

// ⑦ 无任务状态拒绝（任务过滤 inactive）
{
  const agent = makeAgent("s-none");
  check("无 taskToolState 拒绝", await rejectedWith(callEnable(agent, "safe_json_write", "no state"), /task tool filtering is inactive/));
}

// ⑧ 特性关闭拒绝
{
  const agent = makeAgent("s-off");
  check("taskToolSelectionEnabled=false 拒绝", await rejectedWith(callEnable(agent, "safe_json_write", "off"), /task tool filtering is inactive/));
}

// ⑨ 第二条点亮仍追加且不覆盖旧审计
{
  const agent = makeAgent("s-add");
  const before = workflowService.taskToolStateOf(agent).jitEnabledTools.length;
  await callEnable(agent, "read_image", "追加点亮");
  const after = workflowService.taskToolStateOf(agent).jitEnabledTools;
  check("第二次点亮追加审计不覆盖", after.length === before + 1 && after[after.length - 1].tool === "read_image" && after[after.length - 1].reason === "追加点亮");
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nENABLE-TOOL PROBE OK" : `\nENABLE-TOOL PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
