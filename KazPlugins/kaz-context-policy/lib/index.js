// kaz-context-policy M3.2b —— Cordis 插件：context_search / context_read
// ===========================================================================
// 纯只读回溯工具：从当前 agent session 的 append-only 原始事件日志建 M2
// records（replacement checkpoint / compaction 日志不进 records），再调用 M2
// 纯核心 searchContext / readContext。结果以 JSON 文本渲染；错误也走结构化
// { ok:false, code, reason }。不 append、不改写 session、不写任何存储。
// ===========================================================================

import { defineTool } from "@deepseek-ai/dsh-tools";
import { searchContext, readContext } from "./context-search-read.js";
import { buildSearchRecords } from "./session-context-adapter.js";

const renderJsonText = (_args, value) => [
  { type: "text", text: JSON.stringify(value, null, 2) },
];

function structuredError(code, reason) {
  return { ok: false, code, reason };
}

function sessionEventsOf(exec) {
  try {
    const session = exec && exec.agent && exec.agent.session;
    if (session !== null && session !== undefined && Array.isArray(session.events)) {
      return session.events;
    }
  } catch {
    return null;
  }
  return null;
}

function recordsOf(exec) {
  const events = sessionEventsOf(exec);
  if (events === null) {
    return {
      error: structuredError(
        "no-agent-session",
        "context tools require exec.agent.session.events",
      ),
    };
  }
  try {
    return { records: buildSearchRecords(events) };
  } catch (error) {
    return {
      error: structuredError(
        "invalid-session-events",
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
}

function safeReason(error) {
  return error instanceof Error ? error.message : String(error);
}

function contextSearchDef() {
  return defineTool({
    name: "context_search",
    description:
      "Search the current session's append-only original event log (user/assistant/tool surface messages only; replacement checkpoints and compaction logs are excluded). Returns page items with seq/kind/time/snippet sorted by seq descending, plus total/hasMore/nextCursor for cursor pagination. Read-only.",
    parameters: {
      query: {
        type: "string",
        required: true,
        description:
          "Search text; matched as a whole case-insensitive substring against original message text.",
      },
      limit: {
        type: "integer",
        description: "Max page size (default 10).",
      },
      cursor: {
        type: "string",
        description:
          "Opaque cursor returned by a previous context_search page (optional).",
      },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: renderJsonText,
    },
    async execute(args, exec) {
      const resolved = recordsOf(exec);
      if (resolved.error !== undefined) return resolved.error;
      const opts = {};
      if (args.limit !== undefined) opts.limit = args.limit;
      if (args.cursor !== undefined) opts.cursor = args.cursor;
      try {
        return searchContext(resolved.records, args.query, opts);
      } catch (error) {
        return structuredError(
          "internal-error",
          `context_search failed: ${safeReason(error)}`,
        );
      }
    },
    presentCall: (args) => ({
      card: "generic",
      title: "搜索会话原文",
      kind: "read",
      rawInput: args.query,
    }),
  });
}

function contextReadDef() {
  return defineTool({
    name: "context_read",
    description:
      "Read full original text for one or more session event seqs (from context_search results). Accepts a single seq number or an array of seq numbers; each returned item is verbatim and never truncated. Applies a total-character budget; items that do not fit are reported as omitted. Read-only.",
    parameters: {
      seqs: {
        oneOf: [
          { type: "integer", description: "One session event seq." },
          {
            type: "array",
            items: { type: "integer", description: "Session event seq." },
            description: "List of session event seqs.",
          },
        ],
        required: true,
        description:
          "Session event seq(s): a single number or an array of numbers.",
      },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: renderJsonText,
    },
    async execute(args, exec) {
      const resolved = recordsOf(exec);
      if (resolved.error !== undefined) return resolved.error;
      try {
        return readContext(resolved.records, args.seqs);
      } catch (error) {
        return structuredError(
          "internal-error",
          `context_read failed: ${safeReason(error)}`,
        );
      }
    },
    presentCall: (args) => ({
      card: "generic",
      title: "读取会话原文",
      kind: "read",
      rawInput: JSON.stringify(args.seqs),
    }),
  });
}

export default {
  name: "kaz-context-policy",
  inject: ["tools"],
  apply(ctx, _config = {}) {
    const disposers = [];
    for (const def of [contextSearchDef(), contextReadDef()]) {
      try {
        disposers.push(ctx.tools.register(def));
      } catch (error) {
        ctx.logger?.warn?.(
          `[kaz-context-policy] 注册工具 ${def.name} 失败：${safeReason(error)}`,
        );
      }
    }
    ctx.effect(() => () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch (error) {
          ctx.logger?.warn?.(
            `[kaz-context-policy] 注销工具失败：${safeReason(error)}`,
          );
        }
      }
    });
  },
};
