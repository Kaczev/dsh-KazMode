// kaz-mode 探针：任务分类工具选择（第三次升级）—— kazSurfaceFor 任务过滤。
// 覆盖：selected optional 进面；unselected optional 不进最终面；Goal 三件套常驻、
// 原生 Plan 已移除（旧 plan/mode 事件不追加工具）；memory 开时 memory 工具在基础面；
// enable_tool 在任务过滤开启时可见；无任务状态 = 全量白名单（feature off）；
// unfilteredSurfaceOf/taskToolPoolOf 一致；assemble 与 pre-execute 同走 kazSurfaceFor。
// 运行：node KazPlugins/kaz-mode/probe-task-surface-filter.mjs
import plugin from "file:///C:/Users/Kaczev/.dsh/profiles/web/KazPlugins/kaz-mode/lib/index.js";
import { optionalToolPoolNames } from "../kaz-shared/lib/tool-lists.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

const TMP = mkdtempSync(join(tmpdir(), "kaz-surface-filter-"));
const PROJECT_A = join(TMP, "proj-a"); // memory on, feature on
const PROJECT_B = join(TMP, "proj-b"); // memory off
for (const dir of [PROJECT_A, PROJECT_B]) {
  mkdirSync(join(dir, ".dsh", "storages"), { recursive: true });
}
function writeProjectStates(dir, states) {
  writeFileSync(
    join(dir, ".dsh", "storages", "kaz-project-states.json"),
    JSON.stringify({ version: 1, states }, null, 2),
    "utf8",
  );
}
writeProjectStates(PROJECT_A, { "ka-whale-workflow": { enabled: true, taskToolSelectionEnabled: true } });
writeProjectStates(PROJECT_B, { "ka-whale-memory": { enabled: false }, "ka-whale-workflow": { enabled: true, taskToolSelectionEnabled: true } });

// 用户默认四文件：把 read_image / job_list / subagent 放进 Kaz 白名单。
const STORAGE_DIR = join(TMP, "dsh-storages");
mkdirSync(STORAGE_DIR, { recursive: true });
writeFileSync(
  join(STORAGE_DIR, "tool-plugin.json"),
  JSON.stringify({ "tool-fs": true, "tool-jobs": true, "tool-subagent": true }, null, 2),
  "utf8",
);
writeFileSync(
  join(STORAGE_DIR, "tool-plugin-catalog.json"),
  JSON.stringify(
    {
      "tool-fs": { read_image: true },
      "tool-jobs": { job_list: true },
      "tool-subagent": { subagent: true },
    },
    null,
    2,
  ),
  "utf8",
);

const SESSIONS = {
  "s-sel": { cwd: PROJECT_A, agentPreset: "kaz" },
  "s-empty": { cwd: PROJECT_A, agentPreset: "kaz" },
  "s-nostate": { cwd: PROJECT_A, agentPreset: "kaz" },
  "s-plan": { cwd: PROJECT_A, agentPreset: "kaz" },
  "s-goal": { cwd: PROJECT_A, agentPreset: "kaz" },
  "s-nomem": { cwd: PROJECT_B, agentPreset: "kaz" },
  "s-ctrl": { cwd: PROJECT_A, agentPreset: "kaz" },
};

const eventsOf = (id) => {
  const base = [{ type: "tool/call", seq: 0, time: Date.now(), data: { name: "pwsh" } }];
  if (id === "s-plan") return [...base, { type: "plan/mode", seq: 1, time: Date.now(), data: { active: true } }];
  return base;
};
const agentOf = (id) => ({
  id,
  session: { header: { id, cwd: SESSIONS[id].cwd, agentPreset: SESSIONS[id].agentPreset }, events: eventsOf(id) },
});
const agentOfSubagent = (id) => ({
  id,
  options: { subagentDepth: 1 },
  session: { header: { id, cwd: SESSIONS[id].cwd, agentPreset: SESSIONS[id].agentPreset }, events: eventsOf(id) },
});

