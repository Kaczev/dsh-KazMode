// kaz-context-policy —— context_compress（§3.7）：一次压一段，没有 suggest 预览。
//
// 流程：按 drop 的检索词在会话日志里找命中 → 取最密的一簇 → 映到 surface 节点 →
// 向两侧扩到安全边界（不切断工具调用/结果对）→ 尾部按 keep_recent 留出 →
// 交给 dsh 自带的 compactRegion 压成摘要。

import { defineTool } from "@deepseek-ai/dsh-tools";
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from "@deepseek-ai/dsh-compaction";
import { readPressure } from "./reminder.js";
import { entriesOfSession, hitCount, termsOf } from "./session-log.js";

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean", required: true },
    message: { type: "string", required: true },
  },
};

const RESULT_RENDER = (_args, value) => [{ type: "text", text: value.ok ? `success: ${value.message}` : `failure: ${value.message}` }];

function clampInt(value, fallback, min, max) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function eventTypeOf(session, seq) {
  const events = Array.isArray(session?.events) ? session.events : [];
  for (const event of events) if (event?.seq === seq) return event.type;
  return undefined;
}

/**
 * 取命中记录的"最密一簇"：命中之间相隔不超过 gap 条记录就连成一簇；
 * 取命中数最多的一簇（并列取跨度最小、再取更早的那簇）。
 * @param {{index: number, seq: number, score: number}[]} matched - 命中记录（按 index 升序）。
 * @param {number} gap - 允许的间隔。
 * @returns {{group: object[], score: number, span: number}|null}
 */
export function densestCluster(matched, gap = 2) {
  if (!Array.isArray(matched) || matched.length === 0) return null;
  let best = null;
  let start = 0;
  for (let i = 1; i <= matched.length; i += 1) {
    const isBreak = i === matched.length || matched[i].index - matched[i - 1].index > gap;
    if (!isBreak) continue;
    const group = matched.slice(start, i);
    const score = group.reduce((sum, item) => sum + item.score, 0);
    const span = group[group.length - 1].index - group[0].index + 1;
    if (best === null || score > best.score || (score === best.score && span < best.span)) {
      best = { group, score, span };
    }
    start = i;
  }
  return best;
}

/** 按 token 预算求尾部保留边界：从尾向前累加到 keepRecent% 所对应的节点下标。 */
export function retainBoundaryIdx(nodes, totalTokens, keepRecentPercent) {
  if (!Array.isArray(nodes) || nodes.length === 0) return 0;
  const keepTokens = Math.ceil((Number(totalTokens) || 0) * (keepRecentPercent / 100));
  if (keepTokens <= 0) return nodes.length;
  let acc = 0;
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    acc += Number(nodes[i]?.tokens) || 0;
    if (acc >= keepTokens) return i;
  }
  return 0;
}

/**
 * 压缩候选（按顺序尝试）：先整簇，再从得分最高的单条开始逐个退小段——
 * 大锚点跨不过安全边界时，自动退到还能压的最强小段。
 * @param {{index: number, seq: number, score: number}[]} matched - 命中记录。
 * @param {{group: object[]}|null} cluster - 最密一簇。
 * @returns {object[][]} 每组是一个 candidate.group。
 */
export function orderedCandidates(matched, cluster) {
  const candidates = [];
  if (cluster !== null && Array.isArray(cluster.group) && cluster.group.length > 0) candidates.push(cluster.group);
  const ranked = [...matched].sort((a, b) => (b.score - a.score) || (b.seq - a.seq));
  for (const item of ranked) candidates.push([item]);
  return candidates;
}

/**
 * 命中簇 → surface 上的安全区间：起点/终点映到最近的 surface 节点，
 * 再向两侧扩到配对平衡的边界；头部 system/message 节点不参与。
 * @returns {{startIdx: number, endIdx: number}|null}
 */
