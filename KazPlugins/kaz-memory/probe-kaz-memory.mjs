// kaz-memory 宿主半探针：在 mock ctx 上运行插件，验证：
//   ① memory_list 只返回 id/namespace/status/名称，不含 content 与 keywords；
//   ② memory_search 返回完整正文；
//   ③ 固定指引 tool:memory 用 [标题] > < 消息格式，说明 list 只回名称、search 回全文；
//   ④ 面板桥接：settings 镜像 memories（仅元数据、按 updatedAt 倒序）+ opened 按需正文（open/close）；
//   ⑤ 项目记忆按项目文件夹隔离：项目根从 exec.agent.session.header.cwd 解析，
//      不同项目根看到各自的项目记忆；memory_save(namespace=project) 写入对应项目根；
//   ⑥ paths 镜像：global / project 两个记忆 json 所在文件夹；
//   ⑦ openFolder 动作：target=global/project 分别打开对应文件夹（config.openFolder 覆盖，不真开资源管理器）。
// 运行：node kaz-memory/probe-kaz-memory.mjs
import { apply } from "./lib/index.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, rmSync } from "node:fs";

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

// ---- mock 记忆引擎（直接经 ctx.plugin 注入，绕过 vendored MemoryEngine） ----
// projectRoot 字段标记一条 project 记忆属于哪个项目根；list/search 按 filter.projectRoot 过滤。
function makeMemoryEngine(records) {
  let list = [...records];
  const projectRootMatch = (r, filter) =>
    r.namespace === "global" || filter.projectRoot === undefined || r.projectRoot === filter.projectRoot;
  return {
    globalStoragesRoot() {
      return "C:/mock/.dsh/storages";
    },
    projectStoragesRoot(root) {
      return String(root).replace(/[\\/]+$/, "") + "/.dsh/storages";
    },
    list(filter = {}) {
      return list.filter(
        (r) =>
          (filter.namespace === undefined || r.namespace === filter.namespace) &&
          (filter.status === undefined || r.status === filter.status) &&
          projectRootMatch(r, filter),
      );
    },
    search(query, filter = {}) {
      const q = String(query ?? "").toLowerCase();
      return list
        .filter(
          (r) =>
            (filter.namespace === undefined || r.namespace === filter.namespace) &&
            (filter.status === undefined || r.status === filter.status) &&
            projectRootMatch(r, filter) &&
            (r.content.toLowerCase().includes(q) || (r.keywords ?? []).some((k) => String(k).toLowerCase().includes(q))),
        )
        .map((r) => ({ record: r, score: 1 }));
    },
    remember(input) {
      const rec = {
        id: "new-" + (list.length + 1),
        namespace: input.namespace ?? "global",
        status: "pending",
        content: input.content,
        keywords: input.keywords ?? [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        projectRoot: input.projectRoot,
      };
      list.push(rec);
      return Promise.resolve(rec);
    },
    forget(id) {
      const before = list.length;
      list = list.filter((r) => r.id !== id);
      return Promise.resolve(list.length < before);
    },
    update(id, patch = {}) {
      const rec = list.find((r) => r.id === id);
      if (rec === undefined) return Promise.reject(new Error(`cannot update unknown memory '${id}'`));
      const contentChanged = typeof patch.content === "string" && patch.content !== rec.content;
      if (contentChanged) rec.content = patch.content;
      if (Array.isArray(patch.keywords)) rec.keywords = patch.keywords.map((k) => String(k).toLowerCase());
      if (typeof patch.name === "string") rec.name = patch.name.trim();
      if (contentChanged && (rec.status === "applied" || rec.status === "auto")) rec.status = "pending";
      rec.updatedAt = Date.now();
      return Promise.resolve(rec);
    },
    setStatus(id, status) {
      const rec = list.find((r) => r.id === id);
      if (rec !== undefined) rec.status = status;
      return Promise.resolve(rec);
    },
    setAutoLoad(id, autoLoad) {
      const rec = list.find((r) => r.id === id);
      if (rec !== undefined) { rec.autoLoad = autoLoad === true; rec.updatedAt = Date.now(); }
      return Promise.resolve(rec);
    },
    setName(id, name) {
      const rec = list.find((r) => r.id === id);
      if (rec !== undefined) { rec.name = String(name ?? "").trim(); rec.updatedAt = Date.now(); }
      return Promise.resolve(rec);
    },
  };
}

// ---- mock settings（与 kaz-mode 探针同构） ----
function makeSettings() {
  const userSections = new Map();
  const bases = new Map();
  const watches = new Map();
  const resolve = (ns) => ({ ...(bases.get(ns) ?? {}), ...(userSections.get(ns) ?? {}) });
  const fireWatch = (ns, next) => {
    for (const cb of watches.get(ns) ?? []) {
      try {
        cb(next, undefined);
      } catch (error) {
        console.log("[mock:watch-error]", error);
      }
    }
  };
  const commit = (ns) => fireWatch(ns, resolve(ns));
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
    getUser(ns) {
      return userSections.get(ns);
    },
  };
}

