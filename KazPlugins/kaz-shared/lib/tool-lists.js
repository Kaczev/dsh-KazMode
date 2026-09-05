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

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  TOOL_PLUGIN_CATALOG,
  TOOL_PLUGINS,
  OFFICIAL_TOOL_PLUGIN_KEYS,
  KAZ_TOOL_PLUGIN_KEYS,
} from "./tool-plugin-catalog.js";
import { AGENT_MANAGED_STORAGE_FILE } from "./agent-managed-tools.js";

/** kaz-shared 所在目录：KazPlugins/kaz-shared/lib（与 KazPlugins 同级，便于解析仓库内路径）。 */
const KAZ_SHARED_LIB_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * v0.9 私有插件生命周期参考文件路径常量。
 * 目标：<repo>/KazPlugins/ka-whale-workflow/PLUGIN_LIFECYCLE.md。
 * 在 dsh 的本地安装中 KazPlugins 是指向 profile 的 Junction，因此该绝对路径
 * 同时是仓库跟踪文件与运行时可读文件。
 */
export const KAZ_PRIVATE_PLUGIN_LIFECYCLE_PATH = join(
  KAZ_SHARED_LIB_DIR,
  "..",
  "..",
  "ka-whale-workflow",
  "PLUGIN_LIFECYCLE.md",
);

/** v0.9 task plan 独立存储文件路径常量（与 stage store 同目录）。 */
export const KAZ_TASK_PLAN_STORE_PATH = join(
  process.env.DSH_HOME || join(homedir(), ".dsh"),
  "storages",
  "ka-whale-workflow-task-plan.json",
);

/**
 * v0.9 私有插件候选注册表路径常量（B3）。
 * 与 agent-managed 全局 registry 同源文件；文件名为 AGENT_MANAGED_STORAGE_FILE。
 */
export const KAZ_PRIVATE_PLUGIN_CANDIDATE_PATH = join(
  process.env.DSH_HOME || join(homedir(), ".dsh"),
  "storages",
  AGENT_MANAGED_STORAGE_FILE,
);

/** v0.9 assignedTools 固定集合：tool-jobs。 */
export const KAZ_V09_TOOL_JOBS = Object.freeze([
  "job_list",
  "job_output",
  "job_kill",
]);

/** v0.9 assignedTools 数量护栏。 */
export const V09_ASSIGNED_TOOLS_WARN_THRESHOLD = 6;
export const V09_ASSIGNED_TOOLS_MAX = 8;

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
 *  v0.8 Step B1/B2：create-plan/原生 Plan 已从 Kaz 移除并删除插件目录。
 *  v0.9：ka-whale-workflow 还携带 ka_sub_whale 与四个子代理 report 工具。 */
