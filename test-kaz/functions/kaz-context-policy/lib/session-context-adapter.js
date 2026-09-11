// kaz-context-policy M3.1 —— DshLike 会话 → M1/M2 的适配层
// ===========================================================================
// 纯 ESM、零 I/O、零依赖：不 import node:*、cordis、DSH 模块或本目录其它文件。
// 不改 DSH 核心 / 不改 preset / 不注册工具 / 不碰 tool-lists。
//
// 输入形态（最小 DSH 语义）：
//   session = {
//     events: [{ seq:number, type:string, time?:number|string, data:any,
//                surfaceOp?: "append" | { op:"replace", start:number, end:number } }],
//     surface?: { nodes:number[] },   // 缺省时由 events 最小折叠重建
//   }
//
// 三类 surface 事件 = user/message | assistant/message | tool/result。
// append-origin 只指 surfaceOp === "append"（DshLike 简写缺省按 append 处理）；
// replacement checkpoint 与 compaction/* 只留在日志，不进 M2 records。
// 但 M1 units 按当前 surface.nodes 投影：replacement checkpoint 若在当前 surface
// 上，就会成为可被压缩/保护的 unit。
//
// buildCompressUnits 输出“工具配对平衡”的 M1 units：assistant 含未闭合 tool-call
// 时，后续 tool/result 会并入同一 unit，因此压缩范围不会拆开 tool-call/result 对。
// unit.position = 当前 surface 顺序下的 group 序号（0-based、唯一）。
// ===========================================================================

export const SURFACE_EVENT_TYPES = Object.freeze([
  "user/message",
  "assistant/message",
  "tool/result",
]);
export const DEFAULT_LARGE_TOOL_RESULT_CHARS = 4096;

const SURFACE_EVENT_SET = new Set(SURFACE_EVENT_TYPES);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function failure(message) {
  throw new TypeError(message);
}

/** 归一化会话输入；本插件内部一律消费 { events: [...], surface?: { nodes } }。
 *  dsh 0.1.1：exec.agent.session.events 本身就是事件数组，原样通过。
 *  dsh 0.1.5：agent.session 是带方法的会话句柄（.seq / .eventAt(seq) /
 *  .surface.nodes —— 官方 @deepseek-ai/dsh-compaction-basic 就是这么用的），
 *  没有 .events 数组，这里按 seq 折叠出事件数组并带上 surface.nodes
 *  （surface 缺省时下游用 foldSurfaceNodes 从事件重建）。 */
export function normalizeSessionView(session) {
  if (session === null || session === undefined || typeof session !== "object") return session;
  if (Array.isArray(session.events)) return session;
  if (
    !Number.isInteger(session.seq) ||
    session.seq < 0 ||
    typeof session.eventAt !== "function"
  ) {
    return session;
  }
  const events = [];
  for (let seq = 0; seq < session.seq; seq += 1) {
    let event;
    try {
      event = session.eventAt(seq);
    } catch {
      event = undefined;
    }
    if (event !== null && event !== undefined) events.push(event);
  }
  const view = { events };
  if (isPlainObject(session.surface) && Array.isArray(session.surface.nodes)) {
    view.surface = { nodes: session.surface.nodes.slice() };
  }
  return view;
}

function normalizeOpts(rawOpts) {
  if (rawOpts === undefined) rawOpts = {};
  if (!isPlainObject(rawOpts)) {
    return failure("opts must be a plain object or undefined");
  }
  const firstUserLayer =
    rawOpts.firstUserLayer === undefined ? "core-task" : rawOpts.firstUserLayer;
  const userLayer = rawOpts.userLayer === undefined ? "active-detail" : rawOpts.userLayer;
  const assistantLayer = rawOpts.assistantLayer === undefined ? "detail" : rawOpts.assistantLayer;
  const toolResultLayer =
    rawOpts.toolResultLayer === undefined ? "detail" : rawOpts.toolResultLayer;
  let largeToolResultChars = DEFAULT_LARGE_TOOL_RESULT_CHARS;
  if (rawOpts.largeToolResultChars !== undefined) {
    if (!isNonNegativeSafeInteger(rawOpts.largeToolResultChars)) {
      return failure("largeToolResultChars must be a non-negative safe integer");
    }
    largeToolResultChars = rawOpts.largeToolResultChars;
  }
  return {
    firstUserLayer,
    userLayer,
    assistantLayer,
    toolResultLayer,
    largeToolResultChars,
  };
}

