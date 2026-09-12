// kaz-context-policy —— context_search / context_search_from_companion。
// 输入 / 说明 / 效果 / 输出按《Kaz8.0设计.md》§3.8、§3.8.5；文案一律英文。
// 检索按得分排序（原句命中优先、其次检索词加权、同分新的在前），并回报总数。

import { defineTool } from "@deepseek-ai/dsh-tools";
import { entriesOfSession, searchEntries } from "./session-log.js";

const renderText = (value) => [{ type: "text", text: value }];

const HIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    seq: { type: "number", required: true },
    from: { type: "string", required: true },
    label: { type: "string", required: true },
    snippet: { type: "string", required: true },
  },
};

const HITS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean", required: true },
    message: { type: "string", required: true },
    total: { type: "number", required: true },
    hits: { type: "array", required: true, items: HIT_SCHEMA },
  },
};

function renderHits(_args, value) {
  if (value.ok !== true) return renderText(`failure: ${value.message}`);
  if (value.hits.length === 0) return renderText("no matches");
  const header = value.total > value.hits.length
    ? `showing ${value.hits.length} of ${value.total} matches`
    : `${value.total} match(es)`;
  const lines = value.hits.map((hit) => `[${hit.from} #${hit.seq} ${hit.label}] ${hit.snippet}`);
  return renderText([header, ...lines].join("\n\n"));
}

export function clampInt(value, fallback, min, max) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 当前会话的根（主代理会话）：沿 parentSession 上溯到还能取到的最高一层。 */
function rootSessionOf(ctx, agent) {
  const sessions = ctx.get("sessions");
  let current = agent?.session;
  if (current === undefined || current === null) return undefined;
  for (let depth = 0; depth < 16; depth += 1) {
    const parentId = current?.header?.parentSession;
    if (typeof parentId !== "string" || parentId.length === 0) return current;
    const parent = sessions?.get?.(parentId);
    if (parent === undefined || parent === null) return current;
    current = parent;
  }
  return current;
}

/** companion 名字 → 目标会话：main = 根会话；其余按 id / label 在根的直接子代理里找。 */
export async function resolveCompanion(ctx, agent, name) {
  const root = rootSessionOf(ctx, agent);
  if (root === undefined) return { error: "this agent has no session" };
  const wanted = String(name ?? "").trim();
  if (wanted.length === 0) return { error: "companion is required" };
  const lower = wanted.toLowerCase();
  if (lower === "main" || lower === String(root.id).toLowerCase()) return { session: root, from: "main" };
  const subagents = ctx.get("subagents");
  if (subagents === undefined || typeof subagents.listChildren !== "function") {
    return { error: "the subagent registry is unavailable" };
  }
  let children = [];
  try {
    children = await subagents.listChildren(root.id);
  } catch (error) {
    return { error: `cannot list subagents: ${error instanceof Error ? error.message : String(error)}` };
  }
  const match = children.find(
    (child) => child?.id === wanted || (typeof child?.label === "string" && child.label.toLowerCase() === lower),
  );
  if (match === undefined) {
    const known = children.map((child) => child?.label ?? child?.id).filter((item) => typeof item === "string");
    return { error: `unknown companion "${wanted}"; known companions: main${known.length > 0 ? `, ${known.join(", ")}` : ""}` };
  }
  const session = ctx.get("sessions")?.get?.(match.id);
  if (session === undefined) {
    return { error: `companion "${match.label ?? match.id}" is not live right now` };
  }
  return { session, from: typeof match.label === "string" && match.label.length > 0 ? match.label : String(match.id) };
}

const SEARCH_PARAMS = {
  query: { type: "string", required: true, description: "Keywords or an exact sentence to find. Surrounding quotes are stripped before matching." },
  limit: { type: "integer", description: "Maximum number of results (default 20, max 50)." },
  after_seq: { type: "integer", description: "Only look at records with a sequence number greater than this (default 0 = all)." },
  chars: { type: "integer", description: "Snippet width per hit in characters (default 400, max 2000)." },
};

const SEARCH_OPTIONS = (args) => ({
  limit: clampInt(args?.limit, 20, 1, 50),
  afterSeq: clampInt(args?.after_seq, 0, 0, Number.MAX_SAFE_INTEGER),
  radius: Math.round(clampInt(args?.chars, 400, 80, 2000) / 2),
});

export function contextSearchTool() {
  return defineTool({
    name: "context_search",
    description:
      "Search the original text of this conversation's log, including parts already compressed out of the current context. Read-only; use it when exact words are needed instead of guessing. Results are ranked (exact phrase first, then keyword coverage, newest first on ties) and report the total match count; limit/after_seq/chars narrow the scope.",
    parameters: SEARCH_PARAMS,
    output: { schema: HITS_SCHEMA, render: renderHits },
    async execute(args, exec) {
      const session = exec?.agent?.session;
      if (session === undefined || session === null) return { ok: false, message: "this agent has no session", total: 0, hits: [] };
      const { hits, total } = searchEntries(entriesOfSession(session), args?.query, SEARCH_OPTIONS(args));
      return {
        ok: true,
        message: `${total} match(es) in this conversation's log`,
        total,
        hits: hits.map((hit) => ({ seq: hit.seq, from: "this", label: hit.label, snippet: hit.snippet })),
      };
    },
  });
}

export function contextSearchFromCompanionTool(ctx) {
  return defineTool({
    name: "context_search_from_companion",
    description:
      'Search another agent\'s conversation log the same way context_search searches this one: the main agent ("main") or one of its subagents (by id or label). Read-only and cross-session; the same limit/after_seq/chars options apply.',
    parameters: {
      companion: { type: "string", required: true, description: 'Whose log to search: "main", or a subagent id or label.' },
      ...SEARCH_PARAMS,
    },
    output: { schema: HITS_SCHEMA, render: renderHits },
    async execute(args, exec) {
      const resolved = await resolveCompanion(ctx, exec?.agent, args?.companion);
      if (resolved.error !== undefined) return { ok: false, message: resolved.error, total: 0, hits: [] };
      const { hits, total } = searchEntries(entriesOfSession(resolved.session), args?.query, SEARCH_OPTIONS(args));
      return {
        ok: true,
        message: `${total} match(es) in ${resolved.from}'s log`,
        total,
        hits: hits.map((hit) => ({ seq: hit.seq, from: resolved.from, label: hit.label, snippet: hit.snippet })),
      };
    },
  });
}
