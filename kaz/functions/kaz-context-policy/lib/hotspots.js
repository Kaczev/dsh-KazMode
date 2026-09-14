// kaz-context-policy —— context_hotspots：把"当前上下文里最占地方的节点"直接摆给模型看。
//
// 为什么需要它：模型只能按 `#seq` 猜哪里该压，而对一条已折叠过的会话，**序号空间与节点空间
// 严重错位**——按序号框选很容易整片落在保留带里、或者选到早已被压成摘要的小区域（实测：
// 连折四次只回收 3k~6k token，因为选中的都是摘要）。模型缺的不是"压缩能力"，是**可见性**。
//
// 数据来源：**我们自算**。平台的 `contextBreakdown` 投影虽然有逐节点状态，但它的 wire view
// 只暴露 `{ systemTokens, toolsTokens, messageTokens }` 三个汇总数（见 `dsh-token-meter` 的
// `wire: { view: (state) => state.breakdown }`），而 `sessionProjections.snapshot()` 只返回
// wire view 的内容——**逐节点数组拿不到**（实测：`.values.contextBreakdown.nodes` 恒为 undefined）。
// 所以这里自己重建 surface 并计价：
//   * 节点顺序：优先 `session.surface.nodes`（权威），退化时按事件流重建（append 入尾、
//     replace 把 [startSeq..endSeq] 换成新节点）。
//   * 节点成本：该节点**模型可见内容**的 UTF-8 字节 ÷ 4。实测与平台记账同量级
//     （本会话 603k vs 平台 619k，约 3% 偏差），足以用于"挑哪个大"。
// 只用于排序挑大的，不作为计费口径——所以粗估可接受。
//
// 输出：最重的 N 个节点（坐标 = #seq + 它在 surface 上的位置），每个带一小段内容预览，
// 以及**连续热点段的建议区间**——模型照抄那个区间去 context_compress 即可（一次折一段，
// 而不是只删一个节点）。

import { defineTool } from "@deepseek-ai/dsh-tools";

/** 默认显示多少个最重的节点。 */
export const DEFAULT_TOP_N = 8;
/** 上限。 */
export const MAX_TOP_N = 24;
/** 每个节点预览多少字符。 */
const PREVIEW_CHARS = 70;

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean", required: true },
    text: { type: "string", required: true },
  },
};

const RESULT_RENDER = (_args, value) => [{ type: "text", text: value.text }];

function clampInt(value, fallback, min, max) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 一条消息里能当预览用的纯文本（拼接所有 text 块）。 */
function previewOf(event) {
  const data = event?.data ?? {};
  const blocks =
    event?.type === "user/message"
      ? Array.isArray(data.content) ? data.content : []
      : Array.isArray(data.message?.content) ? data.message.content : [];
  const text = blocks
    .map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > 0) return text.slice(0, PREVIEW_CHARS);
  if (event?.type === "tool/result") {
    const call = data.message?.toolCallId ?? data.callId;
    return `(tool result${call ? ` ${String(call).slice(0, 18)}` : ""})`;
  }
  return "";
}

/** 一个节点**模型可见内容**的字节数（只算喂给模型的那部分，不算事件信封）。 */
export function modelBytesOf(event) {
  const data = event?.data ?? {};
  switch (event?.type) {
    case "user/message":
      return Buffer.byteLength(JSON.stringify(data.content ?? data), "utf8");
    case "system/message":
    case "assistant/message":
      return Buffer.byteLength(JSON.stringify(data.message?.content ?? []), "utf8");
    case "tool/result":
      return Buffer.byteLength(JSON.stringify(data.message?.content ?? []), "utf8");
    default:
      return 0;
  }
}

/**
 * 重建当前 surface 的节点顺序。
 *
 * 首选 `session.surface.nodes`（平台权威顺序）；拿不到时按事件流重建：
 * `append` 入尾，`replace` 把 `[startSeq..endSeq]` 那段换成新节点（压缩与删除都走这条）。
 * @returns {number[]} surface 上各节点的 seq，按模型可见顺序。
 */
