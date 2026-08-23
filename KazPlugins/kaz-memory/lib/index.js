// kaz-memory —— 独立记忆插件（BM25 检索 + 摘要 + 自动载入 + RPC 面板通道）
// ===========================================================================
//   2026-08 升级：
//   * ctx.memory 引擎 + memory_save / memory_update / memory_list /
//     memory_search / memory_detail / memory_forget 六工具
//   * 每条记忆 JSON 持久化：id / name / keywords / summary / content /
//     created_at / updated_at（ISO 字符串）；旧记录（createdAt/updatedAt
//     毫秒数字、无 summary）读取时自动迁移，写回时落新格式
//   * memory_search = BM25 相关性排序（vendored okapibm25，离线可用；
//     k1/b 可在 settings.yaml 的 kaz-memory.bm25 段调整），返回
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
//   * 已确认且标记「自动载入」（autoLoad）的记忆会在对话开始时（首个 pre-step）
//     以上下文注入方式注入一次（2026-08 重构：不再等 memory_search 首次可用）
//   * memory_list 只返回 id/name/updated_at/keywords，不返回正文——避免列表
//     调用把记忆灌进上下文；按时间倒序（updated_at，缺失回退 created_at，
//     最新在前），limit 控制返回条数；看全文用 memory_search 的 summary +
//     memory_detail。
//   * 项目记忆按项目文件夹隔离（2026-08-17）：project 记忆写在
//     <项目文件夹>/.dsh/storages/memory_project.json，项目根从 agent 会话 cwd
//     （exec.agent.session.header.cwd）解析——不再用 dsh 进程的 process.cwd()。
//   * 面板数据通道 = 专用 Connection RPC（/kaz-memory，loopback）：list / open /
//     rename / status / autoLoad / forget / openFolder。记忆数据（含 name）全部
//     存在 JSON 文件里，settings.yaml 不再承载任何记忆存储信息（2026-08-19）。
//   * 人工确认闸门：模型 memory_save 只能写 pending，只有人在面板确认才置为
//     applied；模型没有任何对应工具，闸门成立。
// ===========================================================================

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { MemoryEngine } from "./engine.js";
import { effectiveToolWhitelist, TOOL_WHITELIST } from "kaz-shared";

export { MemoryEngine, MemoryId } from "./engine.js";
export { bm25Scores, bm25ScoresAsync, tokenize } from "./bm25.js";

export const name = "kaz-memory";
export const inject = ["storage", "systemPrompt", "tools", "connection"];

/** 设置命名空间：~/.dsh/settings.yaml 中的 kaz-memory: 段（面板桥接镜像）。 */
const NAMESPACE = settingsNamespace("kaz-memory");

const RECORD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", required: true },
    namespace: { type: "string", required: true, enum: ["global", "project"] },
    status: { type: "string", required: true, enum: ["pending", "ignored", "applied"] },
    autoLoad: { type: "boolean", required: true },
    name: { type: "string", required: true },
    summary: { type: "string", required: true },
    content: { type: "string", required: true },
    keywords: { type: "array", required: true, items: { type: "string" } },
    created_at: { type: "string", required: true },
    updated_at: { type: "string", required: true },
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
  },
};

/** memory_detail 的返回项（分片读取）。 */
const DETAIL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    content_preview: { type: "string", required: true },
    total_length: { type: "number", required: true },
    has_more: { type: "boolean", required: true },
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

