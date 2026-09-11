// ka-whale-memory —— 独立记忆插件（BM25 检索 + 摘要 + RPC 通道）
// ===========================================================================
//   2026-08 升级：
//   * ctx.memory 引擎 + memory_save / memory_update / memory_list /
//     memory_search / memory_detail / memory_forget 六工具
//   * 每条记忆 JSON 持久化：id / name / keywords / summary / content /
//     created_at / updated_at（ISO 字符串）；旧记录（createdAt/updatedAt
//     毫秒数字、无 summary）读取时自动迁移，写回时落新格式
//   * memory_search = BM25 相关性排序（vendored okapibm25，离线可用；
//     k1/b 可在 settings.yaml 的 ka-whale-memory.bm25 段调整），返回
//     id/name/summary/keywords/score（不含 content），支持 limit/offset
//     分页与 namespace/status 过滤；评分异步分块计算不阻塞主线程
//   * memory_detail（新增）：按 id 分片读取完整 content
//   * memory_save 必填 name / keywords / content / summary（summary 由模型
//     在保存时提供，插件不生成）
//   * 所有工具描述与参数说明为英文（模型推理用英文）
//   * tool:memory 固定指引在首轮工具调用之后以上下文消息注入；第一次发送该
//     指引的轮次记为 n，从第 n+1 轮起的每个 turn 开头（step === 1）都会再次注入
//     同一固定指引；
//   * 每一轮对话第一次调用 memory_search 之后，都会注入一次遗忘指引
//     （memory_forget 清理已完成任务）；
//   * memory_list 只返回 id/name/updated_at/keywords，不返回正文——避免列表
//     调用把记忆灌进上下文；按时间倒序（updated_at，缺失回退 created_at，
//     最新在前），limit 控制返回条数；看全文用 memory_search 的 summary +
//     memory_detail。
//   * 项目记忆按项目文件夹隔离（2026-08-17）：project 记忆写在
//     <项目文件夹>/.dsh/storages/memory_project.json，项目根从 agent 会话 cwd
//     （exec.agent.session.header.cwd）解析——不再用 dsh 进程的 process.cwd()。
//   * 面板数据通道 = 专用 Connection RPC（/ka-whale-memory，loopback）：list / open /
//     rename / status / autoLoad / forget / openFolder / recentChanges。记忆数据（含 name）全部
//     存在 JSON 文件里，settings.yaml 不再承载任何记忆存储信息（2026-08-19）。
//   * 人工确认闸门已取消（2026-08）：模型 memory_save 直接写 applied，
//     旧 JSON 里的 pending/suggested 读取时自动归一为 applied；面板不再有待确认区。
// ===========================================================================

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { MemoryEngine } from "./engine.js";
import { effectiveToolWhitelist, TOOL_WHITELIST } from "../../kaz-shared/lib/tool-lists.js";

export { MemoryEngine, MemoryId } from "./engine.js";
export { bm25Scores, bm25ScoresAsync, tokenize } from "./bm25.js";

export const name = "ka-whale-memory";
export const inject = ["storage", "systemPrompt", "tools"];

/** 设置命名空间：~/.dsh/settings.yaml 中的 ka-whale-memory: 段（面板桥接镜像）。 */
const NAMESPACE = "ka-whale-memory";

/** memory_save / memory_update 的成功返回：只告诉模型操作成功与否，不回传记忆正文。 */
const SAVE_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    saved: { type: "boolean", required: true },
  },
};

const UPDATE_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    updated: { type: "boolean", required: true },
  },
};

/** memory_update.edits 的单项 schema：字面量查找替换 / 按锚点插入 / 首尾追加。 */
const EDIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: {
      type: "string",
      enum: ["replace", "insertAfter", "insertBefore", "append", "prepend"],
      required: true,
      description: "replace = 替换 find；insertAfter/insertBefore = 在 find 后/前插入 text；append/prepend = 在正文末尾/开头追加 text。",
    },
    find: { type: "string", description: "Literal text to locate (required for replace/insertAfter/insertBefore)." },
    replace: { type: "string", description: "Replacement text for replace; use \"\" to delete the matched text." },
    text: { type: "string", description: "Text to insert for insertAfter/insertBefore/append/prepend." },
    before: { type: "string", description: "Literal text that must immediately precede find (disambiguates matches)." },
    after: { type: "string", description: "Literal text that must immediately follow find (disambiguates matches)." },
    occurrence: {
      oneOf: [
        { type: "integer" },
        { type: "string", enum: ["all"] },
      ],
      description: '1-based occurrence, or "all"; omit to require a unique match.',
    },
  },
};

/** memory_search 的返回项：只给摘要信息（id/name/summary/keywords/score），不含 content。 */
const SEARCH_HIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", required: true },
    name: { type: "string", required: true },
    summary: { type: "string", required: true },
    keywords: { type: "array", required: true, items: { type: "string" } },
    score: { type: "number", required: true },
    has_paths: { type: "boolean", required: true },
  },
};

