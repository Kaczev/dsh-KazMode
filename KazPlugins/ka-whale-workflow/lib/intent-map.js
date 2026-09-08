// ka-whale-workflow —— 7.4 P2 Intent Map 纯归一化/校验（纯 ESM）
// ===========================================================================
// §8.1 run 级 intentMap 字段；R-f/D21：discriminatingSignal 必填且非空。
// 规则：
//   - 结构非法（根不是对象 / 未知键 / 字段类型错 / confidence 枚举错）
//     → validateIntentMapInput 返回 intent-map-invalid，调用方不落盘。
//   - 结构合法但 discriminatingSignal 缺失/空白/非字符串 → 不拒绝；
//     normalizeIntentMap 强制 confidence:"low" + requiresUserConfirmation:true，
//     并在 normalized 里记 "discriminating-signal-missing"。
//   - §8.4 prompt-defect pass：纯确定性、只响应 defects 中命中的已知信号，
//     绝不无条件运行、不代模型推断文字内容。
// 本文件不依赖 cordis / dsh 服务，供 task-plan-store / stage-store / 探针共用。
// ===========================================================================

/** 允许的 confidence 枚举（§8.1）。 */
export const INTENT_MAP_CONFIDENCES = Object.freeze(["high", "medium", "low"]);

/** §8.4 已知 prompt 缺陷类型。 */
export const INTENT_DEFECT_TYPES = Object.freeze([
  "missing-acceptance",
  "ambiguous-scope",
  "contradictory",
  "counter-intuitive",
  "aesthetic-messy",
  "incomplete",
]);

/** Intent Map 顶层字段白名单（§8.1）。 */
const INTENT_MAP_KEYS = new Set([
  "goal",
  "trueGoal",
  "inferredFrom",
  "defects",
  "assumptions",
  "confidence",
  "requiresUserConfirmation",
  "discriminatingSignal",
  "acceptanceSignals",
  "normalized",
]);

/** 归一化 string[]：只保留非空 string，去重、保序。 */
function normalizeStringList(value) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (text.length === 0 || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/** 归一化可选 string：非 string 视为空串。 */
function optionalString(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** 归一化 defects：只保留 { type, quote?, action? } 形状的对象（type 非空）。 */
function normalizeDefects(value) {
  const out = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const type = typeof entry.type === "string" ? entry.type.trim() : "";
    if (type.length === 0) continue;
    const defect = { type };
    if (typeof entry.quote === "string" && entry.quote.trim().length > 0) {
      defect.quote = entry.quote.trim();
    }
    if (typeof entry.action === "string" && entry.action.trim().length > 0) {
      defect.action = entry.action.trim();
    }
    out.push(defect);
  }
  return out;
}

/** 归一化 evidenceChecklist（run 记录/§3.2 形状；P2 只做容器与字段保留）。 */
export function normalizeEvidenceChecklist(value) {
  const out = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const normalized = {
      id: optionalString(entry.id),
      kind: optionalString(entry.kind),
      command: optionalString(entry.command),
      expected: optionalString(entry.expected),
      actualTail: optionalString(entry.actualTail),
      status:
        entry.status === "met" || entry.status === "unmet" || entry.status === "waived"
          ? entry.status
          : "unmet",
      at: optionalString(entry.at),
    };
    if (entry.mainRerun !== null && entry.mainRerun !== undefined && typeof entry.mainRerun === "object") {
      normalized.mainRerun = {
        command: optionalString(entry.mainRerun.command),
        actualTail: optionalString(entry.mainRerun.actualTail),
        matches: entry.mainRerun.matches === true,
      };
    } else {
      normalized.mainRerun = null;
    }
    out.push(normalized);
  }
  return out;
}

/**
 * 校验用户提供的 intentMap（结构层）。missing discriminatingSignal 不算结构错；
 * 返回 { ok:false, code:"intent-map-invalid", reason } 或 { ok:true }。
 */
