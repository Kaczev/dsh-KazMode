// kaz-context-policy —— 会话日志的原文读取与检索（context_search 系列共用）。
//
// 只认模型可见的历史事件：user/message、assistant/message、tool/call、tool/result。
// 压缩只改变"当前上下文"（surface），不改这条追加式日志；所以这里查到的就是原文，
// 包含已经被压缩掉、不在当前上下文里的部分。

/** 从 content blocks 抽纯文本（text 块；tool-result 块向内递归）。 */
function blocksText(blocks) {
  const parts = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block === null || typeof block !== "object") continue;
    if (typeof block.text === "string" && block.text.length > 0) parts.push(block.text);
    else if (block.type === "tool-result" && Array.isArray(block.content)) parts.push(blocksText(block.content));
  }
  return parts.join("\n");
}

/**
 * 一个事件 → 一条可检索记录；不属于历史原文的事件返回 null。
 * @param {object} event - 会话日志事件（{type, seq, data}）。
 * @returns {{seq: number, label: string, text: string}|null}
 */
export function entryOfEvent(event) {
  const data = event?.data;
  if (data === null || typeof data !== "object") return null;
  const seq = event.seq;
  switch (event.type) {
    case "user/message": {
      const text = blocksText(data.content);
      return text.length > 0 ? { seq, label: "user", text } : null;
    }
    case "assistant/message": {
      const text = blocksText(data.message?.content);
      return text.length > 0 ? { seq, label: "assistant", text } : null;
    }
    case "tool/call": {
      const name = typeof data.name === "string" ? data.name : "?";
      const args = typeof data.arguments === "string" ? data.arguments : "";
      return { seq, label: `tool_call ${name}`, text: `${name} ${args}`.trim() };
    }
    case "tool/result": {
      const text = blocksText(data.message?.content);
      return text.length > 0 ? { seq, label: "tool_result", text } : null;
    }
    default:
      return null;
  }
}

/** 整个会话日志 → 可检索记录列表（保持 seq 顺序）。读公开快照 snapshotEvents()。 */
export function entriesOfSession(session) {
  const events = typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : [];
  const entries = [];
  for (const event of events) {
    const entry = entryOfEvent(event);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

/** 统一小写、切成检索词：拉丁词/数字串（≥2 字符）+ 中日韩二元组（单字仅在词长为 1 时取）。 */
export function termsOf(input) {
  const text = String(input ?? "").toLowerCase();
  const terms = new Set();
  for (const match of text.matchAll(/[a-z0-9_]+|[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g)) {
    const token = match[0];
    if (/^[a-z0-9_]+$/.test(token)) {
      if (token.length >= 2) terms.add(token);
      continue;
    }
    if (token.length === 1) {
      terms.add(token);
      continue;
    }
    for (let i = 0; i + 1 < token.length; i += 1) terms.add(token.slice(i, i + 2));
  }
  return [...terms];
}

/** 一条记录命中多少检索词（按不同词计一次）。 */
export function hitCount(text, terms) {
  const lower = text.toLowerCase();
  let hits = 0;
  for (const term of terms) if (lower.includes(term)) hits += 1;
  return hits;
}

/** 去掉查询两端成对的引号（模型常带引号搜原句）。 */
export function stripQueryQuotes(input) {
  let text = String(input ?? "").trim();
  const pairs = [['"', '"'], ["'", "'"], ["\u201c", "\u201d"], ["\u300c", "\u300d"], ["\u300e", "\u300f"], ["\u300a", "\u300b"]];
  let changed = true;
  while (changed && text.length >= 2) {
    changed = false;
    for (const [open, close] of pairs) {
      if (text.startsWith(open) && text.endsWith(close)) {
        text = text.slice(1, -1).trim();
        changed = true;
      }
    }
  }
  return text;
}

/**
 * 一条记录的检索得分：原句命中最高，其次按匹配到的检索词长度加权。
 * @returns {{score: number, exact: boolean, hits: number}}
 */
export function scoreEntry(text, needle, terms) {
  const lower = text.toLowerCase();
  if (needle.length > 0 && lower.includes(needle)) return { score: 1000 + needle.length, exact: true, hits: terms.length };
  let hits = 0;
  let weight = 0;
  for (const term of terms) {
    if (lower.includes(term)) {
      hits += 1;
      weight += Math.min(term.length, 4);
    }
  }
  return { score: weight, exact: false, hits };
}

/** 取命中处附近的片段（优先原句，其次检索词；都没有就取开头）。 */
export function snippetOf(text, needle, radius = 200) {
  const lower = text.toLowerCase();
  const exact = String(needle ?? "").trim().toLowerCase();
  let idx = exact.length > 0 ? lower.indexOf(exact) : -1;
  if (idx < 0) {
    for (const term of termsOf(needle)) {
      idx = lower.indexOf(term);
      if (idx >= 0) break;
    }
  }
  if (idx < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/**
 * 在记录里找 query：原句命中优先，其次按检索词加权；同分新的在前。
 * @param {object} [options] - limit 条数上限；radius 片段半径；afterSeq 只看 seq 大于它的记录。
 * @returns {{hits: {seq: number, label: string, match: "exact"|"terms", snippet: string}[], total: number}}
 */
export function searchEntries(entries, query, { limit = 20, radius = 200, afterSeq = 0 } = {}) {
  const needle = stripQueryQuotes(query).toLowerCase();
  const terms = termsOf(query);
  const scored = [];
  for (const entry of entries) {
    if (Number.isFinite(afterSeq) && entry.seq <= afterSeq) continue;
    const { score, exact } = scoreEntry(entry.text, needle, terms);
    if (score <= 0) continue;
    scored.push({ entry, score, exact });
  }
  scored.sort((a, b) => (b.score - a.score) || (b.entry.seq - a.entry.seq));
  const hits = scored.slice(0, Math.max(0, limit)).map(({ entry, exact }) => ({
    seq: entry.seq,
    label: entry.label,
    match: exact ? "exact" : "terms",
    snippet: snippetOf(entry.text, needle.length > 0 ? needle : query, radius),
  }));
  return { hits, total: scored.length };
}

/**
 * 按序号区间取原文记录（两端含）。不是原文的事件已在建表时跳过。
 * @param {object[]} entries - entriesOfSession 的结果。
 * @param {number} from - 起始序号（含）。
 * @param {number} [to] - 结束序号（含）；缺省 = from。
 * @returns {object[]} 按 seq 升序的区间记录。
 */
export function readEntries(entries, from, to) {
  const start = Number.isFinite(Number(from)) ? Math.trunc(Number(from)) : 0;
  const end = Number.isFinite(Number(to)) ? Math.trunc(Number(to)) : start;
  const lower = Math.min(start, end);
  const upper = Math.max(start, end);
  return entries.filter((entry) => entry.seq >= lower && entry.seq <= upper);
}
