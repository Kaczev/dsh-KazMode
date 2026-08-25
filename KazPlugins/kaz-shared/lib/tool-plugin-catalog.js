// kaz-shared —— 工具插件目录 / 原设置（官方 / Kaz 分类 + 出厂默认）
// ===========================================================================
// 这里就是“原设置”的修改点：
//   - TOOL_PLUGIN_CATALOG：包名 → [{ 工具名, enabled }]
//       enabled=true 表示该工具在白名单（小开关）；enabled=false 表示已知但默认关闭。
//       “已知但默认关闭”也必须写进来，避免检测时被误判成“新工具”而默认开启。
//   - DEFAULT_ENABLED_TOOL_PLUGINS：默认有“能力启用”的包名列表（大开关）。
//   - DEFAULT_UNABLED_TOOL_PLUGINS：已知但默认没有“能力启用”的包名列表。
//       只有既不在 TOOL_PLUGIN_CATALOG、也不在 DEFAULT_UNABLED_TOOL_PLUGINS
//       里的插件，才算是“真正的新插件”，检测到后默认开启。
//   - OFFICIAL_TOOL_PLUGIN_KEYS / KAZ_TOOL_PLUGIN_KEYS：仅用于 UI 面板分栏。
// 原设置下不忽略插件、不隐藏工具。
// 用户默认 / 项目专属的覆盖数据放在用户目录与项目目录的 JSON 里，
// 不写在这个源码文件里。
// ===========================================================================

/** 原设置：每个包的工具与白名单状态（出厂默认）。 */
export const TOOL_PLUGIN_CATALOG = {
  // ---- 默认开启的官方工具 ----
  "tool-pwsh": [
    { name: "pwsh", enabled: true },
  ],
  "tool-fs": [
    { name: "read", enabled: true },
    { name: "write", enabled: true },
    { name: "edit", enabled: true },
    { name: "read_image", enabled: false },
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

  // ---- 已知但默认关闭的官方插件（工具写 enabled:false；工具未知的留空数组）----
  "tool-bash": [
    { name: "run_code", enabled: false },
  ],
  "tool-bash-persistent": [],
  "tool-call-timeout-policy": [],
  "tool-cordis": [],
  "tool-goal": [],
  "tool-ralph": [
    { name: "ralph", enabled: false },
  ],
  "tool-skill": [],
  "tool-str-replace-editor": [
    { name: "str_replace_editor", enabled: false },
  ],
  "tool-subagent": [
    { name: "subagent", enabled: false },
    { name: "subagent_fork", enabled: false },
  ],
  "tool-subagent-control": [
    { name: "send_message", enabled: false },
    { name: "interrupt_agent", enabled: false },
  ],
  "tool-subagent-list-agents": [
    { name: "list_agents", enabled: false },
  ],
  "tool-subagent-report": [
    { name: "report", enabled: false },
  ],
  "tool-workflow": [
    { name: "workflow", enabled: false },
  ],
  "plan-mode": [
    { name: "exit_plan_mode", enabled: false },
  ],
  "plan-mode-controller": [],
  "planmodecontroller": [],
  "goal": [
    { name: "create_goal", enabled: false },
    { name: "get_goal", enabled: false },
    { name: "update_goal", enabled: false },
  ],
  "goal-round-driver": [],
  "command-goal": [],
  "session-title": [],
  "session-title-llm": [],
  "agent-default-model": [],
  "agent-instructions": [],
  "web": [],
  "web-search-deepseek": [],
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

/**
 * 已知但默认没有“能力启用”的包名列表。
 * 这些插件已经在 TOOL_PLUGIN_CATALOG 里登记，因此检测时不会被当作“新插件”自动开启。
 */
export const DEFAULT_UNABLED_TOOL_PLUGINS = Object.keys(TOOL_PLUGIN_CATALOG).filter(
  (key) => !DEFAULT_ENABLED_TOOL_PLUGINS.includes(key),
);

/** 未归属/未知包名使用的保留 key（UI 显示为“未知插件”）。 */
export const UNKNOWN_PLUGIN_KEY = "unknown";

/** DSH 官方插件（fiber.name 归一化后的 key）。 */
export const OFFICIAL_TOOL_PLUGIN_KEYS = [
  // 官方工具插件（tool- 风格）
  "tool-ask-user",
  "tool-bash",
  "tool-fs",
  "tool-fs-search",
  "tool-goal",
  "tool-jobs",
  "tool-pwsh",
  "tool-ralph",
  "tool-str-replace-editor",
  "tool-subagent",
  "tool-subagent-control",
  "tool-subagent-list-agents",
  "tool-subagent-report",
  "tool-todo",
  "tool-web",
  "tool-workflow",
  "plan-mode",
  "planmodecontroller",
  "goal",
];

/** Kaz 模式自家插件（用于 UI 面板分栏）。 */
export const KAZ_TOOL_PLUGIN_KEYS = [
  "kaz-memory",
];
