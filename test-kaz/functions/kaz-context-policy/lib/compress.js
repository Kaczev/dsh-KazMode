// kaz-context-policy —— context_compress（§3.7）：只做"框选"，一次压一段，没有 suggest 预览。
//
// 模型从 context_search / context_read 的输出里拿到 `#seq`，用 from_seq / to_seq 指出
// 要压掉的两点；区间收进安全边界（不切断工具调用/结果对、不夹 system/message、不进保留带）
// 后交给 dsh 自带的 compactRegion 压成摘要。
//
// **`nodes` 是位置序列，不是按 seq 排序的**：压缩与删除都用 `replace` 把新节点留在被遮蔽
// 区间原来的位置上，而新节点的 seq 是全场最大的那一档。因此"按 seq 收拢区间"必须靠扫描，
// 不能拿 `nodes[i].seq >= fromSeq` 当下标换算——见 foldBand 的说明。
// 保留带同理按**位置**取：尾部最近 `keep_recent` 个节点。
// 省略一侧 = 用那一侧的自然边界（起点 = 可压中段开头，终点 = 保留带边界），
// 所以"一个点都不给"就等于把可压中段整段收掉。
//
// **两条通道的分工（设计，不是副作用）**：真正发给模型的是**压缩后的**上下文（surface）；
// `context_search` / `context_read` 读的是**追加式事件日志**，因此**能查到压缩之前的原文**。
// 这是刻意的——对话上下文太重要，压缩只换空间，不丢原文。
// 因此 `delete: true` 也是一个道理：它让那段**不再进入模型输入**（换成空占位节点），
// 但**原文仍然可检索**。想彻底不可检索，本工具做不到，平台也没有这样的能力。

import { defineTool } from "@deepseek-ai/dsh-tools";
import { createSystemMessage } from "@deepseek-ai/dsh-llm";
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from "@deepseek-ai/dsh-compaction";
import { readPressure } from "./reminder.js";

/** 默认保留带：从尾部往前保留的节点个数。 */
export const DEFAULT_KEEP_RECENT_NODES = 150;
/** 保留带上限（防止把整段都保护起来）。 */
export const MAX_KEEP_RECENT_NODES = 2000;

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean", required: true },
    message: { type: "string", required: true },
  },
};

const RESULT_RENDER = (_args, value) => [{ type: "text", text: value.ok ? `success: ${value.message}` : `failure: ${value.message}` }];

/**
 * 取当前 turn / step：替换事件（system/message）需要这两个字段，而工具的 exec 里没有。
 * 从事件流尾部往前找最近一条 `step/start`（其次 `turn/start`）——工具调用必然发生在
 * 一个已经开始的 step 之内，所以这条一定存在。
 * @returns {{turn: number, step: number}|null}
 */
export function currentTurnStep(session) {
  const events = typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : [];
  let turn = null;
  let step = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event === null || typeof event !== "object") continue;
    if (turn === null && event.type === "turn/start") {
      turn = typeof event.data?.turn === "number" ? event.data.turn : null;
      if (turn !== null && step > 0) break;
    }
    if (step === 0 && event.type === "step/start") {
      step = typeof event.data?.step === "number" ? event.data.step : 0;
      if (turn === null && typeof event.data?.turn === "number") turn = event.data.turn;
      if (turn !== null) break;
    }
  }
  return turn === null ? null : { turn, step };
}

/**
 * 就地"删除"一段 surface 节点：用**空内容的 system/message** 作为替换事件。
 *
 * 平台没有删除操作，`SurfaceOp` 只有 `append` 与 `replace`。而投射规则（dsh-session
 * `surface.js` deriveEventMessage）规定：**空内容的 system/message 落在 surface 上、却不产生
 * 任何消息**。所以"replace 成空 system/message" = 该段的内容彻底消失，只留一个占位节点。
 *
 * 约束（都在 session 层校验）：
 *   * `sourceEventSeqs` 必须是**全部被遮蔽节点**的超集（非空、唯一、都早于新事件）；
 *   * 空内容只对 system/assistant 生效——空的 user/message 仍会产生一条空消息，不省空间。
 * @param {object} session - 目标会话。
 * @param {number[]} shadowedSeqs - 段内全部 surface 节点的 seq（按 surface 顺序）。
 * @returns {number} 新事件的 seq。
 */