/** memory_paths 单项 schema（v0.9 R-B6-3）。 */
const PATH_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", required: true, description: "Absolute or project-relative file/folder path." },
    purpose: { type: "string", required: true, description: "Short purpose/role of this path." },
  },
};

/** memory_detail 的返回项（分片读取 + paths）。 */
const DETAIL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    content_preview: { type: "string", required: true },
    total_length: { type: "number", required: true },
    has_more: { type: "boolean", required: true },
    paths: { type: "array", items: PATH_ITEM_SCHEMA, required: true, description: "Stored file paths ([] when the memory has none); path existence is not checked." },
  },
};

/** memory_list 的返回项：只给 id / name / updated_at / keywords，不含正文。 */
const LIST_RECORD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", required: true },
    name: { type: "string", required: true },
    updated_at: { type: "string", required: true },
    keywords: { type: "array", items: { type: "string" }, required: true },
  },
};

/** 取记忆名称：优先标题行（# 开头），否则首非空行；超长截断。 */
function nameOf(content, max = 140) {
  if (typeof content !== "string") return "";
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return "";
  const title = lines.find((line) => line.startsWith("#"));
  const head = (title ?? lines[0]).replace(/^#+\s*/, "").trim();
  return head.length > max ? head.slice(0, max) + "…" : head;
}

/** memory_list 项：只给名称，不给正文。 */
function nameValue(record) {
  return {
    id: String(record.id),
    namespace: record.namespace,
    status: record.status,
    autoLoad: record.autoLoad === true,
    name: typeof record.name === "string" && record.name.length > 0 ? record.name : nameOf(record.content),
  };
}

/** memory_list 工具项：id / name / updated_at / keywords（不含正文与 namespace/status/autoLoad）。 */
function listValue(record) {
  return {
    id: String(record.id),
    name: typeof record.name === "string" && record.name.length > 0 ? record.name : nameOf(record.content),
    updated_at: typeof record.updated_at === "string" ? record.updated_at : "",
    keywords: Array.isArray(record.keywords) ? record.keywords : [],
  };
}

/** 面板列表项：memory_list 字段 + summary + ISO 时间戳 + 所属项目路径（仅 project 记忆）。 */
function metaValue(record) {
  return {
    ...nameValue(record),
    autoLoad: record.autoLoad === true,
    summary: typeof record.summary === "string" ? record.summary : "",
    created_at: record.created_at,
    updated_at: record.updated_at,
    project: record.namespace === "project" && typeof record.projectRoot === "string" ? record.projectRoot : "",
  };
}

/** memory_search 命中项：只给摘要信息，不给 content。 */
function searchHitValue(hit) {
  return {
    id: String(hit.record.id),
    name: typeof hit.record.name === "string" && hit.record.name.length > 0 ? hit.record.name : nameOf(hit.record.content),
    summary: typeof hit.record.summary === "string" ? hit.record.summary : "",
    keywords: Array.isArray(hit.record.keywords) ? hit.record.keywords : [],
    score: Number(hit.score),
    has_paths: Array.isArray(hit.record.paths) && hit.record.paths.length > 0,
  };
}

/** memory_detail 返回：从 offset 起截取 limit 个字符；offset 超出正文时返回空串并提示。 */
function detailValue(record, offset, limit) {
  const content = typeof record.content === "string" ? record.content : "";
  const start = Number.isFinite(Number(offset)) ? Math.max(0, Math.trunc(Number(offset))) : 0;
  const len = Number.isFinite(Number(limit)) ? Math.min(5000, Math.max(0, Math.trunc(Number(limit)))) : 500;
  const preview = start >= content.length ? "" : content.slice(start, start + len);
  return {
    content_preview: preview,
    total_length: content.length,
    has_more: start + len < content.length,
    paths: Array.isArray(record.paths) ? record.paths : [],
  };
}

/** 整数钳制：非法值回退 fallback，超出 [min, max] 截断。 */
function clampInt(value, fallback, min, max) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 时间戳数值：ISO 字符串 → 毫秒；缺失/非法按 0（memory_list 排序用，最新在前）。 */
function timeMs(value) {
  if (typeof value === "string" && value.length > 0) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

/** 从 settings 段读取 BM25 参数（ka-whale-memory.bm25.k1 / b），缺省 1.2 / 0.75。 */
function bm25Of(current) {
  const section =
    current !== null && typeof current === "object" && current.bm25 !== null && typeof current.bm25 === "object"
      ? current.bm25
      : {};
  const k1 = typeof section.k1 === "number" && Number.isFinite(section.k1) ? section.k1 : 1.2;
  const b = typeof section.b === "number" && Number.isFinite(section.b) ? section.b : 0.75;
  return { k1, b };
}

function renderJson(value) {
  return [{ type: "text", text: JSON.stringify(value) }];
}

function present(title, kind, rawInput) {
  return { card: "generic", title, kind, ...(rawInput === undefined ? {} : { rawInput }) };
}


/** 判断某个记忆工具当前是否可用：
 *  1) 注册检查：plugin-filter / 组合移除会让工具不在注册表（工具面过滤后也不可见）；
 *  2) Kaz 工具面检查：kaz-mode.enabled=true 时，工具必须在 kaz-shared 的
 *     有效白名单（settings.toolWhitelist，白名单是唯一闸门——含全部记忆工具；
 *     本插件关闭时工具已注销，注册检查先行拦截）里才可见。
 *  读不到的服务 / 设置一律按"不受限制"处理。 */
function toolAvailable(name, grouping, kazSettings) {
  const groupingOk = grouping !== undefined && grouping !== null && typeof grouping.isRegistered === "function";
  if (groupingOk && grouping.isRegistered(name) !== true) return false;
  if (kazSettings !== undefined && kazSettings !== null && typeof kazSettings === "object" && kazSettings.enabled === true) {
    const whitelist = effectiveToolWhitelist(
      Array.isArray(kazSettings.toolWhitelist) ? kazSettings.toolWhitelist : TOOL_WHITELIST,
    );
    if (!whitelist.includes(name)) return false;
  }
  return true;
}

const SETTINGS_SCHEMA = z.object({
  /** 总开关：关闭时完全注销六工具（热重载）；Kaz 模式下会话级可见性由 kaz-mode 按 agent 会话过滤。 */
  enabled: z.boolean().default(true),
  /** BM25 检索参数（memory_search 相关性评分用）：改 settings.yaml 生效，无需 UI。 */
  bm25: z
    .object({
      k1: z.number().default(1.2),
      b: z.number().default(0.75),
    })
    .default({ k1: 1.2, b: 0.75 }),
  /** 方向1 巩固/淘汰参数（可由 Kaczev 调整）：C=每命名空间容量，Nmin=最低使用次数，tau=升级阈值，idle_window=闲置天数。 */
  lifecycle: z
    .object({
      C: z.number().min(1).default(64),
      Nmin: z.number().min(1).default(2),
      tau: z.number().min(0).max(1).default(0.15),
      idleWindowDays: z.number().min(1).default(30),
    })
    .default({ C: 64, Nmin: 2, tau: 0.15, idleWindowDays: 30 }),
});

/** 本插件 settings.yaml 段的默认配置（镜像作者 settings.yaml；仅含非运行时字段）。 */
export const DEFAULT_SECTION = {
  bm25: { k1: 1.2, b: 0.75 },
  lifecycle: { C: 64, Nmin: 2, tau: 0.15, idleWindowDays: 30 },
};
// ---------------------------------------------------------------------------
// settings 自愈：settings.yaml 中本插件段缺失时自动补齐默认值。
// 只写"缺失的键"，保留用户已有配置；settings.yaml 文件不存在时由 settings
// 服务在首次写入时自动创建（DSH_HOME 下的 settings.yaml）。
// ---------------------------------------------------------------------------

/** 卸载判定：插件 fiber 正在拆除时不再回写 source（与 dsh-settings 内部一致）。 */
function isUnloading(ctx) {
  const state = ctx.fiber.state;
  return state === 5 || state === 4; // FiberState.Unloading / Disposed
}

/**
 * 注册 settings 命名空间（composition entry 作 base、用户层优先、热重载），
 * 并在用户段缺失时只写缺失的键补齐默认值。
 */
function installSettingsWithDefaults(ctx, ns, schema, entry, defaults, hooks) {
  ctx.inject(["settings"], (sctx) => {
    const scope = sctx.settings.register(ns, schema, { base: entry });
    hooks.setSource(() => scope.get());
    sctx.effect(() => () => {
      if (isUnloading(ctx)) return;
      hooks.setSource(() => entry);
      hooks.onChange();
    });
    hooks.onChange();
    scope.watch(() => {
      if (isUnloading(ctx)) return;
      hooks.onChange();
    });
    // 纯方案 A（2026-08-21）：不再自愈写 settings.yaml——生效配置由
    // kazMode.pluginConfig 提供，settings.yaml 插件段仅作 standalone 兜底。
  });
}

/**
 * 检查 settings.yaml 用户段：缺失的默认键用默认值补齐（合并写入，保留已有键）。
 * 返回写入的 patch；无需写入或失败时返回 null。独立导出便于测试。
 */
export function ensureSettingsDefaults(settings, ns, defaults, logger) {
  try {
    const descriptor = settings.describe().find((item) => item.ns === ns);
    const user =
      descriptor !== undefined && descriptor.user !== null && typeof descriptor.user === "object"
        ? descriptor.user
        : {};
    const patch = {};
    for (const [key, value] of Object.entries(defaults)) {
      if (!Object.prototype.hasOwnProperty.call(user, key)) patch[key] = value;
    }
    if (Object.keys(patch).length === 0) return null;
    const write = settings.update(ns, patch);
    if (write !== null && typeof write.then === "function") {
      void write.then(
        () => {
          logger?.info?.("[ns] settings.yaml config section auto-filled missing keys: " + Object.keys(patch).join(", "));
        },
        (error) => {
          logger?.warn?.("[ns] auto-fill defaults failed: " + (error instanceof Error ? error.message : String(error)));
        },
      );
    }
    return patch;
  } catch (error) {
    logger?.warn?.("[ns] check defaults failed: " + (error instanceof Error ? error.message : String(error)));
    return null;
  }
}


export async function apply(ctx, config = {}) {
  await ctx.plugin(MemoryEngine, config);
  const memory = ctx.get("memory");
  if (memory === undefined) throw new Error("memory engine failed to register");

  // ---- 设置（bm25 / lifecycle 参数；记忆数据不走 settings） ----
  // settings 服务惰性获取：apply 阶段可能尚未挂载（启动竞态），所有读写都在
  // 调用时解析；注册内部用 inject 等待服务，注册不受影响。
  const getSettings = () => ctx.get("settings");
  let source = () => ({
    enabled: true,
  });

  // ---- 项目根解析 ----
  // 项目记忆归属「项目文件夹」：优先显式配置 projectRoot，其次当前工具调用
  // 的 agent 会话 cwd（exec.agent.session.header.cwd）；agent 缺失时兜底
  // process.cwd()（仅工具路径；镜像不用——见 currentProjectRoot 的注释）。
  function cwdOf(agent) {
    return agent &&
      agent.session &&
      agent.session.header &&
      typeof agent.session.header.cwd === "string"
      ? agent.session.header.cwd
      : undefined;
  }
  function projectRootOf(exec) {
    if (typeof config.projectRoot === "string" && config.projectRoot.length > 0) return config.projectRoot;
    return cwdOf(exec && exec.agent) ?? process.cwd();
  }
  /** 当前项目根（RPC 兜底用）：配置 > 最近创建/恢复的会话 cwd > 最后已知项目根 >
   *  undefined（绝不退回 process.cwd()）。面板经 RPC 显式上报当前会话 cwd，
   *  这里只是无上报时的兜底推断。 */
  let lastProjectRoot;
  function currentProjectRoot() {
    if (typeof config.projectRoot === "string" && config.projectRoot.length > 0) return config.projectRoot;
    try {
      const agents = ctx.get("agents");
      if (agents !== null && agents !== undefined) {
        let candidates = [];
        if (typeof agents.roots === "function") {
          const roots = agents.roots();
          if (Array.isArray(roots) && roots.length > 0) candidates = roots;
        }
        if (candidates.length === 0 && typeof agents.list === "function") {
          const all = agents.list();
          if (Array.isArray(all)) candidates = all;
        }
        for (let index = candidates.length - 1; index >= 0; index -= 1) {
          const cwd = cwdOf(candidates[index]);
          if (cwd !== undefined) {
            lastProjectRoot = cwd;
            return cwd;
          }
        }
        if (typeof agents.currentInitiator === "function") {
          const cwd = cwdOf(agents.currentInitiator());
          if (cwd !== undefined) {
            lastProjectRoot = cwd;
            return cwd;
          }
        }
      }
    } catch (error) {
      ctx.logger.warn(`[ka-whale-memory] 解析当前项目根失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return lastProjectRoot;
  }


  // ---- 面板「记忆保存/更新」事件队列 ----
  // 只在进程内保留最近 50 条 remembered/updated 事件，供客户端 recentChanges
  // 增量拉取；改名 / 自动载入 / 状态 / 删除等不进入队列，避免面板误报「更新」。
  const recentChanges = [];
  const RECENT_CHANGES_LIMIT = 50;
  let recentChangeSeq = 0;
  ctx.on("memory/changed", (payload) => {
    if (payload === null || typeof payload !== "object") return;
    const operation = payload.operation;
    if (operation !== "remembered" && operation !== "updated") return;
    const record = payload.record;
    if (record === null || record === undefined || typeof record !== "object") return;
    const title =
      typeof record.name === "string" && record.name.trim().length > 0
        ? record.name.trim()
        : nameOf(typeof record.content === "string" ? record.content : "");
    recentChangeSeq += 1;
    recentChanges.push({
      seq: recentChangeSeq,
      operation,
      id: String(record.id),
      title,
      namespace: record.namespace === "project" ? "project" : "global",
      projectRoot:
        typeof payload.projectRoot === "string"
          ? payload.projectRoot
          : record.namespace === "project"
            ? record.projectRoot
            : undefined,
      ts: Date.now(),
    });
    if (recentChanges.length > RECENT_CHANGES_LIMIT) {
      recentChanges.splice(0, recentChanges.length - RECENT_CHANGES_LIMIT);
    }
  });

  // ---- 面板数据通道（Connection RPC，不经过 settings.yaml） ----
  // 客户端经 createWebConnectionRpc() 调用 /ka-whale-memory 通道；记忆数据（含 name）
  // 全部存在 JSON 文件里，settings.yaml 不再承载任何记忆存储信息。
  function rootOf(payload) {
    if (payload !== null && typeof payload === "object" && typeof payload.project === "string" && payload.project.length > 0) {
      return payload.project;
    }
    return currentProjectRoot() ?? process.cwd();
  }
  function rpcFail(message) {
    return { ok: false, error: { code: "internal", message: String(message), details: {} } };
  }
  async function rpcFindRecord(id, project) {
    const records = await memory.list({ projectRoot: project });
    return records.find((item) => String(item.id) === String(id));
  }
  const rpcHandler = async (endpoint, payload, _signal) => {
    try {
      if (endpoint === "list") {
        const project = rootOf(payload);
        const records = await memory.list({ projectRoot: project });
        return {
          ok: true,
          value: {
            memories: records.map(metaValue).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))),
            paths: {
              global: memory.globalStoragesRoot(),
              project: memory.projectStoragesRoot(project),
            },
          },
        };
      }
      if (endpoint === "recentChanges") {
        const project = rootOf(payload);
        const after = Number.isFinite(Number(payload?.after)) ? Math.max(0, Math.trunc(Number(payload?.after))) : 0;
        const changes = recentChanges
          .filter(
            (change) =>
              change.seq > after &&
              (change.namespace !== "project" || change.projectRoot === undefined || change.projectRoot === project),
          )
          .slice(0, 20);
        const nextSeq = changes.length > 0 ? changes[changes.length - 1].seq : after;
        return { ok: true, value: { changes, nextSeq } };
      }
      if (endpoint === "open") {
        const project = rootOf(payload);
        const record = await rpcFindRecord(payload?.id, project);
        if (record === undefined) return rpcFail(`memory '${String(payload?.id)}' not found`);
        return {
          ok: true,
          value: {
            id: String(record.id),
            name: typeof record.name === "string" && record.name.length > 0 ? record.name : nameOf(record.content),
            content: record.content,
          },
        };
      }
      if (endpoint === "rename") {
        const record = await memory.setName(String(payload?.id), String(payload?.name ?? ""));
        return { ok: true, value: metaValue(record) };
      }
      if (endpoint === "status") {
        const status =
          payload?.status === "ignored" || payload?.status === "suggest" ? "ignored" : "applied";
        const record = await memory.setStatus(String(payload?.id), status);
        return { ok: true, value: metaValue(record) };
      }
      if (endpoint === "forget") {
        const deleted = await memory.forget(String(payload?.id));
        return { ok: true, value: { deleted } };
      }
      if (endpoint === "openFolder") {
        const target = payload?.target === "project" ? "project" : "global";
        const project = rootOf(payload);
        const folder = target === "project" ? memory.projectStoragesRoot(project) : memory.globalStoragesRoot();
        openFolderAction(folder);
        return { ok: true, value: { opened: true } };
      }
      return rpcFail(`unknown endpoint '${String(endpoint)}'`);
    } catch (error) {
      ctx.logger.warn(`[ka-whale-memory] RPC ${String(endpoint)} 失败：${error instanceof Error ? error.message : String(error)}`);
      return rpcFail(error instanceof Error ? error.message : String(error));
    }
  };
  // 预设化 v1（无客户端面板）：不再注册 /ka-whale-memory RPC 通道。
  // 0.1.5 的 connection.rpc.handle 会经调用方 ctx 访问 webServer（本插件未注入该服务），
  // 注册即抛 "cannot get property \"webServer\" without inject"；面板已删，无需该通道。

  // ---- 组装层兜底：无条件移除基础英文记忆指引（tool:memory）----
  // ka-whale-memory 不再注册 tool:memory:ka-whale-memory 系统提示段；固定指引改为首轮
  // 工具调用后以上下文消息注入。这里保留全模式兜底：任何会话、任何模式都
  // 不再注入基础英文记忆指引（tool:memory）。
  ctx.on("system-prompt/assemble", async (assembly, context, next) => {
    if (assembly !== null && typeof assembly === "object" && Array.isArray(assembly.sections)) {
      assembly.sections = assembly.sections.filter(
        (section) => !(section !== null && typeof section === "object" && section.name === "tool:memory"),
      );
    }
    return next();
  });

  // ---- 六工具（与 @max-null/dsh-memory 同名同 schema 同行为；memory_update /
  // memory_detail 为扩展）。描述与参数说明为英文（模型推理用英文）。
  // 注册跟随 ka-whale-memory.enabled（2026-08-21）：关闭 = 六工具完全注销（不只是
  // 移出 Kaz 工具面），热重载；任何模式下都不再出现在工具列表里。----
  const toolDefs = [
  defineTool({
      name: "memory_save",
      description:
        'Save one cross-session memory. It takes effect immediately (status is "applied") — no manual confirmation is needed. Provide a short name (title), anchor keywords, the full content, and a one-sentence summary (~100 chars) that you write yourself when saving (the plugin does not generate it). You may optionally add structured metadata: type (e.g. success_pattern/error_pattern/insight), evidence (concrete source/probe/file/code/user feedback; required to set confidence high), confidence (unknown/low/medium/high; default unknown unless evidence is concrete). New memories start lifecycle_status=CANDIDATE. These metadata fields are independent of BM25 — search documents remain content + summary + keywords. You may optionally add up to 8 paths [{path,purpose}]; paths are not included in memory_search/memory_list result views; use memory_detail to read full content and paths on demand. File existence is not checked. namespace=project stores it in the current project folder (<project>/.dsh/storages/memory_project.json). On success returns { saved: true } only (no memory content).',
      parameters: {
        name: { type: "string", required: true, description: "Short title for the memory (<= 80 chars, ideally 5–10 words)." },
        keywords: { type: "array", items: { type: "string" }, required: true, description: "Anchor keywords used by memory_search (BM25)." },
        content: { type: "string", required: true, description: "Full memory content (plain text)." },
        summary: { type: "string", required: true, description: "One-sentence summary (~100 chars), written by you when saving; it is the only summary text shown in memory_search results." },
        type: { type: "string", description: "Structured memory type (e.g. success_pattern, error_pattern, insight, design, reference); optional." },
        evidence: { type: "string", description: "Concrete evidence supporting this memory (probe/file/code/user feedback); optional, but must be non-empty to set confidence=high." },
        confidence: { type: "string", enum: ["unknown", "low", "medium", "high"], description: "Confidence level (default unknown); never set high without concrete evidence." },
        paths: { type: "array", items: PATH_ITEM_SCHEMA, description: "Optional file/folder paths [{path,purpose}] up to 8; stored with the memory. Path text is not included in memory_search/memory_list result views; memory_detail returns them on demand. File existence is not checked." },
        namespace: { type: "string", enum: ["global", "project"], description: "Scope: global (harness home) / project (current project folder); default global." },
      },
      output: {
        schema: SAVE_RESULT_SCHEMA,
        render: (_args, value) => renderJson(value),
      },
      execute(args, exec) {
        const name = typeof args.name === "string" ? args.name.trim() : "";
        const summary = typeof args.summary === "string" ? args.summary.trim() : "";
        const content = typeof args.content === "string" ? args.content : "";
        if (name.length === 0) return Promise.reject(new Error("memory_save: name must not be empty"));
        if (summary.length === 0) return Promise.reject(new Error("memory_save: summary must not be empty"));
        if (content.length === 0) return Promise.reject(new Error("memory_save: content must not be empty"));
        if (!Array.isArray(args.keywords)) return Promise.reject(new Error("memory_save: keywords must be an array"));
        return Promise.resolve(
          memory.remember({
            name,
            keywords: args.keywords,
            content,
            summary,
            ...(args.type === undefined ? {} : { type: args.type }),
            ...(args.evidence === undefined ? {} : { evidence: args.evidence }),
            ...(args.confidence === undefined ? {} : { confidence: args.confidence }),
            ...(args.paths === undefined ? {} : { paths: args.paths }),
            ...(args.namespace === undefined ? {} : { namespace: args.namespace }),
            projectRoot: projectRootOf(exec),
          }),
        ).then(() => ({ saved: true }));
      },
      presentCall: (args) => present("保存记忆", "other", args.content),
    }),

  defineTool({
      name: "memory_update",
      description:
        'Update an existing memory by id. You can change name, summary, keywords, content, and the optional structured metadata type/evidence/confidence. Omit name to keep the current title (titles are never auto-derived). For keywords, pass keywordsAdd/keywordsRemove to add/remove items, or keywords to replace the whole list (do not combine). For content, pass content to replace the whole body, or edits for precise literal edits: replace/insertAfter/insertBefore/append/prepend. Use before/after context to make a match unique; if it is still ambiguous, add occurrence (1-based) or "all". Changing content keeps the memory applied (no re-confirmation). These metadata fields are independent of BM25 — search documents remain content + summary + keywords. You may also replace paths with up to 8 [{path,purpose}] (pass [] to clear); paths are not included in memory_search/memory_list result views; use memory_detail to read full content and paths on demand. File existence is not checked. On success returns { updated: true } only (no memory content).',
      parameters: {
        id: { type: "string", required: true, description: "Memory id (from memory_list or memory_search)." },
        name: { type: "string", description: "Short title for the memory (<= 80 chars, ideally 5–10 words)." },
        keywords: { type: "array", items: { type: "string" }, description: "Anchor keywords used by memory_search (BM25)." },
        keywordsAdd: { type: "array", items: { type: "string" }, description: "Add anchor keywords (case-insensitive, deduplicated; missing/duplicate items are no-ops)." },
        keywordsRemove: { type: "array", items: { type: "string" }, description: "Remove anchor keywords (case-insensitive; missing keywords are no-ops)." },
        summary: { type: "string", description: "One-sentence summary (~100 chars), written by you when saving; it is the only summary text shown in memory_search results." },
        type: { type: "string", description: "Structured memory type (e.g. success_pattern, error_pattern, insight, design, reference); optional." },
        evidence: { type: "string", description: "Concrete evidence supporting this memory (probe/file/code/user feedback); optional, but must be non-empty to set confidence=high." },
        confidence: { type: "string", enum: ["unknown", "low", "medium", "high"], description: "Confidence level (default unknown); never set high without concrete evidence." },
        paths: { type: "array", items: PATH_ITEM_SCHEMA, description: "Optional file/folder paths [{path,purpose}] up to 8; replaces existing paths when provided (pass [] to clear). Path text is not included in memory_search/memory_list result views; memory_detail returns them on demand. File existence is not checked." },
        content: { type: "string", description: "Full memory content (plain text)." },
        edits: { type: "array", items: EDIT_SCHEMA, description: "Precise literal content edits; applied sequentially and atomically." },
      },
      output: {
        schema: UPDATE_RESULT_SCHEMA,
        render: (_args, value) => renderJson(value),
      },
      execute(args, _exec) {
        const patch = {
          ...(args.name === undefined ? {} : { name: args.name }),
          ...(args.summary === undefined ? {} : { summary: args.summary }),
          ...(args.type === undefined ? {} : { type: args.type }),
          ...(args.evidence === undefined ? {} : { evidence: args.evidence }),
          ...(args.confidence === undefined ? {} : { confidence: args.confidence }),
          ...(args.paths === undefined ? {} : { paths: args.paths }),
          ...(args.keywords === undefined ? {} : { keywords: args.keywords }),
          ...(args.keywordsAdd === undefined ? {} : { keywordsAdd: args.keywordsAdd }),
          ...(args.keywordsRemove === undefined ? {} : { keywordsRemove: args.keywordsRemove }),
          ...(args.content === undefined ? {} : { content: args.content }),
          ...(args.edits === undefined ? {} : { edits: args.edits }),
        };
        return Promise.resolve(
          memory.update(String(args.id), patch),
        ).then(() => ({ updated: true }));
      },
      presentCall: (args) => present("更新记忆", "other", args.id),
    }),

  defineTool({
      name: "memory_list",
      description:
        "List memories sorted by time, newest first (by updated_at, falling back to created_at), limited to limit entries. Each entry contains only id/name/updated_at/keywords (name = title line or first line, truncated to 140 chars) — no content, no namespace/status/autoLoad, no paths text. Use memory_search for relevance hits or memory_detail to read one memory's full content and paths.",
      parameters: {
        namespace: { type: "string", enum: ["global", "project"], description: "Restrict to a namespace; project = current project folder." },
        status: { type: "string", enum: ["ignored", "applied"], description: "Restrict to a status." },
        limit: { type: "number", description: "Max memories to return (default 10, max 100)." },
      },
      output: {
        schema: { type: "array", items: LIST_RECORD_SCHEMA },
        render: (_args, value) => renderJson(value),
      },
      execute(args, exec) {
        const limit = clampInt(args.limit, 10, 1, 100);
        return Promise.resolve(
          memory.list({
            ...(args.namespace === undefined ? {} : { namespace: args.namespace }),
            ...(args.status === undefined ? {} : { status: args.status }),
            projectRoot: projectRootOf(exec),
          }),
        ).then((records) =>
          records
            .slice()
            .sort(
              (left, right) =>
                timeMs(right.updated_at ?? right.created_at) - timeMs(left.updated_at ?? left.created_at),
            )
            .slice(0, limit)
            .map(listValue),
        );
      },
      presentCall: () => present("列出记忆", "read"),
    }),

  defineTool({
      name: "memory_search",
      description:
        "Search memories by BM25 relevance and return summaries sorted by score (descending), with pagination. Each hit contains id/name/summary/keywords/score/has_paths — content and paths text are NOT included in this result view; use memory_detail to read the full content and stored paths of a hit. has_paths is a boolean marker only. Scores are computed over content (primary) + summary + keywords with the tunable k1/b parameters from the ka-whale-memory.bm25 settings section. DEPRECATED memories are excluded by default. Returns an empty array when nothing matches; errors when the query is empty.",
      parameters: {
        query: { type: "string", required: true, description: "Search query (BM25 over content + summary + keywords)." },
        limit: { type: "number", description: "Max hits to return (default 10, max 100)." },
        offset: { type: "number", description: "Hits to skip for pagination (default 0, max 1000)." },
        namespace: { type: "string", enum: ["global", "project"], description: "Restrict to a namespace; project = current project folder." },
        status: { type: "string", enum: ["ignored", "applied"], description: "Restrict to a status." },
      },
      output: {
        schema: { type: "array", items: SEARCH_HIT_SCHEMA },
        render: (_args, value) => renderJson(value),
      },
      execute(args, exec) {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (query.length === 0) {
          return Promise.reject(new Error("memory_search: query must not be empty"));
        }
        const bm25 = bm25Of(source());
        const limit = clampInt(args.limit, 10, 1, 100);
        const offset = clampInt(args.offset, 0, 0, 1000);
        return Promise.resolve(
          memory.search(
            query,
            {
              ...(args.namespace === undefined ? {} : { namespace: args.namespace }),
              ...(args.status === undefined ? {} : { status: args.status }),
              projectRoot: projectRootOf(exec),
            },
            bm25,
          ),
        ).then((hits) => hits.slice(offset, offset + limit).map(searchHitValue));
      },
      presentCall: (args) => present("搜索记忆", "read", args.query),
    }),

  defineTool({
      name: "memory_detail",
      description:
        "Read the full content of a single memory by id, with chunked reading. Returns content_preview (limit chars starting at offset), total_length, has_more, and paths (stored [{path,purpose}] or []). Errors if the id does not exist; if offset is beyond the content length, content_preview is an empty string (total_length tells you the real size) and has_more is false. Path existence is not checked. Use memory_search or memory_list first to obtain ids.",
      parameters: {
        id: { type: "string", required: true, description: "Memory id (from memory_list or memory_search)." },
        offset: { type: "number", description: "Character offset to start reading from (default 0)." },
        limit: { type: "number", description: "Max characters to read (default 500, max 5000)." },
      },
      output: {
        schema: DETAIL_SCHEMA,
        render: (_args, value) => renderJson(value),
      },
      execute(args, exec) {
        return Promise.resolve(
          memory.get(String(args.id), { projectRoot: projectRootOf(exec) }),
        ).then((record) => {
          if (record === undefined) throw new Error(`memory '${String(args.id)}' not found`);
          return detailValue(record, args.offset, args.limit);
        });
      },
      presentCall: (args) => present("查看记忆详情", "read", args.id),
    }),

  defineTool({
      name: "memory_forget",
      description:
        "Delete one memory by id. The owner can delete any memory (applied or ignored). id comes from memory_list or memory_search.",
      parameters: {
        id: { type: "string", required: true, description: "Memory id to delete (from memory_list or memory_search)." },
      },
      output: {
        schema: { type: "object", additionalProperties: false, properties: { deleted: { type: "boolean", required: true } } },
        render: (_args, value) => renderJson(value),
      },
      execute(args, _exec) {
        return Promise.resolve(memory.forget(args.id)).then((deleted) => ({ deleted }));
      },
      presentCall: (args) => present("删除记忆", "other", args.id),
    }),
];

  // ---- 六工具注册跟随 ka-whale-memory.enabled（2026-08-21 修复，恢复文档语义）：
  // enabled=true 时注册，enabled=false 时完全注销（不只是移出 Kaz 工具面），
  // 热重载生效——任何模式下关闭本插件都不再出现记忆工具。会话级可见性
  // 仍由 kaz-mode 在组装/执行层按 agent 会话计算：启用的会话里记忆工具
  // 进工具面、关闭的会话里被过滤/拒绝；正在后台运行的其它会话不受影响。----
  let toolDisposers = [];
  function installTools() {
    if (toolDisposers.length > 0) return;
    for (const def of toolDefs) {
      try {
        toolDisposers.push(ctx.tools.register(def));
      } catch (error) {
        ctx.logger.warn(`[ka-whale-memory] 注册工具 ${def.name} 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  function uninstallTools() {
    for (const dispose of toolDisposers) {
      try {
        dispose();
      } catch (error) {
        ctx.logger.warn(`[ka-whale-memory] 注销工具失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    toolDisposers = [];
  }
  function handleChange() {
    const enabled = source()?.enabled !== false;
    if (enabled) installTools();
    else uninstallTools();
    ctx.logger.info(
      `[ka-whale-memory] 配置已生效：enabled=${enabled ? "true" : "false"}` +
        `（六工具${enabled ? "已注册" : "已完全注销"}；会话级可见性由 kaz-mode 按 agent 会话过滤）`,
    );
  }

  /** 在文件管理器中打开一个文件夹（先确保目录存在；探针可用 config.openFolder 覆盖）。 */
  function openFolder(folder) {
    try {
      mkdirSync(folder, { recursive: true });
    } catch (error) {
      ctx.logger.warn(`[ka-whale-memory] 确保记忆文件夹存在失败：${error instanceof Error ? error.message : String(error)}`);
    }
    const platform = process.platform;
    const command = platform === "win32" ? "explorer" : platform === "darwin" ? "open" : "xdg-open";
    let child;
    try {
      child = spawn(command, [folder], { stdio: "ignore", detached: true });
    } catch (error) {
      ctx.logger.warn(`[ka-whale-memory] 打开文件夹失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    child.on("error", (error) => ctx.logger.warn(`[ka-whale-memory] 打开文件夹失败：${error instanceof Error ? error.message : String(error)}`));
    child.unref();
  }
  const openFolderAction = typeof config.openFolder === "function" ? config.openFolder : openFolder;

  installSettingsWithDefaults(
    ctx,
    NAMESPACE,
    SETTINGS_SCHEMA,
    {
      enabled: true,
      bm25: { k1: 1.2, b: 0.75 },
      lifecycle: { C: 64, Nmin: 2, tau: 0.15, idleWindowDays: 30 },
    },
    DEFAULT_SECTION,
    {
      setSource: (getValue) => {
        source = () => getValue();
      },
      onChange: () => handleChange(),
    },
  );

  // 初始注册交给 handleChange（installSettingsWithDefaults 的 onChange 会同步
  // 调用一次）：enabled=true 时注册六工具，关闭时完全注销。
  ctx.effect(() => () => {
    uninstallTools();
  });
}