/** 模拟 kaWhaleWorkflow.taskToolStateOf：s-nostate 返回 null，其余返回任务状态。 */
const taskStates = {
  "s-sel": {
    taskRunId: 1,
    mode: "normal",
    initialOptionalTools: ["read_image"],
    jitEnabledTools: [{ tool: "job_list", reason: "need job list", at: "2026-09-02T00:00:00.000Z" }],
  },
  "s-empty": { taskRunId: 1, mode: "normal", initialOptionalTools: [], jitEnabledTools: [] },
  "s-plan": { taskRunId: 1, mode: "plan", initialOptionalTools: [], jitEnabledTools: [] },
  "s-goal": { taskRunId: 1, mode: "goal", initialOptionalTools: [], jitEnabledTools: [] },
  "s-nomem": { taskRunId: 1, mode: "normal", initialOptionalTools: [], jitEnabledTools: [] },
};
const CONTROLLED_WORKER_SURFACE = [
  "edit",
  "glob",
  "grep",
  "memory_detail",
  "memory_list",
  "memory_search",
  "pwsh",
  "read",
  "todo_write",
  "web_search",
  "write",
  "work_sub_whale_report",
  "job_list",
];
const kaWhaleMock = {
  stageOf: (agent) => "done",
  taskToolStateOf: (agent) => (agent !== null && typeof agent === "object" ? taskStates[agent.id] ?? null : null),
  subagentRoleOf: (agent) =>
    agent?.id === "s-ctrl"
      ? { persona: "worker", assignedTools: ["job_list"], finalTools: [...CONTROLLED_WORKER_SURFACE] }
      : null,
  subagentSurfaceOf: (agent) => (agent?.id === "s-ctrl" ? [...CONTROLLED_WORKER_SURFACE] : null),
};

const listeners = new Map();
const provided = {};
const agentsBySession = new Map();
for (const [id] of Object.entries(SESSIONS)) agentsBySession.set(id, agentOf(id));
const goalsByAgent = new Map();
goalsByAgent.set("s-goal", { phase: "active" });

function makeSettings() {
  const userSections = new Map();
  const bases = new Map();
  const watches = new Map();
  const resolve = (ns) => ({ ...(bases.get(ns) ?? {}), ...(userSections.get(ns) ?? {}) });
  const commit = (ns) => {
    for (const cb of watches.get(ns) ?? []) {
      try {
        cb(resolve(ns), undefined);
      } catch {
        // ignore
      }
    }
  };
  return {
    register(ns, _schema, opts = {}) {
      bases.set(ns, opts.base ?? {});
      return {
        get: () => resolve(ns),
        watch: (cb) => {
          if (!watches.has(ns)) watches.set(ns, []);
          watches.get(ns).push(cb);
          return () => {};
        },
        update: (patch) => {
          userSections.set(ns, { ...(userSections.get(ns) ?? {}), ...patch });
          commit(ns);
          return Promise.resolve();
        },
        replace: (section) => {
          userSections.set(ns, { ...section });
          commit(ns);
          return Promise.resolve();
        },
      };
    },
    get: (ns) => resolve(ns),
    update(ns, patch) {
      userSections.set(ns, { ...(userSections.get(ns) ?? {}), ...patch });
      commit(ns);
      return Promise.resolve();
    },
    describe: () => [],
  };
}
const settings = makeSettings();
const mockTools = {
  register() {
    return () => {};
  },
  schemas() {
    return [];
  },
  ctx: null,
};
const rpcHandlers = new Map();
const mockConnection = {
  rpc: {
    handle(channel, handler, _options) {
      rpcHandlers.set(channel, handler);
      return () => {
        rpcHandlers.delete(channel);
      };
    },
  },
};
const ctx = {
  fiber: { state: 0 },
  tools: mockTools,
  logger: { info: () => {}, warn: (...a) => console.log("[mock:warn]", ...a), debug: () => {} },
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(fn);
    return () => {};
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
    if (name === "agents") return { get: (sid) => agentsBySession.get(sid) ?? undefined };
    if (name === "goals") return { get: (agent) => goalsByAgent.get(agent?.id) ?? undefined };
    if (name === "kaWhaleWorkflow") return kaWhaleMock;
    if (name === "connection") return mockConnection;
    return undefined;
  },
  inject(deps, cb) {
    if (deps.includes("settings")) cb({ ...ctx, settings });
  },
};

plugin.apply(ctx, { enabled: true, storageDir: STORAGE_DIR });
await new Promise((resolve) => setTimeout(resolve, 20));
const kazMode = provided["kazMode"];
check("kazMode 服务已提供新方法", kazMode !== undefined && typeof kazMode.unfilteredSurfaceOf === "function" && typeof kazMode.taskToolPoolOf === "function");

