// kaz-mode 探针（方案 A 重构后）：按 agent 会话计算工具面，不做全局注销。
// 覆盖：
//   ① kazMode 服务：kazEnabled / pluginEnabled / toolVisible 按 agent 会话判定；
//   ② 组装层：Kaz 会话按白名单过滤（记忆/诊断工具按该会话开关增减）；
//   ③ 组装层：非 Kaz 会话只移除该会话禁用的记忆/诊断工具（标准工具保留）；
//   ④ 执行层：Kaz 会话拒绝白名单外调用；非 Kaz 会话拒绝已禁用插件的工具；
//   ⑤ 记忆/诊断工具常驻注册——工具面完全由会话状态计算，不随全局 enabled 注销。
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
mkdirSync(join(TMP, ".dsh"), { recursive: true });
const SESSION_FILE = join(TMP, ".dsh", "kaz-session-states.json");

// 会话：agentPreset 决定 Kaz/非 Kaz；会话状态文件决定 kaz-memory 开关。
const SESSIONS = {
  "s-kaz": { agentPreset: "kaz", states: { "kaz-memory": { enabled: true } } },
  "s-kaz-nomem": { agentPreset: "kaz", states: { "kaz-memory": { enabled: false } } },
  "s-plain": { agentPreset: "router-standard", states: { "kaz-memory": { enabled: false } } },
  "s-plain-mem": { agentPreset: "router-standard", states: { "kaz-memory": { enabled: true } } },
};
{
  const sessionsJson = { version: 1, sessions: {} };
  for (const [id, info] of Object.entries(SESSIONS)) sessionsJson.sessions[id] = info.states;
  writeFileSync(SESSION_FILE, JSON.stringify(sessionsJson, null, 2), "utf8");
}

