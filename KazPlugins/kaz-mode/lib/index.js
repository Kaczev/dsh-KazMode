// kaz-mode
// ===========================================================================
// 「Kaz 模式」超级模式插件 —— 统一管理并联动本工作区插件：
//   thinking-anchor（思考锚点 · 消息注入）、round-minimal（首阶段极简）、
//   plugin-filter（工具过滤）、output-beep（提示音）、round-display（注入显示）、
//   deepseek-default-model（DeepSeek 默认参数）、kaz-memory（独立记忆组件）、
//   kaz-diag（诊断 · 状态工具），并提供集中管理面板与头部开关按钮（客户端半）。
//
// Kaz 模式的语义（2026-08 重构后）：
//   1) 系统提示词固定：Kaz 模式下组装层把提示段收敛为 persona 一句
//      "You are a helpful software engineer assistant."（+ 计划模式段，计划模式
//      仍需生效），其余任何提示段（thinking-anchor / round-minimal 轮次提示 /
//      kaz-memory 指引 / tool:* 指导段 / 运行时上下文…）一律过滤。任何插件都
//      不再向 Kaz 会话的 system prompt 注入其它内容。
//   2) 工具面两阶段：
//        - 首次工具调用前（round-minimal 首阶段信号）：minimalTools（默认
//          pwsh、str_replace_editor）∪ round-minimal 首轮工具集；
//        - 首次工具调用后：恢复 Kaz 全部工具 = minimalTools + toolWhitelist
//          白名单（= 标准模式全部工具除 bash + pwsh + str_replace_editor +
//          kaz-memory 四工具）。toolWhitelist 是 Kaz 全部工具的手动编辑点
//          （settings.yaml 的 kaz-mode.toolWhitelist，热改生效）。
//        - 动态调整：kaz-memory 关闭 → 其四个记忆工具自动移出白名单；
//          kaz-diag 开启 → kaz_mode_status 自动加入白名单。
//   3) 插件联动：只有 kaz-mode.enabled 变为 true（进入 Kaz）时，先快照被管理
//      插件的原始 enabled 状态到 kaz-mode.savedPluginStates（供状态报告展示），
//      再按会话/默认状态应用；defaultDisabledPlugins 默认关闭清单里的插件例外
//      （当前为空）。变为 false（关闭 / 切走）时按会话/非 Kaz 默认状态应用。
//   4) 预设联动：Kaz 模式已注册为 agent preset（id: kaz）。default 切到 "kaz"
//      或会话切换到 kaz 时把 kaz-mode.enabled 置 true（触发上面的插件联动）；
//      切到其它预设 / 其它会话时置 false。同时把最近一个非 kaz 预设记录到
//      kaz-mode.previousPreset，供按钮"关闭"时切回。
//   5) 本插件不注册任何 systemPrompt 段，除联动与固定提示词外不触碰用户已有配置。
//   6) 状态工具 kaz_mode_status 已移出本插件，由独立的 kaz-diag 插件注册
//      （本插件开启/关闭不影响其注册；kaz-diag 关闭时工具也不进入 Kaz 工具面）。
// ===========================================================================

import z from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 设置命名空间：~/.dsh/settings.yaml 中的 kaz-mode: 段。 */
const NAMESPACE = settingsNamespace("kaz-mode");

/** agent-presets 设置命名空间（预设切换的读写目标，与官方选择器一致）。 */
const PRESETS_NAMESPACE = settingsNamespace("agent-presets");

/** Kaz 模式对应的 agent preset id（~/.dsh/.agent-presets/kaz/）。 */
const KAZ_PRESET_ID = "kaz";

/** 按钮"关闭 Kaz"时的兜底预设。 */
const FALLBACK_PRESET_ID = "cordis";

/** Kaz 模式固定系统提示词（persona 唯一文本；其余提示段一律过滤）。 */
const FIXED_PERSONA = "You are a helpful software engineer assistant.";

