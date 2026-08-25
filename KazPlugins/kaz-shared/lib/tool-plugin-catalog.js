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
  "tool-pwsh": {
    "pwsh" : true
  },
  "tool-fs": {
    "read" : true,
    "write" : true,
    "edit" : true,
    "read_image" : false
  },
  "tool-fs-search": {
    "glob" : true,
    "grep" : true
  },
  "tool-jobs": {
    "job_list" : true,
    "job_output" : true,
    "job_kill" : true
  },
  "tool-ask-user": {
    "ask_user_question" : true
  },
  "tool-todo": {
    "todo_write" : true
  },
  "tool-web": {
    "web_search" : true
  },
  "kaz-memory": {
    "memory_save" : true,
    "memory_update" : true,
    "memory_list" : true,
    "memory_search" : true,
    "memory_detail" : true,
    "memory_forget" : true
  },
  "tool-bash": {
    "run_code" : false
  },
  "tool-ralph": {
    "ralph" : false
  },
  "tool-str-replace-editor": {
    "str_replace_editor" : false
  },
  "tool-subagent": {
    "subagent" : false,
    "subagent_fork" : false
  },
  "tool-subagent-control": {
    "send_message" : false,
    "interrupt_agent" : false
  },
  "tool-subagent-list-agents": {
    "list_agents" : false
  },
  "tool-subagent-report": {
    "report" : false
  },
  "tool-workflow": {
    "workflow" : false
  },
  "plan-mode": {
    "exit_plan_mode" : false
  },
  "goal": {
    "create_goal" : false,
    "get_goal" : false,
    "update_goal" : false
  }
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
