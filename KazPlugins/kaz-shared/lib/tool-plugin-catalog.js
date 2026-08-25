// kaz-shared —— 工具插件目录 / 原设置（官方 / Kaz 分类 + 出厂默认）
// ===========================================================================
// 这里就是“原设置”的修改点：
//   - TOOL_PLUGIN_CATALOG：包名 → [{ 工具名, enabled }]
//       enabled=true 表示该工具在白名单（小开关）；没有启用就是关闭。
//   - DEFAULT_ENABLED_TOOL_PLUGINS：默认有“能力启用”的包名列表（大开关）；
//       不在列表里的插件，其工具出厂时全部没有能力启用。
//   - OFFICIAL_TOOL_PLUGIN_KEYS / KAZ_TOOL_PLUGIN_KEYS：仅用于 UI 面板分栏。
// 原设置下不忽略插件、不隐藏工具。
// 用户默认 / 项目专属的覆盖数据放在用户目录与项目目录的 JSON 里，
// 不写在这个源码文件里。
// ===========================================================================

/** 原设置：每个包的工具与白名单状态（出厂默认）。 */
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
};

/** 默认开启的包名列表（原设置）——即“插件是否有能力启用”的大开关。 */
export const DEFAULT_ENABLED_TOOL_PLUGINS = [
  "tool-pwsh",
  "tool-fs",
  "tool-fs-search",
  "tool-jobs",
  "tool-ask-user",
  "tool-todo",
  "tool-web",
  "kaz-memory",
];

/** DEFAULT_ENABLED_TOOL_PLUGINS 的语义别名：插件级“有能力启用”。 */
export const DEFAULT_CAPABLE_TOOL_PLUGINS = DEFAULT_ENABLED_TOOL_PLUGINS;

/** 未归属/未知包名使用的保留 key（UI 显示为“未知插件”）。 */
export const UNKNOWN_PLUGIN_KEY = "unknown";

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

/** Kaz 模式自家插件（用于 UI 面板分栏）。 */
export const KAZ_TOOL_PLUGIN_KEYS = [
  "kaz-memory",
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
