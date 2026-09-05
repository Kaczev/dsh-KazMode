// whale-summarizer —— pure core: validation, prompt, source ids, output policy.
// ===========================================================================
// Kaz7.0 whale_summarizer 内部 service 的纯函数层（零 I/O、零 Cordis、零 LLM）。
// 硬约束：每次 summarize 输入只含“被闭合/被升华块”的直接 children 语义摘要：
//   leaf  = 原文（level 0）
//   block = 该 block 已有的 summary
// 不接收整棵子树 / 全部历史 / 展开分页 / 多轮 user messages / system / tools。
// ===========================================================================

export const WHALE_SUMMARIZER_PURPOSES = Object.freeze([
  "close-round",
  "close-planItem",
  "close-goal",
  "promote",
]);

export const EVIDENCE_KINDS = Object.freeze(["leaf", "block"]);
export const REF_KINDS = Object.freeze(["leaf", "block"]);

export const DEFAULT_OPTIONS = Object.freeze({
  maxEvidenceChars: 1000000,
  maxSummaryChars: 2000,
  maxAttempts: 3,
  language: "zh",
});

export const ERROR_CODES = Object.freeze({
  INVALID_INPUT: "WHALE_SUMMARIZER_INVALID_INPUT",
  SCOPE_DENIED: "WHALE_SUMMARIZER_SCOPE_DENIED",
  NO_ROUTE: "WHALE_SUMMARIZER_NO_ROUTE",
  UNSUPPORTED_REASONING_OFF: "WHALE_SUMMARIZER_UNSUPPORTED_REASONING_OFF",
  SUMMARY_FAILED: "WHALE_SUMMARIZER_SUMMARY_FAILED",
  CANCELED: "WHALE_SUMMARIZER_CANCELED",
  OUTPUT_INVALID: "WHALE_SUMMARIZER_OUTPUT_INVALID",
});

export class WhaleSummarizerError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "WhaleSummarizerError";
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function unique(value) {
  return [...new Set(value)];
}

function errorResult(code, message) {
  return { error: { code, message } };
}

function okResult(value) {
  return { ok: true, ...value };
}

const PURPOSE_TEXT = Object.freeze({
  "close-round": {
    zh: "为刚刚完成的一个 round（回合/层级 1 块）生成收口摘要。",
    en: "Produce the closing summary for a completed round (level-1 block).",
  },
  "close-planItem": {
    zh: "为刚刚完成的一个 planItem（子任务/层级 2 块）生成收口摘要。",
    en: "Produce the closing summary for a completed plan item (level-2 block).",
  },
  "close-goal": {
    zh: "为刚刚完成的一个 goal（目标/阶段/层级 3 块）生成收口摘要。",
    en: "Produce the closing summary for a completed goal (level-3 block).",
  },
  promote: {
    zh: "为同层若干 closed siblings 的升华父块生成语义父摘要。",
    en: "Produce the semantic parent summary for a sublimed group of closed sibling blocks.",
  },
});

const PURPOSE_OUTPUT_RULES = Object.freeze({
  "close-round": {
    zh: "概括该 round 实际发生的事：目标、动作、结果、决策、精确产物与后续待办；输出将作为该 round 块的摘要。",
    en: "Summarize what happened in this round: objectives, actions, results, decisions, exact artifacts, and pending follow-ups; the output becomes the round block summary.",
  },
  "close-planItem": {
    zh: "概括该 planItem 的目标、完成内容、关键结果/产物、阻塞与后续；输出将作为该 planItem 块的摘要。",
    en: "Summarize the plan item's goal, completed work, key results/artifacts, blockers, and follow-ups; the output becomes the plan item block summary.",
  },
  "close-goal": {
    zh: "概括该 goal/阶段的达成情况、关键决策、交付物与未完成事项；输出将作为该 goal 块的摘要。",
    en: "Summarize goal/phase achievement, key decisions, deliverables, and unfinished items; the output becomes the goal block summary.",
  },
  promote: {
    zh: "提炼这些 closed siblings 的共同主题/更高层结论；不得展开兄弟块后代或 leaf 原文；输出将作为升华父块摘要。",
    en: "Synthesize the shared theme or higher-level conclusion of these closed siblings without expanding descendants; the output becomes the sublimed parent summary.",
  },
});

const PURPOSE_LABEL = Object.freeze({
  "close-round": "close-round",
  "close-planItem": "close-planItem",
  "close-goal": "close-goal",
  promote: "promote",
});