const now = Date.now();
const records = [
  {
    id: "m1",
    namespace: "global",
    status: "applied",
    name: "关于 Kaczev 的相处约定",
    content: "# 关于 Kaczev 的相处约定\n\n- 任何时候都可以重启 dsh；\n- 喜欢鲸鱼（蹭蹭）（戳戳）。",
    keywords: ["kaczev", "鲸鱼"],
    createdAt: now - 2000,
    updatedAt: now - 2000,
  },
  {
    id: "m2",
    namespace: "project",
    status: "pending",
    content: "项目约定：PowerShell 中文编码坑\n\n读写中文文件必须 -Encoding UTF8。",
    keywords: ["powershell", "编码"],
    createdAt: now - 1000,
    updatedAt: now - 1000,
    projectRoot: "C:/projA",
  },
  {
    id: "m3",
    namespace: "global",
    status: "applied",
    content: "没有标题的记忆内容，第一行就是很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长的正文。",
    keywords: ["long"],
    createdAt: now - 3000,
    updatedAt: now,
  },
  {
    id: "m4",
    namespace: "project",
    status: "applied",
    content: "# 另一个项目的约定\n\n仅属于 projB 的记忆。",
    keywords: ["projb"],
    createdAt: now - 500,
    updatedAt: now - 500,
    projectRoot: "C:/projB",
  },
];

const memory = makeMemoryEngine(records);
const settings = makeSettings();
const listeners = new Map();
const registeredTools = new Map();
let rpcHandler = null;
const openedFolders = [];

// mock agents：roots 返回顶层会话（最近的在尾部）；当前项目 = 最后一个带 cwd 的会话 = C:/projA。
const mockAgents = {
  roots: () => [{ session: { header: { cwd: "C:/projA" } } }],
  list: () => [],
  currentInitiator: () => undefined,
};

/** mock tools 服务：register 记录工具；schemas 返回当前已注册工具（含 memory_search）。 */
const toolsMock = {
  register(def) {
    registeredTools.set(def.name, def);
    return () => registeredTools.delete(def.name);
  },
  schemas() {
    return [...registeredTools.keys()].map((name) => ({ name, description: "", parameters: {} }));
  },
};

const base = {
  fiber: { state: 0 },
  logger: { info: () => {}, warn: (...a) => console.log("[mock:warn]", ...a), debug: () => {} },
  async plugin() {
    // 代替 MemoryEngine：直接提供 memory 服务
    return;
  },
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(fn);
    return () => {};
  },
  inject(deps, cb) {
    if (deps.includes("settings")) cb({ ...base, settings });
  },
  effect(fn) {
    fn();
    return () => {};
  },
  get(name) {
    if (name === "settings") return settings;
    if (name === "memory") return memory;
    if (name === "agents") return mockAgents;
    if (name === "tools") return toolsMock;
    if (name === "connection") {
      return {
        rpc: {
          handle: (channel, handler, _opts) => {
            rpcHandler = handler;
            return async () => {};
          },
        },
      };
    }
    return undefined;
  },
  systemPrompt: {
    section() {
      return () => {};
    },
  },
  tools: toolsMock,
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

// 两个「项目上下文」：模拟不同项目会话的工具调用（exec.agent.session.header.cwd）。
const execProjA = { agent: { session: { header: { cwd: "C:/projA" } } } };
const execProjB = { agent: { session: { header: { cwd: "C:/projB" } } } };

// 主 harness 用隔离的注入标记文件，避免读到真实 ~/.dsh/storages 里的持久化标记
// （否则 guidance 测试的固定 agent id 会被跨重启去重挡住）。
const mainStore = join(tmpdir(), "km-main-" + Date.now() + ".json");
await apply(base, { openFolder: (folder) => openedFolders.push(folder), autoInjectedStore: mainStore });
await settle();

// ① memory_list：只回 id/namespace/status/名称
const listTool = registeredTools.get("memory_list");
check("① memory_list 已注册", listTool !== undefined);
const listAll = await listTool.execute({}, execProjA);
check("① 项目 A 上下文下返回 3 条（全局 m1/m3 + 项目 A 的 m2）", Array.isArray(listAll) && listAll.length === 3);
check("① 返回项无 content 字段", listAll.every((item) => !("content" in item)));
check("① 返回项无 keywords 字段", listAll.every((item) => !("keywords" in item)));
check("① 返回项有 name 字段", listAll.every((item) => typeof item.name === "string"));
check("① 标题行优先（# 开头的标题作为名称）", listAll.some((item) => item.name === "关于 Kaczev 的相处约定"));
check("① 无标题取首行", listAll.some((item) => item.name === "项目约定：PowerShell 中文编码坑"));
check("① 超长名称截断到 140 字 + …", listAll.every((item) => item.name.length <= 141) && listAll.some((item) => item.name.endsWith("…")));
check("① namespace 过滤生效", (await listTool.execute({ namespace: "project" }, execProjA)).every((item) => item.namespace === "project"));
const projBList = await listTool.execute({}, execProjB);
check("① 项目 B 上下文只看到全局 + B 自己的项目记忆（m1/m3/m4）", Array.isArray(projBList) && projBList.length === 3 && projBList.some((item) => item.id === "m4") && !projBList.some((item) => item.id === "m2"));
check("① memory_list 默认不按 status/autoLoad 过滤（pending 与 applied 都返回，autoLoad 字段恒为 boolean）", listAll.some((item) => item.status === "pending") && listAll.some((item) => item.status === "applied") && listAll.every((item) => typeof item.autoLoad === "boolean"));
check("① memory_list status=applied 过滤只回 applied", (await listTool.execute({ status: "applied" }, execProjA)).every((item) => item.status === "applied"));

