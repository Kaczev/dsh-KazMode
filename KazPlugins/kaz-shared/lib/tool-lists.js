// kaz-shared —— Kaz 模式工具清单的单一事实源（纯 ESM 模块，非 cordis 插件）
// ===========================================================================
// 职责：
//   1) TOOL_WHITELIST：Kaz 模式下允许出现的【全部】工具默认清单（含
//      kaz-memory 六工具与 kaz-diag 的 kaz_mode_status）。白名单是唯一闸门：
//      不在清单里的工具即使被注册也不会进入 Kaz 工具列表。
//   2) 工具面计算：computeSurface / effectiveToolWhitelist 供 kaz-mode 组装层
//      过滤与 kaz-diag 报告使用。
//
// 工具面语义（2026-08-21 统一）：
//   - Kaz 模式（kaz-mode.enabled=true）下：
//       effectiveToolWhitelist = 用户 settings.toolWhitelist（缺失时
//       TOOL_WHITELIST）原样去重——白名单是唯一闸门，不做任何群组加减；
//       全量阶段 = effectiveToolWhitelist；
//       首阶段（round-minimal 信号 minimalPhase=true）只保留 firstRoundTools；
//       firstRoundTools 为空时按 kaz-memory 启用状态自动解析（resolveFirstRoundTools）：
//       kaz-memory 开 → 仅 memory_search；关 → pwsh + read + edit。
//       无交集演算、无 minimalTools 概念。
//   - kaz-memory / kaz-diag 的工具是否出现在工具面 ⇔ 插件 enabled 时注册到
//     harness（关闭时完全注销，由各插件自身负责）且名字在白名单里。
//   - 非 Kaz 模式：本模块不干预（工具面由标准模式决定；kaz-memory 等插件
//     关闭时已自行注销工具，开启时自行注册）。
//   - 用户 settings.yaml 的 toolWhitelist / firstRoundTools / disabledTools
//     始终优先：本模块只提供默认值与计算，不读写设置。
//
// 本模块零依赖、无副作用导入。
// ===========================================================================

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

/** kaz-diag 的状态工具名（会话级可见性由 kaz-mode 按 agent 会话计算）。 */
export const DIAG_TOOL = "kaz_mode_status";

/** Kaz 模式默认系统提示词（persona 默认文本；实际由 kaz 预设脚本按条件覆盖）。 */
export const FIXED_PERSONA = "You are a helpful software engineer assistant.";

/** 被管理插件目录（kaz-mode 面板 / kaz-diag 报告共用）。 */
export const MANAGED_PLUGINS = [
  { id: "thinking-anchor", label: "thinking-anchor（思考锚点 · 消息注入）" },
  { id: "round-minimal", label: "round-minimal（首阶段极简 · 首次工具调用后恢复）" },
  { id: "plugin-filter", label: "plugin-filter（工具过滤）" },
  { id: "output-beep", label: "output-beep（输出完成提示音）" },
  { id: "round-display", label: "round-display（每轮注入显示）" },
  { id: "deepseek-default-model", label: "deepseek-default-model（DeepSeek 采样参数）" },
  { id: "kaz-memory", label: "kaz-memory（独立记忆组件）" },
  { id: "kaz-diag", label: "kaz-diag（诊断 · 状态工具）" },
  { id: "first-round-hints", label: "first-round-hints（首轮其它消息提示 · 对话开始注入）" },
];

/**
 * Kaz 模式下允许出现的【全部】工具默认清单：标准模式全部工具（除 bash 与
 * skill）+ pwsh + str_replace_editor + kaz-memory 六工具 + kaz-diag 的
 * kaz_mode_status。白名单是唯一闸门：不在清单里的工具即使被注册也不会进入
 * Kaz 工具列表。
 * 2026-08-21（Kaczev 决定）移除：read_image（模型不支持图片输入）、ralph（仅
 * 显式请求）、workflow（重型编排）、create_goal/get_goal/update_goal（长周期目标）、
 * str_replace_editor（与 edit/write/read 重叠，仅 insert 独有且日常少用）。
 * 子代理几乎不使用，去掉subagent, subagent_fork, list_agents, send_message, interrupt_agent,
 * 用户 settings.yaml 的 kaz-mode.toolWhitelist 是手动编辑点，始终优先；
 * Kaz 面板的「toolWhitelist」输入直接读写该设置（热重载生效）。
 */
export const TOOL_WHITELIST = [
  "pwsh", // windows PowerShell（跨平台）——首轮工具必选
  "read", "write", "edit", "glob", "grep", // 文件读写/编辑/搜索
  "job_list", "job_output", "job_kill", // 后台任务管理
  "ask_user_question", "todo_write", "web_search", // 交互/待办/搜索
  ...MEMORY_TOOLS, // kaz-memory 六工具
  DIAG_TOOL, // kaz-diag 的工具：Kaz 模式状态报告
];

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
// 外置工具插件管理（2026-08 分步实施 · 第一步：纯数据模型）
// ---------------------------------------------------------------------------
// 目标：Kaz 面板要能管理“外置插件注册进来的工具”（如 dsh-pixel-art 的
// render_pixel_art / convert_image_to_pixel_art）。官方工具不进入这套模型，
// 继续由 toolWhitelist 管。本段只提供纯函数与数据结构，不读写任何文件、
// 不注册任何服务，也不改变现有工具面计算——后续步骤再接动态检测 / 存储 /
// kazSurfaceFor / 面板 UI。
//
// 存储形态（三层：factory → 用户默认 → 项目设置）：
//   {
//     version: 1,
//     plugins: {
//       "dsh-pixel-art": {
//         ignored: false,              // true = 被忽略（永久关闭，可还原）
//         tools: {
//           "render_pixel_art": true,  // false = 该工具在 Kaz 工具面关闭
//           "convert_image_to_pixel_art": true
//         }
//       }
//     }
//   }
// 新检测到但未在任何层登记的插件/工具，按“默认开启”处理（flatten 时补入）。
// ---------------------------------------------------------------------------

