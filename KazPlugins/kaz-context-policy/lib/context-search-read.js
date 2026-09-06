// kaz-context-policy M2 —— 离线纯函数核心：context search + context read
// ===========================================================================
// 纯 ESM、零 I/O、零依赖：不 import node:*、cordis 或 DSH 模块。
// 不改 DSH 核心 / 不改 preset / 不注册工具 / 不碰 tool-lists。
//
// record 契约：
//   { seq:number, kind:"user"|"assistant"|"tool", time?:number|string, text:string }
//   - seq 必须是非负安全整数且在整个 records 中唯一。
//   - text 必须是 string 且 trim 后非空（存储时保留原文，不主动 trim）。
//   - time 可选；提供时必须是 number 或 string。
//
// searchContext(records, query, opts?)：
//   - query 必须 trim 后非空 string；匹配为整串大小写不敏感子串匹配。
//   - 结果按 seq 降序；snippet 取首次命中的前 snippetBefore / 后
//     snippetAfter 字符窗口，边界被截断时补省略号（省略号不计窗口字符）。
//   - opts: limit(默认10, 正安全整数), cursor(不透明页码游标),
//     snippetBefore(默认80, 非负), snippetAfter(默认160, 非负),
//     maxResultsTotal(可选, 正安全整数)。
//   - maxResultsTotal 是“暴露上限”：只扫描/暴露这么多条命中即停止；
//     total 为该上限内数量，达到上限后 hasMore=false。
//   - cursor 为 m2s:<base36 offset> 形式的不透明字符串，只由本函数生成。
//
// readContext(records, targets, opts?)：
//   - targets 接受 number 或 number[]，去重且保留输入顺序。
//   - 返回完整原文，单条永不截断；totalCharsBudget 默认 16000，按 estimateChars
//     (text.length) 累计；下一条整条放不进剩余预算时停止，并把当前及后续唯一
//     目标计为 omitted。
//   - 非法/不存在 seq 返回 { ok:false, code, reason } 结构化错误。
//
// helpers：
//   estimateChars(text)  -> text.length（UTF-16 code unit 字符数）。
//   tokenOfText(text)    -> 无依赖粗估：空串 0，否则 max(1, ceil(chars/4))。
// ===========================================================================

export const KINDS = Object.freeze(["user", "assistant", "tool"]);
export const DEFAULT_SEARCH_LIMIT = 10;
export const DEFAULT_SNIPPET_BEFORE = 80;
export const DEFAULT_SNIPPET_AFTER = 160;
export const DEFAULT_READ_CHARS_BUDGET = 16000;

const ELLIPSIS = "\u2026";
const CURSOR_PREFIX = "m2s:";
const CURSOR_RE = /^[0-9a-z]+$/i;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function failure(code, reason) {
  return { ok: false, code, reason };
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** 校验整份 records；返回 { ok:true } 或结构化失败。 */
function validateRecords(records) {
  if (!Array.isArray(records)) {
    return failure("invalid-records", "records must be an array");
  }
  const seen = new Set();
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!isPlainObject(record)) {
      return failure(
        "invalid-record",
        `records[${i}] must be a plain object`,
      );
    }
    const { seq, kind, text, time } = record;
    if (!isNonNegativeSafeInteger(seq)) {
      return failure(
        "invalid-seq",
        `records[${i}].seq must be a non-negative safe integer`,
      );
    }
    if (seen.has(seq)) {
      return failure(
        "duplicate-seq",
        `duplicate seq ${seq}; seq must be unique`,
      );
    }
    seen.add(seq);
    if (typeof kind !== "string" || !KINDS.includes(kind)) {
      return failure(
        "invalid-kind",
        `records[${i}].kind must be one of ${KINDS.join("|")}`,
      );
    }
    if (typeof text !== "string" || text.trim().length === 0) {
      return failure(
        "invalid-text",
        `records[${i}].text must be a string with non-empty trimmed value`,
      );
    }
    if (time !== undefined && typeof time !== "number" && typeof time !== "string") {
      return failure(
        "invalid-time",
        `records[${i}].time must be a number or string when provided`,
      );
    }
  }
  return { ok: true };
}

function validateQuery(query) {
  if (typeof query !== "string") {
    return failure("invalid-query", "query must be a string");
  }
  if (query.trim().length === 0) {
    return failure("empty-query", "query must not be empty after trim");
  }
  return { ok: true };
}

