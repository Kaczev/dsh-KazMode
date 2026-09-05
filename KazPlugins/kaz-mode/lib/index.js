// kaz-mode
// ===========================================================================
// 「Kaz 模式」超级模式插件 —— 统一管理并联动本工作区插件：
//   plugin-filter（工具过滤 · 已收编 kaz-shared/preset）、output-beep（提示音）、
//   round-display（注入显示）、deepseek-default-model（DeepSeek 采样参数）、
//   ka-whale-memory（独立记忆组件）、ka-whale-workflow（工作流），
//   并提供集中管理面板与头部开关按钮（客户端半）。
//   36.9：round-minimal 已删除；首阶段极简与工具面变化上报已收编进本插件核心。
//
// Kaz 模式的语义（Kaz 5.0 Step 1 后；v0.8 Step B1 移除原生 Plan）：
//   1) 系统提示词由 kaz 预设的 kaz-system-prompt.mjs 收敛为 DeepSeek 基础提示词
//      （逐字、最前；不再按记忆插件开关切换 persona 变体；不再注入 plan/goal
//      system 段）。角色特化段固定存放于 kaz-shared 的 KAZ_ROLE_PROMPTS；本插件
//      不再负责系统提示词。
//   2) 工具面两阶段（v0.8 Step A 固定集，工具清单由 kaz-shared 的 tool-lists.js 管理；
//      36.9 round-minimal 已删除，本插件直接拥有首阶段 Minimal）：
//        - 首次工具调用前：仅保留首轮工具集（≤2）；
//        - 首次工具调用后：Stable Main Surface = KAZ_STABLE_MAIN_TOOLS（v0.9
//          §1.1 固定 20 项，M6 版本边界新增只读树检索工具 whale_expand；
//          不含旧 subagent/create_goal）。
//          不再恢复“工具面板 JSON 全量”；旧 JSON 只作兼容读；纯
//          minimal → Stable Main 一次变化（原生 Plan 例外已删除）。
//        - v0.9 B5：ka-whale-memory / ka-whale-workflow 在 Kaz 恒开，固定面完整；
//          非 Kaz 模式仍按项目状态决定这些组件是否启用。
//   3) 插件联动：只有 kaz-mode.enabled 变为 true（进入 Kaz）时，先快照被管理
//      插件的原始 enabled 状态到 kaz-mode.savedPluginStates（供状态报告展示），
//      再按项目/默认状态应用（同一项目内所有会话共享）。变为 false（关闭 / 切走）
//      时按项目/非 Kaz 默认状态应用。
//   4) 预设联动：Kaz 模式已注册为 agent preset（id: kaz）。default 切到 "kaz"
//      或会话切换到 kaz 时把 kaz-mode.enabled 置 true（触发上面的插件联动）；
//      切到其它预设 / 其它会话时置 false。同时把最近一个非 kaz 预设记录到
//      kaz-mode.previousPreset，供按钮"关闭"时切回。
//   5) 本插件不注册任何 systemPrompt 段，也不触碰系统提示词；系统提示词由
//      kaz 预设的 kaz-system-prompt.mjs 负责。
// ===========================================================================

import z from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import {
  DEFAULT_DISABLED_TOOLS,
  MANAGED_PLUGINS,
  MEMORY_TOOLS,
  MANAGED_CARRIER_TOOLS,
  computeSurface,
  normalizeExternalKey,
  normalizePluginEnableDict,
  normalizeToolCatalog,
  mergePluginEnableDicts,
  mergeToolCatalogs,
  buildToolUniverse,
  computeEffectiveToolState,
  computeToolPluginSurfaceFromEffective,
  computeToolPluginSurface,
  TOOL_PLUGIN_CATALOG,
  TOOL_PLUGINS,
  OFFICIAL_TOOL_PLUGIN_KEYS,
  KAZ_TOOL_PLUGIN_KEYS,
  KAZ_STABLE_MAIN_TOOLS,
  KAZ_SUBAGENT_BASE_TOOLS,
  stableMainSurface,
  stableSubagentSurface,
  AGENT_MANAGED_STORAGE_FILE,
  PRIVATE_PLUGIN_CANDIDATE_VERSION,
  normalizeAgentManagedCandidateRegistry,
  normalizePrivatePluginCandidate,
  upsertPrivatePluginCandidate,
  agentManagedPluginKeys,
  agentManagedToolNames,
  agentManagedRegistryHasPlugin,
  mergeAgentManagedToolsIntoSurface,
  KAZ_V09_TOOL_JOBS,
  V09_SUBAGENT_ROLE_MINIMAL_TOOLS,
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
 * Kaz 工具面全部交给 kaz-shared（lib/tool-lists.js）管理：出厂默认 /
 * 工具插件状态模型 / 工具面计算都来自 kaz-shared；kaz-memory 的工具按
 * agent 会话开关随 enabled 加入/排除。本插件只负责读工具插件三层 JSON
 * 并在组装层/执行层应用 computeSurface 的结果。
 */

/** 出厂默认（非 Kaz 模式）：Kaz 插件初始默认全关。 */
const FACTORY_NON_KAZ_DEFAULTS = {
  "plugin-filter": {
    enabled: false,
    mode: "remove",
    disabledTools: [...DEFAULT_DISABLED_TOOLS],
  },
  "output-beep": { enabled: false, includeSubagents: false, frequency: 1000, duration: 300 },
  "round-display": { enabled: false },
  "deepseek-default-model": {
    enabled: false,
    generation_kwargs: { temperature: 0.6, top_p: 0.95, repetition_penalty: 1.2 },
  },
  "ka-whale-memory": { enabled: false, guidance: "", guidanceHeadEnabled: true, guidanceHead: "", guidanceForgetEnabled: true, guidanceForget: "" },
  "ka-whale-workflow": {
    enabled: false,
    includeSubagents: false,
    skillPrivateRoot: "",
    skillAutoLifecycleEnabled: true,
    skillLifecycleUnusedDays: 60,
    skillLifecyclePendingDays: 7,
    skillLifecycleAuditIntervalHours: 24,
    skillLifecycleMaxAutoActions: 1,
  },
};

/** 出厂默认（Kaz 模式）：Kaz 插件初始默认全开。 */
/** 默认不开启kaz-memory的guidanceHeadEnabled，因为有系统提示词 */
const FACTORY_KAZ_DEFAULTS = {};
for (const [id, cfg] of Object.entries(FACTORY_NON_KAZ_DEFAULTS)) {
  FACTORY_KAZ_DEFAULTS[id] = { ...cfg, enabled: true };
  if (id === "round-display") {
    FACTORY_KAZ_DEFAULTS[id].enabled = false;
  }
  if (id === "ka-whale-memory") {
    FACTORY_KAZ_DEFAULTS[id].guidanceHeadEnabled = false;
  }
}

/** 项目级插件状态文件名（放在项目 .dsh/storages/ 下，同一项目所有对话共享）。 */
const PROJECT_STATES_FILE = "kaz-project-states.json";
/** 两个模式的默认设置文件名（放在 DSH_HOME/storages 下，缺省 ~/.dsh/storages）。
 *  2026-08-21 修复：原实现硬编码为作者机器的 C:\Users\Kaczev\.dsh\storages，
 *  换机/分享时读写会落到错误路径；现在用 DSH_HOME 解析，并支持 config.storageDir 覆盖。 */
const DEFAULTS_FILE_NAME = "kaz-defaults.json";
let STORAGE_DIR = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "storages");
let DEFAULTS_FILE = join(STORAGE_DIR, DEFAULTS_FILE_NAME);
/** 用户目录：默认“插件启用”字典。 */
const USER_ENABLE_TOOL_PLUGIN_FILE = "tool-plugin.json";
/** 用户目录：默认“工具开关”字典。 */
const USER_TOOL_PLUGIN_CATALOG_FILE = "tool-plugin-catalog.json";
/** 用户目录：用户手动添加的“插件启用”字典（共享到所有项目；恢复原设置时全部置 true）。 */
const USER_OTHER_ENABLE_TOOL_PLUGIN_FILE = "other-tool-plugin.json";
/** 用户目录：用户手动添加的“工具开关”字典（共享到所有项目；恢复原设置时全部置 true）。 */
const USER_OTHER_TOOL_PLUGIN_CATALOG_FILE = "other-tool-plugin-catalog.json";

