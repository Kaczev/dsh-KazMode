// kaz-shared —— 工具插件目录（官方 / Kaz 的分类修改点）
// ===========================================================================
// 这里只做“分类”，不包含任何逻辑：
//   - OFFICIAL_TOOL_PLUGIN_KEYS：DSH 官方插件（tool-* 只是多数风格，不以此为准）
//   - KAZ_TOOL_PLUGIN_KEYS：Kaz 模式自家插件
// 不在以上两个列表里的检测插件，一律按「外置」处理。
// 外置插件的数据（检测结果 / 用户移除 / 手动添加）保存在用户目录 storages，
// 不写在这个源码文件里。
// 新增/修改官方/Kaz 分类时只需改这个文件；kaz-mode 服务端会把目录通过 RPC 发给面板。
// ===========================================================================

/** DSH 官方插件（fiber.name 归一化后的 key）。 */
export const OFFICIAL_TOOL_PLUGIN_KEYS = [
  // 官方工具插件（tool- 风格）
  "tool-ask-user",
  "tool-bash",
  "tool-bash-persistent",
  "tool-call-timeout-policy",
  "tool-cordis",
  "tool-fs",
  "tool-fs-search",
  "tool-goal",
  "tool-jobs",
  "tool-pwsh",
  "tool-ralph",
  "tool-skill",
  "tool-str-replace-editor",
  "tool-subagent",
  "tool-subagent-control",
  "tool-subagent-list-agents",
  "tool-subagent-report",
  "tool-todo",
  "tool-web",
  "tool-workflow",
  // 非 tool- 风格的官方插件
  "plan-mode",
  "plan-mode-controller",
  "planmodecontroller",
  "goal",
  "goal-round-driver",
  "command-goal",
  "session-title",
  "session-title-llm",
  "agent-default-model",
  "agent-instructions",
  "web",
  "web-search-deepseek",
];

/** Kaz 模式自家插件。 */
export const KAZ_TOOL_PLUGIN_KEYS = [
  "kaz-memory",
  "kaz-diag",
];

/** 官方工具名（含不在 TOOL_PLUGIN_FACTORY 默认清单里的官方工具），用于 registeredTools 扫描时排除。 */
export const OFFICIAL_TOOL_NAMES = [
  "read_image",
  "str_replace_editor",
  "subagent",
  "subagent_fork",
  "send_message",
  "interrupt_agent",
  "list_agents",
  "report",
  "workflow",
  "ralph",
  "exit_plan_mode",
  "create_goal",
  "get_goal",
  "update_goal",
  "run_code",
];
