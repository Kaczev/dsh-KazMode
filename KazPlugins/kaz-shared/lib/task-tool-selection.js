// kaz-shared —— 任务分类工具选择：基础面 / 模式限定面 / optional 池 / 目录排版（纯 ESM）
// ===========================================================================
// 第三次升级（任务分类阶段决定工具面）的单一事实源纯函数模块：
//   - BASE_TOOLS          基础工具名（不含 memory；memory 是否进基础面由
//                         baseToolNames({ memoryEnabled }) 表达）；
//   - MODE_SCOPED_TOOLS   模式限定工具（从 tool-auto-on 派生，不在这里硬编码
//                         第二份），它们永不进入 optional 目录；
//   - normalizeOptionalTools         分类 whale_report 传参的清洗；
//   - optionalToolPoolNames          从某 Kaz 面算出“可选池”；
//   - compactOptionalToolDirectory   把 { name, description } 排成一行目录。
// 本文件不依赖 cordis / dsh 服务，供 kaz-mode / ka-whale-workflow / 探针共用。
// ===========================================================================

import {
  MEMORY_READ_TOOLS,
  KAZ_MAINTENANCE_ONLY_TOOLS,
} from "./tool-lists.js";
import {
  PLAN_AUTO_ON_TOOLS,
  GOAL_AUTO_ON_TOOLS,
  TOOL_AUTO_ON_CONFIG,
} from "./tool-auto-on.js";

/** enable_tool：任务内按需点亮 optional 工具的基础工具（由 ka-whale-workflow 注册）。 */
export const ENABLE_TOOL = "enable_tool";

/** 基础工具面：任何任务（含任务过滤生效后）都常驻的工具名。 */
export const BASE_TOOLS = Object.freeze([
  "ask_user_question",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "pwsh",
  "todo_write",
  "web_search",
  ENABLE_TOOL,
]);

/** 模式限定工具：从 kaz_tool_auto_on 派生，默认仅模式激活/鲸鱼阶段临时放行。 */
export const MODE_SCOPED_TOOLS = Object.freeze([
  ...new Set([
    ...PLAN_AUTO_ON_TOOLS,
    ...GOAL_AUTO_ON_TOOLS,
    ...TOOL_AUTO_ON_CONFIG.whale.tools,
  ]),
]);

/** 基础工具名：kaz-memory 启用时把记忆**读**工具并入基础面；
 *  记忆写工具只进维护子代理白名单（KAZ_MAINTENANCE_ONLY_TOOLS），主线基础面不放行。 */
export function baseToolNames({ memoryEnabled = false } = {}) {
  const names = [...BASE_TOOLS];
  if (memoryEnabled === true) {
    for (const tool of MEMORY_READ_TOOLS) {
      if (!names.includes(tool)) names.push(tool);
    }
  }
  return names;
}

/** 清洗可选工具清单：只保留非空字符串、trim、去重；非数组一律返回 []。 */
export function normalizeOptionalTools(value) {
  const out = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item !== "string") continue;
    const tool = item.trim();
    if (tool.length > 0 && !out.includes(tool)) out.push(tool);
  }
  return out;
}

/** 由 surface（Set/数组）计算可选池：不在基础面、也不在模式限定面的工具名。
 *  记忆写工具只进维护子代理白名单，绝不进入主线可选池（Kaz 5.0 硬边界 7/8）。 */
export function optionalToolPoolNames(surface, { memoryEnabled = false } = {}) {
  const base = new Set(baseToolNames({ memoryEnabled }));
  const scoped = new Set(MODE_SCOPED_TOOLS);
  const maintenance = new Set(KAZ_MAINTENANCE_ONLY_TOOLS);
  const seen = new Set();
  const out = [];
  const list = surface instanceof Set ? [...surface] : Array.isArray(surface) ? surface : [];
  for (const raw of list) {
    if (typeof raw !== "string" || raw.length === 0) continue;
    if (base.has(raw) || scoped.has(raw) || maintenance.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  out.sort();
  return out;
}

/** 把工具目录条目排版成一行式文本（name: one-line description）。
 *  entries: [{ name, description }]。无 schema 描述的工具标注 (no description)。 */
export function compactOptionalToolDirectory(entries) {
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry === null || typeof entry !== "object") continue;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (name.length === 0) continue;
    const rawDescription = typeof entry.description === "string" ? entry.description.trim() : "";
    const oneLine = rawDescription.replace(/\s+/g, " ");
    out.push(name + ": " + (oneLine.length > 0 ? oneLine : "(no description)"));
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Kaz 5.0 可选工具规则（唯一触发点：契约生成 / whale_report({optional_tools})）
//   >6 提醒收敛；>8 拒绝。计数口径 = 任务可选工具数（不含基础面与模式限定面）。
// ---------------------------------------------------------------------------

/** 提醒阈值：可选工具超过 6 个时提醒收敛。 */
export const OPTIONAL_TOOLS_WARN_THRESHOLD = 6;

/** 硬上限：可选工具超过 8 个时拒绝。 */
export const OPTIONAL_TOOLS_MAX = 8;

/** 固定提醒文案模板（保持唯一，避免各插件自说自话）。 */
export const OPTIONAL_TOOLS_WARN_MESSAGE = (count) =>
  `[ka-whale-workflow] optional_tools 提醒：当前 ${count} 个可选工具超过 ${OPTIONAL_TOOLS_WARN_THRESHOLD} 个，请收敛到更少的任务可选工具（硬上限 ${OPTIONAL_TOOLS_MAX}）。`;

/** 固定拒绝文案模板。 */
export const OPTIONAL_TOOLS_REJECT_MESSAGE = (count) =>
  `whale_report rejected: optional_tools 数量为 ${count}，超过硬上限 ${OPTIONAL_TOOLS_MAX}（>6 提醒、>8 拒绝）。请收敛后再提交。`;

/**
 * 校验可选工具数量（纯函数）：
 *  - count <= 6 → { ok: true, count, warn: null, error: null }
 *  - 7 <= count <= 8 → { ok: true, count, warn, error: null }
 *  - count > 8 → { ok: false, count, warn: null, error }
 */
export function validateOptionalToolCount(value) {
  const tools = normalizeOptionalTools(value);
  const count = new Set(tools).size;
  if (count > OPTIONAL_TOOLS_MAX) {
    return { ok: false, count, warn: null, error: OPTIONAL_TOOLS_REJECT_MESSAGE(count) };
  }
  if (count > OPTIONAL_TOOLS_WARN_THRESHOLD) {
    return { ok: true, count, warn: OPTIONAL_TOOLS_WARN_MESSAGE(count), error: null };
  }
  return { ok: true, count, warn: null, error: null };
}
