// kaz-shared 探针：Kaz7.0 M0 上下文压缩结构与测量纯模块（lib/context-compress.js）。
// 覆盖：
//   - 升华阈值 / 渲染顺序 / cache 可用性矩阵 / 原生 1M 兜底策略常量；
//   - normalize/classify/cacheMeasurementMode、hFull/hReadProxy、
//     compressionRatioPass、renderOrderValid 的代表性纯行为；
//   - 已删除的 token 触发 / 保留预算导出不存在（直接模块与 tool-lists 公共出口都检查）。
// 运行：node KazPlugins/kaz-shared/probe-context-compress.mjs
import {
  SUBLIMATION_THRESHOLD,
  KAZ_CONTEXT_RENDER_ORDER,
  KAZ_CONTEXT_CACHE_SCENARIOS,
  KAZ_CONTEXT_NATIVE_FALLBACK_STRATEGY,
  normalizeCacheScenario,
  classifyCacheScenario,
  cacheMeasurementMode,
  hFull,
  hReadProxy,
  compressionRatioPass,
  renderOrderValid,
} from "./lib/context-compress.js";

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

// ---------- ① 冻结常量与“结构阈值不是 token 预算”语义 ----------
check("① SUBLIMATION_THRESHOLD = 4", SUBLIMATION_THRESHOLD === 4);
check(
  "① KAZ_CONTEXT_RENDER_ORDER 冻结且两阶段顺序固定",
  Object.isFrozen(KAZ_CONTEXT_RENDER_ORDER) &&
    JSON.stringify(KAZ_CONTEXT_RENDER_ORDER) === JSON.stringify(["outermost-blocks", "current-unclosed-raw"])
);
check(
  "① KAZ_CONTEXT_CACHE_SCENARIOS 冻结且 A/B/C/D 口径正确",
  Object.isFrozen(KAZ_CONTEXT_CACHE_SCENARIOS) &&
    Object.keys(KAZ_CONTEXT_CACHE_SCENARIOS).join(",") === "A,B,C,D" &&
    KAZ_CONTEXT_CACHE_SCENARIOS.A.measurement === "h-full" &&
    KAZ_CONTEXT_CACHE_SCENARIOS.A.hardGate === true &&
    KAZ_CONTEXT_CACHE_SCENARIOS.B.measurement === "h-read-proxy" &&
    KAZ_CONTEXT_CACHE_SCENARIOS.B.hardGate === false &&
    KAZ_CONTEXT_CACHE_SCENARIOS.C.measurement === "cache_unmeasurable" &&
    KAZ_CONTEXT_CACHE_SCENARIOS.D.measurement === "cache_unmeasurable" &&
    ["A", "B", "C", "D"].every((k) => Object.isFrozen(KAZ_CONTEXT_CACHE_SCENARIOS[k]))
);
check(
  "① KAZ_CONTEXT_NATIVE_FALLBACK_STRATEGY 冻结且不含数值预算字段",
  Object.isFrozen(KAZ_CONTEXT_NATIVE_FALLBACK_STRATEGY) &&
    KAZ_CONTEXT_NATIVE_FALLBACK_STRATEGY.id === "archive-nearest-root-outermost-oldest-highest" &&
    KAZ_CONTEXT_NATIVE_FALLBACK_STRATEGY.archiveFirst === true &&
    KAZ_CONTEXT_NATIVE_FALLBACK_STRATEGY.boundaryType === "planned-invalidation" &&
    Object.values(KAZ_CONTEXT_NATIVE_FALLBACK_STRATEGY).every((v) => typeof v !== "number")
);