const sSel = agentOf("s-sel");
const sEmpty = agentOf("s-empty");
const sNoState = agentOf("s-nostate");
const sPlan = agentOf("s-plan");
const sGoal = agentOf("s-goal");
const sNomem = agentOf("s-nomem");

// ① v0.8 Step A：unfilteredSurfaceOf/taskToolPoolOf 也按固定主面（不再暴露外部可选）
{
  const unfiltered = kazMode.unfilteredSurfaceOf(sSel);
  check("unfilteredSurfaceOf 返回 Stable Main（无 read_image/job_list/enable_tool）", unfiltered !== null && !unfiltered.has("read_image") && !unfiltered.has("job_list") && !unfiltered.has("enable_tool"));
  check("unfilteredSurfaceOf 含 v0.9 固定工具（read/ka_sub_whale/controls/whale_report）", unfiltered !== null && unfiltered.has("read") && unfiltered.has("ka_sub_whale") && unfiltered.has("list_agents") && unfiltered.has("send_message") && unfiltered.has("interrupt_agent") && unfiltered.has("whale_report") && !unfiltered.has("subagent") && !unfiltered.has("create_goal"));
  const pool = kazMode.taskToolPoolOf(sSel);
  check("taskToolPoolOf 不含外部候选 read_image/job_list/enable_tool/模式工具", !pool.includes("read_image") && !pool.includes("job_list") && !pool.includes("enable_tool") && !pool.includes("exit_plan_mode"));
  const unfilteredNomem = kazMode.unfilteredSurfaceOf(sNomem);
  check("unfilteredSurfaceOf(memory off) 不含 memory 工具", unfilteredNomem !== null && !unfilteredNomem.has("memory_search") && !unfilteredNomem.has("memory_save"));
  check("taskToolPoolOf(memory off) 不含 memory 工具", !kazMode.taskToolPoolOf(sNomem).includes("memory_search"));
}

// ② v0.8 Step A：surfaceOf 忽略任务状态，恒为 Stable Main
{
  const surface = kazMode.surfaceOf(sSel);
  check("surfaceOf(selected) 含基础工具", surface.has("read") && surface.has("pwsh") && surface.has("web_search"));
  check("surfaceOf(selected) 不含初始 optional（read_image）", !surface.has("read_image"));
  check("surfaceOf(selected) 不含 JIT 已点亮（job_list）", !surface.has("job_list"));
  check("surfaceOf(selected) 含 v0.9 固定控制工具", surface.has("ka_sub_whale") && surface.has("list_agents") && surface.has("send_message") && surface.has("interrupt_agent"));
  check("surfaceOf(selected) 不含旧 subagent/create_goal", !surface.has("subagent") && !surface.has("create_goal"));
  check("surfaceOf(selected) 不含 enable_tool", !surface.has("enable_tool"));
  check("surfaceOf(selected, memory on) 读记忆进面、写记忆不进", surface.has("memory_search") && surface.has("memory_list") && surface.has("memory_detail") && !surface.has("memory_save") && !surface.has("memory_update") && !surface.has("memory_forget"));
  const emptySurface = kazMode.surfaceOf(sEmpty);
  check("空 optional 列表与 selected 相同（固定主面）", emptySurface.has("read") && !emptySurface.has("read_image") && !emptySurface.has("job_list") && !emptySurface.has("enable_tool"));
  const noStateSurface = kazMode.surfaceOf(sNoState);
  check("无任务状态 = 固定主面（不回退旧全量、不加 enable_tool）", noStateSurface.has("read") && noStateSurface.has("ka_sub_whale") && !noStateSurface.has("subagent") && !noStateSurface.has("read_image") && !noStateSurface.has("job_list") && !noStateSurface.has("enable_tool"));
}

// ③ v0.8 Step A/B1：Goal 三件套常驻；原生 Plan 已移除，旧 plan/mode 事件不再例外
{
  const planSurface = kazMode.surfaceOf(sPlan);
  check("旧 plan/mode 事件不再加入 exit_plan_mode（B1 移除 Plan 例外）", !planSurface.has("exit_plan_mode"));
  check("旧 plan/mode 事件下外部 optional 仍不进面", !planSurface.has("read_image") && !planSurface.has("job_list"));
  const goalSurface = kazMode.surfaceOf(sGoal);
  check("goal 激活：get_goal/update_goal 常驻，create_goal 不放行（非动态）", goalSurface.has("get_goal") && goalSurface.has("update_goal") && !goalSurface.has("create_goal"));
  check("goal 激活：外部 optional 仍不进面", !goalSurface.has("job_list") && !goalSurface.has("read_image"));
}

