// kaz-shared —— Kaz 模式工具清单的单一事实源（纯 ESM 模块，非 cordis 插件）
// ===========================================================================
// 职责：
//   1) TOOL_WHITELIST：Kaz 模式下允许出现的【全部】工具默认清单（含
//      kaz-memory 六工具）。白名单是唯一闸门：不在清单里的工具即使被注册
//      也不会进入 Kaz 工具列表。
//   2) 工具面计算：computeSurface / effectiveToolWhitelist 供 kaz-mode 组装层
//      过滤与状态报告使用。
//   3) 工具插件状态模型：原设置（factory）→ 用户默认 → 项目专属。
//      每个状态对象统一为：
//         plugins[key] = {
//           ignored: boolean?,   // true = 插件被忽略（大开关硬关）
//           capable: boolean?,   // true = 插件有“能力启用”（大开关）
//           tools: { name: boolean },   // 小开关：工具是否在白名单/启用
//           hiddenTools: { name: boolean } // 工具是否被隐藏（隐藏=关闭）
//         }
//       effective 工具可见 = !ignored && capable && tools[tool] && !hidden。
//
// 工具面语义（2026-08-21 统一，2026-08-25 拆分插件能力/工具默认）：
//   - Kaz 模式（kaz-mode.enabled=true）下：
//       effectiveToolWhitelist = 用户 settings.toolWhitelist（缺失时
//       TOOL_WHITELIST）原样去重——白名单是唯一闸门，不做任何群组加减；
//       全量阶段 = effectiveToolWhitelist；
//       首阶段（round-minimal 信号 minimalPhase=true）只保留 firstRoundTools；
//       firstRoundTools 为空时按 kaz-memory 启用状态自动解析（resolveFirstRoundTools）：
//       kaz-memory 开 → 仅 memory_search；关 → pwsh + read + edit。
//   - kaz-memory 的工具是否出现在工具面 ⇔ 插件 enabled 时注册到 harness
//     （关闭时完全注销，由插件自身负责）且名字在白名单里。
//   - 非 Kaz 模式：本模块不干预（工具面由标准模式决定）。
//   - 用户 settings.yaml 的 toolWhitelist / firstRoundTools / disabledTools
//     始终优先：本模块只提供默认值与计算，不读写设置。
//
// 本模块零副作用导入；原设置/分类来自 tool-plugin-catalog.js。
// ===========================================================================

import {
  TOOL_PLUGIN_CATALOG,
  DEFAULT_ENABLED_TOOL_PLUGINS,
  DEFAULT_UNABLED_TOOL_PLUGINS,
  OFFICIAL_TOOL_PLUGIN_KEYS,
  KAZ_TOOL_PLUGIN_KEYS,
  OFFICIAL_TOOL_NAMES,
  UNKNOWN_PLUGIN_KEY,
} from "./tool-plugin-catalog.js";

/** kaz-memory 开启时的首轮工具白名单：第一轮先查记忆，触发首次工具调用后再恢复。 */
export const DEFAULT_FIRST_ROUND_TOOLS_MEMORY_ON = ["memory_search"];

/** kaz-memory 关闭时的首轮工具白名单：回到原来的 pwsh + read + edit（shell + 看/改文件）。 */
export const DEFAULT_FIRST_ROUND_TOOLS_MEMORY_OFF = ["pwsh", "read", "edit"];

/** 兜底默认（kaz-memory 状态未知时）：pwsh + read + edit（旧行为）。 */
export const DEFAULT_FIRST_ROUND_TOOLS = DEFAULT_FIRST_ROUND_TOOLS_MEMORY_OFF;

/**
 * 首轮工具规则（与 kaz/kaz-system-prompt.mjs 的 PROMPT_RULES 同思路）：
 * 第一个 test 返回 true 的规则胜出。
 *   - kaz-memory 启用 → 仅 memory_search
 *   - 默认（关闭 / 未知）→ pwsh + read + edit
 */
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

/** 按 kaz-memory 启用状态解析首轮工具白名单（统一管理点，类似系统提示词规则）。 */
export function resolveFirstRoundTools({ kazMemoryEnabled } = {}) {
  for (const rule of FIRST_ROUND_TOOL_RULES) {
    try {
      if (rule.test(kazMemoryEnabled)) return [...rule.tools];
    } catch {
      // 某条规则异常时跳过，继续往下找
    }
  }
  return [...DEFAULT_FIRST_ROUND_TOOLS];
}

