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

/** §3.2 evidence kind 枚举（evidence gate 机器校验用）。 */
export const EVIDENCE_KINDS = Object.freeze([
  "probe",
  "test",
  "build-lint",
  "command",
  "rendered",
  "diff",
  "audit",
]);

/** §3.2 evidence status 枚举。 */
export const EVIDENCE_STATUSES = Object.freeze(["met", "unmet", "waived"]);

/** 机器可读 evidenceChecklist 契约（单一事实源：校验 / 工具提示 / 错误 schema 共用）。 */
export const EVIDENCE_CHECKLIST_SCHEMA = Object.freeze({
  code: "evidence-checklist-invalid",
  root: "array of evidence entries",
  entry: Object.freeze({
    required: Object.freeze({
      id: "non-empty string",
      command: "non-empty string",
      expected: "non-empty string",
      actualTail: "non-empty string",
      at: "non-empty string",
      kind: Object.freeze({ enum: EVIDENCE_KINDS }),
      status: Object.freeze({ enum: EVIDENCE_STATUSES }),
    }),
    optional: Object.freeze({
      mainRerun: Object.freeze({
        nullable: true,
        required: Object.freeze({
          command: "non-empty string",
          actualTail: "string",
          matches: "boolean",
        }),
      }),
    }),
    unknownEntryKeys: "ignored",
  }),
});

/** 机器可读 intentMap 契约（单一事实源：校验 / 工具提示 / 错误 schema 共用）。 */
export const INTENT_MAP_SCHEMA = Object.freeze({
  code: "intent-map-invalid",
  root: "object",
  unknownKeys: "rejected",
  properties: Object.freeze({
    goal: "optional string",
    trueGoal: "optional string",
    inferredFrom: "optional array of strings",
    defects: "optional array of { type: non-empty string, quote?: string, action?: string }",
    assumptions: "optional array of strings",
    confidence: Object.freeze({ optional: true, enum: INTENT_MAP_CONFIDENCES }),
    requiresUserConfirmation: "optional boolean",
    discriminatingSignal:
      "optional string; missing/blank -> confidence low + requiresUserConfirmation true",
    acceptanceSignals: "optional array of strings",
    normalized: "optional array",
  }),
  knownDefectTypes: INTENT_DEFECT_TYPES,
});

/** whale_report.evidenceChecklist 参数的单行提示（由 schema 常量派生）。 */
export const EVIDENCE_CHECKLIST_TOOL_HINT =
  `{${Object.keys(EVIDENCE_CHECKLIST_SCHEMA.entry.required).join(", ")}}; ` +
  `kind ${EVIDENCE_KINDS.join("/")}; status ${EVIDENCE_STATUSES.join("/")}; ` +
  `mainRerun? {${Object.keys(EVIDENCE_CHECKLIST_SCHEMA.entry.optional.mainRerun.required).join(", ")}}; ` +
  `invalid payloads return all issues + schema`;

/** whale_report.intentMap 参数的单行提示（字段名由 schema 常量派生）。 */
export const INTENT_MAP_TOOL_HINT =
  `Optional Intent Map object (assess-complexity only): ${Object.keys(INTENT_MAP_SCHEMA.properties).join("/")}`;

/** Intent Map 顶层字段白名单（§8.1；由 INTENT_MAP_SCHEMA 派生，单一事实源）。 */
const INTENT_MAP_KEYS = new Set(Object.keys(INTENT_MAP_SCHEMA.properties));

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
 * 收集式校验失败结果：reason 与旧实现首条违规的单行文案完全一致，
 * issues 按源码检查顺序给出全部违规，schema 为机器可读契约。
 */
function validationFailure(code, issues, summary) {
  return {
    ok: false,
    code,
    reason:
      typeof summary === "string" && summary.length > 0
        ? summary
        : `${issues[0].path} ${issues[0].problem}`,
    issueCount: issues.length,
    issues,
    schema: code === "intent-map-invalid" ? INTENT_MAP_SCHEMA : EVIDENCE_CHECKLIST_SCHEMA,
  };
}

