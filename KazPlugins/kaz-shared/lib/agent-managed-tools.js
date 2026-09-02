// kaz-shared —— Agent 管理的「自写工具」层（纯 ESM 模块，非 cordis 插件）
// ===========================================================================
// 第14次更新：自写工具（Agent 管理 · 全局）的单一事实源纯函数模块。
// 语义（已定，勿改）：
//   - 只有插件名满足 kaz-skill-* 约定，且 agent-managed registry 中显式标记
//     agentManaged === true 的条目才算“Agent 管理工具”；
//   - Agent 管理工具全局启用、跨项目生效，不受项目/用户 four-file JSON 或
//     other-* 删除影响；
//   - 它们不是模式自动启用工具；进入 Kaz 白名单后由 round-13 任务分类
//     optional_tools / enable_tool 决定是否进入当前任务工具面。
// 本文件只负责纯数据归一化 / 校验 / 表面合并；registry 文件的读写由
// kaz-mode 负责（文件放在全局 storages，不在项目 four-file 模型内）。
// ===========================================================================

/** kaz-skill-* 前缀：自写 skill/插件命名约定（识别规则条件一）。 */
export const AGENT_MANAGED_PLUGIN_PREFIX = "kaz-skill-";

/** 面板/RPC 的 agent 分类组 id（客户端在 external 之前识别）。 */
export const AGENT_MANAGED_CATALOG_GROUP_ID = "agent";

/** Agent 管理 registry 的全局存储文件名（放在 DSH_HOME/storages，跨项目共享）。 */
export const AGENT_MANAGED_STORAGE_FILE = "kaz-agent-managed-tools.json";

/** 与四文件模型同一套归一化：小写、非字母数字折叠为 “-”。 */
function normalizeAgentPluginKey(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** 清洗工具名：只保留非空字符串、trim、去重；兼容数组或 { tool: true }。 */
function cleanAgentToolNames(value) {
  const out = [];
  const push = (name) => {
    if (typeof name !== "string") return;
    const tool = name.trim();
    if (tool.length > 0 && !out.includes(tool)) out.push(tool);
  };
  if (Array.isArray(value)) {
    for (const item of value) push(item);
  } else if (value !== null && typeof value === "object") {
    for (const [name, enabled] of Object.entries(value)) {
      if (enabled === true) push(name);
    }
  }
  return out;
}

/**
 * 归一化 agent-managed registry。
 * 输入形状：{ version?: 1, plugins: { "<kaz-skill-*>": { agentManaged: true, tools: [...] } } }
 * 兼容直接传 plugins 字典（便于探针构造）。
 * 识别规则：kaz-skill-* 前缀 且 显式 agentManaged === true，两个条件缺一不可。
 * 文件缺失 / 损坏 / 无合法条目 → 返回空 registry（feature off，行为与旧版一致）。
 */
export function normalizeAgentManagedRegistry(raw) {
  const value =
    raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const container =
    value.plugins !== null &&
    typeof value.plugins === "object" &&
    !Array.isArray(value.plugins)
      ? value.plugins
      : value;
  const plugins = {};
  for (const [rawKey, entry] of Object.entries(container)) {
    const key = normalizeAgentPluginKey(rawKey);
    if (key.length === 0 || !key.startsWith(AGENT_MANAGED_PLUGIN_PREFIX)) continue;
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      entry.agentManaged !== true
    ) {
      continue;
    }
    plugins[key] = {
      agentManaged: true,
      tools: cleanAgentToolNames(entry.tools),
    };
  }
  return { version: 1, plugins };
}

/** 归一化后的 plugin key 列表（排序）。 */
export function agentManagedPluginKeys(registry) {
  return Object.keys(normalizeAgentManagedRegistry(registry).plugins).sort();
}

/** 全部 Agent 管理工具名（去重、排序）。 */
export function agentManagedToolNames(registry) {
  const plugins = normalizeAgentManagedRegistry(registry).plugins;
  const seen = [];
  for (const entry of Object.values(plugins)) {
    for (const tool of entry.tools) {
      if (!seen.includes(tool)) seen.push(tool);
    }
  }
  seen.sort();
  return seen;
}

/** 供 RPC / 面板使用的 agent catalog 条目：{ plugin, agentManaged: true, tools }。 */
export function agentManagedCatalogEntries(registry) {
  const plugins = normalizeAgentManagedRegistry(registry).plugins;
  return Object.entries(plugins).map(([plugin, entry]) => ({
    plugin,
    agentManaged: true,
    tools: [...entry.tools],
  }));
}

/** 判断某插件 key 是否已在 agent-managed registry 中（输入可以是任意写法）。 */
export function agentManagedRegistryHasPlugin(registry, pluginName) {
  const key = normalizeAgentPluginKey(pluginName);
  if (key.length === 0) return false;
  return agentManagedPluginKeys(registry).includes(key);
}

/**
 * 把 agent-managed 层并入“四文件模型计算出的 Kaz 白名单”。
 * 合并发生在任务过滤之前；registry 为空/损坏时原样返回，行为不变。
 * 返回新 Set，不改动入参。
 */
export function mergeAgentManagedToolsIntoSurface(surface, registry) {
  const result = new Set(
    surface instanceof Set
      ? [...surface]
      : Array.isArray(surface)
        ? surface
        : [],
  );
  for (const tool of agentManagedToolNames(registry)) result.add(tool);
  return result;
}
