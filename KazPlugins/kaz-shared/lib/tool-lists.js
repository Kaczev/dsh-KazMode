// kaz-shared —— Kaz 模式工具清单的单一事实源（纯 ESM 模块，非 cordis 插件）
// ===========================================================================
// 职责（Kaz 模式的工具管理全部集中在这里）：
//   1) 全部工具清单默认值常量（单一出处，其它插件不再各自维护副本）；
//   2) 工具群组注册表：kaz-memory / kaz-diag 等插件在 apply 时"发信"声明
//      自己的工具组（registerGroup），在 enabled 变化时通知开关
//      （setGroupEnabled），插件卸载时注销（unregisterGroup）；
//   3) 工具面计算：computeSurface / effectiveToolWhitelist 供 kaz-mode 组装层
//      过滤与 kaz-diag 报告使用。
//
// 工具面语义（2026-08-21 统一）：
//   - Kaz 模式（kaz-mode.enabled=true）下：
//       首阶段（round-minimal 信号 minimalPhase=true）只保留 firstRoundTools
//       （为空回退 DEFAULT_FIRST_ROUND_TOOLS）——"首轮工具一定是
//       DEFAULT_FIRST_ROUND_TOOLS"，无交集演算；
//       全量阶段 = effectiveToolWhitelist（settings.toolWhitelist ∪ 已启用群组
//       − 已停用群组）。不再有 minimalTools 概念：首阶段极简完全由
//       round-minimal 定义，全量阶段由白名单定义。
//   - effectiveToolWhitelist = (settings.toolWhitelist ∪ 已启用群组的工具)
//       − 已停用群组的工具：已启用群组的工具总是加入（即使不在白名单里）；
//       已停用群组的工具总是排除（即使写进了白名单）。kaz-memory / kaz-diag
//       的工具是否出现在工具面完全由各自的 enabled 决定。
//   - 非 Kaz 模式：本模块不干预（工具面由标准模式决定；kaz-memory 等插件
//     关闭时已自行注销工具，开启时自行注册）。
//   - 用户 settings.yaml 的 toolWhitelist / firstRoundTools / disabledTools
//     始终优先：本模块只提供默认值与计算，不读写设置。
//
// 本模块零依赖、无副作用导入（注册表是显式 API 驱动的模块级状态，
// ESM 模块缓存保证所有导入方共享同一份注册表）。
// ===========================================================================

/** round-minimal 首阶段工具白名单默认值（首次工具调用前仅保留这些）。 */
export const DEFAULT_FIRST_ROUND_TOOLS = ["pwsh", "str_replace_editor"];

/** plugin-filter 默认禁用清单（插件/工具名，大小写不敏感匹配）。 */
export const DEFAULT_DISABLED_TOOLS = ["tool-cordis", "tool-subagent-report", "codex", "claude-code"];

/** Kaz 模式固定系统提示词（persona 唯一文本）。 */
export const FIXED_PERSONA = "You are a helpful software engineer assistant.";

