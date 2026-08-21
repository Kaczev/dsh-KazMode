// kaz-shared —— Kaz 模式工具清单的单一事实源（纯 ESM 模块，非 cordis 插件）
// ===========================================================================
// 职责：
//   1) TOOL_WHITELIST：Kaz 模式下允许出现的【全部】工具默认清单（含
//      kaz-memory 六工具与 kaz-diag 的 kaz_mode_status）。白名单是唯一闸门：
//      不在清单里的工具即使被注册也不会进入 Kaz 工具列表。
//   2) 工具面计算：computeSurface / effectiveToolWhitelist 供 kaz-mode 组装层
//      过滤与 kaz-diag 报告使用。
//
// 工具面语义（2026-08-21 统一）：
//   - Kaz 模式（kaz-mode.enabled=true）下：
//       effectiveToolWhitelist = 用户 settings.toolWhitelist（缺失时
//       TOOL_WHITELIST）原样去重——白名单是唯一闸门，不做任何群组加减；
//       全量阶段 = effectiveToolWhitelist；
//       首阶段（round-minimal 信号 minimalPhase=true）只保留 firstRoundTools
//       （为空回退 DEFAULT_FIRST_ROUND_TOOLS）——"首轮工具一定是
//       DEFAULT_FIRST_ROUND_TOOLS"，无交集演算、无 minimalTools 概念。
//   - kaz-memory / kaz-diag 的工具是否出现在工具面 ⇔ 插件 enabled 时注册到
//     harness（关闭时完全注销，由各插件自身负责）且名字在白名单里。
//   - 非 Kaz 模式：本模块不干预（工具面由标准模式决定；kaz-memory 等插件
//     关闭时已自行注销工具，开启时自行注册）。
//   - 用户 settings.yaml 的 toolWhitelist / firstRoundTools / disabledTools
//     始终优先：本模块只提供默认值与计算，不读写设置。
//
// 本模块零依赖、无副作用导入。
// ===========================================================================

/** round-minimal 首阶段工具白名单默认值（首次工具调用前仅保留这些）。
 *  2026-08-21（Kaczev 决定）：pwsh + read + edit——edit 受"先 read 后 edit"
 *  的文件观察策略约束，必须与 read 成对出现，首轮才能自洽地看/改文件。 */
export const DEFAULT_FIRST_ROUND_TOOLS = ["pwsh", "read", "edit"];

/** plugin-filter 默认禁用清单（插件/工具名，大小写不敏感匹配）。 */
export const DEFAULT_DISABLED_TOOLS = ["tool-cordis", "tool-subagent-report", "codex", "claude-code"];

/** kaz-memory 六个记忆工具名（会话级可见性由 kaz-mode 按 agent 会话计算）。 */
export const MEMORY_TOOLS = [
  "memory_save",
  "memory_update",
  "memory_list",
  "memory_search",
  "memory_detail",
  "memory_forget",
];

/** kaz-diag 的状态工具名（会话级可见性由 kaz-mode 按 agent 会话计算）。 */
export const DIAG_TOOL = "kaz_mode_status";

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
 * Kaz 模式下允许出现的【全部】工具默认清单：标准模式全部工具（除 bash 与
 * skill）+ pwsh + str_replace_editor + kaz-memory 六工具 + kaz-diag 的
 * kaz_mode_status。白名单是唯一闸门：不在清单里的工具即使被注册也不会进入
 * Kaz 工具列表。
 * 2026-08-21（Kaczev 决定）移除：read_image（模型不支持图片输入）、ralph（仅
 * 显式请求）、workflow（重型编排）、create_goal/get_goal/update_goal（长周期目标）、
 * str_replace_editor（与 edit/write/read 重叠，仅 insert 独有且日常少用）。
 * 子代理几乎不使用，去掉subagent, subagent_fork, list_agents, send_message, interrupt_agent,
 * 用户 settings.yaml 的 kaz-mode.toolWhitelist 是手动编辑点，始终优先；
 * Kaz 面板的「toolWhitelist」输入直接读写该设置（热重载生效）。
 */
export const TOOL_WHITELIST = [
  "pwsh", // windows PowerShell（跨平台）——首轮工具必选
  "read", "write", "edit", "glob", "grep", // 文件读写/编辑/搜索
  "job_list", "job_output", "job_kill", // 后台任务管理
  "ask_user_question", "todo_write", "web_search", // 交互/待办/搜索
  ...MEMORY_TOOLS, // kaz-memory 六工具
  DIAG_TOOL, // kaz-diag 的工具：Kaz 模式状态报告
];

/** 清理 + 去重工具名列表（保留顺序）。 */
function cleanTools(list) {
  const out = [];
  const seen = new Set();
  for (const tool of Array.isArray(list) ? list : []) {
    if (typeof tool !== "string" || tool.length === 0 || seen.has(tool)) continue;
    seen.add(tool);
    out.push(tool);
  }
  return out;
}

/**
 * 有效白名单 = 用户 settings.toolWhitelist（缺失/为空时用 TOOL_WHITELIST），
 * 原样去重。白名单是唯一闸门：不做群组加减——已注册但不在清单里的工具不会
 * 进入工具面；反过来，清单里的工具也要等插件注册后才真正出现在工具列表里。
 */
export function effectiveToolWhitelist(toolWhitelist = []) {
  const list = Array.isArray(toolWhitelist) && toolWhitelist.length > 0 ? toolWhitelist : TOOL_WHITELIST;
  return cleanTools(list);
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
  const first = cleanTools(firstRoundTools);
  if (minimalPhase) {
    return new Set(first.length > 0 ? first : DEFAULT_FIRST_ROUND_TOOLS);
  }
  return new Set(effectiveToolWhitelist(toolWhitelist));
}