function normalizeSearchOpts(rawOpts) {
  if (rawOpts === undefined) rawOpts = {};
  if (!isPlainObject(rawOpts)) {
    return failure("invalid-opts", "opts must be a plain object or undefined");
  }

  const readPositive = (value, fallback, code) => {
    if (value === undefined) return fallback;
    if (!isPositiveSafeInteger(value)) {
      return failure(code, "value must be a positive safe integer");
    }
    return value;
  };

  const readNonNegative = (value, fallback, code) => {
    if (value === undefined) return fallback;
    if (!isNonNegativeSafeInteger(value)) {
      return failure(code, "value must be a non-negative safe integer");
    }
    return value;
  };

  const limit = readPositive(rawOpts.limit, DEFAULT_SEARCH_LIMIT, "invalid-limit");
  if (typeof limit === "object") return limit;
  const before = readNonNegative(
    rawOpts.snippetBefore,
    DEFAULT_SNIPPET_BEFORE,
    "invalid-snippet-before",
  );
  if (typeof before === "object") return before;
  const after = readNonNegative(
    rawOpts.snippetAfter,
    DEFAULT_SNIPPET_AFTER,
    "invalid-snippet-after",
  );
  if (typeof after === "object") return after;
  const maxTotal = readPositive(
    rawOpts.maxResultsTotal,
    null,
    "invalid-max-results-total",
  );
  if (maxTotal !== null && typeof maxTotal === "object") return maxTotal;
  if (rawOpts.cursor !== undefined && typeof rawOpts.cursor !== "string") {
    return failure("invalid-cursor", "cursor must be a string when provided");
  }

  return {
    ok: true,
    opts: {
      limit,
      snippetBefore: before,
      snippetAfter: after,
      maxResultsTotal: maxTotal,
      cursor: rawOpts.cursor,
    },
  };
}

function normalizeReadOpts(rawOpts) {
  if (rawOpts === undefined) rawOpts = {};
  if (!isPlainObject(rawOpts)) {
    return failure("invalid-opts", "opts must be a plain object or undefined");
  }
  let budget = DEFAULT_READ_CHARS_BUDGET;
  if (rawOpts.totalCharsBudget !== undefined) {
    if (!isNonNegativeSafeInteger(rawOpts.totalCharsBudget)) {
      return failure(
        "invalid-total-budget",
        "totalCharsBudget must be a non-negative safe integer",
      );
    }
    budget = rawOpts.totalCharsBudget;
  }
  return { ok: true, opts: { totalCharsBudget: budget } };
}

function firstMatchIndex(text, lowerQuery) {
  return text.toLowerCase().indexOf(lowerQuery);
}

function encodeCursor(offset) {
  return `${CURSOR_PREFIX}${offset.toString(36)}`;
}

function decodeCursor(cursor) {
  if (typeof cursor !== "string" || !cursor.startsWith(CURSOR_PREFIX)) {
    return failure(
      "invalid-cursor",
      "cursor must be an opaque cursor string returned by searchContext",
    );
  }
  const raw = cursor.slice(CURSOR_PREFIX.length);
  if (!CURSOR_RE.test(raw)) {
    return failure("invalid-cursor", "cursor is malformed");
  }
  const offset = Number.parseInt(raw, 36);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return failure("invalid-cursor", "cursor is out of range");
  }
  return { ok: true, offset };
}

function makeSnippet(text, query, before, after) {
  const lowerQuery = query.toLowerCase();
  const index = firstMatchIndex(text, lowerQuery);
  const matchLength = query.length;
  if (index === -1) {
    // 正常情况下不会走到；防御性返回整条。
    return text;
  }
  const cutLeft = index - before > 0;
  const start = Math.max(0, index - before);
  const cutRight = index + matchLength + after < text.length;
  const end = Math.min(text.length, index + matchLength + after);
  const leftMark = cutLeft ? ELLIPSIS : "";
  const rightMark = cutRight ? ELLIPSIS : "";
  return leftMark + text.slice(start, end) + rightMark;
}

/** 在已验证 records 中收集匹配项（最多 maxResultsTotal 条）。 */
function collectMatches(records, query, maxResultsTotal) {
  const lowerQuery = query.toLowerCase();
  const sorted = records.slice().sort((a, b) => b.seq - a.seq);
  const matched = [];
  for (const record of sorted) {
    if (firstMatchIndex(record.text, lowerQuery) !== -1) {
      matched.push(record);
      if (maxResultsTotal !== null && matched.length >= maxResultsTotal) {
        break;
      }
    }
  }
  return matched;
}

function toSearchItem(record, snippet) {
  const item = { seq: record.seq, kind: record.kind, snippet };
  if (record.time !== undefined) item.time = record.time;
  return item;
}