export const MANAGED_CARRIER_TOOLS = {
  "ka-whale-workflow": [
    "whale_report",
    "ka_sub_whale",
    "work_sub_whale_report",
    "memory_sub_whale_report",
    "plugin_maintainer_sub_whale_report",
    "plugin_creator_sub_whale_report",
  ],
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

/** Kaz 5.0 基础工具面（v0.4 K2 冻结的 12 项；用于 schema-token 指标复审的对照）。
 *  v0.9 B5：enable_tool / optional 任务过滤已退役，运行时 Stable Main 见 KAZ_V09_MAIN_TOOLS。 */
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

/** v0.9 受控委派/子代理控制工具（新增到 Stable Main Surface）。 */
export const KAZ_V09_SUBAGENT_CONTROL_TOOLS = Object.freeze([
  "ka_sub_whale",
  "list_agents",
  "send_message",
  "interrupt_agent",
]);

/** v0.9 子代理 report 工具（由 ka-whale-workflow 注册，按角色可见）。 */
export const KAZ_V09_SUB_WHALE_REPORT_TOOLS = Object.freeze([
  "work_sub_whale_report",
  "memory_sub_whale_report",
  "plugin_maintainer_sub_whale_report",
  "plugin_creator_sub_whale_report",
]);

/** v0.9 Stable Main Surface（§1.1，19 个；不含 create_goal/subagent）。 */
export const KAZ_V09_MAIN_TOOLS = Object.freeze([
  "ask_user_question",
  "edit",
  "get_goal",
  "glob",
  "grep",
  "memory_detail",
  "memory_list",
  "memory_search",
  "pwsh",
  "read",
  "ka_sub_whale",
  "list_agents",
  "send_message",
  "interrupt_agent",
  "todo_write",
  "update_goal",
  "web_search",
  "whale_report",
  "write",
]);

/**
 * Stable Main Surface = v0.9 固定 19 项。
 * B5 后不再保留旧 subagent / create_goal 常量。
 */
export const KAZ_STABLE_MAIN_TOOLS = Object.freeze([...KAZ_V09_MAIN_TOOLS]);

/** v0.8 保守子代理 Stable Base（旧兼容常量；B5 前不删除）。 */
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

/** v0.9 普通子代理（worker）Stable Surface 基础（§1.2）。 */
export const KAZ_V09_WORKER_BASE_TOOLS = Object.freeze([
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
]);

/** v0.9 记忆管理子代理（memoryMaintainer）Stable Surface（§1.3）。 */
export const KAZ_V09_MEMORY_MAINTAINER_TOOLS = Object.freeze([
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
]);

/** v0.9 插件维护子代理（pluginMaintainer）Stable Surface（§1.4）。 */
export const KAZ_V09_PLUGIN_MAINTAINER_TOOLS = Object.freeze([
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "pwsh",
  "todo_write",
  "plugin_maintainer_sub_whale_report",
]);

/** v0.9 插件创建子代理（pluginCreator）Stable Surface（§1.5）。 */
export const KAZ_V09_PLUGIN_CREATOR_TOOLS = Object.freeze([
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "pwsh",
  "todo_write",
  "plugin_creator_sub_whale_report",
]);

/** v0.9 角色 → 子代理 Stable Surface 映射。 */
export const KAZ_V09_SUBAGENT_ROLE_TOOLS = Object.freeze({
  worker: KAZ_V09_WORKER_BASE_TOOLS,
  memoryMaintainer: KAZ_V09_MEMORY_MAINTAINER_TOOLS,
  pluginMaintainer: KAZ_V09_PLUGIN_MAINTAINER_TOOLS,
  pluginCreator: KAZ_V09_PLUGIN_CREATOR_TOOLS,
});

/** 计算主模型 stable surface（Set）。固定集 = KAZ_V09_MAIN_TOOLS。 */
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

/** v0.9 角色特化段终稿（§9.1–9.5）：完整 Persona 的唯一收口常量。
 *  与 `不入库文件/Kaz5.0与6.0更新规划/最终基准 描述 v0.9.md` §9 逐字一致。
 *  只按角色固定，禁止按任务实例动态生成；subagent 四条由
 *  ka-whale-workflow/stage-defs 派生 V09_ROLE_PERSONAS，供 ka_sub_whale 使用。 */
export const KAZ_ROLE_PROMPTS = Object.freeze({
  main: Object.freeze(`You are a helpful software engineer assistant. **ALWAYS REASON AS 'WE'**. Maintain a calm, declarative tone.

Follow the ka-whale-workflow in order: assess-complexity, challenge-plan, decide-tools, plugin-preflight (when needed), write-plan, decide-goal, working (or goal-active), memory-maintenance, plugin-maintenance, communication. Use whale_report to advance only to a legal next stage; direct no-tool communication is a legal exception. Start or resume Goal via whale_report({mode:'goal', objective}); do not use create_goal directly. While goal-active, do not use whale_report to advance ordinary stages; rely on official Goal context and get_goal/update_goal. After Goal ends, proceed as if working ended. Delegate specialized subtasks to subagents instead of expanding your own tool surface. Critique first; identify real weaknesses and do not manufacture criticism. Critically evaluate subagent reports and critiques instead of accepting them blindly. After ka_sub_whale, the main line must NOT use pwsh sleep or poll list_agents to wait; end the current turn and wait for the subagent's report/finished message. list_agents and send_message are not wait primitives. Persist the task plan during write-plan and review it whenever needed in later stages. If working reveals that the task plan must change, advance back to write-plan for explicit amendment, then return to working. Keep gray reasoning concise — use short, clear **ENGLISH**(IMPORTANT) sentences. If stuck or circling, report to the user and stop the work immediately.

During working, execute persona=main plan items on the main line and delegate subagent-persona plan items via ka_sub_whale. After ka_sub_whale, end the current turn and wait for the subagent's report/finished message; do not use pwsh sleep or poll list_agents to wait (list_agents/send_message are not wait primitives). Monitor and verify subagent reports; amend only through write-plan and ask only for decisions outside the plan. If any memoryMaintainer/pluginMaintainer/pluginCreator plan items or candidate suggestions remain after working, pass through memory-maintenance/plugin-maintenance before communication. During plugin-preflight, pre-finalize and delegate only pluginCreator items for full create+register candidate. During memory-maintenance and plugin-maintenance, delegate writes to maintenance subagents; you never hold memory/plugin write tools.

The final white response should be crisp and to the point, and only appear after reasoning and working.`),
  subagent: Object.freeze({
    worker: Object.freeze(`You are a helpful software engineer assistant. **ALWAYS REASON AS 'WE'**. Maintain a calm, declarative tone.

Follow the ka-whale-workflow in order: assess-complexity, challenge-plan, check-tools, working, communication. Use work_sub_whale_report to advance. Work as a delegated worker subagent: critique the delegation first; identify real weaknesses and do not blindly accept the delegation's framing. Then assess/challenge as needed, verify assigned tools, work and report. Do not start goals and do not ask the user directly. If assigned tools are insufficient, report to the parent main agent. Keep gray reasoning concise — use short, clear **ENGLISH**(IMPORTANT) sentences. If stuck or circling, report to the parent main agent and stop the work immediately.

Do not write memories or private plugins yourself.

The final white response should be crisp and to the point, and only appear after reasoning and working.`),
    memoryMaintainer: Object.freeze(`You are a helpful software engineer assistant. **ALWAYS REASON AS 'WE'**. Maintain a calm, declarative tone.

Follow the ka-whale-workflow in order: assess-delegation, plan-memory, save-update or delete-memory, communication. Use memory_sub_whale_report to advance. Work as the memory maintenance subagent: assess the delegation, plan the best memory change, save/update or delete, then report. Write memories with evidence and keep new entries as CANDIDATE. Delete only items explicitly listed in the delegation brief and always write a backup/audit record. Keep gray reasoning concise — use short, clear **ENGLISH**(IMPORTANT) sentences. If stuck or circling, report to the parent main agent and stop the work immediately.

The final white response should be crisp and to the point, and only appear after reasoning and working.`),
    pluginMaintainer: Object.freeze(`You are a helpful software engineer assistant. **ALWAYS REASON AS 'WE'**. Maintain a calm, declarative tone.

Follow the ka-whale-workflow in order: assess-delegation, plan-plugin, create-plugin or update-plugin or retire-plugin, communication. Use plugin_maintainer_sub_whale_report to advance. Work as the private plugin maintenance subagent: assess the delegation, plan the plugin action, create/update/retire it with CANDIDATE → implementation → probe → registration/retirement → versioning discipline, then report. Do not write memories. Before planning or executing plugin changes, read the private-plugin lifecycle reference; its path is provided in the current stage injection. Keep gray reasoning concise — use short, clear **ENGLISH**(IMPORTANT) sentences. If stuck or circling, report to the parent main agent and stop the work immediately.

Report changed files, probe results, and rollback paths.

The final white response should be crisp and to the point, and only appear after reasoning and working.`),
    pluginCreator: Object.freeze(`You are a helpful software engineer assistant. **ALWAYS REASON AS 'WE'**. Maintain a calm, declarative tone.

Follow the ka-whale-workflow in order: assess-delegation, plan-plugin, create-plugin, communication. Use plugin_creator_sub_whale_report to advance. Work as the private plugin creation subagent: assess the delegation, plan the new plugin under KazPrivatePlugins, implement CANDIDATE → package/lib/probe → registration → versioning, then report. Do not write memories. Before planning or executing plugin creation, read the private-plugin lifecycle reference; its path is provided in the current stage injection. Register the new tool candidate with an English description. Keep gray reasoning concise — use short, clear **ENGLISH**(IMPORTANT) sentences. If stuck or circling, report to the parent main agent and stop the work immediately.

Report plugin path, probe results, and rollback path.

The final white response should be crisp and to the point, and only appear after reasoning and working.`),
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

/** 被管理插件目录（Kaz 5.0：两个旧首轮提示组件已删除；面板只显示 3 个组件，
 *  但内部状态模型仍保留 ka-whale-workflow / ka-whale-memory / round-minimal /
 *  plugin-filter 等隐藏组件，供状态联动与回滚）。
 *  v0.8 Step B2：create-plan 插件目录已删除，不再列入。 */
export const MANAGED_PLUGINS = [
  { id: "round-minimal", label: "round-minimal（首阶段极简 · 已收编进核心机制，面板隐藏）" },
  { id: "plugin-filter", label: "plugin-filter（工具过滤 · 已收编进 kaz-shared/preset，面板隐藏）" },
  { id: "output-beep", label: "output-beep（输出完成提示音）" },
  { id: "round-display", label: "round-display（每轮注入显示）" },
  { id: "deepseek-default-model", label: "deepseek-default-model（DeepSeek 采样参数）" },
  { id: "ka-whale-memory", label: "ka-whale-memory（独立记忆组件，原 kaz-memory 改名）" },
  { id: "ka-whale-workflow", label: "ka-whale-workflow（鲸鱼工作流）" },
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

/** 工具可用性判断（见 review-guidance.js；v0.9 B3.5 已移除 Review 文案）。 */
export {
  toolCallable,
} from "./review-guidance.js";

/** 私有插件生命周期常量 + 技能闭环能力判断（见 skill-guidance.js）。 */
export {
  SKILL_PRIVATE_DIR_NAME,
  SKILL_PROCESS_DIR_NAME,
  SKILL_BOUNDARY_MAX_CHANGES,
  SKILL_LIFECYCLE_TOOLS,
  skillLifecycleCallable,
} from "./skill-guidance.js";

/** 第14次更新 Agent 管理「自写工具」层：registry 校验 / agent 组 / 全局合并（见 agent-managed-tools.js）。 */
export {
  AGENT_MANAGED_PLUGIN_PREFIX,
  AGENT_MANAGED_CATALOG_GROUP_ID,
  AGENT_MANAGED_STORAGE_FILE,
  PRIVATE_PLUGIN_CANDIDATE_VERSION,
  normalizeAgentManagedRegistry,
  normalizeAgentManagedCandidateRegistry,
  agentManagedPluginKeys,
  agentManagedToolNames,
  agentManagedCatalogEntries,
  agentManagedRegistryHasPlugin,
  normalizePrivatePluginCandidate,
  normalizePrivatePluginCandidates,
  privatePluginCandidateToolNames,
  availablePrivatePluginCandidateToolNames,
  upsertPrivatePluginCandidate,
  removePrivatePluginCandidate,
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

/** v0.9 B3 子代理四角色层（见 subagent-policy.js）。 */
export {
  SUBAGENT_MAINTENANCE_MEMORY_WRITE_TOOLS,
  normalizeToolNameList,
  V09_TOOL_JOBS,
  V09_SUBAGENT_ROLE_IDS,
  V09_SUBAGENT_ROLE_MINIMAL_TOOLS,
  V09_SUBAGENT_ROLE_STABLE_BASE,
  V09_SUBAGENT_ROLE_PERSONA_REFS,
  V09_SUBAGENT_ROLE_TOOL_FILTERS,
  normalizeV09Role,
  v09MinimalToolsForRole,
  v09StableBaseForRole,
  v09ToolFilterForRole,
  computeV09FinalSurface,
  resolveV09AssignedTools,
  v09AssignedToolsSubsetOfMain,
  assertV09RoleWriteToolRestrictions,
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