/** DSH surface.js 的最小逐事件投影：只有三类消息事件可 derive；其余返回 null。 */
export function deriveMessage(event) {
  if (!isPlainObject(event)) return null;
  switch (event.type) {
    case "user/message":
      return event.data;
    case "assistant/message": {
      const content = event.data?.message?.content;
      if (Array.isArray(content) && content.length === 0) return null;
      return event.data?.message ?? null;
    }
    case "tool/result":
      return event.data?.message ?? null;
    default:
      return null;
  }
}

function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!isPlainObject(block)) continue;
    if (block.type === "text") {
      if (typeof block.text === "string") parts.push(block.text);
    } else if (block.type === "tool-call") {
      const name = typeof block.name === "string" ? block.name : String(block.name ?? "");
      const args =
        typeof block.arguments === "string"
          ? block.arguments
          : JSON.stringify(block.arguments ?? "");
      parts.push(`[tool-call ${name}] ${args}`);
    } else if (block.type === "tool-result") {
      parts.push(textOfContent(block.content));
    }
    // reasoning/image/未知 block：不进入纯文本搜索/估算。
  }
  return parts.join("");
}

/** 把一条消息投影为纯文本：string 原样；content[] 拼接 text（tool-call 带标记）。 */
export function textOfMessage(message) {
  if (typeof message === "string") return message;
  if (Array.isArray(message)) return textOfContent(message);
  if (!isPlainObject(message)) return "";
  if (Array.isArray(message.content)) return textOfContent(message.content);
  if (typeof message.text === "string") return message.text;
  return "";
}

/** 无依赖 token 粗估：4 字符 ≈ 1 token，空文本为 0。 */
export function estimateTokens(text) {
  if (typeof text !== "string") {
    failure("estimateTokens(text): text must be a string");
  }
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function isSurfaceEligibleType(type) {
  return SURFACE_EVENT_SET.has(type);
}

function isReplaceOp(op) {
  return (
    isPlainObject(op) &&
    op.op === "replace" &&
    isNonNegativeSafeInteger(op.start) &&
    isNonNegativeSafeInteger(op.end)
  );
}

/** 是否 append-origin：surfaceOp==="append"；DshLike 缺 surfaceOp 时按 append 简写。 */
function isAppendSurfaceEvent(event) {
  if (!isSurfaceEligibleType(event.type)) return false;
  if (event.surfaceOp === undefined || event.surfaceOp === "append") return true;
  return false;
}

function sortEventsBySeq(events) {
  return events.slice().sort((a, b) => a.seq - b.seq);
}

/** 仅日志事件 → 当前 surface.nodes 的最小 DSH 折叠（append/replace）。 */
export function foldSurfaceNodes(events) {
  if (!Array.isArray(events)) {
    failure("foldSurfaceNodes(events): events must be an array");
  }
  const nodes = [];
  for (const event of sortEventsBySeq(events)) {
    if (!isSurfaceEligibleType(event.type)) continue;
    if (isAppendSurfaceEvent(event)) {
      if (!nodes.includes(event.seq)) nodes.push(event.seq);
      continue;
    }
    const op = event.surfaceOp;
    if (!isReplaceOp(op)) {
      failure(`event ${event.seq} has invalid surfaceOp`);
    }
    const startIdx = nodes.indexOf(op.start);
    const endIdx = nodes.indexOf(op.end);
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
      failure(
        `event ${event.seq}: replacement range ${op.start}..${op.end} is not in current surface`,
      );
    }
    nodes.splice(startIdx, endIdx - startIdx + 1, event.seq);
  }
  return nodes;
}

