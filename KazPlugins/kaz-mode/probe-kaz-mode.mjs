// kaz-mode 探针（方案 A 重构后）：按 agent 所在项目计算工具面，不做全局注销。
// 覆盖：
//   ① kazMode 服务：kazEnabled / pluginEnabled / toolVisible 按 agent 项目判定；
//   ② 组装层：Kaz 会话按白名单过滤（记忆/诊断工具按该项目开关增减）；
//   ③ 组装层：非 Kaz 会话只移除该项目禁用的记忆/诊断工具（标准工具保留）；
//   ④ 执行层：Kaz 会话拒绝白名单外调用；非 Kaz 会话拒绝已禁用插件的工具；
//   ⑤ 记忆/诊断工具常驻注册——工具面完全由项目状态计算，不随全局 enabled 注销。
// 运行：node kaz-mode/probe-kaz-mode.mjs
import plugin from "file:///C:/Users/Kaczev/.dsh/profiles/web/KazPlugins/kaz-mode/lib/index.js";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

const TMP = mkdtempSync(join(tmpdir(), "kzm-probe-"));
const PROJECT_A = join(TMP, "proj-a"); // 无项目覆盖：Kaz 默认记忆开 / 非 Kaz 默认记忆关
const PROJECT_B = join(TMP, "proj-b"); // 项目覆盖记忆关
const PROJECT_C = join(TMP, "proj-c"); // 项目覆盖记忆开
const PROJECT_D = join(TMP, "proj-d"); // 旧键 kaz-memory 项目覆盖（兼容读）
for (const dir of [PROJECT_A, PROJECT_B, PROJECT_C, PROJECT_D]) {
  mkdirSync(join(dir, ".dsh", "storages"), { recursive: true });
}
function writeProjectStates(dir, states) {
  writeFileSync(
    join(dir, ".dsh", "storages", "kaz-project-states.json"),
    JSON.stringify({ version: 1, states }, null, 2),
    "utf8",
  );
}
writeProjectStates(PROJECT_A, {});
writeProjectStates(PROJECT_B, { "ka-whale-memory": { enabled: false } });
writeProjectStates(PROJECT_C, { "ka-whale-memory": { enabled: true } });
writeProjectStates(PROJECT_D, { "kaz-memory": { enabled: true } });

// 会话：agentPreset 决定 Kaz/非 Kaz；项目状态文件（按 cwd）决定 ka-whale-memory 开关。
const SESSIONS = {
  "s-kaz": { cwd: PROJECT_A, agentPreset: "kaz" },
  "s-kaz-nomem": { cwd: PROJECT_B, agentPreset: "kaz" },
  "s-plain": { cwd: PROJECT_B, agentPreset: "router-standard" },
  "s-plain-mem": { cwd: PROJECT_C, agentPreset: "router-standard" },
  "s-kaz-legacy": { cwd: PROJECT_D, agentPreset: "kaz" },
  "s-kaz-plan": { cwd: PROJECT_A, agentPreset: "kaz" },
  "s-kaz-goal": { cwd: PROJECT_A, agentPreset: "kaz" },
  // v0.8 Step A：子代理 stable/minimal 会话（带 subagent/descriptor）。
  "s-kaz-sub": { cwd: PROJECT_A, agentPreset: "kaz", subagent: true },
  "s-kaz-sub-min": { cwd: PROJECT_A, agentPreset: "kaz", subagent: true },
  // 专门验证首轮极简（无任何 tool/call）的 Kaz 会话。
  "s-kaz-min": { cwd: PROJECT_A, agentPreset: "kaz" },
  "s-kaz-min-nomem": { cwd: PROJECT_B, agentPreset: "kaz" },
};

/** 会话事件：s-kaz-plan 模拟旧 plan/mode 事件（v0.8 Step B1 后应被忽略）；sub 会话模拟子代理。
 *  除 s-kaz-min / s-kaz-sub-min 外都先放一条 tool/call，模拟“首次工具调用后”的稳定阶段。 */
