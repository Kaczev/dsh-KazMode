// kaz-shared —— 整数夹取：把工具入参收进 [min, max]，非数/非有限值回退 fallback。

export function clampInt(value, fallback, min, max) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