/** 校验用户提交的 evidenceChecklist（§3.2 机器可校验形状；一次返回全部违规）。 */
export function validateEvidenceChecklistInput(value) {
  const issues = [];
  const add = (path, problem, allowed) => {
    issues.push(
      allowed === undefined ? { path, problem } : { path, problem, allowed: [...allowed] },
    );
  };
  if (!Array.isArray(value)) {
    add("evidenceChecklist", "must be an array when present.");
    return validationFailure("evidence-checklist-invalid", issues);
  }
  const requiredText = ["id", "command", "expected", "actualTail", "at"];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const label = `evidenceChecklist[${index}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      add(label, "must be an object.");
      continue;
    }
    for (const key of requiredText) {
      if (typeof entry[key] !== "string" || entry[key].trim().length === 0) {
        add(`${label}.${key}`, "must be a non-empty string.");
      }
    }
    if (!EVIDENCE_KINDS.includes(entry.kind)) {
      add(`${label}.kind`, `must be one of ${EVIDENCE_KINDS.join("/")}.`, EVIDENCE_KINDS);
    }
    if (!EVIDENCE_STATUSES.includes(entry.status)) {
      add(`${label}.status`, `must be one of ${EVIDENCE_STATUSES.join("/")}.`, EVIDENCE_STATUSES);
    }
    if (entry.mainRerun !== undefined && entry.mainRerun !== null) {
      const rerun = entry.mainRerun;
      const rerunLabel = `${label}.mainRerun`;
      if (rerun === null || typeof rerun !== "object" || Array.isArray(rerun)) {
        add(rerunLabel, "must be null or an object.");
      } else {
        if (typeof rerun.command !== "string" || rerun.command.trim().length === 0) {
          add(`${rerunLabel}.command`, "must be a non-empty string.");
        }
        if (typeof rerun.actualTail !== "string") {
          add(`${rerunLabel}.actualTail`, "must be a string.");
        }
        if (typeof rerun.matches !== "boolean") {
          add(`${rerunLabel}.matches`, "must be a boolean.");
        }
      }
    }
  }
  if (issues.length > 0) return validationFailure("evidence-checklist-invalid", issues);
  return { ok: true };
}

/**
 * 校验用户提供的 intentMap（结构层；一次返回全部违规）。missing discriminatingSignal
 * 不算结构错；返回 { ok:false, code:"intent-map-invalid", reason, issueCount, issues, schema }
 * 或 { ok:true }。
 */
export function validateIntentMapInput(raw) {
  const issues = [];
  let firstSummary = "";
  const add = (path, problem, options = {}) => {
    if (issues.length === 0) {
      firstSummary =
        typeof options.summary === "string" && options.summary.length > 0
          ? options.summary
          : `${path} ${problem}`;
    }
    issues.push(
      options.allowed === undefined
        ? { path, problem }
        : { path, problem, allowed: [...options.allowed] },
    );
  };
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    add("intentMap", "must be an object.");
    return validationFailure("intent-map-invalid", issues, firstSummary);
  }
  const unknownKeys = Object.keys(raw).filter((key) => !INTENT_MAP_KEYS.has(key));
  if (unknownKeys.length > 0) {
    const summary = `intentMap has unsupported keys: ${unknownKeys.join(", ")}.`;
    for (const key of unknownKeys) {
      add(`intentMap.${key}`, "is not a supported key.", { summary });
    }
  }
  for (const key of ["goal", "trueGoal", "discriminatingSignal"]) {
    if (raw[key] !== undefined && raw[key] !== null && typeof raw[key] !== "string") {
      add(`intentMap.${key}`, "must be a string when present.");
    }
  }
  for (const key of ["inferredFrom", "assumptions", "acceptanceSignals"]) {
    if (
      raw[key] !== undefined &&
      raw[key] !== null &&
      (!Array.isArray(raw[key]) || raw[key].some((entry) => typeof entry !== "string"))
    ) {
      add(`intentMap.${key}`, "must be an array of strings when present.");
    }
  }
  if (raw.confidence !== undefined && raw.confidence !== null) {
    if (typeof raw.confidence !== "string" || !INTENT_MAP_CONFIDENCES.includes(raw.confidence)) {
      add("intentMap.confidence", `must be one of ${INTENT_MAP_CONFIDENCES.join("/")}.`, {
        allowed: INTENT_MAP_CONFIDENCES,
      });
    }
  }
  if (
    raw.requiresUserConfirmation !== undefined &&
    raw.requiresUserConfirmation !== null &&
    typeof raw.requiresUserConfirmation !== "boolean"
  ) {
    add("intentMap.requiresUserConfirmation", "must be a boolean when present.");
  }
  if (raw.defects !== undefined && raw.defects !== null) {
    if (!Array.isArray(raw.defects)) {
      add("intentMap.defects", "must be an array when present.");
    } else {
      for (let index = 0; index < raw.defects.length; index += 1) {
        const entry = raw.defects[index];
        if (
          entry === null ||
          typeof entry !== "object" ||
          Array.isArray(entry) ||
          typeof entry.type !== "string" ||
          entry.type.trim().length === 0
        ) {
          add(`intentMap.defects[${index}]`, "must be an object with a non-empty string type.", {
            summary: "intentMap.defects entries must be objects with a non-empty string type.",
          });
        }
      }
    }
  }
  if (raw.normalized !== undefined && raw.normalized !== null && !Array.isArray(raw.normalized)) {
    add("intentMap.normalized", "must be an array when present.");
  }
  if (issues.length > 0) return validationFailure("intent-map-invalid", issues, firstSummary);
  return { ok: true };
}

/** 把校验失败结果格式化成模型可见的单条消息：首行单行摘要，随后全部 issues 与 schema。 */
export function formatValidationFailure(result) {
  const code =
    result !== null &&
    typeof result === "object" &&
    typeof result.code === "string" &&
    result.code.length > 0
      ? result.code
      : "invalid-input";
  const reason =
    result !== null && typeof result === "object" && typeof result.reason === "string"
      ? result.reason
      : "invalid input.";
  const lines = [`${code}: ${reason}`];
  const issues = result !== null && typeof result === "object" && Array.isArray(result.issues)
    ? result.issues
    : [];
  if (issues.length > 0) {
    lines.push("issues:");
    for (const issue of issues) {
      const path = typeof issue?.path === "string" ? issue.path : "?";
      const problem = typeof issue?.problem === "string" ? issue.problem : "invalid.";
      const allowed =
        Array.isArray(issue?.allowed) && issue.allowed.length > 0
          ? ` [allowed: ${issue.allowed.join("/")}]`
          : "";
      lines.push(`- ${path}: ${problem}${allowed}`);
    }
  }
  if (result !== null && typeof result === "object" && result.schema !== undefined) {
    lines.push("schema:");
    lines.push(JSON.stringify(result.schema));
  }
  return lines.join("\n");
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
