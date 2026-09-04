// kaz-mode 探针：Agent 管理「自写工具」层（第14次更新）。
// 覆盖：agent 工具进入 unfilteredSurfaceOf/taskToolPoolOf（每个项目）；
// RPC 返回 catalog.agent 与 agentManagedRegistry；用户 set/reset 不能触碰 agent 层；
// 分类 optional_tools / jit 可点亮 agent 工具；v0.8 Step B2 后 auto-on RPC 已退役。
// 运行：node KazPlugins/kaz-mode/probe-agent-managed-layer.mjs
import plugin from "file:///C:/Users/Kaczev/.dsh/profiles/web/KazPlugins/kaz-mode/lib/index.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

const TMP = mkdtempSync(join(tmpdir(), "kaz-agent-managed-"));
const PROJECT_A = join(TMP, "proj-a");
const PROJECT_B = join(TMP, "proj-b"); // 第二项目证明全局跨项目
for (const dir of [PROJECT_A, PROJECT_B]) {
  mkdirSync(join(dir, ".dsh", "storages"), { recursive: true });
  // 用户/项目 four-file 显式把 kaz-skill-safe-json 关掉：验证 agent 层不受影响。
  writeFileSync(
    join(dir, ".dsh", "storages", "other-tool-plugin.json"),
    JSON.stringify({ "kaz-skill-safe-json": false }, null, 2),
    "utf8",
  );
  writeFileSync(
    join(dir, ".dsh", "storages", "other-tool-plugin-catalog.json"),
    JSON.stringify({ "kaz-skill-safe-json": { safe_json_write: false } }, null, 2),
    "utf8",
  );
  writeFileSync(
    join(dir, ".dsh", "storages", "kaz-project-states.json"),
    JSON.stringify(
      { version: 1, states: { "ka-whale-memory": { enabled: true }, "ka-whale-workflow": { enabled: true, taskToolSelectionEnabled: true } } },
      null,
      2,
    ),
    "utf8",
  );
}

// 全局 storages：放 agent-managed registry。
const STORAGE_DIR = join(TMP, "dsh-storages");
mkdirSync(STORAGE_DIR, { recursive: true });
writeFileSync(
  join(STORAGE_DIR, "kaz-agent-managed-tools.json"),
  JSON.stringify(
    {
      version: 1,
      plugins: {
        "kaz-skill-safe-json": {
          agentManaged: true,
          tools: ["safe_json_write"],
        },
      },
    },
    null,
    2,
  ),
  "utf8",
);

const SESSIONS = {
  "s-sel": { cwd: PROJECT_A, agentPreset: "kaz" }, // initial optional 选中
  "s-jit": { cwd: PROJECT_A, agentPreset: "kaz" }, // enable_tool 点亮
  "s-empty": { cwd: PROJECT_B, agentPreset: "kaz" }, // 未选中
  "s-nostate": { cwd: PROJECT_B, agentPreset: "kaz" }, // feature off 全量面
};
const agentOf = (id) => ({
  id,
  session: {
    header: { id, cwd: SESSIONS[id].cwd, agentPreset: SESSIONS[id].agentPreset },
    events: [{ type: "tool/call", seq: 0, time: Date.now(), data: { name: "pwsh" } }],
  },
});
const taskStates = {
  "s-sel": { taskRunId: 1, mode: "normal", initialOptionalTools: ["safe_json_write"], jitEnabledTools: [] },
  "s-jit": { taskRunId: 1, mode: "normal", initialOptionalTools: [], jitEnabledTools: [{ tool: "safe_json_write", reason: "need safe json", at: "2026-09-02T00:00:00.000Z" }] },
  "s-empty": { taskRunId: 1, mode: "normal", initialOptionalTools: [], jitEnabledTools: [] },
};
const kaWhaleMock = {
  stageOf: (agent) => "done",
  taskToolStateOf: (agent) => (agent !== null && typeof agent === "object" ? taskStates[agent.id] ?? null : null),
};

const listeners = new Map();
const provided = {};
const agentsBySession = new Map();
for (const [id] of Object.entries(SESSIONS)) agentsBySession.set(id, agentOf(id));

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
const rpc = (endpoint, payload) => rpcHandlers.get("/kaz-mode")(endpoint, payload ?? {});

check("kazMode 服务可用", kazMode !== undefined && typeof kazMode.unfilteredSurfaceOf === "function" && typeof kazMode.surfaceOf === "function" && typeof kazMode.taskToolPoolOf === "function");

const sSel = agentOf("s-sel");
const sJit = agentOf("s-jit");
const sEmpty = agentOf("s-empty");
const sNoState = agentOf("s-nostate");

// ① v0.8 Step A：Agent 管理「自写工具」只作候选，不进 Stable Main Surface / optional 池
for (const agent of [sSel, sEmpty, sNoState]) {
  const unfiltered = kazMode.unfilteredSurfaceOf(agent);
  const pool = kazMode.taskToolPoolOf(agent);
  check(`unfilteredSurfaceOf(${agent.id}) 不含 safe_json_write（固定主面）`, unfiltered !== null && !unfiltered.has("safe_json_write"));
  check(`taskToolPoolOf(${agent.id}) 不含 safe_json_write`, !pool.includes("safe_json_write"));
  check(`unfilteredSurfaceOf(${agent.id}) 含 Goal/whale 固定工具且不含 Plan 例外`, unfiltered.has("get_goal") && unfiltered.has("whale_report") && !unfiltered.has("exit_plan_mode"));
}

