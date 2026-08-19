// kaz-mode
// ===========================================================================
// 「Kaz 模式」超级模式插件 —— 统一管理并联动本工作区插件：
//   thinking-anchor（插件1）、round-minimal（插件2）、tool-grouping（插件3）、
//   tool-filter（插件4）、code-collapse（插件5）、output-beep（插件6）、
//   task-master-whiteboard（插件7 · 任务白板）、round-display（插件8 · 每轮注入显示）、
//   deepseek-default-model（插件9 · DeepSeek 默认参数）、kaz-memory（独立记忆组件），
//   并提供集中管理面板与头部开关按钮（客户端半）。
//
// 宿主平面职责：
//   1) 插件联动：只有 kaz-mode.enabled 变为 true（进入 Kaz）时，先快照被管理
//      插件的原始 enabled 状态到 kaz-mode.savedPluginStates（供状态报告展示），
//      再按会话/默认状态应用；defaultDisabledPlugins 默认关闭清单里的
//      插件（默认 task-master-whiteboard）例外——进入 Kaz 时被置为 enabled=false
//      （Kaz 模式下默认关闭，用户仍可在面板 / settings.yaml 手动开启，联动不再
//      触碰它们）；变为 false（关闭 / 切走）时按会话/非 Kaz 默认状态应用（无活跃
//      会话时保持插件 enabled 状态不变）。例外：round-minimal 的
//      showPolicy（轮次提示段开关）进入 Kaz 时快照原值并置 false，退出 Kaz 时
//      按快照精确恢复（原值可能是 false）。
//   2) 预设联动：Kaz 模式已注册为 agent preset（id: kaz）。default 切到 "kaz"
//      或会话切换到 kaz 时把 kaz-mode.enabled 置 true（触发上面的插件联动）；
//      切到其它预设 / 其它会话时置 false（不改动四个插件）。同时把最近一个
//      非 kaz 预设记录到 kaz-mode.previousPreset，供按钮"关闭"时切回。
//      按钮状态与切换都跟随预设 / 当前会话（客户端半实现视图联动）。
//   3) 工具分组依赖：本插件不内置任何工具列表。分组事实全部来自 tool-grouping
//      插件发布的 toolGrouping 运行时服务（enabled/groups/groupOf/isRegistered）。
//      首轮工具集完全由 round-minimal 的 firstRoundTools 配置决定。
//   4) Kaz 工具面（极简基底 + 白名单）：enabled=true 时，把模型可见/可调用的
//      工具收敛为 minimalTools（默认 pwsh、str_replace_editor）+ toolWhitelist
//      白名单（默认放行 kaz-memory / tool-fs / workflowEngine 三个组 id——经
//      toolGrouping 服务展开为组内工具——以及 tool_grouping_status /
//      kaz_mode_status 两个状态工具）。组装层过滤工具与 tool:* 指导段，执行层
//      拒绝白名单外的调用；host 平面监听器对所有 agent 生效，因此子代理会话
//      同样是 Kaz 工具面。
//   5) round-minimal 信号 + 首轮极简伪装：订阅 round-minimal/state 事件、
//      查询 roundMinimal 服务。首轮极简激活时（isMinimal=true）本插件把
//      工具面收敛为 minimalTools ∪ round-minimal 首轮工具集（含
//      task-master-whiteboard 白板工具；不展开白名单），并把提示段滤到只剩
//      persona + thinking-anchor + round-minimal 轮次提示 + code-collapse
//      首轮提醒 + task-master-whiteboard:role（与原生极简模式的 complete
//      persona 效果一致——首轮没有任何其它提示段，也不提示模型"先搜索记忆"）；
//      次轮起 persona 替换为 postFirstRoundMode 对应的基底 persona
//      （standard / minimal / creative，分别对应 shipped standard /
//      minimal / cordis 预设），并恢复白名单与记忆指引。
//   6) 只读状态工具 kaz_mode_status：输出联动状态、各插件启停状态、Kaz 工具面、
//      round-minimal 信号、tool-grouping 运行时分组视图与 round-minimal 首轮
//      基底，用于验证。
//   7) 首轮提示："请在第一句话中说明本次对话的总任务目标。" 由客户端半显示在
//      输入框上方（仅 UI 可见，不注入模型提示词）——本插件不注册任何
//      systemPrompt 段，除联动与提示文案外不触碰用户已有配置。
// ===========================================================================

import z from "@deepseek-ai/schemastery";
import { defineTool, renderToolsSdk } from "@deepseek-ai/dsh-tools";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 设置命名空间：~/.dsh/settings.yaml 中的 kaz-mode: 段。 */
const NAMESPACE = settingsNamespace("kaz-mode");

/** agent-presets 设置命名空间（预设切换的读写目标，与官方选择器一致）。 */
const PRESETS_NAMESPACE = settingsNamespace("agent-presets");

/** Kaz 模式对应的 agent preset id（~/.dsh/.agent-presets/kaz/）。 */
const KAZ_PRESET_ID = "kaz";

/** 按钮"关闭 Kaz"时的兜底预设。 */
const FALLBACK_PRESET_ID = "cordis";

/** 首轮 UI 提示默认文案（显示给用户看，不进入模型提示词）。 */
const DEFAULT_FIRST_ROUND_HINT = "请在第一句话中说明本次对话的总任务目标。";

/** 首轮极简伪装保留的提示段：persona（kaz 预设 = 极简模式原句）、
 *  thinking-anchor（自由输出，不受 Kaz 限制；其关闭时输出空串自然丢弃）、
 *  task-master-whiteboard:role（Task Master 角色，仅首轮注入——首轮正是
 *  它生效的时机，因此必须保留）。 */
const PERSONA_SECTION = "deployment:persona";
const THINKING_ANCHOR_SECTION = "thinking-anchor:policy";
const ROUND_MINIMAL_POLICY_SECTION = "round-minimal:policy";
const CODE_COLLAPSE_FIRST_ROUND_SECTION = "code-collapse:first-round";
const TASK_MASTER_ROLE_SECTION = "task-master-whiteboard:role";

/** postFirstRoundMode 的可用值与默认值（首轮之后恢复的基底模式）。
 *  注意：曾有过 "ptc"（对应 shipped code 预设）——它只换 persona 不切 Code Mode
 *  工具呈现，与 standard 效果完全一样，是误导选项，2026-08-17 已删除。 */