/** 项目目录：与用户目录同名的四个文件（外置插件/工具的专属开关写项目 other-*，官方/Kaz 写项目 tool-plugin 文件）。 */
const PROJECT_ENABLE_TOOL_PLUGIN_FILE = USER_ENABLE_TOOL_PLUGIN_FILE;
const PROJECT_TOOL_PLUGIN_CATALOG_FILE = USER_TOOL_PLUGIN_CATALOG_FILE;
const PROJECT_OTHER_ENABLE_TOOL_PLUGIN_FILE = USER_OTHER_ENABLE_TOOL_PLUGIN_FILE;
const PROJECT_OTHER_TOOL_PLUGIN_CATALOG_FILE = USER_OTHER_TOOL_PLUGIN_CATALOG_FILE;

/** 面板专用 RPC 通道。 */
const RPC_CHANNEL = "/kaz-mode";

/** kaz-mode 插件根目录与 package.json（本机已安装版本的单一事实源）。 */
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_JSON_FILE = join(PLUGIN_ROOT, "package.json");

/** 设置 schema（同时驱动设置页 UI 与客户端面板的字段读写）。 */
const SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(false),
  managedPlugins: z.array(z.string()).default(MANAGED_PLUGINS.map((plugin) => plugin.id)),
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
// 项目级插件状态持久化（.dsh/storages/kaz-project-states.json）
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

/** 规范化插件状态 map：只保留对象值；旧键 kaz-memory 归一化到 ka-whale-memory（改名兼容读）。 */
function normalizePluginMap(raw) {
  const result = {};
  if (raw === null || typeof raw !== "object") return result;
  for (const [rawId, value] of Object.entries(raw)) {
    if (value === null || typeof value !== "object") continue;
    const id = normalizeExternalKey(rawId);
    if (id.length === 0) continue;
    if (result[id] !== undefined) {
      result[id] = { ...result[id], ...value };
    } else {
      result[id] = value;
    }
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

/** 项目状态文件路径：<项目>/.dsh/storages/kaz-project-states.json（与 kaz-memory
 *  的 memory_project.json 同目录约定；2026-08 起改为按项目隔离，不再读取按对话的
 *  kaz-session-states.json）。 */
function projectStatesPath(cwd) {
  return join(cwd, ".dsh", "storages", PROJECT_STATES_FILE);
}

/** 读取项目目录下的项目专属状态；不存在或损坏时返回空对象。
 *  旧键 kaz-memory 会经 normalizePluginMap 归一化到 ka-whale-memory。 */
function loadProjectStates(cwd, logger) {
  try {
    const file = projectStatesPath(cwd);
    if (!existsSync(file)) return {};
    let raw = readFileSync(file, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return {};
    const states = parsed.states !== null && typeof parsed.states === "object" ? parsed.states : {};
    return normalizePluginMap(states);
  } catch (error) {
    logger?.warn?.("[kaz-mode] 读取项目状态文件失败：" + safeMessage(error));
    return {};
  }
}

/** 写回项目目录下的项目专属状态（.dsh/storages/）。 */
function saveProjectStates(cwd, states, logger) {
  const dir = join(cwd, ".dsh", "storages");
  const file = join(dir, PROJECT_STATES_FILE);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, states }, null, 2) + "\n", "utf8");
  } catch (error) {
    logger?.warn?.("[kaz-mode] 写入项目状态文件失败：" + safeMessage(error));
  }
}

/** 读取完整状态：默认设置来自用户 storages，项目专属来自项目目录。 */
function loadStateFile(cwd, logger) {
  return {
    defaults: loadDefaults(logger),
    project: loadProjectStates(cwd, logger),
  };
}

// ---------------------------------------------------------------------------
// 外置工具插件四文件模型（2026-08-25 用户新架构）
//   原设置   = 代码 TOOL_PLUGIN_CATALOG / TOOL_PLUGINS
//              + 用户 other-*.json（用户手动添加，共享到所有项目）
//   默认设置 = 用户 tool-plugin.json / tool-plugin-catalog.json
//              + 用户 other-*.json
//   专属设置 = 项目 tool-plugin.json / tool-plugin-catalog.json + 项目 other-*.json
//              （外置插件/工具的专属开关写项目 other-*，官方/Kaz 写项目 tool-plugin 文件）
// ---------------------------------------------------------------------------

