// kaz-shared —— Kaz7.0 M0 上下文压缩：结构与测量纯模块（纯 ESM，零 I/O，无运行时接线）
// ===========================================================================
// 依据：不入库文件/Kaz7.0更新规划/最终基准 描述 Kaz7.0 上下文压缩.md（权威最终基准 v1.2）
// 职责（只做常量/归一化/分类/判据，绝不读写文件、不注册 cordis、不注入请求）：
//   * 升华阈值、渲染顺序、cache 可用性矩阵（A/B/C/D）；
//   * 原生 1M 窗口兜底策略（渲染窗口 hiddenRootIds 跳过最老根节点：
//     不删除、不归档移动，whale_expand 可读；非 token 预算）；
//   * H_full / H_read_proxy / R 压缩降幅等事后测量纯函数。
// 不设项：本模块不设 MC_trigger / MC_emergency / MC_expand / RawTailBudget /
// OuterResidentBudget 等任何 token 触发或保留预算常量/函数。
// ===========================================================================

/** 冻结默认升华阈值：同层 ≥4 个兄弟触发父层摘要（v1.2 §5）。N 是结构数量阈值，不是 token 预算。 */
export const SUBLIMATION_THRESHOLD = 4;

/**
 * v1.2 §4.3 常驻内容渲染顺序（硬性）。
 * 1) 高层块在前、低层块在后；同级块按时间老 → 新；
 * 2) 当前未闭合原信息在最后；
 * 3) 渲染格式/字段名/顺序/标记稳定。
 * 本常量是将来树形渲染器与 renderOrderValid 的共同基准。
 */
export const KAZ_CONTEXT_RENDER_ORDER = Object.freeze([
  "outermost-blocks", // 高层 → 低层；同级按老 → 新
  "current-unclosed-raw", // 始终最后
]);

/** v1.2 §8.2 cache 可用性矩阵（硬门禁只对 A 类成立）。 */
export const KAZ_CONTEXT_CACHE_SCENARIOS = Object.freeze({
  A: Object.freeze({
    id: "A",
    uncached: true,
    cacheRead: true,
    cacheWrite: true,
    measurement: "h-full",
    hardGate: true,
    note: "完整字段：H_full 可作 ≥90% 硬门禁",
  }),
  B: Object.freeze({
    id: "B",
    uncached: true,
    cacheRead: true,
    cacheWrite: false,
    measurement: "h-read-proxy",
    hardGate: false,
    note: "DeepSeek 等无 cacheWrite：H_read_proxy 只作代理/趋势",
  }),
  C: Object.freeze({
    id: "C",
    uncached: true,
    cacheRead: false,
    cacheWrite: false,
    measurement: "cache_unmeasurable",
    hardGate: false,
    note: "无 cacheRead：显式 cache_unmeasurable",
  }),
  D: Object.freeze({
    id: "D",
    uncached: false,
    cacheRead: false,
    cacheWrite: false,
    measurement: "cache_unmeasurable",
    hardGate: false,
    note: "无 usage：显式 cache_unmeasurable",
  }),
});

/**
 * v1.2 §6.2 原生 1M 窗口兜底策略（极端意外情形）。
 * 策略只描述“渲染窗口 hiddenRootIds 跳过最老根节点，直到显著低于原生窗口”；
 * 不删除、不归档移动；被跳过的根节点及其子树仍完整保留在 session-tree/store，
 * whale_expand 仍可按 path/id 访问。不冻结任何 MC/token 触发值或常驻保留预算。
 */
export const KAZ_CONTEXT_NATIVE_FALLBACK_STRATEGY = Object.freeze({
  id: "hidden-root-ids-render-window-skip",
  trigger: "active-tree-or-resident-content-approaches-native-window",
  target: "oldest-render-visible-root-closed-block",
  action: "skip-in-render-window-via-hiddenRootIds",
  windowField: "hiddenRootIds",
  retainsSessionTree: true,
  whaleExpandReadable: true,
  boundaryType: "planned-invalidation",
  recordRequired: true,
});

/** 场景别名：只收容明确含义，不扩展 token/预算语义。 */
const CACHE_SCENARIO_ALIASES = {
  a: "A",
  b: "B",
  c: "C",
  d: "D",
  "full-fields": "A",
  "full": "A",
  "deepseek": "B",
  "no-cache-write": "B",
  "no-cache-read": "C",
  "no-usage": "D",
};

function scenarioFromValue(value) {
  if (typeof value === "string") {
    const key = value.trim().toLowerCase();
    return CACHE_SCENARIO_ALIASES[key] ?? (/^[abcd]$/.test(key) ? key.toUpperCase() : "");
  }
  if (value !== null && typeof value === "object") {
    const id = value?.id ?? value?.scenario ?? value?.key;
    if (typeof id === "string") return scenarioFromValue(id);
  }
  return "";
}

/** 归一化 cache 可用性场景：返回 "A" | "B" | "C" | "D"；无法识别返回空串。 */
export function normalizeCacheScenario(value) {
  return scenarioFromValue(value);
}

function usageFieldPresent(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isNaN(value)) return false;
  return true;
}

/**
 * 按 usage 字段可用性分类到 A/B/C/D（v1.2 §8.2）。
 * 字段可为布尔（是否可用）；数值视为字段已出现（含 0）。无法归入矩阵返回空串。
 */