const POST_ROUND_MODES = ["standard", "minimal", "creative"];
const DEFAULT_POST_ROUND_MODE = "standard";

/**
 * postFirstRoundMode → 首轮之后恢复的 persona 文本，与 shipped 预设逐字一致：
 *   standard = shipped `standard` 预设 persona
 *   minimal  = shipped `minimal` 预设 persona（极简模式）
 *   creative = shipped `cordis` 预设 persona（创造模式）
 * {{model}} / {{cwd}} 由 dsh-agent-loop 的全局变量解析。升级 dsh 后若对应
 * persona 变化，需同步更新这些文本。
 */
const POST_ROUND_PERSONA = {
  standard: "You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.",
  minimal: "You are a helpful software engineer assistant.",
  creative: `You are a coding agent powered by the {{model}} model, running on the DeepSeek Harness. Your working directory is {{cwd}}.

You can read and modify the harness you run on. Its composition is Cordis: every capability is a plugin row in a \`cordis.yml\`, and an agent preset is one such file mounted for a single session.

Two planes decide where an edit belongs. The HOST composition holds the registries and anything shared across sessions — persistence, the sandbox and approval stack, the model route, the subagent registry and its backends. An AGENT PRESET holds what one session contributes to those registries: its tools, its persona, its prompt sections. A row that publishes a service belongs in the host composition, or inside an \`isolate\` realm if the preset genuinely owns that service and nothing outside one agent reads it.

Presets you author live one directory per preset under \`\${DSH_HOME:-$HOME/.dsh}/.agent-presets/<id>/\`; the roster reports each preset's real path, so take the one you edit from there. NEVER edit or delete the shipped preset install (the \`agent-presets\` directory beside the deployment's own config): it belongs to the deployment, an upgrade overwrites it, and corrupting the \`cordis\` preset would disable this very mode. To change what a shipped preset does, copy its composition into a new preset directory and edit the copy.

Load the \`editing-cordis-compositions\` skill before writing or changing a composition.`,
};

/** Kaz 工具面·极简基底（始终保留的最小工具集）。 */
const DEFAULT_MINIMAL_TOOLS = ["pwsh", "str_replace_editor"];

/** Kaz 工具面·白名单默认值：逐个列出工具名（不使用组 id——tool-grouping 可能被
 *  用户关闭，分组归属完全交给 tool-grouping；minimalTools 另算，不在白名单内）。 */
const DEFAULT_TOOL_WHITELIST = [
  "read", "write", "edit", "glob", "grep",
  "job_list", "job_output", "job_kill",
  "web_search", "skill", "todo_write", "ask_user_question",
  "create_goal", "get_goal", "update_goal",
  "subagent", "subagent_fork", "list_agents", "send_message", "interrupt_agent",
  "workflow", "ralph",
  "memory_save", "memory_list", "memory_search", "memory_forget",
  "tool_grouping_status", "kaz_mode_status",
];

/** 进入 Kaz 时默认关闭的被管理插件 id 清单（Kaz 模式下默认关闭，
 *  但用户仍可在面板 / settings.yaml 手动开启）。 */
const DEFAULT_DISABLED_PLUGINS = ["task-master-whiteboard"];

/** 被管理的插件（id 与 settings.yaml 命名空间一致）。 */
const MANAGED_PLUGINS = [
  { id: "thinking-anchor", label: "thinking-anchor（插件1 · 思考锚点）" },
  { id: "round-minimal", label: "round-minimal（插件2 · 极简plus轮次模式）" },
  { id: "tool-grouping", label: "tool-grouping（插件3 · 工具分组）" },
  { id: "tool-filter", label: "tool-filter（插件4 · 工具过滤）" },
  { id: "code-collapse", label: "code-collapse（插件5 · 工具塌缩 run_code）" },
  { id: "output-beep", label: "output-beep（插件6 · 输出完成提示音）" },
  { id: "round-display", label: "round-display（插件8 · 每轮注入显示）" },
  { id: "deepseek-default-model", label: "deepseek-default-model（插件9 · DeepSeek 默认参数）" },
  { id: "kaz-memory", label: "kaz-memory（独立记忆组件）" },
  { id: "task-master-whiteboard", label: "task-master-whiteboard（插件7 · 任务白板）" },
];

/** 出厂默认（非 Kaz 模式）：Kaz 插件初始默认全关。 */
const FACTORY_NON_KAZ_DEFAULTS = {
  "thinking-anchor": { enabled: false, instruction: "", turnReminder: "" },
  "round-minimal": {
    enabled: false,
    firstRoundTools: ["pwsh", "str_replace_editor"],
    roundOneInstruction: "",
    roundTwoInstruction: "",
    includeSubagents: false,
    showPolicy: true,
  },
  "tool-grouping": {
    enabled: false,
    registerStatusTool: true,
    mode: "tag",
    groups: [
      { id: "tool-fs", realm: "minimal-local-fs", tools: ["read", "write", "edit", "glob", "grep"] },
      { id: "workflowEngine", realm: "workflowEngine", tools: ["workflow", "ralph"] },
      { id: "kaz-memory", realm: "kazMemory", tools: ["memory_save", "memory_list", "memory_search", "memory_forget"] },
    ],
  },
  "tool-filter": {
    enabled: false,
    mode: "remove",
    disabledTools: ["tool-cordis", "tool-subagent-report", "codex", "claude-code"],
  },
  "code-collapse": { enabled: false, appendCallHint: true, callHint: "", firstRoundHint: true },
  "output-beep": { enabled: false, includeSubagents: false, frequency: 1000, duration: 300 },
  "round-display": { enabled: false },
  "deepseek-default-model": {
    enabled: false,
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    reasoningEffort: "high",
    generation_kwargs: { temperature: 0.2, top_p: 1, repetition_penalty: 1.2 },
  },
  "kaz-memory": { enabled: false, guidance: "", guidanceHead: "" },
  "task-master-whiteboard": { enabled: false, boardsDir: "", turnReminder: "" },
};

/** 出厂默认（Kaz 模式）：Kaz 插件初始默认全开，仅 task-master-whiteboard 默认关闭。 */
const FACTORY_KAZ_DEFAULTS = {};
for (const [id, cfg] of Object.entries(FACTORY_NON_KAZ_DEFAULTS)) {
  FACTORY_KAZ_DEFAULTS[id] = { ...cfg, enabled: true };
}
FACTORY_KAZ_DEFAULTS["task-master-whiteboard"] = {
  ...FACTORY_NON_KAZ_DEFAULTS["task-master-whiteboard"],
  enabled: false,
};