const eventsOf = (id) => {
  const isSub = SESSIONS[id]?.subagent === true;
  const descriptor = isSub ? [{ type: "subagent/descriptor", seq: 0, time: Date.now(), data: {} }] : [];
  if (id === "s-kaz-min" || id === "s-kaz-min-nomem" || id === "s-kaz-sub-min") return descriptor;
  const base = [...descriptor, { type: "tool/call", seq: descriptor.length, time: Date.now(), data: { name: "pwsh" } }];
  if (id === "s-kaz-plan") return [...base, { type: "plan/mode", seq: base.length, time: Date.now(), data: { active: true } }];
  return base;
};

const agentOf = (id) => ({
  id,
  session: { header: { id, cwd: SESSIONS[id].cwd, agentPreset: SESSIONS[id].agentPreset }, events: eventsOf(id) },
});

// ---- mock settings ----
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

// ---- mock ctx ----
const listeners = new Map();
const provided = {};
const agentsBySession = new Map();
for (const [id, info] of Object.entries(SESSIONS)) {
  agentsBySession.set(id, { id, session: { header: { id, cwd: info.cwd, agentPreset: info.agentPreset }, events: eventsOf(id) } });
}
/** goal 模式 mock：s-kaz-goal 存在 active 目标。 */
const goalsByAgent = new Map();
goalsByAgent.set("s-kaz-goal", { phase: "active" });
const WHITELIST = ["pwsh", "read", "edit", "web_search", "memory_save", "memory_search"];

/** 鲸鱼工作流阶段 mock：由 ka-whale-workflow 插件在真实环境提供的服务。 */
const whaleStages = {
  "s-kaz-whale-rec": "reconstruction",
  "s-kaz-whale-cls": "classification",
};

const settings = makeSettings();
const mockTools = {
  register() {
    return () => {};
  },
  schemas() {
    return [{ name: "render_pixel_art" }, { name: "convert_image_to_pixel_art" }];
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
    if (name === "kaWhaleWorkflow") return { stageOf: (agent) => whaleStages[agent?.id] ?? null };
    if (name === "connection") return mockConnection;
    return undefined;
  },
  inject(deps, cb) {
    if (deps.includes("settings")) cb({ ...ctx, settings });
  },
};

plugin.apply(ctx, { enabled: true, toolWhitelist: [...WHITELIST], storageDir: join(TMP, "dsh-storages") });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
await settle();

// ① kazMode 服务按 agent 所在项目判定
const kazMode = provided["kazMode"];
check("① kazMode 服务已提供", kazMode !== undefined && typeof kazMode.toolVisible === "function");
check("① kazMode 服务不提供已删除的 detectedToolPlugins", kazMode !== undefined && typeof kazMode.detectedToolPlugins !== "function");

// ①.6 四文件模型 RPC：手动添加插件/工具后进入工具面
const sKaz = agentOf("s-kaz");
const sKazNomem = agentOf("s-kaz-nomem");
const sPlain = agentOf("s-plain");
const sPlainMem = agentOf("s-plain-mem");
const sKazLegacy = agentOf("s-kaz-legacy");
const sKazMin = agentOf("s-kaz-min");
const sKazMinNomem = agentOf("s-kaz-min-nomem");
const sKazSub = agentOf("s-kaz-sub");
const sKazSubMin = agentOf("s-kaz-sub-min");

// ② 硬边界 2：首次工具调用前工具面 ≤2（kaz-memory/ka-whale-memory 开与关两种状态）。
{
  const onSurface = kazMode.surfaceOf(sKazMin);
  const offSurface = kazMode.surfaceOf(sKazMinNomem);
  check("①.11 首轮极简（记忆开）工具面 ≤2 且仅 memory_search", onSurface !== null && onSurface.size <= 2 && onSurface.has("memory_search") && onSurface.size === 1);
  check("①.11 首轮极简（记忆关）工具面 ≤2 且 read/pwsh", offSurface !== null && offSurface.size <= 2 && offSurface.has("read") && offSurface.has("pwsh") && offSurface.size === 2);
  check("①.11 首轮极简不放行 edit/write/web_search", kazMode.toolVisible(sKazMin, "edit") === false && kazMode.toolVisible(sKazMin, "write") === false && kazMode.toolVisible(sKazMin, "web_search") === false && kazMode.toolVisible(sKazMinNomem, "edit") === false);
}

