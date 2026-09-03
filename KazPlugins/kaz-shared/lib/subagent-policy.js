// kaz-shared —— Kaz 6.0 Step 2 子代理 toolFilter 白名单投影（纯 ESM）
// ===========================================================================
// 目标：
//   1) `@deepseek-ai/dsh-tool-subagent` 的 toolFilter 是“工具实例 / provider
//      request 层”的固定白名单，不是模型可随意填写的参数。
//   2) 本模块只产出**角色固定**的 toolFilter（allow/deny），并支持把角色白名单
//      进一步投影到“任务允许子集”，供外层编排层在创建/选择子代理工具实例时使用。
//   3) 主线全量工具面与子代理受限子集由这一层拉开：记忆写工具只属于维护角色。
//
// 本文件不依赖 cordis / dsh 服务，供 kaz-shared / ka-whale-workflow / 探针共用。
// ===========================================================================

/** 已知子代理角色 id（代码级维护；禁止模型自由扩写角色）。 */
export const SUBAGENT_ROLE_IDS = Object.freeze([
  "toolCreator",
  "memoryMaintainer",
  "retriever",
]);

/**
 * 角色 → 子代理工具实例命名（供外层创建 `@deepseek-ai/dsh-tool-subagent`
 * 独立实例使用：一个角色 = 一个 toolName = 一个固定 toolFilter）。
 */
export const SUBAGENT_ROLE_INSTANCES = Object.freeze({
  toolCreator: Object.freeze({
    toolName: "tool_creator_subagent",
    personaRef: "KAZ_ROLE_PROMPTS.subagent.toolCreator",
  }),
  memoryMaintainer: Object.freeze({
    toolName: "maintenance_subagent",
    personaRef: "KAZ_ROLE_PROMPTS.subagent.memoryMaintainer",
  }),
  retriever: Object.freeze({
    toolName: "retrieval_subagent",
    personaRef: "KAZ_ROLE_PROMPTS.subagent.retriever",
  }),
});

/**
 * 角色固定 toolFilter 白名单（静态配置层；不随模型输入变化）。
 *  - memoryMaintainer 是唯一携带 memory_save/update/forget 的角色；
 *  - retriever 只做检索/列表/详情，永不携带写工具；
 *  - toolCreator 负责工具/技能生命周期的写文件能力，但不碰记忆写工具。
 */
export const SUBAGENT_ROLE_TOOL_FILTERS = Object.freeze({
  toolCreator: Object.freeze({
    allow: Object.freeze([
      "read",
      "glob",
      "grep",
      "write",
      "edit",
      "pwsh",
      "safe_json_write",
      "todo_write",
    ]),
  }),
  memoryMaintainer: Object.freeze({
    allow: Object.freeze([
      "memory_save",
      "memory_update",
      "memory_forget",
      "memory_list",
      "memory_search",
      "memory_detail",
      "read",
      "glob",
      "grep",
      "write",
      "edit",
      "pwsh",
      "safe_json_write",
      "todo_write",
    ]),
  }),
  retriever: Object.freeze({
    allow: Object.freeze([
      "memory_list",
      "memory_search",
      "memory_detail",
    ]),
  }),
});

/** 只读工具名集合：读记忆工具（任务主线记忆开时允许的基础子集）。 */
export const SUBAGENT_ROLE_MEMORY_READ_TOOLS = Object.freeze([
  "memory_list",
  "memory_search",
  "memory_detail",
]);

/** 只允许维护子代理面出现的记忆写工具名（与 KAZ_MAINTENANCE_ONLY_TOOLS 同源口径）。 */
export const SUBAGENT_MAINTENANCE_MEMORY_WRITE_TOOLS = Object.freeze([
  "memory_save",
  "memory_update",
  "memory_forget",
]);

/** 归一化工具名列表：trim、去重、保留顺序、忽略空值。 */
export function normalizeToolNameList(value) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item !== "string") continue;
    const tool = item.trim();
    if (tool.length === 0 || seen.has(tool)) continue;
    seen.add(tool);
    out.push(tool);
  }
  return out;
}

/** 校验角色 id：合法返回原值；非法返回 null（不抛错，便于调用方 feature-off）。 */
export function normalizeSubagentRole(value) {
  if (typeof value !== "string") return null;
  const role = value.trim();
  return SUBAGENT_ROLE_IDS.includes(role) ? role : null;
}

/**
 * 返回某角色的固定 toolFilter（深拷贝）。
 * 未知角色抛错——这是配置层错误，不是模型可绕过的输入。
 */
export function toolFilterForRole(role) {
  const normalized = normalizeSubagentRole(role);
  if (normalized === null) {
    throw new Error(`subagent-policy: unknown role "${String(role)}"`);
  }
  const filter = SUBAGENT_ROLE_TOOL_FILTERS[normalized];
  return { allow: [...filter.allow] };
}

/**
 * 把角色固定白名单进一步投影到“任务允许子集”。
 * `taskAllowedTools` 为 null/undefined 时表示外层尚未给出任务子集，返回角色全量
 * 白名单（仅用于受控编排层创建实例，不作为模型可填写 toolFilter 的通道）。
 */
export function projectTaskWhitelist({ role, taskAllowedTools } = {}) {
  const roleAllow = toolFilterForRole(role).allow;
  if (taskAllowedTools === null || taskAllowedTools === undefined) {
    return { allow: [...roleAllow] };
  }
  const allowed = new Set(normalizeToolNameList(taskAllowedTools));
  return { allow: roleAllow.filter((tool) => allowed.has(tool)) };
}

/**
 * 断言投影后的子代理面是主线全量面的子集；返回 { ok, extra }。
 * extra 列出子代理允许但主线全量面没有的工具（正常应为空）。
 */
export function assertSubsetOf(mainSurface, subagentSurface) {
  const main = new Set(normalizeToolNameList(mainSurface));
  const sub = normalizeToolNameList(subagentSurface);
  const extra = sub.filter((tool) => !main.has(tool));
  return { ok: extra.length === 0, extra };
}
