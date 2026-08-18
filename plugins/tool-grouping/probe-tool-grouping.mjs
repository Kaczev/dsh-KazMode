// 临时探针：在 mock 的 Cordis ctx 上运行 tool-grouping 插件，验证核心逻辑。
// 覆盖：
//   场景 A：无 settings 服务 → source() 回落到组合行 entry（DEFAULT_GROUPS）。
//   场景 B：有 settings 服务 → source() 使用 settings 值（realm 用独特值以严格
//           区分 settings 与 DEFAULT），并模拟热重载推送后报告更新、enabled=false
//           后状态工具注销。
//   场景 C：trace 模式不阻断任何调用。
//   两条注册路径：① scope 层存量工具（apply 之前已注册）→ 扫描补记；
//                 ② apply 之后经注册补丁注册 → 带插件名归属。
// 运行：node tool-grouping/probe-tool-grouping.mjs
import plugin from "file:///C:/Users/Kaczev/.dsh/profiles/web/plugins/tool-grouping/lib/index.js";

const PRESET_KEY = "presetScope";
const presetTools = ["read", "write", "edit", "glob", "grep", "workflow", "ralph"];

function makeRaw() {
  const registeredTools = new Map(); // 全局层
  return {
    layers: { scoped: new Map([[PRESET_KEY, {}]]) },
    registeredTools,
    register(definition) {
      registeredTools.set(definition.name, definition);
      let disposed = false;
      return () => {
        if (!disposed) {
          disposed = true;
          registeredTools.delete(definition.name);
        }
      };
    },
    schemas(scope) {
      if (scope === PRESET_KEY) return presetTools.map((name) => ({ name, description: `mock ${name}`, parameters: {} }));
      return [...registeredTools.values()].map((d) => ({ name: d.name, description: d.description, parameters: {} }));
    },
  };
}

function makeLogger() {
  return { info: () => {}, warn: (...a) => console.log("[mock:warn]", ...a), debug: () => {} };
}

function makeLoader() {
  return {
    entries() {
      return [
        { options: { id: "tool-fs", name: "@deepseek-ai/dsh-tool-fs" }, disabled: true, parent: { tree: { ctx: { fiber: { entry: undefined } } } } },
        { options: { id: "tool-workflow", name: "@deepseek-ai/dsh-tool-workflow" }, disabled: true, parent: { tree: { ctx: { fiber: { entry: { options: { id: "delegation" } } } } } } },
        { options: { id: "tool-ralph", name: "@deepseek-ai/dsh-tool-ralph" }, disabled: true, parent: { tree: { ctx: { fiber: { entry: { options: { id: "delegation" } } } } } } },
        { options: { id: "workflow-worker-thread", name: "@deepseek-ai/dsh-workflow-worker-thread" }, disabled: true, parent: { tree: { ctx: { fiber: { entry: { options: { id: "delegation" } } } } } } },
        { options: { id: "delegation", name: "cordis:group", group: true, isolate: { workflowEngine: true } } },
      ];
    },
  };
}

/**
 * 构造 mock ctx。
 * @param raw 工具注册表 mock
 * @param settingsValue 有值 → 模拟 settings 服务存在；undefined → 不存在
 */
function makeCtx(raw, settingsValue) {
  const listeners = new Map();
  const watchCallbacks = [];
  const provided = {};
  let currentSettings = settingsValue;
  const base = {
    tools: raw,
    // 模拟活跃 fiber（state=0）：installSettingsSection 的 watch 回调会读
    // ctx.fiber.state（isUnloading），真实 Cordis ctx 总有 fiber。
    fiber: { state: 0 },
    logger: makeLogger(),
    provide(name, value) {
      provided[name] = value;
      return () => {
        delete provided[name];
      };
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return () => {};
    },
    effect(fn) {
      fn();
      return () => {};
    },
    inject(deps, cb) {
      if (deps.includes("settings") && currentSettings !== undefined) {
        const sctx = {
          ...base,
          settings: {
            register(_ns, _schema, _opts) {
              return {
                get: () => currentSettings,
                watch: (cb2) => {
                  watchCallbacks.push(cb2);
                  return () => {};
                },
                update: () => Promise.resolve(),
                replace: () => Promise.resolve(),
              };
            },
          },
        };
        cb(sctx);
      }
    },
    get(name) {
      if (name === "workflowEngine") return undefined;
      if (name === "agents") return { list: () => [] };
      if (name === "loader") return makeLoader();
      return undefined;
    },
  };
  return {
    ctx: base,
    listeners,
    watchCallbacks,
    provided,
    get currentSettings() {
      return currentSettings;
    },
    setCurrentSettings(value) {
      currentSettings = value;
    },
  };
}

