// kaz-mode
// ===========================================================================
// 「Kaz 模式」超级模式插件 —— 统一管理并联动本工作区插件：
//   thinking-anchor（思考锚点 · 消息注入）、round-minimal（首阶段极简）、
//   plugin-filter（工具过滤）、output-beep（提示音）、round-display（注入显示）、
//   deepseek-default-model（DeepSeek 采样参数）、kaz-memory（独立记忆组件）、
//   kaz-diag（诊断 · 状态工具），并提供集中管理面板与头部开关按钮（客户端半）。
//
// Kaz 模式的语义（2026-08 重构后）：
//   1) 系统提示词由 kaz 预设的 kaz-system-prompt.mjs 控制：组装层按条件收敛为
//      persona（默认 "You are a helpful software engineer assistant."；kaz-memory
//      启用时切换为记忆优先提示词）+ 计划模式段（计划模式仍需生效），其余任何
//      提示段（thinking-anchor / round-minimal 轮次提示 / kaz-memory 指引 /
//      tool:* 指导段 / 运行时上下文…）一律过滤。本插件不再负责系统提示词。
//   2) 工具面两阶段（工具清单全部由 kaz-shared 的 tool-lists.js 管理）：
//        - 首次工具调用前（round-minimal 首阶段信号）：仅保留 round-minimal
//          首轮工具集 firstRoundTools（为空时由 kaz-shared 按 kaz-memory 自动解析：
//          kaz-memory 开 → memory_search；关 → pwsh + read + edit）；
//        - 首次工具调用后：恢复 Kaz 全部工具 = effectiveToolWhitelist
//          （= settings.toolWhitelist 用户白名单，白名单是唯一闸门——含记忆/
//          诊断工具；已注册但不在清单里的工具不进入工具列表）。白名单默认值
//          TOOL_WHITELIST 来自 kaz-shared；
//          settings.yaml 的 kaz-mode.toolWhitelist 是手动编辑点
//          （热改生效，用户配置始终优先）。不再有 minimalTools / 群组加减。
//        - 记忆/诊断工具是否真正出现 ⇔ 插件 enabled 时注册到 harness（关闭时
//          kaz-memory/kaz-diag 把工具完全注销）且名字在白名单里。
//   3) 插件联动：只有 kaz-mode.enabled 变为 true（进入 Kaz）时，先快照被管理
//      插件的原始 enabled 状态到 kaz-mode.savedPluginStates（供状态报告展示），
//      再按会话/默认状态应用。变为 false（关闭 / 切走）时按会话/非 Kaz 默认状态应用。
//   4) 预设联动：Kaz 模式已注册为 agent preset（id: kaz）。default 切到 "kaz"
//      或会话切换到 kaz 时把 kaz-mode.enabled 置 true（触发上面的插件联动）；
//      切到其它预设 / 其它会话时置 false。同时把最近一个非 kaz 预设记录到
//      kaz-mode.previousPreset，供按钮"关闭"时切回。
//   5) 本插件不注册任何 systemPrompt 段，也不触碰系统提示词；系统提示词由
//      kaz 预设的 kaz-system-prompt.mjs 负责。
//   6) 状态工具 kaz_mode_status 已移出本插件，由独立的 kaz-diag 插件注册
//      （本插件开启/关闭不影响其注册；kaz-diag 关闭时工具也不进入 Kaz 工具面）。
// ===========================================================================

import z from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { symbols } from "@deepseek-ai/cordis";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import {
  TOOL_WHITELIST,
  DEFAULT_DISABLED_TOOLS,
  MANAGED_PLUGINS,
  MEMORY_TOOLS,
  DIAG_TOOL,
  computeSurface,
  normalizeExternalKey,
  emptyExternalToolPluginState,
  normalizeExternalToolPluginState,
  effectiveExternalToolPluginState,
  setExternalPluginTool,
  removeExternalPluginTool,
  setExternalPluginToolHidden,
  setExternalPluginIgnored,
  restoreExternalPlugin,
  TOOL_PLUGIN_FACTORY,
  computeToolPluginSurface,
} from "kaz-shared";

/** 设置命名空间：~/.dsh/settings.yaml 中的 kaz-mode: 段。 */
const NAMESPACE = settingsNamespace("kaz-mode");

/** agent-presets 设置命名空间（预设切换的读写目标，与官方选择器一致）。 */
const PRESETS_NAMESPACE = settingsNamespace("agent-presets");

/** Kaz 模式对应的 agent preset id（~/.dsh/.agent-presets/kaz/）。 */
const KAZ_PRESET_ID = "kaz";

/** 按钮"关闭 Kaz"时的兜底预设。 */
const FALLBACK_PRESET_ID = "cordis";

/**
 * Kaz 工具面全部交给 kaz-shared（lib/tool-lists.js）管理：白名单默认值 /
 * 群组注册 / 工具面计算都来自 kaz-shared；kaz-memory 与 kaz-diag
 * 以群组方式"发信"注册自己的工具并随 enabled 加入/排除。本插件只负责读
 * settings（用户 toolWhitelist 优先）并在组装层/执行层应用
 * computeSurface 的结果。记忆工具与 kaz_mode_status 不再硬编码在本文件。
 */

/** 出厂默认（非 Kaz 模式）：Kaz 插件初始默认全关。 */
const FACTORY_NON_KAZ_DEFAULTS = {
  "thinking-anchor": { enabled: false, instruction: "", turnReminder: "" },
  "round-minimal": {
    enabled: false,
    firstRoundTools: [],
    includeSubagents: false,
    guidanceHeadEnabled: false,
    guidanceHead: "",
  },
  "plugin-filter": {
    enabled: false,
    mode: "remove",
    disabledTools: [...DEFAULT_DISABLED_TOOLS],
  },
  "output-beep": { enabled: false, includeSubagents: false, frequency: 1000, duration: 300 },
  "round-display": { enabled: false },
  "deepseek-default-model": {
    enabled: false,
    generation_kwargs: { temperature: 0.2, top_p: 0.9, repetition_penalty: 1.2 },
  },
  "kaz-memory": { enabled: false, guidance: "", guidanceHeadEnabled: true, guidanceHead: "", guidanceForgetEnabled: true, guidanceForget: "" },
  "kaz-diag": { enabled: false },
  "first-round-hints": { enabled: false },
};

/** 出厂默认（Kaz 模式）：Kaz 插件初始默认全开。 */
/** 默认不开启thinking-anchor、kaz-diag */
/** 默认不开启kaz-memory的guidanceHeadEnabled，因为有系统提示词 */
const FACTORY_KAZ_DEFAULTS = {};
for (const [id, cfg] of Object.entries(FACTORY_NON_KAZ_DEFAULTS)) {
  FACTORY_KAZ_DEFAULTS[id] = { ...cfg, enabled: true };
  if (id === "thinking-anchor" || id === "kaz-diag" || id === "round-display") {
    FACTORY_KAZ_DEFAULTS[id].enabled = false;
  }
  if (id === "kaz-memory") {
    FACTORY_KAZ_DEFAULTS[id].guidanceHeadEnabled = false;
  }
  if (id === "round-minimal") {
    // Kaz 模式默认开首轮工具解锁提示；非 Kaz 默认关。
    FACTORY_KAZ_DEFAULTS[id].guidanceHeadEnabled = true;
  }
}

/** 会话级插件状态文件名（放在项目 .dsh/ 下）。 */
const SESSION_STATES_FILE = "kaz-session-states.json";
/** 两个模式的默认设置文件名（放在 DSH_HOME/storages 下，缺省 ~/.dsh/storages）。
 *  2026-08-21 修复：原实现硬编码为作者机器的 C:\Users\Kaczev\.dsh\storages，
 *  换机/分享时读写会落到错误路径；现在用 DSH_HOME 解析，并支持 config.storageDir 覆盖。 */
const DEFAULTS_FILE_NAME = "kaz-defaults.json";
let STORAGE_DIR = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "storages");
let DEFAULTS_FILE = join(STORAGE_DIR, DEFAULTS_FILE_NAME);
/** 外置工具插件：用户目录默认设置文件名（~/.dsh/storages 下）。 */
const EXTERNAL_USER_DEFAULTS_FILE_NAME = "kaz-tool-plugin-defaults.json";
/** 外置工具插件：项目设置文件名（<项目>/.dsh/storages 下）。 */
const EXTERNAL_PROJECT_STATE_FILE_NAME = "kaz-tool-plugins.json";
/** 外置工具插件：安装时默认（factory）。统一工具插件出厂默认来自 kaz-shared。 */
const TOOL_PLUGIN_FACTORY_STATE = TOOL_PLUGIN_FACTORY;
/** 面板专用 RPC 通道。 */
const RPC_CHANNEL = "/kaz-mode";