/** 外置工具插件状态文件版本。 */
export const EXTERNAL_TOOL_PLUGIN_STATE_VERSION = 1;

/**
 * 统一工具插件出厂默认（factory）：官方工具也改用“插件分组”格式管理，
 * 不再写入 settings.yaml 的 kaz-mode.toolWhitelist。
 * 分组名 = 插件 fiber.name（tool-fs / tool-pwsh / ... / kaz-memory / kaz-diag）。
 * 只包含当前 Kaz 默认白名单里的工具；未列入的官方工具（read_image、
 * str_replace_editor、subagent 等）默认不出现，之后可由用户在面板/JSON 添加。
 */
export const TOOL_PLUGIN_FACTORY = {
  version: EXTERNAL_TOOL_PLUGIN_STATE_VERSION,
  plugins: {
    "tool-pwsh": { ignored: false, tools: { pwsh: true } },
    "tool-fs": {
      ignored: false,
      tools: { read: true, write: true, edit: true },
    },
    "tool-fs-search": {
      ignored: false,
      tools: { glob: true, grep: true },
    },
    "tool-jobs": {
      ignored: false,
      tools: { job_list: true, job_output: true, job_kill: true },
    },
    "tool-ask-user": {
      ignored: false,
      tools: { ask_user_question: true },
    },
    "tool-todo": {
      ignored: false,
      tools: { todo_write: true },
    },
    "tool-web": {
      ignored: false,
      tools: { web_search: true },
    },
    "kaz-memory": {
      ignored: false,
      tools: {
        memory_save: true,
        memory_update: true,
        memory_list: true,
        memory_search: true,
        memory_detail: true,
        memory_forget: true,
      },
    },
    "kaz-diag": {
      ignored: false,
      tools: { kaz_mode_status: true },
    },
  },
};

/** 官方 / Kaz 插件分类目录（源码修改点，见 tool-plugin-catalog.js）。 */
export { OFFICIAL_TOOL_PLUGIN_KEYS, KAZ_TOOL_PLUGIN_KEYS, OFFICIAL_TOOL_NAMES } from "./tool-plugin-catalog.js";

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
      plugins[key] = {
        ignored: item.ignored === true,
        tools,
        hiddenTools,
      };
    }
  }
  return { version: EXTERNAL_TOOL_PLUGIN_STATE_VERSION, plugins };
}

/**
 * 合并多层外置工具插件状态（顺序 = 优先级，后层覆盖前层）：
 *   factory → user → project
 * 插件级和工具级都做浅合并：高层显式写 false 会覆盖低层的 true，
 * 高层没写的键继承低层。
 */
export function mergeExternalToolPluginStates(...states) {
  const out = emptyExternalToolPluginState();
  for (const state of states) {
    const normalized = normalizeExternalToolPluginState(state);
    for (const [key, plugin] of Object.entries(normalized.plugins)) {
      const target = out.plugins[key] ?? { ignored: false, tools: {}, hiddenTools: {} };
      target.ignored = plugin.ignored;
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
  const plugin = next.plugins[key] ?? { ignored: false, tools: {}, hiddenTools: {} };
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
  const plugin = next.plugins[key] ?? { ignored: false, tools: {}, hiddenTools: {} };
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
  const plugin = next.plugins[key] ?? { ignored: false, tools: {}, hiddenTools: {} };
  plugin.ignored = ignored === true;
  next.plugins[key] = plugin;
  return next;
}

/**
 * 还原某个外置插件：取消忽略，清除全部工具隐藏标记，并把该插件已登记的
 * 所有工具设为开启（用户确认的语义：还原 = 默认全部开启）。
 */
export function restoreExternalPlugin(state, pluginName) {
  const next = normalizeExternalToolPluginState(state);
  const key = normalizeExternalKey(pluginName);
  if (key.length === 0) return next;
  const plugin = next.plugins[key] ?? { ignored: false, tools: {}, hiddenTools: {} };
  plugin.ignored = false;
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
 *   - 已显式登记的工具：true 出现、false 不出现；
 *   - 检测到但未显式登记的工具（新工具/新插件）→ 默认开启（补入集合）。
 */
export function flattenEnabledExternalTools(effectiveState, detected = {}) {
  const state = normalizeExternalToolPluginState(effectiveState);
  const out = new Set();

  // ① 显式登记的工具
  for (const [key, plugin] of Object.entries(state.plugins)) {
    if (plugin.ignored === true) continue;
    for (const [tool, enabled] of Object.entries(plugin.tools)) {
      if (plugin.hiddenTools[tool] === true) continue;
      if (enabled === true) out.add(tool);
    }
  }

  // ② 检测到的工具：没被显式登记的一律默认开启
  for (const [rawKey, tools] of Object.entries(detected)) {
    const key = normalizeExternalKey(rawKey);
    if (key.length === 0) continue;
    const plugin = state.plugins[key];
    if (plugin !== undefined && plugin.ignored === true) continue;
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