// ② memory_search：返回全文，且项目隔离生效
const searchTool = registeredTools.get("memory_search");
check("② memory_search 已注册", searchTool !== undefined);
const hits = await searchTool.execute({ query: "Kaczev" }, execProjA);
check("② search 命中 m1 且含完整 content", hits.length >= 1 && hits.some((hit) => hit.record.content.includes("任何时候都可以重启 dsh")));
const hitsB = await searchTool.execute({ query: "projb" }, execProjA);
check("② 在项目 A 搜不到项目 B 的记忆", hitsB.length === 0);
const hitsB2 = await searchTool.execute({ query: "projb" }, execProjB);
check("② 在项目 B 能搜到项目 B 的记忆", hitsB2.length >= 1 && hitsB2.some((hit) => hit.record.content.includes("仅属于 projB")));

// ③ 固定指引：首轮工具调用后以合成用户消息注入一次
// （settings.guidance 留空 → 按工具可用性动态拼装）
function guidanceTextOf(decision) {
  const messages = Array.isArray(decision?.messages) ? decision.messages : [];
  for (const message of messages) {
    const source = message !== null && typeof message === "object" ? message.source : undefined;
    const isGuidanceSource =
      source !== null &&
      typeof source === "object" &&
      source.kind === "plugin" &&
      source.plugin === "kaz-memory" &&
      source.form === "guidance";
    const blocks = message !== null && typeof message === "object" ? message.content : undefined;
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (
          block !== null &&
          typeof block === "object" &&
          block.type === "text" &&
          typeof block.text === "string" &&
          (isGuidanceSource || block.text.includes("[kaz-memory guidance]"))
        ) {
          return block.text;
        }
      }
    }
  }
  return "";
}
function hasGuidance(decision) {
  return guidanceTextOf(decision).length > 0;
}
function forgetGuidanceTextOf(decision) {
  const messages = Array.isArray(decision?.messages) ? decision.messages : [];
  for (const message of messages) {
    const source = message !== null && typeof message === "object" ? message.source : undefined;
    const isForgetSource =
      source !== null &&
      typeof source === "object" &&
      source.kind === "plugin" &&
      source.plugin === "kaz-memory" &&
      source.form === "forget-guidance";
    const blocks = message !== null && typeof message === "object" ? message.content : undefined;
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (
          block !== null &&
          typeof block === "object" &&
          block.type === "text" &&
          typeof block.text === "string" &&
          (isForgetSource || block.text.includes("We need to forget memories (memory_forget)"))
        ) {
          return block.text;
        }
      }
    }
  }
  return "";
}
function hasForgetGuidance(decision) {
  return forgetGuidanceTextOf(decision).length > 0;
}
async function runPreStep(agent, step = 2, messages = []) {
  const handlers = listeners.get("agent/pre-step") ?? [];
  let decision = { kind: "enter", messages };
  for (let i = handlers.length - 1; i >= 0; i -= 1) {
    decision = await handlers[i]({ step, agent }, async () => decision);
  }
  return decision;
}
const beforeToolAgent = { id: "guidance-before-tool", session: { header: { cwd: "C:/projA" }, events: [] } };
const afterToolAgent = { id: "guidance-after-tool", session: { header: { cwd: "C:/projA" }, events: [{ type: "tool/call", name: "pwsh" }] } };

const preBefore = await runPreStep(beforeToolAgent, 2);
check("③ 首次工具调用前不注入指引", hasGuidance(preBefore) === false);
const preAfter = await runPreStep(afterToolAgent, 2);
const guidanceText = guidanceTextOf(preAfter);
check("③ 首轮工具调用后注入指引", hasGuidance(preAfter) === true);
check("③ 指引使用 [标题] > < 消息格式", guidanceText.startsWith("[kaz-memory guidance]") && guidanceText.includes("\n>\n") && guidanceText.trimEnd().endsWith("<"));
check("③ 指引含主动行动式总述行（先查记忆 + 存重要事实）", guidanceText.includes("We need to search the memory (memory_search)") && guidanceText.includes("save important facts we learn (memory_save)"));
check(
  "③ 指引只含固定总述行（无四工具说明行）",
  !guidanceText.includes("memory_search：") &&
    !guidanceText.includes("memory_save：") &&
    !guidanceText.includes("memory_list：") &&
    !guidanceText.includes("memory_forget："),
);
const preAgain = await runPreStep(afterToolAgent, 3);
check("③ 同会话只注入一次", hasGuidance(preAgain) === false);