/**
 * 子串搜索。成功：
 *   { ok:true, page:[{seq,kind,time?,snippet}], total, hasMore, nextCursor? }
 * 失败：{ ok:false, code, reason }。
 */
export function searchContext(records, query, rawOpts) {
  const recordResult = validateRecords(records);
  if (!recordResult.ok) return recordResult;

  const queryResult = validateQuery(query);
  if (!queryResult.ok) return queryResult;

  const optResult = normalizeSearchOpts(rawOpts);
  if (!optResult.ok) return optResult;
  const { limit, snippetBefore, snippetAfter, maxResultsTotal, cursor } =
    optResult.opts;

  let offset = 0;
  if (cursor !== undefined) {
    const cursorResult = decodeCursor(cursor);
    if (!cursorResult.ok) return cursorResult;
    offset = cursorResult.offset;
  }

  const matched = collectMatches(records, query, maxResultsTotal);
  const total = matched.length;
  if (offset > total) {
    return failure(
      "invalid-cursor",
      `cursor offset ${offset} is beyond total ${total}`,
    );
  }

  const pageRecords = matched.slice(offset, offset + limit);
  const page = pageRecords.map((record) =>
    toSearchItem(record, makeSnippet(record.text, query, snippetBefore, snippetAfter)),
  );
  const hasMore = offset + page.length < total;
  const result = {
    ok: true,
    page,
    total,
    hasMore,
  };
  if (hasMore) {
    result.nextCursor = encodeCursor(offset + page.length);
  }
  return result;
}

function normalizeTargets(targets) {
  let list;
  if (typeof targets === "number") {
    list = [targets];
  } else if (Array.isArray(targets)) {
    list = targets;
  } else {
    return failure(
      "invalid-targets",
      "targets must be a seq number or an array of seq numbers",
    );
  }
  for (let i = 0; i < list.length; i += 1) {
    if (!isNonNegativeSafeInteger(list[i])) {
      return failure(
        "invalid-target-seq",
        `targets[${i}] must be a non-negative safe integer`,
      );
    }
  }
  const seen = new Set();
  const unique = [];
  for (const seq of list) {
    if (!seen.has(seq)) {
      seen.add(seq);
      unique.push(seq);
    }
  }
  return { ok: true, targets: unique };
}

function toReadItem(record) {
  const item = { seq: record.seq, kind: record.kind, text: record.text };
  if (record.time !== undefined) item.time = record.time;
  return item;
}

/**
 * 按 seq 读取完整原文。成功：
 *   { ok:true, items:[{seq,kind,time?,text}], omitted:number }
 * 失败：{ ok:false, code, reason }。
 */
export function readContext(records, targets, rawOpts) {
  const recordResult = validateRecords(records);
  if (!recordResult.ok) return recordResult;

  const targetResult = normalizeTargets(targets);
  if (!targetResult.ok) return targetResult;

  const optResult = normalizeReadOpts(rawOpts);
  if (!optResult.ok) return optResult;
  const { totalCharsBudget } = optResult.opts;

  const bySeq = new Map();
  for (const record of records) {
    bySeq.set(record.seq, record);
  }

  for (const seq of targetResult.targets) {
    if (!bySeq.has(seq)) {
      return failure("missing-seq", `no record found with seq ${seq}`);
    }
  }

  const items = [];
  let remaining = totalCharsBudget;
  let omitted = 0;
  const { targets: uniqueTargets } = targetResult;
  for (let i = 0; i < uniqueTargets.length; i += 1) {
    const record = bySeq.get(uniqueTargets[i]);
    const chars = estimateChars(record.text);
    if (chars <= remaining) {
      items.push(toReadItem(record));
      remaining -= chars;
    } else {
      omitted = uniqueTargets.length - i;
      break;
    }
  }
  return { ok: true, items, omitted };
}

/** 纯字符估算：UTF-16 code unit 数，与 readContext 预算口径一致。 */
export function estimateChars(text) {
  if (typeof text !== "string") {
    throw new TypeError("estimateChars(text): text must be a string");
  }
  return text.length;
}

/** 纯 token 粗估：无依赖启发式，空串为 0，否则 max(1, ceil(chars / 4))。 */
export function tokenOfText(text) {
  if (typeof text !== "string") {
    throw new TypeError("tokenOfText(text): text must be a string");
  }
  const chars = estimateChars(text);
  if (chars === 0) return 0;
  return Math.max(1, Math.ceil(chars / 4));
}