export function deleteSpan(session, shadowedSeqs) {
  const turnStep = currentTurnStep(session);
  if (turnStep === null) throw new Error("cannot determine the current turn/step for a delete replacement");
  const event = session.append(
    "system/message",
    { turn: turnStep.turn, step: turnStep.step, message: createSystemMessage("", "kaz-context-policy") },
    {
      surfaceOp: { op: "replace", startSeq: shadowedSeqs[0], endSeq: shadowedSeqs[shadowedSeqs.length - 1] },
      sourceEventSeqs: [...shadowedSeqs],
    },
  );
  return event.seq;
}

function clampInt(value, fallback, min, max) {  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * 读 surface 节点的事实：事件类型（seq → type），以及"压缩摘要"节点的 seq 集合。
 * 摘要节点（compaction checkpoint：`source.plugin === "compact"`）带着**新的**大序号插在
 * 被压区间的位置上——它破坏"节点表里序号递增"的假设。它**可以**被再次压掉（口径见下）。
 * 注意：平台的 Session 没有 `session.events`，必须用 `snapshotEvents()`。
 */
function nodeFactsOf(session, nodes) {
  const wanted = new Set();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node !== null && typeof node === "object" && typeof node.seq === "number") wanted.add(node.seq);
  }
  const types = new Map();
  const events = typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : [];
  for (const event of events) {
    if (event === null || typeof event !== "object" || !wanted.has(event.seq)) continue;
    types.set(event.seq, event.type);
  }
  return { types };
}

/**
 * 求尾部保留边界：保留带 = **从最后一个节点往前数的最近 N 个节点**。
 *
 * 口径：**按节点计数**，不是按 token、也不是占窗口的百分比。
 * 这样"保留多少"是可预测的——模型知道自己留下的就是最近 N 条内容，
 * 而不会像百分比那样随尾部内容的轻重忽多忽少。
 *
 * 注意这是**位置**口径：`nodes` 是 surface 的当前位置序列，**不是按 seq 排序的**
 * （一次 `replace` 会把新节点留在被遮蔽区间的位置上，而它的 seq 比周围都大），
 * 所以"最后 N 个节点"≠"seq 最大的 N 个"。保留带按位置取，正是我们想要的语义。
 * @param {object[]} nodes - surface 节点。
 * @param {number} keepRecentNodes - 从尾部保留的节点个数（0 = 不保留）。
 * @returns {number} 保留带的起始下标（此下标及其后的节点不可动）。
 */
export function retainBoundaryIdx(nodes, keepRecentNodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return 0;
  const keep = Math.max(0, Math.trunc(Number(keepRecentNodes) || 0));
  if (keep <= 0) return nodes.length;
  return Math.max(0, nodes.length - keep);
}

/**
 * 框选区间：把 [fromSeq, toSeq] 收进可压中段。
 * **只保护两处**：头部连续的 system/message（起点之后才算）与尾部保留带（终点之前才算）；
 * 两侧落点都必须是配对平衡的切点，且区间内不得出现 system/message。
 * 已压过的摘要节点**不设保护**——它可以被再次压掉（把摘要换得更紧）。
 *
 * **为什么不能用 `nodes[i].seq` 当"下标 → 序号"来收拢**（这条曾经是 bug 的根源）：
 * `nodes` 是 surface 的**位置**序列，一次 `replace`（压缩摘要、或 `delete: true` 留下的空
 * system/message 占位）会把新节点留在**被遮蔽区间原来的位置**上，而它的 seq 是全场最大的
 * 那一档。于是"第一个 seq >= fromSeq 的节点"会跳到某个**又大又旧**的占位/摘要节点上，
 * 端点随即被"区间内不得夹 system"的规则裁成空 → 老区间永远折不动。
 * 实测：本会话对 [4600..5100] 的三次请求（含 `keep_recent: 60`）都因此被拒，
 * 而按 seq 收拢后同一区间是 273 个可折节点。
 *
 * 所以收拢规则改成：
 *   1. 在**可动窗口**（头部 system 之后、保留带之前）里，凡 seq 落在 [fromSeq, toSeq] 的节点
 *      都算目标，取其中第一个与最后一个；
 *   2. 起点回退到**最近的**平衡切点（`balancedBefore`），终点前推到最近的平衡切点
 *      （`balancedAfter`）——只走最近一步，不把区间撑大；
 *   3. 区间内若夹着受保护节点（头部 system / 空占位），取**其中最长的一段连续可折区**，
 *      而不是把整段裁掉。
 * @returns {{startIdx: number, endIdx: number}|null}
 */