// ② RPC：listToolPlugins 返回 agent 组；getExternalToolPlugins 返回 registry
{
  const listRes = await rpc("listToolPlugins", {});
  check("listToolPlugins catalog.agent 含 kaz-skill-safe-json", listRes?.ok === true && listRes.value?.catalog?.agent?.includes("kaz-skill-safe-json") === true);
  const extRes = await rpc("getExternalToolPlugins", { cwd: PROJECT_A });
  const reg = extRes?.value?.agentManagedRegistry;
  check(
    "getExternalToolPlugins 返回 agentManagedRegistry",
    reg !== null &&
      typeof reg === "object" &&
      reg.plugins?.["kaz-skill-safe-json"]?.agentManaged === true &&
      reg.plugins?.["kaz-skill-safe-json"]?.tools?.includes("safe_json_write") === true,
  );
  check("getExternalToolPlugins agentManagedTools 含 safe_json_write", extRes?.value?.agentManagedTools?.includes("safe_json_write") === true);
}

// ③ 用户操作防护：setExternalToolPlugin 对 agent 插件全部拒绝
{
  const removePlugin = await rpc("setExternalToolPlugin", { cwd: PROJECT_A, pluginName: "kaz-skill-safe-json", removePlugin: true });
  check("removePlugin 拒绝 agent 插件", removePlugin?.ok === false && /Agent 管理/.test(removePlugin.error?.message ?? ""));
  const removeTool = await rpc("setExternalToolPlugin", { cwd: PROJECT_A, pluginName: "kaz-skill-safe-json", toolName: "safe_json_write", remove: true });
  check("remove tool 拒绝 agent 工具", removeTool?.ok === false);
  const toggle = await rpc("setExternalToolPlugin", { cwd: PROJECT_A, pluginName: "kaz-skill-safe-json", layer: "project", capable: false });
  check("toggle capable 拒绝 agent 插件", toggle?.ok === false);
  const toggleTool = await rpc("setExternalToolPlugin", { cwd: PROJECT_A, pluginName: "kaz-skill-safe-json", layer: "project", toolName: "safe_json_write", enabled: false });
  check("toggle tool 拒绝 agent 工具", toggleTool?.ok === false);
  const addTool = await rpc("setExternalToolPlugin", { cwd: PROJECT_A, pluginName: "kaz-skill-safe-json", addTool: true, toolName: "another_tool" });
  check("addTool 拒绝 agent 插件", addTool?.ok === false);
}

// ④ reset 不触碰 agent 层
{
  const resetUser = await rpc("resetExternalToolPlugins", { cwd: PROJECT_A, layer: "user" });
  check("resetExternalToolPlugins(user) 仍返回 agent registry", resetUser?.ok === true && resetUser.value?.agentManagedRegistry?.plugins?.["kaz-skill-safe-json"]?.tools?.includes("safe_json_write") === true);
  const resetProject = await rpc("resetExternalToolPlugins", { cwd: PROJECT_A, layer: "project" });
  check("resetExternalToolPlugins(project) 仍返回 agent registry", resetProject?.ok === true && resetProject.value?.agentManagedRegistry?.plugins?.["kaz-skill-safe-json"]?.tools?.includes("safe_json_write") === true);
  const unfiltered = kazMode.unfilteredSurfaceOf(sSel);
  check("reset 后 agent 工具仍不进稳定主面（保持 Step A 固定面）", unfiltered?.has("safe_json_write") === false);
}

// ⑤ v0.8 Step A：任务状态/optional_tools 不再影响主面，agent 工具一律不进固定主面
{
  const selSurface = kazMode.surfaceOf(sSel);
  check("surfaceOf(selected initial optional) 不含 safe_json_write", selSurface !== null && !selSurface.has("safe_json_write"));
  const jitSurface = kazMode.surfaceOf(sJit);
  check("surfaceOf(jit enable_tool 点亮) 不含 safe_json_write", jitSurface !== null && !jitSurface.has("safe_json_write"));
  const emptySurface = kazMode.surfaceOf(sEmpty);
  check("surfaceOf(未选 optional) 不含 safe_json_write", emptySurface !== null && !emptySurface.has("safe_json_write"));
  const noStateSurface = kazMode.surfaceOf(sNoState);
  check("surfaceOf(无任务状态) 仍为固定主面，不含 safe_json_write", noStateSurface !== null && !noStateSurface.has("safe_json_write"));
}

// ⑥ v0.8 Step B2：auto-on RPC 已退役，setToolAutoOn 不再存在
{
  const res = await rpc("setToolAutoOn", { cwd: PROJECT_A, feature: "plan", layer: "project", tools: ["exit_plan_mode", "safe_json_write"] });
  check("setToolAutoOn 已退役（unknown endpoint）", res !== null && res.ok === false);
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nAGENT-MANAGED-LAYER PROBE OK" : `\nAGENT-MANAGED-LAYER PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