// ②.5 v0.8 Step A：稳定主面/子代理面（首次工具调用后）
{
  const stable = kazMode.surfaceOf(sKaz);
  const nomem = kazMode.surfaceOf(sKazNomem);
  const sub = kazMode.surfaceOf(sKazSub);
  const subMin = kazMode.surfaceOf(sKazSubMin);
  check("②.5 Stable Main Surface = 17（12 Base + Goal 三件套 + whale_report + subagent）", stable !== null && stable.size === 17);
  check("②.5 主面含 create_goal/get_goal/update_goal（常驻）", kazMode.toolVisible(sKaz, "create_goal") === true && kazMode.toolVisible(sKaz, "get_goal") === true && kazMode.toolVisible(sKaz, "update_goal") === true);
  check("②.5 主面含 whale_report/subagent", kazMode.toolVisible(sKaz, "whale_report") === true && kazMode.toolVisible(sKaz, "subagent") === true);
  check("②.5 主面不含 send_message/list_agents/enable_tool/workflow/subagent_fork", kazMode.toolVisible(sKaz, "send_message") === false && kazMode.toolVisible(sKaz, "list_agents") === false && kazMode.toolVisible(sKaz, "enable_tool") === false && kazMode.toolVisible(sKaz, "workflow") === false && kazMode.toolVisible(sKaz, "subagent_fork") === false);
  check("②.5 主面不含 exit_plan_mode（v0.8 Step B1：原生 Plan 已移除）", kazMode.toolVisible(sKaz, "exit_plan_mode") === false);
  check("②.5 记忆关稳定主面=固定集剔除记忆读三件", nomem !== null && nomem.size === 14 && !nomem.has("memory_search") && nomem.has("get_goal"));
  check("②.5 子代理稳定面 = 保守 Subagent Base 11", sub !== null && sub.size === 11 && sub.has("read") && sub.has("web_search") && !sub.has("create_goal") && !sub.has("whale_report") && !sub.has("subagent") && !sub.has("memory_save"));
  check("②.5 子代理 minimal = memory_search（≤2）", subMin !== null && subMin.size === 1 && subMin.has("memory_search"));
}

// ①.6 RPC：四文件模型（Step A 固定主面下，外置工具只写候选层，不进主面）
{
  const rpc = rpcHandlers.get("/kaz-mode");
  const getRes = await rpc("getExternalToolPlugins", { cwd: TMP });
  check("①.6 getExternalToolPlugins 返回四文件模型", getRes !== null && getRes.ok === true && getRes.value !== null && typeof getRes.value.userEnable === "object" && typeof getRes.value.userCatalog === "object" && typeof getRes.value.effective === "object");
  check("①.6 初始 projectDiffers=false / userDiffersFactory=false", getRes.value.projectDiffers === false && getRes.value.userDiffersFactory === false);
  const addP = await rpc("setExternalToolPlugin", { cwd: TMP, pluginName: "dsh-pixel-art", addPlugin: true });
  check("①.6 addPlugin 写入用户 other-enable/other-catalog", addP !== null && addP.ok === true && addP.value.userOtherEnable["dsh-pixel-art"] === true);
  const addT = await rpc("setExternalToolPlugin", { cwd: TMP, pluginName: "dsh-pixel-art", toolName: "render_pixel_art", addTool: true });
  check("①.6 addTool 写入用户 other-catalog", addT !== null && addT.ok === true && addT.value.userOtherCatalog["dsh-pixel-art"]?.render_pixel_art === true);
  check("①.6 手动添加的插件/工具写入候选层，但 Step A 固定主面不放行外置工具", addT !== null && addT.ok === true && addT.value.userOtherCatalog["dsh-pixel-art"]?.render_pixel_art === true && kazMode.toolVisible(sKaz, "render_pixel_art") === false);
  const resetU = await rpc("resetExternalToolPlugins", { cwd: TMP, layer: "user" });
  check("①.6 reset(user) 用出厂数据替换默认层并把 other-* 全置 true", resetU !== null && resetU.ok === true && resetU.value.userEnable["tool-fs"] === true && resetU.value.userCatalog["tool-fs"]?.read === true && resetU.value.userOtherEnable["dsh-pixel-art"] === true && resetU.value.projectOtherEnable["dsh-pixel-art"] === undefined);
  const tog = await rpc("setExternalToolPlugin", { cwd: TMP, pluginName: "dsh-pixel-art", layer: "project", capable: false });
  check("①.6 外置插件 capable false 写入项目 other-enable 字典", tog !== null && tog.ok === true && tog.value.projectOtherEnable["dsh-pixel-art"] === false);
  const rem = await rpc("setExternalToolPlugin", { cwd: TMP, pluginName: "dsh-pixel-art", removePlugin: true });
  check("①.6 removePlugin 删除用户添加插件", rem !== null && rem.ok === true && rem.value.userOtherEnable["dsh-pixel-art"] === undefined && rem.value.projectOtherEnable["dsh-pixel-art"] === undefined && rem.value.projectOtherCatalog["dsh-pixel-art"] === undefined);
}

