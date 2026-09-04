// kaz-shared —— Kaz 模式工具清单的单一事实源（纯 ESM 模块，非 cordis 插件）
// ===========================================================================
// 职责：
//   1) 首轮工具规则、记忆工具、被管理插件目录等常量；
//   2) 工具插件“四文件模型”的归一化 / 合并 / 工具面计算：
//        - enable 类：纯对象，例如 { "tool-fs": true, "dsh-pixel-art": true }
//        - catalog 类：纯对象，例如 { "tool-fs": { "read": true, "write": false } }
//   3) computeSurface / effectiveToolWhitelist 供 kaz-mode 组装层使用。
//
// 层次：
//   原设置   = 代码 TOOL_PLUGIN_CATALOG / TOOL_PLUGINS + 用户 other-*.json
//   默认设置 = 用户 tool-plugin.json / tool-plugin-catalog.json + 用户 other-*.json
//   专属设置 = 项目 tool-plugin.json / tool-plugin-catalog.json + 项目 other-*.json
//   （外置插件/工具的专属开关写项目 other-*，官方/Kaz 写项目 tool-plugin 文件）
// 工具面只放行：
//   - 插件在“启用插件并集”里；
//   - 工具在 T0 全集里；
//   - 工具在生效 catalog 里为 true。
// ===========================================================================

import {
  TOOL_PLUGIN_CATALOG,
  TOOL_PLUGINS,
  OFFICIAL_TOOL_PLUGIN_KEYS,
  KAZ_TOOL_PLUGIN_KEYS,
} from "./tool-plugin-catalog.js";

/** 首轮工具面常量（Kaz 5.0 设计）：所有插件状态下 ≤2。
 *  - "ka-whale-memory" / legacy "kaz-memory" 开 → memory_search（1 个）；
 *  - 其余（记忆关 / 未知）→ read + pwsh（2 个）。
 */
export const KAZ_FIRST_ROUND_TOOLS = Object.freeze({
  "ka-whale-memory": Object.freeze(["memory_search"]),
  "kaz-memory": Object.freeze(["memory_search"]),
  default: Object.freeze(["read", "pwsh"]),
});

/** kaz-memory/ka-whale-memory 开启时的首轮工具白名单：第一轮先查记忆，触发首次工具调用后再恢复。 */
export const DEFAULT_FIRST_ROUND_TOOLS_MEMORY_ON = ["memory_search"];

/** kaz-memory/ka-whale-memory 关闭时的首轮工具白名单：read + pwsh（≤2，2026-09 收编 round-minimal）。 */
export const DEFAULT_FIRST_ROUND_TOOLS_MEMORY_OFF = ["read", "pwsh"];

/** 兜底默认（kaz-memory 状态未知时）：read + pwsh（≤2）。 */
export const DEFAULT_FIRST_ROUND_TOOLS = DEFAULT_FIRST_ROUND_TOOLS_MEMORY_OFF;

/** ka-whale-workflow 任务重构阶段的默认工具清单（配置面板黑底白字框展示/编辑）。 */
export const DEFAULT_RECONSTRUCTION_TOOLS = [
  "ask_user_question",
  "read",
  "glob",
  "grep",
  "web_search",
  "memory_search",
  "memory_list",
  "memory_detail",
];

const FIRST_ROUND_TOOL_RULES = [
  {
    id: "ka-whale-memory",
    test: (kaWhaleMemoryEnabled) => kaWhaleMemoryEnabled === true,
    tools: KAZ_FIRST_ROUND_TOOLS["ka-whale-memory"],
  },
  {
    id: "kaz-memory",
    test: (_kaWhaleMemoryEnabled, kazMemoryEnabled) => kazMemoryEnabled === true,
    tools: KAZ_FIRST_ROUND_TOOLS["kaz-memory"],
  },
  {
    id: "default",
    test: () => true,
    tools: KAZ_FIRST_ROUND_TOOLS.default,
  },
];

/** 按 ka-whale-memory/kaz-memory 启用状态解析首轮工具白名单。 */
export function resolveFirstRoundTools({ kazMemoryEnabled, kaWhaleMemoryEnabled } = {}) {
  for (const rule of FIRST_ROUND_TOOL_RULES) {
    try {
      if (rule.test(kaWhaleMemoryEnabled, kazMemoryEnabled)) return [...rule.tools];
    } catch {
      // 跳过异常规则
    }
  }
  return [...DEFAULT_FIRST_ROUND_TOOLS];
}