function surfaceNodesOf(rawSession) {
  const session = normalizeSessionView(rawSession);
  if (!isPlainObject(session) || !Array.isArray(session.events)) {
    failure("session must be { events: [...] } or a dsh 0.1.5 session handle (.seq + .eventAt)");
  }
  if (
    session.surface !== undefined &&
    (session.surface === null ||
      !isPlainObject(session.surface) ||
      !Array.isArray(session.surface.nodes))
  ) {
    failure("session.surface must be { nodes: number[] } when provided");
  }
  if (session.surface !== undefined) {
    for (const seq of session.surface.nodes) {
      if (!isNonNegativeSafeInteger(seq)) {
        failure("session.surface.nodes must contain non-negative safe integers");
      }
    }
    return session.surface.nodes.slice();
  }
  return foldSurfaceNodes(session.events);
}

function toolCallCountOf(event) {
  const message = deriveMessage(event);
  const content = isPlainObject(message) ? message.content : message;
  if (!Array.isArray(content)) return 0;
  return content.reduce(
    (total, block) => total + (isPlainObject(block) && block.type === "tool-call" ? 1 : 0),
    0,
  );
}

/**
 * 纯 layer 启发式：
 *   user/message → active-detail；isFirstUser 时可用 firstUserLayer（默认 core-task）
 *   assistant/message → detail
 *   tool/result → text 超过 largeToolResultChars 时 noise，否则 toolResultLayer
 */
export function layerOf(event, rawOpts) {
  if (!isPlainObject(event)) return "detail";
  const opts = normalizeOpts(rawOpts);
  const message = deriveMessage(event);
  const text = message === null ? "" : textOfMessage(message);
  if (event.type === "user/message") {
    const isFirstUser = isPlainObject(rawOpts) && rawOpts.isFirstUser === true;
    return isFirstUser ? opts.firstUserLayer : opts.userLayer;
  }
  if (event.type === "assistant/message") return opts.assistantLayer;
  if (event.type === "tool/result") {
    return text.length > opts.largeToolResultChars ? "noise" : opts.toolResultLayer;
  }
  return "detail";
}

function layerOfEntry(entry, opts) {
  if (typeof entry.layer === "string" && entry.layer.length > 0) return entry.layer;
  if (typeof entry.type !== "string") return "detail";
  // layerOf 对 entry 不方便：直接按已投影的 entry 规则给默认值。
  if (entry.type === "user/message") {
    return entry.isFirstUser ? opts.firstUserLayer : opts.userLayer;
  }
  if (entry.type === "assistant/message") return opts.assistantLayer;
  if (entry.type === "tool/result") {
    const chars = typeof entry.chars === "number" ? entry.chars : entry.text.length;
    return chars > opts.largeToolResultChars ? "noise" : opts.toolResultLayer;
  }
  return "detail";
}

function groupLayer(group, opts) {
  // 超大工具结果优先判 noise；随后 user（含首个 user）→ 用户层；否则 assistant 层。
  for (const entry of group) {
    if (entry.type !== "tool/result") continue;
    const chars = typeof entry.chars === "number" ? entry.chars : entry.text.length;
    if (chars > opts.largeToolResultChars) return "noise";
  }
  for (const entry of group) {
    if (entry.type === "user/message") return layerOfEntry(entry, opts);
  }
  for (const entry of group) {
    if (entry.type === "assistant/message") return layerOfEntry(entry, opts);
  }
  for (const entry of group) {
    if (entry.type === "tool/result") return layerOfEntry(entry, opts);
  }
  return "detail";
}

/**
 * 把 surface 事件级 entries 合并成工具配对平衡的 M1 units。
 * entries: [{ seq, type, text?, chars?, toolCallCount?, layer?, isFirstUser? }]
 * 返回：[{ position, seqStart, seqEnd, tokens, layer }]
 */
