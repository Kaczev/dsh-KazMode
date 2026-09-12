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

/**
 * 读 surface 节点对应的事件类型（seq → type）。
 * 注意：平台的 Session 没有 `session.events` 这个属性，必须用 `snapshotEvents()`——
 * 读错属性会让"跳过头部 system/message"永远失效，压缩区间就会扩到节点 0。
 */
function eventTypesOf(session, nodes) {
  const wanted = new Set();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node !== null && typeof node === "object" && typeof node.seq === "number") wanted.add(node.seq);
  }
  const types = new Map();
  const events = typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : [];
  for (const event of events) {
    if (event !== null && typeof event === "object" && wanted.has(event.seq)) types.set(event.seq, event.type);
  }
  return types;
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
 * 命中簇 → surface 上的安全区间。
 * 硬约束：区间绝不覆盖开头的 system/message 节点——系统提示词那类只能"恰好针对该节点"
 * 改写，被一个区间覆盖会被 surface 整段拒绝（整次压缩就白费）。所以先算出"可压下界"
 * minIdx（跳过头部 system/message 且配对平衡），左扩只允许退到 minIdx 为止。
 * @returns {{startIdx: number, endIdx: number}|null}
 */
export function pickRange(session, nodes, cluster) {
  if (!Array.isArray(nodes) || nodes.length === 0 || cluster === null) return null;
  const types = eventTypesOf(session, nodes);
  const isSystem = (idx) => types.get(nodes[idx].seq) === "system/message";

  // 可压下界：跳过开头的 system/message，并要求该处是配对平衡的切点。
  let minIdx = 0;
  while (minIdx < nodes.length && isSystem(minIdx)) minIdx += 1;
  while (minIdx < nodes.length && !toolPairingBalancedBefore(session, nodes[minIdx].seq)) minIdx += 1;

  const firstSeq = cluster.group[0].seq;
  const lastSeq = cluster.group[cluster.group.length - 1].seq;
  let startIdx = -1;
  for (let i = 0; i < nodes.length; i += 1) if (nodes[i].seq <= firstSeq) startIdx = i;
  let endIdx = -1;
  for (let i = nodes.length - 1; i >= 0; i -= 1) if (nodes[i].seq >= lastSeq) endIdx = i;
  if (startIdx < 0 || endIdx < 0 || startIdx > endIdx) return null;

  if (startIdx < minIdx) startIdx = minIdx;
  while (startIdx > minIdx && !toolPairingBalancedBefore(session, nodes[startIdx].seq)) startIdx -= 1;
  while (startIdx <= endIdx && isSystem(startIdx)) startIdx += 1;
  if (startIdx > endIdx) return null;
  if (!toolPairingBalancedBefore(session, nodes[startIdx].seq)) return null;

  while (endIdx + 1 < nodes.length && !toolPairingBalancedAfter(session, nodes[endIdx].seq)) endIdx += 1;
  if (!toolPairingBalancedAfter(session, nodes[endIdx].seq)) return null;

  // 区间里不许再出现 system/message（头部已跳过；中间若有，放弃这个候选，交给下一组）。
  for (let i = startIdx; i <= endIdx; i += 1) if (isSystem(i)) return null;
  return startIdx <= endIdx ? { startIdx, endIdx } : null;
}

/**
 * 整段硬折叠的区间：可压中段 [起点, 终点]。
 * 起点 = 跳过头部 system/message 后的第一个配对平衡切点；终点 = 尾部保留带之前、
 * 且配对平衡的最后一个节点。给了 amount（token）时，在不超过它的范围里尽量多折。
 * @returns {{startIdx: number, endIdx: number}|null}
 */
export function foldBand(session, nodes, retainIdx, amount = 0) {
  if (!Array.isArray(nodes) || nodes.length === 0) return null;
  const types = eventTypesOf(session, nodes);
  const isSystem = (idx) => types.get(nodes[idx].seq) === "system/message";
  let startIdx = 0;
  while (startIdx < nodes.length && isSystem(startIdx)) startIdx += 1;
  while (startIdx < nodes.length && !toolPairingBalancedBefore(session, nodes[startIdx].seq)) startIdx += 1;
  if (startIdx >= nodes.length) return null;
  let endIdx = Math.min(retainIdx - 1, nodes.length - 1);
  while (endIdx >= startIdx && !toolPairingBalancedAfter(session, nodes[endIdx].seq)) endIdx -= 1;
  if (endIdx < startIdx) return null;
  if (amount > 0) {
    let acc = 0;
    let cut = startIdx - 1;
    for (let i = startIdx; i <= endIdx; i += 1) {
      acc += Number(nodes[i]?.tokens) || 0;
      if (acc > amount) break;
      cut = i;
    }
    if (cut < startIdx) return null;
    endIdx = cut;
    while (endIdx >= startIdx && !toolPairingBalancedAfter(session, nodes[endIdx].seq)) endIdx -= 1;
    if (endIdx < startIdx) return null;
  }
  return { startIdx, endIdx };
}