export function surfaceNodesOf(session, events) {
  const authoritative = session?.surface?.nodes;
  if (Array.isArray(authoritative) && authoritative.length > 0) return [...authoritative];
  const surf = [];
  for (const event of events) {
    const op = event?.surfaceOp;
    if (op === undefined) continue;
    if (op === "append") {
      surf.push(event.seq);
      continue;
    }
    if (typeof op === "object" && op.op === "replace") {
      const start = surf.indexOf(op.startSeq);
      const end = surf.indexOf(op.endSeq);
      if (start < 0 || end < 0) continue;
      surf.splice(start, end - start + 1, event.seq);
    }
  }
  return surf;
}

/**
 * 组装"按体积排序"的表：重建 surface、给每个节点估 token、附上类型与预览。
 *
 * 计价口径：模型可见内容的 UTF-8 字节 ÷ 4（见文件头说明）。只用于挑大的。
 * @returns {{rows: object[], totals: object}|null}
 */
export function hotspotsOf(_ctx, session) {
  if (session === undefined || session === null) return null;
  try {
    const events = typeof session.snapshotEvents === "function" ? session.snapshotEvents() : [];
    if (events.length === 0) return null;
    const bySeq = new Map();
    for (const event of events) {
      if (event !== null && typeof event === "object" && typeof event.seq === "number") bySeq.set(event.seq, event);
    }
    const seqs = surfaceNodesOf(session, events);
    if (seqs.length === 0) return null;

    const rows = seqs.map((seq, index) => {
      const event = bySeq.get(seq);
      return {
        index,
        seq,
        tokens: Math.round(modelBytesOf(event) / 4),
        type: event?.type ?? "?",
        preview: event === undefined ? "" : previewOf(event),
      };
    });
    const total = rows.reduce((sum, row) => sum + row.tokens, 0);
    const byType = {};
    for (const row of rows) byType[row.type] = (byType[row.type] ?? 0) + row.tokens;
    return { rows, totals: { total, count: rows.length, byType } };
  } catch {
    return null;
  }
}

/**
 * 找出"质量最大的连续块"。
 *
 * 为什么不用"导数"：`#seq` 与 surface 位置**两套编号不一致**（折叠会把一串 seq 换成
 * 一个带大 seq 的新节点），所以在 seq 上求差分得到的"剧烈变化"只是错位的产物。
 * 正确的做法是在 **surface 顺序**（模型看到的顺序）上做质量累积与切分——
 * 即在一维密度图上找最重的连续段。
 *
 * 算法：以中位数为"重"的门槛，把连续的重节点并成块；允许块内出现少量低谷
 * （避免被单个轻节点切碎）。这样能抓到"单个节点不大、但连成一片很重"的区域，
 * 而单节点排名会漏掉它们。
 *
 * 返回的 `fromSeq` / `toSeq` **都取自当前 surface 上真实存在的节点**——这正是
 * 直接用它们调 context_compress 不会撞上"seq 名存实亡"的原因。
 *
 * @param {object[]} rows - 按 surface 顺序排列的节点（各带 tokens / seq / type / index）。
 * @param {number} maxBlocks - 最多返回几块。
 * @param {number} minTokens - 块的质量下限（低于此不算）。
 * @returns {object[]} 按质量降序的块。
 */
export function biggestBlocks(rows, maxBlocks = 3, minTokens = 4000) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  // 保护头（system/message）不参与——它们永远不可动，包进块里只会让调用被拒。
  const usable = rows.filter((row) => row.type !== "system/message");
  if (usable.length === 0) return [];

  const sortedTokens = [...usable.map((row) => row.tokens)].sort((a, b) => a - b);
  const median = sortedTokens[Math.floor(sortedTokens.length / 2)] ?? 0;
  // 门槛：中位数与一个绝对下限取大者，避免在"整体都很轻"的会话里把噪声当块。
  const threshold = Math.max(median, 200);
  const GAP = 4; // 允许块内连续多少个轻节点还不算断开

  const blocks = [];
  let current = null;
  let gap = 0;
  for (const row of usable) {
    if (row.tokens >= threshold) {
      if (current === null) {
        current = { minIndex: row.index, maxIndex: row.index, minSeq: row.seq, maxSeq: row.seq, tokens: 0, nodes: 0 };
      }
      current.maxIndex = row.index;
      current.maxSeq = row.seq;
      current.tokens += row.tokens;
      current.nodes += 1;
      gap = 0;
      continue;
    }
    if (current === null) continue;
    gap += 1;
    if (gap > GAP) {
      blocks.push(current);
      current = null;
      gap = 0;
    }
  }
  if (current !== null) blocks.push(current);
  return blocks.filter((block) => block.tokens >= minTokens).sort((a, b) => b.tokens - a.tokens).slice(0, maxBlocks);
}

