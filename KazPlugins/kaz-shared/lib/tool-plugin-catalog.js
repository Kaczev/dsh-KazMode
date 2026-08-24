// kaz-shared —— 工具插件目录 / 原设置（官方 / Kaz 分类 + 出厂默认）
// ===========================================================================
// 这里就是“原设置”的修改点：
//   - TOOL_PLUGIN_CATALOG：包名 → [{ 工具名, 开启状态 }, ...]
//   - DEFAULT_ENABLED_TOOL_PLUGINS：默认开启的包名列表
//   - OFFICIAL_TOOL_PLUGIN_KEYS / KAZ_TOOL_PLUGIN_KEYS：官方 / Kaz 分类
// 外置插件数据（检测结果 / 用户移除 / 手动添加）保存在用户目录 storages，
// 不写在这个源码文件里。
// ===========================================================================

/** 原设置：每个包的工具与开启状态（出厂默认）。 */
export const TOOL_PLUGIN_CATALOG = {
  "tool-pwsh": [
    { name: "pwsh", enabled: true },
  ],
  "tool-fs": [
    { name: "read", enabled: true },
    { name: "write", enabled: true },
    { name: "edit", enabled: true },
  ],
  "tool-fs-search": [
    { name: "glob", enabled: true },
    { name: "grep", enabled: true },
  ],
  "tool-jobs": [
    { name: "job_list", enabled: true },
    { name: "job_output", enabled: true },
    { name: "job_kill", enabled: true },
  ],
  "tool-ask-user": [
    { name: "ask_user_question", enabled: true },
  ],
  "tool-todo": [
    { name: "todo_write", enabled: true },
  ],
  "tool-web": [
    { name: "web_search", enabled: true },
  ],
  "kaz-memory": [
    { name: "memory_save", enabled: true },
    { name: "memory_update", enabled: true },
    { name: "memory_list", enabled: true },
    { name: "memory_search", enabled: true },
    { name: "memory_detail", enabled: true },
    { name: "memory_forget", enabled: true },
  ],
  "kaz-diag": [
    { name: "kaz_mode_status", enabled: true },
  ],
};

/** 默认开启的包名列表（原设置）。 */
export const DEFAULT_ENABLED_TOOL_PLUGINS = [
  "tool-pwsh",
  "tool-fs",
  "tool-fs-search",
  "tool-jobs",
  "tool-ask-user",
  "tool-todo",
  "tool-web",
  "kaz-memory",
  "kaz-diag",
];

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

/** 官方工具名（含不在 TOOL_PLUGIN_CATALOG 默认清单里的官方工具），用于 registeredTools 扫描时排除。 */
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