function normalizeLanguage(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_OPTIONS.language;
  if (value === "zh" || value === "en") return value;
  return null;
}

function validateOptions(value) {
  if (value === undefined || value === null) return okResult({ opts: { ...DEFAULT_OPTIONS } });
  if (!isPlainObject(value)) return errorResult(ERROR_CODES.INVALID_INPUT, "opts must be an object");
  const allowed = new Set([
    "maxEvidenceChars",
    "maxSummaryChars",
    "maxAttempts",
    "language",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return errorResult(
        ERROR_CODES.INVALID_INPUT,
        `opts contains unsupported key "${key}"`,
      );
    }
  }
  const opts = { ...DEFAULT_OPTIONS };
  if (value.maxEvidenceChars !== undefined) {
    if (!Number.isInteger(value.maxEvidenceChars) || value.maxEvidenceChars < 1) {
      return errorResult(ERROR_CODES.INVALID_INPUT, "opts.maxEvidenceChars must be a positive integer");
    }
    opts.maxEvidenceChars = value.maxEvidenceChars;
  }
  if (value.maxSummaryChars !== undefined) {
    if (!Number.isInteger(value.maxSummaryChars) || value.maxSummaryChars < 1) {
      return errorResult(ERROR_CODES.INVALID_INPUT, "opts.maxSummaryChars must be a positive integer");
    }
    opts.maxSummaryChars = value.maxSummaryChars;
  }
  if (value.maxAttempts !== undefined) {
    if (!Number.isInteger(value.maxAttempts) || value.maxAttempts < 1 || value.maxAttempts > 10) {
      return errorResult(ERROR_CODES.INVALID_INPUT, "opts.maxAttempts must be an integer between 1 and 10");
    }
    opts.maxAttempts = value.maxAttempts;
  }
  if (value.language !== undefined) {
    const language = normalizeLanguage(value.language);
    if (language === null) {
      return errorResult(ERROR_CODES.INVALID_INPUT, 'opts.language must be "zh" or "en"');
    }
    opts.language = language;
  }
  return okResult({ opts });
}

function validateEvidenceItem(value, index) {
  if (!isPlainObject(value)) {
    return errorResult(ERROR_CODES.INVALID_INPUT, `evidence[${index}] must be a plain object`);
  }
  const allowed = new Set(["kind", "id", "text", "path"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return errorResult(
        ERROR_CODES.INVALID_INPUT,
        `evidence[${index}] contains unsupported key "${key}" (direct-children input only; no subtree/history/expansion)`,
      );
    }
  }
  if (!EVIDENCE_KINDS.includes(value.kind)) {
    return errorResult(
      ERROR_CODES.INVALID_INPUT,
      `evidence[${index}].kind must be one of: ${EVIDENCE_KINDS.join(", ")}`,
    );
  }
  if (!isNonEmptyString(value.id)) {
    return errorResult(ERROR_CODES.INVALID_INPUT, `evidence[${index}].id must be a non-empty string`);
  }
  if (!isNonEmptyString(value.text)) {
    return errorResult(ERROR_CODES.INVALID_INPUT, `evidence[${index}].text must be a non-empty string`);
  }
  if (value.path !== undefined && !isNonEmptyString(value.path)) {
    return errorResult(ERROR_CODES.INVALID_INPUT, `evidence[${index}].path must be a non-empty string when provided`);
  }
  return okResult({
    item: {
      kind: value.kind,
      id: value.id,
      text: value.text.trim(),
      ...(value.path !== undefined ? { path: value.path.trim() } : {}),
    },
  });
}

function validateRefItem(value, index) {
  if (!isPlainObject(value)) {
    return errorResult(ERROR_CODES.INVALID_INPUT, `refs[${index}] must be a plain object`);
  }
  const allowed = new Set(["kind", "id", "path", "seq"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return errorResult(
        ERROR_CODES.INVALID_INPUT,
        `refs[${index}] contains unsupported key "${key}"`,
      );
    }
  }
  if (!REF_KINDS.includes(value.kind)) {
    return errorResult(
      ERROR_CODES.INVALID_INPUT,
      `refs[${index}].kind must be one of: ${REF_KINDS.join(", ")}`,
    );
  }
  if (!isNonEmptyString(value.id)) {
    return errorResult(ERROR_CODES.INVALID_INPUT, `refs[${index}].id must be a non-empty string`);
  }
  if (value.path !== undefined && !isNonEmptyString(value.path)) {
    return errorResult(ERROR_CODES.INVALID_INPUT, `refs[${index}].path must be a non-empty string when provided`);
  }
  if (value.kind === "leaf" && value.seq !== undefined) {
    if (!Number.isInteger(value.seq) || value.seq < 1) {
      return errorResult(ERROR_CODES.INVALID_INPUT, `refs[${index}].seq must be a positive integer when provided`);
    }
  }
  return okResult({
    ref: {
      kind: value.kind,
      id: value.id,
      ...(value.path !== undefined ? { path: value.path.trim() } : {}),
      ...(value.seq !== undefined ? { seq: value.seq } : {}),
    },
  });
}

