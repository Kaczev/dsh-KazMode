// 临时探针：在 mock 的 Cordis ctx 上运行 kaz-mode 插件，验证核心逻辑。
// 覆盖：
//   ① 关闭态：enabled=false 时不写任何插件状态（状态工具仍注册——诊断工具不随开关隐藏）；
//   ② 开启联动：快照原始状态 → 自动启用未启用的插件（未加载的跳过）→ 快照落盘；
//   ③ 关闭：不改动四个插件（不恢复、不清空快照）；
//   ④ 状态工具 kaz_mode_status：分组数据来自 toolGrouping 运行时服务、
//      首轮基底来自 round-minimal 配置（kaz-mode 不内置工具列表）；
//   ⑤ 预设联动：agent-presets.default 切到 kaz → kaz-mode.enabled 置 true 并联动；
//      切走 → enabled 置 false 并恢复；previousPreset 记录来处/去处；
//   ⑥ 启动时默认预设已是 kaz → 自动开启联动。
//   ⑦ Kaz 工具面：minimalTools 极简基底 + toolWhitelist 白名单（组 id 经
//      toolGrouping 服务展开）；组装层过滤工具与 tool:* 段；首轮极简信号激活时
//      仅 minimalTools 并移除 tool:memory 段；执行层拒绝白名单外调用；
//      子代理会话同样适用；内部调用（无 agent）放行。
//   ⑧ enabled=false：工具面不过滤、执行层不拒绝。
// 运行：node kaz-mode/probe-kaz-mode.mjs
import plugin from "file:///C:/Users/Kaczev/.dsh/profiles/web/plugins/kaz-mode/lib/index.js";

const PLUGIN_DEFAULTS = {
  "thinking-anchor": { enabled: false },
  "round-minimal": { enabled: true, showPolicy: true },
  "tool-grouping": { enabled: true },
  "tool-filter": { enabled: false },
  "code-collapse": { enabled: true },
  "task-master-whiteboard": { enabled: true },
  "round-display": { enabled: true },
  "deepseek-default-model": { enabled: true },
  "kaz-mode": {
    enabled: false,
    savedPluginStates: {},
    registerStatusTool: true,
    previousPreset: "cordis",
    postFirstRoundMode: "standard",
    roundMinimalPolicySnapshot: { active: false, hadOverride: false, value: true },
  },
  "agent-presets": { default: "cordis" },
};

const TOOL_GROUPING_SVC = {
  enabled: () => true,
  groups: () => [
    { id: "tool-fs", realm: "svc-realm", tools: ["read", "write", "edit", "glob", "grep"] },
    { id: "workflowEngine", realm: "workflowEngine", tools: ["workflow", "ralph"] },
    { id: "kaz-memory", realm: "kazMemory", tools: ["memory_save", "memory_list", "memory_search", "memory_forget"] },
  ],
  groupOf: (name) => (name === "read" ? { groupId: "tool-fs", realm: "svc-realm" } : null),
  isRegistered: (name) => name !== "glob",
};

const ROUND_MINIMAL_SVC = {
  enabled: () => true,
  isMinimal: (agent) => agent?.roundOne === true,
  firstRoundTools: () => ["pwsh", "str_replace_editor"],
  turnOf: (agent) => agent?.turn ?? 0,
};

