// kaz-context-policy —— context_compress（§3.7）：只做"框选"，一次压一段，没有 suggest 预览。
//
// 模型从 context_search / context_read 的输出里拿到 `#seq`，用 from_seq / to_seq 指出
// 要压掉的两点；区间收进安全边界（不切断工具调用/结果对、不夹 system/message、不进保留带）
// 后交给 dsh 自带的 compactRegion 压成摘要。
// 省略一侧 = 用那一侧的自然边界（起点 = 可压中段开头，终点 = 保留带边界），
// 所以"一个点都不给"就等于把可压中段整段收掉。

import { defineTool } from "@deepseek-ai/dsh-tools";
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from "@deepseek-ai/dsh-compaction";
import { readPressure } from "./reminder.js";

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
 * 框选区间：把 [fromSeq, toSeq] 收进可压中段 [起点, 终点]。
 * 起点 = 跳过头部 system/message 后的第一个配对平衡切点；终点 = 尾部保留带之前、
 * 且配对平衡的最后一个节点。两边都必须给（缺一边直接返回 null）：
 * 区间先收进这两点之间，再向内收——起点后移到配对平衡处、终点前移到配对平衡处，
 * 撞上 system/message 就退到它前面。
 * @returns {{startIdx: number, endIdx: number}|null}
 */
export function foldBand(session, nodes, retainIdx, fromSeq, toSeq) {
  if (!Array.isArray(nodes) || nodes.length === 0) return null;
  if (!(Number(fromSeq) > 0) || !(Number(toSeq) > 0)) return null;
  const types = eventTypesOf(session, nodes);
  const isSystem = (idx) => types.get(nodes[idx].seq) === "system/message";
  let startIdx = 0;
  while (startIdx < nodes.length && isSystem(startIdx)) startIdx += 1;
  while (startIdx < nodes.length && !toolPairingBalancedBefore(session, nodes[startIdx].seq)) startIdx += 1;
  if (startIdx >= nodes.length) return null;
  let endIdx = Math.min(retainIdx - 1, nodes.length - 1);
  while (endIdx >= startIdx && !toolPairingBalancedAfter(session, nodes[endIdx].seq)) endIdx -= 1;
  if (endIdx < startIdx) return null;

  // 收进 [fromSeq, toSeq]，再向安全边界内收。
  {
    let idx = -1;
    for (let i = startIdx; i <= endIdx; i += 1) {
      if (nodes[i].seq >= fromSeq) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return null;
    startIdx = idx;
    while (startIdx <= endIdx && !toolPairingBalancedBefore(session, nodes[startIdx].seq)) startIdx += 1;
    if (startIdx > endIdx) return null;
  }
  {
    let idx = -1;
    for (let i = endIdx; i >= startIdx; i -= 1) {
      if (nodes[i].seq <= toSeq) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return null;
    endIdx = idx;
    while (endIdx >= startIdx && !toolPairingBalancedAfter(session, nodes[endIdx].seq)) endIdx -= 1;
    if (endIdx < startIdx) return null;
  }

  // 区间里不许出现 system/message（平台只允许"恰好针对该节点"的改写）：
  // 撞上就退到它前面最近的平衡切点。
  for (let i = startIdx; i <= endIdx; i += 1) {
    if (isSystem(i)) {
      endIdx = i - 1;
      while (endIdx >= startIdx && !toolPairingBalancedAfter(session, nodes[endIdx].seq)) endIdx -= 1;
      break;
    }
  }
  if (endIdx < startIdx) return null;
  return { startIdx, endIdx };
}

export function contextCompressTool(ctx) {
  return defineTool({
    name: "context_compress",
    description:
      "Compress a redundant middle span of this conversation into a summary. Box the span with `from_seq` and `to_seq` — both are required, and they are the `#seq` numbers shown in context_search / context_read output. The span is snapped to safe boundaries and never cuts a tool call/result pair. Only the compactable middle is reachable: the protected head (system messages), the kept-recent tail (keep_recent, default 20%), and spans that were already compacted away cannot be re-compressed. One span per call; call again for another span.",
    parameters: {
      from_seq: { type: "integer", required: true, description: "First seq of the span to fold (the `#seq` shown in context_search / context_read output)." },
      to_seq: { type: "integer", required: true, description: "Last seq of the span to fold (the `#seq` shown in context_search / context_read output)." },
      keep_recent: { type: "integer", description: "Percentage of the current context to keep untouched at the end (default 20, max 90)." },
    },
    output: { schema: RESULT_SCHEMA, render: RESULT_RENDER },
    async execute(args, exec) {
      const agent = exec?.agent;
      const session = agent?.session;
      if (session === undefined || session === null) return { ok: false, message: "this agent has no session" };
      const keepRecent = clampInt(args?.keep_recent, 20, 0, 90);
      const fromSeq = clampInt(args?.from_seq, 0, 0, Number.MAX_SAFE_INTEGER);
      const toSeq = clampInt(args?.to_seq, 0, 0, Number.MAX_SAFE_INTEGER);
      if (fromSeq <= 0 || toSeq <= 0) {
        return { ok: false, message: "from_seq and to_seq are both required — give the two #seq ends of the span to compress" };
      }
      if (fromSeq > toSeq) {
        return { ok: false, message: `from_seq (${fromSeq}) is after to_seq (${toSeq}) — swap the two ends of the box` };
      }
      const meter = ctx.get("tokenMeter");
      const compaction = ctx.get("compaction");
      if (meter === undefined || typeof meter.measure !== "function") return { ok: false, message: "the token meter is unavailable" };
      if (compaction === undefined || typeof compaction.compactRegion !== "function") return { ok: false, message: "the compaction provider is unavailable" };
      const measurement = meter.measure(session);
      const nodes = measurement?.nodes;
      if (!Array.isArray(nodes) || nodes.length === 0) return { ok: false, message: "the token meter reported no surface nodes" };
      const retainIdx = retainBoundaryIdx(nodes, measurement.totalTokens, keepRecent);
      const chosen = foldBand(session, nodes, retainIdx, fromSeq, toSeq);
      if (chosen === null) {
        return {
          ok: false,
          message: `nothing foldable inside [${fromSeq} .. ${toSeq}] after safe-boundary snapping — the box may sit inside the protected head, the kept-recent tail, or an already-compacted span`,
        };
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