/** 被管理插件目录（kaz-mode 面板 / kaz-diag 报告共用）。 */
export const MANAGED_PLUGINS = [
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

/**
 * Kaz 全部工具白名单默认值 = 标准模式全部工具（除 bash 与 skill）+ pwsh +
 * str_replace_editor。记忆工具与 kaz_mode_status 不属于基底白名单——它们由
 * kaz-memory / kaz-diag 以群组方式注册，随各自 enabled 加入/排除。
 * 用户 settings.yaml 的 kaz-mode.toolWhitelist 是手动编辑点，始终优先。
 */
export const DEFAULT_TOOL_WHITELIST = [
  "pwsh",
  "read", "write", "edit", "read_image", "glob", "grep",
  "job_list", "job_output", "job_kill",
  "create_goal", "get_goal", "update_goal",
  "subagent", "subagent_fork", "list_agents", "send_message", "interrupt_agent",
  "workflow", "ralph",
  "ask_user_question", "todo_write", "web_search",
  "str_replace_editor",
];

// ---------------------------------------------------------------------------
// 工具群组注册表（"发信"接口）：插件声明自己的工具并通知开关。
// ---------------------------------------------------------------------------

/** id -> { label, tools: string[], enabled: boolean }（模块级共享状态）。 */
const groups = new Map();

const cleanTools = (tools) =>
  Array.isArray(tools)
    ? [...new Set(tools.filter((tool) => typeof tool === "string" && tool.length > 0))]
    : [];

/**
 * 声明一组工具（插件 apply 时调用一次）。enabled 默认 false——声明后由
 * setGroupEnabled 按插件实际设置通知开关。重复注册同一 id 会更新声明。
 */
export function registerGroup(id, options = {}) {
  const key = String(id ?? "");
  if (key.length === 0) return undefined;
  const entry = {
    label: typeof options.label === "string" && options.label.length > 0 ? options.label : key,
    tools: cleanTools(options.tools),
    enabled: options.enabled === true,
  };
  groups.set(key, entry);
  return { ...entry, id: key };
}

/** 通知某组工具的开关状态（随插件 enabled 变化热调用）。 */
export function setGroupEnabled(id, enabled) {
  const key = String(id ?? "");
  const entry = groups.get(key);
  if (entry === undefined) return undefined;
  entry.enabled = enabled === true;
  return { ...entry, id: key };
}

/** 插件卸载时注销其工具组。 */
export function unregisterGroup(id) {
  return groups.delete(String(id ?? ""));
}

/** 某组是否已声明。 */
export function hasGroup(id) {
  return groups.has(String(id ?? ""));
}

/** 全部已声明群组（快照）。 */
export function listGroups() {
  return [...groups.entries()].map(([id, entry]) => ({ id, label: entry.label, enabled: entry.enabled, tools: [...entry.tools] }));
}

/** 已启用群组的工具合集（去重）。 */
export function enabledGroupTools() {
  const out = [];
  for (const entry of groups.values()) {
    if (entry.enabled) for (const tool of entry.tools) out.push(tool);
  }
  return [...new Set(out)];
}

/** 已停用群组的工具合集（去重；用于从白名单中强制排除）。 */
export function disabledGroupTools() {
  const out = [];
  for (const entry of groups.values()) {
    if (!entry.enabled) for (const tool of entry.tools) out.push(tool);
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// 工具面计算（kaz-mode 组装层 / kaz-diag 报告使用）。
// ---------------------------------------------------------------------------

/**
 * 有效白名单 = (settings.toolWhitelist ∪ 已启用群组的工具) − 已停用群组的工具。
 * 用户白名单中的条目被保留；群组工具不依赖白名单、也不被白名单"复活"。
 */
export function effectiveToolWhitelist(toolWhitelist = []) {
  const list = Array.isArray(toolWhitelist) ? toolWhitelist.filter((tool) => typeof tool === "string" && tool.length > 0) : [];
  const enabled = new Set(enabledGroupTools());
  const disabled = new Set(disabledGroupTools());
  const out = [];
  for (const tool of [...list, ...enabled]) {
    if (!disabled.has(tool)) out.push(tool);
  }
  return [...new Set(out)];
}

/**
 * 计算某代理此刻的 Kaz 工具面（Set）。
 *   minimalPhase=true（round-minimal 首阶段）：只保留 firstRoundTools（为空回退
 *   DEFAULT_FIRST_ROUND_TOOLS）；否则全量阶段 = effectiveToolWhitelist。
 * @param {object} inputs
 * @param {string[]} [inputs.toolWhitelist] settings 的 kaz-mode.toolWhitelist
 * @param {boolean} [inputs.minimalPhase] round-minimal 首阶段信号
 * @param {string[]} [inputs.firstRoundTools] round-minimal 的 firstRoundTools
 * @returns {Set<string>}
 */
export function computeSurface({ toolWhitelist = [], minimalPhase = false, firstRoundTools = [] } = {}) {
  const first = Array.isArray(firstRoundTools) ? firstRoundTools.filter((tool) => typeof tool === "string" && tool.length > 0) : [];
  if (minimalPhase) {
    return new Set(first.length > 0 ? first : DEFAULT_FIRST_ROUND_TOOLS);
  }
  return new Set(effectiveToolWhitelist(toolWhitelist));
}