/** plugin-filter 默认禁用清单。 */
export const DEFAULT_DISABLED_TOOLS = ["tool-cordis", "tool-subagent-report", "codex", "claude-code"];

/** kaz-memory 六个记忆工具名。 */
export const MEMORY_TOOLS = [
  "memory_save",
  "memory_update",
  "memory_list",
  "memory_search",
  "memory_detail",
  "memory_forget",
];

/** 主线任务面（记忆开时）允许进入基础面的记忆**读**工具。
 *  记忆写工具只进维护子代理白名单（KAZ_MAINTENANCE_ONLY_TOOLS），主线不持有。 */
export const MEMORY_READ_TOOLS = Object.freeze([
  "memory_list",
  "memory_search",
  "memory_detail",
]);

/** 携带工具的 Kaz 被管理组件：组件在 Kaz 面板关闭时，这些工具不应出现在工具面。
 *  v0.8 Step B1：create-plan/原生 Plan 已从 Kaz 移除，不再列入。 */
export const MANAGED_CARRIER_TOOLS = {
  "ka-whale-workflow": ["whale_report"],
};

/** Kaz 5.0 组件命名：ka-whale-memory 为新 id；kaz-memory 仅作旧键兼容读。 */
export const KAZ_MEMORY_COMPONENT_ID = "ka-whale-memory";
export const KAZ_MEMORY_LEGACY_COMPONENT_ID = "kaz-memory";

/** Kaz 5.0 固定核心工具全集（代码级维护，冻结；用户 JSON 不扩写它）。
 *  外置工具只进 KAZ_EXTERNAL_CANDIDATES 候选层，不写进本全集。 */
const _toolUniverse = {};
for (const [plugin, tools] of Object.entries(TOOL_PLUGIN_CATALOG)) {
  _toolUniverse[plugin] = Object.freeze(
    Object.fromEntries(Object.keys(tools).map((tool) => [tool, true])),
  );
}
for (const [plugin, tools] of Object.entries(MANAGED_CARRIER_TOOLS)) {
  _toolUniverse[plugin] = Object.freeze(
    Object.fromEntries(tools.map((tool) => [tool, true])),
  );
}
export const KAZ_TOOL_UNIVERSE = Object.freeze(_toolUniverse);

/** Kaz 5.0 基础工具面初稿（v0.4 K2 冻结的 12 项；允许 >8，Step 4 复审）。
 *  注意：任务工具选择的运行时 BASE_TOOLS 在 Step 4 前保留 enable_tool 兼容层；
 *  本常量是设计基准面，作为 schema-token 指标复审的对照。 */
export const KAZ_BASE_TOOLS = Object.freeze([
  "ask_user_question",
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
]);

/** 外置工具候选注册表层（面板添加只写这里；probe/验证通过后才可被任务契约选中）。 */
export const KAZ_EXTERNAL_CANDIDATES = Object.freeze({
  version: 1,
  candidates: Object.freeze({}),
  storageHint: "user other-*.json / project other-*.json（面板添加通道）",
});

/** v0.8 Step A：Goal 三件套 = create_goal / get_goal / update_goal，常驻 Stable Main Surface。 */
export const KAZ_GOAL_TOOLS = Object.freeze([
  "create_goal",
  "get_goal",
  "update_goal",
]);

/** v0.8 Step A：Stable Main Surface 的子代理控制工具。
 *  20/21 裁决：先用现有 DSH `subagent` 入主面，不新造 delegate_subagent；
 *  send_message / list_agents 暂不默认加入（后续有 continuable/后台需求再加）。 */
export const KAZ_SUBAGENT_CONTROL_TOOLS = Object.freeze(["subagent"]);

/** v0.8 Step A：Stable Main Surface = KAZ_BASE_TOOLS(12) + Goal 三件套 +
 *  whale_report + subagent（20/21 裁决后的固定集）。 */
export const KAZ_STABLE_MAIN_TOOLS = Object.freeze([
  ...new Set([
    ...KAZ_BASE_TOOLS,
    ...KAZ_GOAL_TOOLS,
    "whale_report",
    ...KAZ_SUBAGENT_CONTROL_TOOLS,
  ]),
]);