function recordValue(record) {
  return {
    id: String(record.id),
    namespace: record.namespace,
    status: record.status,
    name: typeof record.name === "string" && record.name.length > 0 ? record.name : nameOf(record.content),
    autoLoad: record.autoLoad === true,
    summary: typeof record.summary === "string" ? record.summary : "",
    content: record.content,
    keywords: record.keywords,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
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

/** 从 settings 段读取 BM25 参数（kaz-memory.bm25.k1 / b），缺省 1.2 / 0.75。 */
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

/** 指引总述行（S 信息）：memory_search 可调用时作为指引第一行。
 *  2026-08-21：改为主动行动式措辞——模型应当主动查记忆、主动存记忆，
 *  而不是等到"遇到难题"才想起记忆。
 *  2026-08-23：固定指引默认由 guidanceHeadEnabled=false 关闭；开启后
 *  guidanceHead 留空时仍使用这条内置默认。 */
const GUIDANCE_HEAD = [
  "We need to search the memory (memory_search) at the start of a task for relevant information.",
  "We need to save memories (memory_save) with concise and sharp content that captures the reasoned solutions and key insights we've derived — so we can reference them when facing similar problems in the future."
].join("\n");

/** 每轮首次 memory_search 之后注入的遗忘指引。 */
const GUIDANCE_FORGET = [
 "We need to get details of memories (memory_detail) when we need more information about a specific memory.",
 "We need to forget memories (memory_forget) that are no longer relevant, including approaches that turned out to be ineffective, solutions that have been superseded, or tasks that have been completed and no longer need to be retained.",
 "We need to update memories (memory_update) when the stored content is incorrect, when the content needs to be revised, or when the memory's name or keywords are no longer accurate — and also when we discover that a previously saved approach or solution is ineffective, outdated, or can be improved."
].join("\n");

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

/**
 * 判断 memory_search 在当前代理环境是否真的可调用：
 *   1) 注册 + Kaz 工具面检查（toolAvailable）——不在注册表 / 不在 Kaz
 *      白名单即视为不可用；
 *   2) 首轮极简（round-minimal isMinimal）——执行层拒绝 memory_search，
 *      即使 schemas 里有也不能调用（与自动载入的 turn>1 兜底同一语义）；
 *   3) schemas(agent) 实际包含 memory_search——原生模式即直接工具面；
 *      Code Mode 下 wire 折叠为 run_code，schemas(agent) 返回的正是
 *      run_code SDK 可绑定的全部可见工具（含 memory_search），因此
 *      "在 schemas 里" 即代表"当前环境能经 run_code 调用"。
 *  读不到的服务 / 设置一律按"不受限制"处理；判定失败按"不可用"处理。
 */
function memorySearchCallable(agent, grouping, kazSettings, toolsSvc, roundMinimalSvc, kazModeSvc) {
  if (roundMinimalSvc !== undefined && roundMinimalSvc !== null && typeof roundMinimalSvc.isMinimal === "function") {
    try {
      if (roundMinimalSvc.isMinimal(agent) === true) return false;
    } catch {
      // 判定失败不阻断，交给工具面检查兜底
    }
  }
  // 方案 A：kazMode 服务存在时按 agent 会话的工具面判定（该会话 kaz-memory
  // 关闭 / 不在白名单 / 首阶段极简都会被排除）；服务缺失时回退旧逻辑。
  if (kazModeSvc !== null && kazModeSvc !== undefined && typeof kazModeSvc.toolVisible === "function") {
    try {
      return kazModeSvc.toolVisible(agent, "memory_search") === true;
    } catch {
      return false;
    }
  }
  if (!toolAvailable("memory_search", grouping, kazSettings)) return false;
  try {
    const schemas =
      toolsSvc !== undefined && toolsSvc !== null && typeof toolsSvc.schemas === "function"
        ? toolsSvc.schemas(agent)
        : [];
    return (
      Array.isArray(schemas) &&
      schemas.some((schema) => schema !== null && typeof schema === "object" && schema.name === "memory_search")
    );
  } catch {
    return false;
  }
}

/**
 * 拼装首轮工具调用后注入的 [kaz-memory guidance] 上下文消息：
 *  统一消息格式 [标题] / > / 内容 / <；只发总述行（S）——记忆工具的具体
 *  用法由各工具描述自带，不再逐行重复 A/B/C/D。仅当 memory_search 在当前
 *  环境确实可调用（存在且可直接使用或经 run_code SDK 调用）时发送；
 *  memory_search 不可用时返回空串（不向模型发指引——没有检索能力的指引
 *  只会干扰模型思考）。
 *
 *  overrides.head：总述行覆盖（空 = 内置默认 GUIDANCE_HEAD）。
 */
function composeGuidance(grouping, kazSettings, overrides = {}, agent, toolsSvc, roundMinimalSvc, kazModeSvc) {
  const head =
    overrides !== null &&
    typeof overrides === "object" &&
    typeof overrides.head === "string" &&
    overrides.head.trim().length > 0
      ? overrides.head.trim()
      : GUIDANCE_HEAD;
  if (!memorySearchCallable(agent, grouping, kazSettings, toolsSvc, roundMinimalSvc, kazModeSvc)) return "";
  return ["[kaz-memory guidance]", ">", head, "<"].join("\n");
}

/**
 * 拼装每轮首次 memory_search 之后注入的 [kaz-memory guidance] 上下文消息：
 *  提醒模型用 memory_forget 清理已完成、不再需要保留的任务记忆。
 *  仅在 memory_search 与 memory_forget 当前环境都确实可调用时发送。
 *
 *  overrides.forget：guidanceForget 覆盖（留空 = 内置默认）。
 */
function composeForgetGuidance(grouping, kazSettings, overrides = {}, agent, toolsSvc, roundMinimalSvc, kazModeSvc) {
  if (!memorySearchCallable(agent, grouping, kazSettings, toolsSvc, roundMinimalSvc, kazModeSvc)) return "";
  if (kazModeSvc !== null && kazModeSvc !== undefined && typeof kazModeSvc.toolVisible === "function") {
    try {
      if (kazModeSvc.toolVisible(agent, "memory_forget") !== true) return "";
    } catch {
      return "";
    }
  } else if (!toolAvailable("memory_forget", grouping, kazSettings)) {
    return "";
  }
  const line =
    overrides !== null &&
    typeof overrides === "object" &&
    typeof overrides.forget === "string" &&
    overrides.forget.trim().length > 0
      ? overrides.forget.trim()
      : GUIDANCE_FORGET;
  return ["[kaz-memory guidance]", ">", line, "<"].join("\n");
}
const SETTINGS_SCHEMA = z.object({
  /** 总开关（Kaz 模式面板提供开关）：关闭时完全不注入记忆指引、不自动载入，
   *  客户端也不渲染记忆面板（sidebar 按钮与面板整体隐藏）。 */
  enabled: z.boolean().default(true),
  /** 整段指引覆盖（旧字段，保留兼容）：非空时完全取代动态拼装。 */
  guidance: z.string().default(""),
  /** 固定提示总述行开关：默认关；开启后按 guidanceHead（留空 = 内置默认）注入。 */
  guidanceHeadEnabled: z.boolean().default(false),
  /** 固定提示总述行文本：仅在 guidanceHeadEnabled=true 时生效；留空 = 内置默认。 */
  guidanceHead: z.string().default(""),
  /** 以下三个字段保留兼容（2026-08-17 起不再生效）：工具细节已并入各工具描述。
   *  guidanceForget 自每轮首次 memory_search 遗忘指引起恢复生效（覆盖默认遗忘指引）。 */
  guidanceSearch: z.string().default(""),
  guidanceSave: z.string().default(""),
  guidanceList: z.string().default(""),
  guidanceForget: z.string().default(""),
  /** BM25 检索参数（memory_search 相关性评分用）：改 settings.yaml 生效，无需 UI。 */
  bm25: z
    .object({
      k1: z.number().default(1.2),
      b: z.number().default(0.75),
    })
    .default({ k1: 1.2, b: 0.75 }),
});

/** 本插件 settings.yaml 段的默认配置（镜像作者 settings.yaml；仅含非运行时字段）。 */
export const DEFAULT_SECTION = {
  guidance: "",
  enabled: true,
  guidanceHeadEnabled: false,
  guidanceHead: "",
  bm25: { k1: 1.2, b: 0.75 },
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
 * 注册 settings 命名空间（语义与 installSettingsSection 相同：composition entry
 * 作 base、用户层优先、热重载），并在用户段缺失时只写缺失的键补齐默认值。
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

  // ---- 设置（仅 guidance 配置；记忆数据不走 settings） ----
  // settings 服务惰性获取：apply 阶段可能尚未挂载（启动竞态），所有读写都在
  // 调用时解析；installSettingsSection 内部用 inject 等待服务，注册不受影响。
  const getSettings = () => ctx.get("settings");
  let source = () => ({
    enabled: true,
    guidance: "",
    guidanceHeadEnabled: false,
    guidanceHead: "",
    guidanceSearch: "",
    guidanceSave: "",
    guidanceList: "",
    guidanceForget: "",
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
      ctx.logger.warn(`[kaz-memory] 解析当前项目根失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return lastProjectRoot;
  }

  // ---- 自动载入：已注入标记持久化 ----
  // 2026-08-19 修复（Kaczev 报告）：autoLoadInjected 是进程内 WeakMap，dsh 重启
  // 后清空，恢复的会话会把 memory_search 误判为「首次可用」而重复注入。修复：
  // 把已注入的 agent id 持久化到 <DSH_HOME>/storages/kaz-memory-auto-injected.json
  // （默认 ~/.dsh/storages；config.autoInjectedStore 可覆盖，探针用临时文件），
  // 重启后同一会话不再注入。仅在实际注入成功后才落标。
  // 固定指引与遗忘指引改为按 turn 重复注入，不再做「每会话一次」的持久化去重。
  const AUTO_INJECTED_STORE =
    typeof config.autoInjectedStore === "string" && config.autoInjectedStore.trim().length > 0
      ? config.autoInjectedStore.trim()
      : join(process.env.DSH_HOME || join(homedir(), ".dsh"), "storages", "kaz-memory-auto-injected.json");
  const persistedInjected = new Set();
  try {
    if (existsSync(AUTO_INJECTED_STORE)) {
      // 兼容手工编辑/工具写入时可能带上的 UTF-8 BOM（﻿）
      const raw = readFileSync(AUTO_INJECTED_STORE, "utf8").replace(/^\uFEFF/, "");
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && Array.isArray(parsed.agents)) {
        for (const id of parsed.agents) {
          if (typeof id === "string" && id.length > 0) persistedInjected.add(id);
        }
      } else if (parsed !== null && typeof parsed === "object" && typeof parsed.agents === "string" && parsed.agents.length > 0) {
        // 兼容 PowerShell ConvertTo-Json 单元素数组被解包成字符串的写法
        persistedInjected.add(parsed.agents);
      }
    }
  } catch (error) {
    ctx.logger.warn(`[kaz-memory] 读取注入标记失败：${error instanceof Error ? error.message : String(error)}`);
  }
  function persistInjected() {
    try {
      mkdirSync(dirname(AUTO_INJECTED_STORE), { recursive: true });
      writeFileSync(
        AUTO_INJECTED_STORE,
        JSON.stringify(
          {
            agents: [...persistedInjected].sort(),
            updatedAt: Date.now(),
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );
    } catch (error) {
      ctx.logger.warn(`[kaz-memory] 持久化注入标记失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const autoLoadInjected = new WeakMap();
  /** 进程内缓存：某 agent 首次注入固定指引的 turn；用于避免重复扫描事件。 */
  const guidanceFirstTurnCache = new WeakMap();
  /** 进程内缓存：某 agent 最近一次已注入遗忘指引的 turn。 */
  const forgetInjectedTurn = new WeakMap();

  // 加载时预标记现有 agent（thinking-anchor 同款）：自动载入视为已注入。
  // 重启后恢复的会话即使不在持久化标记里（例如标记文件晚于会话创建、
  // 或 id 格式差异），也不会被重复注入；持久化标记继续兜底「重启后晚于插件
  // 加载才恢复的会话」。固定指引/遗忘指引不再预标记——新行为按 turn 注入，
  // 恢复的会话也能从后续轮次开始收到提醒。
  try {
    const agents = ctx.get("agents");
    if (agents !== undefined && agents !== null && typeof agents.list === "function") {
      for (const agent of agents.list()) {
        if (agent !== null && typeof agent === "object" && agent.id !== undefined) {
          autoLoadInjected.set(agent, true);
          persistedInjected.add(String(agent.id));
        }
      }
      persistInjected();
    }
  } catch (error) {
    ctx.logger.debug(`[kaz-memory] 预标记现有 agent 失败：${error instanceof Error ? error.message : String(error)}`);
  }

  async function buildAutoLoadMessage(agent) {
    let records;
    try {
      records = await memory.list({
        status: "applied",
        autoLoad: true,
        projectRoot: projectRootOf({ agent }),
      });
    } catch (error) {
      ctx.logger.warn(`[kaz-memory] 加载自动载入记忆失败: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
    if (!Array.isArray(records) || records.length === 0) return undefined;
    const lines = ["[kaz-memory Auto-Load]", ">", "We need to recall the memories:"];
    for (const record of records) {
      // 自动载入只注入 content 正文，不再额外带标题/namespace，减小上下文占用。
      const body = String(record.content ?? "").replace(/\r?\n/g, "\n  ");
      lines.push(`- ${body}`);
    }
    lines.push("<");
    return createUserMessage({
      content: [{ type: "text", text: lines.join("\n") }],
      source: { kind: "plugin", plugin: "kaz-memory", form: "recall" },
    });
  }

  // ---- 面板数据通道（Connection RPC，不经过 settings.yaml） ----
  // 客户端经 createWebConnectionRpc() 调用 /kaz-memory 通道；记忆数据（含 name）
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
      if (endpoint === "autoLoad") {
        const record = await memory.setAutoLoad(String(payload?.id), payload?.autoLoad === true);
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
      ctx.logger.warn(`[kaz-memory] RPC ${String(endpoint)} 失败：${error instanceof Error ? error.message : String(error)}`);
      return rpcFail(error instanceof Error ? error.message : String(error));
    }
  };
  const connection = ctx.get("connection");
  if (connection !== undefined && connection !== null && connection.rpc !== undefined && typeof connection.rpc.handle === "function") {
    const disposeRpc = connection.rpc.handle("/kaz-memory", rpcHandler, { authority: "loopback" });
    ctx.effect(() => () => { void disposeRpc(); });
  } else {
    ctx.logger.warn("[kaz-memory] connection 服务不可用，面板 RPC 通道未注册（仅工具与自动载入可用）");
  }

  // ---- 固定指引文本：settings 里 guidance 留空则发固定总述行
  // （工具细节由工具描述自带，不再重复 A/B/C/D 行）；仅在 memory_search 当前
  // 环境可调用时以合成用户消息注入。Kaz 模式会把 systemPrompt 段全部滤掉，
  // 所以这里不再注册 tool:memory:kaz-memory 段，改为 pre-step 上下文注入。
  // 方案 A：kazMode 服务存在时按 agent 会话判定工具可用性（后台会话不受
  // 切换对话影响）；服务缺失时回退全局 enabled 兜底。----
  const getKazModeSvc = () => {
    try {
      const svc = ctx.get("kazMode");
      return svc !== undefined && svc !== null && typeof svc.toolVisible === "function" ? svc : null;
    } catch {
      return null;
    }
  };

  /** 生效配置 = kazMode.pluginConfig（完整）；服务缺失时回落到插件自身 settings.yaml。 */
  function liveFor(agent) {
    try {
      const svc = ctx.get("kazMode");
      if (svc !== undefined && svc !== null && typeof svc.pluginConfig === "function") {
        const cfg = svc.pluginConfig(agent, "kaz-memory");
        if (cfg !== null && cfg !== undefined && typeof cfg === "object") return cfg;
      }
    } catch {
      // fall through
    }
    return source();
  }

  const guidanceText = (agent) => {
    const current = liveFor(agent);
    const kazModeSvc = getKazModeSvc();
    // 总开关（硬闸门，2026-08-21 修复）：生效 enabled=false 时一律不注入。
    if (current === null || typeof current !== "object" || current.enabled === false) return "";
    const legacy =
      current !== null && typeof current === "object" && typeof current.guidance === "string"
        ? current.guidance.trim()
        : "";
    if (legacy.length > 0) return legacy; // 旧字段 guidance：整段覆盖（兼容旧配置）
    // 固定提示总述行开关（2026-08-23）：默认关；开启后才按 guidanceHead 注入。
    if (current.guidanceHeadEnabled !== true) return "";
    const settings = getSettings();
    let kazSettings;
    try {
      kazSettings = settings === undefined ? undefined : settings.get(settingsNamespace("kaz-mode"));
    } catch {
      kazSettings = undefined;
    }
    const head =
      current !== null && typeof current === "object" && typeof current.guidanceHead === "string"
        ? current.guidanceHead
        : "";
    return composeGuidance(ctx.get("toolGrouping"), kazSettings, { head }, agent, ctx.get("tools"), ctx.get("roundMinimal"), kazModeSvc);
  };
  /** 每轮首次 memory_search 之后注入的遗忘指引：同受总开关控制；旧字段 guidance
   *  整段覆盖时不再追加（兼容旧配置）；guidanceForget 可覆盖默认遗忘指引。 */
  const forgetGuidanceText = (agent) => {
    const current = liveFor(agent);
    const kazModeSvc = getKazModeSvc();
    // 总开关（硬闸门，同 guidanceText）：生效 enabled=false 时一律不注入。
    if (current === null || typeof current !== "object" || current.enabled === false) return "";
    const legacy =
      current !== null && typeof current === "object" && typeof current.guidance === "string"
        ? current.guidance.trim()
        : "";
    if (legacy.length > 0) return ""; // 旧字段 guidance：整段覆盖（兼容旧配置）
    const settings = getSettings();
    let kazSettings;
    try {
      kazSettings = settings === undefined ? undefined : settings.get(settingsNamespace("kaz-mode"));
    } catch {
      kazSettings = undefined;
    }
    const forget =
      current !== null && typeof current === "object" && typeof current.guidanceForget === "string"
        ? current.guidanceForget
        : "";
    return composeForgetGuidance(ctx.get("toolGrouping"), kazSettings, { forget }, agent, ctx.get("tools"), ctx.get("roundMinimal"), kazModeSvc);
  };
  /** 尝试把本插件给模型发送的信息上报给 round-display 显示插件（best-effort）。
   *  服务不存在时静默跳过，不影响主流程。 */
  function reportRoundDisplay(agent, content) {
    try {
      const rd = ctx.get("roundDisplay");
      if (rd !== undefined && rd !== null && typeof rd.report === "function" && typeof content === "string" && content.trim().length > 0) {
        rd.report({ agent, plugin: "kaz-memory", title: "guidance", content });
      }
    } catch (error) {
      ctx.logger.debug(`[kaz-memory] 上报 round-display 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 从 createUserMessage 返回值里取纯文本（content 数组首个 text 块）。 */
  function recallTextOf(recall) {
    try {
      const blocks = recall !== null && typeof recall === "object" ? recall.content : undefined;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
            return block.text;
          }
        }
      }
    } catch {
      return "";
    }
    return "";
  }

  /** 从 tool/call 事件里取工具名（兼容 event.name 与 event.data.name）。 */
  function toolCallNameOf(event) {
    if (event === null || typeof event !== "object" || event.type !== "tool/call") return undefined;
    const data = event.data;
    const name = data !== null && typeof data === "object" ? data.name : undefined;
    return typeof name === "string" ? name : typeof event.name === "string" ? event.name : undefined;
  }

  /** 会话里是否已发生第一次工具调用；传入 toolName 时只匹配指定工具。 */
  function hasToolCall(agent, toolName) {
    try {
      const events = agent?.session?.events;
      if (!Array.isArray(events)) return false;
      return events.some((event) => {
        const name = toolCallNameOf(event);
        if (name === undefined) return false;
        return toolName === undefined || name === toolName;
      });
    } catch {
      return false;
    }
  }

  /** 指定 turn 内是否已发生过工具调用；传入 toolName 时只匹配指定工具。 */
  function hasToolCallInTurn(agent, toolName, turn) {
    try {
      const events = agent?.session?.events;
      if (!Array.isArray(events)) return false;
      let turnStartIndex = -1;
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        if (
          event !== null &&
          typeof event === "object" &&
          event.type === "turn/start" &&
          event.data !== null &&
          typeof event.data === "object" &&
          event.data.turn === turn
        ) {
          turnStartIndex = index;
        }
      }
      if (turnStartIndex === -1) return false;
      for (let index = turnStartIndex + 1; index < events.length; index += 1) {
        const name = toolCallNameOf(events[index]);
        if (name !== undefined && (toolName === undefined || name === toolName)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * 指定 turn 内是否已注入过 kaz-memory 的指定 form 消息。
   * 用于跨重启/同 turn 内防重复：以 turn/start 事件切分轮次。
   */
  function hasInjectedInTurn(agent, form, turn) {
    try {
      const events = agent?.session?.events;
      if (!Array.isArray(events)) return false;
      let turnStartIndex = -1;
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        if (
          event !== null &&
          typeof event === "object" &&
          event.type === "turn/start" &&
          event.data !== null &&
          typeof event.data === "object" &&
          event.data.turn === turn
        ) {
          turnStartIndex = index;
        }
      }
      if (turnStartIndex === -1) return false;
      for (let index = turnStartIndex + 1; index < events.length; index += 1) {
        const event = events[index];
        if (event === null || typeof event !== "object" || event.type !== "user/message") continue;
        const data = event.data;
        if (data === null || typeof data !== "object") continue;
        const source = data.source;
        if (source === null || typeof source !== "object") continue;
        if (source.kind !== "plugin" || source.plugin !== "kaz-memory") continue;
        if (form !== undefined && source.form !== form) continue;
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * 会话日志里是否已注入过 kaz-memory 的消息（自动载入 recall 或固定指引 guidance）。
   * 这是自动载入跨重启去重的最终防线：只要会话历史里已经出现过 kaz-memory 的注入记录，
   * 就不再注入。
   */
  function hasInjectedBefore(agent, form) {
    try {
      const events = agent?.session?.events;
      if (!Array.isArray(events)) return false;
      return events.some((event) => {
        if (event === null || typeof event !== "object" || event.type !== "user/message") return false;
        const data = event.data;
        if (data === null || typeof data !== "object") return false;
        const source = data.source;
        if (source === null || typeof source !== "object") return false;
        if (source.kind !== "plugin" || source.plugin !== "kaz-memory") return false;
        if (form !== undefined && source.form !== form) return false;
        return true;
      });
    } catch {
      return false;
    }
  }

  /**
   * 首次发送固定指引（source.form === "guidance"）所在的轮次。
   * 从会话事件里直接推导：找到第一条 guidance 用户消息，再找它前面最近的 turn/start。
   * 找不到返回 undefined。
   */
  function firstGuidanceTurnOf(agent) {
    try {
      const events = agent?.session?.events;
      if (!Array.isArray(events)) return undefined;
      let firstIndex = -1;
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        if (event === null || typeof event !== "object" || event.type !== "user/message") continue;
        const data = event.data;
        if (data === null || typeof data !== "object") continue;
        const source = data.source;
        if (source === null || typeof source !== "object") continue;
        if (source.kind === "plugin" && source.plugin === "kaz-memory" && source.form === "guidance") {
          firstIndex = index;
          break;
        }
      }
      if (firstIndex === -1) return undefined;
      let turn = 0;
      for (let index = 0; index <= firstIndex; index += 1) {
        const event = events[index];
        if (
          event !== null &&
          typeof event === "object" &&
          event.type === "turn/start" &&
          event.data !== null &&
          typeof event.data === "object" &&
          typeof event.data.turn === "number"
        ) {
          turn = event.data.turn;
        }
      }
      return turn > 0 ? turn : undefined;
    } catch {
      return undefined;
    }
  }

  // ---- 自动载入：对话开始时（首个 pre-step）把已确认且标记「自动载入」的记忆
  // 注入一次（2026-08 重构：不再等 memory_search 首次可用——对话一开始就注入）----
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (decision === null || typeof decision !== "object" || decision.kind !== "enter") return decision;
    if (payload === null || typeof payload !== "object" || payload.step !== 1) return decision;
    const agent = payload.agent;
    if (agent === null || agent === undefined || typeof agent !== "object") return decision;
    // 组件总开关：按该会话生效配置判定（含 kazMode 会话覆盖）。
    if (liveFor(agent).enabled === false) return decision;
    if (autoLoadInjected.has(agent)) return decision;
    // 跨重启去重：该会话此前已注入过（持久化标记）→ 跳过。
    if (agent.id !== undefined && persistedInjected.has(String(agent.id))) return decision;
    // 最终防线：会话日志里已出现过 kaz-memory 自动载入记录 → 跳过。
    if (hasInjectedBefore(agent, "recall")) return decision;
    const recall = await buildAutoLoadMessage(agent);
    if (recall === undefined) return decision;
    // 实际注入成功后才落标（进程内 + 持久化）。
    autoLoadInjected.set(agent, true);
    if (agent.id !== undefined) {
      persistedInjected.add(String(agent.id));
      persistInjected();
    }
    // 告诉 round-display 显示插件本轮发送了什么（best-effort）。
    reportRoundDisplay(agent, recallTextOf(recall));
    return { ...decision, messages: Array.isArray(decision.messages) ? [...decision.messages, recall] : decision.messages };
  });

  // ---- 固定指引：首次工具调用后注入；之后每个 turn 开头重复注入 ----
  // 记第一次发送固定指引的轮次为 n，则第 n+1、n+2、……轮都在对话开始
  // （agent/pre-step，step === 1）再次注入同一固定指引。首次发送仍保持旧语义：
  // 在会话已有第一次 tool/call 后的某个 pre-step 以合成用户消息注入一次。
  // Kaz 模式系统提示词由 kaz 预设的 kaz-system-prompt.mjs 收敛（只保留 persona +
  // 计划模式段），因此固定指引不再注册 systemPrompt.section；改为 agent/pre-step
  // 合成用户消息注入（round-display 同步上报）。
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (decision === null || typeof decision !== "object" || decision.kind !== "enter") return decision;
    const agent = payload?.agent;
    if (agent === null || agent === undefined || typeof agent !== "object") return decision;
    const turn = payload?.turn;
    if (typeof turn !== "number" || turn <= 0) return decision;

    let firstTurn = guidanceFirstTurnCache.has(agent)
      ? guidanceFirstTurnCache.get(agent)
      : firstGuidanceTurnOf(agent);
    if (firstTurn !== undefined) {
      guidanceFirstTurnCache.set(agent, firstTurn);
      // 已发送过：只在后续轮次的 turn 开头重复。
      if (payload.step !== 1) return decision;
      if (turn <= firstTurn) return decision;
      // 跨重启/同 turn 防重复：会话事件里当前轮已注入过就不再注入。
      if (hasInjectedInTurn(agent, "guidance", turn)) return decision;
      const text = guidanceText(agent);
      if (typeof text !== "string" || text.trim().length === 0) return decision;
      let message;
      try {
        message = createUserMessage({
          content: [{ type: "text", text }],
          source: { kind: "plugin", plugin: "kaz-memory", form: "guidance" },
        });
      } catch (error) {
        ctx.logger.warn(`[kaz-memory] 构造指引注入消息失败：${error instanceof Error ? error.message : String(error)}`);
        return decision;
      }
      reportRoundDisplay(agent, text);
      return { ...decision, messages: Array.isArray(decision.messages) ? [...decision.messages, message] : decision.messages };
    }

    // 首次发送：首轮工具调用之后才注入，此时 memory_search 已进入工具面。
    if (!hasToolCall(agent)) return decision;
    const text = guidanceText(agent);
    if (typeof text !== "string" || text.trim().length === 0) return decision;
    let message;
    try {
      message = createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "plugin", plugin: "kaz-memory", form: "guidance" },
      });
    } catch (error) {
      ctx.logger.warn(`[kaz-memory] 构造指引注入消息失败：${error instanceof Error ? error.message : String(error)}`);
      return decision;
    }
    guidanceFirstTurnCache.set(agent, turn);
    reportRoundDisplay(agent, text);
    return { ...decision, messages: Array.isArray(decision.messages) ? [...decision.messages, message] : decision.messages };
  });

  // ---- 遗忘指引：每一轮首次 memory_search 之后注入一次 ----
  // 提醒模型清理已完成、不再需要保留的任务记忆；按 turn 切分，每个 turn 内
  // 只注入一次，跨重启/同 turn 由会话事件里的 forget-guidance 记录兜底。
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (decision === null || typeof decision !== "object" || decision.kind !== "enter") return decision;
    const agent = payload?.agent;
    if (agent === null || agent === undefined || typeof agent !== "object") return decision;
    const turn = payload?.turn;
    if (typeof turn !== "number" || turn <= 0) return decision;
    if (forgetInjectedTurn.get(agent) === turn) return decision;
    if (hasInjectedInTurn(agent, "forget-guidance", turn)) {
      forgetInjectedTurn.set(agent, turn);
      return decision;
    }
    // 当前轮第一次 memory_search 之后才注入。
    if (!hasToolCallInTurn(agent, "memory_search", turn)) return decision;
    const text = forgetGuidanceText(agent);
    if (typeof text !== "string" || text.trim().length === 0) return decision;
    let message;
    try {
      message = createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "plugin", plugin: "kaz-memory", form: "forget-guidance" },
      });
    } catch (error) {
      ctx.logger.warn(`[kaz-memory] 构造遗忘指引注入消息失败：${error instanceof Error ? error.message : String(error)}`);
      return decision;
    }
    forgetInjectedTurn.set(agent, turn);
    reportRoundDisplay(agent, text);
    return { ...decision, messages: Array.isArray(decision.messages) ? [...decision.messages, message] : decision.messages };
  });

  // ---- 组装层兜底：无条件移除基础英文记忆指引（tool:memory）----
  // kaz-memory 不再注册 tool:memory:kaz-memory 系统提示段；固定指引改为首轮
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
  // 注册跟随 kaz-memory.enabled（2026-08-21）：关闭 = 六工具完全注销（不只是
  // 移出 Kaz 工具面），热重载；任何模式下都不再出现在工具列表里。----
  const toolDefs = [
  defineTool({
      name: "memory_save",
      description:
        'Save one cross-session memory as "pending" (待确认). It does NOT take effect automatically — a human must confirm it in the web panel before it becomes "applied"; never treat a pending memory as effective. Provide a short name (title), anchor keywords, the full content, and a one-sentence summary (~100 chars) that you write yourself when saving (the plugin does not generate it). namespace=project stores it in the current project folder (<project>/.dsh/storages/memory_project.json).',
      parameters: {
        name: { type: "string", required: true, description: "Short title for the memory (<=140 chars)." },
        keywords: { type: "array", items: { type: "string" }, required: true, description: "Anchor keywords used by memory_search (BM25)." },
        content: { type: "string", required: true, description: "Full memory content (plain text)." },
        summary: { type: "string", required: true, description: "One-sentence summary (~100 chars), written by you when saving; it is the only summary text shown in memory_search results." },
        namespace: { type: "string", enum: ["global", "project"], description: "Scope: global (harness home) / project (current project folder); default global." },
      },
      output: {
        schema: RECORD_SCHEMA,
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
            ...(args.namespace === undefined ? {} : { namespace: args.namespace }),
            projectRoot: projectRootOf(exec),
          }),
        ).then(recordValue);
      },
      presentCall: (args) => present("保存记忆", "other", args.content),
    }),

  defineTool({
      name: "memory_update",
      description:
        'Update an existing memory by id: content, keywords, name and/or summary. Changing the content of an "applied" memory demotes it back to "pending" for human re-confirmation; metadata-only edits (name / keywords / summary) keep the status. id comes from memory_list or memory_search.',
      parameters: {
        id: { type: "string", required: true, description: "Memory id (from memory_list or memory_search)." },
        content: { type: "string", description: "New memory content (plain text)." },
        keywords: { type: "array", items: { type: "string" }, description: "New anchor keywords; pass [] to clear." },
        name: { type: "string", description: 'New title; pass "" to fall back to deriving it from the content.' },
        summary: { type: "string", description: "New one-sentence summary (~100 chars)." },
      },
      output: {
        schema: RECORD_SCHEMA,
        render: (_args, value) => renderJson(value),
      },
      execute(args, _exec) {
        return Promise.resolve(
          memory.update(String(args.id), {
            ...(args.content === undefined ? {} : { content: args.content }),
            ...(args.keywords === undefined ? {} : { keywords: args.keywords }),
            ...(args.name === undefined ? {} : { name: args.name }),
            ...(args.summary === undefined ? {} : { summary: args.summary }),
          }),
        ).then(recordValue);
      },
      presentCall: (args) => present("更新记忆", "other", args.id),
    }),

  defineTool({
      name: "memory_list",
      description:
        "List memories sorted by time, newest first (by updated_at, falling back to created_at), limited to limit entries. Each entry contains only id/name/updated_at/keywords (name = title line or first line, truncated to 140 chars) — no content, no namespace/status/autoLoad. Use memory_search for relevance hits, memory_detail for the full content of a single memory.",
      parameters: {
        namespace: { type: "string", enum: ["global", "project"], description: "Restrict to a namespace; project = current project folder." },
        status: { type: "string", enum: ["pending", "ignored", "applied"], description: "Restrict to a status." },
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
        "Search memories by BM25 relevance and return summaries sorted by score (descending), with pagination. Each hit contains id/name/summary/keywords/score — content is NOT included; use memory_detail to read the full content of a hit. Scores are computed over content (primary) + summary + keywords with the tunable k1/b parameters from the kaz-memory.bm25 settings section. Returns an empty array when nothing matches; errors when the query is empty.",
      parameters: {
        query: { type: "string", required: true, description: "Search query (BM25 over content + summary + keywords)." },
        limit: { type: "number", description: "Max hits to return (default 10, max 100)." },
        offset: { type: "number", description: "Hits to skip for pagination (default 0, max 1000)." },
        namespace: { type: "string", enum: ["global", "project"], description: "Restrict to a namespace; project = current project folder." },
        status: { type: "string", enum: ["pending", "ignored", "applied"], description: "Restrict to a status." },
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
        "Read the full content of a single memory by id, with chunked reading. Returns content_preview (limit chars starting at offset), total_length and has_more. Errors if the id does not exist; if offset is beyond the content length, content_preview is an empty string (total_length tells you the real size) and has_more is false. Use memory_search or memory_list first to obtain ids.",
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
        "Delete one memory by id. The owner can delete any memory (pending, ignored or applied). id comes from memory_list or memory_search.",
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

  // ---- 六工具注册跟随 kaz-memory.enabled（2026-08-21 修复，恢复文档语义）：
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
        ctx.logger.warn(`[kaz-memory] 注册工具 ${def.name} 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  function uninstallTools() {
    for (const dispose of toolDisposers) {
      try {
        dispose();
      } catch (error) {
        ctx.logger.warn(`[kaz-memory] 注销工具失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    toolDisposers = [];
  }
  function handleChange() {
    const enabled = source()?.enabled !== false;
    if (enabled) installTools();
    else uninstallTools();
    ctx.logger.info(
      `[kaz-memory] 配置已生效：enabled=${enabled ? "true" : "false"}` +
        `（六工具${enabled ? "已注册" : "已完全注销"}；会话级可见性由 kaz-mode 按 agent 会话过滤）`,
    );
  }

  /** 在文件管理器中打开一个文件夹（先确保目录存在；探针可用 config.openFolder 覆盖）。 */
  function openFolder(folder) {
    try {
      mkdirSync(folder, { recursive: true });
    } catch (error) {
      ctx.logger.warn(`[kaz-memory] 确保记忆文件夹存在失败：${error instanceof Error ? error.message : String(error)}`);
    }
    const platform = process.platform;
    const command = platform === "win32" ? "explorer" : platform === "darwin" ? "open" : "xdg-open";
    let child;
    try {
      child = spawn(command, [folder], { stdio: "ignore", detached: true });
    } catch (error) {
      ctx.logger.warn(`[kaz-memory] 打开文件夹失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    child.on("error", (error) => ctx.logger.warn(`[kaz-memory] 打开文件夹失败：${error instanceof Error ? error.message : String(error)}`));
    child.unref();
  }
  const openFolderAction = typeof config.openFolder === "function" ? config.openFolder : openFolder;

  installSettingsWithDefaults(
    ctx,
    NAMESPACE,
    SETTINGS_SCHEMA,
    {
      enabled: true,
      guidance: "",
      guidanceHeadEnabled: false,
      guidanceHead: "",
      guidanceSearch: "",
      guidanceSave: "",
      guidanceList: "",
      guidanceForget: "",
      bm25: { k1: 1.2, b: 0.75 },
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