// ①.8 官方工具统一走 factory/JSON，不再依赖 settings.yaml 的 toolWhitelist
{
  await settings.update("kaz-mode", { toolWhitelist: ["only_unknown"] });
  await settle();
  check("①.8 官方工具不再依赖 settings.toolWhitelist：pwsh/read/todo_write 仍可见", kazMode.toolVisible(sKaz, "pwsh") === true && kazMode.toolVisible(sKaz, "read") === true && kazMode.toolVisible(sKaz, "todo_write") === true);
  check("①.8 only_unknown 不进入工具面", kazMode.toolVisible(sKaz, "only_unknown") === false);
}

// ①.9 listToolPlugins 只返回官方/Kaz 分类
{
  const rpc = rpcHandlers.get("/kaz-mode");
  const list1 = await rpc("listToolPlugins", {});
  check("①.9 listToolPlugins 返回 catalog 且官方不再含 plan-mode/planmodecontroller（B1）", list1 !== null && list1.ok === true && list1.value.catalog !== null && Array.isArray(list1.value.catalog.official) && !list1.value.catalog.official.includes("plan-mode") && !list1.value.catalog.official.includes("planmodecontroller"));
}

// ①.10 项目级插件状态 RPC：setProjectPlugin / clearProjectPlugin / clearProject
{
  const rpc = rpcHandlers.get("/kaz-mode");
  const getRes = await rpc("getState", { sessionId: "s-kaz" });
  check("①.10 getState 返回项目状态对象", getRes !== null && getRes.ok === true && getRes.value.project !== null && typeof getRes.value.project === "object");
  const setRes = await rpc("setProjectPlugin", { sessionId: "s-kaz", pluginId: "round-minimal", patch: { enabled: false } });
  check("①.10 setProjectPlugin 写入项目状态", setRes !== null && setRes.ok === true && setRes.value.project?.enabled === false);
  const clearOne = await rpc("clearProjectPlugin", { sessionId: "s-kaz", pluginId: "round-minimal" });
  check("①.10 clearProjectPlugin 清除单插件项目覆盖", clearOne !== null && clearOne.ok === true && clearOne.value.project?.["round-minimal"] === undefined);
  const setAgain = await rpc("setProjectPlugin", { cwd: PROJECT_A, pluginId: "output-beep", patch: { enabled: true } });
  check("①.10 setProjectPlugin 支持仅按 cwd 写入", setAgain !== null && setAgain.ok === true && setAgain.value.project?.enabled === true);
  const clearAll = await rpc("clearProject", { cwd: PROJECT_A });
  check("①.10 clearProject 清除全部项目覆盖", clearAll !== null && clearAll.ok === true && clearAll.value.project === null);
}