/** v0.8 Step A：保守子代理 Stable Base（不含 safe_json_write、不含记忆写工具；
 *  自创建工具由后续受控委派 Step 作为“主模型指定工具”加入）。 */
export const KAZ_SUBAGENT_BASE_TOOLS = Object.freeze([
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "pwsh",
  "todo_write",
  "memory_list",
  "memory_search",
  "memory_detail",
  "web_search",
]);

/** 计算主模型 stable surface（Set）。v0.8 Step B1：原生 Plan 已移除，
 *  固定集 = KAZ_STABLE_MAIN_TOOLS，不再接受 Plan 自动放行参数。 */
export function stableMainSurface() {
  return new Set(KAZ_STABLE_MAIN_TOOLS);
}

/** 计算子代理 stable surface（Set）：Stable Subagent Base + 主模型指定工作工具。
 *  Step A 尚无 delegate_subagent 参数通道，assignedTools 默认空；后续受控委派 Step 接入。 */
export function stableSubagentSurface({ baseTools = KAZ_SUBAGENT_BASE_TOOLS, assignedTools = [] } = {}) {
  const tools = new Set(Array.isArray(baseTools) ? baseTools : KAZ_SUBAGENT_BASE_TOOLS);
  for (const tool of Array.isArray(assignedTools) ? assignedTools : []) {
    if (typeof tool === "string" && tool.trim().length > 0) tools.add(tool.trim());
  }
  return tools;
}

/** Kaz 5.0 角色特化段（初稿）：只按角色/任务类型固定，禁止按任务实例动态生成。 */
export const KAZ_ROLE_PROMPTS = Object.freeze({
  main: Object.freeze(
    "We are the main-line driver of the confirmed task contract. Keep gray reasoning concise; use memory read tools at task start when relevant; stay in Step scope.",
  ),
  subagent: Object.freeze({
    toolCreator: Object.freeze("We are a tool creator subagent. Create tools only within the delegated whitelist and report evidence."),
    memoryMaintainer: Object.freeze("We are the memory maintenance subagent. Write concise memories with evidence; deletion requires main-model approval."),
    retriever: Object.freeze("We are the retrieval subagent. Return id+summary, keep budgets, avoid dumping full contents."),
  }),
});

/** 只进维护子代理面的记忆写工具（主线基础面/可选池都不放行）。 */
export const KAZ_MAINTENANCE_ONLY_TOOLS = Object.freeze([
  "memory_save",
  "memory_update",
  "memory_forget",
]);

/** Kaz 模式默认系统提示词。 */
export const FIXED_PERSONA = "You are a helpful software engineer assistant.";

/** 被管理插件目录（Kaz 5.0：两个旧首轮提示组件已删除；面板只显示 4 个组件，
 *  但内部状态模型仍保留 ka-whale-workflow / ka-whale-memory / create-plan / round-minimal /
 *  plugin-filter 等隐藏组件，供状态联动与回滚）。 */
export const MANAGED_PLUGINS = [
  { id: "round-minimal", label: "round-minimal（首阶段极简 · 已收编进核心机制，面板隐藏）" },
  { id: "plugin-filter", label: "plugin-filter（工具过滤 · 已收编进 kaz-shared/preset，面板隐藏）" },
  { id: "output-beep", label: "output-beep（输出完成提示音）" },
  { id: "round-display", label: "round-display（每轮注入显示）" },
  { id: "deepseek-default-model", label: "deepseek-default-model（DeepSeek 采样参数）" },
  { id: "ka-whale-memory", label: "ka-whale-memory（独立记忆组件，原 kaz-memory 改名）" },
  { id: "ka-whale-workflow", label: "ka-whale-workflow（鲸鱼工作流：任务重构→任务分类）" },
  { id: "create-plan", label: "create-plan（create_plan 工具：鲸鱼自己启用 plan 模式）" },
];

/** 由 TOOL_PLUGIN_CATALOG + TOOL_PLUGINS 派生的旧版兼容白名单。 */
export const TOOL_WHITELIST = Object.entries(TOOL_PLUGIN_CATALOG)
  .filter(([key]) => TOOL_PLUGINS[key] === true)
  .flatMap(([, tools]) =>
    Object.entries(tools)
      .filter(([, enabled]) => enabled === true)
      .map(([name]) => name),
  );

