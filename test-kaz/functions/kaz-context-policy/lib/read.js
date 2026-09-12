// kaz-context-policy —— context_read（§3.8.6）：按序号区间取完整原文，供取证。
//
// 与 context_search 同一份会话日志原文；压缩不影响它。
// 单次最多 READ_MAX_CHARS 字符：放不下的整条不取；单条自身超上限时截取该条前一段。

import { defineTool } from "@deepseek-ai/dsh-tools";
import { entriesOfSession, readEntries } from "./session-log.js";
import { clampInt, resolveCompanion } from "./search.js";

export const READ_MAX_CHARS = 20000;

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean", required: true },
    message: { type: "string", required: true },
    text: { type: "string", required: true },
    truncated: { type: "boolean", required: true },
  },
};

const RESULT_RENDER = (_args, value) => [{ type: "text", text: value.ok !== true ? `failure: ${value.message}` : value.text }];

/**
 * 逐条拼接原文，受 maxChars 限制。
 * @param {object[]} entries - 区间内的记录（按 seq 升序）。
 * @param {number} from - 请求的起始序号（空区间时报错用）。
 * @param {number} to - 请求的结束序号。
 * @param {number} [maxChars] - 字符上限。
 * @returns {{text: string, coveredFrom: number, coveredTo: number, truncated: boolean}}
 */
export function buildReadText(entries, from, to, maxChars = READ_MAX_CHARS) {
  const lines = [];
  let used = 0;
  let truncated = false;
  let coveredTo = Number.isFinite(Number(from)) ? Math.trunc(Number(from)) : 0;
  for (const entry of entries) {
    const head = `[#${entry.seq} ${entry.label}] `;
    const body = entry.text;
    const available = maxChars - used - head.length;
    if (available <= 0) {
      truncated = true;
      break;
    }
    if (body.length > available) {
      if (used === 0) {
        lines.push(`${head}${body.slice(0, available)}`);
        used += head.length + available;
        coveredTo = entry.seq;
      }
      truncated = true;
      break;
    }
    lines.push(`${head}${body}`);
    used += head.length + body.length;
    coveredTo = entry.seq;
  }
  const coveredFrom = entries.length > 0 ? entries[0].seq : coveredTo;
  const text = truncated
    ? `${lines.join("\n\n")}\n\n[truncated — covered seq ${coveredFrom}–${coveredTo}; ask for a narrower range]`
    : lines.join("\n\n");
  return { text, coveredFrom, coveredTo, truncated };
}

export function contextReadTool(ctx) {
  return defineTool({
    name: "context_read",
    description:
      "Read the full original text of records by sequence range from this conversation's log (or a companion's) — the same log context_search searches. Read-only; use it when you need exact wording, not just a snippet. Non-record events are skipped; at most 20000 characters per call, and a truncated receipt says which seq range was covered.",
    parameters: {
      from: { type: "integer", required: true, description: "First sequence number (inclusive)." },
      to: { type: "integer", description: "Last sequence number (inclusive); defaults to `from` (one record)." },
      companion: { type: "string", description: 'Whose log to read: "main", or a subagent id or label; omit for this conversation.' },
    },
    output: { schema: RESULT_SCHEMA, render: RESULT_RENDER },
    async execute(args, exec) {
      const agent = exec?.agent;
      const fromRaw = Number(args?.from);
      if (!Number.isFinite(fromRaw)) return { ok: false, message: "from must be a sequence number", text: "", truncated: false };
      const from = Math.max(0, Math.trunc(fromRaw));
      const to = Number.isFinite(Number(args?.to)) ? Math.max(0, Math.trunc(Number(args.to))) : from;
      const companion = typeof args?.companion === "string" ? args.companion.trim() : "";
      let session = agent?.session;
      let where = "this";
      if (companion.length > 0) {
        const resolved = await resolveCompanion(ctx, agent, companion);
        if (resolved.error !== undefined) return { ok: false, message: resolved.error, text: "", truncated: false };
        session = resolved.session;
        where = resolved.from;
      }
      if (session === undefined || session === null) return { ok: false, message: "this agent has no session", text: "", truncated: false };
      const all = entriesOfSession(session);
      const window = readEntries(all, from, to);
      if (window.length === 0) {
        const range = all.length > 0 ? `${all[0].seq}–${all[all.length - 1].seq}` : "none";
        return { ok: false, message: `no original records in seq ${Math.min(from, to)}–${Math.max(from, to)}; available seq range: ${range}`, text: "", truncated: false };
      }
      const built = buildReadText(window, from, to);
      return {
        ok: true,
        message: `${where}: read ${window.length} record(s), seq ${window[0].seq}–${built.coveredTo}${built.truncated ? " (truncated)" : ""}`,
        text: built.text,
        truncated: built.truncated,
      };
    },
  });
}
