// kaz-shared —— v0.9 B3 子代理四角色层（Minimal / Stable Base / toolFilter / personaRef）
// ===========================================================================
// 目标：
//   1) 本模块只产出 v0.9 固定四角色（worker / memoryMaintainer /
//      pluginMaintainer / pluginCreator）的 Minimal、Stable Base、toolFilter
//      与 personaRef，供 ka-whale-workflow 受控委派层使用。
//   2) assignedTools 来源校验只接受 tool-jobs + 可用私有插件候选，并遵守
//      >6 提醒、>8 拒绝；最终面 = role Stable Base + assignedTools。
//   3) B5 起旧 toolCreator / retriever 角色与旧 taskAllowedTools 投影层已退役。
//
// 本文件不依赖 cordis / dsh 服务，供 kaz-shared / ka-whale-workflow / 探针共用。
// ===========================================================================

import {
  PRIVATE_PLUGIN_CANDIDATE_VERSION,
  normalizeAgentManagedCandidateRegistry,
  availablePrivatePluginCandidateToolNames,
  privatePluginCandidateToolNames,
  normalizePrivatePluginCandidate,
  upsertPrivatePluginCandidate,
  removePrivatePluginCandidate,
} from "./agent-managed-tools.js";

/** v0.9 固定 assignedTools 工具（tool-jobs 官方集合；不建 JSON 候选）。 */
export const V09_TOOL_JOBS = Object.freeze(["job_list", "job_output", "job_kill"]);

/** v0.9 assignedTools 数量提醒/拒绝阈值。 */
export const V09_ASSIGNED_TOOLS_WARN_THRESHOLD = 6;
export const V09_ASSIGNED_TOOLS_MAX = 8;

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

// ---------------------------------------------------------------------------
// v0.9 B3：四角色固定层（Minimal / Stable Base / toolFilter / personaRef）
// ---------------------------------------------------------------------------

/** v0.9 子代理角色固定集合（R-B3-2）。 */
export const V09_SUBAGENT_ROLE_IDS = Object.freeze([
  "worker",
  "memoryMaintainer",
  "pluginMaintainer",
  "pluginCreator",
]);

/** v0.9 子代理 Minimal 工具（§1.7；首次工具调用前可见）。 */
export const V09_SUBAGENT_ROLE_MINIMAL_TOOLS = Object.freeze({
  worker: Object.freeze(["memory_search", "work_sub_whale_report"]),
  memoryMaintainer: Object.freeze(["memory_search", "memory_sub_whale_report"]),
  pluginMaintainer: Object.freeze(["read", "plugin_maintainer_sub_whale_report"]),
  pluginCreator: Object.freeze(["read", "plugin_creator_sub_whale_report"]),
});

/** v0.9 子代理 Stable Base（§1.2–1.5；含该角色的 report 工具）。 */
export const V09_SUBAGENT_ROLE_STABLE_BASE = Object.freeze({
  worker: Object.freeze([
    "edit",
    "glob",
    "grep",
    "memory_detail",
    "memory_list",
    "memory_search",
    "pwsh",
    "read",
    "todo_write",
    "web_search",
    "write",
    "work_sub_whale_report",
  ]),
  memoryMaintainer: Object.freeze([
    "memory_detail",
    "memory_search",
    "memory_list",
    "memory_save",
    "memory_update",
    "memory_forget",
    "read",
    "glob",
    "grep",
    "memory_sub_whale_report",
  ]),
  pluginMaintainer: Object.freeze([
    "read",
    "write",
    "edit",
    "glob",
    "grep",
    "pwsh",
    "todo_write",
    "plugin_maintainer_sub_whale_report",
  ]),
  pluginCreator: Object.freeze([
    "read",
    "write",
    "edit",
    "glob",
    "grep",
    "pwsh",
    "todo_write",
    "plugin_creator_sub_whale_report",
  ]),
});

/** v0.9 角色 → personaRef（R-B3-3）。 */
export const V09_SUBAGENT_ROLE_PERSONA_REFS = Object.freeze({
  worker: "v0.9:worker",
  memoryMaintainer: "v0.9:memoryMaintainer",
  pluginMaintainer: "v0.9:pluginMaintainer",
  pluginCreator: "v0.9:pluginCreator",
});

/** v0.9 角色固定 toolFilter（Stable Base 即 allow；最终面由 Base + assignedTools 合成）。 */
export const V09_SUBAGENT_ROLE_TOOL_FILTERS = Object.freeze({
  worker: Object.freeze({ allow: Object.freeze([...V09_SUBAGENT_ROLE_STABLE_BASE.worker]) }),
  memoryMaintainer: Object.freeze({
    allow: Object.freeze([...V09_SUBAGENT_ROLE_STABLE_BASE.memoryMaintainer]),
  }),
  pluginMaintainer: Object.freeze({
    allow: Object.freeze([...V09_SUBAGENT_ROLE_STABLE_BASE.pluginMaintainer]),
  }),
  pluginCreator: Object.freeze({
    allow: Object.freeze([...V09_SUBAGENT_ROLE_STABLE_BASE.pluginCreator]),
  }),
});

/** 校验 v0.9 role id；非法返回 null。 */
export function normalizeV09Role(value) {
  if (typeof value !== "string") return null;
  const role = value.trim();
  return V09_SUBAGENT_ROLE_IDS.includes(role) ? role : null;
}