/** 安全读取 JSON；不存在/损坏时回退 fallback。 */
function readJsonFile(file, fallback, normalize, logger) {
  try {
    if (!existsSync(file)) return fallback;
    let raw = readFileSync(file, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return normalize(JSON.parse(raw));
  } catch (error) {
    logger?.warn?.("[kaz-mode] 读取 JSON 失败（" + file + "）：" + safeMessage(error));
    return fallback;
  }
}

function userPath(file) {
  return join(STORAGE_DIR, file);
}
function projectPath(cwd, file) {
  return join(cwd, ".dsh", "storages", file);
}

function loadUserEnable(logger) {
  return readJsonFile(userPath(USER_ENABLE_TOOL_PLUGIN_FILE), {}, normalizePluginEnableDict, logger);
}
function loadUserCatalog(logger) {
  return readJsonFile(userPath(USER_TOOL_PLUGIN_CATALOG_FILE), {}, normalizeToolCatalog, logger);
}
function loadUserOtherEnable(logger) {
  return readJsonFile(userPath(USER_OTHER_ENABLE_TOOL_PLUGIN_FILE), {}, normalizePluginEnableDict, logger);
}
function loadUserOtherCatalog(logger) {
  return readJsonFile(userPath(USER_OTHER_TOOL_PLUGIN_CATALOG_FILE), {}, normalizeToolCatalog, logger);
}
function loadProjectEnable(cwd, logger) {
  return readJsonFile(projectPath(cwd, PROJECT_ENABLE_TOOL_PLUGIN_FILE), {}, normalizePluginEnableDict, logger);
}
function loadProjectCatalog(cwd, logger) {
  return readJsonFile(projectPath(cwd, PROJECT_TOOL_PLUGIN_CATALOG_FILE), {}, normalizeToolCatalog, logger);
}
function loadProjectOtherEnable(cwd, logger) {
  return readJsonFile(projectPath(cwd, PROJECT_OTHER_ENABLE_TOOL_PLUGIN_FILE), {}, normalizePluginEnableDict, logger);
}
function loadProjectOtherCatalog(cwd, logger) {
  return readJsonFile(projectPath(cwd, PROJECT_OTHER_TOOL_PLUGIN_CATALOG_FILE), {}, normalizeToolCatalog, logger);
}

/** Agent 管理「自写工具」registry：全局文件路径（DSH_HOME/storages，跨项目共享）。 */
function agentManagedRegistryPath() {
  return join(STORAGE_DIR, AGENT_MANAGED_STORAGE_FILE);
}

/** 读取全局 agent-managed registry；文件缺失/损坏/非法 → 空 registry（feature off）。
 *  v0.9 B4：返回 schema version 2 的完整视图（plugins + private-plugin candidates），
 *  旧文件缺 candidates 时由 normalizeAgentManagedCandidateRegistry 兼容读为空。 */
function loadAgentManagedRegistry(logger) {
  return readJsonFile(
    agentManagedRegistryPath(),
    {},
    normalizeAgentManagedCandidateRegistry,
    logger,
  );
}

/** 写回全局 agent-managed registry（保留 schema version 2 plugins + candidates）。 */
function saveAgentManagedRegistry(registry, logger) {
  try {
    mkdirSync(STORAGE_DIR, { recursive: true });
    const normalized = normalizeAgentManagedCandidateRegistry(registry);
    writeFileSync(
      agentManagedRegistryPath(),
      JSON.stringify(
        {
          version: PRIVATE_PLUGIN_CANDIDATE_VERSION,
          plugins: normalized.plugins,
          candidates: normalized.candidates,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    return true;
  } catch (error) {
    logger?.warn?.("[kaz-mode] 写入 agent-managed registry 失败：" + safeMessage(error));
    return false;
  }
}

/** 向私有插件候选注册表新增/更新一条候选（面板添加通道；只写 candidates 层）。 */
function upsertPrivatePluginCandidateFile(candidate, logger) {
  const current = loadAgentManagedRegistry(logger);
  const normalized = normalizePrivatePluginCandidate(candidate);
  if (normalized === null) return { ok: false, error: "candidate 缺少合法 tool 字段" };
  const next = upsertPrivatePluginCandidate(current, normalized);
  if (!saveAgentManagedRegistry(next, logger)) {
    return { ok: false, error: "无法写入 kaz-agent-managed-tools.json" };
  }
  return { ok: true, registry: next };
}

function saveUserEnable(value, logger) {
  try {
    mkdirSync(STORAGE_DIR, { recursive: true });
    writeFileSync(userPath(USER_ENABLE_TOOL_PLUGIN_FILE), JSON.stringify(normalizePluginEnableDict(value), null, 2) + "\n", "utf8");
  } catch (error) {
    logger?.warn?.("[kaz-mode] 写入用户 tool-plugin.json 失败：" + safeMessage(error));
  }
}
function saveUserCatalog(value, logger) {
  try {
    mkdirSync(STORAGE_DIR, { recursive: true });
    writeFileSync(userPath(USER_TOOL_PLUGIN_CATALOG_FILE), JSON.stringify(normalizeToolCatalog(value), null, 2) + "\n", "utf8");
  } catch (error) {
    logger?.warn?.("[kaz-mode] 写入用户 tool-plugin-catalog.json 失败：" + safeMessage(error));
  }
}
function saveUserOtherEnable(value, logger) {
  try {
    mkdirSync(STORAGE_DIR, { recursive: true });
    writeFileSync(userPath(USER_OTHER_ENABLE_TOOL_PLUGIN_FILE), JSON.stringify(normalizePluginEnableDict(value), null, 2) + "\n", "utf8");
  } catch (error) {
    logger?.warn?.("[kaz-mode] 写入用户 other-tool-plugin.json 失败：" + safeMessage(error));
  }
}
function saveUserOtherCatalog(value, logger) {
  try {
    mkdirSync(STORAGE_DIR, { recursive: true });
    writeFileSync(userPath(USER_OTHER_TOOL_PLUGIN_CATALOG_FILE), JSON.stringify(normalizeToolCatalog(value), null, 2) + "\n", "utf8");
  } catch (error) {
    logger?.warn?.("[kaz-mode] 写入用户 other-tool-plugin-catalog.json 失败：" + safeMessage(error));
  }
}
function saveProjectEnable(cwd, value, logger) {
  try {
    const dir = join(cwd, ".dsh", "storages");
    mkdirSync(dir, { recursive: true });
    writeFileSync(projectPath(cwd, PROJECT_ENABLE_TOOL_PLUGIN_FILE), JSON.stringify(normalizePluginEnableDict(value), null, 2) + "\n", "utf8");
  } catch (error) {
    logger?.warn?.("[kaz-mode] 写入项目 tool-plugin.json 失败：" + safeMessage(error));
  }
}
function saveProjectCatalog(cwd, value, logger) {
  try {
    const dir = join(cwd, ".dsh", "storages");
    mkdirSync(dir, { recursive: true });
    writeFileSync(projectPath(cwd, PROJECT_TOOL_PLUGIN_CATALOG_FILE), JSON.stringify(normalizeToolCatalog(value), null, 2) + "\n", "utf8");
  } catch (error) {
    logger?.warn?.("[kaz-mode] 写入项目 tool-plugin-catalog.json 失败：" + safeMessage(error));
  }
}
function saveProjectOtherEnable(cwd, value, logger) {
  try {
    const dir = join(cwd, ".dsh", "storages");
    mkdirSync(dir, { recursive: true });
    writeFileSync(projectPath(cwd, PROJECT_OTHER_ENABLE_TOOL_PLUGIN_FILE), JSON.stringify(normalizePluginEnableDict(value), null, 2) + "\n", "utf8");
  } catch (error) {
    logger?.warn?.("[kaz-mode] 写入项目 other-tool-plugin.json 失败：" + safeMessage(error));
  }
}
function saveProjectOtherCatalog(cwd, value, logger) {
  try {
    const dir = join(cwd, ".dsh", "storages");
    mkdirSync(dir, { recursive: true });
    writeFileSync(projectPath(cwd, PROJECT_OTHER_TOOL_PLUGIN_CATALOG_FILE), JSON.stringify(normalizeToolCatalog(value), null, 2) + "\n", "utf8");
  } catch (error) {
    logger?.warn?.("[kaz-mode] 写入项目 other-tool-plugin-catalog.json 失败：" + safeMessage(error));
  }
}

function enableEquals(a, b) {
  return JSON.stringify(normalizePluginEnableDict(a)) === JSON.stringify(normalizePluginEnableDict(b));
}
function catalogEquals(a, b) {
  return JSON.stringify(normalizeToolCatalog(a)) === JSON.stringify(normalizeToolCatalog(b));
}

/** 读取四文件模型并算出生效状态。 */
function loadExternalToolPluginLayers(cwd, logger) {
  const safeCwd = typeof cwd === "string" && cwd.trim().length > 0 ? cwd.trim() : process.cwd();
  const userEnable = loadUserEnable(logger);
  const userCatalog = loadUserCatalog(logger);
  const userOtherEnable = loadUserOtherEnable(logger);
  const userOtherCatalog = loadUserOtherCatalog(logger);
  const projectEnable = loadProjectEnable(safeCwd, logger);
  const projectCatalog = loadProjectCatalog(safeCwd, logger);
  const projectOtherEnable = loadProjectOtherEnable(safeCwd, logger);
  const projectOtherCatalog = loadProjectOtherCatalog(safeCwd, logger);
  const agentManagedRegistry = loadAgentManagedRegistry(logger);
  const effective = computeEffectiveToolState({
    codeCatalog: TOOL_PLUGIN_CATALOG,
    codeEnabled: TOOL_PLUGINS,
    userEnable,
    userOtherEnable,
    userCatalog,
    userOtherCatalog,
    projectEnable,
    projectOtherEnable,
    projectCatalog,
    projectOtherCatalog,
  });
  const original = computeEffectiveToolState({
    codeCatalog: TOOL_PLUGIN_CATALOG,
    codeEnabled: TOOL_PLUGINS,
    userOtherEnable,
    userOtherCatalog,
  });
  const defaults = computeEffectiveToolState({
    codeCatalog: TOOL_PLUGIN_CATALOG,
    codeEnabled: TOOL_PLUGINS,
    userEnable,
    userOtherEnable,
    userCatalog,
    userOtherCatalog,
  });
  const projectDiffers = !enableEquals(effective.P, defaults.P) || !catalogEquals(effective.T, defaults.T);
  const userDiffersFactory = !enableEquals(defaults.P, original.P) || !catalogEquals(defaults.T, original.T);
  return {
    cwd: safeCwd,
    userEnable,
    userCatalog,
    userOtherEnable,
    userOtherCatalog,
    projectEnable,
    projectCatalog,
    projectOtherEnable,
    projectOtherCatalog,
    effective,
    defaults,
    original,
    projectDiffers,
    userDiffersFactory,
    effectiveEqualsFactory: !projectDiffers && !userDiffersFactory,
    effectiveEqualsUser: !projectDiffers,
    hasProjectOverrides: projectDiffers,
    agentManagedRegistry,
    agentManagedPluginKeys: agentManagedPluginKeys(agentManagedRegistry),
    agentManagedTools: agentManagedToolNames(agentManagedRegistry),
  };
}

/** 读取某一层的四个文件（user/project）。 */
function loadLayerFourFiles(layer, cwd, logger) {
  if (layer === "user") {
    return {
      enable: loadUserEnable(logger),
      catalog: loadUserCatalog(logger),
      otherEnable: loadUserOtherEnable(logger),
      otherCatalog: loadUserOtherCatalog(logger),
    };
  }
  return {
    enable: loadProjectEnable(cwd, logger),
    catalog: loadProjectCatalog(cwd, logger),
    otherEnable: loadProjectOtherEnable(cwd, logger),
    otherCatalog: loadProjectOtherCatalog(cwd, logger),
  };
}

/** 写回某一层的四个文件（user/project）。 */
function saveLayerFourFiles(layer, cwd, data, logger) {
  if (layer === "user") {
    saveUserEnable(data.enable, logger);
    saveUserCatalog(data.catalog, logger);
    saveUserOtherEnable(data.otherEnable, logger);
    saveUserOtherCatalog(data.otherCatalog, logger);
  } else {
    saveProjectEnable(cwd, data.enable, logger);
    saveProjectCatalog(cwd, data.catalog, logger);
    saveProjectOtherEnable(cwd, data.otherEnable, logger);
    saveProjectOtherCatalog(cwd, data.otherCatalog, logger);
  }
}

/** 把“插件启用”字典所有值置为 true（保留键）。 */
function allTruePluginEnableDict(dict) {
  const out = {};
  for (const key of Object.keys(normalizePluginEnableDict(dict))) out[key] = true;
  return out;
}

/** 把“工具开关”字典所有值置为 true（保留插件/工具键）。 */
function allTrueToolCatalog(catalog) {
  const out = {};
  const normalized = normalizeToolCatalog(catalog);
  for (const [key, tools] of Object.entries(normalized)) {
    out[key] = Object.fromEntries(Object.keys(tools).map((tool) => [tool, true]));
  }
  return out;
}

/** 是否为官方/Kaz 插件（外置插件走 other-* 文件，官方/Kaz 走 tool-plugin 文件）。 */
function isOfficialOrKazToolPluginKey(key) {
  return OFFICIAL_TOOL_PLUGIN_KEYS.includes(key) || KAZ_TOOL_PLUGIN_KEYS.includes(key);
}

/** 永久删除一个用户添加的外置插件（从用户/项目四文件里都移除）。 */
function deleteExternalPluginPermanently(pluginKey, cwd, logger) {
  if (isOfficialOrKazToolPluginKey(pluginKey)) return false;
  // 第14次更新：Agent 管理的自写工具不在用户可删层内（双保险，RPC 入口也会拦）。
  if (agentManagedRegistryHasPlugin(loadAgentManagedRegistry(logger), pluginKey)) return false;
  for (const layer of ["user", "project"]) {
    const data = loadLayerFourFiles(layer, cwd, logger);
    delete data.enable[pluginKey];
    delete data.otherEnable[pluginKey];
    delete data.catalog[pluginKey];
    delete data.otherCatalog[pluginKey];
    saveLayerFourFiles(layer, cwd, data, logger);
  }
  return true;
}

/** 永久删除一个用户添加的工具（从用户/项目四文件里都移除）。 */
function deleteExternalToolPermanently(pluginKey, toolName, cwd, logger) {
  if (isOfficialOrKazToolPluginKey(pluginKey)) return false;
  // 第14次更新：Agent 管理的自写工具不在用户可删层内（双保险，RPC 入口也会拦）。
  if (agentManagedRegistryHasPlugin(loadAgentManagedRegistry(logger), pluginKey)) return false;
  for (const layer of ["user", "project"]) {
    const data = loadLayerFourFiles(layer, cwd, logger);
    delete data.catalog[pluginKey]?.[toolName];
    delete data.otherCatalog[pluginKey]?.[toolName];
    if (data.catalog[pluginKey] && Object.keys(data.catalog[pluginKey]).length === 0) delete data.catalog[pluginKey];
    if (data.otherCatalog[pluginKey] && Object.keys(data.otherCatalog[pluginKey]).length === 0) delete data.otherCatalog[pluginKey];
    saveLayerFourFiles(layer, cwd, data, logger);
  }
  return true;
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
  const saved = value.savedPluginStates && typeof value.savedPluginStates === "object" ? value.savedPluginStates : {};
  return {
    enabled: value.enabled === true,
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
  // RPC 通道；tools：工具注册信息（面板/工具面用）；settings 为可选依赖
  // （惰性解析）。round-minimal 服务已随 36.9 删除，不再消费。
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

    /** 当前由客户端告知的活跃会话（用于在没有 sessionId 时解析项目 cwd）。 */
    let activeSession = null;

    // -----------------------------------------------------------------------
    // 联动工具函数
    // -----------------------------------------------------------------------

    /**
     * settings 服务惰性获取：启动时可能尚未挂载（kaz-mode 只 inject systemPrompt），
     * 所有跨命名空间读写都在调用时解析，避免 apply 阶段一次性捕获到 undefined。
     */
    const getSettings = () => ctx.get("settings");

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

    /** 读取某会话所在项目的状态文件；返回 { cwd, data }。 */
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

    /** 计算某项目当前应生效的插件状态 map：项目专属覆盖 > 当前模式默认。
     *  纯方案 A：此 map 只经 kazMode.pluginConfig / getState.effective 提供给
     *  被管理插件与客户端面板，kaz-mode 不再把它写入任何插件的 settings.yaml。 */
    function effectivePluginStates(data, kazEnabled) {
      const mode = kazEnabled ? "kaz" : "nonKaz";
      const defaults = data.defaults?.[mode] ?? {};
      const projectOverrides = data.project ?? {};
      const result = {};
      for (const plugin of managedList()) {
        const base = defaults[plugin.id] !== null && typeof defaults[plugin.id] === "object" ? defaults[plugin.id] : {};
        const override = projectOverrides[plugin.id] !== null && typeof projectOverrides[plugin.id] === "object" ? projectOverrides[plugin.id] : {};
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

    /** 会话里是否已发生第一次工具调用（36.9：首阶段 Minimal 由 kaz-mode 核心判定）。 */
    function hasToolCallEvent(agent) {
      try {
        const events = agent?.session?.events;
        if (!Array.isArray(events)) return false;
        return events.some((event) => event !== null && typeof event === "object" && event.type === "tool/call");
      } catch {
        return false;
      }
    }

    /** 读取代理当前轮次（供工具面变化上报使用）：会话日志中最近 turn/start 的 data.turn。 */
    function currentTurnOf(agent) {
      try {
        const events = agent?.session?.events;
        if (!Array.isArray(events)) return 0;
        let turn = 0;
        for (const event of events) {
          if (event === null || typeof event !== "object") continue;
          if (event.type !== "turn/start") continue;
          const value = event.data?.turn;
          if (typeof value === "number" && value > turn) turn = value;
        }
        return turn;
      } catch {
        return 0;
      }
    }

    /** 提取 assembly.tools 里的工具名（去重、保留顺序）。 */
    function toolNamesOf(tools) {
      const names = [];
      const seen = new Set();
      for (const tool of Array.isArray(tools) ? tools : []) {
        if (tool === null || typeof tool !== "object") continue;
        const name = tool.name;
        if (typeof name !== "string" || name.length === 0 || seen.has(name)) continue;
        seen.add(name);
        names.push(name);
      }
      return names;
    }

    /** 该代理此刻是否处于首阶段极简（36.9：round-minimal 已删除，纯核心判定）：
     *  Kaz 模式主模型与子代理在第一次 tool/call 前都保持极简，
     *  保证首次工具调用前工具面 ≤2（硬边界 2；v0.8 Step A 子代理同样适用）。
     *  注意：kazSurfaceFor 只用于 Kaz 会话，因此这里不会误伤非 Kaz 模式。 */
    function isMinimalAgent(agent) {
      if (agent === null || agent === undefined || typeof agent !== "object") return false;
      return !hasToolCallEvent(agent);
    }

    /** v0.9 B3：读取受控子代理角色记录（ka-whale-workflow stage store）。 */
    function controlledSubagentRoleOf(agent) {
      if (agent === null || agent === undefined || typeof agent !== "object") return null;
      try {
        const svc = ctx.get("kaWhaleWorkflow");
        if (svc === undefined || svc === null || typeof svc.subagentRoleOf !== "function") return null;
        return svc.subagentRoleOf(agent);
      } catch {
        return null;
      }
    }

    /** v0.9 B3：读取受控子代理最终工具面数组；未知返回 null。 */
    function controlledSubagentSurfaceOf(agent) {
      if (agent === null || agent === undefined || typeof agent !== "object") return null;
      try {
        const svc = ctx.get("kaWhaleWorkflow");
        if (svc === undefined || svc === null || typeof svc.subagentSurfaceOf !== "function") return null;
        return svc.subagentSurfaceOf(agent);
      } catch {
        return null;
      }
    }

    // -----------------------------------------------------------------------
    // 项目级解析（方案 A：工具面按 agent 所在项目计算，不再全局注册/注销）。
    // kaz-memory 的工具常驻注册；本插件在每个请求的组装/执行层按 agent 所在
    // 项目的 kaz-project-states.json 决定它们是否进入工具面——切换对话不再影响
    // 后台正在运行的会话，同一项目内的对话共享同一套项目专属设置。
    // -----------------------------------------------------------------------

    /** 从 agent 会话头解析原始会话 id（子代理归入父会话）；读不到返回 ""。
     *  仅用于解析该会话所在项目 cwd，不再作为状态文件键。 */
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

    /** 读取 agent 所在项目的生效插件状态 map（项目专属覆盖 > 当前模式默认）。 */
    function agentEffectiveStates(agent) {
      const sessionId = agentSessionIdOf(agent);
      if (sessionId.length === 0) return {};
      try {
        const cwd = resolveSessionCwd(sessionId);
        const data = loadStateFile(cwd, ctx.logger);
        const states = effectivePluginStates(data, agentKazEnabled(agent));
        return states;
      } catch (error) {
        ctx.logger.debug(`[kaz-mode] 读取 agent 项目状态失败：${safeMessage(error)}`);
        return {};
      }
    }

    /**
     * 计算某 agent 此刻的 Kaz 工具面（Set）。
     *
     * v0.8 Step A/B1 语义：
     *   - 主模型：minimal（首次工具调用前 ≤2）→ Stable Main Surface
     *     （KAZ_STABLE_MAIN_TOOLS v0.9 固定 20 项，M6 版本边界新增 whale_expand）；一次变化。
     *   - 子代理：minimal → Stable Subagent Base（Step A 尚无 per-task assigned
     *     工具通道，assignedTools 由后续受控委派 Step 接入）。
     *   - 代码级固定集优先：旧 tool-plugin JSON 只作兼容读，不决定固定成员是否可见。
     *   - v0.8 Step B1：原生 Plan 已移除，不再存在 Plan 自动放行例外。
     *   - v0.9 B5：enable_tool / taskToolSelection 已整体退役，不再参与工具面。
     */
    function kazSurfaceFor(agent, current, states, options = {}) {
      let whitelist;
      try {
        const layers = loadExternalToolPluginLayers(workspaceOfAgent(agent), ctx.logger);
        whitelist = new Set(computeToolPluginSurfaceFromEffective(layers.effective));
        whitelist = mergeAgentManagedToolsIntoSurface(whitelist, layers.agentManagedRegistry);
      } catch (error) {
        ctx.logger?.debug?.("[kaz-mode] 计算统一工具插件面失败：" + safeMessage(error));
        whitelist = new Set();
      }

      const subagent = isSubagent(agent) === true;
      const minimalPhase = isMinimalAgent(agent) === true;

      if (minimalPhase) {
        // 36.9：round-minimal 服务已删除，firstRoundTools 由 kaz-mode 直接解析：
        //   - 受控 v0.9 子代理：role Minimal（V09_SUBAGENT_ROLE_MINIMAL_TOOLS）；
        //   - 其它子代理：memory_search 兜底；
        //   - 主模型：firstRoundTools 保持空，computeSurface 按 Kaz 恒开
        //     ka-whale-memory 自动解析为 memory_search（≤2）。
        let firstRoundTools = [];
        const subagentMinimalTools = ["memory_search"];
        if (subagent) {
          const roleRecord = controlledSubagentRoleOf(agent);
          const roleMinimal =
            roleRecord !== null &&
            typeof roleRecord.persona === "string" &&
            V09_SUBAGENT_ROLE_MINIMAL_TOOLS[roleRecord.persona] !== undefined
              ? V09_SUBAGENT_ROLE_MINIMAL_TOOLS[roleRecord.persona]
              : null;
          firstRoundTools =
            roleMinimal !== null
              ? [...roleMinimal]
              : subagentMinimalTools;
        }
        return computeSurface({
          toolWhitelist: [...whitelist],
          minimalPhase: true,
          firstRoundTools,
          // v0.9 B5：Kaz 模式下 ka-whale-memory 恒开，首轮固定按记忆开解析。
          kazMemoryEnabled: true,
        });
      }

      let allowed;
      if (subagent) {
        // v0.9 B3：受控子代理使用 role Stable Base + assignedTools（由
        // ka-whale-workflow 持久化）；旧/未知子代理回落到静态保守 Stable Base。
        const controlledSurface = controlledSubagentSurfaceOf(agent);
        if (Array.isArray(controlledSurface) && controlledSurface.length > 0) {
          allowed = new Set(controlledSurface);
        } else {
          allowed = stableSubagentSurface({ assignedTools: [] });
        }
      } else {
        allowed = stableMainSurface();
      }
      // v0.9 B5：Kaz 模式下 ka-whale-memory / ka-whale-workflow 恒开，
      // 不再根据旧项目状态从固定面剔除工具（非 Kaz 仍由 nonKazToolVisible 管理）。
      return allowed;
    }

    /** 某工具是否属于“携带工具的 Kaz 被管理组件”且该组件当前未启用。 */
    function carrierToolHidden(states, name) {
      for (const [pluginId, tools] of Object.entries(MANAGED_CARRIER_TOOLS)) {
        if (tools.includes(name)) return states[pluginId]?.enabled !== true;
      }
      return false;
    }

    /** 非 Kaz 会话：记忆工具/携带工具组件的工具是否可见只取决于该会话的插件开关
     *  （其余交还宿主）。2026-08-21 加固：状态缺失（undefined）按「禁用」处理——
     *  原先 `!== false` 会把新对话/未落盘状态的会话误判为启用。 */
    function nonKazToolVisible(states, name) {
      if (MEMORY_TOOLS.includes(name)) return states["ka-whale-memory"]?.enabled === true;
      if (carrierToolHidden(states, name)) return false;
      return true;
    }

    /**
     * kazMode 服务（供被管理插件在使用时刻按 agent 所在项目读取生效配置）：
     *   - kazEnabled(agent)            该 agent 会话是否 Kaz 模式；
     *   - pluginEnabled(agent, pluginId) 该 agent 项目里某被管理插件是否启用；
     *   - pluginConfig(agent, pluginId)  该 agent 项目里某插件的【完整生效配置】
     *     = 工厂默认 + 当前模式默认(kaz-defaults.json) + 项目专属覆盖(kaz-project-states.json)。
     *     无会话/无覆盖时返回 null，调用方回落到插件自身 settings.yaml。
     *   - toolVisible(agent, name)    该 agent 会话里某工具是否在工具面内；
     *   - surfaceOf(agent)            Kaz 会话的完整工具面（Set）；非 Kaz 返回 null。
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
        // 无 agent / 项目状态缺失时按「不可见」处理（2026-08-21 加固，避免误判为启用）。
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
    };
    ctx.effect(() => {
      const disposeService = ctx.provide("kazMode", kazModeService);
      return () => {
        if (typeof disposeService === "function") disposeService();
      };
    }, "kaz-mode: 发布 kazMode 会话工具面服务");

    // 组装层：按 agent 会话过滤工具列表。
    //   Kaz 会话：工具面 = kazSurfaceFor（白名单 - 该会话禁用的记忆工具，
    //   首阶段仅 firstRoundTools）；系统提示词已交给 kaz 预设的
    //   kaz-system-prompt.mjs 控制，本插件不再收敛/改写 sections。
    //   非 Kaz 会话：只移除该会话禁用的记忆工具（kaz-memory 的工具常驻注册，
    //   标准模式不能露出），其余工具交还宿主标准工具面。
    //   每个请求组装时实时计算 → 后台运行的会话不受切换对话影响。
    //   36.9：round-minimal 的 assemble 工具面变化上报已收编进本监听器——等所有
    //   监听器跑完后取最终可见工具面，按 agent × 轮次记录上次面并把真实增删
    //   以 category=tool-surface 上报 round-display。
    const lastToolSurfaces = new WeakMap();
    function reportToolSurfaceChange(agent, before, after, minimal) {
      try {
        if (agent === null || agent === undefined || typeof agent !== "object") return;
        if (agent.id === undefined) return;
        const turn = currentTurnOf(agent);
        let state = lastToolSurfaces.get(agent);
        if (state === undefined || state.turn !== turn) {
          // 新一轮的第一条基线：
          //  - 全新会话且还在极简阶段：用过滤前的原始面，让面板能展示极简收窄；
          //  - 轮次切换或历史缺失：用当前真实最终工具面，避免把其它过滤器的
          //    原始全量误当作上一轮状态。
          const useRawBaseline = state === undefined && minimal === true;
          state = { turn, names: useRawBaseline ? before : after };
          lastToolSurfaces.set(agent, state);
        }
        const prev = state.names;
        const added = after.filter((name) => !prev.includes(name));
        const removed = prev.filter((name) => !after.includes(name));
        if (added.length === 0 && removed.length === 0) return;
        state.names = after;

        let phase;
        if (minimal) {
          phase = "极简阶段（首次工具调用前）";
        } else if (added.length > 0 && removed.length === 0) {
          phase = "恢复全量（首次工具调用后）";
        } else {
          phase = "工具面变化";
        }
        const content =
          "工具面变化（来自 system-prompt/assemble）\n" +
          phase + "\n" +
          "- 当前工具（" + after.length + "）：" + (after.length > 0 ? after.join(", ") : "（无）") + "\n" +
          "- 移除（" + removed.length + "）：" + (removed.length > 0 ? removed.join(", ") : "（无）") + "\n" +
          "+ 新增（" + added.length + "）：" + (added.length > 0 ? added.join(", ") : "（无）");
        const roundDisplay = ctx.get("roundDisplay");
        if (
          roundDisplay !== null &&
          roundDisplay !== undefined &&
          typeof roundDisplay.report === "function"
        ) {
          roundDisplay.report({
            agent,
            plugin: "kaz-mode",
            title: "本轮工具变化",
            content,
            category: "tool-surface",
          });
        }
      } catch (error) {
        ctx.logger?.debug?.("[kaz-mode] 工具面变化上报失败：" + (error instanceof Error ? error.message : String(error)));
      }
    }

    ctx.on("system-prompt/assemble", async function (assembly, context, next) {
      const current = source();
      const agent = context?.agent;
      const hasAgent = agent !== null && agent !== undefined && typeof agent === "object";
      const kazEnabled = hasAgent ? agentKazEnabled(agent) : current.enabled === true;
      const before = hasAgent ? toolNamesOf(assembly?.tools) : [];
      const minimal = hasAgent && kazEnabled && isMinimalAgent(agent) === true;

      if (kazEnabled) {
        const states = hasAgent ? agentEffectiveStates(agent) : {};
        const allowed = kazSurfaceFor(agent, current, states);
        assembly.tools = assembly.tools.filter((tool) => {
          if (tool === null || typeof tool !== "object") return false;
          return allowed.has(tool.name);
        });
      } else {
        // 非 Kaz 会话：仅剔除该会话禁用的记忆工具。
        // 状态缺失按禁用处理（`!== true`），与新会话判定保持一致。
        if (hasAgent) {
          const states = agentEffectiveStates(agent);
          const remove = new Set();
          if (states["ka-whale-memory"]?.enabled !== true) {
            for (const tool of MEMORY_TOOLS) remove.add(tool);
          }
          for (const [pluginId, tools] of Object.entries(MANAGED_CARRIER_TOOLS)) {
            if (states[pluginId]?.enabled !== true) {
              for (const tool of tools) remove.add(tool);
            }
          }
          if (remove.size > 0) {
            assembly.tools = assembly.tools.filter((tool) => {
              if (tool === null || typeof tool !== "object") return true;
              return !remove.has(tool.name);
            });
          }
        }
      }

      const result = await next();
      if (hasAgent && kazEnabled) {
        const finalAssembly = result ?? assembly;
        reportToolSurfaceChange(agent, before, toolNamesOf(finalAssembly?.tools), minimal);
      }
      return result;
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
              `工具 "${name}" 不在本会话 Kaz 模式工具面内（工具控制面板 JSON：官方/外置 + 已启用记忆插件）。` +
              `如需使用，请在 Kaz 面板的「工具控制面板」或项目/用户 JSON 中放行（首次工具调用前仅核心首轮工具集，≤2）。`,
          };
        }
        return next();
      }

      // 非 Kaz 会话：记忆工具/携带工具组件按项目开关拒绝（常驻注册但该项目不可用）。
      if (MEMORY_TOOLS.includes(name) && states["ka-whale-memory"]?.enabled === false) {
        ctx.logger.info(`[kaz-mode] 拒绝调用工具 "${name}"（该项目 ka-whale-memory 已关闭）`);
        return {
          kind: "deny",
          reason: `工具 "${name}" 在当前项目不可用（ka-whale-memory 已关闭）；如需使用请在 Kaz 面板的当前项目专属设置中开启 ka-whale-memory。`,
        };
      }
      if (carrierToolHidden(states, name)) {
        const pluginId = Object.entries(MANAGED_CARRIER_TOOLS).find(([, tools]) => tools.includes(name))?.[0] ?? "未知组件";
        ctx.logger.info(`[kaz-mode] 拒绝调用工具 "${name}"（组件 ${pluginId} 已关闭）`);
        return {
          kind: "deny",
          reason: `工具 "${name}" 在当前项目不可用（${pluginId} 已关闭）；如需使用请在 Kaz 面板的当前项目专属设置中开启对应组件。`,
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
    // 面板 RPC 通道（/kaz-mode，loopback）：项目级插件状态读写与默认设置管理
    // -----------------------------------------------------------------------
    function rpcFail(message) {
      return { ok: false, error: { code: "internal", message: String(message), details: {} } };
    }
    /** v0.9 B4：工具控制面板已只读；旧写入口返回只读语义而不是执行写入。 */
    function rpcReadOnly(message) {
      return {
        ok: false,
        error: { code: "read-only", message: String(message), details: {} },
      };
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
          endpoint !== "resetExternalToolPlugins" &&
          endpoint !== "setExternalToolPluginsAsDefault" &&
          endpoint !== "addPrivatePluginCandidate" &&
          endpoint !== "setProjectPlugin" &&
          endpoint !== "clearProject" &&
          endpoint !== "clearProjectPlugin"
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

        /** 项目状态端点统一解析项目 cwd（与工具面板同规则）。 */
        const resolveStateCwd = () => {
          if (typeof input.cwd === "string" && input.cwd.trim().length > 0) return input.cwd.trim();
          if (sessionId.length > 0) return resolveSessionCwd(sessionId);
          if (activeSession !== null && activeSession !== undefined) return activeSession.cwd;
          return process.cwd();
        };

        /** 组装工具插件 RPC 返回值（统一字段）。 */
        const toolPluginValue = (layers, extra = {}) => ({
          cwd: layers.cwd,
          userEnable: layers.userEnable,
          userCatalog: layers.userCatalog,
          userOtherEnable: layers.userOtherEnable,
          userOtherCatalog: layers.userOtherCatalog,
          projectEnable: layers.projectEnable,
          projectCatalog: layers.projectCatalog,
          projectOtherEnable: layers.projectOtherEnable,
          projectOtherCatalog: layers.projectOtherCatalog,
          effective: layers.effective,
          defaults: layers.defaults,
          original: layers.original,
          projectDiffers: layers.projectDiffers,
          userDiffersFactory: layers.userDiffersFactory,
          effectiveEqualsFactory: layers.effectiveEqualsFactory,
          effectiveEqualsUser: layers.effectiveEqualsUser,
          hasProjectOverrides: layers.hasProjectOverrides,
          agentManagedRegistry: layers.agentManagedRegistry,
          agentManagedPluginKeys: layers.agentManagedPluginKeys,
          agentManagedTools: layers.agentManagedTools,
          // v0.9 B4：只读展示所需的代码级固定面/候选清单。
          stableMainTools: [...KAZ_STABLE_MAIN_TOOLS],
          workflowTools: [...(MANAGED_CARRIER_TOOLS["ka-whale-workflow"] ?? [])],
          toolJobs: [...KAZ_V09_TOOL_JOBS],
          privatePluginCandidates: Array.isArray(layers.agentManagedRegistry?.candidates)
            ? layers.agentManagedRegistry.candidates.map((candidate) => ({ ...candidate }))
            : [],
          ...extra,
        });

        if (endpoint === "getState") {
          const cwd = sessionId.length > 0 ? resolveSessionCwd(sessionId) : activeSession !== null ? activeSession.cwd : process.cwd();
          const data = loadStateFile(cwd, ctx.logger);
          if (sessionId.length > 0) activeSession = { sessionId, cwd };
          // 会话自己的 Kaz 状态（事件优先判定，与面板/组装层同源），不是全局开关。
          const kazEnabled = sessionKazEnabledById(sessionId);
          // 直接算好每个被管理插件的生效 enabled（工厂+模式默认+项目覆盖），
          // 供 kaz-memory / round-display 客户端面板判断显隐，无需各自重复计算。
          const effective = effectivePluginStates(data, kazEnabled);
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
              project: data.project,
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
          const agentRegistry = loadAgentManagedRegistry(ctx.logger);
          return {
            ok: true,
            value: {
              catalog: {
                official: [...OFFICIAL_TOOL_PLUGIN_KEYS],
                kaz: [...KAZ_TOOL_PLUGIN_KEYS],
                agent: agentManagedPluginKeys(agentRegistry),
              },
            },
          };
        }

        if (endpoint === "getExternalToolPlugins") {
          const cwd = resolveExternalCwd();
          const layers = loadExternalToolPluginLayers(cwd, ctx.logger);
          return { ok: true, value: toolPluginValue(layers) };
        }

        if (endpoint === "setExternalToolPlugin") {
          const pluginName = typeof input.pluginName === "string" ? input.pluginName : "";
          if (pluginName.length === 0) return rpcFail("缺少 pluginName");
          const cwd = resolveExternalCwd();
          const key = normalizeExternalKey(pluginName);
          if (key.length === 0) return rpcFail("插件名无法归一化");
          const tool = typeof input.toolName === "string" ? input.toolName.trim() : "";
          // 第14次更新：Agent 管理的自写工具由 Agent/自升级生命周期所有，
          // 用户面板任何 add/remove/toggle 都不得触碰该层。
          const agentRegistry = loadAgentManagedRegistry(ctx.logger);
          if (agentManagedRegistryHasPlugin(agentRegistry, key)) {
            return rpcFail("Agent 管理的自写工具不能通过工具控制面板修改");
          }

          // v0.9 B4：面板只允许“添加候选”。旧的删除/开关/恢复/设为默认全部拒绝写。
          if (input.removePlugin === true || input.remove === true) {
            return rpcReadOnly("工具控制面板已只读：不再提供删除入口");
          }
          if (typeof input.capable === "boolean" || typeof input.enabled === "boolean") {
            return rpcReadOnly("工具控制面板已只读：不再提供启用/停用开关");
          }
          if (input.layer === "user" || input.layer === "project") {
            return rpcReadOnly("工具控制面板已只读：不能直接写入四文件开关层");
          }

          // 手动添加插件候选：写入用户 other-*（共享到所有项目；外置候选层）。
          if (input.addPlugin === true) {
            const user = loadLayerFourFiles("user", cwd, ctx.logger);
            user.otherEnable[key] = true;
            if (user.otherCatalog[key] === undefined) user.otherCatalog[key] = {};
            saveLayerFourFiles("user", cwd, user, ctx.logger);
            const layers = loadExternalToolPluginLayers(cwd, ctx.logger);
            return { ok: true, value: toolPluginValue(layers) };
          }

          // 手动添加工具候选：写入用户 other-catalog，并确保插件在用户 other-enable 里。
          if (input.addTool === true && tool.length > 0) {
            const user = loadLayerFourFiles("user", cwd, ctx.logger);
            user.otherEnable[key] = true;
            user.otherCatalog[key] = { ...(user.otherCatalog[key] ?? {}), [tool]: true };
            saveLayerFourFiles("user", cwd, user, ctx.logger);
            const layers = loadExternalToolPluginLayers(cwd, ctx.logger);
            return { ok: true, value: toolPluginValue(layers) };
          }

          return rpcReadOnly("工具控制面板已只读：仅支持添加外置插件/工具候选");
        }

        if (endpoint === "addPrivatePluginCandidate") {
          // 6.0.3：私有插件候选不由用户在面板添加；写入只允许 pluginCreator /
          // pluginMaintainer 生命周期内部完成。此端点保持存在但只读拒绝。
          return rpcReadOnly("私有插件候选不可由用户在工具面板添加；请通过 pluginCreator/pluginMaintainer 生命周期管理。");
        }

        if (endpoint === "resetExternalToolPlugins") {
          return rpcReadOnly("工具控制面板已只读：不再提供恢复/重置入口");
        }

        if (endpoint === "setExternalToolPluginsAsDefault") {
          return rpcReadOnly("工具控制面板已只读：不再提供设为默认设置入口");
        }

        if (endpoint === "applySession") {
          // 纯方案 A：只需记录活跃会话；插件配置在使用时刻经
          // kazMode.pluginConfig 按 agent 项目实时读取生效状态，
          // 无需写任何插件 settings.yaml，也无需初始化会话内存态。
          const { cwd, data } = loadSessionData(sessionId);
          activeSession = { sessionId, cwd };
          return { ok: true, value: { applied: true, sessionId } };
        }

        if (endpoint === "setProjectPlugin") {
          const pluginId = typeof input.pluginId === "string" ? input.pluginId : "";
          const patch = input.patch !== null && typeof input.patch === "object" ? input.patch : null;
          if (pluginId.length === 0 || patch === null) return rpcFail("缺少 pluginId 或 patch");
          const cwd = resolveStateCwd();
          const data = loadStateFile(cwd, ctx.logger);
          if (data.project[pluginId] === undefined || data.project[pluginId] === null) {
            data.project[pluginId] = {};
          }
          const merged = { ...data.project[pluginId] };
          for (const [key, value] of Object.entries(patch)) {
            if (value === null) {
              delete merged[key];
            } else {
              merged[key] = value;
            }
          }
          if (Object.keys(merged).length === 0) {
            delete data.project[pluginId];
          } else {
            data.project[pluginId] = merged;
          }
          saveProjectStates(cwd, data.project, ctx.logger);
          if (sessionId.length > 0) activeSession = { sessionId, cwd };
          return { ok: true, value: { project: data.project[pluginId] ?? null } };
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
          const cwd = resolveStateCwd();
          const data = loadStateFile(cwd, ctx.logger);
          // "当前项目的插件状态" = 有效状态（项目专属覆盖 > 当前模式默认）。
          // 用会话自身预设（事件优先）计算，避免把上一个会话的模式带进来。
          const effective = effectivePluginStates(data, sessionKazEnabledById(sessionId));
          data.defaults[mode] = deepClone(effective);
          saveDefaults(data.defaults, ctx.logger);
          if (sessionId.length > 0) activeSession = { sessionId, cwd };
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

        if (endpoint === "clearProject") {
          // 清除当前项目的全部专属覆盖 → 生效状态回落到当前模式默认
          // （Kaz 会话回落到 Kaz 默认，非 Kaz 会话回落到非 Kaz 默认）。
          const cwd = resolveStateCwd();
          const data = loadStateFile(cwd, ctx.logger);
          data.project = {};
          saveProjectStates(cwd, data.project, ctx.logger);
          if (sessionId.length > 0) activeSession = { sessionId, cwd };
          return { ok: true, value: { project: null } };
        }

        if (endpoint === "clearProjectPlugin") {
          // 清除当前项目里单个插件的专属覆盖（该插件回落到当前模式默认）。
          const pluginId = typeof input.pluginId === "string" ? input.pluginId : "";
          if (pluginId.length === 0) return rpcFail("缺少 pluginId");
          const cwd = resolveStateCwd();
          const data = loadStateFile(cwd, ctx.logger);
          if (data.project[pluginId] !== undefined && data.project[pluginId] !== null && typeof data.project[pluginId] === "object") {
            delete data.project[pluginId];
            saveProjectStates(cwd, data.project, ctx.logger);
          }
          if (sessionId.length > 0) activeSession = { sessionId, cwd };
          return { ok: true, value: { project: data.project ?? null } };
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
