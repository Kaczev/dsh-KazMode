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

/** PM3-uncalibrated provisional S 档预算（§2.4/§A.2）。
 *  PM3 实测前 N/M 未定稿：这里是显式占位常量，不内联魔法数字；
 *  生产默认 flag off，探针用内部 config.sTierBudget 覆盖测试路径。 */
export const PROVISIONAL_S_TIER_BUDGET = Object.freeze({
  modelRequests: 100,
  turns: 12,
});

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

/** 归一化 session S 误判历史：只保留 "S" 记号，最多最近 2 次。 */
export function normalizeSMisjudgmentHistory(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (entry !== "S") continue;
    out.push("S");
  }
  return out.slice(-2);
}

/** S 档是否超预算（§2.4 规则 4；budget 默认 PM3 占位常量）。 */
export function tierBudgetExceeded(metrics = {}, budget = PROVISIONAL_S_TIER_BUDGET) {
  const meter = metrics !== null && typeof metrics === "object" ? metrics : {};
  const requestLimit = Number(budget?.modelRequests);
  const turnLimit = Number(budget?.turns);
  const requests = Number(meter.modelRequests);
  const turns = Number(meter.turns);
  if (Number.isFinite(requestLimit) && Number.isFinite(requests) && requests >= requestLimit) {
    return true;
  }
  if (Number.isFinite(turnLimit) && Number.isFinite(turns) && turns >= turnLimit) {
    return true;
  }
  return false;
}

/** 两个 tier 是否允许 from → to（只升不降；同一 tier 不算升级但允许保持）。 */
export function canUpgradeTier(from, to) {
  const fromRank = from === null ? -1 : TIER_ORDER[from];
  const toRank = to === null ? -1 : TIER_ORDER[to];
  if (fromRank === undefined || toRank === undefined || toRank < 0) return false;
  return toRank > fromRank;
}

/**
 * 分类核心（不含 session 默认覆盖）：§2.1/§2.4。
 * S = 恰好 1 个 changed file + 无风险词 + 现成 probe 覆盖 + probe 通过。
 * 任一事实缺失/不可判定或条件不满足 → M（绝不默认 S）。
 */
function classifyCore(facts) {
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

/**
 * 分类契约（§2.1/§2.4/§2.4 规则 4）：输入为机器可判定事实；
 * sessionDefaultTier="M"（连续 S 误判后）强制返回 M。
 */
export function classifyTier(facts = {}, sessionDefaultTier = null) {
  const base = classifyCore(facts);
  if (normalizeTier(sessionDefaultTier) !== "M") return base;
  const signals = base.tierSignals.includes("session-default-m")
    ? base.tierSignals
    : [...base.tierSignals, "session-default-m"];
  return {
    tier: DEFAULT_TIER,
    tierReason: "session 连续 2 次 S 误判后默认 M（可读 API 强制覆盖分类）",
    tierSignals: signals,
  };
}

/**
 * 追加一次 S 误判记录；只保留最近 2 次。
 * wasMisjudgedS=false 表示一次成功的 S run 完成 → 清零连续误判计数。
 */
export function recordSMisjudgment(history, wasMisjudgedS = true) {
  if (wasMisjudgedS !== true) return [];
  const base = normalizeSMisjudgmentHistory(history);
  return [...base, "S"].slice(-2);
}

/** 连续 2 次 S 误判 → session 默认 M；否则不改变默认（返回 null）。 */
export function sessionDefaultTierAfterMisjudgments(history) {
  const recent = Array.isArray(history) ? history : [];
  return recent.length >= 2 && recent.slice(-2).every((entry) => entry === "S")
    ? DEFAULT_TIER
    : null;
}