// ③d 首次 memory_search 后注入遗忘指引（固定指引仍照常，各自只一次）
const searchToolAgent = { id: "guidance-search-tool", session: { header: { cwd: "C:/projA" }, events: [{ type: "tool/call", name: "memory_search" }] } };
const preSearchTool = await runPreStep(searchToolAgent, 2);
check("③d 首次 memory_search 后注入遗忘指引", hasForgetGuidance(preSearchTool) === true);
check("③d 遗忘指引使用 [标题] > < 消息格式", forgetGuidanceTextOf(preSearchTool).startsWith("[kaz-memory guidance]") && forgetGuidanceTextOf(preSearchTool).includes("\n>\n") && forgetGuidanceTextOf(preSearchTool).trimEnd().endsWith("<"));
check("③d 遗忘指引包含 memory_forget 清理已完成任务", forgetGuidanceTextOf(preSearchTool).includes("We need to forget memories (memory_forget)"));
const preSearchToolAgain = await runPreStep(searchToolAgent, 3);
check("③d 同会话遗忘指引只注入一次", hasForgetGuidance(preSearchToolAgain) === false);
const searchDataAgent = { id: "guidance-search-data", session: { header: { cwd: "C:/projA" }, events: [{ type: "tool/call", data: { name: "memory_search" } }] } };
check("③d tool/call 的 data.name 也能触发遗忘指引", hasForgetGuidance(await runPreStep(searchDataAgent, 2)) === true);
const pwshAgentForget = { id: "guidance-pwsh-no-forget", session: { header: { cwd: "C:/projA" }, events: [{ type: "tool/call", name: "pwsh" }] } };
check("③d 非 memory_search 工具调用不触发遗忘指引", hasForgetGuidance(await runPreStep(pwshAgentForget, 2)) === false);

// ③b guidanceHead 覆盖总述行；guidanceSearch 等字段保留兼容但不再生效
await settings.update("kaz-memory", { guidanceHead: "Custom head line", guidanceSearch: "Custom search line" });
await settle();
const headAgent = { id: "guidance-head", session: { header: { cwd: "C:/projA" }, events: [{ type: "tool/call", name: "pwsh" }] } };
const gHead = guidanceTextOf(await runPreStep(headAgent, 2));
check("③b guidanceHead 覆盖总述行", gHead.includes("Custom head line") && !gHead.includes("search the memory (memory_search)"));
check("③b guidanceSearch 不再生效（工具细节并入工具描述）", !gHead.includes("Custom search line") && !gHead.includes("memory_search："));
check("③b 其余工具说明行不再发送", !gHead.includes("memory_save：") && !gHead.includes("memory_forget："));
await settings.update("kaz-memory", { guidanceHead: "", guidanceSearch: "" });
await settle();
const defaultAgent = { id: "guidance-default", session: { header: { cwd: "C:/projA" }, events: [{ type: "tool/call", name: "pwsh" }] } };
check("③b 清空后恢复内置默认", guidanceTextOf(await runPreStep(defaultAgent, 2)).includes("search the memory (memory_search)"));

// ③c 旧字段 guidance（整段覆盖）仍优先
await settings.update("kaz-memory", { guidance: "整段覆盖的指引文本" });
await settle();
const legacyAgent = { id: "guidance-legacy", session: { header: { cwd: "C:/projA" }, events: [{ type: "tool/call", name: "pwsh" }] } };
check("③c 旧字段 guidance 整段覆盖", guidanceTextOf(await runPreStep(legacyAgent, 2)) === "整段覆盖的指引文本");
await settings.update("kaz-memory", { guidance: "" });
await settle();
const dynamicAgent = { id: "guidance-dynamic", session: { header: { cwd: "C:/projA" }, events: [{ type: "tool/call", name: "pwsh" }] } };
check("③c 清空旧字段后恢复动态拼装", guidanceTextOf(await runPreStep(dynamicAgent, 2)).startsWith("[kaz-memory guidance]"));