export function contextCompressTool(ctx) {
  return defineTool({
    name: "context_compress",
    description:
      "Compress a redundant middle span of this conversation into a summary. Two ways: give `drop` (keywords, an exact sentence, or a topic) and the tool finds the smallest span covering it; or give no `drop` (optionally `amount` in tokens) and the tool folds the largest safe span of the compactable middle in one call. Spans expand to safe boundaries and never cut a tool call/result pair. Only the compactable middle is reachable: the protected head (system messages), the kept-recent tail (keep_recent, default 20%), and spans that were already compacted away cannot be re-compressed. One span per call; call again for another span.",
    parameters: {
      drop: { type: "string", description: "What to compress away: keywords, an exact sentence, or a topic description. Omit to fold the largest safe span instead." },
      amount: { type: "integer", description: "Only without `drop`: roughly how many tokens to fold (omit to fold as much as the compactable middle allows)." },
      keep_recent: { type: "integer", description: "Percentage of the current context to keep untouched at the end (default 20, max 90)." },
    },
    output: { schema: RESULT_SCHEMA, render: RESULT_RENDER },
    async execute(args, exec) {
      const agent = exec?.agent;
      const session = agent?.session;
      if (session === undefined || session === null) return { ok: false, message: "this agent has no session" };
      const drop = String(args?.drop ?? "").trim();
      const keepRecent = clampInt(args?.keep_recent, 20, 0, 90);
      const amount = clampInt(args?.amount, 0, 0, Number.MAX_SAFE_INTEGER);
      const terms = drop.length > 0 ? termsOf(drop) : [];
      const matched = [];
      if (drop.length > 0) {
        entriesOfSession(session).forEach((entry, index) => {
          const score = hitCount(entry.text, terms);
          if (score > 0) matched.push({ index, seq: entry.seq, score });
        });
        if (matched.length === 0) return { ok: false, message: `nothing in this conversation matches "${drop}"` };
      }
      const cluster = drop.length > 0 ? densestCluster(matched) : null;
      const meter = ctx.get("tokenMeter");
      const compaction = ctx.get("compaction");
      if (meter === undefined || typeof meter.measure !== "function") return { ok: false, message: "the token meter is unavailable" };
      if (compaction === undefined || typeof compaction.compactRegion !== "function") return { ok: false, message: "the compaction provider is unavailable" };
      const measurement = meter.measure(session);
      const nodes = measurement?.nodes;
      if (!Array.isArray(nodes) || nodes.length === 0) return { ok: false, message: "the token meter reported no surface nodes" };
      const retainIdx = retainBoundaryIdx(nodes, measurement.totalTokens, keepRecent);
      let chosen = null;
      if (drop.length === 0) {
        // 整段硬折叠：不指定内容，直接把可压中段里最大的一段压掉（旧 kaz 的"硬压"行为）。
        chosen = foldBand(session, nodes, retainIdx, amount);
        if (chosen === null) {
          return {
            ok: false,
            message:
              "nothing foldable: the protected head, the kept-recent tail and already-compacted spans leave no safe span — try a smaller keep_recent, or start a new conversation",
          };
        }
      } else {
        let sawTail = false;
        let sawUnsafe = false;
        for (const group of orderedCandidates(matched, cluster)) {
          const range = pickRange(session, nodes, { group });
          if (range === null) {
            sawUnsafe = true;
            continue;
          }
          if (range.startIdx >= retainIdx) {
            sawTail = true;
            continue;
          }
          let endIdx = Math.min(range.endIdx, retainIdx - 1);
          while (endIdx >= range.startIdx && !toolPairingBalancedAfter(session, nodes[endIdx].seq)) endIdx -= 1;
          if (endIdx < range.startIdx) {
            sawTail = true;
            continue;
          }
          chosen = { startIdx: range.startIdx, endIdx };
          break;
        }
        if (chosen === null) {
          const reason = sawTail
            ? `the matches sit inside the retained recent part (keep_recent=${keepRecent}%) — retry with a smaller keep_recent, or call again without drop to fold the largest span`
            : sawUnsafe
              ? "the matching spans are not safely compressible (protected head, already-compacted region, or an unbalanced tool pair) — call again without drop to fold the largest span"
              : "no matching span";
          return { ok: false, message: `nothing safely compressible for "${drop}": ${reason}` };
        }
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