export function classifyCacheScenario(usage = {}) {
  const value = usage !== null && typeof usage === "object" ? usage : {};
  const uncached = usageFieldPresent(value.uncached);
  const cacheRead = usageFieldPresent(value.cacheRead);
  const cacheWrite = usageFieldPresent(value.cacheWrite);
  if (uncached && cacheRead && cacheWrite) return "A";
  if (uncached && cacheRead && !cacheWrite) return "B";
  if (uncached && !cacheRead && !cacheWrite) return "C";
  if (!uncached && !cacheRead && !cacheWrite) return "D";
  return "";
}

/** 场景 → 测量口径：A=h-full；B=h-read-proxy；C/D=cache_unmeasurable。 */
export function cacheMeasurementMode(scenario) {
  const id = normalizeCacheScenario(scenario);
  if (id.length === 0) return "";
  return KAZ_CONTEXT_CACHE_SCENARIOS[id].measurement;
}

function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * H_full = cacheRead / (uncached + cacheRead + cacheWrite)（v1.2 §8.1）。
 * 仅当三个字段都为非负有限数且分母 >0 时返回数值，否则 null（不可测/误用保护）。
 */
export function hFull({ uncached, cacheRead, cacheWrite } = {}) {
  const u = nonNegativeNumber(uncached);
  const r = nonNegativeNumber(cacheRead);
  const w = nonNegativeNumber(cacheWrite);
  if (u === null || r === null || w === null) return null;
  const total = u + r + w;
  return total > 0 ? r / total : null;
}

/**
 * H_read_proxy = cacheRead / (uncached + cacheRead)（v1.2 §8.1，B 类降级代理）。
 * cacheWrite 不应参与本代理口径；两字段非法/分母为 0 返回 null。
 */
export function hReadProxy({ uncached, cacheRead } = {}) {
  const u = nonNegativeNumber(uncached);
  const r = nonNegativeNumber(cacheRead);
  if (u === null || r === null) return null;
  const total = u + r;
  return total > 0 ? r / total : null;
}

function toFiniteNumber(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * v1.2 §10 C2 压缩效率判据（只作事后验收，不是触发/预算）：
 *   R = 1 - compressedTokens / originalTokens；
 *   span ≥ 16K 时要求 R ≥ 0.90 且替换描述 ≤ 1500；span ≥ 32K 时要求 R ≥ 0.95 且替换描述 ≤ 1500；
 * 输入无法度量时返回 false。span < 16K 时 C2 判据不适用，返回 true。
 */
export function compressionRatioPass({
  originalTokens,
  compressedTokens,
  spanTokens,
  span,
  replacementTokens,
  replacement,
} = {}) {
  const original = nonNegativeNumber(originalTokens);
  const compressed = nonNegativeNumber(compressedTokens);
  if (original === null || compressed === null || original <= 0) return false;
  const spanValue = toFiniteNumber(spanTokens, toFiniteNumber(span, 0));
  const replacementValue = toFiniteNumber(replacementTokens, toFiniteNumber(replacement, 0));
  const ratio = 1 - compressed / original;
  if (spanValue >= 32000) return ratio >= 0.95 && replacementValue <= 1500;
  if (spanValue >= 16000) return ratio >= 0.9 && replacementValue <= 1500;
  return true;
}

function isRawEntry(entry) {
  if (entry === null || typeof entry !== "object") return false;
  const kind = typeof entry.kind === "string" ? entry.kind : "";
  return (
    entry.raw === true ||
    kind === "raw" ||
    kind === "current-unclosed-raw" ||
    entry.level === 0 ||
    entry.level === "0"
  );
}

function entryLevel(entry) {
  const level = entry?.level;
  if (typeof level === "number" && Number.isInteger(level)) return level;
  if (typeof level === "string" && /^\d+$/.test(level)) return Number(level);
  return null;
}

/**
 * v1.2 §4.3 渲染顺序判据。
 * @param rendered 渲染后的节点数组；每项形如
 *   { kind: "block"|"raw"|"current-unclosed-raw", level, seq?/order? }
 *   块 = level>0；当前未闭合原信息 = raw/level 0。
 * 校验：块全部在前且 level 高层 → 低层（不递增）；同层 seq/order 存在时老 → 新；
 * 原信息全部在最后。空数组视为合法。
 */
export function renderOrderValid(rendered) {
  if (!Array.isArray(rendered)) return false;
  let rawPhase = false;
  let lastBlockLevel = null;
  const lastSeqByLevel = new Map();
  for (const entry of rendered) {
    if (entry === null || typeof entry !== "object") return false;
    const raw = isRawEntry(entry);
    if (raw) {
      rawPhase = true;
      continue;
    }
    if (rawPhase) return false; // 块出现在原信息之后
    const level = entryLevel(entry);
    if (level === null || level <= 0) return false;
    if (lastBlockLevel !== null && level > lastBlockLevel) return false; // 高层必须在前
    lastBlockLevel = level;
    const seq = entry.seq ?? entry.order;
    const previous = lastSeqByLevel.get(level);
    if (
      typeof seq === "number" &&
      typeof previous === "number" &&
      seq < previous
    ) {
      return false; // 同层必须老 → 新
    }
    if (typeof seq === "number") lastSeqByLevel.set(level, seq);
  }
  return true;
}
