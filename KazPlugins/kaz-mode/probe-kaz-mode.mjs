// kaz-mode 探针（方案 A 重构后）：按 agent 所在项目计算工具面，不做全局注销。
// 覆盖：
//   ① kazMode 服务：kazEnabled / pluginEnabled / toolVisible 按 agent 项目判定；
//   ② 组装层：Kaz 会话按白名单过滤（记忆/诊断工具按该项目开关增减）；
//   ③ 组装层：非 Kaz 会话只移除该项目禁用的记忆/诊断工具（标准工具保留）；
//   ④ 执行层：Kaz 会话拒绝白名单外调用；非 Kaz 会话拒绝已禁用插件的工具；
//   ⑤ 记忆/诊断工具常驻注册——工具面完全由项目状态计算，不随全局 enabled 注销。
// 运行：node kaz-mode/probe-kaz-mode.mjs
import plugin from "file:///C:/Users/Kaczev/.dsh/profiles/web/KazPlugins/kaz-mode/lib/index.js";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
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
for (const dir of [PROJECT_A, PROJECT_B, PROJECT_C]) {
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
writeProjectStates(PROJECT_B, { "kaz-memory": { enabled: false } });
writeProjectStates(PROJECT_C, { "kaz-memory": { enabled: true } });

// 会话：agentPreset 决定 Kaz/非 Kaz；项目状态文件（按 cwd）决定 kaz-memory 开关。
const SESSIONS = {
  "s-kaz": { cwd: PROJECT_A, agentPreset: "kaz" },
  "s-kaz-nomem": { cwd: PROJECT_B, agentPreset: "kaz" },
  "s-plain": { cwd: PROJECT_B, agentPreset: "router-standard" },
  "s-plain-mem": { cwd: PROJECT_C, agentPreset: "router-standard" },
  "s-kaz-plan": { cwd: PROJECT_A, agentPreset: "kaz" },
  "s-kaz-goal": { cwd: PROJECT_A, agentPreset: "kaz" },
};

/** plan/mode 会话事件：s-kaz-plan 模拟“当前处于 plan 模式”。 */
const eventsOf = (id) =>
  id === "s-kaz-plan"
    ? [{ type: "plan/mode", seq: 1, time: Date.now(), data: { active: true } }]
    : [];

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
check("① pluginEnabled(s-kaz, kaz-memory)=true", kazMode.pluginEnabled(sKaz, "kaz-memory") === true);
check("① pluginEnabled(s-kaz-nomem, kaz-memory)=false", kazMode.pluginEnabled(sKazNomem, "kaz-memory") === false);
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
      { name: "thinking-anchor:policy", text: "anchor" },
    ],
    contexts: [],
    variables: {},
  };
  await listener(assembly, { agent: sKaz }, () => assembly);
  const persona = assembly.sections.find((s) => s.name === "deployment:persona");
  check("⑥ Kaz 会话不再由 kaz-mode 改写 persona", persona !== undefined && persona.text === "other");
  check("⑥ Kaz 会话不再由 kaz-mode 过滤其它提示段", assembly.sections.some((s) => s.name === "thinking-anchor:policy"));
}

// ⑦ kaz_tool_auto_on：按会话内存态临时放行
{
  const rpc = rpcHandlers.get("/kaz-mode");
  const sKazPlan = agentOf("s-kaz-plan");
  const sKazGoal = agentOf("s-kaz-goal");

  // 未 applySession 的会话不参与（“仅当前对话生效”）。
  check("⑦ 未 applySession 的会话不放行 plan 工具", kazMode.toolVisible(sKazPlan, "exit_plan_mode") === false);
  check("⑦ 未 applySession 的会话不放行 goal 工具", kazMode.toolVisible(sKazGoal, "get_goal") === false);

  // applySession 初始化当前会话状态。
  const applyPlan = await rpc("applySession", { sessionId: "s-kaz-plan" });
  const applyGoal = await rpc("applySession", { sessionId: "s-kaz-goal" });
  check("⑦ applySession 初始化 auto-on 状态", applyPlan?.ok === true && applyGoal?.ok === true);

  // 默认开关开 + 模式激活 -> 自动放行。
  check("⑦ plan 模式自动放行 exit_plan_mode", kazMode.toolVisible(sKazPlan, "exit_plan_mode") === true);
  check("⑦ goal 模式自动放行 get_goal/update_goal", kazMode.toolVisible(sKazGoal, "get_goal") === true && kazMode.toolVisible(sKazGoal, "update_goal") === true);
  // 未激活的模式不放行。
  check("⑦ goal 会话不放行 plan 工具", kazMode.toolVisible(sKazGoal, "exit_plan_mode") === false);
  check("⑦ plan 会话不放行 goal 工具", kazMode.toolVisible(sKazPlan, "get_goal") === false);

  // RPC 快照。
  const snap = await rpc("getToolAutoOn", { sessionId: "s-kaz-plan" });
  check("⑦ getToolAutoOn 返回模式激活与功能状态", snap?.ok === true && snap.value?.active?.plan === true && snap.value?.features?.plan?.enabled === true && Array.isArray(snap.value?.features?.plan?.tools) && snap.value.features.plan.tools.includes("exit_plan_mode"));

  // 关闭开关 -> 立即移除。
  const off = await rpc("setToolAutoOn", { sessionId: "s-kaz-plan", feature: "plan", enabled: false });
  check("⑦ setToolAutoOn 关闭 plan 开关", off?.ok === true && off.value?.features?.plan?.enabled === false);
  check("⑦ 关闭开关后 plan 工具移除", kazMode.toolVisible(sKazPlan, "exit_plan_mode") === false);

  // 调整工具清单 -> 只放行新清单。
  const custom = await rpc("setToolAutoOn", { sessionId: "s-kaz-goal", feature: "goal", enabled: true, tools: ["get_goal"] });
  check("⑦ setToolAutoOn 调整 goal 工具清单", custom?.ok === true && JSON.stringify(custom.value?.features?.goal?.tools) === JSON.stringify(["get_goal"]));
  check("⑦ 调整后只放行新清单", kazMode.toolVisible(sKazGoal, "get_goal") === true && kazMode.toolVisible(sKazGoal, "update_goal") === false);

  // 恢复默认，避免影响其它检查（仅内存态）。
  await rpc("setToolAutoOn", { sessionId: "s-kaz-plan", feature: "plan", enabled: true });
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nKAZ-MODE PROBE OK" : `\nKAZ-MODE PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