export function groupUnits(entries, rawOpts) {
  if (!Array.isArray(entries)) {
    failure("groupUnits(entries): entries must be an array");
  }
  const opts = normalizeOpts(rawOpts);
  const groups = [];
  let current = [];
  let openToolCalls = 0;

  const flush = () => {
    if (current.length > 0) {
      groups.push(current);
      current = [];
    }
  };

  for (const entry of entries) {
    current.push(entry);
    if (entry.type === "assistant/message") {
      openToolCalls +=
        typeof entry.toolCallCount === "number" ? entry.toolCallCount : toolCallCountOf(entry);
    } else if (entry.type === "tool/result") {
      openToolCalls -= 1;
    }
    if (openToolCalls < 0) openToolCalls = 0; // DshLike 宽容：孤立 result 自成 unit
    if (openToolCalls === 0) flush();
  }
  flush();

  return groups.map((group, position) => {
    const seqStart = group[0].seq;
    const seqEnd = group[group.length - 1].seq;
    const chars = group.reduce(
      (total, entry) => total + (typeof entry.chars === "number" ? entry.chars : entry.text.length),
      0,
    );
    return {
      position,
      seqStart,
      seqEnd,
      tokens: chars === 0 ? 0 : Math.max(1, Math.ceil(chars / 4)),
      layer: groupLayer(group, opts),
    };
  });
}

/** 只取 append-origin 三类 surface 事件 → M2 records（跳过 replacement checkpoint/compaction/*）。 */
export function buildSearchRecords(events) {
  if (!Array.isArray(events)) {
    failure("buildSearchRecords(events): events must be an array");
  }
  const records = [];
  for (const event of sortEventsBySeq(events)) {
    if (!isAppendSurfaceEvent(event)) continue;
    const message = deriveMessage(event);
    if (message === null) continue;
    const text = textOfMessage(message);
    if (text.trim().length === 0) continue;
    const kind =
      event.type === "user/message"
        ? "user"
        : event.type === "assistant/message"
          ? "assistant"
          : "tool";
    const record = { seq: event.seq, kind, text };
    if (event.time !== undefined) record.time = event.time;
    records.push(record);
  }
  return records;
}

/**
 * 按当前 surface.nodes 顺序输出 M1 units（工具配对平衡，不拆 assistant tool-call/result）。
 * opts:
 *   firstUserLayer（默认 core-task）、userLayer（默认 active-detail）、
 *   assistantLayer（默认 detail）、toolResultLayer（默认 detail）、
 *   largeToolResultChars（默认 4096）
 */
export function buildCompressUnits(rawSession, rawOpts) {
  const opts = normalizeOpts(rawOpts);
  const session = normalizeSessionView(rawSession);
  const nodes = surfaceNodesOf(session);
  const eventsBySeq = new Map();
  for (const event of session.events) {
    eventsBySeq.set(event.seq, event);
  }

  const entries = [];
  let firstUserSeen = false;
  for (const seq of nodes) {
    const event = eventsBySeq.get(seq);
    if (event === undefined) {
      failure(`surface node seq ${seq} has no matching event`);
    }
    const message = deriveMessage(event);
    if (message === null) continue; // 空 assistant/message（仅 usage）不形成可压文本 unit
    const text = textOfMessage(message);
    if (text.trim().length === 0) continue; // 无文本 unit（例如纯 image 引用）不进 M1 文本单位
    const isFirstUser = event.type === "user/message" && !firstUserSeen;
    if (isFirstUser) firstUserSeen = true;
    entries.push({
      seq,
      type: event.type,
      text,
      chars: text.length,
      tokens: estimateTokens(text),
      toolCallCount: toolCallCountOf(event),
      layer: layerOf(event, { ...rawOpts, isFirstUser }),
      isFirstUser,
    });
  }
  return groupUnits(entries, opts);
}