export function foldBand(session, nodes, retainIdx, fromSeq, toSeq) {
  if (!Array.isArray(nodes) || nodes.length === 0) return null;
  if (!(Number(fromSeq) > 0) || !(Number(toSeq) > 0)) return null;
  const { types } = nodeFactsOf(session, nodes);
  const isSystem = (idx) => types.get(nodes[idx].seq) === "system/message";
  // 平衡查询对"不在当前 surface 上"的 seq 会抛错——按"此处不可切"处理，不要让它掀掉整个框选。
  const balancedBefore = (idx) => {
    try {
      return toolPairingBalancedBefore(session, nodes[idx].seq);
    } catch {
      return false;
    }
  };
  const balancedAfter = (idx) => {
    try {
      return toolPairingBalancedAfter(session, nodes[idx].seq);
    } catch {
      return false;
    }
  };

  // 1) 可动窗口 = 头部连续 system 之后 .. 保留带之前。
  let winStart = 0;
  while (winStart < nodes.length && isSystem(winStart)) winStart += 1;
  const winEnd = Math.min(retainIdx - 1, nodes.length - 1);
  if (winEnd < winStart) return null;

  // 2) 窗口里 seq 落在 [fromSeq, toSeq] 的节点范围。
  let first = -1;
  let last = -1;
  for (let i = winStart; i <= winEnd; i += 1) {
    const seq = nodes[i].seq;
    if (seq < fromSeq || seq > toSeq) continue;
    if (first < 0) first = i;
    last = i;
  }
  if (first < 0 || last < first) return null;

  // 3) 端点外扩到最近的平衡切点（起点往前找、终点往后找，方向不能反）。
  let lo = first;
  for (let i = first - 1; i >= winStart; i -= 1) {
    if (balancedBefore(i)) {
      lo = i;
      break;
    }
  }
  let hi = last;
  for (let i = last + 1; i <= winEnd; i += 1) {
    if (balancedAfter(i)) {
      hi = i;
      break;
    }
  }
  if (hi < lo) return null;

  // 4) 受保护节点不能进区间：取 [lo..hi] 里最长的一段连续可折区。
  let bestStart = -1;
  let bestEnd = -1;
  let runStart = -1;
  for (let i = lo; i <= hi + 1; i += 1) {
    const blocked = i > hi || isSystem(i);
    if (blocked) {
      if (runStart >= 0) {
        bestStart = runStart;
        bestEnd = i - 1;
        runStart = -1;
      }
    } else if (runStart < 0) {
      runStart = i;
    }
  }
  if (bestStart < 0) return null;

  // 5) 这一段的两端也必须落在平衡切点上。
  let startIdx = bestStart;
  while (startIdx <= bestEnd && !balancedBefore(startIdx)) startIdx += 1;
  let endIdx = bestEnd;
  while (endIdx >= startIdx && !balancedAfter(endIdx)) endIdx -= 1;
  if (endIdx < startIdx) return null;
  return { startIdx, endIdx };
}