/** 固定 persona 段名（与 preset 的 persona 行一致）。 */
const PERSONA_SECTION = "deployment:persona";

/** Kaz 工具面·极简基底（首阶段与全量阶段始终保留的最小工具集）。 */
const DEFAULT_MINIMAL_TOOLS = ["pwsh", "str_replace_editor"];

/** kaz-memory 的四工具（kaz-memory 关闭时从 Kaz 工具面自动移除）。 */
const KAZ_MEMORY_TOOLS = ["memory_save", "memory_list", "memory_search", "memory_forget"];

/**
 * Kaz 工具面·白名单默认值 = Kaz 模式的「全部工具列表」：
 *   标准模式（shipped standard 预设）全部工具（除 bash 与 skill：Windows 上
 *   bash 本就不存在；skill 已按 Kaczev 要求从 Kaz 模式整体移除）
 *   + pwsh + str_replace_editor + kaz-memory 四工具。
 * 这是手动编辑点：以后要加新工具，在 settings.yaml 的 kaz-mode.toolWhitelist
 * 里加工具名即可（热改生效）。kaz_mode_status 不在白名单内——由 kaz-diag 插件
 * 开启时动态加入。
 */
const DEFAULT_TOOL_WHITELIST = [
  "pwsh",
  "read", "write", "edit", "read_image", "glob", "grep",
  "job_list", "job_output", "job_kill",
  "create_goal", "get_goal", "update_goal",
  "subagent", "subagent_fork", "list_agents", "send_message", "interrupt_agent",
  "workflow", "ralph",
  "ask_user_question", "todo_write", "web_search",
  "str_replace_editor",
  "memory_save", "memory_list", "memory_search", "memory_forget", "memory_update"
];

/** 进入 Kaz 时默认关闭的被管理插件 id 清单（当前为空——全部默认启用）。 */
const DEFAULT_DISABLED_PLUGINS = [];

/** 被管理的插件（id 与 settings.yaml 命名空间一致）。 */
const MANAGED_PLUGINS = [
  { id: "thinking-anchor", label: "thinking-anchor（思考锚点 · 消息注入）" },
  { id: "round-minimal", label: "round-minimal（首阶段极简 · 首次工具调用后恢复）" },
  { id: "plugin-filter", label: "plugin-filter（工具过滤）" },
  { id: "output-beep", label: "output-beep（输出完成提示音）" },
  { id: "round-display", label: "round-display（每轮注入显示）" },
  { id: "deepseek-default-model", label: "deepseek-default-model（DeepSeek 默认参数）" },
  { id: "kaz-memory", label: "kaz-memory（独立记忆组件）" },
  { id: "kaz-diag", label: "kaz-diag（诊断 · 状态工具）" },
  { id: "first-round-hints", label: "first-round-hints（首轮其它消息提示 · 对话开始注入）" },
];

/** 出厂默认（非 Kaz 模式）：Kaz 插件初始默认全关。 */
const FACTORY_NON_KAZ_DEFAULTS = {
  "thinking-anchor": { enabled: false, instruction: "", turnReminder: "" },
  "round-minimal": {
    enabled: false,
    firstRoundTools: ["pwsh", "str_replace_editor"],
    includeSubagents: false,
  },
  "plugin-filter": {
    enabled: false,
    mode: "remove",
    disabledTools: ["tool-cordis", "tool-subagent-report", "codex", "claude-code"],
  },
  "output-beep": { enabled: false, includeSubagents: false, frequency: 1000, duration: 300 },
  "round-display": { enabled: false },
  "deepseek-default-model": {
    enabled: false,
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    reasoningEffort: "high",
    generation_kwargs: { temperature: 0.2, top_p: 0.9, repetition_penalty: 1.2 },
  },
  "kaz-memory": { enabled: false, guidance: "", guidanceHead: "" },
  "kaz-diag": { enabled: false },
  "first-round-hints": { enabled: false },
};

