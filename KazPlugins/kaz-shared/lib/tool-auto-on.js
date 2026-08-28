// kaz-shared —— kaz_tool_auto_on（模式工具自动启用）参数单一事实源
// ===========================================================================
// 职责：
//   - 定义 plan / goal 两个“模式自动启用”功能的默认参数：
//       1) plan 模式激活时临时放行哪些工具（默认 exit_plan_mode）；
//       2) goal 模式激活时临时放行哪些工具（默认 get_goal / update_goal）。
//   - 提供默认状态与工具清单归一化纯函数。
// 注意：
//   - 这里只放“参数/默认值”，不保存任何会话状态；
//   - 临时启用状态由 kaz-mode 在内存中按会话维护，不写任何配置文件。
// ===========================================================================

/** 两个模式自动启用功能的参数（改这里即可扩展/调整默认工具）。 */
export const TOOL_AUTO_ON_CONFIG = {
  plan: {
    id: "plan",
    label: "plan 模式",
    defaultEnabled: true,
    tools: ["exit_plan_mode"],
    description: "进入 plan 模式时，临时放行这些工具；plan 模式结束自动移除。",
  },
  goal: {
    id: "goal",
    label: "goal 模式",
    defaultEnabled: true,
    tools: ["get_goal", "update_goal"],
    description: "进入 goal 模式（存在 active/paused 目标）时，临时放行这些工具；goal 模式结束自动移除。",
  },
};

/** plan 模式默认临时放行清单。 */
export const PLAN_AUTO_ON_TOOLS = [...TOOL_AUTO_ON_CONFIG.plan.tools];

/** goal 模式默认临时放行清单。 */
export const GOAL_AUTO_ON_TOOLS = [...TOOL_AUTO_ON_CONFIG.goal.tools];

/** plan 模式功能默认开关。 */
export const PLAN_AUTO_ON_DEFAULT_ENABLED = TOOL_AUTO_ON_CONFIG.plan.defaultEnabled;

/** goal 模式功能默认开关。 */
export const GOAL_AUTO_ON_DEFAULT_ENABLED = TOOL_AUTO_ON_CONFIG.goal.defaultEnabled;

/** 清洗工具清单：只保留非空字符串、trim、去重。 */
export function normalizeToolList(value) {
  const out = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item !== "string") continue;
    const tool = item.trim();
    if (tool.length > 0 && !out.includes(tool)) out.push(tool);
  }
  return out;
}

/** 返回一份全新的默认会话状态（避免调用方修改污染默认值）。 */
export function defaultToolAutoOnState() {
  return {
    plan: {
      enabled: TOOL_AUTO_ON_CONFIG.plan.defaultEnabled,
      tools: [...TOOL_AUTO_ON_CONFIG.plan.tools],
    },
    goal: {
      enabled: TOOL_AUTO_ON_CONFIG.goal.defaultEnabled,
      tools: [...TOOL_AUTO_ON_CONFIG.goal.tools],
    },
  };
}

/** 归一化任意来源的 auto-on 状态对象。 */
export function normalizeToolAutoOnState(raw) {
  const value = raw !== null && typeof raw === "object" ? raw : {};
  const plan = value.plan !== null && typeof value.plan === "object" ? value.plan : {};
  const goal = value.goal !== null && typeof value.goal === "object" ? value.goal : {};
  return {
    plan: {
      enabled: plan.enabled === true,
      tools: normalizeToolList(plan.tools),
    },
    goal: {
      enabled: goal.enabled === true,
      tools: normalizeToolList(goal.tools),
    },
  };
}