check("① kazEnabled(kaz 会话)=true", kazMode.kazEnabled(sKaz) === true);
check("① kazEnabled(非 kaz 会话)=false", kazMode.kazEnabled(sPlain) === false);
check("① pluginEnabled(s-kaz, ka-whale-memory)=true", kazMode.pluginEnabled(sKaz, "ka-whale-memory") === true);
check("① pluginEnabled(s-kaz-nomem, ka-whale-memory)=false", kazMode.pluginEnabled(sKazNomem, "ka-whale-memory") === false);
check("① pluginEnabled(s-kaz-legacy, ka-whale-memory)=true（旧键兼容读）", kazMode.pluginEnabled(sKazLegacy, "ka-whale-memory") === true);
check("① toolVisible(s-kaz-legacy, memory_search)=true（旧键兼容读）", kazMode.toolVisible(sKazLegacy, "memory_search") === true);
check("① toolVisible(s-kaz, memory_search)=true（记忆开）", kazMode.toolVisible(sKaz, "memory_search") === true);
check("① toolVisible(s-kaz-nomem, memory_search)=false（记忆关）", kazMode.toolVisible(sKazNomem, "memory_search") === false);
check("① toolVisible(s-plain, memory_search)=false（非 Kaz 记忆关）", kazMode.toolVisible(sPlain, "memory_search") === false);
check("① toolVisible(s-plain-mem, memory_search)=true（非 Kaz 记忆开）", kazMode.toolVisible(sPlainMem, "memory_search") === true);
check("① toolVisible(s-plain, web_search)=true（非 Kaz 其它工具放行）", kazMode.toolVisible(sPlain, "web_search") === true);

// ② 组装层：Kaz 会话
const runAssemble = async (agent, tools) => {
  const listener = listeners.get("system-prompt/assemble")[0];
  const assembly = {
    tools: tools.map((name) => ({ name })),
    sections: [{ name: "deployment:persona", text: "p" }],
    contexts: [],
    variables: {},
  };
  await listener(assembly, { agent }, () => assembly);
  return assembly.tools.map((t) => t.name);
};
const ALL_TOOLS = [...WHITELIST, "workflow", "subagent", "subagent_fork", "create_goal", "get_goal", "update_goal", "whale_report", "enable_tool", "send_message", "list_agents", "exit_plan_mode"];
const kazNames = await runAssemble(sKaz, ALL_TOOLS);
check("② Kaz 会话：白名单外工具被移除（workflow/subagent_fork/enable_tool/send_message/list_agents/exit_plan_mode）", !kazNames.includes("workflow") && !kazNames.includes("subagent_fork") && !kazNames.includes("enable_tool") && !kazNames.includes("send_message") && !kazNames.includes("list_agents") && !kazNames.includes("exit_plan_mode"));
check("② Kaz 会话：Stable Main 固定工具保留（read/subagent/create_goal/whale_report）", kazNames.includes("read") && kazNames.includes("memory_search") && kazNames.includes("web_search") && kazNames.includes("subagent") && kazNames.includes("create_goal") && kazNames.includes("whale_report"));
const kazNomemNames = await runAssemble(sKazNomem, ALL_TOOLS);
check("② Kaz 会话（记忆关）：记忆工具被过滤，Goal 工具仍常驻", !kazNomemNames.includes("memory_search") && !kazNomemNames.includes("memory_save") && kazNomemNames.includes("get_goal"));

// ③ 组装层：非 Kaz 会话
const plainNames = await runAssemble(sPlain, ALL_TOOLS);
check("③ 非 Kaz 会话（记忆关）：记忆工具被移除", !plainNames.includes("memory_search") && !plainNames.includes("memory_save"));
check("③ 非 Kaz 会话：标准工具保留（workflow/subagent/web_search）", plainNames.includes("workflow") && plainNames.includes("subagent") && plainNames.includes("web_search"));
const plainMemNames = await runAssemble(sPlainMem, ALL_TOOLS);
check("③ 非 Kaz 会话（记忆开）：记忆工具保留", plainMemNames.includes("memory_search"));

// ④ 执行层
const gate = listeners.get("tools/pre-execute")[0];
const runGate = async (agent, name) => gate({ name, agent }, async () => ({ kind: "allow" }));
const denyWorkflow = await runGate(sKaz, "workflow");
check("④ Kaz 会话：拒绝白名单外工具（workflow）", denyWorkflow.kind === "deny");
const allowMem = await runGate(sKaz, "memory_search");
check("④ Kaz 会话：放行记忆工具（memory_search）", allowMem.kind === "allow");
const denyMemPlain = await runGate(sPlain, "memory_search");
check("④ 非 Kaz 会话（记忆关）：拒绝 memory_search", denyMemPlain.kind === "deny");
const allowMemPlain = await runGate(sPlainMem, "memory_search");
check("④ 非 Kaz 会话（记忆开）：放行 memory_search", allowMemPlain.kind === "allow");
const internalCall = await gate({ name: "workflow" }, async () => ({ kind: "allow" }));
check("④ 无 agent 的内部调用放行", internalCall.kind === "allow");