const agentOf = (id) => ({
  id,
  session: { header: { id, cwd: TMP, agentPreset: SESSIONS[id].agentPreset }, events: [] },
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
  agentsBySession.set(id, { id, session: { header: { id, cwd: TMP, agentPreset: info.agentPreset } } });
}
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

// ① kazMode 服务按 agent 会话判定
const kazMode = provided["kazMode"];
check("① kazMode 服务已提供", kazMode !== undefined && typeof kazMode.toolVisible === "function");
check("① kazMode 服务提供 detectedToolPlugins（只读检测）", kazMode !== undefined && typeof kazMode.detectedToolPlugins === "function");

// ①.5 动态检测：包装 tools.register，用 this.ctx.fiber.name 归因
{
  const pluginCtx = { ...ctx, fiber: { name: "dsh-pixel-art", state: 0 } };
  mockTools.ctx = pluginCtx;
  mockTools.register({ name: "render_pixel_art" });
  mockTools.register({ name: "convert_image_to_pixel_art" });
  const detected = kazMode.detectedToolPlugins();
  const pixel = detected.find((item) => item.pluginName === "dsh-pixel-art");
  check("①.5 动态检测：dsh-pixel-art 被记录且工具归因正确", pixel !== undefined && pixel.tools.includes("render_pixel_art") && pixel.tools.includes("convert_image_to_pixel_art"));
}

// ①.6 三层存储 RPC（用户默认 / 项目设置）
{
  const rpc = rpcHandlers.get("/kaz-mode");
  check("①.6 RPC 通道已注册", typeof rpc === "function");
  const getRes = await rpc("getExternalToolPlugins", { cwd: TMP });
  check("①.6 getExternalToolPlugins 返回三层结构", getRes !== null && getRes.ok === true && getRes.value !== null && typeof getRes.value.factory === "object" && typeof getRes.value.user === "object" && typeof getRes.value.project === "object" && typeof getRes.value.effective === "object");
  check("①.6 初始 projectDiffers=false / userDiffersFactory=true（检测到的新插件已写入用户默认）", getRes.value.projectDiffers === false && getRes.value.userDiffersFactory === true);
  const setRes = await rpc("setExternalToolPlugin", {
    cwd: TMP,
    layer: "project",
    pluginName: "dsh-pixel-art",
    toolName: "render_pixel_art",
    enabled: false,
  });
  check("①.6 setExternalToolPlugin 写入项目层", setRes !== null && setRes.ok === true && setRes.value.project.plugins["dsh-pixel-art"]?.tools["render_pixel_art"] === false && setRes.value.projectDiffers === true);
  const getRes2 = await rpc("getExternalToolPlugins", { cwd: TMP });
  check("①.6 项目层持久化后可读回", getRes2.value.project.plugins["dsh-pixel-art"]?.tools["render_pixel_art"] === false);
  const resetRes = await rpc("resetExternalToolPlugins", { cwd: TMP, layer: "project" });
  check("①.6 resetExternalToolPlugins 清空项目层", resetRes !== null && resetRes.ok === true && resetRes.value.projectDiffers === false && Object.keys(resetRes.value.project.plugins).length === 0);
  const resetUser = await rpc("resetExternalToolPlugins", { cwd: TMP, layer: "user" });
  check("①.6 reset user 写回出厂后 userDiffersFactory=false", resetUser !== null && resetUser.ok === true && resetUser.value.userDiffersFactory === false);
}
const sKaz = agentOf("s-kaz");
const sKazNomem = agentOf("s-kaz-nomem");
const sPlain = agentOf("s-plain");
const sPlainMem = agentOf("s-plain-mem");

// ①.7 kazSurfaceFor 接入：外置插件第一次检测到默认开启
{
  const rpc = rpcHandlers.get("/kaz-mode");
  check("①.7 外置检测默认开启：render_pixel_art 进入 Kaz 工具面", kazMode.toolVisible(sKaz, "render_pixel_art") === true);
  check("①.7 surfaceOf 包含 render_pixel_art", kazMode.surfaceOf(sKaz).has("render_pixel_art") === true);
  await rpc("setExternalToolPlugin", {
    cwd: TMP,
    layer: "project",
    pluginName: "dsh-pixel-art",
    toolName: "render_pixel_art",
    enabled: false,
  });
  check("①.7 项目层关闭后 render_pixel_art 不可见", kazMode.toolVisible(sKaz, "render_pixel_art") === false);
  check("①.7 convert_image_to_pixel_art 仍默认开启", kazMode.toolVisible(sKaz, "convert_image_to_pixel_art") === true);
  await rpc("resetExternalToolPlugins", { cwd: TMP, layer: "project" });
  check("①.7 重置项目层后 render_pixel_art 恢复默认开启", kazMode.toolVisible(sKaz, "render_pixel_art") === true);

  await rpc("setExternalToolPlugin", {
    cwd: TMP,
    layer: "project",
    pluginName: "dsh-pixel-art",
    toolName: "convert_image_to_pixel_art",
    toolHidden: true,
  });
  check("①.7 工具 hidden 后 convert_image_to_pixel_art 不可见", kazMode.toolVisible(sKaz, "convert_image_to_pixel_art") === false);
  check("①.7 render_pixel_art 仍默认开启", kazMode.toolVisible(sKaz, "render_pixel_art") === true);
  await rpc("setExternalToolPlugin", {
    cwd: TMP,
    layer: "project",
    pluginName: "dsh-pixel-art",
    toolName: "convert_image_to_pixel_art",
    toolHidden: false,
  });
  check("①.7 取消 toolHidden 后恢复默认开启", kazMode.toolVisible(sKaz, "convert_image_to_pixel_art") === true);
  await rpc("resetExternalToolPlugins", { cwd: TMP, layer: "project" });
}

// ①.8 官方工具统一走 factory/JSON，不再依赖 settings.yaml 的 toolWhitelist
{
  await settings.update("kaz-mode", { toolWhitelist: ["only_unknown"] });
  await settle();
  check("①.8 官方工具不再依赖 settings.toolWhitelist：pwsh/read/todo_write 仍可见", kazMode.toolVisible(sKaz, "pwsh") === true && kazMode.toolVisible(sKaz, "read") === true && kazMode.toolVisible(sKaz, "todo_write") === true);
  check("①.8 only_unknown 不进入工具面", kazMode.toolVisible(sKaz, "only_unknown") === false);
}

// ①.9 用户目录外置插件目录：分类来自 catalog，remove/restoreRemoved 落盘
{
  const rpc = rpcHandlers.get("/kaz-mode");
  const list1 = await rpc("listToolPlugins", {});
  check("①.9 listToolPlugins 返回 catalog 且官方含 planmodecontroller", list1 !== null && list1.ok === true && list1.value.catalog !== null && Array.isArray(list1.value.catalog.official) && list1.value.catalog.official.includes("planmodecontroller"));
  const rem = await rpc("setExternalToolPlugin", { cwd: TMP, pluginName: "dsh-pixel-art", removePlugin: true });
  check("①.9 removePlugin 落盘 removedPlugins", rem !== null && rem.ok === true && rem.value.removedPlugins["dsh-pixel-art"] === true);
  const list2 = await rpc("listToolPlugins", {});
  check("①.9 listToolPlugins 能看到 removedPlugins", list2.value.catalog.removedPlugins["dsh-pixel-art"] === true);
  const rst = await rpc("setExternalToolPlugin", { cwd: TMP, pluginName: "dsh-pixel-art", restoreRemoved: true });
  check("①.9 restoreRemoved 清空 removedPlugins", rst !== null && rst.ok === true && rst.value.removedPlugins["dsh-pixel-art"] === undefined);
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

// ⑤ 工具面完全由会话状态计算（常驻注册语义：不看全局 enabled 注销）
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

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nKAZ-MODE PROBE OK" : `\nKAZ-MODE PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