export function validateIntentMapInput(raw) {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "intent-map-invalid", reason: "intentMap must be an object." };
  }
  const unknownKeys = Object.keys(raw).filter((key) => !INTENT_MAP_KEYS.has(key));
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      code: "intent-map-invalid",
      reason: `intentMap has unsupported keys: ${unknownKeys.join(", ")}.`,
    };
  }
  for (const key of ["goal", "trueGoal", "discriminatingSignal"]) {
    if (raw[key] !== undefined && raw[key] !== null && typeof raw[key] !== "string") {
      return {
        ok: false,
        code: "intent-map-invalid",
        reason: `intentMap.${key} must be a string when present.`,
      };
    }
  }
  for (const key of ["inferredFrom", "assumptions", "acceptanceSignals"]) {
    if (
      raw[key] !== undefined &&
      raw[key] !== null &&
      (!Array.isArray(raw[key]) || raw[key].some((entry) => typeof entry !== "string"))
    ) {
      return {
        ok: false,
        code: "intent-map-invalid",
        reason: `intentMap.${key} must be an array of strings when present.`,
      };
    }
  }
  if (raw.confidence !== undefined && raw.confidence !== null) {
    if (typeof raw.confidence !== "string" || !INTENT_MAP_CONFIDENCES.includes(raw.confidence)) {
      return {
        ok: false,
        code: "intent-map-invalid",
        reason: `intentMap.confidence must be one of ${INTENT_MAP_CONFIDENCES.join("/")}.`,
      };
    }
  }
  if (
    raw.requiresUserConfirmation !== undefined &&
    raw.requiresUserConfirmation !== null &&
    typeof raw.requiresUserConfirmation !== "boolean"
  ) {
    return {
      ok: false,
      code: "intent-map-invalid",
      reason: "intentMap.requiresUserConfirmation must be a boolean when present.",
    };
  }
  if (raw.defects !== undefined && raw.defects !== null) {
    if (!Array.isArray(raw.defects)) {
      return { ok: false, code: "intent-map-invalid", reason: "intentMap.defects must be an array when present." };
    }
    for (const entry of raw.defects) {
      if (
        entry === null ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        typeof entry.type !== "string" ||
        entry.type.trim().length === 0
      ) {
        return {
          ok: false,
          code: "intent-map-invalid",
          reason: "intentMap.defects entries must be objects with a non-empty string type.",
        };
      }
    }
  }
  if (raw.normalized !== undefined && raw.normalized !== null && !Array.isArray(raw.normalized)) {
    return {
      ok: false,
      code: "intent-map-invalid",
      reason: "intentMap.normalized must be an array when present.",
    };
  }
  return { ok: true };
}

/**
 * 归一化（结构上已合法）的 intentMap；返回 null 仅当输入不是对象。
 * - discriminatingSignal 缺失/空白/非字符串 → confidence:"low" + requiresUserConfirmation:true
 *   + normalized 含 "discriminating-signal-missing"。
 */
export function normalizeIntentMap(raw) {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return null;
  const signal =
    typeof raw.discriminatingSignal === "string" ? raw.discriminatingSignal.trim() : "";
  const signalUndecidable =
    raw.discriminatingSignal === undefined ||
    raw.discriminatingSignal === null ||
    typeof raw.discriminatingSignal !== "string" ||
    signal.length === 0;
  const markers = normalizeStringList(raw.normalized);
  if (signalUndecidable && !markers.includes("discriminating-signal-missing")) {
    markers.unshift("discriminating-signal-missing");
  }
  const declaredConfidence =
    typeof raw.confidence === "string" && INTENT_MAP_CONFIDENCES.includes(raw.confidence)
      ? raw.confidence
      : "low";
  return {
    goal: optionalString(raw.goal),
    trueGoal: optionalString(raw.trueGoal),
    inferredFrom: normalizeStringList(raw.inferredFrom),
    defects: normalizeDefects(raw.defects),
    assumptions: normalizeStringList(raw.assumptions),
    confidence: signalUndecidable ? "low" : declaredConfidence,
    requiresUserConfirmation: signalUndecidable ? true : raw.requiresUserConfirmation === true,
    discriminatingSignal: signal,
    acceptanceSignals: normalizeStringList(raw.acceptanceSignals),
    normalized: markers,
  };
}

/**
 * §8.4 prompt-defect pass：纯确定性、只在 defects 命中已知信号时动作。
 * 返回 { value, appliedSignals }；无缺陷或未知类型时完全不改。
 * 可机判动作（不做模型式推断）：
 *   - contradictory：强制 requiresUserConfirmation=true；
 *   - missing-acceptance 且无 acceptanceSignals：confidence 降到 low。
 * 其余信号只记录命中，不代模型编造文字/影响。
 */
export function runPromptDefectPass(raw) {
  const value = normalizeIntentMap(raw);
  if (value === null) return { value: null, appliedSignals: [] };
  const appliedSignals = [];
  for (const defect of value.defects) {
    const type = defect?.type ?? "";
    if (type === "contradictory") {
      if (value.requiresUserConfirmation !== true) {
        value.requiresUserConfirmation = true;
      }
      if (!appliedSignals.includes(type)) appliedSignals.push(type);
    } else if (type === "missing-acceptance" && value.acceptanceSignals.length === 0) {
      if (value.confidence !== "low") {
        value.confidence = "low";
      }
      if (!appliedSignals.includes(type)) appliedSignals.push(type);
    } else if (INTENT_DEFECT_TYPES.includes(type) && !appliedSignals.includes(type)) {
      // 命中已知信号但无可机判动作：只记录命中，不发明内容/不降级。
      appliedSignals.push(type);
    }
  }
  if (appliedSignals.length > 0) {
    const markers = [...value.normalized];
    for (const signal of appliedSignals) {
      const marker = `prompt-defect:${signal}`;
      if (!markers.includes(marker)) markers.push(marker);
    }
    value.normalized = markers;
  }
  return { value, appliedSignals };
}
