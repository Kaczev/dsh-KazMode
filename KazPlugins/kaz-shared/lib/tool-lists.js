// kaz-shared —— Kaz 模式工具清单的单一事实源（纯 ESM 模块，非 cordis 插件）
// ===========================================================================
// 职责：
//   1) 首轮工具规则、记忆工具、被管理插件目录等常量；
//   2) 工具插件“四文件模型”的归一化 / 合并 / 工具面计算：
//        - enable 类：纯数组，例如 ["tool-fs", "dsh-pixel-art"]
//        - catalog 类：纯对象，例如 { "tool-fs": { "read": true, "write": false } }
//   3) computeSurface / effectiveToolWhitelist 供 kaz-mode 组装层使用。
//
// 层次：
//   原设置   = 代码 TOOL_PLUGIN_CATALOG + 用户 other-*.json
//   默认设置 = 用户 tool-plugin-catalog.json + 用户 other-*.json
//   专属设置 = 项目 tool-plugin-catalog.json + 项目 other-*.json
// 工具面只放行：
//   - 插件在“启用插件并集”里；
//   - 工具在 T0 全集里；
//   - 工具在生效 catalog 里为 true。
// ===========================================================================

import {
  TOOL_PLUGIN_CATALOG,
  DEFAULT_ENABLED_TOOL_PLUGINS,
  OFFICIAL_TOOL_PLUGIN_KEYS,
  KAZ_TOOL_PLUGIN_KEYS,
} from "./tool-plugin-catalog.js";

/** kaz-memory 开启时的首轮工具白名单：第一轮先查记忆，触发首次工具调用后再恢复。 */
export const DEFAULT_FIRST_ROUND_TOOLS_MEMORY_ON = ["memory_search"];

/** kaz-memory 关闭时的首轮工具白名单：回到原来的 pwsh + read + edit（shell + 看/改文件）。 */
export const DEFAULT_FIRST_ROUND_TOOLS_MEMORY_OFF = ["pwsh", "read", "edit"];

/** 兜底默认（kaz-memory 状态未知时）：pwsh + read + edit（旧行为）。 */
export const DEFAULT_FIRST_ROUND_TOOLS = DEFAULT_FIRST_ROUND_TOOLS_MEMORY_OFF;

const FIRST_ROUND_TOOL_RULES = [
  {
    id: "kaz-memory",
    test: (kazMemoryEnabled) => kazMemoryEnabled === true,
    tools: DEFAULT_FIRST_ROUND_TOOLS_MEMORY_ON,
  },
  {
    id: "default",
    test: () => true,
    tools: DEFAULT_FIRST_ROUND_TOOLS_MEMORY_OFF,
  },
];

/** 按 kaz-memory 启用状态解析首轮工具白名单。 */
export function resolveFirstRoundTools({ kazMemoryEnabled } = {}) {
  for (const rule of FIRST_ROUND_TOOL_RULES) {
    try {
      if (rule.test(kazMemoryEnabled)) return [...rule.tools];
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

/** Kaz 模式默认系统提示词。 */
export const FIXED_PERSONA = "You are a helpful software engineer assistant.";

/** 被管理插件目录。 */
export const MANAGED_PLUGINS = [
  { id: "thinking-anchor", label: "thinking-anchor（思考锚点 · 消息注入）" },
  { id: "round-minimal", label: "round-minimal（首阶段极简 · 首次工具调用后恢复）" },
  { id: "plugin-filter", label: "plugin-filter（工具过滤）" },
  { id: "output-beep", label: "output-beep（输出完成提示音）" },
  { id: "round-display", label: "round-display（每轮注入显示）" },
  { id: "deepseek-default-model", label: "deepseek-default-model（DeepSeek 采样参数）" },
  { id: "kaz-memory", label: "kaz-memory（独立记忆组件）" },
  { id: "first-round-hints", label: "first-round-hints（首轮其它消息提示 · 对话开始注入）" },
];

/** 由 TOOL_PLUGIN_CATALOG + DEFAULT_ENABLED_TOOL_PLUGINS 派生的旧版兼容白名单。 */
export const TOOL_WHITELIST = Object.entries(TOOL_PLUGIN_CATALOG)
  .filter(([key]) => DEFAULT_ENABLED_TOOL_PLUGINS.includes(key))
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

/** 归一化插件/工具名（匹配用）：小写，非字母数字连续串折叠为单个 “-”。 */
export function normalizeExternalKey(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** 清洗 enable 类 JSON（纯数组）→ 去重后的规范化数组。 */
export function normalizeEnableList(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (typeof item !== "string") continue;
    const key = normalizeExternalKey(item);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
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

/** 合并多个 enable 数组（并集，保持顺序）。 */
export function unionEnableLists(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const key of normalizeEnableList(list)) {
      if (!seen.has(key)) {
        seen.add(key);
        out.push(key);
      }
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
 * 构造 T0 全集：代码 TOOL_PLUGIN_CATALOG 与用户 other-tool-plugin-catalog 的所有键，
 * 全部视为 true（T0 只决定“是否允许出现”，不决定最终开关）。
 */
export function buildToolUniverse(codeCatalog, otherCatalog) {
  const merged = mergeToolCatalogs(codeCatalog, otherCatalog);
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
  codeEnabled = DEFAULT_ENABLED_TOOL_PLUGINS,
  userEnable = [],
  userOtherEnable = [],
  userCatalog = {},
  userOtherCatalog = {},
  projectEnable = [],
  projectOtherEnable = [],
  projectCatalog = {},
  projectOtherCatalog = {},
} = {}) {
  const P0 = unionEnableLists(codeEnabled, userOtherEnable);
  const T0 = buildToolUniverse(codeCatalog, userOtherCatalog);
  // 默认/专属都以“代码原设置 + 用户 other-*”为基底，再叠加各层文件。
  const P1 = unionEnableLists(codeEnabled, userEnable, userOtherEnable);
  const T1 = mergeToolCatalogs(codeCatalog, userOtherCatalog, userCatalog);
  const P2 = unionEnableLists(codeEnabled, projectEnable, projectOtherEnable);
  const T2 = mergeToolCatalogs(codeCatalog, projectOtherCatalog, projectCatalog);
  const P = unionEnableLists(P1, P2); // 项目专属并集
  const T = mergeToolCatalogs(T1, T2); // 项目覆盖默认
  return { P0, T0, P1, T1, P2, T2, P, T };
}

/** 由生效状态展开成工具名集合。 */
export function computeToolPluginSurfaceFromEffective(effective) {
  const { P, T, T0 } = effective;
  const enabledPlugins = new Set(P);
  const out = new Set();
  for (const [plugin, tools] of Object.entries(T0)) {
    if (!enabledPlugins.has(plugin)) continue;
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
export { OFFICIAL_TOOL_PLUGIN_KEYS, KAZ_TOOL_PLUGIN_KEYS, DEFAULT_ENABLED_TOOL_PLUGINS, TOOL_PLUGIN_CATALOG } from "./tool-plugin-catalog.js";