// ③d2 guidanceForget 覆盖遗忘指引；旧字段 guidance 整段覆盖时不再追加
await settings.update("kaz-memory", { guidanceForget: "Custom forget line" });
await settle();
const customForgetAgent = { id: "guidance-forget-custom", session: { header: { cwd: "C:/projA" }, events: [{ type: "tool/call", name: "memory_search" }] } };
const gForget = forgetGuidanceTextOf(await runPreStep(customForgetAgent, 2));
check("③d2 guidanceForget 覆盖遗忘指引", gForget.includes("Custom forget line") && !gForget.includes("We need to forget memories (memory_forget)"));
await settings.update("kaz-memory", { guidanceForget: "" });
await settle();
await settings.update("kaz-memory", { guidance: "整段覆盖的指引文本" });
await settle();
const legacyForgetAgent = { id: "guidance-forget-legacy", session: { header: { cwd: "C:/projA" }, events: [{ type: "tool/call", name: "memory_search" }] } };
check("③d2 旧字段 guidance 整段覆盖时不追加遗忘指引", hasForgetGuidance(await runPreStep(legacyForgetAgent, 2)) === false);
await settings.update("kaz-memory", { guidance: "" });
await settle();

// ④ RPC list：只回元数据（含 name/autoLoad，无正文），按 updatedAt 倒序
check("④ RPC 通道已注册", typeof rpcHandler === "function");
const listRpc = await rpcHandler("list", { project: "C:/projA" });
check("④ RPC list 成功", listRpc !== null && listRpc.ok === true);
check("④ RPC list 返回 3 条且无正文与 keywords", listRpc.ok === true && Array.isArray(listRpc.value.memories) && listRpc.value.memories.length === 3 && listRpc.value.memories.every((item) => !("content" in item) && !("keywords" in item) && typeof item.name === "string" && typeof item.autoLoad === "boolean"));
check("④ RPC list 按 updatedAt 倒序（第一条是 m3）", listRpc.ok === true && listRpc.value.memories[0] !== undefined && listRpc.value.memories[0].id === "m3");
check("④ 项目记忆的列表项带所属项目路径", listRpc.ok === true && listRpc.value.memories.some((item) => item.id === "m2" && item.project === "C:/projA"));
check("④ 全局记忆的列表项 project 为空", listRpc.ok === true && listRpc.value.memories.every((item) => item.namespace !== "global" || item.project === ""));
check("④ 存储的 name 优先于正文推导", listRpc.ok === true && listRpc.value.memories.some((item) => item.id === "m1" && item.name === "关于 Kaczev 的相处约定"));

// ⑤ RPC open：按 id 取正文
const openRpc = await rpcHandler("open", { id: "m1", project: "C:/projA" });
check("⑤ RPC open 带回 m1 正文", openRpc !== null && openRpc.ok === true && openRpc.value.id === "m1" && openRpc.value.content.includes("任何时候都可以重启"));

// ⑥ memory_save(namespace=project) 写入调用者项目根
const saveTool = registeredTools.get("memory_save");
check("⑥ memory_save 已注册", saveTool !== undefined);
const saved = await saveTool.execute({ content: "临时探针记忆", namespace: "project" }, execProjB);
check("⑥ 保存到项目 B 成功且返回 record", saved !== undefined && saved.id !== undefined && saved.namespace === "project");
const afterSaveB = await listTool.execute({ namespace: "project" }, execProjB);
const afterSaveA = await listTool.execute({ namespace: "project" }, execProjA);
check("⑥ 项目 B 能看到新记忆、项目 A 看不到", afterSaveB.some((item) => item.id === saved.id) && !afterSaveA.some((item) => item.id === saved.id));

// ⑥b memory_update：可改正文/标签/标题；applied 正文变更降级 pending
const updateTool = registeredTools.get("memory_update");
check("⑥b memory_update 已注册", updateTool !== undefined);
const metaOnly = await updateTool.execute({ id: "m1", keywords: ["kaczev", "鲸鱼", "updated"], name: "新标题" }, execProjA);
check("⑥b 只改标签/标题时 applied 保持 applied", metaOnly !== undefined && metaOnly.status === "applied" && metaOnly.keywords.includes("updated") && metaOnly.name === "新标题");
const contentChange = await updateTool.execute({ id: "m1", content: "# 关于 Kaczev 的新内容\n\n更新后的正文。" }, execProjA);
check("⑥b 修改 applied 正文后降级为 pending", contentChange !== undefined && contentChange.status === "pending" && contentChange.content.includes("新内容"));
const unknownUpdate = await updateTool.execute({ id: "no-such-id" }, execProjA).then(() => null, () => "rejected");
check("⑥b 不存在的 id 会拒绝", unknownUpdate === "rejected");

// ⑦ RPC list paths + openFolder
check("⑦ RPC list paths.global 出全局记忆文件夹", listRpc.ok === true && listRpc.value.paths.global === "C:/mock/.dsh/storages");
check("⑦ RPC list paths.project 出当前项目记忆文件夹", listRpc.ok === true && typeof listRpc.value.paths.project === "string" && listRpc.value.paths.project.endsWith("/.dsh/storages") && listRpc.value.paths.project.includes("projA"));
const beforeOpenCount = openedFolders.length;
const openProj = await rpcHandler("openFolder", { target: "project", project: "C:/projA" });
check("⑦ RPC openFolder(project) 触发打开当前项目记忆文件夹", openProj !== null && openProj.ok === true && openedFolders.length === beforeOpenCount + 1 && openedFolders[openedFolders.length - 1].endsWith("/.dsh/storages"));
const openGlob = await rpcHandler("openFolder", { target: "global", project: "C:/projA" });
check("⑦ RPC openFolder(global) 触发打开全局记忆文件夹", openGlob !== null && openGlob.ok === true && openedFolders[openedFolders.length - 1] === "C:/mock/.dsh/storages");