/** 返回 v0.9 角色 Minimal 工具深拷贝；未知角色抛错（配置错误）。 */
export function v09MinimalToolsForRole(role) {
  const normalized = normalizeV09Role(role);
  if (normalized === null) {
    throw new Error(`subagent-policy: unknown v0.9 role "${String(role)}"`);
  }
  return [...V09_SUBAGENT_ROLE_MINIMAL_TOOLS[normalized]];
}

/** 返回 v0.9 角色 Stable Base 深拷贝；未知角色抛错。 */
export function v09StableBaseForRole(role) {
  const normalized = normalizeV09Role(role);
  if (normalized === null) {
    throw new Error(`subagent-policy: unknown v0.9 role "${String(role)}"`);
  }
  return [...V09_SUBAGENT_ROLE_STABLE_BASE[normalized]];
}

/** 返回 v0.9 角色固定 toolFilter 深拷贝。 */
export function v09ToolFilterForRole(role) {
  const normalized = normalizeV09Role(role);
  if (normalized === null) {
    throw new Error(`subagent-policy: unknown v0.9 role "${String(role)}"`);
  }
  return { allow: [...V09_SUBAGENT_ROLE_TOOL_FILTERS[normalized].allow] };
}

/** 计算 v0.9 最终角色面 = Stable Base + assignedTools（去重、保留顺序）。 */
export function computeV09FinalSurface({ role, assignedTools = [] } = {}) {
  const base = v09StableBaseForRole(role);
  const tools = normalizeToolNameList(assignedTools);
  const seen = new Set(base);
  const out = [...base];
  for (const tool of tools) {
    if (seen.has(tool)) continue;
    seen.add(tool);
    out.push(tool);
  }
  return out;
}

/**
 * v0.9 assignedTools 来源校验（R-B3-4/5）：
 * 来源只能是 tool-jobs + 私有插件候选（候选 registry 中 available=true 的工具）。
 * candidateRegistry 缺省时可按 candidateTools 显式传允许列表。
 * 返回 { ok, tools, warning, code?, reason? }。
 */
export function resolveV09AssignedTools({
  role,
  assignedTools = [],
  candidateRegistry = null,
  candidateTools = null,
} = {}) {
  const normalizedRole = normalizeV09Role(role);
  if (normalizedRole === null) {
    return {
      ok: false,
      code: "unknown-v09-role",
      reason: `assignedTools validation rejected unknown v0.9 role "${String(role)}".`,
    };
  }
  const tools = normalizeToolNameList(assignedTools);
  if (tools.length > V09_ASSIGNED_TOOLS_MAX) {
    return {
      ok: false,
      code: "assigned-tools-over-limit",
      reason: `assignedTools count ${tools.length} exceeds the maximum of ${V09_ASSIGNED_TOOLS_MAX}.`,
    };
  }
  const allowed =
    candidateTools !== null && candidateTools !== undefined
      ? normalizeToolNameList(candidateTools)
      : availablePrivatePluginCandidateToolNames(candidateRegistry);
  const allowedSet = new Set([...V09_TOOL_JOBS, ...allowed]);
  const invalid = tools.filter((tool) => !allowedSet.has(tool));
  if (invalid.length > 0) {
    return {
      ok: false,
      code: "assigned-tools-source-denied",
      reason: `assignedTools source validation rejected: ${invalid.join(", ")}. Only tool-jobs and available private-plugin candidates are allowed.`,
      invalid,
    };
  }
  const warning =
    tools.length > V09_ASSIGNED_TOOLS_WARN_THRESHOLD
      ? `assignedTools count is ${tools.length}; >${V09_ASSIGNED_TOOLS_WARN_THRESHOLD} is allowed but should be reviewed.`
      : "";
  return { ok: true, tools, warning };
}

/** 判断 assignedTools 是否为主模型 Stable Main Surface 子集（不含角色 report 工具）。 */
export function v09AssignedToolsSubsetOfMain(mainSurface, assignedTools) {
  const main = new Set(normalizeToolNameList(mainSurface));
  const tools = normalizeToolNameList(assignedTools);
  const extra = tools.filter((tool) => !main.has(tool));
  return { ok: extra.length === 0, extra };
}

/** R-B3-8：角色写工具限制。记忆写工具只能属于 memoryMaintainer；返回 { ok, denied }。 */
export function assertV09RoleWriteToolRestrictions(role, finalSurface) {
  const normalized = normalizeV09Role(role);
  if (normalized === null) return { ok: false, denied: ["unknown-role"] };
  const tools = new Set(normalizeToolNameList(finalSurface));
  const forbidden =
    normalized === "memoryMaintainer"
      ? []
      : [...SUBAGENT_MAINTENANCE_MEMORY_WRITE_TOOLS];
  const denied = forbidden.filter((tool) => tools.has(tool));
  return { ok: denied.length === 0, denied };
}

// Re-export candidate registry helpers for callers that prefer using the role layer.
export {
  PRIVATE_PLUGIN_CANDIDATE_VERSION,
  normalizeAgentManagedCandidateRegistry,
  availablePrivatePluginCandidateToolNames,
  privatePluginCandidateToolNames,
  normalizePrivatePluginCandidate,
  upsertPrivatePluginCandidate,
  removePrivatePluginCandidate,
};