/** plugin-filter 默认禁用清单（插件/工具名，大小写不敏感匹配）。 */
export const DEFAULT_DISABLED_TOOLS = ["tool-cordis", "tool-subagent-report", "codex", "claude-code"];

/** kaz-memory 六个记忆工具名（会话级可见性由 kaz-mode 按 agent 会话计算）。 */
export const MEMORY_TOOLS = [
  "memory_save",
  "memory_update",
  "memory_list",
  "memory_search",
  "memory_detail",
  "memory_forget",
];

/** Kaz 模式默认系统提示词（persona 默认文本；实际由 kaz 预设脚本按条件覆盖）。 */
export const FIXED_PERSONA = "You are a helpful software engineer assistant.";

/** 被管理插件目录（kaz-mode 面板共用；kaz-diag 已移除）。 */
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

/**
 * 旧白名单已注释（2026-08）：原设置统一由 tool-plugin-catalog.js 提供，
 * 这里只保留一个由目录派生的兼容导出，供旧路径兜底。
 */
/** 由 TOOL_PLUGIN_CATALOG + DEFAULT_ENABLED_TOOL_PLUGINS 派生（兼容旧 API）。 */
export const TOOL_WHITELIST = Object.entries(TOOL_PLUGIN_CATALOG)
  .filter(([key]) => DEFAULT_ENABLED_TOOL_PLUGINS.includes(key))
  .flatMap(([, tools]) => tools.filter((tool) => tool.enabled === true).map((tool) => tool.name));

/** 清理 + 去重工具名列表（保留顺序）。 */
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

/**
 * 有效白名单 = 用户 settings.toolWhitelist（缺失/为空时用 TOOL_WHITELIST），
 * 原样去重。白名单是唯一闸门：不做群组加减——已注册但不在清单里的工具不会
 * 进入工具面；反过来，清单里的工具也要等插件注册后才真正出现在工具列表里。
 */
export function effectiveToolWhitelist(toolWhitelist = []) {
  const list = Array.isArray(toolWhitelist) && toolWhitelist.length > 0 ? toolWhitelist : TOOL_WHITELIST;
  return cleanTools(list);
}

/**
 * 计算某代理此刻的 Kaz 工具面（Set）。
 *   minimalPhase=true（round-minimal 首阶段）：只保留 firstRoundTools；
 *   firstRoundTools 为空时按 kazMemoryEnabled 自动解析（resolveFirstRoundTools）；
 *   否则全量阶段 = effectiveToolWhitelist。
 * @param {object} inputs
 * @param {string[]} [inputs.toolWhitelist] settings 的 kaz-mode.toolWhitelist
 * @param {boolean} [inputs.minimalPhase] round-minimal 首阶段信号
 * @param {string[]} [inputs.firstRoundTools] round-minimal 的 firstRoundTools（空 = 自动）
 * @param {boolean} [inputs.kazMemoryEnabled] 该会话 kaz-memory 是否启用（firstRoundTools 为空时用）
 * @returns {Set<string>}
 */
export function computeSurface({ toolWhitelist = [], minimalPhase = false, firstRoundTools = [], kazMemoryEnabled } = {}) {
  const first = cleanTools(firstRoundTools);
  if (minimalPhase) {
    return new Set(first.length > 0 ? first : resolveFirstRoundTools({ kazMemoryEnabled }));
  }
  return new Set(effectiveToolWhitelist(toolWhitelist));
}

// ---------------------------------------------------------------------------
// 工具插件状态模型（factory → 用户默认 → 项目专属）
// ---------------------------------------------------------------------------
// 状态对象统一为：
//   {
//     version: 1,
//     plugins: {
//       "tool-fs": {
//         ignored: false,          // 插件被忽略（硬关）
//         capable: true,           // 插件是否有能力启用（大开关）
//         tools: { "read": true }, // 工具是否启用（小开关）
//         hiddenTools: {}          // 工具是否被隐藏
//       }
//     }
//   }
// 用户默认 / 项目专属在磁盘上拆成两个同层文件：
//   - kaz-tool-plugin-catalog.json  ：插件级 { ignored, capable }
//   - kaz-tool-plugin-defaults.json ：工具级 { tools, hiddenTools }
// 加载时用 pluginLayerToToolPluginState 合成回上面的统一状态。
// ---------------------------------------------------------------------------

