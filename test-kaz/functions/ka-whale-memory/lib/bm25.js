// ka-whale-memory —— BM25 相关性检索。
//
// 分词：优先 Intl.Segmenter（中英文都能切）；不可用时回退到
// "非字母数字切分 + CJK 连续段二元组"，保证中文也能检索。

const K1 = 1.2;
const B = 0.75;

let segmenter;

function getSegmenter() {
  if (segmenter === undefined) {
    try {
      segmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter("zh-Hans", { granularity: "word" })
        : null;
    } catch {
      segmenter = null;
    }
  }
  return segmenter;
}

/** 文本 → 词元（小写）。 */
export function tokenize(value) {
  const lower = String(value ?? "").toLowerCase();
  const seg = getSegmenter();
  const tokens = [];
  if (seg !== null) {
    for (const part of seg.segment(lower)) {
      if (part.isWordLike) tokens.push(part.segment);
    }
    return tokens;
  }
  for (const chunk of lower.split(/[^\p{L}\p{N}]+/u)) {
    if (chunk.length === 0) continue;
    if (/[\u4e00-\u9fff]/.test(chunk)) {
      if (chunk.length === 1) tokens.push(chunk);
      else for (let i = 0; i + 1 < chunk.length; i++) tokens.push(chunk.slice(i, i + 2));
    } else {
      tokens.push(chunk);
    }
  }
  return tokens;
}

/**
 * 对一批文档按 BM25 打分（k1=1.2、b=0.75）。
 * @param {string} query - 查询词。
 * @param {Array<{name: string, text: string}>} docs - 文档（text 为正文）。
 * @returns {Array<{name: string, score: number}>} 分数 > 0 的结果，从高到低。
 */
export function scoreBM25(query, docs) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0 || docs.length === 0) return [];
  const docTokens = docs.map((doc) => tokenize(doc.text));
  const total = docTokens.reduce((sum, tokens) => sum + tokens.length, 0);
  const avgdl = total / docTokens.length || 1;
  const df = new Map();
  for (const tokens of docTokens) {
    for (const term of new Set(tokens)) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const n = docs.length;
  const scored = [];
  docs.forEach((doc, index) => {
    const tokens = docTokens[index];
    const tf = new Map();
    for (const term of tokens) tf.set(term, (tf.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of queryTokens) {
      const frequency = tf.get(term) ?? 0;
      if (frequency === 0) continue;
      const documentFrequency = df.get(term) ?? 0;
      const idf = Math.log(1 + (n - documentFrequency + 0.5) / (documentFrequency + 0.5));
      score += (idf * (frequency * (K1 + 1))) / (frequency + K1 * (1 - B + (B * tokens.length) / avgdl));
    }
    if (score > 0) scored.push({ name: doc.name, score });
  });
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored;
}