// ⑧ RPC list 按 project 过滤 + paths 跟随
const listB = await rpcHandler("list", { project: "C:/projB" });
check("⑧ RPC list(project=projB) 显示 m4 不含 m2", listB !== null && listB.ok === true && listB.value.memories.some((item) => item.id === "m4") && !listB.value.memories.some((item) => item.id === "m2"));
check("⑧ RPC list paths.project 指向新项目文件夹", listB.ok === true && typeof listB.value.paths.project === "string" && listB.value.paths.project.includes("projB"));

// ⑧b RPC 状态 / 自动载入 / 改名 / 删除
const statusRpc = await rpcHandler("status", { id: "m2", status: "applied", project: "C:/projA" });
check("⑧b RPC status 把 m2 置为 applied", statusRpc !== null && statusRpc.ok === true && statusRpc.value.status === "applied");
const autoRpc = await rpcHandler("autoLoad", { id: "m2", autoLoad: true, project: "C:/projA" });
check("⑧b RPC autoLoad 把 m2 置为自动载入", autoRpc !== null && autoRpc.ok === true && autoRpc.value.autoLoad === true);
const listAfterAuto = await listTool.execute({}, execProjA);
check("⑧b memory_list 同时包含 autoLoad=true 与 autoLoad=false 的记忆", listAfterAuto.some((item) => item.id === "m2" && item.autoLoad === true) && listAfterAuto.some((item) => item.autoLoad === false));
const renameRpc = await rpcHandler("rename", { id: "m1", name: "关于 Kaczev 的新名字", project: "C:/projA" });
check("⑧b RPC rename 修改 m1 名称", renameRpc !== null && renameRpc.ok === true && renameRpc.value.name === "关于 Kaczev 的新名字");
const forgetRpc = await rpcHandler("forget", { id: "m3", project: "C:/projA" });
check("⑧b RPC forget 删除 m3", forgetRpc !== null && forgetRpc.ok === true && forgetRpc.value.deleted === true);

// ⑨ memory_forget 被禁用、但 memory_search 仍可用（注册 + schemas 都有）→ 仍发指引
const originalGet = base.get;
base.get = (name) => (name === "toolGrouping" ? { isRegistered: (n) => n !== "memory_forget" } : originalGet(name));
const forgetDisabledAgent = { id: "guidance-forget-disabled", session: { header: { cwd: "C:/projA" }, events: [{ type: "tool/call", name: "pwsh" }] } };
const g8 = guidanceTextOf(await runPreStep(forgetDisabledAgent, 2));
check("⑨ memory_forget 被禁用、memory_search 可用时仍发固定提示", g8.includes("We need to search the memory (memory_search)"));
check("⑨ 固定提示不含任何工具说明行", !g8.includes("memory_search：") && !g8.includes("memory_forget："));
const forgetDisabledSearchAgent = { id: "guidance-forget-disabled-search", session: { header: { cwd: "C:/projA" }, events: [{ type: "tool/call", name: "memory_search" }] } };
check("⑨ memory_forget 被禁用时不发遗忘指引", hasForgetGuidance(await runPreStep(forgetDisabledSearchAgent, 2)) === false);
base.get = originalGet;

// ⑨b memory_search 单独被禁用（其余记忆工具仍可用）→ 不发指引
base.get = (name) => (name === "toolGrouping" ? { isRegistered: (n) => n !== "memory_search" } : originalGet(name));
const searchDisabledAgent = { id: "guidance-search-disabled", session: { header: { cwd: "C:/projA" }, events: [{ type: "tool/call", name: "pwsh" }] } };
check("⑨b memory_search 单独被禁用时不发指引（其余记忆工具可用也不发）", hasGuidance(await runPreStep(searchDisabledAgent, 2)) === false);
base.get = originalGet;

// ⑨c memory_search 不在当前环境 schemas（注册了但工具面不含它，如作用域移除）
//     → 不发指引（当前环境确实调不到它）
base.get = (name) =>
  name === "tools"
    ? {
        register: toolsMock.register,
        schemas: () =>
          [...registeredTools.keys()]
            .filter((n) => n !== "memory_search")
            .map((name) => ({ name, description: "", parameters: {} })),
      }
    : originalGet(name);
const noSchemaAgent = { id: "guidance-no-schema", session: { header: { cwd: "C:/projA" }, events: [{ type: "tool/call", name: "pwsh" }] } };
check("⑨c memory_search 不在 schemas 时不发指引", hasGuidance(await runPreStep(noSchemaAgent, 2)) === false);
base.get = originalGet;

