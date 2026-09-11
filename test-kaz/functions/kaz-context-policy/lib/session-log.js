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

/** 取命中处附近的片段（优先原句，其次检索词；都没有就取开头）。 */
export function snippetOf(text, needle, radius = 120) {
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
 * 在记录里找 query；原句命中优先，其次按检索词命中。
 * @returns {{seq: number, label: string, match: "exact"|"terms", snippet: string}[]}
 */
export function searchEntries(entries, query, { limit = 20, radius = 120 } = {}) {
  const needle = String(query ?? "").trim().toLowerCase();
  const terms = termsOf(query);
  const hits = [];
  for (const entry of entries) {
    if (hits.length >= limit) break;
    const exact = needle.length > 0 && entry.text.toLowerCase().includes(needle);
    const matched = exact || (terms.length > 0 && hitCount(entry.text, terms) > 0);
    if (!matched) continue;
    hits.push({ seq: entry.seq, label: entry.label, match: exact ? "exact" : "terms", snippet: snippetOf(entry.text, query, radius) });
  }
  return hits;
}