// ---------------------------------------------------------------------
// mock settings 服务：命名空间注册 + 内存存储 + update/mutate/describe。
// 所有写操作回调 onCommit(ns, next)，由 harness 接到 settings/updated 事件。
// ---------------------------------------------------------------------
function makeSettings(defaults, onCommit) {
  const userSections = new Map();
  const bases = new Map();
  const watches = new Map();
  const writeLog = [];

  function resolve(ns) {
    return { ...(defaults[ns] ?? {}), ...(bases.get(ns) ?? {}), ...(userSections.get(ns) ?? {}) };
  }
  function fireWatch(ns, next) {
    for (const cb of watches.get(ns) ?? []) {
      try {
        cb(next, undefined);
      } catch (error) {
        console.log("[mock:watch-error]", error);
      }
    }
  }
  function commit(ns) {
    const next = resolve(ns);
    fireWatch(ns, next);
    onCommit(ns, next);
  }

  return {
    writeLog,
    seed(ns) {
      if (!bases.has(ns)) bases.set(ns, {});
    },
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
          writeLog.push({ op: "update", ns, patch });
          userSections.set(ns, { ...(userSections.get(ns) ?? {}), ...patch });
          commit(ns);
          return Promise.resolve();
        },
        replace: (section) => {
          writeLog.push({ op: "replace", ns, section });
          userSections.set(ns, { ...section });
          commit(ns);
          return Promise.resolve();
        },
      };
    },
    get: (ns) => resolve(ns),
    update(ns, patch) {
      writeLog.push({ op: "update", ns, patch });
      userSections.set(ns, { ...(userSections.get(ns) ?? {}), ...patch });
      commit(ns);
      return Promise.resolve();
    },
    replace(ns, section) {
      writeLog.push({ op: "replace", ns, section });
      userSections.set(ns, { ...section });
      commit(ns);
      return Promise.resolve();
    },
    mutate(ns, ops) {
      writeLog.push({ op: "mutate", ns, ops });
      const next = { ...(userSections.get(ns) ?? {}) };
      for (const op of ops) {
        if (op.op === "set") next[op.path[0]] = op.value;
        else delete next[op.path[0]];
      }
      userSections.set(ns, next);
      commit(ns);
      return Promise.resolve();
    },
    describe() {
      return [...bases.keys()].map((ns) => ({ ns, user: userSections.get(ns) }));
    },
    setUser(ns, section) {
      userSections.set(ns, section);
      commit(ns);
    },
    getUser(ns) {
      return userSections.get(ns);
    },
  };
}