// ⑩ 四个工具全被禁用 → 不发指引
base.get = (name) => (name === "toolGrouping" ? { isRegistered: () => false } : originalGet(name));
const allDisabledAgent = { id: "guidance-all-disabled", session: { header: { cwd: "C:/projA" }, events: [{ type: "tool/call", name: "pwsh" }] } };
check("⑩ 四个工具全被禁用时不发指引", hasGuidance(await runPreStep(allDisabledAgent, 2)) === false);
base.get = originalGet;

// ⑪ 组装层兜底：无条件移除基础英文 tool:memory 指引段（全模式生效）
const asmListeners = listeners.get("system-prompt/assemble") ?? [];
const asm = {
  tools: [],
  sections: [
    { name: "tool:memory", text: "Use memory tools for cross-session preferences..." },
    { name: "tool:memory:kaz-memory", text: "[kaz-memory 记忆指引]\n>\nS\n<" },
    { name: "persona", text: "p" },
  ],
  contexts: [],
  variables: {},
};
let filtered = asm;
(async () => {
  for (const fn of asmListeners) filtered = await fn(filtered, {}, () => filtered);
})();
check("⑪ 基础英文 tool:memory 段被移除", !filtered.sections.some((s) => s.name === "tool:memory"));
check("⑪ 其它层提供的 tool:memory:kaz-memory 段不被兜底误删", filtered.sections.some((s) => s.name === "tool:memory:kaz-memory"));
check("⑪ 其它段不受影响", filtered.sections.some((s) => s.name === "persona"));

// ⑫ 自动载入：每会话一次 + 跨重启持久化（2026-08-19 修复）
{
  const autoRecords = [
    { id: "auto-1", namespace: "global", status: "applied", autoLoad: true, name: "Auto Mem", content: "# Auto Mem\n\nAuto content.", keywords: [], createdAt: 1, updatedAt: 1 },
  ];
  const storePath = join(tmpdir(), "km-auto-" + Date.now() + ".json");
  const agentA = { id: "session-test-A", session: { header: { cwd: "C:/projA" }, events: [{ type: "turn/start", data: { turn: 2 } }] } };
  const agentB = { id: "session-test-B", session: { header: { cwd: "C:/projA" }, events: [{ type: "turn/start", data: { turn: 2 } }] } };

  function makeAutoCtx(store, agentsList = []) {
    const engine = makeMemoryEngine(autoRecords);
    const lns = new Map();
    const c = {
      fiber: { state: 0 },
      logger: { info: () => {}, warn: (...a) => console.log("[mock:warn]", ...a), debug: () => {} },
      async plugin() { return; },
      on(event, fn) { if (!lns.has(event)) lns.set(event, []); lns.get(event).push(fn); return () => {}; },
      inject(deps, cb) { if (deps.includes("settings")) cb({ ...c, settings: makeSettings() }); },
      effect(fn) { fn(); return () => {}; },
      get(name) {
        if (name === "settings") return makeSettings();
        if (name === "memory") return engine;
        if (name === "agents") return { roots: () => agentsList, list: () => agentsList, currentInitiator: () => undefined };
        if (name === "tools") return { register: () => () => {}, schemas: () => [{ name: "memory_search" }] };
        return undefined;
      },
      systemPrompt: { section() { return () => {}; } },
      tools: { register: () => () => {} },
    };
    return { c, lns };
  }

  async function primeAndStep(h, agent) {
    const assemble = h.lns.get("system-prompt/assemble")[0];
    await assemble({ tools: [{ name: "memory_search" }], sections: [] }, { agent }, async () => ({}));
    const pre = h.lns.get("agent/pre-step")[0];
    return pre({ step: 1, agent }, async () => ({ kind: "enter", messages: [] }));
  }
  const hasRecall = (d) => (d?.messages ?? []).some((m) => JSON.stringify(m).includes("[kaz-memory Auto-Load]"));

  const h1 = makeAutoCtx(storePath);
  await apply(h1.c, { autoInjectedStore: storePath });
  const d1 = await primeAndStep(h1, agentA);
  check("⑫ 首次：memory_search 可用时注入自动载入消息", hasRecall(d1) === true);
  check("⑫ 标记文件已写入且含 agent id", existsSync(storePath) && readFileSync(storePath, "utf8").includes("session-test-A"));

  const d2 = await primeAndStep(h1, agentA);
  check("⑫ 同进程内第二次 pre-step 不重复注入", hasRecall(d2) === false);

  // 模拟重启：全新 ctx（新 WeakMap）+ 同一 store
  const h2 = makeAutoCtx(storePath);
  await apply(h2.c, { autoInjectedStore: storePath });
  const d3 = await primeAndStep(h2, agentA);
  check("⑫ 重启后同会话不再注入（持久化标记）", hasRecall(d3) === false);

  const d4 = await primeAndStep(h2, agentB);
  check("⑫ 重启后新会话仍正常注入一次", hasRecall(d4) === true);

  // ⑫b 加载时预标记现有 agent（thinking-anchor 同款）：新 agent 不在持久化
  // 标记里、但插件加载时已存在 → 预标记后不注入（覆盖重启场景的兜底）。
  const agentC = { id: "session-test-C", session: { header: { cwd: "C:/projA" }, events: [{ type: "turn/start", data: { turn: 2 } }] } };
  const h3 = makeAutoCtx(storePath, [agentC]);
  await apply(h3.c, { autoInjectedStore: storePath });
  const d5 = await primeAndStep(h3, agentC);
  check("⑫b 加载时预标记：现有会话即使不在标记文件中也不注入", hasRecall(d5) === false);

  rmSync(storePath, { force: true });
}

