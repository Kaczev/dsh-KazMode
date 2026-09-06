// kaz-context-policy M3.3 —— Cordis 插件：Kaz compaction provider + context 工具
// ===========================================================================
// 同一插件实例承担两个角色：
//   1. ctx.compaction provider（KazCompactionEngine，M1/M3 自定义选区 + 官方
//      compaction 事务），可直接替换 preset compaction group 里的
//      @deepseek-ai/dsh-compaction-basic 行；
//   2. 工具：context_search / context_read（M2 只读回溯）与 context_compress
//      （模型主动压缩入口，strategy=suggest|fold）。
// context_search / context_read：纯只读回溯工具，从当前 agent session 的
// append-only 原始事件日志建 M2 records（replacement checkpoint / compaction
// 日志不进 records），再调用 M2 纯核心 searchContext / readContext。
// context_compress：schema 支持 strategy=suggest|fold、limit 与 opts；执行时
// 读取本插件提供的 ctx.compaction（selectRange + compactRegion）。无 provider
// 时返回结构化 no-provider（仅离线/降级路径）。
// suggest/fold 是模型/手动路径：默认按当前 tokenMeter totalTokens 的 50%
// （foldTargetRatio=0.5）作一次连续填充预算，从可压区右侧尽量压满预算、
// 跨 layer/run 但仍不碰前缀/尾/强保单位；自动 compactIfNeeded 仍保持官方
// thresholdRatio 0.8 的上下文窗口压力阈值，不套 foldTargetRatio。
// suggest 默认返回紧凑摘要（无全量 units）；opts.includeUnits=true 时附加
// 全量 units 数组供调试，schema 与 tool description 同步暴露 includeUnits。
// 结果以 JSON 文本渲染；错误也走结构化 { ok:false, code, reason }。
// 不 append、不改写 session、不写任何存储（fold 时改写 surface 由 provider
// 的官方 compactRegion 事务负责）。
// ===========================================================================

import { defineTool } from "@deepseek-ai/dsh-tools";
import { KazCompactionEngine } from "./kaz-compaction-engine.js";
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

function compressionProviderOf(ctx) {
  try {
    const provider = ctx && typeof ctx.get === "function" ? ctx.get("compaction") : null;
    if (
      provider &&
      typeof provider.selectRange === "function" &&
      typeof provider.compactRegion === "function"
    ) {
      return provider;
    }
  } catch {
    return null;
  }
  return null;
}