/**
 * 把最重的若干节点与"质量最大的连续块"渲染成给模型看的文本。
 * 建议区间用的是 `#seq` 坐标（与 context_compress 的 from_seq / to_seq 同一套编号），
 * 所以模型可以直接照抄，不必自己换算 surface 位置。
 */
export function renderHotspots(rows, totals, topN) {
  const heaviest = [...rows].sort((a, b) => b.tokens - a.tokens).slice(0, topN);
  const lines = [];

  lines.push(`Context hotspots — the ${heaviest.length} heaviest nodes of ${totals.count} currently in view (${(totals.total / 1000).toFixed(0)}k tokens estimated).`);
  lines.push("");
  lines.push("  #seq   surface#   tokens   type                preview");
  for (const row of heaviest) {
    lines.push(
      `  ${String(row.seq).padStart(5)}  ${String(row.index).padStart(8)}  ${String(row.tokens).padStart(6)}   ${String(row.type).padEnd(18)}  ${row.preview}`,
    );
  }

  const byType = totals.byType;
  if (byType !== null && byType !== undefined && Object.keys(byType).length > 0) {
    lines.push("");
    lines.push(
      `  Heaviest category: ${Object.entries(byType)
        .sort((a, b) => b[1] - a[1])
        .map(([label, tokens]) => `${label} ${(tokens / 1000).toFixed(0)}k (${((tokens / totals.total) * 100).toFixed(0)}%)`)
        .join(", ")}`,
    );
  }

  // 质量最大的连续块：比"单节点排名"更能反映实际占地方的东西。
  const blocks = biggestBlocks(rows);
  if (blocks.length > 0) {
    lines.push("");
    lines.push("  Biggest contiguous blocks (mass in surface order, protected system nodes excluded):");
    for (const block of blocks) {
      lines.push(
        `    from_seq ${block.minSeq}  to_seq ${block.maxSeq}   ~${(block.tokens / 1000).toFixed(0)}k tokens across ${block.nodes} node(s)`,
      );
    }
    lines.push("  Pass one of these straight to context_compress. A block covers more nodes than the lines above; the fold snaps to safe boundaries and never cuts a tool call/result pair.");
  }

  lines.push("");
  lines.push(
    "  Read a node before acting on it: context_search or context_read with its #seq shows what it holds. " +
      "Prefer compressing (a summary keeps you oriented); delete only spans you are sure are finished. " +
      "Deleting is per span, and the spans worth removing are usually not contiguous — call context_compress again for each block, and expect to need several calls. " +
      "Nodes in the newest keep_recent tail cannot be folded — lower keep_recent, or pick an older block.",
  );
  return lines.join("\n");
}

export function contextHotspotsTool(ctx) {
  return defineTool({
    name: "context_hotspots",
    description:
      "List the heaviest nodes and the biggest contiguous blocks currently in the model's context, biggest first, with each node's `#seq` and a short preview. Use it before compressing or deleting: it shows what is actually taking up space, so you pick a span by weight instead of guessing from sequence numbers — and after folds, `#seq` order no longer matches what is on the surface, so a span you remember may already be gone. Pair it with context_search / context_read to see what a block holds, then call context_compress with the suggested from_seq / to_seq. One call folds one span, and the spans worth removing are usually not contiguous: expect to call context_compress again for each block.",
    parameters: {
      top_n: { type: "integer", description: `How many of the heaviest nodes to list (default ${DEFAULT_TOP_N}, max ${MAX_TOP_N}).` },
    },
    output: { schema: RESULT_SCHEMA, render: RESULT_RENDER },
    async execute(args, exec) {
      const session = exec?.agent?.session;
      if (session === undefined || session === null) {
        return { ok: false, text: "this agent has no session" };
      }
      const topN = clampInt(args?.top_n, DEFAULT_TOP_N, 1, MAX_TOP_N);
      const data = hotspotsOf(ctx, session);
      if (data === null) {
        return { ok: false, text: "this session has no readable log yet — there is nothing in view to measure" };
      }
      return { ok: true, text: renderHotspots(data.rows, data.totals, topN) };
    },
  });
}