/** 外置工具插件状态文件版本。 */
export const EXTERNAL_TOOL_PLUGIN_STATE_VERSION = 1;

/** 统一工具插件出厂默认（factory）：由 tool-plugin-catalog.js 派生。 */
export const TOOL_PLUGIN_FACTORY = {
  version: EXTERNAL_TOOL_PLUGIN_STATE_VERSION,
  plugins: Object.fromEntries(
    Object.entries(TOOL_PLUGIN_CATALOG).map(([key, tools]) => {
      const capable = DEFAULT_ENABLED_TOOL_PLUGINS.includes(key);
      const toolMap = {};
      for (const item of tools) {
        toolMap[item.name] = item.enabled === true;
      }
      return [key, { ignored: false, capable, tools: toolMap, hiddenTools: {} }];
    }),
  ),
};

/** 原设置拆出的“插件级”出厂默认：{ ignored, capable }。 */
export const TOOL_PLUGIN_CATALOG_FACTORY = {
  version: EXTERNAL_TOOL_PLUGIN_STATE_VERSION,
  plugins: Object.fromEntries(
    Object.keys(TOOL_PLUGIN_CATALOG).map((key) => [
      key,
      { ignored: false, capable: DEFAULT_ENABLED_TOOL_PLUGINS.includes(key) },
    ]),
  ),
};

/** 原设置拆出的“工具级”出厂默认：{ tools, hiddenTools }。 */
export const TOOL_PLUGIN_DEFAULTS_FACTORY = {
  version: EXTERNAL_TOOL_PLUGIN_STATE_VERSION,
  plugins: Object.fromEntries(
    Object.entries(TOOL_PLUGIN_CATALOG).map(([key, tools]) => [
      key,
      {
        tools: Object.fromEntries(tools.map((item) => [item.name, item.enabled === true])),
        hiddenTools: {},
      },
    ]),
  ),
};

/** 官方 / Kaz 插件分类目录（源码修改点，见 tool-plugin-catalog.js）。 */
export { OFFICIAL_TOOL_PLUGIN_KEYS, KAZ_TOOL_PLUGIN_KEYS, OFFICIAL_TOOL_NAMES, UNKNOWN_PLUGIN_KEY, DEFAULT_ENABLED_TOOL_PLUGINS, DEFAULT_UNABLED_TOOL_PLUGINS } from "./tool-plugin-catalog.js";

/** 通用别名：外置/官方统一叫“工具插件”，后续新代码优先用这些名字。 */
export const emptyToolPluginState = emptyExternalToolPluginState;
export const normalizeToolPluginState = normalizeExternalToolPluginState;
export const mergeToolPluginStates = mergeExternalToolPluginStates;
export const setToolPluginTool = setExternalPluginTool;
export const removeToolPluginTool = removeExternalPluginTool;
export const setToolPluginToolHidden = setExternalPluginToolHidden;
export const setToolPluginIgnored = setExternalPluginIgnored;
export const restoreToolPlugin = restoreExternalPlugin;
export const effectiveToolPluginState = effectiveExternalToolPluginState;
export const flattenEnabledToolPlugins = flattenEnabledExternalTools;
export const computeToolPluginSurface = computeExternalToolSurface;