/** 清理 + 去重工具名列表。 */
function cleanTools(list) {
  const out = [];
  const seen = new Set();
  for (const tool of Array.isArray(list) ? list : []) {
    if (typeof tool !== "string" || tool.length === 0 || seen.has(tool)) continue;
    seen.add(tool);
    out.push(tool);
  }
  return out;
}

/** 有效白名单（旧版兼容）。 */
export function effectiveToolWhitelist(toolWhitelist = []) {
  const list = Array.isArray(toolWhitelist) && toolWhitelist.length > 0 ? toolWhitelist : TOOL_WHITELIST;
  return cleanTools(list);
}

/** 计算某代理此刻的 Kaz 工具面（Set）。 */
export function computeSurface({ toolWhitelist = [], minimalPhase = false, firstRoundTools = [], kazMemoryEnabled } = {}) {
  const first = cleanTools(firstRoundTools);
  if (minimalPhase) {
    return new Set(first.length > 0 ? first : resolveFirstRoundTools({ kazMemoryEnabled }));
  }
  return new Set(effectiveToolWhitelist(toolWhitelist));
}

// ---------------------------------------------------------------------------
// 四文件模型
// ---------------------------------------------------------------------------

/** 归一化插件/工具名（匹配用）：小写，非字母数字连续串折叠为单个 “-”。
 *  kaz-memory → ka-whale-memory（改名矩阵的旧键兼容读：所有用户/项目 JSON
 *  里的旧键经此归一化到新组件 id）。 */
export function normalizeExternalKey(value) {
  const key = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return key === KAZ_MEMORY_LEGACY_COMPONENT_ID ? KAZ_MEMORY_COMPONENT_ID : key;
}

/** 清洗“插件启用”字典（纯对象）→ { plugin: bool }；兼容旧数组（视为全部 true）。 */
export function normalizePluginEnableDict(raw) {
  const out = {};
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== "string") continue;
      const key = normalizeExternalKey(item);
      if (key.length === 0) continue;
      out[key] = true;
    }
    return out;
  }
  const value = raw !== null && typeof raw === "object" ? raw : {};
  for (const [rawKey, enabled] of Object.entries(value)) {
    const key = normalizeExternalKey(rawKey);
    if (key.length === 0) continue;
    out[key] = enabled === true;
  }
  return out;
}

/** 清洗 catalog 类 JSON（纯对象）→ { plugin: { tool: bool } }。 */
export function normalizeToolCatalog(raw) {
  const value = raw !== null && typeof raw === "object" ? raw : {};
  const out = {};
  for (const [rawKey, tools] of Object.entries(value)) {
    const key = normalizeExternalKey(rawKey);
    if (key.length === 0) continue;
    const toolMap = {};
    if (tools !== null && typeof tools === "object") {
      for (const [toolName, enabled] of Object.entries(tools)) {
        if (typeof toolName !== "string" || toolName.length === 0) continue;
        toolMap[toolName] = enabled === true;
      }
    }
    out[key] = toolMap;
  }
  return out;
}

/** 合并多个“插件启用”字典（后层覆盖前层）。 */
export function mergePluginEnableDicts(...dicts) {
  const out = {};
  for (const dict of dicts) {
    const normalized = normalizePluginEnableDict(dict);
    for (const [key, enabled] of Object.entries(normalized)) {
      out[key] = enabled;
    }
  }
  return out;
}

/** 合并多个 catalog 对象（后层覆盖前层；同插件同工具后者胜出）。 */
export function mergeToolCatalogs(...catalogs) {
  const out = {};
  for (const catalog of catalogs) {
    const normalized = normalizeToolCatalog(catalog);
    for (const [key, tools] of Object.entries(normalized)) {
      out[key] = { ...(out[key] ?? {}), ...tools };
    }
  }
  return out;
}

/**
 * 构造 T0 全集：代码 TOOL_PLUGIN_CATALOG 与各层 other-tool-plugin-catalog 的所有键，
 * 全部视为 true（T0 只决定“是否允许出现”，不决定最终开关）。
 */
export function buildToolUniverse(...catalogs) {
  const merged = mergeToolCatalogs(...catalogs);
  const universe = {};
  for (const [key, tools] of Object.entries(merged)) {
    universe[key] = Object.fromEntries(Object.keys(tools).map((tool) => [tool, true]));
  }
  return universe;
}

