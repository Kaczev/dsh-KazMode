// kaz-shared —— kaz_tool_auto_on（模式工具自动启用）参数单一事实源
// ===========================================================================
// 职责：
//   - 定义 plan / goal 两个“模式自动启用”功能的【原设置（工厂默认）】：
//       1) plan 模式激活时临时放行哪些工具（默认 exit_plan_mode）；
//       2) goal 模式激活时临时放行哪些工具（默认 get_goal / update_goal）。
//   - 提供三层设置（原设置 → 用户默认 → 项目专属）的归一化 / 合并纯函数。
//
// 存储（一个 JSON 文件即可存完一层，文件读写由 kaz-mode 负责）：
//   - 默认设置：~/.dsh/storages/ka_tool_auto_on_setting.json
//   - 专属设置：<项目>/.dsh/storages/ka_tool_auto_on_setting.json
//   - 两层都是同一形状：
//       { "plan": { "enabled": true, "tools": ["exit_plan_mode"] },
//         "goal": { "enabled": true, "tools": ["get_goal", "update_goal"] } }
//   - 某层文件缺失 / 某字段缺失 = 继承下层；空数组 tools: [] 是合法覆盖。
//
// 运行时：
//   - 临时启用由 kaz-mode 按 agent 会话的模式激活状态实时计算：
//     模式激活 → 把生效清单临时加进该会话工具面；模式结束 → 自动移除。
//   - 这里只放参数 / 默认值 / 纯函数，不保存任何会话状态。
// ===========================================================================

/** 两个模式自动启用功能的原设置（改这里即可扩展/调整默认工具）。 */
export const TOOL_AUTO_ON_CONFIG = {
  plan: {
    id: "plan",
    label: "plan 模式",
    defaultEnabled: true,
    /** 这些插件属于“模式限定”：即使工具控制面板 JSON 启用了也不进基础工具面。 */
    pluginKeys: ["plan-mode"],
    tools: ["exit_plan_mode"],
    description: "进入 plan 模式时，临时放行这些工具；plan 模式结束自动移除。",
  },
  goal: {
    id: "goal",
    label: "goal 模式",
    defaultEnabled: true,
    pluginKeys: ["goal"],
    tools: ["get_goal", "update_goal"],
    description: "进入 goal 模式（存在 active/paused 目标）时，临时放行这些工具；goal 模式结束自动移除。",
  },
};

/** 模式限定工具插件 key（从各 feature 的 pluginKeys 去重派生）。 */
export const MODE_SCOPED_TOOL_PLUGIN_KEYS = [
  ...new Set(Object.values(TOOL_AUTO_ON_CONFIG).flatMap((feature) => feature.pluginKeys)),
];

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

/** 返回一份全新的原设置（工厂默认）完整状态（避免调用方修改污染默认值）。 */
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

/** 归一化任意来源的 auto-on 状态对象（缺失字段按关闭/空处理，旧版兼容）。 */
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

/**
 * 归一化一层 JSON 设置（用户默认 / 项目专属）。
 * 返回【局部层对象】：只有显式写过的字段才出现，缺失字段表示“继承下层”。
 * 注意：tools: [] 会被保留（开关开着但一个工具都不放行，是合法覆盖）。
 */
export function normalizeAutoOnLayer(raw) {
  const value = raw !== null && typeof raw === "object" ? raw : {};
  const out = {};
  for (const feature of ["plan", "goal"]) {
    const entry = value[feature] !== null && typeof value[feature] === "object" ? value[feature] : {};
    const normalized = {};
    if (typeof entry.enabled === "boolean") normalized.enabled = entry.enabled;
    if (Array.isArray(entry.tools)) normalized.tools = normalizeToolList(entry.tools);
    if (Object.keys(normalized).length > 0) out[feature] = normalized;
  }
  return out;
}

/**
 * 合并三层设置 → 完整生效状态。
 *   project（专属）> user（默认）> original（原设置/工厂）
 * 每个 feature 的 enabled / tools 逐项继承。
 */
export function mergeAutoOnLayers(original, user = {}, project = {}) {
  const result = {};
  for (const feature of ["plan", "goal"]) {
    const base = original?.[feature] ?? {};
    const u = user?.[feature] ?? {};
    const p = project?.[feature] ?? {};
    result[feature] = {
      enabled:
        typeof p.enabled === "boolean"
          ? p.enabled
          : typeof u.enabled === "boolean"
            ? u.enabled
            : base.enabled === true,
      tools: Array.isArray(p.tools)
        ? [...p.tools]
        : Array.isArray(u.tools)
          ? [...u.tools]
          : [...(Array.isArray(base.tools) ? base.tools : [])],
    };
  }
  return result;
}

/** 两个完整状态是否相等（JSON 深度比较）。 */
export function autoOnSettingsEqual(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** 某层 JSON 里指定 feature 是否写了覆盖字段。 */
export function hasAutoOnLayerFields(layer, feature) {
  const entry = layer?.[feature];
  return entry !== null && entry !== undefined && typeof entry === "object" && Object.keys(entry).length > 0;
}