function validateEvidenceRefs(evidence, refs) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return errorResult(ERROR_CODES.INVALID_INPUT, "evidence must be a non-empty array of direct children");
  }
  if (evidence.length > 10000) {
    return errorResult(ERROR_CODES.INVALID_INPUT, "evidence exceeds 10000 direct children");
  }
  if (!Array.isArray(refs) || refs.length === 0) {
    return errorResult(ERROR_CODES.INVALID_INPUT, "refs must be a non-empty array");
  }
  if (evidence.length !== refs.length) {
    return errorResult(
      ERROR_CODES.INVALID_INPUT,
      "evidence and refs must describe the same direct children (same count)",
    );
  }
  const normalizedEvidence = [];
  const normalizedRefs = [];
  for (let i = 0; i < evidence.length; i += 1) {
    const ev = validateEvidenceItem(evidence[i], i);
    if (ev.error) return ev;
    const ref = validateRefItem(refs[i], i);
    if (ref.error) return ref;
    if (ev.item.kind !== ref.ref.kind || ev.item.id !== ref.ref.id) {
      return errorResult(
        ERROR_CODES.INVALID_INPUT,
        `evidence[${i}] and refs[${i}] must have the same kind and id`,
      );
    }
    if (
      ev.item.path !== undefined &&
      ref.ref.path !== undefined &&
      ev.item.path !== ref.ref.path
    ) {
      return errorResult(
        ERROR_CODES.INVALID_INPUT,
        `evidence[${i}] and refs[${i}] path mismatch`,
      );
    }
    normalizedEvidence.push(ev.item);
    normalizedRefs.push(ref.ref);
  }
  const ids = normalizedRefs.map((ref) => ref.id);
  if (unique(ids).length !== ids.length) {
    return errorResult(ERROR_CODES.INVALID_INPUT, "refs must not contain duplicate ids");
  }
  return okResult({ evidence: normalizedEvidence, refs: normalizedRefs });
}

/**
 * Validate one summarize input object. Strictly rejects anything beyond the
 * direct-children protocol.
 */
export function validateSummarizeInput(input) {
  if (!isPlainObject(input)) {
    return errorResult(ERROR_CODES.INVALID_INPUT, "summarize input must be an object");
  }
  const allowed = new Set(["evidence", "refs", "purpose", "opts"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      return errorResult(
        ERROR_CODES.INVALID_INPUT,
        `summarize input contains unsupported key "${key}"`,
      );
    }
  }
  if (!WHALE_SUMMARIZER_PURPOSES.includes(input.purpose)) {
    return errorResult(
      ERROR_CODES.INVALID_INPUT,
      `purpose must be one of: ${WHALE_SUMMARIZER_PURPOSES.join(", ")}`,
    );
  }
  const options = validateOptions(input.opts);
  if (options.error) return options;
  const pairs = validateEvidenceRefs(input.evidence, input.refs);
  if (pairs.error) return pairs;
  const evidence = pairs.evidence;
  const refs = pairs.refs;
  const opts = options.opts;
  const totalChars = evidence.reduce((sum, item) => sum + item.text.length, 0);
  if (totalChars > opts.maxEvidenceChars) {
    return errorResult(
      ERROR_CODES.INVALID_INPUT,
      `evidence total length ${totalChars} exceeds maxEvidenceChars ${opts.maxEvidenceChars}`,
    );
  }
  return okResult({
    input: {
      evidence,
      refs,
      purpose: input.purpose,
      opts,
    },
  });
}

/** Unique source ids of the direct-children refs, in evidence order. */
export function sourceIdsOf(normalized) {
  return unique((normalized?.refs ?? []).map((ref) => ref.id));
}