/** kaz-mode 插件根目录与 package.json（本机已安装版本的单一事实源）。 */
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_JSON_FILE = join(PLUGIN_ROOT, "package.json");

/** 设置 schema（同时驱动设置页 UI 与客户端面板的字段读写）。 */
const SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(false),
  managedPlugins: z.array(z.string()).default(MANAGED_PLUGINS.map((plugin) => plugin.id)),
  /** Kaz 工具面·白名单（= Kaz 全部工具的唯一闸门，含记忆/诊断工具），热改生效。 */
  toolWhitelist: z.array(z.string()).default([...TOOL_WHITELIST]),
  /** 最近一个非 kaz 预设（按钮"关闭 Kaz"时切回的目标，由预设联动自动维护）。 */
  previousPreset: z.string().default(FALLBACK_PRESET_ID),
  savedPluginStates: z
    .dict(
      z.object({
        hadOverride: z.boolean(),
        enabled: z.boolean(),
      }),
    )
    .default({}),
});

/** 本插件 settings.yaml 段的默认配置（镜像作者 settings.yaml；仅含非运行时字段。
 *  savedPluginStates / previousPreset 是运行时联动字段（Kaz 面板自行写入），
 *  不预置，避免把本机的联动状态带到新机器。 */
export const DEFAULT_SECTION = {
  enabled: true,
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
    // 自愈：只补缺失键，保留用户已有配置（best-effort，失败只记日志）。
    ensureSettingsDefaults(sctx.settings, ns, defaults, ctx.logger);
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


// ---------------------------------------------------------------------------
// 会话级插件状态持久化（.dsh/kaz-session-states.json）
// ---------------------------------------------------------------------------

/** 深拷贝可 JSON 序列化的对象（避免默认值被后续修改污染）。 */
function deepClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

/** 返回一份全新的出厂默认设置。 */
function factoryDefaults() {
  return {
    nonKaz: deepClone(FACTORY_NON_KAZ_DEFAULTS),
    kaz: deepClone(FACTORY_KAZ_DEFAULTS),
  };
}

/** 规范化插件状态 map：只保留对象值。 */
function normalizePluginMap(raw) {
  const result = {};
  if (raw === null || typeof raw !== "object") return result;
  for (const [id, value] of Object.entries(raw)) {
    if (value !== null && typeof value === "object") result[id] = value;
  }
  return result;
}

/** 合并出厂默认与已存默认：按插件逐个浅合并，保留出厂默认的缺失字段。 */
function mergeDefaultsMap(factory, stored) {
  const result = {};
  for (const [id, base] of Object.entries(factory)) {
    const override = stored[id];
    result[id] = override !== null && typeof override === "object" ? { ...base, ...override } : { ...base };
  }
  return result;
}

/** 读取 storages 下的默认设置文件；不存在或损坏时回退到代码内出厂默认。 */
function loadDefaults(logger) {
  try {
    if (!existsSync(DEFAULTS_FILE)) return factoryDefaults();
    let raw = readFileSync(DEFAULTS_FILE, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return factoryDefaults();
    const defaults = parsed.defaults !== null && typeof parsed.defaults === "object" ? parsed.defaults : {};
    return {
      nonKaz: mergeDefaultsMap(FACTORY_NON_KAZ_DEFAULTS, normalizePluginMap(defaults.nonKaz)),
      kaz: mergeDefaultsMap(FACTORY_KAZ_DEFAULTS, normalizePluginMap(defaults.kaz)),
    };
  } catch (error) {
    logger?.warn?.("[kaz-mode] 读取默认设置文件失败：" + safeMessage(error));
    return factoryDefaults();
  }
}

/** 写回 storages 下的默认设置文件（非 Kaz / Kaz 两个模式）。 */
function saveDefaults(defaults, logger) {
  try {
    mkdirSync(dirname(DEFAULTS_FILE), { recursive: true });
    writeFileSync(DEFAULTS_FILE, JSON.stringify({ version: 1, defaults }, null, 2) + "\n", "utf8");
  } catch (error) {
    logger?.warn?.("[kaz-mode] 写入默认设置文件失败：" + safeMessage(error));
  }
}

/** 会话状态文件新路径：<项目>/.dsh/storages/kaz-session-states.json（2026-08-21
 *  与 kaz-memory 的 memory_project.json 同目录约定；旧路径 <项目>/.dsh/ 仅迁移用）。 */
function sessionStatesPath(cwd) {
  return join(cwd, ".dsh", "storages", SESSION_STATES_FILE);
}
function legacySessionStatesPath(cwd) {
  return join(cwd, ".dsh", SESSION_STATES_FILE);
}

/** 读取项目目录下的会话专属状态；不存在或损坏时返回空对象。 */
function loadSessions(cwd, logger) {
  const tryRead = (file) => {
    if (!existsSync(file)) return null;
    let raw = readFileSync(file, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return {};
    return parsed.sessions !== null && typeof parsed.sessions === "object" ? parsed.sessions : {};
  };
  try {
    const current = tryRead(sessionStatesPath(cwd));
    if (current !== null) return current;
    // 旧路径迁移：读到旧文件即返回（下次 save 会写到新路径并删除旧文件）。
    const legacy = tryRead(legacySessionStatesPath(cwd));
    if (legacy !== null) {
      logger?.info?.("[kaz-mode] 检测到旧路径会话状态文件，将在下次写入时迁移到 .dsh/storages/");
      return legacy;
    }
    return {};
  } catch (error) {
    logger?.warn?.("[kaz-mode] 读取会话状态文件失败：" + safeMessage(error));
    return {};
  }
}

/** 写回项目目录下的会话专属状态（.dsh/storages/；写成功后删除旧路径残留）。 */
function saveSessions(cwd, sessions, logger) {
  const dir = join(cwd, ".dsh", "storages");
  const file = join(dir, SESSION_STATES_FILE);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, sessions }, null, 2) + "\n", "utf8");
  } catch (error) {
    logger?.warn?.("[kaz-mode] 写入会话状态文件失败：" + safeMessage(error));
    return;
  }
  try {
    const legacy = legacySessionStatesPath(cwd);
    if (existsSync(legacy)) {
      unlinkSync(legacy);
      logger?.info?.("[kaz-mode] 已迁移会话状态文件到 .dsh/storages/（删除旧路径文件）");
    }
  } catch (error) {
    logger?.warn?.("[kaz-mode] 删除旧路径会话状态文件失败（不影响新文件）：" + safeMessage(error));
  }
}

/** 读取完整状态：默认设置来自插件目录，会话专属来自项目目录。 */
function loadStateFile(cwd, logger) {
  return {
    defaults: loadDefaults(logger),
    sessions: loadSessions(cwd, logger),
  };
}

// ---------------------------------------------------------------------------
// 外置工具插件三层存储（2026-08 分步实施 · 第三步）
//   factory（代码内）→ 用户默认（~/.dsh/storages/kaz-tool-plugin-defaults.json）
//   → 项目设置（<项目>/.dsh/storages/kaz-tool-plugins.json）
// 只负责读写 + 合并，不参与工具面过滤（那是第四步）。
// ---------------------------------------------------------------------------

/** 用户默认设置文件路径（随 STORAGE_DIR 配置变化，调用时计算）。 */
function externalUserDefaultsPath() {
  return join(STORAGE_DIR, EXTERNAL_USER_DEFAULTS_FILE_NAME);
}

/** 项目设置文件路径。 */
function externalProjectStatePath(cwd) {
  return join(cwd, ".dsh", "storages", EXTERNAL_PROJECT_STATE_FILE_NAME);
}