// ⑬ enabled 总开关（Kaz 面板开关）：关闭时指引为空、自动载入不注入；开启恢复
{
  // 指引门控（主 harness）
  await settings.update("kaz-memory", { enabled: false });
  await settle();
  const disabledGuidanceAgent = { id: "guidance-disabled", session: { header: { cwd: "C:/projA" }, events: [{ type: "tool/call", name: "pwsh" }] } };
  check("⑬ 关闭后记忆指引为空", hasGuidance(await runPreStep(disabledGuidanceAgent, 2)) === false);
  await settings.update("kaz-memory", { enabled: true });
  await settle();
  const enabledGuidanceAgent = { id: "guidance-enabled", session: { header: { cwd: "C:/projA" }, events: [{ type: "tool/call", name: "pwsh" }] } };
  check("⑬ 重新开启后指引恢复", guidanceTextOf(await runPreStep(enabledGuidanceAgent, 2)).startsWith("[kaz-memory guidance]"));

  // 自动载入门控（独立 harness，捕获注册期 settings 实例）
  const storeOff = join(tmpdir(), "km-off-" + Date.now() + ".json");
  const offRecords = [
    { id: "auto-off", namespace: "global", status: "applied", autoLoad: true, name: "Auto Mem", content: "# Auto Mem\n\nAuto content.", keywords: [], createdAt: 1, updatedAt: 1 },
  ];
  const engineOff = makeMemoryEngine(offRecords);
  const lnsOff = new Map();
  let regSettings = null;
  const cOff = {
    fiber: { state: 0 },
    logger: { info: () => {}, warn: (...a) => console.log("[mock:warn]", ...a), debug: () => {} },
    async plugin() { return; },
    on(event, fn) { if (!lnsOff.has(event)) lnsOff.set(event, []); lnsOff.get(event).push(fn); return () => {}; },
    inject(deps, cb) { if (deps.includes("settings")) { regSettings = makeSettings(); cb({ ...cOff, settings: regSettings }); } },
    effect(fn) { fn(); return () => {}; },
    get(name) {
      if (name === "settings") return regSettings;
      if (name === "memory") return engineOff;
      if (name === "agents") return { roots: () => [], list: () => [], currentInitiator: () => undefined };
      if (name === "tools") return { register: () => () => {}, schemas: () => [{ name: "memory_search" }] };
      return undefined;
    },
    systemPrompt: { section() { return () => {}; } },
    tools: { register: () => () => {} },
  };
  await apply(cOff, { autoInjectedStore: storeOff });
  await regSettings.update("kaz-memory", { enabled: false });
  await settle();
  const agentOff = { id: "session-off", session: { header: { cwd: "C:/projA" }, events: [{ type: "turn/start", data: { turn: 2 } }] } };
  const asmOff = lnsOff.get("system-prompt/assemble")[0];
  await asmOff({ tools: [{ name: "memory_search" }], sections: [] }, { agent: agentOff }, async () => ({}));
  const preOff = lnsOff.get("agent/pre-step")[0];
  const dOff = await preOff({ step: 1, agent: agentOff }, async () => ({ kind: "enter", messages: [] }));
  const hasRecallOff = (d) => (d?.messages ?? []).some((m) => JSON.stringify(m).includes("[kaz-memory Auto-Load]"));
  check("⑬ 关闭后自动载入不注入", hasRecallOff(dOff) === false);
  // 正向对照：重新开启后，新会话应正常注入一次
  await regSettings.update("kaz-memory", { enabled: true });
  await settle();
  const agentOn = { id: "session-on", session: { header: { cwd: "C:/projA" }, events: [{ type: "turn/start", data: { turn: 2 } }] } };
  await asmOff({ tools: [{ name: "memory_search" }], sections: [] }, { agent: agentOn }, async () => ({}));
  const dOn = await preOff({ step: 1, agent: agentOn }, async () => ({ kind: "enter", messages: [] }));
  check("⑬ 重新开启后自动载入恢复注入", hasRecallOff(dOn) === true);
  rmSync(storeOff, { force: true });
}

rmSync(mainStore, { force: true });

console.log(failures === 0 ? "\nPROBE OK" : `\nPROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