export function pickRange(session, nodes, cluster) {
  if (!Array.isArray(nodes) || nodes.length === 0 || cluster === null) return null;
  const firstSeq = cluster.group[0].seq;
  const lastSeq = cluster.group[cluster.group.length - 1].seq;
  let startIdx = -1;
  for (let i = 0; i < nodes.length; i += 1) if (nodes[i].seq <= firstSeq) startIdx = i;
  let endIdx = -1;
  for (let i = nodes.length - 1; i >= 0; i -= 1) if (nodes[i].seq >= lastSeq) endIdx = i;
  if (startIdx < 0 || endIdx < 0 || startIdx > endIdx) return null;
  while (startIdx <= endIdx && eventTypeOf(session, nodes[startIdx].seq) === "system/message") startIdx += 1;
  while (startIdx > 0 && !toolPairingBalancedBefore(session, nodes[startIdx].seq)) startIdx -= 1;
  if (!toolPairingBalancedBefore(session, nodes[startIdx].seq)) return null;
  while (endIdx + 1 < nodes.length && !toolPairingBalancedAfter(session, nodes[endIdx].seq)) endIdx += 1;
  if (!toolPairingBalancedAfter(session, nodes[endIdx].seq)) return null;
  return startIdx <= endIdx ? { startIdx, endIdx } : null;
}

export function contextCompressTool(ctx) {
  return defineTool({
    name: "context_compress",
    description:
      "Compress a redundant middle span of this conversation into a summary. Say what to drop (keywords, an exact sentence, or a topic); the tool finds the smallest span covering it, expands to safe boundaries, and compresses that span with the built-in compaction. If the broad match has no safe boundary, it narrows to the strongest matching sub-span. The most recent part stays untouched (keep_recent, default 20%). One span per call; call again for another span.",
    parameters: {
      drop: { type: "string", required: true, description: "What to compress away: keywords, an exact sentence, or a topic description." },
      keep_recent: { type: "integer", description: "Percentage of the current context to keep untouched at the end (default 20, max 90)." },
    },
    output: { schema: RESULT_SCHEMA, render: RESULT_RENDER },
    async execute(args, exec) {
      const agent = exec?.agent;
      const session = agent?.session;
      if (session === undefined || session === null) return { ok: false, message: "this agent has no session" };
      const drop = String(args?.drop ?? "").trim();
      if (drop.length === 0) return { ok: false, message: "drop is required" };
      const keepRecent = clampInt(args?.keep_recent, 20, 0, 90);
      const terms = termsOf(drop);
      const matched = [];
      entriesOfSession(session).forEach((entry, index) => {
        const score = hitCount(entry.text, terms);
        if (score > 0) matched.push({ index, seq: entry.seq, score });
      });
      if (matched.length === 0) return { ok: false, message: `nothing in this conversation matches "${drop}"` };
      const cluster = densestCluster(matched);
      const meter = ctx.get("tokenMeter");
      const compaction = ctx.get("compaction");
      if (meter === undefined || typeof meter.measure !== "function") return { ok: false, message: "the token meter is unavailable" };
      if (compaction === undefined || typeof compaction.compactRegion !== "function") return { ok: false, message: "the compaction provider is unavailable" };
      const measurement = meter.measure(session);
      const nodes = measurement?.nodes;
      const retainIdx = retainBoundaryIdx(nodes, measurement.totalTokens, keepRecent);
      let chosen = null;
      for (const group of orderedCandidates(matched, cluster)) {
        const range = pickRange(session, nodes, { group });
        if (range === null) continue;
        let endIdx = Math.min(range.endIdx, retainIdx - 1);
        while (endIdx >= range.startIdx && !toolPairingBalancedAfter(session, nodes[endIdx].seq)) endIdx -= 1;
        if (endIdx < range.startIdx) continue;
        chosen = { startIdx: range.startIdx, endIdx };
        break;
      }
      if (chosen === null) {
        return { ok: false, message: `no safe compressible span found for "${drop}"; try a narrower target or a smaller keep_recent` };
      }
      const startSeq = nodes[chosen.startIdx].seq;
      const endSeq = nodes[chosen.endIdx].seq;
      const spanTokens = nodes.slice(chosen.startIdx, chosen.endIdx + 1).reduce((sum, node) => sum + (Number(node?.tokens) || 0), 0);
      try {
        await compaction.compactRegion(startSeq, endSeq, agent, exec?.signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const reason = /active compaction/i.test(message)
          ? "a compaction is already in progress"
          : /balanced boundary/.test(message)
            ? "the located span is not a safe boundary"
            : message;
        return { ok: false, message: reason };
      }
      const pressure = readPressure(ctx, session);
      const usage = pressure === null ? "" : `; context usage ~${pressure.percent}%`;
      return { ok: true, message: `compressed seq ${startSeq}-${endSeq} (~${spanTokens} tokens)${usage}` };
    },
  });
}