// ---------- ② cache 场景归一化 / 分类 / 测量口径 ----------
check(
  "② normalizeCacheScenario 别名与对象输入归一化",
  normalizeCacheScenario("A") === "A" &&
    normalizeCacheScenario("a") === "A" &&
    normalizeCacheScenario("full-fields") === "A" &&
    normalizeCacheScenario("deepseek") === "B" &&
    normalizeCacheScenario({ id: "c" }) === "C" &&
    normalizeCacheScenario({ scenario: "no-usage" }) === "D"
);
check(
  "② normalizeCacheScenario 未知/空输入返回空串",
  normalizeCacheScenario("unknown") === "" &&
    normalizeCacheScenario(null) === "" &&
    normalizeCacheScenario(undefined) === "" &&
    normalizeCacheScenario(42) === ""
);
check(
  "② classifyCacheScenario A/B/C/D 与无法归类",
  classifyCacheScenario({ uncached: true, cacheRead: true, cacheWrite: true }) === "A" &&
    classifyCacheScenario({ uncached: true, cacheRead: true, cacheWrite: false }) === "B" &&
    classifyCacheScenario({ uncached: true, cacheRead: false, cacheWrite: false }) === "C" &&
    classifyCacheScenario({ uncached: false, cacheRead: false, cacheWrite: false }) === "D" &&
    classifyCacheScenario({ uncached: true, cacheRead: false, cacheWrite: true }) === ""
);
check(
  "② classifyCacheScenario 数值字段视为出现（含 0）",
  classifyCacheScenario({ uncached: 1, cacheRead: 0, cacheWrite: 0 }) === "A"
);
check(
  "② cacheMeasurementMode 映射 A/B/C/D 与未知",
  cacheMeasurementMode("A") === "h-full" &&
    cacheMeasurementMode("b") === "h-read-proxy" &&
    cacheMeasurementMode("no-cache-read") === "cache_unmeasurable" &&
    cacheMeasurementMode("no-usage") === "cache_unmeasurable" &&
    cacheMeasurementMode("??") === ""
);

// ---------- ③ H_full / H_read_proxy 事后测量 ----------
check(
  "③ hFull 三字段口径与分母",
  hFull({ uncached: 90, cacheRead: 10, cacheWrite: 0 }) === 0.1 &&
    hFull({ uncached: 1, cacheRead: 9, cacheWrite: 0 }) === 0.9 &&
    hFull({ uncached: 0, cacheRead: 0, cacheWrite: 0 }) === null
);
check(
  "③ hFull 非法/缺失字段返回 null",
  hFull({ uncached: -1, cacheRead: 1, cacheWrite: 0 }) === null &&
    hFull({ uncached: 1, cacheRead: 1 }) === null &&
    hFull({ uncached: "1", cacheRead: 1, cacheWrite: 0 }) === null &&
    hFull() === null
);
check(
  "③ hReadProxy 不含 cacheWrite 且分母正确",
  hReadProxy({ uncached: 1, cacheRead: 9, cacheWrite: 999 }) === 0.9 &&
    hReadProxy({ uncached: 1, cacheRead: 0 }) === 0 &&
    hReadProxy({ uncached: 0, cacheRead: 0 }) === null
);
check(
  "③ hReadProxy 非法/缺失字段返回 null",
  hReadProxy({ uncached: -1, cacheRead: 1 }) === null &&
    hReadProxy({ uncached: 1 }) === null &&
    hReadProxy() === null
);

// ---------- ④ compressionRatioPass（只作事后判据，不是触发/预算） ----------
check(
  "④ span<16K 判据不适用即通过；输入不可度量拒绝",
  compressionRatioPass({ originalTokens: 1000, compressedTokens: 900, spanTokens: 1000 }) === true &&
    compressionRatioPass({ originalTokens: undefined }) === false &&
    compressionRatioPass({ originalTokens: 0, compressedTokens: 0 }) === false
);
check(
  "④ span≥16K 需 R≥90% 且替换描述 ≤1500",
  compressionRatioPass({ originalTokens: 1000, compressedTokens: 100, spanTokens: 16000, replacementTokens: 1500 }) === true &&
    compressionRatioPass({ originalTokens: 1000, compressedTokens: 101, spanTokens: 16000 }) === false &&
    compressionRatioPass({ originalTokens: 1000, compressedTokens: 100, spanTokens: 16000, replacementTokens: 1501 }) === false
);
check(
  "④ span≥32K 需 R≥95% 且替换描述 ≤1500",
  compressionRatioPass({ originalTokens: 1000, compressedTokens: 50, spanTokens: 32000, replacementTokens: 1500 }) === true &&
    compressionRatioPass({ originalTokens: 1000, compressedTokens: 51, spanTokens: 32000 }) === false &&
    compressionRatioPass({ originalTokens: 1000, compressedTokens: 50, spanTokens: 32000, replacementTokens: 1501 }) === false
);
check(
  "④ spanTokens 优先于 span 兜底字段",
  compressionRatioPass({ originalTokens: 1000, compressedTokens: 50, spanTokens: 33000, span: 16000 }) === true &&
    compressionRatioPass({ originalTokens: 1000, compressedTokens: 51, spanTokens: 33000, span: 16000 }) === false &&
    compressionRatioPass({ originalTokens: 1000, compressedTokens: 100, span: 16000 }) === true
);