/** 会话级插件状态文件名（与 task-master-whiteboard 一致放在项目 .dsh/ 下）。 */
const SESSION_STATES_FILE = "kaz-session-states.json";
/** 两个模式的默认设置文件名（放在插件目录下，随插件分发/安装存在）。 */
const DEFAULTS_FILE_NAME = "kaz-defaults.json";
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULTS_FILE = join(PLUGIN_DIR, "..", DEFAULTS_FILE_NAME);
/** 面板专用 RPC 通道。 */
const RPC_CHANNEL = "/kaz-mode";

/** 设置 schema（同时驱动设置页 UI 与客户端面板的字段读写）。 */
const SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(false),
  registerStatusTool: z.boolean().default(true),
  showFirstRoundHint: z.boolean().default(true),
  firstRoundHint: z.string().default(DEFAULT_FIRST_ROUND_HINT),
  managedPlugins: z.array(z.string()).default(MANAGED_PLUGINS.map((plugin) => plugin.id)),
  /** 进入 Kaz 时默认关闭的被管理插件 id 清单（Kaz 模式下默认关闭，仍可手动开启）。 */
  defaultDisabledPlugins: z.array(z.string()).default([...DEFAULT_DISABLED_PLUGINS]),
  /** Kaz 工具面·极简基底（始终保留的最小工具集）。 */
  minimalTools: z.array(z.string()).default([...DEFAULT_MINIMAL_TOOLS]),
  /** Kaz 工具面·白名单：逐个列出工具名（不用组 id，分组归属交给 tool-grouping），热改生效。 */
  toolWhitelist: z.array(z.string()).default([...DEFAULT_TOOL_WHITELIST]),
  /** 最近一个非 kaz 预设（按钮"关闭 Kaz"时切回的目标，由预设联动自动维护）。 */
  previousPreset: z.string().default(FALLBACK_PRESET_ID),
  /** 首轮之后恢复的基底模式：standard / minimal / creative（对应 shipped standard / minimal / cordis 预设的 persona）。 */
  postFirstRoundMode: z.string().default(DEFAULT_POST_ROUND_MODE),
  /** round-minimal.showPolicy 的联动快照（内部字段：进入 Kaz 时记录，退出 Kaz 时按此恢复并清空）。 */
  roundMinimalPolicySnapshot: z
    .object({
      active: z.boolean().default(false),
      hadOverride: z.boolean().default(false),
      value: z.boolean().default(true),
    })
    .default({ active: false, hadOverride: false, value: true }),
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
 *  savedPluginStates / roundMinimalPolicySnapshot / previousPreset 是运行时联动
 *  字段（Kaz 面板自行写入），不预置，避免把本机的联动状态带到新机器。 */