/** 出厂默认（Kaz 模式）：Kaz 插件初始默认全开。 */
/** 默认不开启thinking-anchor、kaz-diag */
const FACTORY_KAZ_DEFAULTS = {};
for (const [id, cfg] of Object.entries(FACTORY_NON_KAZ_DEFAULTS)) {
  FACTORY_KAZ_DEFAULTS[id] = { ...cfg, enabled: true };
  if (id === "thinking-anchor" || id === "kaz-diag") {
    FACTORY_KAZ_DEFAULTS[id].enabled = false;
  }
}

/** 会话级插件状态文件名（放在项目 .dsh/ 下）。 */
const SESSION_STATES_FILE = "kaz-session-states.json";
/** 两个模式的默认设置文件名（放在 C:\\Users\\Kaczev\\.dsh\\storages 下）。 */
const DEFAULTS_FILE_NAME = "kaz-defaults.json";
const STORAGE_DIR = "C:\\Users\\Kaczev\\.dsh\\storages";
const DEFAULTS_FILE = join(STORAGE_DIR, DEFAULTS_FILE_NAME);
/** 面板专用 RPC 通道。 */
const RPC_CHANNEL = "/kaz-mode";

/** 设置 schema（同时驱动设置页 UI 与客户端面板的字段读写）。 */
const SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(false),
  managedPlugins: z.array(z.string()).default(MANAGED_PLUGINS.map((plugin) => plugin.id)),
  /** 进入 Kaz 时默认关闭的被管理插件 id 清单（当前为空，全部默认启用）。 */
  defaultDisabledPlugins: z.array(z.string()).default([...DEFAULT_DISABLED_PLUGINS]),
  /** Kaz 工具面·极简基底（首阶段与全量阶段始终保留的最小工具集）。 */
  minimalTools: z.array(z.string()).default([...DEFAULT_MINIMAL_TOOLS]),
  /** Kaz 工具面·白名单（= Kaz 全部工具的手动编辑点），热改生效。 */
  toolWhitelist: z.array(z.string()).default([...DEFAULT_TOOL_WHITELIST]),
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
  defaultDisabledPlugins: [...DEFAULT_DISABLED_PLUGINS],
  toolWhitelist: [...DEFAULT_TOOL_WHITELIST],
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

/** 读取项目目录下的会话专属状态；不存在或损坏时返回空对象。 */
function loadSessions(cwd, logger) {
  const file = join(cwd, ".dsh", SESSION_STATES_FILE);
  try {
    if (!existsSync(file)) return {};
    let raw = readFileSync(file, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return {};
    return parsed.sessions !== null && typeof parsed.sessions === "object" ? parsed.sessions : {};
  } catch (error) {
    logger?.warn?.("[kaz-mode] 读取会话状态文件失败：" + safeMessage(error));
    return {};
  }
}

/** 写回项目目录下的会话专属状态。 */
function saveSessions(cwd, sessions, logger) {
  const dir = join(cwd, ".dsh");
  const file = join(dir, SESSION_STATES_FILE);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, sessions }, null, 2) + "\n", "utf8");
  } catch (error) {
    logger?.warn?.("[kaz-mode] 写入会话状态文件失败：" + safeMessage(error));
  }
}

/** 读取完整状态：默认设置来自插件目录，会话专属来自项目目录。 */
function loadStateFile(cwd, logger) {
  return {
    defaults: loadDefaults(logger),
    sessions: loadSessions(cwd, logger),
  };
}

