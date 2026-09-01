/**
 * 方向1 巩固/淘汰（consolidate）纯函数模块。
 *
 * 目标：在成本敏感的 Kaz 环境里，用低频 consolidate 把记忆按 value 排序，
 * 用 C/Nmin/τ/idle_window 做 CANDIDATE→ACTIVE 升级、降级，并产出「待淘汰清单」。
 * 本模块不直接改 JSON、不执行 memory_forget：把决策交给调用方/用户确认。
 *
 * 默认参数：C=64/namespace，Nmin=2，τ=0.15，idleWindowDays=30。
 * 公式（可调整）：
 *   value = 0.5*usageScore + 0.3*confidenceScore + 0.2*recencyScore
 *   usageScore = min(usage_count / Nmin, 1)
 *   confidenceScore = {unknown:0, low:0.25, medium:0.5, high:1}
 *   recencyScore = max(0, 1 - ageMs / idleWindowMs)
 *   ageMs = now - lastActivityMs(record)（优先 last_used_at，其次 updated_at）
 */

export const DEFAULT_OPTIONS = {
  C: 64,
  Nmin: 2,
  tau: 0.15,
  idleWindowDays: 30,
};

const CONFIDENCE_SCORE = {
  unknown: 0,
  low: 0.25,
  medium: 0.5,
  high: 1,
};

function timestampMs(value) {
  if (typeof value === 'string' && value.length > 0) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return 0;
}

export function lastActivityMs(record) {
  const direct = timestampMs(record?.last_used_at);
  if (direct > 0) return direct;
  const updated = timestampMs(record?.updated_at) || timestampMs(record?.updatedAt);
  return updated > 0 ? updated : Date.now();
}

export function confidenceScoreOf(confidence) {
  return CONFIDENCE_SCORE[confidence] ?? 0;
}

export function computeValue(record, opts = {}) {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  const now = typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now();
  const idleMs = Math.max(1, options.idleWindowDays) * 24 * 3600 * 1000;
  const usageCount = Number.isFinite(Number(record?.usage_count)) ? Math.max(0, Number(record?.usage_count)) : 0;
  const usageScore = Math.min(usageCount / Math.max(1, options.Nmin), 1);
  const confidenceScore = confidenceScoreOf(record?.confidence);
  const ageMs = Math.max(0, now - lastActivityMs(record));
  const recencyScore = idleMs > 0 ? Math.max(0, 1 - ageMs / idleMs) : 0;
  const value = 0.5 * usageScore + 0.3 * confidenceScore + 0.2 * recencyScore;
  return Number(value.toFixed(4));
}

export function lifecycleAction(record, opts = {}) {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  const value = computeValue(record, options);
  const status = String(record?.lifecycle_status ?? 'UNKNOWN').toUpperCase();
  const usageCount = Number.isFinite(Number(record?.usage_count)) ? Math.max(0, Number(record?.usage_count)) : 0;
  const idleMs = Math.max(1, options.idleWindowDays) * 24 * 3600 * 1000;
  const ageMs = Math.max(0, (typeof options.now === 'number' ? options.now : Date.now()) - lastActivityMs(record));
  const idleExpired = ageMs > idleMs;

  if (status === 'UNKNOWN') {
    return { value, action: 'MIGRATE_UNKNOWN' };
  }
  if (status === 'CANDIDATE') {
    if (usageCount >= options.Nmin && value >= options.tau) return { value, action: 'UPGRADE_TO_ACTIVE' };
    if (idleExpired && value < options.tau) return { value, action: 'DEPRECATE_CANDIDATE' };
    return { value, action: 'KEEP_CANDIDATE' };
  }
  if (status === 'ACTIVE') {
    if (value < options.tau && idleExpired) return { value, action: 'DEPRECATE_ACTIVE' };
    if (value < options.tau) return { value, action: 'DOWNGRADE_TO_CANDIDATE' };
    return { value, action: 'KEEP_ACTIVE' };
  }
  if (status === 'DEPRECATED') {
    return { value, action: 'ALREADY_DEPRECATED' };
  }
  return { value, action: 'MIGRATE_UNKNOWN' };
}

/** 生成待淘汰候选：低价值 + 闲置超时；以及超容量时最低价值的 ACTIVE。 */
export function buildDeprecateCandidates(records, opts = {}) {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  const now = typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now();
  const idleMs = Math.max(1, options.idleWindowDays) * 24 * 3600 * 1000;
  const candidates = [];
  const activeOrCandidate = records.filter((rec) => {
    const status = String(rec?.lifecycle_status ?? 'UNKNOWN').toUpperCase();
    return status === 'ACTIVE' || status === 'CANDIDATE' || status === 'UNKNOWN';
  });
  for (const rec of activeOrCandidate) {
    const value = computeValue(rec, options);
    const status = String(rec?.lifecycle_status ?? 'UNKNOWN').toUpperCase();
    const ageMs = Math.max(0, now - lastActivityMs(rec));
    const idleExpired = ageMs > idleMs;
    if (value < options.tau && idleExpired) {
      candidates.push({
        id: String(rec.id ?? ''),
        name: rec.name || String(rec.content ?? '').slice(0, 60),
        namespace: rec.namespace ?? 'unknown',
        value,
        lifecycle_status: status,
        usage_count: Number.isFinite(Number(rec?.usage_count)) ? Number(rec.usage_count) : 0,
        last_used_at: rec.last_used_at || '',
        updated_at: rec.updated_at || rec.updatedAt || '',
        reason: '低价值 + 超过 idle_window 未使用',
        suggested_action: 'DEPRECATE',
      });
    }
  }
  // 超容量：每命名空间 ACTIVE 数量 > C 时，取最低价值的超额部分作为候选。
  const byNs = new Map();
  for (const rec of activeOrCandidate) {
    const ns = rec.namespace ?? 'unknown';
    if (!byNs.has(ns)) byNs.set(ns, []);
    byNs.get(ns).push(rec);
  }
  for (const [ns, recs] of byNs) {
    const active = recs.filter((rec) => String(rec?.lifecycle_status ?? '').toUpperCase() === 'ACTIVE');
    if (active.length <= options.C) continue;
    const sorted = active
      .map((rec) => ({ rec, value: computeValue(rec, options) }))
      .sort((a, b) => a.value - b.value);
    const excess = sorted.slice(0, active.length - options.C);
    for (const { rec, value } of excess) {
      candidates.push({
        id: String(rec.id ?? ''),
        name: rec.name || String(rec.content ?? '').slice(0, 60),
        namespace: ns,
        value,
        lifecycle_status: 'ACTIVE',
        usage_count: Number.isFinite(Number(rec?.usage_count)) ? Number(rec.usage_count) : 0,
        last_used_at: rec.last_used_at || '',
        updated_at: rec.updated_at || rec.updatedAt || '',
        reason: '超过容量 C，value 最低',
        suggested_action: 'REVIEW',
      });
    }
  }
  return candidates;
}

/** 按 consolidate 结果生成建议的 lifecycle_status 变更（不落盘）。 */
export function suggestedLifecycle(record, opts = {}) {
  const { action, value } = lifecycleAction(record, opts);
  if (action === 'UPGRADE_TO_ACTIVE') return { lifecycle_status: 'ACTIVE', value, action };
  if (action === 'DOWNGRADE_TO_CANDIDATE') return { lifecycle_status: 'CANDIDATE', value, action };
  if (action === 'DEPRECATE_CANDIDATE' || action === 'DEPRECATE_ACTIVE') return { lifecycle_status: 'DEPRECATED', value, action };
  return { lifecycle_status: record?.lifecycle_status ?? 'UNKNOWN', value, action };
}