/**
 * 计算生效工具状态。
 * 输入都是已归一化/原始均可（内部会再归一化）。
 */
export function computeEffectiveToolState({
  codeCatalog = TOOL_PLUGIN_CATALOG,
  codeEnabled = TOOL_PLUGINS,
  userEnable = {},
  userOtherEnable = {},
  userCatalog = {},
  userOtherCatalog = {},
  projectEnable = {},
  projectOtherEnable = {},
  projectCatalog = {},
  projectOtherCatalog = {},
} = {}) {
  const P0 = mergePluginEnableDicts(codeEnabled, userOtherEnable);
  const T0 = buildToolUniverse(codeCatalog, userOtherCatalog, projectOtherCatalog);
  // 默认以“代码原设置 + 用户 other-*”为基底，再叠加用户默认文件。
  const P1 = mergePluginEnableDicts(P0, userEnable);
  const T1 = mergeToolCatalogs(codeCatalog, userOtherCatalog, userCatalog);
  // 专属在“默认”之上叠加项目 other-* 与项目 tool-plugin 文件；项目 other 可存外置插件/工具的专属开关。
  const P2 = mergePluginEnableDicts(P1, projectOtherEnable, projectEnable);
  const T2 = mergeToolCatalogs(T1, projectOtherCatalog, projectCatalog);
  const P = P2;
  const T = T2;
  return { P0, T0, P1, T1, P2, T2, P, T };
}

/** 由生效状态展开成工具名集合。 */
export function computeToolPluginSurfaceFromEffective(effective) {
  const { P, T, T0 } = effective;
  const out = new Set();
  for (const [plugin, tools] of Object.entries(T0)) {
    if (P[plugin] !== true) continue;
    const t1 = T[plugin] ?? {};
    for (const tool of Object.keys(tools)) {
      if (t1[tool] === true) out.add(tool);
    }
  }
  return out;
}

/** 一步到位：传入四文件模型各层，返回工具名集合。 */
export function computeToolPluginSurface(inputs = {}) {
  return computeToolPluginSurfaceFromEffective(computeEffectiveToolState(inputs));
}

/** 官方 / Kaz 分类目录（源码修改点，见 tool-plugin-catalog.js）。 */
export { OFFICIAL_TOOL_PLUGIN_KEYS, KAZ_TOOL_PLUGIN_KEYS, TOOL_PLUGIN_CATALOG, TOOL_PLUGINS } from "./tool-plugin-catalog.js";

/** kaz_tool_auto_on（模式工具自动启用）参数单一事实源（见 tool-auto-on.js）。 */
export {
  TOOL_AUTO_ON_CONFIG,
  MODE_SCOPED_TOOL_PLUGIN_KEYS,
  PLAN_AUTO_ON_TOOLS,
  GOAL_AUTO_ON_TOOLS,
  PLAN_AUTO_ON_DEFAULT_ENABLED,
  GOAL_AUTO_ON_DEFAULT_ENABLED,
  defaultToolAutoOnState,
  normalizeToolList,
  normalizeToolAutoOnState,
  normalizeAutoOnLayer,
  mergeAutoOnLayers,
  autoOnSettingsEqual,
  hasAutoOnLayerFields,
} from "./tool-auto-on.js";

/** 方向1 复盘指引：语义 + 文本 + 工具可用性判断（见 review-guidance.js）。 */
export {
  MEMORY_REVIEW_MAX_ITEMS,
  MEMORY_REVIEW_DEFAULT_LIFECYCLE_STATUS,
  MEMORY_REVIEW_FIELDS,
  reviewGuidanceText,
  toolCallable,
} from "./review-guidance.js";

/** 二阶段 技能自省：常量 + 文本 + 技能闭环可用性判断（见 skill-guidance.js）。 */
export {
  SKILL_PRIVATE_DIR_NAME,
  SKILL_PROCESS_DIR_NAME,
  SKILL_BOUNDARY_MAX_CHANGES,
  SKILL_EVIDENCE_MIN,
  SKILL_LIFECYCLE_TOOLS,
  skillReviewGuidanceText,
  skillLifecycleCallable,
} from "./skill-guidance.js";