/** 归一化插件/工具名（匹配用）：小写，非字母数字连续串折叠为单个 “-”。 */
export function normalizeExternalKey(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** 返回一份空的外置工具插件状态（三层共用同一形态）。 */
export function emptyExternalToolPluginState() {
  return { version: EXTERNAL_TOOL_PLUGIN_STATE_VERSION, plugins: {} };
}

/** 清洗任意来源的外置工具插件状态：只保留合法结构，未知字段丢弃。 */
export function normalizeExternalToolPluginState(raw) {
  const value = raw !== null && typeof raw === "object" ? raw : {};
  const plugins = {};
  if (value.plugins !== null && typeof value.plugins === "object") {
    for (const [rawKey, plugin] of Object.entries(value.plugins)) {
      const key = normalizeExternalKey(rawKey);
      if (key.length === 0) continue;
      const item = plugin !== null && typeof plugin === "object" ? plugin : {};
      const tools = {};
      if (item.tools !== null && typeof item.tools === "object") {
        for (const [toolName, enabled] of Object.entries(item.tools)) {
          if (typeof toolName !== "string" || toolName.length === 0) continue;
          tools[toolName] = enabled === true;
        }
      }
      const hiddenTools = {};
      if (item.hiddenTools !== null && typeof item.hiddenTools === "object") {
        for (const [toolName, hidden] of Object.entries(item.hiddenTools)) {
          if (typeof toolName !== "string" || toolName.length === 0) continue;
          hiddenTools[toolName] = hidden === true;
        }
      }
      const entry = { tools, hiddenTools };
      if (typeof item.ignored === "boolean") entry.ignored = item.ignored;
      if (typeof item.capable === "boolean") entry.capable = item.capable;
      plugins[key] = entry;
    }
  }
  return { version: EXTERNAL_TOOL_PLUGIN_STATE_VERSION, plugins };
}

/**
 * 合并多层外置工具插件状态（顺序 = 优先级，后层覆盖前层）：
 *   factory → user → project
 * 插件级（ignored/capable）和工具级都做浅合并：高层显式写 false 会覆盖低层
 * 的 true，高层没写的键继承低层。
 */
export function mergeExternalToolPluginStates(...states) {
  const out = emptyExternalToolPluginState();
  for (const state of states) {
    const normalized = normalizeExternalToolPluginState(state);
    for (const [key, plugin] of Object.entries(normalized.plugins)) {
      const target = out.plugins[key] ?? { tools: {}, hiddenTools: {} };
      if (plugin.ignored !== undefined) target.ignored = plugin.ignored;
      if (plugin.capable !== undefined) target.capable = plugin.capable;
      for (const [tool, enabled] of Object.entries(plugin.tools)) {
        target.tools[tool] = enabled;
      }
      for (const [tool, hidden] of Object.entries(plugin.hiddenTools)) {
        target.hiddenTools[tool] = hidden;
      }
      out.plugins[key] = target;
    }
  }
  return out;
}

/** 设置某个外置插件的某个工具开关；enabled=true/false，传 null/undefined 表示删除该键。 */
export function setExternalPluginTool(state, pluginName, toolName, enabled) {
  const next = normalizeExternalToolPluginState(state);
  const key = normalizeExternalKey(pluginName);
  if (key.length === 0 || typeof toolName !== "string" || toolName.length === 0) return next;
  const plugin = next.plugins[key] ?? { tools: {}, hiddenTools: {} };
  if (enabled === true) {
    plugin.tools[toolName] = true;
    delete plugin.hiddenTools[toolName];
  } else if (enabled === false) {
    plugin.tools[toolName] = false;
  } else {
    delete plugin.tools[toolName];
    delete plugin.hiddenTools[toolName];
  }
  next.plugins[key] = plugin;
  return next;
}

/** 删除某个外置插件的某个工具键（等价于“不再显式管理该工具”）。 */
export function removeExternalPluginTool(state, pluginName, toolName) {
  const next = setExternalPluginTool(state, pluginName, toolName, null);
  const key = normalizeExternalKey(pluginName);
  const plugin = next.plugins[key];
  if (plugin !== undefined) delete plugin.hiddenTools[toolName];
  return next;
}

/** 设置某个外置插件的某个工具“隐藏/忽略”状态（hidden=true 时该工具从面板主列表隐藏，但仍检测到时进入还原区）。 */
export function setExternalPluginToolHidden(state, pluginName, toolName, hidden) {
  const next = normalizeExternalToolPluginState(state);
  const key = normalizeExternalKey(pluginName);
  if (key.length === 0 || typeof toolName !== "string" || toolName.length === 0) return next;
  const plugin = next.plugins[key] ?? { tools: {}, hiddenTools: {} };
  if (hidden === true) {
    plugin.hiddenTools[toolName] = true;
    delete plugin.tools[toolName];
  } else {
    delete plugin.hiddenTools[toolName];
    if (!Object.prototype.hasOwnProperty.call(plugin.tools, toolName)) {
      plugin.tools[toolName] = true; // 还原 = 默认开启
    }
  }
  next.plugins[key] = plugin;
  return next;
}

/** 设置某个外置插件的“忽略”状态（true = 永久关闭，可还原）。 */
export function setExternalPluginIgnored(state, pluginName, ignored) {
  const next = normalizeExternalToolPluginState(state);
  const key = normalizeExternalKey(pluginName);
  if (key.length === 0) return next;
  const plugin = next.plugins[key] ?? { tools: {}, hiddenTools: {} };
  plugin.ignored = ignored === true;
  next.plugins[key] = plugin;
  return next;
}

/** 设置某个外置插件的“能力启用”状态（大开关；true = 该插件下的工具有能力启用）。 */
export function setExternalPluginCapable(state, pluginName, capable) {
  const next = normalizeExternalToolPluginState(state);
  const key = normalizeExternalKey(pluginName);
  if (key.length === 0) return next;
  const plugin = next.plugins[key] ?? { tools: {}, hiddenTools: {} };
  plugin.capable = capable === true;
  next.plugins[key] = plugin;
  return next;
}

/**
 * 还原某个外置插件：取消忽略、恢复能力启用，清除全部工具隐藏标记，
 * 并把该插件已登记的所有工具设为开启（用户确认的语义：还原 = 默认全部开启）。
 */
export function restoreExternalPlugin(state, pluginName) {
  const next = normalizeExternalToolPluginState(state);
  const key = normalizeExternalKey(pluginName);
  if (key.length === 0) return next;
  const plugin = next.plugins[key] ?? { tools: {}, hiddenTools: {} };
  plugin.ignored = false;
  plugin.capable = true;
  plugin.hiddenTools = {};
  for (const tool of Object.keys(plugin.tools)) {
    plugin.tools[tool] = true;
  }
  next.plugins[key] = plugin;
  return next;
}

/**
 * 计算外置工具插件最终状态：merge(factory, user, project)。
 * 返回规范化后的状态对象。
 */
export function effectiveExternalToolPluginState({ factory = {}, user = {}, project = {} } = {}) {
  return mergeExternalToolPluginStates(factory, user, project);
}

/**
 * 把最终状态 + 动态检测结果展开成“应在 Kaz 工具面出现的外置工具名集合”。
 * 规则：
 *   - 插件 ignored=true → 该插件工具全部不出现；
 *   - 插件 capable=false → 该插件工具全部不出现（没有能力启用）；
 *   - 已显式登记的工具：true 出现、false 不出现；
 *   - 检测到但未显式登记的工具（新工具/新插件）→ 默认开启（补入集合）。
 */
export function flattenEnabledExternalTools(effectiveState, detected = {}) {
  const state = normalizeExternalToolPluginState(effectiveState);
  const out = new Set();

  // ① 显式登记的工具
  for (const [key, plugin] of Object.entries(state.plugins)) {
    if (plugin.ignored === true) continue;
    if (plugin.capable === false) continue;
    for (const [tool, enabled] of Object.entries(plugin.tools)) {
      if (plugin.hiddenTools[tool] === true) continue;
      if (enabled === true) out.add(tool);
    }
  }

  // ② 检测到的工具：官方/Kaz/外置统一——显式 false 关闭，未登记默认开启。
  for (const [rawKey, tools] of Object.entries(detected)) {
    const key = normalizeExternalKey(rawKey);
    if (key.length === 0) continue;
    const plugin = state.plugins[key];
    if (plugin !== undefined && plugin.ignored === true) continue;
    if (plugin !== undefined && plugin.capable === false) continue;
    const list = Array.isArray(tools)
      ? tools
      : tools !== null && typeof tools === "object" && Array.isArray(tools.tools)
        ? tools.tools
        : [];
    for (const rawTool of list) {
      const tool = typeof rawTool === "string" ? rawTool : rawTool !== null && typeof rawTool === "object" ? rawTool.name : undefined;
      if (typeof tool !== "string" || tool.length === 0) continue;
      if (plugin !== undefined && plugin.hiddenTools[tool] === true) continue;
      if (plugin !== undefined && Object.prototype.hasOwnProperty.call(plugin.tools, tool)) {
        if (plugin.tools[tool] === true) out.add(tool);
      } else {
        out.add(tool);
      }
    }
  }

  return out;
}

/** 一步到位：factory → user → project 合并后，再按动态检测结果展开外置工具面。 */
export function computeExternalToolSurface({ factory = {}, user = {}, project = {}, detected = {} } = {}) {
  return flattenEnabledExternalTools(effectiveExternalToolPluginState({ factory, user, project }), detected);
}

// ---------------------------------------------------------------------------
// 磁盘拆分模型：插件级（kaz-tool-plugin-catalog.json） + 工具级（kaz-tool-plugin-defaults.json）
// ---------------------------------------------------------------------------

/** 空插件级状态（用户/项目同层）。 */
export function emptyPluginCatalogState() {
  return { version: EXTERNAL_TOOL_PLUGIN_STATE_VERSION, plugins: {} };
}

/** 空工具级状态（用户/项目同层）。 */
export function emptyToolDefaultsState() {
  return { version: EXTERNAL_TOOL_PLUGIN_STATE_VERSION, plugins: {} };
}

/** 清洗插件级状态：{ plugins: { key: { ignored, capable } } }。 */
export function normalizePluginCatalogState(raw) {
  const value = raw !== null && typeof raw === "object" ? raw : {};
  const plugins = {};
  if (value.plugins !== null && typeof value.plugins === "object") {
    for (const [rawKey, plugin] of Object.entries(value.plugins)) {
      const key = normalizeExternalKey(rawKey);
      if (key.length === 0) continue;
      const item = plugin !== null && typeof plugin === "object" ? plugin : {};
      const entry = {};
      if (typeof item.ignored === "boolean") entry.ignored = item.ignored;
      if (typeof item.capable === "boolean") entry.capable = item.capable;
      plugins[key] = entry;
    }
  }
  return { version: EXTERNAL_TOOL_PLUGIN_STATE_VERSION, plugins };
}

/** 清洗工具级状态：{ plugins: { key: { tools, hiddenTools } } }。 */
export function normalizeToolDefaultsState(raw) {
  const value = raw !== null && typeof raw === "object" ? raw : {};
  const plugins = {};
  if (value.plugins !== null && typeof value.plugins === "object") {
    for (const [rawKey, plugin] of Object.entries(value.plugins)) {
      const key = normalizeExternalKey(rawKey);
      if (key.length === 0) continue;
      const item = plugin !== null && typeof plugin === "object" ? plugin : {};
      const tools = {};
      if (item.tools !== null && typeof item.tools === "object") {
        for (const [toolName, enabled] of Object.entries(item.tools)) {
          if (typeof toolName !== "string" || toolName.length === 0) continue;
          tools[toolName] = enabled === true;
        }
      }
      const hiddenTools = {};
      if (item.hiddenTools !== null && typeof item.hiddenTools === "object") {
        for (const [toolName, hidden] of Object.entries(item.hiddenTools)) {
          if (typeof toolName !== "string" || toolName.length === 0) continue;
          hiddenTools[toolName] = hidden === true;
        }
      }
      plugins[key] = { tools, hiddenTools };
    }
  }
  return { version: EXTERNAL_TOOL_PLUGIN_STATE_VERSION, plugins };
}

/** 把同一层的“插件级 + 工具级”合成一个统一状态对象（只含显式出现的键）。 */
export function pluginLayerToToolPluginState(pluginCatalog = {}, toolDefaults = {}) {
  const pluginState = normalizePluginCatalogState(pluginCatalog);
  const toolState = normalizeToolDefaultsState(toolDefaults);
  const plugins = {};
  const keys = new Set([...Object.keys(pluginState.plugins), ...Object.keys(toolState.plugins)]);
  for (const key of keys) {
    const p = pluginState.plugins[key] ?? {};
    const t = toolState.plugins[key] ?? { tools: {}, hiddenTools: {} };
    const entry = { tools: { ...t.tools }, hiddenTools: { ...t.hiddenTools } };
    if (p.ignored !== undefined) entry.ignored = p.ignored;
    if (p.capable !== undefined) entry.capable = p.capable;
    plugins[key] = entry;
  }
  return { version: EXTERNAL_TOOL_PLUGIN_STATE_VERSION, plugins };
}