/** 模拟 apply 之后的补丁注册（带调用方插件名）。 */
function simulateRegister(raw, name, pluginName) {
  raw.register.call({ ctx: { fiber: { name: pluginName } } }, {
    name,
    description: `mock ${name}`,
    parameters: {},
    output: { schema: { type: "string" }, render: () => [{ type: "text", text: "" }] },
  });
}

/** 触发插件注册的全部追记事件并等待微任务/宏任务扫描。 */
async function settle(h) {
  for (const fn of h.listeners.get("tools/change") ?? []) fn();
  for (const fn of h.listeners.get("loader/entry-init") ?? []) fn();
  await new Promise((r) => setTimeout(r, 10));
}

/** 从注册表里取状态工具定义并执行，返回报告文本。 */
async function runStatusTool(raw) {
  let statusDef;
  for (const [name, def] of raw.registeredTools) if (name === "tool_grouping_status") statusDef = def;
  if (!statusDef) throw new Error("tool_grouping_status 未注册");
  return statusDef.execute({});
}

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

const DEFAULT_REALM = "minimal-local-fs";
const SETTINGS_REALM = "settings-realm";
const HOT_REALM = "hot-realm";

// =====================================================================
// 场景 A：无 settings 服务 → source() = 组合行 entry（DEFAULT_GROUPS）
// =====================================================================
{
  const raw = makeRaw();
  const h = makeCtx(raw, undefined);
  plugin.apply(h.ctx, { enabled: true });
  await settle(h);
  simulateRegister(raw, "str_replace_editor", "tool-str-replace-editor");
  simulateRegister(raw, "todo_write", "tool-todo");
  const report = await runStatusTool(raw);

  check(`A: 无 settings 时 realm 用 DEFAULT（${DEFAULT_REALM}）`, report.includes(`(realm: ${DEFAULT_REALM})`));
  check("A: read 由 scope 扫描归组", /✓ read\s*（已注册）/.test(report));
  check("A: str_replace_editor 留在默认组（已移出 tool-fs）", report.includes("str_replace_editor") && !/✓ str_replace_editor/.test(report));
  check("A: todo_write 留在默认组", report.includes("todo_write"));
  check("A: 默认分组含 kaz-memory 组（realm: kazMemory）", report.includes("[组] kaz-memory") && report.includes("(realm: kazMemory)"));
  check("A: 未注册的 memory_search 标记 ✗", /✗ memory_search/.test(report));
}

// =====================================================================
// 场景 B：有 settings 服务 → source() = settings 值；热重载推送后更新
// =====================================================================
{
  const raw = makeRaw();
  const settingsValue = {
    enabled: true,
    registerStatusTool: true,
    mode: "tag",
    groups: [
      { id: "tool-fs", realm: SETTINGS_REALM, tools: ["read", "write", "edit", "glob", "grep"] },
      { id: "workflowEngine", realm: "workflowEngine", tools: ["workflow", "ralph"] },
    ],
  };
  const h = makeCtx(raw, settingsValue);
  plugin.apply(h.ctx, { enabled: true });
  await settle(h);
  simulateRegister(raw, "str_replace_editor", "tool-str-replace-editor");
  simulateRegister(raw, "todo_write", "tool-todo");
  let report = await runStatusTool(raw);

  check(`B: 有 settings 时 realm 用 settings 值（${SETTINGS_REALM}）`, report.includes(`(realm: ${SETTINGS_REALM})`));
  check("B: read 由 scope 扫描归组", /✓ read\s*（已注册）/.test(report));
  check("B: workflow 由 scope 扫描归组", report.includes("✓ workflow"));
  check("B: str_replace_editor 留在默认组（已移出 tool-fs）", report.includes("str_replace_editor") && !/✓ str_replace_editor/.test(report));
  check("B: todo_write 留在默认组", report.includes("todo_write"));
  check("B: 组合事实含 workflowEngine 隔离", report.includes("isolate realm = {workflowEngine}"));

  // 模拟 settings 热重载：改 settings 值并触发 watch 回调
  h.setCurrentSettings({ ...settingsValue, groups: [{ ...settingsValue.groups[0], realm: HOT_REALM }, settingsValue.groups[1]] });
  for (const cb of h.watchCallbacks) cb(h.currentSettings);
  report = await runStatusTool(raw);
  check(`B: 热重载后 realm 更新为 ${HOT_REALM}`, report.includes(`(realm: ${HOT_REALM})`));

  // 模拟 enabled=false 热重载 → 状态工具注销
  h.setCurrentSettings({ ...settingsValue, enabled: false });
  for (const cb of h.watchCallbacks) cb(h.currentSettings);
  let unregistered = false;
  for (const [name] of raw.registeredTools) if (name === "tool_grouping_status") unregistered = true;
  check("B: enabled=false 热重载后状态工具注销", !unregistered);
}