function contextCompressDef(ctx) {
  return defineTool({
    name: "context_compress",
    description:
      "Proactively compress old middle content in the current session while preserving the stable prefix/tail. strategy='suggest' (default) returns a compact candidate summary (start/end, shadowedTokens, cachePreservedTokens, tailPreservedTokens, unitCount and suggestedUnitLayer) without changing anything; no full units array is returned unless opts.includeUnits=true (debug). strategy='fold' commits a compaction through the Kaz m33b compaction provider. Manual suggest/fold fills once from the right of the compressible area, using about 50% of the currently measured context (foldTargetRatio default 0.5) as the budget; it stays under that budget while crossing layers/runs but never folds prefix/tail/protected units. Automatic compactIfNeeded keeps the official 0.8 context-window threshold and does not apply foldTargetRatio. limit/opts are optional forward-looking knobs for the provider. If the Kaz provider is not mounted/complete, returns structured no-provider instead of touching the official basic compaction path.",
    parameters: {
      strategy: {
        type: "string",
        enum: ["suggest", "fold"],
        description: "suggest = show compact candidate range only (default, no mutation; set opts.includeUnits=true to also include the full units array for debug); fold = select then commit through the Kaz provider. Manual suggest/fold fills the compressible area once up to about 50% of the measured-context budget (foldTargetRatio default 0.5), crossing layers/runs but never prefix/tail/protected units; auto compaction keeps the official 0.8 threshold.",
      },
      limit: {
        type: "integer",
        description: "Optional fold-size/candidate limit forwarded to the m33b provider when supported.",
      },
      opts: {
        type: "object",
        additionalProperties: true,
        properties: {
          includeUnits: {
            type: "boolean",
            description: "When true, suggest output also includes the full units array for debugging. Default false: suggest returns a compact summary only.",
          },
        },
        description: "Optional provider options reserved for the m33b provider (e.g. preserve budgets / protected unit ids). Also accepts opts.includeUnits to control debug detail in suggest output.",
      },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: renderJsonText,
    },
    async execute(args, exec) {
      const provider = compressionProviderOf(ctx);
      if (provider === null) {
        return structuredError(
          "no-provider",
          "context_compress requires the Kaz m33b compaction provider (ctx.compaction with selectRange/compactRegion); the provider is not mounted or is not complete.",
        );
      }
      const agent = exec?.agent;
      const session = agent?.session;
      if (session === null || session === undefined) {
        return structuredError(
          "no-agent-session",
          "context_compress requires exec.agent.session",
        );
      }
      const strategy = args?.strategy === "fold" ? "fold" : "suggest";
      try {
        let measurement;
        try {
          const meter = ctx?.get?.("tokenMeter");
          if (meter && typeof meter.measure === "function") {
            measurement = meter.measure(session);
          }
        } catch {
          measurement = undefined;
        }
        // 手动 suggest/fold 路径：manual=true 触发 dynamicMaxFoldTokens
        // （当前 totalTokens * foldTargetRatio，默认 50%）并启用 fillToBudget
        // 连续填充；auto 不走此分支。
        const range = provider.selectRange(session, measurement, {
          overflow: false,
          force: false,
          manual: true,
        });
        if (range === null || range === undefined) {
          return structuredError(
            "no-compressible-range",
            "context_compress found no candidate range after prefix/tail protection.",
          );
        }
        if (strategy === "suggest") {
          // 默认紧凑输出：unitCount = 本次建议压缩覆盖的 unit 数；
          // suggestedUnitLayer = 该连续候选区的 layer（可省）。
          // 全量 units 仅当 opts.includeUnits=true（调试）时附加。
          const detail = range.result ?? range;
          const includeUnits = args?.opts?.includeUnits === true;
          const unitStart = detail.unitStart;
          const unitEnd = detail.unitEnd;
          const unitCount =
            Number.isInteger(unitStart) && Number.isInteger(unitEnd)
              ? unitEnd - unitStart + 1
              : 0;
          const suggestedUnit =
            Array.isArray(detail.units) && Number.isInteger(unitStart)
              ? detail.units[unitStart]
              : undefined;
          const suggested = {
            ok: true,
            strategy,
            action: "suggest",
            start: range.start,
            end: range.end,
            shadowedTokens: detail.shadowedTokens,
            cachePreservedTokens: detail.cachePreservedTokens,
            tailPreservedTokens: detail.tailPreservedTokens,
            unitCount,
          };
          if (suggestedUnit && typeof suggestedUnit.layer === "string") {
            suggested.suggestedUnitLayer = suggestedUnit.layer;
          }
          if (includeUnits) {
            suggested.units = Array.isArray(detail.units) ? detail.units : [];
          }
          return suggested;
        }
        const result = await provider.compactRegion(
          range.start,
          range.end,
          agent,
          exec.signal,
        );
        return { ok: true, strategy, action: "fold", result };
      } catch (error) {
        return structuredError(
          "internal-error",
          `context_compress failed: ${safeReason(error)}`,
        );
      }
    },
    presentCall: (args) => ({
      card: "generic",
      title: "压缩会话上下文",
      kind: args?.strategy === "fold" ? "write" : "read",
      rawInput: JSON.stringify(args ?? {}),
    }),
  });
}

/** 在同一个插件 fiber/entry context 上注册三个 context 工具并绑定注销。 */
function registerTools(ctx) {
  const disposers = [];
  for (const def of [
    contextSearchDef(),
    contextReadDef(),
    contextCompressDef(ctx),
  ]) {
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
}

/**
 * KazContextPolicy —— provider + tool 同一插件的 Cordis 默认导出。
 *
 * 与 @deepseek-ai/dsh-compaction-basic 的加载形式一致（default class plugin）：
 * Cordis 在拥有 llm/tokenMeter/sessions/tools 的 entry context 构造本类；
 * KazCompactionEngine 的 Service 构造器把实例注册为 ctx.compaction，之后
 * registerTools() 把 context_search/read/compress 挂进同一 ctx。
 */
export class KazContextPolicy extends KazCompactionEngine {
  static inject = ["tools", "llm", "tokenMeter", "sessions"];

  constructor(ctx, config = {}) {
    super(ctx, config);
    registerTools(ctx);
  }
}

export default KazContextPolicy;