/** 安全读取一个 JSON 状态文件；不存在/损坏时回退 fallback（不抛错）。 */
function readExternalStateFile(file, fallback, logger) {
  try {
    if (!existsSync(file)) return fallback;
    let raw = readFileSync(file, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const parsed = JSON.parse(raw);
    return normalizeExternalToolPluginState(parsed);
  } catch (error) {
    logger?.warn?.("[kaz-mode] 读取外置工具插件状态失败（" + file + "）：" + safeMessage(error));
    return fallback;
  }
}

/** 读取用户默认层（~/.dsh/storages）。 */
function loadExternalUserDefaults(logger) {
  return readExternalStateFile(externalUserDefaultsPath(), emptyExternalToolPluginState(), logger);
}

/** 读取项目层（<项目>/.dsh/storages）。 */
function loadExternalProjectState(cwd, logger) {
  return readExternalStateFile(externalProjectStatePath(cwd), emptyExternalToolPluginState(), logger);
}

/** 写用户默认层（先建目录，写规范化状态；失败只记日志）。 */
function saveExternalUserDefaults(state, logger) {
  try {
    mkdirSync(STORAGE_DIR, { recursive: true });
    writeFileSync(externalUserDefaultsPath(), JSON.stringify(normalizeExternalToolPluginState(state), null, 2) + "\n", "utf8");
  } catch (error) {
    logger?.warn?.("[kaz-mode] 写入外置工具插件用户默认失败：" + safeMessage(error));
  }
}

/** 写项目层（先建目录，写规范化状态；失败只记日志）。 */
function saveExternalProjectState(cwd, state, logger) {
  try {
    const dir = join(cwd, ".dsh", "storages");
    mkdirSync(dir, { recursive: true });
    writeFileSync(externalProjectStatePath(cwd), JSON.stringify(normalizeExternalToolPluginState(state), null, 2) + "\n", "utf8");
  } catch (error) {
    logger?.warn?.("[kaz-mode] 写入外置工具插件项目设置失败：" + safeMessage(error));
  }
}

/** 读取三层并算出生效状态。cwd 缺失时回退 process.cwd()。 */
function loadExternalToolPluginLayers(cwd, logger) {
  const safeCwd = typeof cwd === "string" && cwd.trim().length > 0 ? cwd.trim() : process.cwd();
  const factory = deepClone(TOOL_PLUGIN_FACTORY_STATE);
  const user = loadExternalUserDefaults(logger);
  const project = loadExternalProjectState(safeCwd, logger);
  const effective = effectiveExternalToolPluginState({ factory, user, project });
  const userEffective = effectiveExternalToolPluginState({ factory, user });
  return { cwd: safeCwd, factory, user, project, effective, userEffective };
}

/** 判断两个规范化状态是否内容一致（用于还原按钮状态）。 */
function externalStateEquals(left, right) {
  return JSON.stringify(normalizeExternalToolPluginState(left)) === JSON.stringify(normalizeExternalToolPluginState(right));
}

/** 从 agent 会话头解析项目工作区根目录。 */
function workspaceOfAgent(agent) {
  try {
    const header = agent?.session?.header;
    if (header !== null && header !== undefined && typeof header === "object" && typeof header.cwd === "string") {
      return header.cwd;
    }
  } catch {
    // fall through
  }
  return process.cwd();
}

/** 归一化任意来源（组合行 config / settings 解析值）的配置。 */
function normalizeConfig(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const managed = Array.isArray(value.managedPlugins)
    ? value.managedPlugins.filter((id) => typeof id === "string" && id.trim().length > 0).map((id) => id.trim())
    : MANAGED_PLUGINS.map((plugin) => plugin.id);
  const stringList = (raw, fallback) =>
    Array.isArray(raw)
      ? raw.filter((item) => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
      : [...fallback];
  const toolWhitelist = stringList(value.toolWhitelist, TOOL_WHITELIST);
  const saved = value.savedPluginStates && typeof value.savedPluginStates === "object" ? value.savedPluginStates : {};
  return {
    enabled: value.enabled === true,
    toolWhitelist,
    managedPlugins: managed,
    previousPreset:
      typeof value.previousPreset === "string" && value.previousPreset.trim().length > 0
        ? value.previousPreset.trim()
        : FALLBACK_PRESET_ID,
    savedPluginStates: saved,
  };
}

/** 安全地把任意抛出的值转成可打印字符串。 */
function safeMessage(error) {
  try {
    if (error instanceof Error) return error.message;
    if (error !== null && typeof error === "object" && "message" in error) return String(error.message);
    return String(error);
  } catch {
    return "<不可打印的错误>";
  }
}

export default {
  name: "kaz-mode",
  // systemPrompt：组装层工具面过滤 + 固定提示词挂在瀑布上；connection：面板
  // RPC 通道；tools：外置工具注册动态检测（fiber.name 归因）；settings /
  // roundMinimal 为可选依赖（惰性解析）。
  inject: ["systemPrompt", "connection", "tools"],
  apply(ctx, config = {}) {
    // 组合行 config 作为 base 层；settings.yaml 用户层优先（热重载）。
    const entry = normalizeConfig(config);
    let source = () => entry;

    // config.storageDir 覆盖默认设置文件目录（探针/换机可用），默认 DSH_HOME/storages。
    if (typeof config.storageDir === "string" && config.storageDir.trim().length > 0) {
      STORAGE_DIR = config.storageDir.trim();
      DEFAULTS_FILE = join(STORAGE_DIR, DEFAULTS_FILE_NAME);
    }

    /** 联动事务防重入：一次联动（快照+启用 / 恢复+清空）未结束前不重复触发。 */
    let linking = false;

    /** 当前由客户端告知的活跃会话（用于按会话应用插件状态）。 */
    let activeSession = null;

    // -----------------------------------------------------------------------
    // 外置工具注册动态检测（2026-08 分步实施 · 第二步：只读收集，不改工具面）
    // 仿 plugin-filter：包装 ctx.tools.register，从 this.ctx.fiber.name 拿到
    // “正在注册该工具的插件名”，收集 { pluginName, tools[] }。官方工具也会被
    // 记录（后续步骤由面板按“非官方”过滤）；这里暂不参与任何过滤/落盘。
    // -----------------------------------------------------------------------
    const detectedToolPlugins = new Map();

    /** 记录一次工具注册；pluginName 可能缺失（核心/保留工具），归入 unknown。 */
    function recordDetectedToolPlugin(pluginName, toolName) {
      if (typeof toolName !== "string" || toolName.length === 0) return;
      const key = normalizeExternalKey(pluginName);
      const safeKey = key.length > 0 ? key : "unknown";
      const label = typeof pluginName === "string" && pluginName.length > 0 ? pluginName : safeKey;
      let entry = detectedToolPlugins.get(safeKey);
      if (entry === undefined) {
        entry = { pluginName: label, tools: new Set() };
        detectedToolPlugins.set(safeKey, entry);
      } else if (typeof pluginName === "string" && pluginName.length > 0 && entry.pluginName === safeKey) {
        // 用第一次拿到的可读名补全 unknown 占位
        entry.pluginName = pluginName;
      }
      entry.tools.add(toolName);
    }

    /** 返回检测结果的只读快照（数组，工具名排序）。 */
    function detectedToolPluginsList() {
      return Array.from(detectedToolPlugins.entries())
        .map(([key, entry]) => ({ key, pluginName: entry.pluginName, tools: [...entry.tools].sort() }))
        .sort((left, right) => left.pluginName.localeCompare(right.pluginName));
    }

    /** 返回 computeExternalToolSurface 可直接使用的 detected 映射（key → 工具名数组）。 */
    function detectedToolPluginsForCompute() {
      const out = {};
      for (const [key, entry] of detectedToolPlugins.entries()) {
        out[key] = [...entry.tools];
      }
      return out;
    }

    /** 包装 tools.register：记录调用方插件名 + 工具名（best-effort，失败不影响注册）。 */
    function installToolRegistrationDetector() {
      try {
        const raw = ctx.tools[symbols.original] ?? ctx.tools;
        const originalRegister = raw.register;
        const registerWrapper = function register(definition) {
          try {
            const callerCtx = this !== null && typeof this === "object" ? this.ctx : undefined;
            const pluginName = callerCtx !== null && callerCtx !== undefined && typeof callerCtx === "object"
              ? callerCtx.fiber?.name
              : undefined;
            recordDetectedToolPlugin(pluginName, definition?.name);
          } catch {
            // 记录失败不影响工具注册本身
          }
          return originalRegister.call(this, definition);
        };
        raw.register = registerWrapper;
        ctx.effect(() => () => {
          if (raw.register === registerWrapper) raw.register = originalRegister;
        });
      } catch (error) {
        ctx.logger.warn("[kaz-mode] 外置工具注册检测包装失败：" + safeMessage(error));
      }
    }

    /**
     * settings 服务惰性获取：启动时可能尚未挂载（kaz-mode 只 inject systemPrompt），
     * 所有跨命名空间读写都在调用时解析，避免 apply 阶段一次性捕获到 undefined。
     */
    const getSettings = () => ctx.get("settings");

    // -----------------------------------------------------------------------
    // 联动工具函数
    // -----------------------------------------------------------------------

    /** 当前生效的被管理插件清单（id + 展示名）。 */
    function managedList() {
      const current = source();
      const byId = new Map(MANAGED_PLUGINS.map((plugin) => [plugin.id, plugin.label]));
      const ids = current.managedPlugins.length > 0 ? current.managedPlugins : MANAGED_PLUGINS.map((p) => p.id);
      return ids.map((id) => ({ id, label: byId.get(id) ?? id }));
    }

    /** 读取某个被管理插件的当前状态；未加载（settings 未注册）返回 null。 */
    function readPluginState(pluginId) {
      const settings = getSettings();
      if (settings === undefined) return null;
      try {
        const value = settings.get(settingsNamespace(pluginId));
        if (value === undefined || value === null || typeof value !== "object") return null;
        let user = null;
        try {
          const descriptor = settings.describe().find((item) => item.ns === settingsNamespace(pluginId));
          user = descriptor?.user;
        } catch {
          user = null;
        }
        const userHas = (key) =>
          user !== null && typeof user === "object" && Object.prototype.hasOwnProperty.call(user, key);
        const state = {
          registered: true,
          enabled: value.enabled !== false,
          hadOverride: userHas("enabled"),
        };
        return state;
      } catch (error) {
        ctx.logger.warn(`[kaz-mode] 读取 ${pluginId} 状态失败：${safeMessage(error)}`);
        return null;
      }
    }

    /** 快照全部已加载被管理插件的原始状态（仅供面板/诊断报告展示；纯方案 A 下
     *  不再驱动任何恢复——kaz-mode 不写各插件 settings.yaml）。 */
    async function snapshotPluginStates() {
      const snapshot = {};
      for (const plugin of managedList()) {
        const state = readPluginState(plugin.id);
        if (state === null) continue; // 未加载的插件不参与快照
        snapshot[plugin.id] = { hadOverride: state.hadOverride, enabled: state.enabled };
      }
      return snapshot;
    }

    /** 由会话 id 解析项目工作区根目录（优先从 agents 服务取会话头，失败回退 cwd）。 */
    function resolveSessionCwd(sessionId) {
      if (typeof sessionId === "string" && sessionId.length > 0) {
        try {
          const agents = ctx.get("agents");
          if (agents !== undefined && agents !== null && typeof agents.get === "function") {
            const agent = agents.get(sessionId);
            if (agent !== undefined && agent !== null) return workspaceOfAgent(agent);
          }
        } catch {
          // fall through
        }
      }
      return process.cwd();
    }

    /** 读取某会话的状态文件；返回 { cwd, data }。 */
    function loadSessionData(sessionId) {
      const cwd = resolveSessionCwd(sessionId);
      const data = loadStateFile(cwd, ctx.logger);
      return { cwd, data };
    }

    /** 按会话 id 判断该会话是否 Kaz 模式：经 agents 服务取 agent，用事件优先的
     *  agentPresetOf 判定（与 agentKazEnabled 同源）；读不到时回退全局开关。 */
    function sessionKazEnabledById(sessionId) {
      if (typeof sessionId === "string" && sessionId.length > 0) {
        try {
          const agents = ctx.get("agents");
          if (agents !== undefined && agents !== null && typeof agents.get === "function") {
            const agent = agents.get(sessionId);
            if (agent !== undefined && agent !== null) {
              const preset = agentPresetOf(agent);
              if (typeof preset === "string" && preset.trim().length > 0) return preset === KAZ_PRESET_ID;
            }
          }
        } catch {
          // fall through
        }
      }
      return source().enabled === true;
    }

    /** 计算某会话当前应生效的插件状态 map：专属覆盖 > 当前模式默认。
     *  纯方案 A：此 map 只经 kazMode.pluginConfig / getState.effective 提供给
     *  被管理插件与客户端面板，kaz-mode 不再把它写入任何插件的 settings.yaml。 */
    function effectivePluginStates(data, sessionId, kazEnabled) {
      const mode = kazEnabled ? "kaz" : "nonKaz";
      const defaults = data.defaults?.[mode] ?? {};
      const sessionOverrides = data.sessions?.[sessionId] ?? {};
      const result = {};
      for (const plugin of managedList()) {
        const base = defaults[plugin.id] !== null && typeof defaults[plugin.id] === "object" ? defaults[plugin.id] : {};
        const override = sessionOverrides[plugin.id] !== null && typeof sessionOverrides[plugin.id] === "object" ? sessionOverrides[plugin.id] : {};
        result[plugin.id] = { ...base, ...override };
      }
      return result;
    }

    /**
     * 联动主流程（纯方案 A）：enabled=true（进入 Kaz）→ 仅补录原始状态快照
     * （信息用途）；enabled=false（关闭 / 切走）→ 无操作。被管理插件启停已由
     * 各插件经 kazMode.pluginConfig 按 agent 会话实时读取，无需写 settings.yaml。
     */
    let linkRunPending = false;
    let lastEnabledState = false;
    async function runLinkage() {
      if (linking) {
        linkRunPending = true;
        return;
      }
      linking = true;
      try {
        do {
          linkRunPending = false;
          const current = source();
          const enabledNow = current.enabled === true;
          const entering = enabledNow && !lastEnabledState;
          lastEnabledState = enabledNow;
          if (entering) {
            // 快照 = 开启 Kaz 前被管理插件的原始状态（仅信息展示）。只补录
            // 「尚无快照」的插件，不覆盖已保存的快照。
            const saved = await snapshotPluginStates();
            const settings = getSettings();
            const currentSettings = source();
            const existing =
              currentSettings.savedPluginStates !== null &&
              typeof currentSettings.savedPluginStates === "object"
                ? currentSettings.savedPluginStates
                : {};
            const merged = { ...existing };
            for (const [id, state] of Object.entries(saved)) {
              if (merged[id] === undefined || merged[id] === null) merged[id] = state;
            }
            if (Object.keys(merged).length > 0 && settings !== undefined) {
              await settings.update(NAMESPACE, { savedPluginStates: merged });
            }
            ctx.logger.info(`[kaz-mode] Kaz 模式已开启：插件状态按 agent 会话实时生效（纯方案 A，不再写插件 settings.yaml）。`);
          } else if (enabledNow) {
            ctx.logger.debug(`[kaz-mode] Kaz 模式保持开启。`);
          } else {
            ctx.logger.info(`[kaz-mode] Kaz 模式已关闭：插件回落到各自独立生效配置（纯方案 A）。`);
          }
        } while (linkRunPending);
      } catch (error) {
        ctx.logger.warn(`[kaz-mode] 联动执行失败：${safeMessage(error)}`);
      } finally {
        linking = false;
      }
    }

    // -----------------------------------------------------------------------
    // 预设联动：agent-presets.default 是唯一驱动源
    // -----------------------------------------------------------------------

    /** 读取当前默认 agent preset id；读不到时返回 undefined。 */
    function currentPreset() {
      const settings = getSettings();
      if (settings === undefined) return undefined;
      try {
        const presets = settings.get(PRESETS_NAMESPACE);
        if (presets === undefined || presets === null || typeof presets !== "object") return undefined;
        return typeof presets.default === "string" ? presets.default : undefined;
      } catch (error) {
        ctx.logger.warn(`[kaz-mode] 读取当前预设失败：${safeMessage(error)}`);
        return undefined;
      }
    }

    /**
     * 把 kaz-mode.enabled 同步到给定预设：
     *   - 预设 = kaz   → enabled 置 true（触发插件联动）；
     *   - 预设 ≠ kaz   → enabled 置 false（触发恢复）。
     */
    async function syncEnabledForPreset(preset) {
      const settings = getSettings();
      if (settings === undefined) return;
      const current = source();
      if (preset === KAZ_PRESET_ID && current.enabled !== true) {
        try {
          await settings.update(NAMESPACE, { enabled: true });
          ctx.logger.info(`[kaz-mode] 预设已切换为 kaz → 开启 Kaz 模式。`);
        } catch (error) {
          ctx.logger.warn(`[kaz-mode] 按预设开启失败：${safeMessage(error)}`);
        }
      } else if (preset !== KAZ_PRESET_ID && current.enabled !== false) {
        try {
          await settings.update(NAMESPACE, { enabled: false });
          ctx.logger.info(`[kaz-mode] 预设已切换为 ${preset} → 关闭 Kaz 模式。`);
        } catch (error) {
          ctx.logger.warn(`[kaz-mode] 按预设关闭失败：${safeMessage(error)}`);
        }
      }
    }

    /** 记录最近一个非 kaz 预设（按钮"关闭 Kaz"时切回的目标）。 */
    async function recordPreviousPreset(preset) {
      const settings = getSettings();
      if (settings === undefined || preset === undefined || preset === KAZ_PRESET_ID) return;
      const current = source();
      if (current.previousPreset === preset) return;
      try {
        await settings.update(NAMESPACE, { previousPreset: preset });
      } catch (error) {
        ctx.logger.warn(`[kaz-mode] 记录 previousPreset 失败：${safeMessage(error)}`);
      }
    }

    // -----------------------------------------------------------------------
    // Kaz 工具面：enabled=true 时收敛模型工具面（全部由 kaz-shared 的
    // computeSurface 计算：首阶段 firstRoundTools / 全量 effectiveToolWhitelist）。
    // 组装层过滤工具并固定提示词；执行层拒绝白名单外调用。host 平面监听器
    // 对所有 agent 生效 → 子代理会话同样是 Kaz 工具面。
    // -----------------------------------------------------------------------

    /** 是否为会话型子代理（含 workflow / ralph 派生的子会话）。 */
    function isSubagent(agent) {
      try {
        const depth = agent?.options?.subagentDepth;
        if (typeof depth === "number" && depth > 0) return true;
        const events = agent?.session?.events;
        if (Array.isArray(events)) {
          for (const event of events) {
            if (event !== null && typeof event === "object" && event.type === "subagent/descriptor") return true;
          }
        }
        return false;
      } catch {
        return false;
      }
    }

    /** 该代理此刻是否处于首阶段极简：完全由 round-minimal 服务判定
     *  （它自身按 enabled / 首次工具调用前判断）；服务缺失或禁用 → 无首阶段。 */
    function isMinimalAgent(agent) {
      if (agent === null || agent === undefined || typeof agent !== "object") return false;
      if (isSubagent(agent)) return false;
      const roundMinimal = ctx.get("roundMinimal");
      if (roundMinimal !== undefined && roundMinimal !== null && typeof roundMinimal.isMinimal === "function") {
        try {
          return roundMinimal.isMinimal(agent) === true;
        } catch {
          return false;
        }
      }
      return false;
    }

    // -----------------------------------------------------------------------
    // 会话级解析（方案 A：工具面按 agent 会话计算，不再全局注册/注销）。
    // kaz-memory / kaz-diag 的工具常驻注册；本插件在每个请求的组装/执行层
    // 按 agent 的会话状态决定它们是否进入该会话的工具面——切换对话不再
    // 影响后台正在运行的会话。
    // -----------------------------------------------------------------------

    /** 从 agent 会话头解析原始会话 id（子代理归入父会话）；读不到返回 ""。
     *  与 RPC 使用的会话状态文件键一致（原始 id，不做 sanitize）。 */
    function agentSessionIdOf(agent) {
      try {
        const header = agent?.session?.header;
        if (header !== null && header !== undefined && typeof header === "object") {
          if (typeof header.parentSession === "string" && header.parentSession.trim().length > 0) {
            return header.parentSession;
          }
          if (typeof header.id === "string" && header.id.trim().length > 0) {
            return header.id;
          }
        }
      } catch {
        // fall through
      }
      if (typeof agent?.id === "string" && agent.id.trim().length > 0) return agent.id;
      return "";
    }

    /** 从 agent 会话解析当前生效的 agent preset id（与官方 resolveSessionPreset
     *  同语义）：优先会话事件日志里最后一次 agent-preset/selected——新对话切换
     *  预设只追加事件、不改 header；回退 header（创建时值）；再回退 undefined。 */
    function agentPresetOf(agent) {
      try {
        const session = agent?.session;
        const events = session?.events;
        if (Array.isArray(events)) {
          for (let index = events.length - 1; index >= 0; index -= 1) {
            const event = events[index];
            if (
              event !== null &&
              typeof event === "object" &&
              event.type === "agent-preset/selected" &&
              event.data !== null &&
              typeof event.data === "object" &&
              typeof event.data.agentPreset === "string" &&
              event.data.agentPreset.trim().length > 0
            ) {
              return event.data.agentPreset;
            }
          }
        }
        const header = session?.header;
        if (
          header !== null &&
          header !== undefined &&
          typeof header === "object" &&
          typeof header.agentPreset === "string" &&
          header.agentPreset.trim().length > 0
        ) {
          return header.agentPreset;
        }
      } catch {
        // fall through
      }
      return undefined;
    }

    /** 该 agent 的会话是否为 Kaz 模式：以会话生效 preset（事件优先，官方同语义）
     *  为准（子代理继承父会话）；无显式预设时回退全局开关。 */
    function agentKazEnabled(agent) {
      const preset = agentPresetOf(agent);
      if (typeof preset === "string" && preset.trim().length > 0) return preset === KAZ_PRESET_ID;
      return source().enabled === true;
    }

    /** 读取 agent 会话的生效插件状态 map（专属覆盖 > 该会话所在模式的默认）。 */
    function agentEffectiveStates(agent) {
      const sessionId = agentSessionIdOf(agent);
      if (sessionId.length === 0) return {};
      try {
        const cwd = resolveSessionCwd(sessionId);
        const data = loadStateFile(cwd, ctx.logger);
        return effectivePluginStates(data, sessionId, agentKazEnabled(agent));
      } catch (error) {
        ctx.logger.debug(`[kaz-mode] 读取 agent 会话状态失败：${safeMessage(error)}`);
        return {};
      }
    }

    /**
     * 计算某 agent 此刻的 Kaz 工具面（Set）——全部交给 kaz-shared 的
     * computeSurface：白名单来自 settings（用户优先），再按该 agent 会话的
     * kaz-memory / kaz-diag 生效状态动态剔除对应工具；外置工具插件按
     * factory → 用户默认 → 项目设置 合并后加入（新检测默认开启）；
     * round-minimal 首阶段信号由本插件读取并传入。
     */
    function kazSurfaceFor(agent, current, states) {
      // 统一工具插件数据源：官方 + 外置都走 factory → 用户默认 → 项目设置，
      // 不再读 settings.yaml 的 kaz-mode.toolWhitelist。
      let whitelist;
      try {
        const layers = loadExternalToolPluginLayers(workspaceOfAgent(agent), ctx.logger);
        whitelist = new Set(
          computeToolPluginSurface({
            factory: layers.factory,
            user: layers.user,
            project: layers.project,
            detected: detectedToolPluginsForCompute(),
          }),
        );
      } catch (error) {
        ctx.logger?.debug?.("[kaz-mode] 计算统一工具插件面失败：" + safeMessage(error));
        whitelist = new Set();
      }
      // 状态缺失（undefined）按「禁用」处理（2026-08-21 加固）：只有显式 enabled=true
      // 才保留记忆/诊断工具，避免新对话/未落盘状态被误判为启用。
      if (states["kaz-memory"]?.enabled !== true) {
        for (const tool of MEMORY_TOOLS) whitelist.delete(tool);
      }
      if (states["kaz-diag"]?.enabled !== true) {
        whitelist.delete(DIAG_TOOL);
      }
      const minimalPhase = isMinimalAgent(agent) === true;
      let firstRoundTools = [];
      if (minimalPhase) {
        try {
          const rm = ctx.get("roundMinimal");
          if (rm !== undefined && rm !== null && typeof rm.firstRoundTools === "function") {
            const tools = rm.firstRoundTools();
            if (Array.isArray(tools)) firstRoundTools = tools;
          }
        } catch {
          // 保持空数组（computeSurface 按 kaz-memory 自动解析）
        }
      }
      return computeSurface({
        toolWhitelist: [...whitelist],
        minimalPhase,
        firstRoundTools,
        // firstRoundTools 为空时：kaz-memory 开 → memory_search；关 → pwsh/read/edit
        kazMemoryEnabled: states["kaz-memory"]?.enabled === true,
      });
    }

    /** 非 Kaz 会话：记忆/诊断工具是否可见只取决于该会话的插件开关（其余交还宿主）。
     *  2026-08-21 加固：状态缺失（undefined）按「禁用」处理——原先 `!== false`
     *  会把新对话/未落盘状态的会话误判为启用，导致 kaz-memory 在已关闭时仍注入指引。 */
    function nonKazToolVisible(states, name) {
      if (MEMORY_TOOLS.includes(name)) return states["kaz-memory"]?.enabled === true;
      if (name === DIAG_TOOL) return states["kaz-diag"]?.enabled === true;
      return true;
    }

    /**
     * kazMode 服务（供被管理插件在使用时刻按 agent 会话读取生效配置）：
     *   - kazEnabled(agent)            该 agent 会话是否 Kaz 模式；
     *   - pluginEnabled(agent, pluginId) 该 agent 会话某被管理插件是否启用；
     *   - pluginConfig(agent, pluginId)  该 agent 会话某插件的【完整生效配置】
     *     = 工厂默认 + 当前模式默认(kaz-defaults.json) + 会话专属覆盖(kaz-session-states.json)。
     *     无会话/无覆盖时返回 null，调用方回落到插件自身 settings.yaml。
     *   - toolVisible(agent, name)    该 agent 会话里某工具是否在工具面内；
     *   - surfaceOf(agent)            Kaz 会话的完整工具面（Set）；非 Kaz 返回 null。
     *   - detectedToolPlugins()       动态检测到的工具注册快照（只读，供面板）。
     */
    const kazModeService = {
      kazEnabled: (agent) => agentKazEnabled(agent),
      pluginEnabled: (agent, pluginId) => {
        const states = agentEffectiveStates(agent);
        const state = states[pluginId];
        return state !== null && state !== undefined && typeof state === "object" && state.enabled === true;
      },
      pluginConfig: (agent, pluginId) => {
        if (agent === null || agent === undefined || typeof agent !== "object") return null;
        if (typeof pluginId !== "string" || pluginId.length === 0) return null;
        const states = agentEffectiveStates(agent);
        const state = states[pluginId];
        return state !== null && state !== undefined && typeof state === "object" ? { ...state } : null;
      },
      toolVisible: (agent, name) => {
        // 无 agent / 会话状态缺失时按「不可见」处理（2026-08-21 加固，避免误判为启用）。
        if (agent === null || agent === undefined || typeof agent !== "object") return false;
        const current = source();
        const states = agentEffectiveStates(agent);
        if (agentKazEnabled(agent)) {
          return kazSurfaceFor(agent, current, states).has(name);
        }
        return nonKazToolVisible(states, name);
      },
      surfaceOf: (agent) => {
        if (agent === null || agent === undefined || typeof agent !== "object") return null;
        if (!agentKazEnabled(agent)) return null;
        return kazSurfaceFor(agent, source(), agentEffectiveStates(agent));
      },
      /** 动态检测到的工具注册快照（只读）：[{ key, pluginName, tools[] }]。 */
      detectedToolPlugins: () => detectedToolPluginsList(),
    };
    installToolRegistrationDetector();
    ctx.effect(() => {
      const disposeService = ctx.provide("kazMode", kazModeService);
      return () => {
        if (typeof disposeService === "function") disposeService();
      };
    }, "kaz-mode: 发布 kazMode 会话工具面服务");

    // 组装层：按 agent 会话过滤工具列表。
    //   Kaz 会话：工具面 = kazSurfaceFor（白名单 - 该会话禁用的记忆/诊断工具，
    //   首阶段仅 firstRoundTools）；系统提示词已交给 kaz 预设的
    //   kaz-system-prompt.mjs 控制，本插件不再收敛/改写 sections。
    //   非 Kaz 会话：只移除该会话禁用的记忆/诊断工具（kaz-memory/kaz-diag 的
    //   工具常驻注册，标准模式不能露出），其余工具交还宿主标准工具面。
    //   每个请求组装时实时计算 → 后台运行的会话不受切换对话影响。
    ctx.on("system-prompt/assemble", function (assembly, context, next) {
      const current = source();
      const agent = context?.agent;
      const hasAgent = agent !== null && agent !== undefined && typeof agent === "object";
      const kazEnabled = hasAgent ? agentKazEnabled(agent) : current.enabled === true;

      if (kazEnabled) {
        const states = hasAgent ? agentEffectiveStates(agent) : {};
        const allowed = kazSurfaceFor(agent, current, states);
        assembly.tools = assembly.tools.filter((tool) => {
          if (tool === null || typeof tool !== "object") return false;
          return allowed.has(tool.name);
        });
        return next();
      }

      // 非 Kaz 会话：仅剔除该会话禁用的记忆/诊断工具。
      // 状态缺失按禁用处理（`!== true`），与新会话判定保持一致。
      if (hasAgent) {
        const states = agentEffectiveStates(agent);
        const remove = new Set();
        if (states["kaz-memory"]?.enabled !== true) {
          for (const tool of MEMORY_TOOLS) remove.add(tool);
        }
        if (states["kaz-diag"]?.enabled !== true) {
          remove.add(DIAG_TOOL);
        }
        if (remove.size > 0) {
          assembly.tools = assembly.tools.filter((tool) => {
            if (tool === null || typeof tool !== "object") return true;
            return !remove.has(tool.name);
          });
        }
      }
      return next();
    });

    // 执行层：按 agent 会话拒绝工具面外调用（纵深防御）。内部调用（无 agent）
    // 放行，避免误伤宿主侧的程序化调用。
    ctx.on("tools/pre-execute", (exec, next) => {
      const agent = exec?.agent;
      if (agent === null || agent === undefined || typeof agent !== "object") return next();
      const name = exec?.name;
      if (typeof name !== "string") return next();
      const current = source();
      const states = agentEffectiveStates(agent);

      if (agentKazEnabled(agent)) {
        if (!kazSurfaceFor(agent, current, states).has(name)) {
          ctx.logger.info(`[kaz-mode] 拒绝调用工具 "${name}"（不在该会话 Kaz 工具面内）`);
          return {
            kind: "deny",
            reason:
              `工具 "${name}" 不在本会话 Kaz 模式工具面内（toolWhitelist + 已启用记忆/诊断插件）。` +
              `如需使用，请在 settings.yaml 的 kaz-mode.toolWhitelist 中放行（首次工具调用前仅 round-minimal 首轮工具集）。`,
          };
        }
        return next();
      }

      // 非 Kaz 会话：记忆/诊断工具按会话开关拒绝（常驻注册但该会话不可用）。
      if (MEMORY_TOOLS.includes(name) && states["kaz-memory"]?.enabled === false) {
        ctx.logger.info(`[kaz-mode] 拒绝调用工具 "${name}"（本会话 kaz-memory 已关闭）`);
        return {
          kind: "deny",
          reason: `工具 "${name}" 在本会话不可用（kaz-memory 已关闭）；如需使用请在本会话的 Kaz 面板开启 kaz-memory。`,
        };
      }
      if (name === DIAG_TOOL && states["kaz-diag"]?.enabled === false) {
        ctx.logger.info(`[kaz-mode] 拒绝调用工具 "${name}"（本会话 kaz-diag 已关闭）`);
        return {
          kind: "deny",
          reason: `工具 "${name}" 在本会话不可用（kaz-diag 已关闭）；如需使用请在本会话的 Kaz 面板开启 kaz-diag。`,
        };
      }
      return next();
    });

    // -----------------------------------------------------------------------
    // settings 注册（放到所有变量/函数定义之后：ctx.inject 可能同步回调，
    // 其 onChange 会调用 handleChange，必须保证闭包变量已初始化）。
    // -----------------------------------------------------------------------
    function handleChange() {
      runLinkage();
      const current = source();
      ctx.logger.info(`[kaz-mode] 配置已生效：enabled=${current.enabled}`);
    }

    installSettingsWithDefaults(ctx, NAMESPACE, SETTINGS_SCHEMA, entry, DEFAULT_SECTION, {
      setSource: (getValue) => {
        source = () => normalizeConfig(getValue());
      },
      onChange: () => handleChange(),
    });

    // 自愈补充：agent-presets.default 缺失时自动设为 kaz（镜像作者 settings.yaml，
    // 朋友的机器一启动就默认进入 Kaz 预设）。该命名空间由宿主 agent-presets
    // 插件注册，启动竞态下可能晚于本插件——按退避重试；用户已有 default 值时
    // 绝不覆盖。
    let presetSeeded = false;
    const seedDefaultPreset = () => {
      if (presetSeeded) return;
      const settings = getSettings();
      if (settings === undefined) return;
      try {
        const ap = settings.describe().find((item) => item.ns === PRESETS_NAMESPACE);
        const apUser = ap !== undefined && ap.user !== null && typeof ap.user === "object" ? ap.user : {};
        if (Object.prototype.hasOwnProperty.call(apUser, "default")) {
          presetSeeded = true;
          return;
        }
        const write = settings.update(PRESETS_NAMESPACE, { default: KAZ_PRESET_ID });
        if (write !== null && typeof write.then === "function") {
          void write.then(
            () => {
              presetSeeded = true;
              ctx.logger?.info?.("[kaz-mode] agent-presets.default 缺失，已自动设为 kaz");
            },
            (error) => {
              ctx.logger?.warn?.("[kaz-mode] 自动设置默认预设失败：" + (error instanceof Error ? error.message : String(error)));
            },
          );
        } else {
          presetSeeded = true;
        }
      } catch (error) {
        // 命名空间尚未注册：稍后重试。
        ctx.logger?.debug?.("[kaz-mode] 默认预设自愈暂不可用（agent-presets 命名空间未注册）");
      }
    };
    for (const delay of [0, 50, 200, 500, 1000, 2000, 5000, 10000, 20000, 30000]) {
      setTimeout(seedDefaultPreset, delay);
    }

    handleChange();

    // 默认预设监听：agent-presets.default 只作为“新建下一个会话”的默认值，
    // 不驱动当前会话/当前面板。因此这里只维护 previousPreset，不再同步
    // kaz-mode.enabled（否则改设置里的默认预设会连带改当前会话和插件面板）。
    ctx.on("settings/updated", (ns, next, prev) => {
      try {
        if (ns !== PRESETS_NAMESPACE) return;
        const nextPreset = next !== null && typeof next === "object" ? next.default : undefined;
        const prevPreset = prev !== null && typeof prev === "object" ? prev.default : undefined;
        if (typeof nextPreset === "string") {
          if (nextPreset !== KAZ_PRESET_ID) {
            recordPreviousPreset(nextPreset);
          } else if (typeof prevPreset === "string" && prevPreset !== KAZ_PRESET_ID) {
            recordPreviousPreset(prevPreset);
          }
        }
      } catch (error) {
        ctx.logger.warn(`[kaz-mode] 默认预设监听处理失败：${safeMessage(error)}`);
      }
    });

    // 会话级预设联动：新对话框（空白会话）切换预设时（预设选择器 select 提交后
    // 宿主重发的 agent-preset/selected）同步 kaz-mode.enabled。
    ctx.on("agent-preset/selected", (_sessionId, agentPreset) => {
      if (typeof agentPreset !== "string") return;
      void syncEnabledForPreset(agentPreset);
    });

    // 启动时同步：只在还没有活跃会话时用默认预设初始化 kaz-mode.enabled；
    // 若已有当前会话，则交给会话自己的 agentPreset 驱动，避免默认预设覆盖当前会话。
    let startupSynced = false;
    const syncStartupOnce = () => {
      if (startupSynced) return;
      if (activeSession !== null) {
        startupSynced = true;
        return;
      }
      const preset = currentPreset();
      if (preset === undefined) return;
      startupSynced = true;
      void syncEnabledForPreset(preset);
    };
    for (const delay of [0, 50, 200, 500, 1000, 2000, 5000, 10000, 20000, 30000]) {
      setTimeout(syncStartupOnce, delay);
    }

    // -----------------------------------------------------------------------
    // 面板 RPC 通道（/kaz-mode，loopback）：会话级插件状态读写与默认设置管理
    // -----------------------------------------------------------------------
    function rpcFail(message) {
      return { ok: false, error: { code: "internal", message: String(message), details: {} } };
    }
    const rpcHandler = async (endpoint, payload) => {
      try {
        const input = payload !== null && typeof payload === "object" ? payload : {};
        const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
        if (
          sessionId.length === 0 &&
          endpoint !== "resetDefault" &&
          endpoint !== "getState" &&
          endpoint !== "setDefaultPlugin" &&
          endpoint !== "getVersion" &&
          endpoint !== "listToolPlugins" &&
          endpoint !== "getExternalToolPlugins" &&
          endpoint !== "setExternalToolPlugin" &&
          endpoint !== "resetExternalToolPlugins"
        ) {
          return rpcFail("缺少 sessionId");
        }

        /** 外置工具插件端点统一解析项目 cwd：显式 cwd > 会话 cwd > 活跃会话 > 进程 cwd。 */
        const resolveExternalCwd = () => {
          if (typeof input.cwd === "string" && input.cwd.trim().length > 0) return input.cwd.trim();
          if (sessionId.length > 0) return resolveSessionCwd(sessionId);
          if (activeSession !== null && activeSession !== undefined) return activeSession.cwd;
          return process.cwd();
        };

        if (endpoint === "getState") {
          const cwd = sessionId.length > 0 ? resolveSessionCwd(sessionId) : activeSession !== null ? activeSession.cwd : process.cwd();
          const data = loadStateFile(cwd, ctx.logger);
          if (sessionId.length > 0) activeSession = { sessionId, cwd };
          // 会话自己的 Kaz 状态（事件优先判定，与面板/组装层同源），不是全局开关。
          const kazEnabled = sessionKazEnabledById(sessionId);
          // 直接算好每个被管理插件的生效 enabled（工厂+模式默认+会话覆盖），
          // 供 kaz-memory / round-display 客户端面板判断显隐，无需各自重复计算。
          const effective = effectivePluginStates(data, sessionId, kazEnabled);
          const effectiveEnabled = {};
          for (const [pid, st] of Object.entries(effective)) {
            effectiveEnabled[pid] = { enabled: st !== null && typeof st === "object" ? st.enabled !== false : false };
          }
          return {
            ok: true,
            value: {
              sessionId,
              cwd,
              kazEnabled,
              defaults: data.defaults,
              session: data.sessions[sessionId] || null,
              effective: effectiveEnabled,
              factory: {
                nonKaz: deepClone(FACTORY_NON_KAZ_DEFAULTS),
                kaz: deepClone(FACTORY_KAZ_DEFAULTS),
              },
            },
          };
        }

        if (endpoint === "getVersion") {
          // 本机已安装的 Kaz 模式版本：读插件目录下 package.json 的 version 字段。
          try {
            if (!existsSync(PACKAGE_JSON_FILE)) {
              return rpcFail("package.json 不存在：" + PACKAGE_JSON_FILE);
            }
            let raw = readFileSync(PACKAGE_JSON_FILE, "utf8");
            if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
            const parsed = JSON.parse(raw);
            const version =
              parsed !== null && typeof parsed === "object" && typeof parsed.version === "string"
                ? parsed.version.trim()
                : "";
            if (version.length === 0) {
              return rpcFail("package.json 缺少 version 字段");
            }
            return { ok: true, value: { version } };
          } catch (error) {
            return rpcFail("读取 package.json 版本失败：" + safeMessage(error));
          }
        }

        if (endpoint === "listToolPlugins") {
          // 动态检测到的工具注册快照（只读，供 Kaz 面板后续展示/管理）。
          return { ok: true, value: { plugins: detectedToolPluginsList() } };
        }

        if (endpoint === "getExternalToolPlugins") {
          const cwd = resolveExternalCwd();
          const layers = loadExternalToolPluginLayers(cwd, ctx.logger);
          return {
            ok: true,
            value: {
              cwd,
              factory: layers.factory,
              user: layers.user,
              project: layers.project,
              effective: layers.effective,
              userEffective: layers.userEffective,
              projectDiffers: !externalStateEquals(layers.project, layers.user),
              userDiffersFactory: !externalStateEquals(layers.user, layers.factory),
            },
          };
        }

        if (endpoint === "setExternalToolPlugin") {
          const layer = input.layer === "user" || input.layer === "project" ? input.layer : null;
          const pluginName = typeof input.pluginName === "string" ? input.pluginName : "";
          if (layer === null || pluginName.length === 0) return rpcFail("缺少 layer 或 pluginName");
          const cwd = resolveExternalCwd();
          const current = layer === "user"
            ? loadExternalUserDefaults(ctx.logger)
            : loadExternalProjectState(cwd, ctx.logger);
          let next = current;
          if (input.restore === true) {
            next = restoreExternalPlugin(current, pluginName);
          } else if (typeof input.ignored === "boolean") {
            next = setExternalPluginIgnored(current, pluginName, input.ignored);
          } else if (typeof input.toolName === "string" && input.toolName.length > 0) {
            if (input.remove === true) {
              next = removeExternalPluginTool(current, pluginName, input.toolName);
            } else if (typeof input.toolHidden === "boolean") {
              next = setExternalPluginToolHidden(current, pluginName, input.toolName, input.toolHidden);
            } else if (typeof input.enabled === "boolean") {
              next = setExternalPluginTool(current, pluginName, input.toolName, input.enabled);
            } else {
              return rpcFail("缺少 enabled/remove/toolHidden");
            }
          } else {
            return rpcFail("缺少 toolName 或 restore/ignored 操作");
          }
          if (layer === "user") saveExternalUserDefaults(next, ctx.logger);
          else saveExternalProjectState(cwd, next, ctx.logger);
          const layers = loadExternalToolPluginLayers(cwd, ctx.logger);
          return {
            ok: true,
            value: {
              cwd,
              user: layers.user,
              project: layers.project,
              effective: layers.effective,
              userEffective: layers.userEffective,
              projectDiffers: !externalStateEquals(layers.project, layers.user),
              userDiffersFactory: !externalStateEquals(layers.user, layers.factory),
            },
          };
        }

        if (endpoint === "resetExternalToolPlugins") {
          const layer = input.layer === "user" || input.layer === "project" ? input.layer : null;
          if (layer === null) return rpcFail("缺少 layer");
          const cwd = resolveExternalCwd();
          if (layer === "user") saveExternalUserDefaults(emptyExternalToolPluginState(), ctx.logger);
          else saveExternalProjectState(cwd, emptyExternalToolPluginState(), ctx.logger);
          const layers = loadExternalToolPluginLayers(cwd, ctx.logger);
          return {
            ok: true,
            value: {
              cwd,
              user: layers.user,
              project: layers.project,
              effective: layers.effective,
              userEffective: layers.userEffective,
              projectDiffers: !externalStateEquals(layers.project, layers.user),
              userDiffersFactory: !externalStateEquals(layers.user, layers.factory),
            },
          };
        }

        if (endpoint === "applySession") {
          // 纯方案 A：只需记录活跃会话；插件在使用时刻经 kazMode.pluginConfig
          // 按 agent 会话实时读取生效状态，无需写任何插件 settings.yaml。
          const { cwd, data } = loadSessionData(sessionId);
          activeSession = { sessionId, cwd };
          return { ok: true, value: { applied: true, sessionId } };
        }

        if (endpoint === "setSessionPlugin") {
          const pluginId = typeof input.pluginId === "string" ? input.pluginId : "";
          const patch = input.patch !== null && typeof input.patch === "object" ? input.patch : null;
          if (pluginId.length === 0 || patch === null) return rpcFail("缺少 pluginId 或 patch");
          const { cwd, data } = loadSessionData(sessionId);
          if (data.sessions[sessionId] === undefined || data.sessions[sessionId] === null) {
            data.sessions[sessionId] = {};
          }
          if (data.sessions[sessionId][pluginId] === undefined || data.sessions[sessionId][pluginId] === null) {
            data.sessions[sessionId][pluginId] = {};
          }
          const merged = { ...data.sessions[sessionId][pluginId] };
          for (const [key, value] of Object.entries(patch)) {
            if (value === null) {
              delete merged[key];
            } else {
              merged[key] = value;
            }
          }
          if (Object.keys(merged).length === 0) {
            delete data.sessions[sessionId][pluginId];
          } else {
            data.sessions[sessionId][pluginId] = merged;
          }
          saveSessions(cwd, data.sessions, ctx.logger);
          activeSession = { sessionId, cwd };
          return { ok: true, value: { session: data.sessions[sessionId] } };
        }

        if (endpoint === "setDefaultPlugin") {
          const mode = input.mode === "nonKaz" || input.mode === "kaz" ? input.mode : null;
          const pluginId = typeof input.pluginId === "string" ? input.pluginId : "";
          const patch = input.patch !== null && typeof input.patch === "object" ? input.patch : null;
          if (mode === null || pluginId.length === 0 || patch === null) return rpcFail("缺少 mode/pluginId/patch");
          const cwd = typeof input.cwd === "string" && input.cwd.trim().length > 0
            ? input.cwd.trim()
            : activeSession !== null
              ? activeSession.cwd
              : process.cwd();
          const data = loadStateFile(cwd, ctx.logger);
          const current = data.defaults[mode]?.[pluginId] !== null && typeof data.defaults[mode]?.[pluginId] === "object" ? data.defaults[mode][pluginId] : {};
          const merged = { ...current };
          for (const [key, value] of Object.entries(patch)) {
            if (value === null) delete merged[key];
            else merged[key] = value;
          }
          if (Object.keys(merged).length === 0) {
            delete data.defaults[mode][pluginId];
          } else {
            data.defaults[mode][pluginId] = merged;
          }
          saveDefaults(data.defaults, ctx.logger);
          const refreshed = loadStateFile(cwd, ctx.logger);
          return { ok: true, value: { defaults: refreshed.defaults } };
        }

        if (endpoint === "setAsDefault") {
          const mode = input.mode === "nonKaz" || input.mode === "kaz" ? input.mode : null;
          if (mode === null) return rpcFail("mode 必须是 nonKaz 或 kaz");
          const { cwd, data } = loadSessionData(sessionId);
          // "当前对话的插件状态" = 有效状态（专属覆盖 > 该会话当前模式默认）。
          // 用会话自身预设（事件优先）计算，避免把上一个会话的模式带进来。
          const effective = effectivePluginStates(data, sessionId, sessionKazEnabledById(sessionId));
          data.defaults[mode] = deepClone(effective);
          saveDefaults(data.defaults, ctx.logger);
          activeSession = { sessionId, cwd };
          return { ok: true, value: { defaults: data.defaults } };
        }

        if (endpoint === "resetDefault") {
          const mode = input.mode === "nonKaz" || input.mode === "kaz" ? input.mode : null;
          if (mode === null) return rpcFail("mode 必须是 nonKaz 或 kaz");
          const cwd = typeof input.cwd === "string" && input.cwd.trim().length > 0
            ? input.cwd.trim()
            : sessionId.length > 0
              ? resolveSessionCwd(sessionId)
              : process.cwd();
          const data = loadStateFile(cwd, ctx.logger);
          data.defaults[mode] = deepClone(mode === "kaz" ? FACTORY_KAZ_DEFAULTS : FACTORY_NON_KAZ_DEFAULTS);
          saveDefaults(data.defaults, ctx.logger);
          if (sessionId.length > 0) {
            activeSession = { sessionId, cwd };
          }
          return { ok: true, value: { defaults: data.defaults } };
        }

        if (endpoint === "clearSession") {
          // 清除某会话的全部专属覆盖 → 生效状态回落到当前模式默认
          // （Kaz 会话回落到 Kaz 默认，非 Kaz 会话回落到非 Kaz 默认）。
          const { cwd, data } = loadSessionData(sessionId);
          delete data.sessions[sessionId];
          saveSessions(cwd, data.sessions, ctx.logger);
          activeSession = { sessionId, cwd };
          return { ok: true, value: { session: data.sessions[sessionId] ?? null } };
        }

        if (endpoint === "clearSessionPlugin") {
          // 清除某会话里单个插件的专属覆盖（该插件回落到当前模式默认）。
          const pluginId = typeof input.pluginId === "string" ? input.pluginId : "";
          if (pluginId.length === 0) return rpcFail("缺少 pluginId");
          const { cwd, data } = loadSessionData(sessionId);
          if (data.sessions[sessionId] !== undefined && data.sessions[sessionId] !== null && typeof data.sessions[sessionId] === "object") {
            delete data.sessions[sessionId][pluginId];
            if (Object.keys(data.sessions[sessionId]).length === 0) {
              delete data.sessions[sessionId];
            }
            saveSessions(cwd, data.sessions, ctx.logger);
          }
          activeSession = { sessionId, cwd };
          return { ok: true, value: { session: data.sessions[sessionId] ?? null } };
        }

        if (endpoint === "forgetSession") {
          // 对话归档/删除时清理 kaz-session-states.json 里该会话的条目（2026-08-21）。
          // 与 clearSession 不同：只删状态文件条目，不应用插件状态、不改 activeSession。
          // cwd 由客户端随会话 summary 上报；缺失时经 agents 服务推断（归档会话通常
          // 仍存活可解析），实在找不到回退 process.cwd()。
          const cwd = typeof input.cwd === "string" && input.cwd.trim().length > 0
            ? input.cwd.trim()
            : resolveSessionCwd(sessionId);
          const data = loadStateFile(cwd, ctx.logger);
          if (data.sessions[sessionId] !== undefined && data.sessions[sessionId] !== null) {
            delete data.sessions[sessionId];
            saveSessions(cwd, data.sessions, ctx.logger);
            ctx.logger.info(`[kaz-mode] 已清理归档/删除会话 ${sessionId} 的 kaz-session-states 条目`);
          }
          return { ok: true, value: { purged: true, sessionId } };
        }

        return rpcFail("unknown endpoint '" + String(endpoint) + "'");
      } catch (error) {
        ctx.logger.warn(
          "[kaz-mode] RPC " + String(endpoint) + " 失败：" + (error instanceof Error ? error.message : String(error)),
        );
        return rpcFail(error instanceof Error ? error.message : String(error));
      }
    };
    const connection = ctx.get("connection");
    if (
      connection !== undefined &&
      connection !== null &&
      connection.rpc !== undefined &&
      typeof connection.rpc.handle === "function"
    ) {
      const disposeRpc = connection.rpc.handle(RPC_CHANNEL, rpcHandler, { authority: "loopback" });
      ctx.effect(() => () => {
        void disposeRpc();
      });
    } else {
      ctx.logger.warn("[kaz-mode] connection 服务不可用，面板 RPC 通道未注册（仅设置页可用）");
    }
  },
};