function codePointSlice(text, maxChars) {
  if (text.length <= maxChars) return text;
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return chars.slice(0, maxChars).join("");
}

/** Validate assembled model output: text-only, non-empty, bounded summary. */
export function assembleSummaryText(blocks, maxSummaryChars) {
  if (!Array.isArray(blocks)) {
    return errorResult(ERROR_CODES.OUTPUT_INVALID, "model output blocks must be an array");
  }
  const unsupported = blocks.find((block) => block === null || typeof block !== "object" || block.type !== "text");
  if (unsupported !== undefined) {
    return errorResult(
      ERROR_CODES.OUTPUT_INVALID,
      "model output must be text only; reasoning/tool/image output is rejected",
    );
  }
  const raw = blocks
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("\n")
    .trim();
  if (raw.length === 0) {
    return errorResult(ERROR_CODES.OUTPUT_INVALID, "model output summary is empty");
  }
  return okResult({
    summary: codePointSlice(raw, maxSummaryChars),
  });
}

/** Translate a terminal LLM finish reason into an attempt-failure error message/code. */
export function finishErrorOf(finish) {
  if (finish === undefined || finish === null) return null;
  switch (finish.kind) {
    case "stop":
      return null;
    case "error":
    case "aborted": {
      const failure = finish.failure && typeof finish.failure === "object" ? finish.failure : {};
      const error = new WhaleSummarizerError(
        ERROR_CODES.SUMMARY_FAILED,
        `whale_summarizer model stream ${finish.kind}: ${failure.message ?? "unknown failure"}`,
      );
      if (typeof failure.code === "string") error.detailCode = failure.code;
      return error;
    }
    case "max-tokens":
      return new WhaleSummarizerError(
        ERROR_CODES.OUTPUT_INVALID,
        "whale_summarizer model output reached max-tokens (incomplete summary)",
      );
    case "tool-calls":
      return new WhaleSummarizerError(
        ERROR_CODES.OUTPUT_INVALID,
        "whale_summarizer model unexpectedly requested tools",
      );
    default:
      return new WhaleSummarizerError(
        ERROR_CODES.OUTPUT_INVALID,
        `whale_summarizer unsupported finish reason: ${String(finish.kind)}`,
      );
  }
}

/** Build the standalone single-user-message prompt for one summarize request. */
export function buildPrompt(normalized) {
  const purpose = normalized.purpose;
  const opts = normalized.opts;
  const lang = opts.language;
  const purposeText = PURPOSE_TEXT[purpose]?.[lang] ?? PURPOSE_TEXT[purpose]?.zh;
  const outputRules = PURPOSE_OUTPUT_RULES[purpose]?.[lang] ?? PURPOSE_OUTPUT_RULES[purpose]?.zh;
  const label = PURPOSE_LABEL[purpose] ?? purpose;

  const lines = [
    lang === "zh"
      ? "你是 Kaz 树形会话的摘要器。以下材料是被收口/被升华块的【直接 children】语义摘要。"
      : "You are the Kaz tree-session summarizer. The material below is the semantic summary of the DIRECT CHILDREN of the block being closed or sublimed.",
    lang === "zh"
      ? "leaf 条目是原始文本；block 条目是已闭合子块已有的 summary。不要展开孙级、不要调用工具、不要补写 system/history。"
      : "leaf entries are original text; block entries are existing summaries of closed children. Do not expand descendants, call tools, or add system/history context.",
    "",
    `Purpose: ${label}`,
    purposeText,
    "",
    lang === "zh" ? "输入条目：" : "Input entries:",
  ];

  normalized.evidence.forEach((item, index) => {
    const location = item.path ? ` path=${item.path}` : "";
    lines.push(`[${index + 1}] (${item.kind}) id=${item.id}${location}`);
    lines.push(item.text);
  });

  lines.push("");
  lines.push(
    lang === "zh"
      ? "输出要求：只输出一段纯文本 summary，不要解释、不要 Markdown 结构、不要工具调用、不要 invent 输入中不存在的事实。"
      : "Output rules: return one plain-text summary only; no explanation, no Markdown structure, no tool calls, and never invent facts absent from the input.",
  );
  lines.push(outputRules);
  lines.push(
    lang === "zh"
      ? "必须保留精确路径、命令、报错串、标识符、数值、函数签名。"
      : "Preserve exact paths, commands, error strings, identifiers, numeric values, and function signatures.",
  );
  return lines.join("\n");
}