export const DEFAULT_SECTION = {
  enabled: true,
  postFirstRoundMode: DEFAULT_POST_ROUND_MODE,
  defaultDisabledPlugins: [...DEFAULT_DISABLED_PLUGINS],
  toolWhitelist: [
    "read", "write", "edit", "glob", "grep",
    "job_list", "job_output", "job_kill",
    "web_search", "skill", "todo_write", "ask_user_question",
    "create_goal", "get_goal", "update_goal",
    "subagent", "subagent_fork", "list_agents", "send_message", "interrupt_agent",
    "workflow", "ralph",
    "memory_save", "memory_list", "memory_search", "memory_forget",
    "tool_grouping_status", "kaz_mode_status",
    "new_whiteboard", "list_whiteboards", "read_whiteboard",
    "append_whiteboard", "update_whiteboard", "clear_whiteboard",
  ],
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

/** 读取插件目录下的默认设置文件；不存在或损坏时回退到代码内出厂默认。 */
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

/** 写回插件目录下的默认设置文件（非 Kaz / Kaz 两个模式）。 */
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

/** 会话键消毒（与 task-master-whiteboard 一致，防止路径穿越）。 */
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
    registerStatusTool: value.registerStatusTool !== false,
    showFirstRoundHint: value.showFirstRoundHint !== false,
    minimalTools,
    toolWhitelist,
    firstRoundHint:
      typeof value.firstRoundHint === "string" && value.firstRoundHint.trim().length > 0
        ? value.firstRoundHint.trim()
        : DEFAULT_FIRST_ROUND_HINT,
    managedPlugins: managed,
    defaultDisabledPlugins,
    previousPreset:
      typeof value.previousPreset === "string" && value.previousPreset.trim().length > 0
        ? value.previousPreset.trim()
        : FALLBACK_PRESET_ID,
    postFirstRoundMode:
      typeof value.postFirstRoundMode === "string" && POST_ROUND_MODES.includes(value.postFirstRoundMode)
        ? value.postFirstRoundMode
        : DEFAULT_POST_ROUND_MODE,
    roundMinimalPolicySnapshot:
      value.roundMinimalPolicySnapshot !== null && typeof value.roundMinimalPolicySnapshot === "object"
        ? {
            active: value.roundMinimalPolicySnapshot.active === true,
            hadOverride: value.roundMinimalPolicySnapshot.hadOverride === true,
            value: value.roundMinimalPolicySnapshot.value !== false,
          }
        : { active: false, hadOverride: false, value: true },
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
  // tools：状态工具注册挂在其链路上；systemPrompt：组装层工具面过滤挂在
  // 其瀑布上；connection：面板 RPC 通道；settings / toolGrouping / roundMinimal
  // 为可选依赖（惰性解析）。
  inject: ["tools", "systemPrompt", "connection"],
  apply(ctx, config = {}) {
    // 组合行 config 作为 base 层；settings.yaml 用户层优先（热重载）。
    const entry = normalizeConfig(config);
    let source = () => entry;

    /** 联动事务防重入：一次联动（快照+启用 / 恢复+清空）未结束前不重复触发。 */
    let linking = false;
    let statusDisposer = null;

    /** 当前由客户端告知的活跃会话（用于按会话应用插件状态）。 */
    let activeSession = null;

    /**
     * settings 服务惰性获取：启动时可能尚未挂载（kaz-mode 只 inject tools），
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
        // round-minimal 的 showPolicy（轮次提示段开关）参与 Kaz 联动：
        // 进入 Kaz 时快照原值并置 false，退出 Kaz 时按快照精确恢复。
        if (pluginId === "round-minimal") {
          state.showPolicy = value.showPolicy !== false;
          state.showPolicyHadOverride = userHas("showPolicy");
        }
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
     *  默认关闭清单内的插件跳过——Kaz 模式下默认关闭，联动不再启用它们）。
     *  返回实际写入个数。 */
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
     *  enabled=false（仅"进入 Kaz"瞬间执行一次；用户之后手动开启的保持开启，
     *  联动不再触碰）。返回实际写入个数。 */
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

    /** 快照 round-minimal.showPolicy 的原始状态（含用户覆盖位），供退出 Kaz 时恢复。
     *  已有待恢复快照（active=true，例如重启后续联）时不覆盖——保留最早的原始值。 */
    async function snapshotRoundMinimalPolicy() {
      const settings = getSettings();
      if (settings === undefined) return null;
      const current = source();
      if (current.roundMinimalPolicySnapshot.active === true) return null;
      const state = readPluginState("round-minimal");
      if (state === null) return null;
      const snap = {
        active: true,
        hadOverride: state.showPolicyHadOverride === true,
        value: state.showPolicy !== false,
      };
      try {
        await settings.update(NAMESPACE, { roundMinimalPolicySnapshot: snap });
        return snap;
      } catch (error) {
        ctx.logger.warn(`[kaz-mode] 快照 round-minimal.showPolicy 失败：${safeMessage(error)}`);
        return null;
      }
    }

    /** 联动开启 round-minimal 的轮次提示段（Kaz 模式下首轮/次轮提醒正常输出）。 */
    async function enableRoundMinimalPolicy() {
      const settings = getSettings();
      if (settings === undefined) return;
      const state = readPluginState("round-minimal");
      if (state === null || state.showPolicy !== false) return;
      try {
        await settings.update(settingsNamespace("round-minimal"), { showPolicy: true });
        ctx.logger.info("[kaz-mode] 联动开启 round-minimal.showPolicy（Kaz 模式：首轮/次轮轮次提示输出）");
      } catch (error) {
        ctx.logger.warn(`[kaz-mode] 联动开启 round-minimal.showPolicy 失败：${safeMessage(error)}`);
      }
    }

    /** 退出 Kaz：按快照精确恢复 round-minimal.showPolicy，然后清空快照。
     *  hadOverride=true → 写回用户原值（可能是 false，不无脑打开）；
     *  hadOverride=false → unset 掉联动写入，回到继承默认。 */
    async function restoreRoundMinimalPolicy() {
      const settings = getSettings();
      if (settings === undefined) return;
      const current = source();
      const snap = current.roundMinimalPolicySnapshot;
      if (snap === null || typeof snap !== "object" || snap.active !== true) return;
      try {
        const ns = settingsNamespace("round-minimal");
        if (snap.hadOverride === true) {
          await settings.update(ns, { showPolicy: snap.value !== false });
        } else {
          await settings.mutate(ns, [{ op: "unset", path: ["showPolicy"] }]);
        }
        await settings.update(NAMESPACE, {
          roundMinimalPolicySnapshot: { active: false, hadOverride: false, value: true },
        });
        ctx.logger.info(
          `[kaz-mode] 已恢复 round-minimal.showPolicy 原始状态：` +
            (snap.hadOverride === true ? `${snap.value !== false ? "true" : "false"}（用户原值）` : "未设置（回到继承默认）"),
        );
      } catch (error) {
        ctx.logger.warn(`[kaz-mode] 恢复 round-minimal.showPolicy 失败：${safeMessage(error)}`);
      }
    }

    /**
     * 联动主流程：enabled=true（进入 Kaz）→ 快照 + 按会话/默认状态应用插件；
     * enabled=false（关闭 / 切走）→ 按会话/非 Kaz 默认状态应用插件，并恢复
     * round-minimal.showPolicy。若尚无客户端告知的活跃会话，则回退到旧的
     * 强制启用/默认关闭行为，保证纯 settings.yaml 使用方式仍然可用。
     * 防重入用"重跑标记"：一次联动进行中又收到新触发时记下 pending，
     * 当前这轮结束后立刻按最新状态再跑一轮——避免同一次预设切换里
     * 先后触发的多次写入互相吞掉。
     */
    let linkRunPending = false;
    /** 上一次联动轮结束时的 enabled 状态（用于识别"由关→开"的进入瞬间）。 */
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
            // 进入 Kaz：只在"由关→开"的瞬间快照一次（记录本次开启前的原始
            // 状态，供状态报告展示）——之后的重入轮不再重拍，避免把联动
            // 强制启用后的状态误记成"原始状态"。
            if (entering) {
              const saved = await snapshotPluginStates();
              const settings = getSettings();
              if (Object.keys(saved).length > 0 && settings !== undefined) {
                await settings.update(NAMESPACE, { savedPluginStates: saved });
              }
              // round-minimal.showPolicy：先快照原值，再置 true（顺序不能反）。
              await snapshotRoundMinimalPolicy();
              await enableRoundMinimalPolicy();
            }
            if (activeSession !== null) {
              await applyEffectiveState(activeSession.cwd, activeSession.sessionId);
              ctx.logger.info(
                `[kaz-mode] Kaz 模式已开启：已按会话 ${activeSession.sessionId} 应用插件状态；原始状态快照已保存。`,
              );
            } else {
              // 默认关闭清单：进入 Kaz 的瞬间把这些插件置为 enabled=false
              // （Kaz 模式下默认关闭；用户之后手动开启的保持开启）。
              await forceDisableDefaultManaged();
              const enabledCount = await forceEnableManaged();
              ctx.logger.info(
                `[kaz-mode] Kaz 模式已开启：联动启用 ${enabledCount} 个插件（默认关闭清单已跳过）；原始状态快照已保存。`,
              );
            }
          } else {
            // 关闭 / 切走 Kaz：round-minimal 的 showPolicy 是进入 Kaz 时联动
            // 开启的，这里按快照精确恢复原始状态（用户原本是关的也恢复为关）。
            await restoreRoundMinimalPolicy();
            if (activeSession !== null) {
              await applyEffectiveState(activeSession.cwd, activeSession.sessionId);
              ctx.logger.info(
                `[kaz-mode] Kaz 模式已关闭：已按会话 ${activeSession.sessionId} 应用非 Kaz 默认插件状态。`,
              );
            } else {
              ctx.logger.info(
                `[kaz-mode] Kaz 模式已关闭：插件 enabled 保持当前状态；round-minimal.showPolicy 已按快照恢复。`,
              );
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
     * 只在预设实际变化时调用：用户在 settings.yaml 里手动改 kaz-mode.enabled
     * 不会被覆盖（预设再次切换时才重新同步）。
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
    // 白名单条目可以是组 id（经 toolGrouping 服务展开为组内工具）或字面
    // 工具名。组装层过滤工具与 tool:* 指导段；执行层拒绝白名单外调用。
    // host 平面监听器对所有 agent 生效 → 子代理会话同样是 Kaz 工具面。
    // -----------------------------------------------------------------------

    /** 记录最近一次 round-minimal/state 信号（供状态报告）。 */
    let lastSignal = null;
    ctx.on("round-minimal/state", (payload) => {
      if (payload === null || typeof payload !== "object") return;
      lastSignal = {
        minimal: payload.minimal === true,
        turn: typeof payload.turn === "number" ? payload.turn : 0,
        at: Date.now(),
      };
    });

    /** 查询 round-minimal 信号：该代理此刻是否处于首轮极简。 */
    function isMinimalAgent(agent) {
      const roundMinimal = ctx.get("roundMinimal");
      if (roundMinimal === undefined || typeof roundMinimal.isMinimal !== "function") return false;
      try {
        return roundMinimal.isMinimal(agent) === true;
      } catch {
        return false;
      }
    }

    /** 展开白名单：组 id → 组内工具；其余按字面工具名。返回 { tools, unresolved }。 */
    function expandWhitelist(entries) {
      const tools = new Set();
      const unresolved = [];
      const toolGrouping = ctx.get("toolGrouping");
      const groups =
        toolGrouping !== undefined && typeof toolGrouping.groups === "function"
          ? toolGrouping.groups()
          : [];
      const byId = new Map();
      for (const group of Array.isArray(groups) ? groups : []) {
        if (group !== null && typeof group === "object" && typeof group.id === "string") {
          byId.set(group.id, Array.isArray(group.tools) ? group.tools : []);
        }
      }
      for (const entry of entries) {
        const groupTools = byId.get(entry);
        if (groupTools !== undefined) {
          for (const tool of groupTools) {
            if (typeof tool === "string" && tool.trim().length > 0) tools.add(tool.trim());
          }
        } else {
          tools.add(entry);
          unresolved.push(entry);
        }
      }
      return { tools, unresolved };
    }

    /** 计算某代理此刻的 Kaz 工具面（Set）。首轮极简时 = minimalTools ∪
     *  round-minimal 首轮工具集（后者含 task-master-whiteboard 自动加入的
     *  白板工具，保证首轮即可用）；次轮起 = minimalTools + 白名单。 */
    function allowedToolSet(agent) {
      const current = source();
      const allowed = new Set(current.minimalTools);
      if (isMinimalAgent(agent) === true) {
        // 首轮极简：跟随 round-minimal 的首轮工具集（含白板工具），
        // 不展开白名单。roundMinimal 服务缺失时保持 minimalTools。
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
        const { tools } = expandWhitelist(current.toolWhitelist);
        for (const tool of tools) allowed.add(tool);
      }
      return allowed;
    }

    /** 该代理是否呈现为 Code Mode（code-collapse 的 presentAs('code') 生效）。
     *  Code Mode 下 wire 只有 run_code，首轮极简必须放行它（联动 round-minimal：
     *  不放行则首轮工具面为空）。运行时检测：code-collapse 未启用或声明失败
     *  时返回 false，首轮保持原生极简。 */
    function isCodeMode(agent) {
      try {
        const toolsSvc = ctx.get("tools");
        if (toolsSvc !== undefined && toolsSvc !== null && typeof toolsSvc.modeFor === "function") {
          return toolsSvc.modeFor(agent) === "code";
        }
      } catch {
        return false;
      }
    }

    // 组装层：过滤工具列表与提示段。
    //   首轮极简信号激活时执行"极简伪装"：只保留 persona + thinking-anchor
    //   两段（原生极简模式用 complete persona 压掉其它所有段；kaz 预设不用
    //   complete 是为了第 2 轮起能按 postFirstRoundMode 切换基底，所以这里
    //   显式滤除）——首轮没有 memory_search 等任何其它提示，也不提示模型
    //   "先搜索记忆"。
    //   次轮起：persona 替换为 postFirstRoundMode 对应的基底文本
    //   （standard / minimal / creative），tool:* 段按白名单过滤，
    //   kaz-memory 记忆指引恢复（首轮已无 memory 工具的提示）。
    ctx.on("system-prompt/assemble", function (assembly, context, next) {
      const current = source();
      if (current.enabled !== true) return next();
      const agent = context?.agent;
      const minimal = isMinimalAgent(agent);
      const allowed = allowedToolSet(agent);
      assembly.tools = assembly.tools.filter((tool) => {
        if (tool === null || typeof tool !== "object") return false;
        // code-collapse：非首轮保留 run_code（工具面折叠的唯一入口）；首轮极简
        // 仅当该代理呈现为 Code Mode 时放行（联动：Code Mode 的 wire 只有
        // run_code，pwsh/str_replace_editor 折叠进 SDK，不放行则首轮工具面为空）。
        if (tool.name === "run_code") return minimal !== true || isCodeMode(agent);
        return allowed.has(tool.name);
      });
      if (minimal === true) {
        // 首轮极简伪装：保留 persona + thinking-anchor + round-minimal 轮次提示
        // + code-collapse 首轮提醒（thinking-anchor 自由输出不受 Kaz 限制；这些段
        // 各自内部会按开关/轮次输出空串，渲染时自然丢弃）。
        let kept = assembly.sections.filter(
          (section) =>
            section !== null &&
            typeof section === "object" &&
            typeof section.name === "string" &&
            (section.name === PERSONA_SECTION ||
              section.name === THINKING_ANCHOR_SECTION ||
              section.name === ROUND_MINIMAL_POLICY_SECTION ||
              section.name === CODE_COLLAPSE_FIRST_ROUND_SECTION ||
              section.name === TASK_MASTER_ROLE_SECTION),
        );
        // code-collapse 联动：Code Mode 下 wire 只发布 run_code，而 tools:sdk
        // 段已被上面的过滤滤除——模型不知道本轮可用工具与参数签名，无法用
        // run_code 调用 pwsh / str_replace_editor（曾因传错参数形状失败）。
        // 这里用真实 schema 渲染一份裁剪版 SDK（只含本轮实际可执行的工具 =
        // minimalTools ∩ round-minimal.firstRoundTools），与次轮 tools:sdk 同款
        // 格式（renderToolsSdk），模型照抄签名即可。
        if (isCodeMode(agent)) {
          // 优先取 roundMinimal 服务的有效首轮工具集（含白板工具）；服务缺失时
          // 回退 settings 配置。effective = minimalTools ∪ firstRoundTools（并集：
          // 白板工具不在 minimalTools 内，交集会把它漏掉）。
          let firstRoundTools = [];
          try {
            const rm = ctx.get("roundMinimal");
            if (rm !== undefined && rm !== null && typeof rm.firstRoundTools === "function") {
              firstRoundTools = rm.firstRoundTools().filter((t) => typeof t === "string" && t.length > 0);
            }
          } catch {
            firstRoundTools = [];
          }
          if (firstRoundTools.length === 0) {
            const rmSettings = getSettings()?.get(settingsNamespace("round-minimal"));
            firstRoundTools = Array.isArray(rmSettings?.firstRoundTools)
              ? rmSettings.firstRoundTools.filter((t) => typeof t === "string" && t.length > 0)
              : [];
          }
          const effective = [...new Set([...current.minimalTools, ...firstRoundTools])];
          if (effective.length > 0) {
            let sdkText = "";
            try {
              const toolsSvc = ctx.get("tools");
              if (toolsSvc !== undefined && toolsSvc !== null && typeof toolsSvc.sdkSchemas === "function") {
                const schemas = toolsSvc.sdkSchemas(agent).filter((s) => effective.includes(s.name));
                if (schemas.length > 0) sdkText = renderToolsSdk(schemas);
              }
            } catch {
              sdkText = "";
            }
            kept.push({
              name: "kaz-mode:round1-code-sdk",
              order: 150,
              text:
                sdkText.length > 0
                  ? "本轮工具面已折叠为 run_code：以下为**本轮可用工具**的 SDK 声明（其它工具不可见、不可调用，会被拒绝）。\n\n" + sdkText
                  : "本轮工具面已折叠为 run_code：本轮可用工具为 " + effective.join("、") + "（在 run_code 程序内以 await tools.<name>(...) 调用；其它工具不可见、不可调用）。",
            });
          }
        }
        assembly.sections = kept;
        return next();
      }
      // 次轮起：persona 换为 postFirstRoundMode 对应的基底文本。
      const mode = current.postFirstRoundMode;
      const personaText = POST_ROUND_PERSONA[mode] ?? POST_ROUND_PERSONA[DEFAULT_POST_ROUND_MODE];
      for (const section of assembly.sections) {
        if (
          section !== null &&
          typeof section === "object" &&
          section.name === PERSONA_SECTION &&
          typeof section.text === "string"
        ) {
          section.text = personaText;
        }
      }
      assembly.sections = assembly.sections.filter((section) => {
        // kaz-memory 的中文指引（tool:memory:kaz-memory）替代部署基础英文指引
        // （tool:memory）；指引只围绕 memory_search（存在且可调用才发），
        // 因此仅在 memory_search 放行时保留该段，否则移除。
        if (typeof section?.name !== "string" || !section.name.startsWith("tool:")) return true;
        if (section.name === "tool:memory") return false;
        if (section.name === "tool:memory:kaz-memory") {
          return allowed.has("memory_search");
        }
        return allowed.has(section.name.slice("tool:".length));
      });
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
      // code-collapse：非首轮放行 run_code；首轮极简仅当 Code Mode 呈现时放行
      // （联动：Code Mode 下 wire 只有 run_code，不放行则首轮工具面为空）。
      if (name === "run_code" && (isMinimalAgent(agent) !== true || isCodeMode(agent))) return next();
      if (!allowedToolSet(agent).has(name)) {
        ctx.logger.info(`[kaz-mode] 拒绝调用工具 "${name}"（不在 Kaz 工具面内）`);
        return {
          kind: "deny",
          reason:
            `工具 "${name}" 不在 Kaz 模式工具面内（minimalTools + toolWhitelist）。` +
            `如需使用，请在 settings.yaml 的 kaz-mode.toolWhitelist 中放行（可填组 id 或工具名）。`,
        };
      }
      return next();
    });

    // -----------------------------------------------------------------------
    // 状态报告（kaz_mode_status 工具与日志共用）
    // -----------------------------------------------------------------------

    /** 生成完整状态报告；分组数据全部来自 tool-grouping 运行时服务。 */
    function buildReport(agent = undefined) {
      const current = source();
      const lines = [];
      lines.push("kaz-mode 状态报告");
      lines.push("==================================================");
      lines.push(
        `配置: enabled=${current.enabled}, showFirstRoundHint=${current.showFirstRoundHint}, ` +
          `registerStatusTool=${current.registerStatusTool}`,
      );
      lines.push(`首轮提示（仅 UI 显示，不注入模型提示词）: ${current.firstRoundHint}`);
      lines.push("");
      lines.push("[预设联动]");
      const preset = currentPreset();
      lines.push(
        `  当前预设: ${preset ?? "（不可读）"}${preset === KAZ_PRESET_ID ? " ← Kaz 模式" : ""}` +
          `；上次非 kaz 预设（关闭时切回目标）: ${current.previousPreset}`,
      );
      lines.push(`  说明：Kaz 模式已注册为 agent preset（id: kaz），按钮与预设选择器双向同步。`);
      lines.push("");

      lines.push("[插件联动]");
      const saved = current.savedPluginStates ?? {};
      const disabledByDefault = new Set(current.defaultDisabledPlugins);
      for (const plugin of managedList()) {
        const state = readPluginState(plugin.id);
        lines.push(`  • ${plugin.label}`);
        if (disabledByDefault.has(plugin.id)) {
          lines.push("      Kaz 默认关闭清单（defaultDisabledPlugins）：进入 Kaz 时置为禁用，仍可在面板手动开启");
        }
        if (state === null) {
          lines.push("      状态: 未加载（settings 未注册，该插件行可能未挂载）");
        } else {
          lines.push(
            `      状态: ${state.enabled ? "启用" : "禁用"}` +
              `${state.hadOverride ? "（用户在 settings.yaml 有覆盖）" : "（继承组合配置/默认值）"}`,
          );
        }
        const before = saved[plugin.id];
        if (before !== undefined && before !== null) {
          lines.push(
            `      开启 Kaz 前的原始状态: enabled=${before.enabled}` +
              `${before.hadOverride ? "（用户覆盖）" : "（继承）"}`,
          );
        }
      }
      lines.push(
        current.enabled
          ? `联动状态: 已开启${Object.keys(saved).length > 0 ? `，保存了 ${Object.keys(saved).length} 个插件的原始状态` : ""}`
          : "联动状态: 未开启（关闭时按快照恢复 round-minimal.showPolicy）",
      );
      lines.push("");

      lines.push("[前置插件]（Kaz 模式的前置依赖，必须存在）");
      const prereqSettings = getSettings();
      const prereqs = ["thinking-anchor", "round-minimal", "tool-grouping", "tool-filter", "kaz-memory"];
      for (const id of prereqs) {
        const loaded = prereqSettings !== undefined && prereqSettings.get(settingsNamespace(id)) !== undefined;
        lines.push(`  ${loaded ? "✓" : "✗"} ${id}${loaded ? "" : "（未加载——前置缺失！）"}`);
      }
      lines.push("");

      lines.push("[首轮伪装与基底恢复]");
      lines.push(
        `  postFirstRoundMode: ${current.postFirstRoundMode}` +
          (POST_ROUND_PERSONA[current.postFirstRoundMode] !== undefined ? "" : "（未知值，回退 standard）"),
      );
      lines.push("  首轮（round-minimal 极简信号激活）：系统提示保留 persona + thinking-anchor + round-minimal 轮次提示 + code-collapse 首轮提醒 + task-master-whiteboard:role（首轮角色，仅首轮注入）");
      lines.push(
        isCodeMode(agent)
          ? "  首轮 Code Mode（code-collapse 联动）：放行 run_code，并附加 kaz-mode:round1-code-sdk 极简声明段（列出本轮可用工具与绑定名）"
          : "  首轮原生呈现：工具面 = minimalTools ∪ round-minimal 首轮工具集（含白板工具），无额外声明段",
      );
      lines.push("  次轮起：persona 替换为 postFirstRoundMode 对应的预设文本（standard/minimal/creative，{{model}}/{{cwd}} 按代理解析）；tool:* 段按白名单过滤");
      const policySnap = current.roundMinimalPolicySnapshot;
      if (policySnap !== null && typeof policySnap === "object" && policySnap.active === true) {
        const restoreDesc =
          policySnap.hadOverride === true
            ? `${policySnap.value !== false ? "true" : "false"}（用户原值）`
            : "继承默认";
        lines.push(`  round-minimal.showPolicy 快照: 待恢复（退出 Kaz 时恢复为 ${restoreDesc}）`);
      } else {
        lines.push("  round-minimal.showPolicy 快照: 无待恢复快照");
      }
      lines.push("");

      lines.push("[Kaz 工具面]（minimalTools 极简基底 + toolWhitelist 白名单；首轮极简时 = 基底 ∪ round-minimal 首轮工具集）");
      lines.push(`  极简基底 minimalTools: [${current.minimalTools.join(", ")}]`);
      lines.push(`  白名单 toolWhitelist: [${current.toolWhitelist.join(", ")}]`);
      const whitelist = expandWhitelist(current.toolWhitelist);
      lines.push(`  白名单展开工具（${whitelist.tools.size} 个）: ${[...whitelist.tools].sort().join(", ") || "（无）"}`);
      if (whitelist.unresolved.length > 0) {
        lines.push(`  白名单字面工具（非组 id，按工具名直接放行）: ${whitelist.unresolved.join(", ")}`);
      }
      const surface = allowedToolSet(agent);
      const groupingSvc = ctx.get("toolGrouping");
      const isRegisteredOf = (name) => {
        if (groupingSvc === undefined || typeof groupingSvc.isRegistered !== "function") return true;
        try {
          return groupingSvc.isRegistered(name) === true;
        } catch {
          return true;
        }
      };
      const surfaceNames = [...surface].sort();
      const mounted = surfaceNames.filter(isRegisteredOf);
      const unmounted = surfaceNames.filter((name) => !isRegisteredOf(name));
      lines.push(
        `  当前工具面（定义 ${surfaceNames.length} 个，实际已注册 ${mounted.length} 个）: ${mounted.join(", ") || "（无）"}`,
      );
      if (unmounted.length > 0) {
        lines.push(`  定义中但未挂载（不计入实际工具面）: ${unmounted.join(", ")}`);
      }
      lines.push("  子代理会话: 同样适用 Kaz 工具面（host 平面监听器对所有 agent 生效）");
      lines.push("");
      lines.push("[round-minimal 信号]");
      const roundMinimalSvc = ctx.get("roundMinimal");
      lines.push(
        roundMinimalSvc === undefined
          ? "  ✗ roundMinimal 服务未发布（round-minimal 未加载或版本过旧，首轮记忆指引抑制不可用）"
          : "  ✓ roundMinimal 服务已发布（首轮极简激活时移除 tool:memory 记忆检索指引）",
      );
      if (agent !== undefined) {
        lines.push(`  当前代理首轮极简: ${isMinimalAgent(agent) ? "是（工具面 = minimalTools ∪ round-minimal 首轮工具集，已移除 tool:memory）" : "否（工具面 = minimalTools + 白名单）"}`);
      }
      if (lastSignal !== null) {
        lines.push(
          `  最近信号: minimal=${lastSignal.minimal}, turn=${lastSignal.turn}` +
            (lastSignal.at !== undefined ? `, ${new Date(lastSignal.at).toLocaleTimeString()}` : ""),
        );
      }
      lines.push("");

      lines.push("[工具分组]（数据来源：tool-grouping 插件的 toolGrouping 运行时服务，kaz-mode 不内置工具列表）");
      const toolGrouping = ctx.get("toolGrouping");
      if (toolGrouping === undefined) {
        lines.push("  ✗ tool-grouping 未发布 toolGrouping 服务（插件未加载或版本过旧，请更新 tool-grouping）");
      } else if (typeof toolGrouping.enabled === "function" && toolGrouping.enabled() !== true) {
        lines.push("  ✗ tool-grouping 已加载但 enabled=false，当前没有任何分组");
      } else {
        const groups = typeof toolGrouping.groups === "function" ? toolGrouping.groups() : [];
        for (const group of Array.isArray(groups) ? groups : []) {
          lines.push(`  [组] ${group.id}  (realm: ${group.realm})`);
          for (const name of Array.isArray(group.tools) ? group.tools : []) {
            const isRegistered = typeof toolGrouping.isRegistered === "function" ? toolGrouping.isRegistered(name) : null;
            lines.push(`    ${isRegistered === true ? "✓" : "✗"} ${name}${isRegistered === false ? "（未注册）" : ""}`);
          }
        }
      }
      lines.push("");

      lines.push("[首轮极简基底]（数据来源：round-minimal 配置，kaz-mode 不内置工具列表）");
      const settings = getSettings();
      const roundMinimal = settings === undefined ? undefined : settings.get(settingsNamespace("round-minimal"));
      if (roundMinimal === undefined || roundMinimal === null || typeof roundMinimal !== "object") {
        lines.push("  ✗ round-minimal 未加载");
      } else {
        const tools = Array.isArray(roundMinimal.firstRoundTools) ? roundMinimal.firstRoundTools : [];
        lines.push(
          `  enabled=${roundMinimal.enabled !== false}, showPolicy=${roundMinimal.showPolicy !== false}, ` +
            `firstRoundTools=[${tools.join(", ")}]`,
        );
      }
      lines.push(
        "  说明：Kaz 模式下首轮工具集完全由 round-minimal 的 firstRoundTools 决定，" +
          "分组归属完全由 tool-grouping 的运行时结果决定，kaz-mode 不重复定义。",
      );
      return lines.join("\n");
    }

    /** 注册只读状态工具（registerStatusTool=true 时注册，无论开关状态——诊断工具不该被开关藏起来）。 */
    function installStatusTool() {
      if (statusDisposer !== null) return;
      const current = source();
      if (current.registerStatusTool !== true) return;
      try {
        statusDisposer = ctx.tools.register(
          defineTool({
            name: "kaz_mode_status",
            description:
              "只读报告 kaz-mode 超级模式当前状态：Kaz 模式开关、五个前置插件（thinking-anchor / round-minimal / tool-grouping / tool-filter / kaz-memory）的加载状态、被管理插件（含 code-collapse / output-beep / task-master-whiteboard / round-display / deepseek-default-model / kaz-memory）的启停、原始状态快照与 Kaz 默认关闭清单（defaultDisabledPlugins）、Kaz 工具面（minimalTools 极简基底 + toolWhitelist 白名单）、首轮极简伪装（首轮保留 persona + thinking-anchor + round-minimal 轮次提示 + code-collapse 首轮提醒 + task-master-whiteboard:role）与 postFirstRoundMode 基底恢复、round-minimal 信号与首轮工具基底（含 showPolicy）、tool-grouping 运行时分组视图。无需任何参数。",
            parameters: {},
            output: {
              schema: { type: "string" },
              render: (_args, value) => [{ type: "text", text: value }],
            },
            async execute(_args, exec) {
              return buildReport(exec?.agent);
            },
          }),
        );
      } catch (error) {
        ctx.logger.warn(`[kaz-mode] 注册状态工具失败：${safeMessage(error)}`);
        statusDisposer = null;
      }
    }

    function uninstallStatusTool() {
      if (statusDisposer === null) return;
      try {
        statusDisposer();
      } catch (error) {
        ctx.logger.warn(`[kaz-mode] 注销状态工具失败：${safeMessage(error)}`);
      }
      statusDisposer = null;
    }

    /** settings 变化后的统一处理：联动 + 状态工具同步 + 日志。 */
    function handleChange() {
      runLinkage();
      const current = source();
      if (current.registerStatusTool === true) {
        installStatusTool();
      } else {
        uninstallStatusTool();
      }
      ctx.logger.info(
        `[kaz-mode] 配置已生效：enabled=${current.enabled}, showFirstRoundHint=${current.showFirstRoundHint}, ` +
          `postFirstRoundMode=${current.postFirstRoundMode}`,
      );
    }

    // settings 注册放到所有变量/函数定义之后：ctx.inject 可能同步回调，
    // 其 onChange 会调用 handleChange()，必须保证闭包变量已初始化（避免 TDZ）。
    // 注意：setSource 收到的是一个 thunk（`() => scope.get()`），不是当前值。
    installSettingsWithDefaults(ctx, NAMESPACE, SETTINGS_SCHEMA, entry, DEFAULT_SECTION, {
      setSource: (getValue) => {
        source = () => normalizeConfig(getValue());
      },
      onChange: () => handleChange(),
    });

    // 自愈补充：agent-presets.default 缺失时自动设为 kaz（镜像作者 settings.yaml，
    // 朋友的机器一启动就默认进入 Kaz 预设）。该命名空间由宿主 agent-presets
    // 插件注册，启动竞态下可能晚于本插件——按退避重试（与预设同步一致）；
    // 用户已有 default 值时绝不覆盖。
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
    // 宿主重发的 agent-preset/selected）同步 kaz-mode.enabled——首轮之前切到
    // 其它模式就关闭 Kaz，避免 Kaz 工具面 / 首轮极简干扰原生极简等其它模式。
    ctx.on("agent-preset/selected", (_sessionId, agentPreset) => {
      if (typeof agentPreset !== "string") return;
      void syncEnabledForPreset(agentPreset);
    });

    // 启动时同步：若默认预设已是 kaz（例如重启前就选着），则开启联动。
    // agent-presets 命名空间可能晚于本插件注册（启动顺序），按退避重试，
    // 但**只同步一次**：第一次成功读到预设即标记完成，后续重试直接返回——
    // 避免启动重试把用户随后切换会话 / 手动改的 enabled 又覆盖回去。
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
          // “当前对话的插件状态” = c 区显示的有效状态（专属覆盖 > 当前模式默认）。
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
      ctx.logger.warn("[kaz-mode] connection 服务不可用，面板 RPC 通道未注册（仅设置页/状态工具可用）");
    }

    // 卸载时注销状态工具。
    ctx.effect(() => () => {
      uninstallStatusTool();
    });
  },
};