// =====================================================================
// 场景 C：trace 模式不阻断任何调用
// =====================================================================
{
  const raw = makeRaw();
  const h = makeCtx(raw, undefined);
  plugin.apply(h.ctx, { enabled: true, mode: "trace" });
  let allowResult;
  for (const fn of h.listeners.get("tools/pre-execute") ?? []) {
    allowResult = await fn({ name: "read" }, () => ({ kind: "allow" }));
  }
  check("C: pre-execute 放行（未阻断）", JSON.stringify(allowResult) === '{"kind":"allow"}');
}

// =====================================================================
// 场景 D：对外 toolGrouping 服务（供 kaz-mode 等消费）
// =====================================================================
{
  const raw = makeRaw();
  const h = makeCtx(raw, {
    enabled: true,
    registerStatusTool: true,
    mode: "tag",
    groups: [
      { id: "tool-fs", realm: SETTINGS_REALM, tools: ["read", "write", "edit", "glob", "grep"] },
      { id: "workflowEngine", realm: "workflowEngine", tools: ["workflow", "ralph"] },
    ],
  });
  plugin.apply(h.ctx, { enabled: true });
  await settle(h);
  simulateRegister(raw, "str_replace_editor", "tool-str-replace-editor");

  const svc = h.provided.toolGrouping;
  check("D: toolGrouping 服务已发布", svc !== undefined && typeof svc.groups === "function");
  check("D: 服务 enabled() = true", svc !== undefined && svc.enabled() === true);
  const groups = svc === undefined ? [] : svc.groups();
  check("D: 服务 groups() 反映 settings 分组（2 组）", groups.length === 2);
  check(
    `D: 服务 groups()[0] 为 tool-fs / realm ${SETTINGS_REALM}`,
    groups[0] !== undefined && groups[0].id === "tool-fs" && groups[0].realm === SETTINGS_REALM,
  );
  const hit = svc === undefined ? null : svc.groupOf("read");
  check("D: 服务 groupOf('read') 归入 tool-fs 组", hit !== null && hit.groupId === "tool-fs" && hit.realm === SETTINGS_REALM);
  check("D: 服务 groupOf('todo_write') = null（未分组）", svc !== undefined && svc.groupOf("todo_write") === null);
  check("D: 服务 isRegistered('str_replace_editor') = true（已注册但不在 tool-fs 组）", svc !== undefined && svc.isRegistered("str_replace_editor") === true && svc.groupOf("str_replace_editor") === null);

  // enabled=false 热重载后：服务反映"无分组"
  h.setCurrentSettings({
    enabled: false,
    registerStatusTool: true,
    mode: "tag",
    groups: [],
  });
  for (const cb of h.watchCallbacks) cb(h.currentSettings);
  check("D: enabled=false 后服务 enabled() = false", svc !== undefined && svc.enabled() === false);
  check("D: enabled=false 后 groupOf('read') = null", svc !== undefined && svc.groupOf("read") === null);
}

console.log(failures === 0 ? "\nPROBE OK" : `\nPROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
