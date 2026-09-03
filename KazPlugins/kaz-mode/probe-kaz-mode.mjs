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
  "s-kaz-whale-rec": { cwd: PROJECT_A, agentPreset: "kaz" },
  "s-kaz-whale-cls": { cwd: PROJECT_A, agentPreset: "kaz" },
  // 专门验证首轮极简（无任何 tool/call）的 Kaz 会话。
  "s-kaz-min": { cwd: PROJECT_A, agentPreset: "kaz" },
  "s-kaz-min-nomem": { cwd: PROJECT_B, agentPreset: "kaz" },
};

/** plan/mode 会话事件：s-kaz-plan 模拟“当前处于 plan 模式”；whale 阶段事件同理。
 *  除 s-kaz-min 外都先放一条 tool/call，模拟“首次工具调用后”的全量阶段，
 *  使既有工具面断言不再被首轮极简（核心收编后默认生效）干扰。 */
const eventsOf = (id) => {
  if (id === "s-kaz-min" || id === "s-kaz-min-nomem") return [];
  const base = [{ type: "tool/call", seq: 0, time: Date.now(), data: { name: "pwsh" } }];
  if (id === "s-kaz-plan") return [...base, { type: "plan/mode", seq: 1, time: Date.now(), data: { active: true } }];
  if (id === "s-kaz-whale-rec") return [...base, { type: "ka-whale-workflow/stage", seq: 1, time: Date.now(), data: { stage: "reconstruction" } }];
  if (id === "s-kaz-whale-cls") return [...base, { type: "ka-whale-workflow/stage", seq: 1, time: Date.now(), data: { stage: "classification" } }];
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

// ② 硬边界 2：首次工具调用前工具面 ≤2（kaz-memory/ka-whale-memory 开与关两种状态）。
{
  const onSurface = kazMode.surfaceOf(sKazMin);
  const offSurface = kazMode.surfaceOf(sKazMinNomem);
  check("①.11 首轮极简（记忆开）工具面 ≤2 且仅 memory_search", onSurface !== null && onSurface.size <= 2 && onSurface.has("memory_search") && onSurface.size === 1);
  check("①.11 首轮极简（记忆关）工具面 ≤2 且 read/pwsh", offSurface !== null && offSurface.size <= 2 && offSurface.has("read") && offSurface.has("pwsh") && offSurface.size === 2);
  check("①.11 首轮极简不放行 edit/write/web_search", kazMode.toolVisible(sKazMin, "edit") === false && kazMode.toolVisible(sKazMin, "write") === false && kazMode.toolVisible(sKazMin, "web_search") === false && kazMode.toolVisible(sKazMinNomem, "edit") === false);
}

{
  const rpc = rpcHandlers.get("/kaz-mode");
  check("①.6 RPC 通道已注册", typeof rpc === "function");
  const getRes = await rpc("getExternalToolPlugins", { cwd: TMP });
  check("①.6 getExternalToolPlugins 返回四文件模型", getRes !== null && getRes.ok === true && getRes.value !== null && typeof getRes.value.userEnable === "object" && typeof getRes.value.userCatalog === "object" && typeof getRes.value.effective === "object");
  check("①.6 初始 projectDiffers=false / userDiffersFactory=false", getRes.value.projectDiffers === false && getRes.value.userDiffersFactory === false);
  const addP = await rpc("setExternalToolPlugin", { cwd: TMP, pluginName: "dsh-pixel-art", addPlugin: true });
  check("①.6 addPlugin 写入用户 other-enable/other-catalog", addP !== null && addP.ok === true && addP.value.userOtherEnable["dsh-pixel-art"] === true);
  const addT = await rpc("setExternalToolPlugin", { cwd: TMP, pluginName: "dsh-pixel-art", toolName: "render_pixel_art", addTool: true });
  check("①.6 addTool 写入用户 other-catalog", addT !== null && addT.ok === true && addT.value.userOtherCatalog["dsh-pixel-art"]?.render_pixel_art === true);
  check("①.6 手动添加的插件/工具进入 Kaz 工具面", kazMode.toolVisible(sKaz, "render_pixel_art") === true);
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
  check("①.9 listToolPlugins 返回 catalog 且官方含 planmodecontroller", list1 !== null && list1.ok === true && list1.value.catalog !== null && Array.isArray(list1.value.catalog.official) && list1.value.catalog.official.includes("planmodecontroller"));
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
const ALL_TOOLS = [...WHITELIST, "workflow", "subagent"];
const kazNames = await runAssemble(sKaz, ALL_TOOLS);
check("② Kaz 会话：白名单外工具被移除（workflow/subagent）", !kazNames.includes("workflow") && !kazNames.includes("subagent"));
check("② Kaz 会话：白名单内工具保留（read/memory_search/web_search）", kazNames.includes("read") && kazNames.includes("memory_search") && kazNames.includes("web_search"));
const kazNomemNames = await runAssemble(sKazNomem, ALL_TOOLS);
check("② Kaz 会话（记忆关）：记忆工具被过滤", !kazNomemNames.includes("memory_search") && !kazNomemNames.includes("memory_save"));

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

// ⑦ kaz_tool_auto_on：三层单 JSON（原设置/默认设置/专属设置）+ 运行时临时放行
{
  const rpc = rpcHandlers.get("/kaz-mode");
  const sKazPlan = agentOf("s-kaz-plan");
  const sKazGoal = agentOf("s-kaz-goal");
  const sKazBase = agentOf("s-kaz");

  // 预置用户默认 auto-on JSON（等同出厂值） + 工具控制 JSON 里启用 plan-mode/goal
  // （应被模式限定逻辑从基础工具面移除）。
  writeFileSync(
    join(TMP, "dsh-storages", "ka_tool_auto_on_setting.json"),
    JSON.stringify(
      {
        plan: { enabled: true, tools: ["exit_plan_mode"] },
        goal: { enabled: true, tools: ["get_goal", "update_goal"] },
      },
      null,
      2,
    ),
    "utf8",
  );
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

  // 模式限定：工具控制 JSON 里启用了 plan-mode/goal，但基础面仍不放行。
  check("⑦ 基础面不放行模式限定工具", kazMode.toolVisible(sKazBase, "exit_plan_mode") === false && kazMode.toolVisible(sKazBase, "get_goal") === false && kazMode.toolVisible(sKazBase, "update_goal") === false);

  // 按项目设置生效，无需 applySession：plan/goal 模式激活时自动放行。
  check("⑦ plan 模式自动放行 exit_plan_mode", kazMode.toolVisible(sKazPlan, "exit_plan_mode") === true);
  check("⑦ goal 模式自动放行 get_goal/update_goal", kazMode.toolVisible(sKazGoal, "get_goal") === true && kazMode.toolVisible(sKazGoal, "update_goal") === true);
  check("⑦ goal 会话不放行 plan 工具", kazMode.toolVisible(sKazGoal, "exit_plan_mode") === false);
  check("⑦ plan 会话不放行 goal 工具", kazMode.toolVisible(sKazPlan, "get_goal") === false);

  // 鲸鱼工作流：重构/分类阶段临时放行 whale_report；分类不再单独放行 create_goal/create_plan。
  const sKazWhaleRec = agentOf("s-kaz-whale-rec");
  const sKazWhaleCls = agentOf("s-kaz-whale-cls");
  check("⑦ 重构阶段放行 whale_report", kazMode.toolVisible(sKazWhaleRec, "whale_report") === true);
  check("⑦ 分类阶段仅放行 whale_report", kazMode.toolVisible(sKazWhaleCls, "whale_report") === true && kazMode.toolVisible(sKazWhaleCls, "create_goal") === false && kazMode.toolVisible(sKazWhaleCls, "create_plan") === false);
  check("⑦ 非工作流会话不放行 whale_report/启动工具", kazMode.toolVisible(sKazBase, "whale_report") === false && kazMode.toolVisible(sKazBase, "create_goal") === false && kazMode.toolVisible(sKazBase, "create_plan") === false);

  // RPC 快照：返回三层与生效状态。
  const snap = await rpc("getToolAutoOn", { sessionId: "s-kaz-plan" });
  check("⑦ getToolAutoOn 返回三层与生效状态", snap?.ok === true && snap.value?.effective?.plan?.enabled === true && Array.isArray(snap.value?.effective?.plan?.tools) && snap.value.effective.plan.tools.includes("exit_plan_mode") && snap.value?.projectDiffers === false && snap.value?.features?.plan?.overridden === false);
  check("⑦ getToolAutoOn 返回 whale 生效状态（无 launch）", snap?.ok === true && snap.value?.effective?.whale?.tools?.includes("whale_report") === true && snap.value?.effective?.whale?.launch === undefined);

  // 项目 JSON 写了与默认完全相同的值 → 不算“专属”。
  const same = await rpc("setToolAutoOn", { sessionId: "s-kaz-plan", feature: "plan", enabled: true, tools: ["exit_plan_mode"] });
  check("⑦ 项目设置与默认一致时不显示专属", same?.ok === true && same.value?.features?.plan?.overridden === false && same.value?.hasProjectOverrides === false);

  // 写项目专属：关闭 plan 开关 → 写入项目 ka_tool_auto_on_setting.json。
  const off = await rpc("setToolAutoOn", { sessionId: "s-kaz-plan", feature: "plan", enabled: false });
  check("⑦ setToolAutoOn(project) 写入项目专属并生效", off?.ok === true && off.value?.features?.plan?.enabled === false && off.value?.features?.plan?.overridden === true && off.value?.hasProjectOverrides === true);
  check("⑦ 关闭 plan 后 exit_plan_mode 不再放行", kazMode.toolVisible(sKazPlan, "exit_plan_mode") === false);
  const projFile = JSON.parse(readFileSync(join(PROJECT_A, ".dsh", "storages", "ka_tool_auto_on_setting.json"), "utf8"));
  check("⑦ 项目 JSON 已写入 plan.enabled=false", projFile?.plan?.enabled === false);

  // 调整 goal 工具清单（项目专属）→ 只放行新清单。
  const custom = await rpc("setToolAutoOn", { sessionId: "s-kaz-goal", feature: "goal", enabled: true, tools: ["get_goal"] });
  check("⑦ setToolAutoOn 调整 goal 工具清单", custom?.ok === true && JSON.stringify(custom.value?.features?.goal?.tools) === JSON.stringify(["get_goal"]));
  check("⑦ 调整后只放行新清单", kazMode.toolVisible(sKazGoal, "get_goal") === true && kazMode.toolVisible(sKazGoal, "update_goal") === false);

  // 调整鲸鱼工作流工具清单（项目专属）→ 只放行新清单（launch 子项已移除）。
  const whaleCustom = await rpc("setToolAutoOn", { sessionId: "s-kaz-whale-cls", feature: "whale", enabled: true, tools: ["whale_report"] });
  check("⑦ setToolAutoOn 调整 whale 工具清单", whaleCustom?.ok === true && JSON.stringify(whaleCustom.value?.features?.whale?.tools) === JSON.stringify(["whale_report"]) && whaleCustom.value?.features?.whale?.launch === undefined);
  const whaleReset = await rpc("setToolAutoOn", { sessionId: "s-kaz-whale-cls", feature: "whale", reset: true });
  check("⑦ reset whale 清除项目专属", whaleReset?.ok === true && whaleReset.value?.features?.whale?.launch === undefined && whaleReset.value?.features?.whale?.overridden === false);

  // 清除某个 feature 的项目专属覆盖 → 回落到用户默认。
  const resetOne = await rpc("setToolAutoOn", { sessionId: "s-kaz-plan", feature: "plan", reset: true });
  check("⑦ reset feature 清除项目专属", resetOne?.ok === true && resetOne.value?.features?.plan?.overridden === false && resetOne.value?.features?.plan?.enabled === true);
  check("⑦ 清除后 plan 工具恢复放行", kazMode.toolVisible(sKazPlan, "exit_plan_mode") === true);

  // 设为默认：把当前项目专属（goal 清单）复制到用户默认 JSON。
  const asDefault = await rpc("setToolAutoOnAsDefault", { sessionId: "s-kaz-goal" });
  check("⑦ setToolAutoOnAsDefault 复制项目专属到用户默认", asDefault?.ok === true && asDefault.value?.effective?.goal?.tools?.includes("get_goal") === true);
  const userFile = JSON.parse(readFileSync(join(TMP, "dsh-storages", "ka_tool_auto_on_setting.json"), "utf8"));
  check("⑦ 用户 JSON 已更新 goal.tools 为 [get_goal]", JSON.stringify(userFile?.goal?.tools) === JSON.stringify(["get_goal"]));

  // 清空项目专属 → 生效回到用户默认。
  const resetProj = await rpc("resetToolAutoOn", { sessionId: "s-kaz-goal", layer: "project" });
  check("⑦ resetToolAutoOn(project) 清空专属", resetProj?.ok === true && resetProj.value?.hasProjectOverrides === false && resetProj.value?.effective?.goal?.tools?.includes("get_goal") === true);

  // 恢复用户默认 → 回到出厂。
  const resetUser = await rpc("resetToolAutoOn", { sessionId: "s-kaz-goal", layer: "user" });
  check("⑦ resetToolAutoOn(user) 恢复出厂", resetUser?.ok === true && JSON.stringify(resetUser.value?.effective?.goal?.tools) === JSON.stringify(["get_goal", "update_goal"]));
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nKAZ-MODE PROBE OK" : `\nKAZ-MODE PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