/** 会话键消毒（防止路径穿越）。 */
function sanitizeKey(key) {
  const cleaned = String(key ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
  return cleaned.length > 0 ? cleaned : "default";
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

/** 从 agent 会话头解析会话作用域键（子代理归入父会话）。 */
function sessionKeyOfAgent(agent) {
  try {
    const header = agent?.session?.header;
    if (header !== null && header !== undefined && typeof header === "object") {
      if (typeof header.parentSession === "string" && header.parentSession.trim().length > 0) {
        return sanitizeKey(header.parentSession);
      }
      if (typeof header.id === "string" && header.id.trim().length > 0) {
        return sanitizeKey(header.id);
      }
    }
    if (typeof agent?.id === "string" && agent.id.trim().length > 0) {
      return sanitizeKey(agent.id);
    }
  } catch {
    // fall through
  }
  return "default";
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
  const minimalTools = stringList(value.minimalTools, DEFAULT_MINIMAL_TOOLS);
  const toolWhitelist = stringList(value.toolWhitelist, DEFAULT_TOOL_WHITELIST);
  const defaultDisabledPlugins = stringList(value.defaultDisabledPlugins, DEFAULT_DISABLED_PLUGINS);
  const saved = value.savedPluginStates && typeof value.savedPluginStates === "object" ? value.savedPluginStates : {};
  return {
    enabled: value.enabled === true,
    minimalTools,
    toolWhitelist,
    managedPlugins: managed,
    defaultDisabledPlugins,
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
  // RPC 通道；settings / roundMinimal 为可选依赖（惰性解析）。
  inject: ["systemPrompt", "connection"],
  apply(ctx, config = {}) {
    // 组合行 config 作为 base 层；settings.yaml 用户层优先（热重载）。
    const entry = normalizeConfig(config);
    let source = () => entry;

    /** 联动事务防重入：一次联动（快照+启用 / 恢复+清空）未结束前不重复触发。 */
    let linking = false;

    /** 当前由客户端告知的活跃会话（用于按会话应用插件状态）。 */
    let activeSession = null;

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

    /** 快照全部已加载被管理插件的原始状态（供关闭 Kaz 模式时恢复）。 */
    async function snapshotPluginStates() {
      const snapshot = {};
      for (const plugin of managedList()) {
        const state = readPluginState(plugin.id);
        if (state === null) continue; // 未加载的插件不参与快照，也不参与恢复
        snapshot[plugin.id] = { hadOverride: state.hadOverride, enabled: state.enabled };
      }
      return snapshot;
    }

    /** 联动启用：把尚未启用的被管理插件置为 enabled=true（defaultDisabledPlugins
     *  默认关闭清单内的插件跳过）。返回实际写入个数。 */
    async function forceEnableManaged() {
      const settings = getSettings();
      if (settings === undefined) return 0;
      const current = source();
      const disabledByDefault = new Set(current.defaultDisabledPlugins);
      let count = 0;
      for (const plugin of managedList()) {
        if (disabledByDefault.has(plugin.id)) continue;
        const state = readPluginState(plugin.id);
        if (state === null || state.enabled === true) continue;
        try {
          await settings.update(settingsNamespace(plugin.id), { enabled: true });
          count += 1;
          ctx.logger.info(`[kaz-mode] 联动启用 ${plugin.id}`);
        } catch (error) {
          ctx.logger.warn(`[kaz-mode] 联动启用 ${plugin.id} 失败：${safeMessage(error)}`);
        }
      }
      return count;
    }

    /** 联动默认关闭：进入 Kaz 时把 defaultDisabledPlugins 清单内的插件置为
     *  enabled=false（仅"进入 Kaz"瞬间执行一次；用户之后手动开启的保持开启）。 */
    async function forceDisableDefaultManaged() {
      const settings = getSettings();
      if (settings === undefined) return 0;
      const current = source();
      const disabledByDefault = new Set(current.defaultDisabledPlugins);
      let count = 0;
      for (const plugin of managedList()) {
        if (!disabledByDefault.has(plugin.id)) continue;
        const state = readPluginState(plugin.id);
        if (state === null || state.enabled === false) continue;
        try {
          await settings.update(settingsNamespace(plugin.id), { enabled: false });
          count += 1;
          ctx.logger.info(`[kaz-mode] 联动默认关闭 ${plugin.id}（Kaz 模式默认关闭清单）`);
        } catch (error) {
          ctx.logger.warn(`[kaz-mode] 联动默认关闭 ${plugin.id} 失败：${safeMessage(error)}`);
        }
      }
      return count;
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

    /** 计算某会话当前应生效的插件状态 map：专属覆盖 > 当前模式默认。 */
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

    /** 把某会话的生效插件状态写入各插件 settings.yaml 段（热重载生效）。 */
    async function applyEffectiveState(cwd, sessionId) {
      const settings = getSettings();
      if (settings === undefined) return false;
      const data = loadStateFile(cwd, ctx.logger);
      const states = effectivePluginStates(data, sessionId, source().enabled === true);
      let wrote = 0;
      for (const plugin of managedList()) {
        const state = states[plugin.id];
        if (state === undefined || state === null) continue;
        const current = readPluginState(plugin.id);
        if (current === null) continue; // 未加载的插件不写入
        try {
          await settings.update(settingsNamespace(plugin.id), state);
          wrote += 1;
        } catch (error) {
          ctx.logger.warn(`[kaz-mode] 按会话应用 ${plugin.id} 状态失败：${safeMessage(error)}`);
        }
      }
      if (wrote > 0) {
        ctx.logger.info(`[kaz-mode] 已按会话 ${sessionId} 应用 ${wrote} 个插件状态（Kaz=${source().enabled === true}）`);
      }
      return wrote > 0;
    }

    /**
     * 联动主流程：enabled=true（进入 Kaz）→ 快照 + 按会话/默认状态应用插件；
     * enabled=false（关闭 / 切走）→ 按会话/非 Kaz 默认状态应用插件。
     * 若尚无客户端告知的活跃会话，则回退到旧的强制启用/默认关闭行为，保证
     * 纯 settings.yaml 使用方式仍然可用。
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
          if (enabledNow) {
            if (entering) {
              const saved = await snapshotPluginStates();
              const settings = getSettings();
              if (Object.keys(saved).length > 0 && settings !== undefined) {
                await settings.update(NAMESPACE, { savedPluginStates: saved });
              }
            }
            if (activeSession !== null) {
              await applyEffectiveState(activeSession.cwd, activeSession.sessionId);
              ctx.logger.info(
                `[kaz-mode] Kaz 模式已开启：已按会话 ${activeSession.sessionId} 应用插件状态；原始状态快照已保存。`,
              );
            } else {
              await forceDisableDefaultManaged();
              const enabledCount = await forceEnableManaged();
              ctx.logger.info(
                `[kaz-mode] Kaz 模式已开启：联动启用 ${enabledCount} 个插件（默认关闭清单已跳过）；原始状态快照已保存。`,
              );
            }
          } else {
            if (activeSession !== null) {
              await applyEffectiveState(activeSession.cwd, activeSession.sessionId);
              ctx.logger.info(
                `[kaz-mode] Kaz 模式已关闭：已按会话 ${activeSession.sessionId} 应用非 Kaz 默认插件状态。`,
              );
            } else {
              ctx.logger.info(`[kaz-mode] Kaz 模式已关闭：插件 enabled 保持当前状态。`);
            }
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

    /** 按 agent-presets.default 同步（previousPreset 的记录由 settings/updated 监听器负责）。 */
    async function syncFromPreset() {
      const preset = currentPreset();
      if (preset === undefined) return;
      await syncEnabledForPreset(preset);
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
    // Kaz 工具面：enabled=true 时收敛模型工具面（minimalTools + 白名单）。
    // 白名单是纯工具名列表（= Kaz 全部工具的手动编辑点）。组装层过滤工具并
    // 固定提示词；执行层拒绝白名单外调用。host 平面监听器对所有 agent 生效
    // → 子代理会话同样是 Kaz 工具面。
    // -----------------------------------------------------------------------

    /** 会话里是否已发生第一次工具调用。 */
    function hasToolCall(agent) {
      try {
        const events = agent?.session?.events;
        if (!Array.isArray(events)) return false;
        return events.some((event) => event !== null && typeof event === "object" && event.type === "tool/call");
      } catch {
        return false;
      }
    }

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

    /** 该代理此刻是否处于首阶段极简（首次工具调用前；子代理除外）。
     *  优先查询 round-minimal 服务（其判定与配置一致），服务缺失时用
     *  会话内 tool/call 事件自行兜底。 */
    function isMinimalAgent(agent) {
      if (agent === null || agent === undefined || typeof agent !== "object") return false;
      if (isSubagent(agent)) return false;
      const roundMinimal = ctx.get("roundMinimal");
      if (roundMinimal !== undefined && roundMinimal !== null && typeof roundMinimal.isMinimal === "function") {
        try {
          return roundMinimal.isMinimal(agent) === true;
        } catch {
          // fall through to local check
        }
      }
      return !hasToolCall(agent);
    }

    /** kaz-memory 是否启用（读不到按启用处理——未加载时其工具本就不注册）。 */
    function kazMemoryToolsEnabled() {
      try {
        const settings = getSettings();
        if (settings === undefined) return true;
        const value = settings.get(settingsNamespace("kaz-memory"));
        return !(value !== undefined && value !== null && typeof value === "object" && value.enabled === false);
      } catch {
        return true;
      }
    }

    /** kaz-diag 是否启用（启用时 kaz_mode_status 加入 Kaz 工具面）。 */
    function kazDiagEnabled() {
      try {
        const settings = getSettings();
        if (settings === undefined) return false;
        const value = settings.get(settingsNamespace("kaz-diag"));
        return value !== undefined && value !== null && typeof value === "object" && value.enabled !== false;
      } catch {
        return false;
      }
    }

    /** 动态调整后的有效白名单：手动白名单 ± kaz-memory / kaz-diag 条件。 */
    function effectiveWhitelist() {
      const current = source();
      const result = new Set(current.toolWhitelist);
      if (!kazMemoryToolsEnabled()) {
        for (const tool of KAZ_MEMORY_TOOLS) result.delete(tool);
      }
      if (kazDiagEnabled()) result.add("kaz_mode_status");
      return result;
    }

    /** 计算某代理此刻的 Kaz 工具面（Set）。首阶段 = minimalTools ∪
     *  round-minimal 首轮工具集；首次工具调用后 = minimalTools + 有效白名单。 */
    function allowedToolSet(agent) {
      const current = source();
      const allowed = new Set(current.minimalTools);
      if (isMinimalAgent(agent) === true) {
        try {
          const rm = ctx.get("roundMinimal");
          if (rm !== undefined && rm !== null && typeof rm.firstRoundTools === "function") {
            for (const tool of rm.firstRoundTools()) {
              if (typeof tool === "string" && tool.length > 0) allowed.add(tool);
            }
          }
        } catch {
          // 保持 minimalTools
        }
      } else {
        for (const tool of effectiveWhitelist()) allowed.add(tool);
      }
      return allowed;
    }

    // 组装层：过滤工具列表 + 固定系统提示词。
    //   系统提示词 = 固定 persona 一句（+ 计划模式段）；其余提示段一律过滤。
    //   工具面：首阶段 minimalTools ∪ round-minimal 首轮工具集；首次工具调用后
    //   minimalTools + 有效白名单。
    ctx.on("system-prompt/assemble", function (assembly, context, next) {
      const current = source();
      if (current.enabled !== true) return next();
      const agent = context?.agent;
      const allowed = allowedToolSet(agent);
      assembly.tools = assembly.tools.filter((tool) => {
        if (tool === null || typeof tool !== "object") return false;
        return allowed.has(tool.name);
      });
      // 固定系统提示词：只保留 persona（文本固定为 FIXED_PERSONA）+ 计划模式段。
      const planSection = assembly.sections.find(
        (section) =>
          section !== null &&
          typeof section === "object" &&
          typeof section.name === "string" &&
          /plan/i.test(section.name),
      );
      const kept = [];
      if (planSection !== undefined) kept.push(planSection);
      let personaKept = false;
      for (const section of assembly.sections) {
        if (section === null || typeof section !== "object" || section.name !== PERSONA_SECTION) continue;
        if (typeof section.text === "string") section.text = FIXED_PERSONA;
        kept.push(section);
        personaKept = true;
      }
      if (!personaKept) {
        kept.push({ name: PERSONA_SECTION, order: 0, text: FIXED_PERSONA });
      }
      assembly.sections = kept;
      return next();
    });

    // 执行层：白名单外调用拒绝（纵深防御）。内部调用（无 agent）放行，
    // 避免误伤宿主侧的程序化调用。
    ctx.on("tools/pre-execute", (exec, next) => {
      const current = source();
      if (current.enabled !== true) return next();
      const agent = exec?.agent;
      if (agent === null || agent === undefined || typeof agent !== "object") return next();
      const name = exec?.name;
      if (typeof name !== "string") return next();
      if (!allowedToolSet(agent).has(name)) {
        ctx.logger.info(`[kaz-mode] 拒绝调用工具 "${name}"（不在 Kaz 工具面内）`);
        return {
          kind: "deny",
          reason:
            `工具 "${name}" 不在 Kaz 模式工具面内（minimalTools + toolWhitelist）。` +
            `如需使用，请在 settings.yaml 的 kaz-mode.toolWhitelist 中放行（首次工具调用前仅 minimalTools ∪ round-minimal 首轮工具集）。`,
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

    // 预设联动：监听 agent-presets 命名空间的变化（预设选择器 / 右上角按钮
    // 写入 default 字段都会触发）。从 prev 里拿到"切换前的预设"记录到
    // previousPreset，再按新预设同步 kaz-mode.enabled。
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
        syncFromPreset();
      } catch (error) {
        ctx.logger.warn(`[kaz-mode] 预设联动处理失败：${safeMessage(error)}`);
      }
    });

    // 会话级预设联动：新对话框（空白会话）切换预设时（预设选择器 select 提交后
    // 宿主重发的 agent-preset/selected）同步 kaz-mode.enabled。
    ctx.on("agent-preset/selected", (_sessionId, agentPreset) => {
      if (typeof agentPreset !== "string") return;
      void syncEnabledForPreset(agentPreset);
    });

    // 启动时同步：若默认预设已是 kaz（例如重启前就选着），则开启联动。
    let startupSynced = false;
    const syncStartupOnce = () => {
      if (startupSynced) return;
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
        if (sessionId.length === 0 && endpoint !== "resetDefault" && endpoint !== "getState" && endpoint !== "setDefaultPlugin") {
          return rpcFail("缺少 sessionId");
        }

        if (endpoint === "getState") {
          const cwd = sessionId.length > 0 ? resolveSessionCwd(sessionId) : activeSession !== null ? activeSession.cwd : process.cwd();
          const data = loadStateFile(cwd, ctx.logger);
          if (sessionId.length > 0) activeSession = { sessionId, cwd };
          return {
            ok: true,
            value: {
              sessionId,
              cwd,
              kazEnabled: source().enabled === true,
              defaults: data.defaults,
              session: data.sessions[sessionId] || null,
              factory: {
                nonKaz: deepClone(FACTORY_NON_KAZ_DEFAULTS),
                kaz: deepClone(FACTORY_KAZ_DEFAULTS),
              },
            },
          };
        }

        if (endpoint === "applySession") {
          const { cwd, data } = loadSessionData(sessionId);
          activeSession = { sessionId, cwd };
          await applyEffectiveState(cwd, sessionId);
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
          await applyEffectiveState(cwd, sessionId);
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
          // "当前对话的插件状态" = 有效状态（专属覆盖 > 当前模式默认）。
          const effective = effectivePluginStates(data, sessionId, source().enabled === true);
          data.defaults[mode] = deepClone(effective);
          saveDefaults(data.defaults, ctx.logger);
          activeSession = { sessionId, cwd };
          await applyEffectiveState(cwd, sessionId);
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
            await applyEffectiveState(cwd, sessionId);
          }
          return { ok: true, value: { defaults: data.defaults } };
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
