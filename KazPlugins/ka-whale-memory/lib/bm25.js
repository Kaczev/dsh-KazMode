/**
 * BM25 keyword scoring over plaintext memory records, built on the vendored
 * okapibm25 library (./okapibm25.js, MIT — see LICENSE-okapibm25). A pure
 * function of the store — no model call — so recall is deterministic and a
 * miss is explainable as "no keyword match".
 *
 * Scoring = okapibm25's BM25(documents, keywords, { k1, b }) over the raw
 * document strings. The query is split by tokenize() (English/number runs
 * stay whole, each CJK ideograph becomes its own term), so Chinese queries
 * keep working exactly like before; okapibm25 matches each term as a
 * substring of the document.
 *
 * Edge cases handled here (the vendored library assumes a non-empty corpus
 * with at least one `\w+` token somewhere):
 *   * empty corpus / empty query → all-zero scores;
 *   * pure-CJK corpus (every document has 0 `\w+` tokens): okapibm25's length
 *     normalization divides by 0 → NaN, so we fall back to the same BM25
 *     formula with length normalization disabled (b effectively 0);
 *   * k1 = 0 or b = 0: the vendored library treats 0 as "unset" and silently
 *     substitutes the defaults, so 0 is routed through the same fallback path.
 *
 * Async variant (bm25ScoresAsync) yields to the event loop before/after the
 * computation and between chunks of documents, so memory_search never blocks
 * the harness main thread even with ~1000 memories.
 */
import BM25, { getWordCount, getTermFrequency, getIDF } from "./okapibm25.js";

/** Split text into lowercase terms: English/number runs stay whole, each CJK ideograph its own term. */
export function tokenize(text) {
  return text.toLowerCase().match(/[a-z0-9]+|[\u3400-\u9fff]/g) ?? [];
}

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

/** Corpus-wide stats (lengths / average length / idf table), shared by both scoring paths. */
function corpusStats(terms, docs, opts = {}) {
  const k1 = typeof opts.k1 === "number" && Number.isFinite(opts.k1) ? opts.k1 : 1.2;
  const b = typeof opts.b === "number" && Number.isFinite(opts.b) ? opts.b : 0.75;
  const lengths = docs.map(getWordCount);
  const averageLength = lengths.reduce((sum, n) => sum + n, 0) / Math.max(1, docs.length);
  // 纯 CJK 语料（\w+ 全为 0）时长度归一化会 0/0 → NaN：禁用（等效 b=0）。
  const effectiveB = averageLength === 0 ? 0 : b;
  const effectiveAvg = averageLength === 0 ? 1 : averageLength;
  const idf = new Map();
  for (const term of terms) idf.set(term, getIDF(term, docs));
  return { k1, effectiveB, effectiveAvg, lengths, idf };
}

/** BM25 contribution of one query term to one document (0 when the term is absent). */
function scoreTerm(term, idf, doc, docLength, k1, effectiveB, effectiveAvg) {
  const tf = getTermFrequency(term, doc);
  if (tf === 0) return 0;
  const denominator = tf + k1 * (1 - effectiveB + (effectiveB * docLength) / effectiveAvg);
  return (idf * (tf * (k1 + 1))) / denominator;
}

/** BM25 score of one document against all query terms. */
function scoreDoc(terms, idf, doc, docLength, k1, effectiveB, effectiveAvg) {
  let score = 0;
  for (const term of terms) {
    score += scoreTerm(term, idf.get(term) ?? 0, doc, docLength, k1, effectiveB, effectiveAvg);
  }
  return score;
}

/** Synchronous whole-corpus scoring (used by the fallback path of bm25Scores). */
function scoreAll(terms, docs, opts) {
  const { k1, effectiveB, effectiveAvg, lengths, idf } = corpusStats(terms, docs, opts);
  return docs.map((doc, index) => scoreDoc(terms, idf, doc, lengths[index], k1, effectiveB, effectiveAvg));
}

/**
 * Score one query against each document with BM25, in document order.
 * Uses okapibm25's BM25() directly on the common path; falls back to the same
 * formula when the library would divide by zero or silently ignore 0 constants.
 */
export function bm25Scores(query, docs, opts = {}) {
  const terms = tokenize(query);
  if (docs.length === 0 || terms.length === 0) return docs.map(() => 0);
  const k1 = typeof opts.k1 === "number" && Number.isFinite(opts.k1) ? opts.k1 : 1.2;
  const b = typeof opts.b === "number" && Number.isFinite(opts.b) ? opts.b : 0.75;
  const averageLength = docs.reduce((sum, doc) => sum + getWordCount(doc), 0) / docs.length;
  if (averageLength > 0 && k1 > 0 && b > 0) {
    return BM25(docs, terms, { k1, b });
  }
  return scoreAll(terms, docs, { k1, b });
}

/**
 * Async BM25 scoring: same scores as {@link bm25Scores}, but releases the
 * event loop before/after the computation and between chunks of documents, so
 * scoring ~1000 memories never blocks the harness.
 */
export async function bm25ScoresAsync(query, docs, opts = {}) {
  await yieldToEventLoop();
  const terms = tokenize(query);
  if (docs.length === 0 || terms.length === 0) return docs.map(() => 0);
  const { k1, effectiveB, effectiveAvg, lengths, idf } = corpusStats(terms, docs, opts);
  const scores = new Array(docs.length);
  const CHUNK = 200;
  for (let start = 0; start < docs.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, docs.length);
    for (let index = start; index < end; index += 1) {
      scores[index] = scoreDoc(terms, idf, docs[index], lengths[index], k1, effectiveB, effectiveAvg);
    }
    if (end < docs.length) await yieldToEventLoop();
  }
  await yieldToEventLoop();
  return scores;
}