/** 第三次升级 任务分类工具选择：基础面 / optional 池 / enable_tool（见 task-tool-selection.js）。 */
export {
  ENABLE_TOOL,
  BASE_TOOLS,
  MODE_SCOPED_TOOLS,
  baseToolNames,
  normalizeOptionalTools,
  optionalToolPoolNames,
  compactOptionalToolDirectory,
  OPTIONAL_TOOLS_WARN_THRESHOLD,
  OPTIONAL_TOOLS_MAX,
  OPTIONAL_TOOLS_WARN_MESSAGE,
  OPTIONAL_TOOLS_REJECT_MESSAGE,
  validateOptionalToolCount,
} from "./task-tool-selection.js";

/** 第14次更新 Agent 管理「自写工具」层：registry 校验 / agent 组 / 全局合并（见 agent-managed-tools.js）。 */
export {
  AGENT_MANAGED_PLUGIN_PREFIX,
  AGENT_MANAGED_CATALOG_GROUP_ID,
  AGENT_MANAGED_STORAGE_FILE,
  normalizeAgentManagedRegistry,
  agentManagedPluginKeys,
  agentManagedToolNames,
  agentManagedCatalogEntries,
  agentManagedRegistryHasPlugin,
  mergeAgentManagedToolsIntoSurface,
} from "./agent-managed-tools.js";

/** Kaz 6.0 Step 2 受控热加载判定与降级路径（见 hot-load-probe.js）。 */
export {
  HOT_LOAD_INPUT_KEYS,
  HOT_LOAD_SUPPORTED,
  HOT_LOAD_UNSUPPORTED,
  hotLoadProbe,
  hotLoadVerdictText,
} from "./hot-load-probe.js";

/** Kaz 6.0 Step 2 维护子代理结构化短 report / 物理删除闸门（见 maintenance-report.js）。 */
export {
  MAINTENANCE_REPORT_FIELDS,
  MAINTENANCE_REPORT_ITEM_MAX,
  MAINTENANCE_REPORT_MAX_CHARS,
  normalizeMaintenanceReport,
  maintenanceReportToText,
  parseMaintenanceReport,
  shortMaintenanceReport,
  validatePhysicalDeletionRequest,
  newDeletionAudit,
} from "./maintenance-report.js";

/** Kaz 6.0 Step 2 子代理 toolFilter 白名单投影（见 subagent-policy.js）。 */
export {
  SUBAGENT_ROLE_IDS,
  SUBAGENT_ROLE_INSTANCES,
  SUBAGENT_ROLE_TOOL_FILTERS,
  SUBAGENT_ROLE_MEMORY_READ_TOOLS,
  SUBAGENT_MAINTENANCE_MEMORY_WRITE_TOOLS,
  normalizeToolNameList,
  normalizeSubagentRole,
  toolFilterForRole,
  projectTaskWhitelist,
  assertSubsetOf,
} from "./subagent-policy.js";

/** 终案 E 全自动 Skill 生命周期：纯函数（归一化 / audit 建议 / registry 投影 / 状态机，见 skill-lifecycle.js）。 */
export {
  SKILL_LIFECYCLE_VERSION,
  SKILL_LIFECYCLE_STATUSES,
  SKILL_LIFECYCLE_DEFAULT_UNUSED_DAYS_BEFORE_PENDING,
  SKILL_LIFECYCLE_DEFAULT_PENDING_GRACE_DAYS,
  SKILL_LIFECYCLE_DEFAULT_TOOL_FAIL_WINDOW_DAYS,
  SKILL_LIFECYCLE_DEFAULT_TOOL_FAIL_THRESHOLD,
  SKILL_LIFECYCLE_DEFAULT_TOOL_FAIL_RATE,
  SKILL_LIFECYCLE_DEFAULT_PROBE_FAIL_THRESHOLD,
  SKILL_LIFECYCLE_DEFAULT_AUDIT_INTERVAL_HOURS,
  SKILL_LIFECYCLE_DEFAULT_MAX_AUTO_ACTIONS,
  SKILL_LIFECYCLE_DEFAULTS,
  normalizeSkillLifecycle,
  normalizeSkillLifecycleDefaults,
  skillKeyOf,
  auditSkillLifecycle,
  projectRegistryFromLifecycle,
  transitionAllowed,
} from "./skill-lifecycle.js";
