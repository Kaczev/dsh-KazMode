// ka-whale-workflow —— 7.4 P1 tier 纯契约（S/M/L；无 I/O、无依赖）
// ===========================================================================
// - 分类默认 M；S 必须同时满足四个机器可判定条件，任一不可判定 → M；
// - tierSignals 记录可核对事实，不能只写“简单”；
// - 连续 2 次 S 误判后该 session 默认 M；
// - 同 run 内只升不降（降级需父主显式批准）。
// ===========================================================================

/** 合法 tier id（声明顺序 = 由低到高成本）。 */
export const TIER_IDS = Object.freeze(["S", "M", "L"]);

/** 分类默认值：M。 */
export const DEFAULT_TIER = "M";

/** tier 成本序（用于只升不降；S 最轻，L 最重）。 */
const TIER_ORDER = Object.freeze({ S: 0, M: 1, L: 2 });

/** 归一化 tier；未知/null 返回 null（调用方按“无显式 tier = 静态 7.3.5 行为”）。 */
export function normalizeTier(value) {
  return TIER_IDS.includes(value) ? value : null;
}

/** 归一化 tierSignals：只保留非空字符串、去重；未知输入返回 []。 */
export function normalizeTierSignals(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const signal of value) {
    if (typeof signal !== "string") continue;
    const trimmed = signal.trim();
    if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/** 归一化 upgradeHistory：只保留形状正确的 {from,to,trigger,at}。 */
export function normalizeUpgradeHistory(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const from = normalizeTier(entry.from);
    const to = normalizeTier(entry.to);
    if (from === null || to === null) continue;
    out.push({
      from,
      to,
      trigger:
        typeof entry.trigger === "string" && entry.trigger.trim().length > 0
          ? entry.trigger.trim()
          : "unknown",
      at: typeof entry.at === "string" && entry.at.trim().length > 0 ? entry.at : "",
    });
  }
  return out;
}

/** 两个 tier 是否允许 from → to（只升不降；同一 tier 不算升级但允许保持）。 */
export function canUpgradeTier(from, to) {
  const fromRank = from === null ? -1 : TIER_ORDER[from];
  const toRank = to === null ? -1 : TIER_ORDER[to];
  if (fromRank === undefined || toRank === undefined || toRank < 0) return false;
  return toRank > fromRank;
}

/**
 * 分类契约（§2.1/§2.4）：输入为机器可判定事实；输出 { tier, tierReason, tierSignals }。
 * S = 恰好 1 个 changed file + 无风险词 + 现成 probe 覆盖 + probe 通过。
 * 任一事实缺失/不可判定或条件不满足 → M（绝不默认 S）。
 */
export function classifyTier(facts = {}) {
  const source = facts !== null && typeof facts === "object" ? facts : {};
  const changedFileCount = Number.isSafeInteger(source.changedFileCount)
    ? source.changedFileCount
    : null;
  const riskWordHit = typeof source.riskWordHit === "boolean" ? source.riskWordHit : null;
  const probeCovers = typeof source.probeCovers === "boolean" ? source.probeCovers : null;
  const probePasses = typeof source.probePasses === "boolean" ? source.probePasses : null;
  const canBeS =
    changedFileCount === 1 &&
    riskWordHit === false &&
    probeCovers === true &&
    probePasses === true;
  if (canBeS) {
    return {
      tier: "S",
      tierReason:
        "恰好 1 个 changed file；无风险词；存在覆盖该文件的现成 probe 且当前通过",
      tierSignals: ["single-file", "no-risk-word", "existing-probe", "probe-pass"],
    };
  }
  const signals = [];
  if (changedFileCount !== null && changedFileCount !== 1) signals.push("not-single-file");
  if (riskWordHit === true) signals.push("risk-word-hit");
  if (probeCovers === false) signals.push("no-existing-probe");
  if (probePasses === false) signals.push("probe-not-passing");
  if (signals.length === 0) signals.push("undecidable-default-m");
  return {
    tier: DEFAULT_TIER,
    tierReason: "分类默认 M：S 四条件未能同时机器可判定为真",
    tierSignals: signals,
  };
}

/** 追加一次 S 误判记录；只保留最近 2 次（用于连续误判默认 M）。 */
export function recordSMisjudgment(history, wasMisjudgedS = true) {
  const base = Array.isArray(history)
    ? history.filter((entry) => entry === "S")
    : [];
  if (wasMisjudgedS !== true) return base.slice(-2);
  return [...base, "S"].slice(-2);
}

/** 连续 2 次 S 误判 → session 默认 M；否则不改变默认（返回 null）。 */
export function sessionDefaultTierAfterMisjudgments(history) {
  const recent = Array.isArray(history) ? history : [];
  return recent.length >= 2 && recent.slice(-2).every((entry) => entry === "S")
    ? DEFAULT_TIER
    : null;
}