// ---------------------------------------------------------------------
// mock ctx：tools + settings + 事件派发（settings 写 → settings/updated，
// 并维护每个命名空间的 prev 值供事件携带）
// ---------------------------------------------------------------------
function makeHarness(defaultsOverride = {}) {
  const listeners = new Map();
  const prevValues = new Map();
  const emit = (event, ...args) => {
    for (const fn of listeners.get(event) ?? []) {
      try {
        fn(...args);
      } catch (error) {
        console.log("[mock:emit-error]", error);
      }
    }
  };

  const settings = makeSettings({ ...PLUGIN_DEFAULTS, ...defaultsOverride }, (ns, next) => {
    const prev = prevValues.has(ns) ? prevValues.get(ns) : undefined;
    prevValues.set(ns, next);
    emit("settings/updated", ns, next, prev, "update");
  });

  const tools = {
    registered: new Map(),
    register(definition) {
      tools.registered.set(definition.name, definition);
      let disposed = false;
      return () => {
        if (!disposed) {
          disposed = true;
          tools.registered.delete(definition.name);
        }
      };
    },
  };

  const base = {
    tools,
    fiber: { state: 0 },
    logger: {
      info: () => {},
      warn: (...args) => console.log("[mock:warn]", ...args),
      debug: () => {},
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
    get(name) {
      if (name === "settings") return settings;
      if (name === "toolGrouping") return TOOL_GROUPING_SVC;
      if (name === "roundMinimal") return ROUND_MINIMAL_SVC;
      return undefined;
    },
    inject(deps, cb) {
      if (deps.includes("settings")) cb({ ...base, settings });
    },
  };

  return { ctx: base, settings, tools, listeners };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

// ---------------------------------------------------------------------
// 场景 1：关闭态 → 不写任何插件状态
// ---------------------------------------------------------------------
{
  const h = makeHarness();
  plugin.apply(h.ctx, { enabled: false });
  await settle();
  const pluginWrites = h.settings.writeLog.filter((entry) => entry.ns !== "kaz-mode" && entry.ns !== "agent-presets");
  check("① 关闭态：未写任何插件状态", pluginWrites.length === 0);
  check("① 关闭态：状态工具仍注册（诊断工具不随开关隐藏）", h.tools.registered.has("kaz_mode_status"));
}

// ---------------------------------------------------------------------
// 场景 2/3：开启联动 → 关闭不动（预设设为 kaz，专注验证联动机制本身）
// ---------------------------------------------------------------------
{
  const h = makeHarness({ "agent-presets": { default: "kaz" } });
  for (const ns of ["thinking-anchor", "round-minimal", "tool-grouping", "tool-filter"]) h.settings.seed(ns);
  h.settings.setUser("thinking-anchor", { enabled: false }); // 用户覆盖：显式禁用
  plugin.apply(h.ctx, { enabled: true });
  await settle();

  // ② 开启后：快照 + 联动启用
  const snap = h.settings.getUser("kaz-mode")?.savedPluginStates;
  check("② 开启后快照存在", snap !== undefined && typeof snap === "object");
  check(
    "② 快照记录 thinking-anchor 原始状态（enabled=false，用户覆盖）",
    snap !== undefined && snap["thinking-anchor"]?.enabled === false && snap["thinking-anchor"]?.hadOverride === true,
  );
  check(
    "② 快照记录 tool-filter 原始状态（enabled=false，继承 base）",
    snap !== undefined && snap["tool-filter"]?.enabled === false && snap["tool-filter"]?.hadOverride === false,
  );
  const enableWrites = h.settings.writeLog.filter(
    (entry) => entry.ns === "thinking-anchor" && entry.op === "update" && entry.patch?.enabled === true,
  );
  check("② 联动把 thinking-anchor 置为 enabled=true", enableWrites.length === 1);
  const tfWrites = h.settings.writeLog.filter(
    (entry) => entry.ns === "tool-filter" && entry.op === "update" && entry.patch?.enabled === true,
  );
  check("② 联动把 tool-filter 置为 enabled=true", tfWrites.length === 1);
  const rmWrites = h.settings.writeLog.filter((entry) => entry.ns === "round-minimal");
  check("② 已启用的 round-minimal 不被重复写 enabled", !rmWrites.some((e) => e.patch?.enabled !== undefined));
  check(
    "② 联动后 round-minimal.showPolicy 保持 true（轮次提示输出）",
    !rmWrites.some((e) => e.patch?.showPolicy === false) && h.settings.get("round-minimal").showPolicy === true,
  );
  check(
    "② kaz-mode 保存 showPolicy 快照（active=true）",
    h.settings.getUser("kaz-mode")?.roundMinimalPolicySnapshot?.active === true,
  );
  check("② 状态工具 kaz_mode_status 已注册", h.tools.registered.has("kaz_mode_status"));

  // ② 状态报告：分组数据来自 toolGrouping 服务
  const report = await h.tools.registered.get("kaz_mode_status").execute({});
  check("② 报告含服务提供的 realm（svc-realm）", report.includes("svc-realm"));
  check("② 报告含服务提供的组 id（tool-fs）", report.includes("[组] tool-fs"));
  check("② 报告标记未注册工具（glob）", report.includes("✗ glob"));
  check("② 报告含 round-minimal 首轮基底配置", report.includes("firstRoundTools=["));
  check("② 报告含 [前置插件] 段与五个前置", report.includes("[前置插件]") && report.includes("kaz-memory"));
  check("② 报告含 [首轮伪装与基底恢复] 段", report.includes("[首轮伪装与基底恢复]"));
  check("② 报告含 postFirstRoundMode", report.includes("postFirstRoundMode: standard"));

  // ③ 关闭 / 切走：不改动四个插件（不恢复、不清空快照）
  const beforeWrites = h.settings.writeLog.length;
  const policySnapBefore = h.settings.getUser("kaz-mode")?.roundMinimalPolicySnapshot;
  h.settings.setUser("kaz-mode", {
    enabled: false,
    savedPluginStates: snap,
    registerStatusTool: true,
    roundMinimalPolicySnapshot: policySnapBefore,
  });
  await settle();
  const offWrites = h.settings.writeLog.slice(beforeWrites);
  const pluginWrites = offWrites.filter(
    (entry) => ["thinking-anchor", "tool-grouping", "tool-filter"].includes(entry.ns),
  );
  check("③ 关闭后三个插件（thinking-anchor/tool-grouping/tool-filter）不被写", pluginWrites.length === 0);
  const rmRestore = offWrites.filter((entry) => entry.ns === "round-minimal");
  check(
    "③ 关闭后 round-minimal.showPolicy 按快照恢复（无用户覆盖 → unset）",
    rmRestore.some(
      (e) =>
        e.op === "mutate" &&
        Array.isArray(e.ops) &&
        e.ops[0]?.op === "unset" &&
        e.ops[0]?.path?.[0] === "showPolicy",
    ),
  );
  check(
    "③ 关闭后 showPolicy 快照清空（active=false）",
    h.settings.getUser("kaz-mode")?.roundMinimalPolicySnapshot?.active === false,
  );
  check(
    "③ 关闭后 savedPluginStates 快照保留（不随关闭清空）",
    Object.keys(h.settings.getUser("kaz-mode")?.savedPluginStates ?? {}).length === 9,
  );
  check("③ 关闭后状态工具保持注册（诊断工具不随开关隐藏）", h.tools.registered.has("kaz_mode_status"));

  // ③b 再次开启：快照重拍 + 四插件再次强制启用（只有"进入 Kaz"才启用）
  h.settings.setUser("thinking-anchor", { enabled: false }); // 用户在 Kaz 外手动关闭一个插件
  await settle();
  const before2 = h.settings.writeLog.length;
  h.settings.setUser("kaz-mode", { enabled: true });
  await settle();
  const reEnable = h.settings.writeLog.slice(before2).filter(
    (entry) => entry.ns === "thinking-anchor" && entry.op === "update" && entry.patch?.enabled === true,
  );
  check("③b 重新进入 Kaz 时四个插件再次被强制启用", reEnable.length === 1);
  check(
    "③b 重新进入后快照重拍（记录本次开启前状态 enabled=false）",
    h.settings.getUser("kaz-mode")?.savedPluginStates?.["thinking-anchor"]?.enabled === false,
  );
}

// ---------------------------------------------------------------------
// 场景 4：tool-grouping 服务缺失 → 报告降级（预设设为 kaz 保持开启）
// ---------------------------------------------------------------------
{
  const h = makeHarness({ "agent-presets": { default: "kaz" } });
  // 覆盖 toolGrouping 缺失：直接改 ctx.get 的返回
  const originalGet = h.ctx.get;
  h.ctx.get = (name) => (name === "toolGrouping" ? undefined : originalGet(name));
  plugin.apply(h.ctx, { enabled: true });
  await settle();
  const report = await h.tools.registered.get("kaz_mode_status").execute({});
  check("④ toolGrouping 缺失时报告降级说明", report.includes("未发布 toolGrouping 服务"));
}

// ---------------------------------------------------------------------
// 场景 5：预设联动（切换预设驱动 kaz-mode.enabled）
// ---------------------------------------------------------------------
{
  const h = makeHarness();
  for (const ns of ["thinking-anchor", "round-minimal", "tool-grouping", "tool-filter"]) h.settings.seed(ns);
  h.settings.setUser("thinking-anchor", { enabled: false });
  plugin.apply(h.ctx, { enabled: false });
  await settle();

  // 预设 cordis → kaz（settings/updated 事件携带 prev = {default:"cordis"}）
  h.settings.setUser("agent-presets", { default: "kaz" });
  await settle();
  check("⑤ 切到 kaz 后 kaz-mode.enabled 置 true", h.settings.get("kaz-mode").enabled === true);
  check("⑤ 联动启用 thinking-anchor", h.settings.get("thinking-anchor").enabled === true);
  check("⑤ previousPreset 记录来处 cordis", h.settings.get("kaz-mode").previousPreset === "cordis");
  check("⑤ 状态工具已注册", h.tools.registered.has("kaz_mode_status"));

  // 预设 kaz → standard：enabled 置 false；四个插件不被改动（不恢复）
  h.settings.setUser("agent-presets", { default: "standard" });
  await settle();
  check("⑤ 切到 standard 后 kaz-mode.enabled 置 false", h.settings.get("kaz-mode").enabled === false);
  check("⑤ 切走后 thinking-anchor 保持启用（不恢复）", h.settings.get("thinking-anchor").enabled === true);
  check("⑤ previousPreset 更新为 standard", h.settings.get("kaz-mode").previousPreset === "standard");
  check("⑤ 状态工具保持注册（诊断工具不随开关隐藏）", h.tools.registered.has("kaz_mode_status"));
}

// ---------------------------------------------------------------------
// 场景 5b：会话级预设切换（agent-preset/selected）同样驱动 kaz-mode.enabled
// ---------------------------------------------------------------------
{
  const h = makeHarness();
  for (const ns of ["thinking-anchor", "round-minimal", "tool-grouping", "tool-filter"]) h.settings.seed(ns);
  h.settings.setUser("agent-presets", { default: "kaz" });
  plugin.apply(h.ctx, { enabled: true });
  await settle();

  const selected = h.listeners.get("agent-preset/selected");
  check("⑤b agent-preset/selected 监听已注册", selected !== undefined && selected.length > 0);
  selected[0]("s1", "cordis");
  await settle();
  check("⑤b 会话切到 cordis → kaz-mode.enabled 置 false", h.settings.get("kaz-mode").enabled === false);
  selected[0]("s2", "kaz");
  await settle();
  check("⑤b 会话切回 kaz → kaz-mode.enabled 置 true", h.settings.get("kaz-mode").enabled === true);
}

// ---------------------------------------------------------------------
// 场景 6：启动时默认预设已是 kaz → 自动开启联动
// ---------------------------------------------------------------------
{
  const h = makeHarness({ "agent-presets": { default: "kaz" } });
  for (const ns of ["thinking-anchor", "round-minimal", "tool-grouping", "tool-filter"]) h.settings.seed(ns);
  h.settings.setUser("thinking-anchor", { enabled: false });
  plugin.apply(h.ctx, { enabled: false });
  await settle();
  check("⑥ 启动时预设为 kaz → enabled 自动置 true", h.settings.get("kaz-mode").enabled === true);
  check("⑥ 启动即联动启用 thinking-anchor", h.settings.get("thinking-anchor").enabled === true);
}

// ---------------------------------------------------------------------
// 场景 7：Kaz 工具面（minimalTools + 白名单；首轮极简信号；子代理；执行层）
// ---------------------------------------------------------------------
{
  const h = makeHarness({ "agent-presets": { default: "kaz" } });
  h.settings.setUser("kaz-mode", {
    enabled: true,
    registerStatusTool: true,
    minimalTools: ["pwsh", "str_replace_editor"],
    toolWhitelist: ["kaz-memory", "tool-fs", "workflowEngine", "tool_grouping_status", "kaz_mode_status"],
    savedPluginStates: {},
  });
  plugin.apply(h.ctx, { enabled: true });
  await settle();

  const TOOLS = ["pwsh", "str_replace_editor", "read", "write", "edit", "glob", "grep", "workflow", "ralph",
    "memory_search", "memory_save", "memory_list", "memory_forget", "web_search", "subagent", "todo_write",
    "tool_grouping_status", "kaz_mode_status"];
  const runAssemble = async (agent) => {
    const listener = h.listeners.get("system-prompt/assemble")[0];
    const assembly = {
      tools: TOOLS.map((name) => ({ name })),
      sections: TOOLS.map((name) => ({ name: `tool:${name}`, text: `guidance ${name}` })).concat([
        { name: "tool:memory", text: "base english memory guidance" },
        { name: "tool:memory:kaz-memory", text: "kaz-memory 中文指引" },
        { name: "deployment:persona", text: "p" },
        { name: "thinking-anchor:policy", text: "anchor" },
        { name: "round-minimal:policy", text: "round-minimal 轮次提示" },
        { name: "code-collapse:first-round", text: "code-collapse 首轮提醒" },
      ]),
      contexts: [],
      variables: {},
    };
    await listener(assembly, { agent, scope: agent }, () => assembly);
    return assembly;
  };

  const mainAgent = { id: "main", roundOne: false, turn: 2, options: { subagentDepth: 0 } };
  const asm = await runAssemble(mainAgent);
  const names = asm.tools.map((t) => t.name);
  check("⑦ 白名单外工具被移除（web_search/subagent/todo_write）", !names.includes("web_search") && !names.includes("subagent") && !names.includes("todo_write"));
  check("⑦ 白名单内工具保留（read/workflow/memory_search/两个状态工具）", names.includes("read") && names.includes("workflow") && names.includes("memory_search") && names.includes("tool_grouping_status") && names.includes("kaz_mode_status"));
  check("⑦ 非首轮保留 kaz-memory 指引、顶掉基础英文指引", asm.sections.some((s) => s.name === "tool:memory:kaz-memory") && !asm.sections.some((s) => s.name === "tool:memory"));
  check("⑦ 非 tool:* 段保留（deployment:persona）", asm.sections.some((s) => s.name === "deployment:persona"));
  check(
    "⑦ 非首轮 persona 替换为 standard 预设文本",
    asm.sections.some(
      (s) =>
        s.name === "deployment:persona" &&
        typeof s.text === "string" &&
        s.text.includes("coding agent powered by") &&
        s.text.includes("{{model}}") &&
        s.text.includes("{{cwd}}"),
    ),
  );
  check("⑦ 非首轮 thinking-anchor 段保留（自由输出）", asm.sections.some((s) => s.name === "thinking-anchor:policy"));

  const roundOne = await runAssemble({ id: "r1", roundOne: true, turn: 1, options: { subagentDepth: 0 } });
  const r1names = roundOne.tools.map((t) => t.name);
  check("⑦ 首轮极简工具面 = minimalTools（pwsh/str_replace_editor）", r1names.length === 2 && r1names.includes("pwsh") && r1names.includes("str_replace_editor"));
  check(
    "⑦ 首轮极简伪装：保留 persona + thinking-anchor + round-minimal 轮次提示 + code-collapse 首轮提醒",
    roundOne.sections.length === 4 &&
      roundOne.sections.some((s) => s.name === "deployment:persona") &&
      roundOne.sections.some((s) => s.name === "thinking-anchor:policy") &&
      roundOne.sections.some((s) => s.name === "round-minimal:policy") &&
      roundOne.sections.some((s) => s.name === "code-collapse:first-round"),
  );
  check("⑦ 首轮不含任何 tool:* 段（含两版记忆指引）", !roundOne.sections.some((s) => s.name.startsWith("tool:")));
  check("⑦ 首轮 persona 保持预设文本（不替换为 standard）", roundOne.sections.some((s) => s.name === "deployment:persona" && s.text === "p"));

  const subAsm = await runAssemble({ id: "sub", roundOne: false, turn: 1, options: { subagentDepth: 1 } });
  check("⑦ 子代理会话同样应用 Kaz 工具面", !subAsm.tools.map((t) => t.name).includes("web_search"));

  const gate = h.listeners.get("tools/pre-execute")[0];
  const denyWeb = await gate({ name: "web_search", agent: mainAgent }, () => ({ kind: "allow" }));
  check("⑦ 执行层拒绝白名单外工具（web_search）", denyWeb.kind === "deny" && typeof denyWeb.reason === "string" && denyWeb.reason.includes("toolWhitelist"));
  const allowRead = await gate({ name: "read", agent: mainAgent }, () => ({ kind: "allow" }));
  check("⑦ 执行层放行白名单内工具（read）", allowRead.kind === "allow");
  const internalCall = await gate({ name: "web_search" }, () => ({ kind: "allow" }));
  check("⑦ 执行层放行无 agent 的内部调用", internalCall.kind === "allow");
  const denyReadRoundOne = await gate({ name: "read", agent: { id: "r1", roundOne: true, turn: 1 } }, () => ({ kind: "allow" }));
  check("⑦ 首轮极简执行层拒绝 read（工具面仅 minimalTools）", denyReadRoundOne.kind === "deny");

  // 状态报告含工具面 / 信号段
  const report = await h.tools.registered.get("kaz_mode_status").execute({});
  check("⑦ 报告含 [Kaz 工具面] 段", report.includes("[Kaz 工具面]"));
  check("⑦ 报告含 [round-minimal 信号] 段", report.includes("[round-minimal 信号]"));
  check("⑦ 报告含 roundMinimal 服务已发布", report.includes("roundMinimal 服务已发布"));
  check("⑦ 报告区分已注册/未挂载（含「实际已注册」）", report.includes("实际已注册"));
  check("⑦ 未注册工具（glob）列入「定义中但未挂载」", report.includes("定义中但未挂载") && /定义中但未挂载[^:]*: [^\n]*glob/.test(report));
}

// ---------------------------------------------------------------------
// 场景 9：showPolicy 用户原值=false 的恢复 + postFirstRoundMode 占位回退
// ---------------------------------------------------------------------
{
  const h = makeHarness({ "agent-presets": { default: "kaz" } });
  for (const ns of ["thinking-anchor", "round-minimal", "tool-grouping", "tool-filter"]) h.settings.seed(ns);
  h.settings.setUser("round-minimal", { showPolicy: false }); // 用户原本就关着
  plugin.apply(h.ctx, { enabled: true, postFirstRoundMode: "creative" });
  await settle();

  const snap = h.settings.getUser("kaz-mode")?.roundMinimalPolicySnapshot;
  check(
    "⑨ 进入 Kaz：showPolicy 快照记录用户原值 false（hadOverride=true）",
    snap?.active === true && snap?.hadOverride === true && snap?.value === false,
  );
  check("⑨ 联动把用户 false 置为 true（Kaz 期间轮次提示输出）", h.settings.get("round-minimal").showPolicy === true);

  // 组装：postFirstRoundMode=creative 是占位 → 仍按 standard 处理
  const listener = h.listeners.get("system-prompt/assemble")[0];
  const assembly = {
    tools: [{ name: "pwsh" }],
    sections: [
      { name: "deployment:persona", text: "p" },
      { name: "thinking-anchor:policy", text: "anchor" },
    ],
    contexts: [],
    variables: {},
  };
  await listener(assembly, { agent: { id: "m", roundOne: false, turn: 2 }, scope: { id: "m" } }, () => assembly);
  check(
    "⑨ creative 模式 persona 替换为 cordis 预设文本（Two planes）",
    assembly.sections.some(
      (s) => s.name === "deployment:persona" && s.text.includes("Two planes decide where an edit belongs"),
    ),
  );

  // 退出 Kaz：恢复用户原值 false（不是无脑 true）
  const snapshotBefore = h.settings.getUser("kaz-mode")?.roundMinimalPolicySnapshot;
  h.settings.setUser("kaz-mode", { enabled: false, roundMinimalPolicySnapshot: snapshotBefore });
  await settle();
  check("⑨ 退出 Kaz 后 showPolicy 恢复为用户原值 false", h.settings.get("round-minimal").showPolicy === false);
  check("⑨ 退出 Kaz 后快照清空", h.settings.getUser("kaz-mode")?.roundMinimalPolicySnapshot?.active === false);
}

// ---------------------------------------------------------------------
// 场景 10：postFirstRoundMode 的 persona 映射（standard / minimal / creative；
// 已删除的 ptc 值回退 standard）
// ---------------------------------------------------------------------
{
  const h = makeHarness({ "agent-presets": { default: "kaz" } });
  h.settings.setUser("kaz-mode", {
    enabled: true,
    registerStatusTool: true,
    postFirstRoundMode: "minimal",
    savedPluginStates: {},
  });
  plugin.apply(h.ctx, { enabled: true });
  await settle();
  const listener = h.listeners.get("system-prompt/assemble")[0];
  const mk = () => {
    const assembly = {
      tools: [{ name: "pwsh" }],
      sections: [
        { name: "deployment:persona", text: "p" },
        { name: "thinking-anchor:policy", text: "a" },
      ],
      contexts: [],
      variables: {},
    };
    return { assembly, run: () => listener(assembly, { agent: { id: "m", roundOne: false, turn: 2 }, scope: { id: "m" } }, () => assembly) };
  };

  const minimal = mk();
  await minimal.run();
  check(
    "⑩ minimal 模式 persona = 极简预设原句",
    minimal.assembly.sections.some((s) => s.name === "deployment:persona" && s.text === "You are a helpful software engineer assistant."),
  );

  h.settings.setUser("kaz-mode", { enabled: true, registerStatusTool: true, postFirstRoundMode: "standard", savedPluginStates: {} });
  await settle();
  const standard = mk();
  await standard.run();
  check(
    "⑩ standard 模式 persona = standard 预设文本",
    standard.assembly.sections.some(
      (s) => s.name === "deployment:persona" && s.text.includes("coding agent powered by") && s.text.includes("{{model}}"),
    ),
  );

  h.settings.setUser("kaz-mode", { enabled: true, registerStatusTool: true, postFirstRoundMode: "creative", savedPluginStates: {} });
  await settle();
  const creative = mk();
  await creative.run();
  check(
    "⑩ creative 模式 persona = cordis 预设文本",
    creative.assembly.sections.some(
      (s) => s.name === "deployment:persona" && s.text.includes("read and modify the harness"),
    ),
  );

  // ptc 已于 2026-08-17 删除：settings 里残留的 "ptc" 值应回退 standard persona
  h.settings.setUser("kaz-mode", { enabled: true, registerStatusTool: true, postFirstRoundMode: "ptc", savedPluginStates: {} });
  await settle();
  const unknown = mk();
  await unknown.run();
  check(
    "⑩ 已删除的 ptc 值回退 standard persona",
    unknown.assembly.sections.some(
      (s) => s.name === "deployment:persona" && s.text.includes("coding agent powered by") && s.text.includes("{{model}}"),
    ),
  );
}

// ---------------------------------------------------------------------
// 场景 8：enabled=false → 工具面不过滤、执行层不拒绝
// ---------------------------------------------------------------------
{
  const h = makeHarness();
  h.settings.setUser("kaz-mode", { enabled: false, registerStatusTool: true, savedPluginStates: {} });
  plugin.apply(h.ctx, { enabled: false });
  await settle();
  const listener = h.listeners.get("system-prompt/assemble")[0];
  const assembly = {
    tools: [{ name: "web_search" }, { name: "read" }],
    sections: [{ name: "tool:web_search", text: "x" }],
    contexts: [],
    variables: {},
  };
  await listener(assembly, { agent: { id: "m", turn: 2 } }, () => assembly);
  check("⑧ enabled=false：工具不被过滤", assembly.tools.length === 2);
  const gate = h.listeners.get("tools/pre-execute")[0];
  const r = await gate({ name: "web_search", agent: { id: "m", turn: 2 } }, () => ({ kind: "allow" }));
  check("⑧ enabled=false：执行层放行", r.kind === "allow");
}

// ---------------------------------------------------------------------
// 场景 11：defaultDisabledPlugins 默认关闭清单（进入 Kaz 强制关闭、不联动启用、
// 用户手动开启后联动不再触碰；再次进入 Kaz 重新默认关闭）
// ---------------------------------------------------------------------
{
  const h = makeHarness({ "agent-presets": { default: "kaz" } });
  // task-master-whiteboard 默认 enabled=true（用户覆盖），但在默认关闭清单内
  h.settings.setUser("task-master-whiteboard", { enabled: true });
  plugin.apply(h.ctx, { enabled: true });
  await settle();

  check(
    "⑪ 进入 Kaz：清单内插件（task-master-whiteboard）被强制置为 enabled=false",
    h.settings.get("task-master-whiteboard").enabled === false,
  );
  const disableWrites = h.settings.writeLog.filter(
    (entry) => entry.ns === "task-master-whiteboard" && entry.op === "update" && entry.patch?.enabled === false,
  );
  check("⑪ 清单内插件产生 enabled=false 写入", disableWrites.length === 1);
  const enableWrites = h.settings.writeLog.filter(
    (entry) => entry.ns === "task-master-whiteboard" && entry.op === "update" && entry.patch?.enabled === true,
  );
  check("⑪ 清单内插件不被联动启用（无 enabled=true 写入）", enableWrites.length === 0);
  // 清单外插件仍被正常联动启用（thinking-anchor 默认 enabled=false）
  const taWrites = h.settings.writeLog.filter(
    (entry) => entry.ns === "thinking-anchor" && entry.op === "update" && entry.patch?.enabled === true,
  );
  check("⑪ 清单外插件仍被联动启用（thinking-anchor）", taWrites.length === 1);

  // 用户手动开启 → 后续联动（kaz-mode 配置变化触发）不再把它关掉
  h.settings.setUser("task-master-whiteboard", { enabled: true });
  await settle();
  const before = h.settings.writeLog.length;
  h.settings.setUser("kaz-mode", { enabled: true, registerStatusTool: true, savedPluginStates: {} });
  await settle();
  const after = h.settings.writeLog.slice(before);
  const touched = after.filter((entry) => entry.ns === "task-master-whiteboard");
  check(
    "⑪ 用户手动开启后，联动不再触碰清单内插件（无后续写入）",
    touched.length === 0 && h.settings.get("task-master-whiteboard").enabled === true,
  );

  // 退出再进入 Kaz → 清单内插件再次默认关闭
  h.settings.setUser("kaz-mode", { enabled: false, registerStatusTool: true, savedPluginStates: {} });
  await settle();
  h.settings.setUser("task-master-whiteboard", { enabled: true });
  await settle();
  h.settings.setUser("kaz-mode", { enabled: true, registerStatusTool: true, savedPluginStates: {} });
  await settle();
  check(
    "⑪ 再次进入 Kaz：清单内插件重新默认关闭",
    h.settings.get("task-master-whiteboard").enabled === false,
  );
}

console.log(failures === 0 ? "\nPROBE OK" : `\nPROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