// ⑤ 工具面完全由项目状态计算（常驻注册语义：不看全局 enabled 注销）
check("⑤ 服务判定不依赖全局注册状态（再次查询结果一致）", kazMode.toolVisible(sKaz, "memory_search") === true && kazMode.toolVisible(sPlain, "memory_search") === false);

// ⑥ 组装层不再改写系统提示词（已交给 kaz 预设的 kaz-system-prompt.mjs）
{
  const listener = listeners.get("system-prompt/assemble")[0];
  const assembly = {
    tools: [{ name: "pwsh" }],
    sections: [
      { name: "deployment:persona", text: "other" },
      { name: "other:policy", text: "anchor" },
    ],
    contexts: [],
    variables: {},
  };
  await listener(assembly, { agent: sKaz }, () => assembly);
  const persona = assembly.sections.find((s) => s.name === "deployment:persona");
  check("⑥ Kaz 会话不再由 kaz-mode 改写 persona", persona !== undefined && persona.text === "other");
  check("⑥ Kaz 会话不再由 kaz-mode 过滤其它提示段", assembly.sections.some((s) => s.name === "other:policy"));
}

// ⑦ v0.8 Step A/B1/B2：Goal 三件套常驻；原生 Plan 与 kaz_tool_auto_on 均已移除
{
  const rpc = rpcHandlers.get("/kaz-mode");
  const sKazPlan = agentOf("s-kaz-plan");
  const sKazGoal = agentOf("s-kaz-goal");
  const sKazBase = agentOf("s-kaz");

  // 工具控制 JSON 仍可写旧 plan-mode/goal 键，用于验证固定主面不受这些 JSON 影响。
  writeFileSync(
    join(TMP, "dsh-storages", "tool-plugin.json"),
    JSON.stringify({ "plan-mode": true, goal: true }, null, 2),
    "utf8",
  );
  writeFileSync(
    join(TMP, "dsh-storages", "tool-plugin-catalog.json"),
    JSON.stringify(
      {
        "plan-mode": { exit_plan_mode: true },
        goal: { get_goal: true, update_goal: true },
      },
      null,
      2,
    ),
    "utf8",
  );

  check("⑦ 稳定主面：Goal 三件套常驻，exit_plan_mode 不可见", kazMode.toolVisible(sKazBase, "create_goal") === true && kazMode.toolVisible(sKazBase, "get_goal") === true && kazMode.toolVisible(sKazBase, "update_goal") === true && kazMode.toolVisible(sKazBase, "exit_plan_mode") === false);
  check("⑦ 旧 plan/mode 事件已不再产生 Plan 例外（exit_plan_mode 不可见）", kazMode.toolVisible(sKazPlan, "exit_plan_mode") === false && kazMode.toolVisible(sKazPlan, "create_goal") === true && kazMode.toolVisible(sKazPlan, "get_goal") === true);
  check("⑦ Goal 会话：Goal 常驻、无 Plan 例外", kazMode.toolVisible(sKazGoal, "get_goal") === true && kazMode.toolVisible(sKazGoal, "update_goal") === true && kazMode.toolVisible(sKazGoal, "exit_plan_mode") === false);
  check("⑦ whale_report 常驻主面（不再依赖工作流阶段）", kazMode.toolVisible(sKazBase, "whale_report") === true && kazMode.toolVisible(sKazGoal, "whale_report") === true && kazMode.toolVisible(sKazPlan, "whale_report") === true);

  const snap = await rpc("getToolAutoOn", { sessionId: "s-kaz-plan" });
  check("⑦ getToolAutoOn 已退役（RPC unknown endpoint）", snap !== null && snap.ok === false);
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nKAZ-MODE PROBE OK" : `\nKAZ-MODE PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