// ---------- ⑤ renderOrderValid ----------
check(
  "⑤ 高层块在前、当前未闭合原信息在最后为合法",
  renderOrderValid([
    { kind: "block", level: 3, seq: 1 },
    { kind: "block", level: 2, seq: 1 },
    { kind: "block", level: 1, seq: 1 },
    { kind: "current-unclosed-raw", level: 0, seq: 2 },
  ]) === true && renderOrderValid([]) === true
);
check(
  "⑤ 原信息后出现块 / 同层倒序 / 层级递增都拒绝",
  renderOrderValid([
    { kind: "current-unclosed-raw", level: 0 },
    { kind: "block", level: 1 },
  ]) === false &&
    renderOrderValid([
      { kind: "block", level: 2, seq: 2 },
      { kind: "block", level: 2, seq: 1 },
    ]) === false &&
    renderOrderValid([
      { kind: "block", level: 1 },
      { kind: "block", level: 2 },
    ]) === false
);
check(
  "⑤ 非数组 / 非对象 / 非法 level 拒绝；level 0 按当前未闭合原信息收容",
  renderOrderValid(null) === false &&
    renderOrderValid([{ kind: "block", level: -1 }]) === false &&
    renderOrderValid([null]) === false &&
    renderOrderValid([{ kind: "block" }]) === false &&
    renderOrderValid([{ kind: "raw", level: 0 }]) === true
);

// ---------- ⑥ 已删除预算 / token 触发导出不存在 ----------
const DELETED_BUDGET_EXPORTS = [
  "MC_trigger",
  "MC_emergency",
  "MC_expand",
  "RawTailBudget",
  "OuterResidentBudget",
];
const directNs = await import("./lib/context-compress.js");
const publicNs = await import("./lib/tool-lists.js");
check(
  "⑥ context-compress 直接命名空间不含已删除 token 触发/保留预算导出",
  DELETED_BUDGET_EXPORTS.every((name) => !Object.prototype.hasOwnProperty.call(directNs, name))
);
check(
  "⑥ tool-lists 公共命名空间不含已删除 token 触发/保留预算导出",
  DELETED_BUDGET_EXPORTS.every((name) => !Object.prototype.hasOwnProperty.call(publicNs, name))
);
check(
  "⑥ 当前 context-compress 全部预期导出仍在直接命名空间",
  [
    "SUBLIMATION_THRESHOLD",
    "KAZ_CONTEXT_RENDER_ORDER",
    "KAZ_CONTEXT_CACHE_SCENARIOS",
    "KAZ_CONTEXT_NATIVE_FALLBACK_STRATEGY",
    "normalizeCacheScenario",
    "classifyCacheScenario",
    "cacheMeasurementMode",
    "hFull",
    "hReadProxy",
    "compressionRatioPass",
    "renderOrderValid",
  ].every((name) => Object.prototype.hasOwnProperty.call(directNs, name))
);
check(
  "⑥ 当前 context-compress 预期导出经 tool-lists 公共出口可用",
  [
    "SUBLIMATION_THRESHOLD",
    "KAZ_CONTEXT_RENDER_ORDER",
    "KAZ_CONTEXT_CACHE_SCENARIOS",
    "KAZ_CONTEXT_NATIVE_FALLBACK_STRATEGY",
    "normalizeCacheScenario",
    "classifyCacheScenario",
    "cacheMeasurementMode",
    "hFull",
    "hReadProxy",
    "compressionRatioPass",
    "renderOrderValid",
  ].every((name) => Object.prototype.hasOwnProperty.call(publicNs, name))
);

if (failures === 0) {
  console.log("\nCONTEXT-COMPRESS PROBE OK");
  process.exit(0);
} else {
  console.error(`\nCONTEXT-COMPRESS PROBE FAILED: ${failures}`);
  process.exit(1);
}