// ④ memory 开关
{
  const emptyMemSurface = kazMode.surfaceOf(sEmpty);
  check("memory on：记忆读工具进面、写工具不进", emptyMemSurface.has("memory_search") && emptyMemSurface.has("memory_list") && !emptyMemSurface.has("memory_save") && !emptyMemSurface.has("memory_forget"));
  const nomemSurface = kazMode.surfaceOf(sNomem);
  check("memory off：memory 工具不进面", !nomemSurface.has("memory_search") && !nomemSurface.has("memory_save"));
  check("memory off：固定基础工具不受影响且无 enable_tool", nomemSurface.has("read") && !nomemSurface.has("enable_tool") && !nomemSurface.has("read_image"));
}

// ⑤ v0.9 B3：受控 worker 子代理面 = role Stable Base + assignedTools
{
  const ctrl = agentOfSubagent("s-ctrl");
  const ctrlSurface = kazMode.surfaceOf(ctrl);
  check("受控 worker 子代理面含 role report + assigned tool-jobs", ctrlSurface.has("work_sub_whale_report") && ctrlSurface.has("job_list") && ctrlSurface.has("write"));
  check("受控 worker 子代理面不含记忆写工具", !ctrlSurface.has("memory_save") && !ctrlSurface.has("memory_forget"));
  const ctrlMinimal = {
    ...agentOfSubagent("s-ctrl"),
    session: {
      header: SESSIONS["s-ctrl"],
      events: [],
    },
  };
  const ctrlMinimalSurface = kazMode.surfaceOf(ctrlMinimal);
  check("受控 worker 子代理首轮 Minimal = §1.7", ctrlMinimalSurface.has("memory_search") && ctrlMinimalSurface.has("work_sub_whale_report") && ctrlMinimalSurface.size <= 2);
}

// ⑥ assemble 与 pre-execute 使用同一稳定主面
const ALL_TOOLS = ["read", "pwsh", "web_search", "read_image", "job_list", "subagent", "enable_tool", "exit_plan_mode", "create_goal", "get_goal", "update_goal", "whale_report", "ka_sub_whale", "list_agents", "send_message", "interrupt_agent", "memory_search", "memory_save"];
const runAssemble = async (agent) => {
  const listener = listeners.get("system-prompt/assemble")[0];
  const assembly = { tools: ALL_TOOLS.map((name) => ({ name })), sections: [], contexts: [], variables: {} };
  await listener(assembly, { agent }, () => assembly);
  return new Set(assembly.tools.map((t) => t.name));
};
const assembledSel = await runAssemble(sSel);
check("assemble(selected)：v0.9 固定主面保留控制/whale_report，移除旧 subagent/create_goal/外部/可选", assembledSel.has("read") && assembledSel.has("ka_sub_whale") && assembledSel.has("get_goal") && assembledSel.has("update_goal") && assembledSel.has("whale_report") && !assembledSel.has("subagent") && !assembledSel.has("create_goal") && !assembledSel.has("read_image") && !assembledSel.has("job_list") && !assembledSel.has("enable_tool"));
const gate = listeners.get("tools/pre-execute")[0];
const runGate = async (agent, name) => gate({ name, agent }, async () => ({ kind: "allow" }));
check("pre-execute 放行固定工具", (await runGate(sSel, "ka_sub_whale")).kind === "allow" && (await runGate(sSel, "whale_report")).kind === "allow" && (await runGate(sSel, "get_goal")).kind === "allow");
check("pre-execute 拒绝外部候选/enable_tool/旧委派", (await runGate(sSel, "read_image")).kind === "deny" && (await runGate(sSel, "job_list")).kind === "deny" && (await runGate(sSel, "enable_tool")).kind === "deny" && (await runGate(sSel, "subagent")).kind === "deny");
check("pre-execute 拒绝记忆写工具", (await runGate(sSel, "memory_save")).kind === "deny");

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nTASK-SURFACE-FILTER PROBE OK" : `\nTASK-SURFACE-FILTER PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