export function contextCompressTool(ctx) {
  return defineTool({
    name: "context_compress",
    description:
      "Compress a redundant middle span of this conversation into a summary — or, with `delete: true`, take it out of view entirely. Box the span with `from_seq` and `to_seq`; both are required and are the `#seq` numbers shown in context_search / context_read output. The span is snapped to safe boundaries and never cuts a tool call/result pair. Two regions are off limits: the protected head (the opening system message) and the kept-recent tail (the newest `keep_recent` nodes, counted back from the end, default 150). Note that after earlier folds the surface order and the `#seq` order disagree, so key a span off `context_hotspots` (or read it with context_read) rather than off what a seq number used to hold. Everything between the two limits is foldable, including spans that were compacted before — folding a summary again replaces it with a tighter one. Either way only what reaches you changes: the record keeps the original text, so context_search and context_read can always read it back. Deleting is nevertheless the riskier of the two — with no summary left you lose the thread until you think to search for it, so prefer compressing, and delete only spans you are sure are finished.",
    parameters: {
      from_seq: { type: "integer", required: true, description: "First seq of the span to fold (the `#seq` shown in context_search / context_read output)." },
      to_seq: { type: "integer", required: true, description: "Last seq of the span to fold (the `#seq` shown in context_search / context_read output)." },
      keep_recent: { type: "integer", description: "How many of the newest surface nodes to leave untouched, counted back from the end (default 150, max 2000). This is a node count, not a percentage: the last N visible items stay exactly as they are." },
      delete: { type: "boolean", description: "Leave no summary at all, so the span stops reaching you: it is replaced by an empty placeholder (default false, which summarises instead). Use sparingly — you lose the span from view, and only context_search / context_read can bring it back, so you must first realise it is missing. Summarising is the safer default: the summary keeps you oriented at a fraction of the cost." },
    },
    output: { schema: RESULT_SCHEMA, render: RESULT_RENDER },
    async execute(args, exec) {
      const agent = exec?.agent;
      const session = agent?.session;
      if (session === undefined || session === null) return { ok: false, message: "this agent has no session" };
      const keepRecent = clampInt(args?.keep_recent, DEFAULT_KEEP_RECENT_NODES, 0, MAX_KEEP_RECENT_NODES);
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
      // 保留带 = 从尾部往前数的 keep_recent 个节点（按节点计数，与窗口大小无关）。
      const pressure = readPressure(ctx, session);
      const retainIdx = retainBoundaryIdx(nodes, keepRecent);
      const chosen = foldBand(session, nodes, retainIdx, fromSeq, toSeq);
      if (chosen === null) {
        // 措辞对两种模式都成立：压缩与删除用的是同一个"可动中段"。
        const what = args?.delete === true ? "drop" : "compress";
        return {
          ok: false,
          message:
            `cannot ${what} [${fromSeq} .. ${toSeq}] after safe-boundary snapping — nothing of that span is inside the allowed middle. ` +
            `The protected head (the opening system message) and the kept-recent tail (the newest keep_recent nodes, counted back from the end) are off limits, ` +
            `and the span is also narrowed to whole tool call/result pairs. ` +
            `Most often the two #seq ends no longer point at what you think: after folds, seq order and surface order disagree, so read the span with context_hotspots or context_read and pick #seq values that are still on the surface. ` +
            `Otherwise pick an older span, or lower keep_recent to reach closer to the end.`,
        };
      }
      const startSeq = nodes[chosen.startIdx].seq;
      const endSeq = nodes[chosen.endIdx].seq;
      const shadowedSeqs = nodes.slice(chosen.startIdx, chosen.endIdx + 1).map((node) => node.seq);
      const spanTokens = nodes.slice(chosen.startIdx, chosen.endIdx + 1).reduce((sum, node) => sum + (Number(node?.tokens) || 0), 0);
      const usage = pressure === null ? "" : `; context usage ~${pressure.percent}%`;

      if (args?.delete === true) {
        let deletedSeq;
        try {
          deletedSeq = deleteSpan(session, shadowedSeqs);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, message: `delete failed: ${message}` };
        }
        return {
          ok: true,
          message: `deleted seq ${startSeq}-${endSeq} (${shadowedSeqs.length} node(s), ~${spanTokens} tokens) — replaced by an empty placeholder (seq ${deletedSeq}), so it is out of view from here on. The record still holds the original text: use context_search / context_read with those seqs to read it back${usage}`,
        };
      }

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
      return { ok: true, message: `compressed seq ${startSeq}-${endSeq} (~${spanTokens} tokens)${usage}` };
    },
  });
}
