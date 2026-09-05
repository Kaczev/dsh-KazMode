// whale-summarizer —— KazPlugins 正式内部服务插件（模型不可见）。
// ===========================================================================
// 只挂 Kaz preset；不注册工具、不注入提示段、不写 round-display。
// 协议：summarize(input, runtime) → Promise<{ summary, sourceIds }>
//   input:   { evidence, refs, purpose, opts? }
//   runtime: { agent, signal? }
// 依据：不入库文件/Kaz7.0更新规划/Kaz7.0-whale_summarizer设计报告.md。
// ===========================================================================

import {
  ERROR_CODES,
  WhaleSummarizerError,
  sourceIdsOf,
  validateSummarizeInput,
} from "./core.mjs";
import { runSingleLlmAttempt } from "./llm-call.mjs";

/**
 * whaleSummarizer 作用域闸：只允许 Kaz 主会话/子代理与受控 v0.9 Kaz 子代理。
 * services 形如 { kazMode, kaWhaleWorkflow }；不依赖真实 ctx，便于探针注入。
 */
export function isWhaleSummarizerScopeAllowed(services, agent) {
  if (agent === null || agent === undefined || typeof agent !== "object") return false;
  try {
    const kazMode = services?.kazMode;
    if (kazMode !== null && kazMode !== undefined && typeof kazMode.kazEnabled === "function") {
      if (kazMode.kazEnabled(agent) === true) return true;
    }
    const workflow = services?.kaWhaleWorkflow;
    if (workflow !== null && workflow !== undefined && typeof workflow.subagentRoleOf === "function") {
      const role = workflow.subagentRoleOf(agent);
      if (role !== null && role !== undefined && typeof role === "object") return true;
    }
  } catch {
    // 服务读取/判定异常一律按禁止处理（fail-closed）。
  }
  return false;
}

function resolveServiceValue(ctx, name) {
  if (ctx === null || ctx === undefined || typeof ctx !== "object") return undefined;
  try {
    if (typeof ctx.get === "function") {
      const value = ctx.get(name);
      if (value !== null && value !== undefined) return value;
    }
  } catch {
    // fall through to property read for stub contexts.
  }
  return ctx[name];
}

function nonEmptyPair(provider, model) {
  return typeof provider === "string" && provider.trim().length > 0 &&
    typeof model === "string" && model.trim().length > 0;
}

function extractProviderModel(config) {
  if (config === null || config === undefined || typeof config !== "object") return null;
  if (!nonEmptyPair(config.provider, config.model)) return null;
  return { provider: config.provider, model: config.model };
}

/** Route priority: requestHeader().config → agent.options → agentDefaultModel. */
export function resolveWhaleSummarizerRoute(ctx, agent) {
  try {
    const header = agent?.session?.requestHeader?.();
    const fromHeader = extractProviderModel(header?.config);
    if (fromHeader !== null) return fromHeader;
  } catch {
    // fall through
  }
  const options = agent?.options;
  const fromOptions = extractProviderModel(options);
  if (fromOptions !== null) return fromOptions;
  try {
    const defaultModel = resolveServiceValue(ctx, "agentDefaultModel");
    const selection =
      defaultModel !== null &&
      defaultModel !== undefined &&
      typeof defaultModel.currentSelection === "function"
        ? defaultModel.currentSelection()
        : undefined;
    const fromDefault = extractProviderModel(selection);
    if (fromDefault !== null) return fromDefault;
  } catch {
    // fall through to NO_ROUTE
  }
  throw new WhaleSummarizerError(
    ERROR_CODES.NO_ROUTE,
    "whale_summarizer cannot resolve provider/model: requestHeader, agent.options, and agentDefaultModel are all unavailable",
  );
}

async function ensureReasoningOffSupported(ctx, route, signal) {
  const llm = resolveServiceValue(ctx, "llm");
  if (llm === null || llm === undefined || typeof llm !== "object") {
    throw new WhaleSummarizerError(
      ERROR_CODES.UNSUPPORTED_REASONING_OFF,
      "whale_summarizer cannot verify reasoning-off support: llm service unavailable",
    );
  }
  if (typeof llm.resolveCallConfig === "function") {
    try {
      await llm.resolveCallConfig(
        { provider: route.provider, model: route.model, reasoningEffort: "off" },
        signal,
      );
      return;
    } catch (error) {
      throw new WhaleSummarizerError(
        ERROR_CODES.UNSUPPORTED_REASONING_OFF,
        `whale_summarizer cannot guarantee reasoningEffort "off" for ${route.provider}/${route.model}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }
  if (typeof llm.resolveModelInfo === "function") {
    try {
      const info = await llm.resolveModelInfo(route.provider, route.model, signal);
      const efforts = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts : [];
      if (efforts.some((effort) => effort?.id === "off")) return;
    } catch (error) {
      throw new WhaleSummarizerError(
        ERROR_CODES.UNSUPPORTED_REASONING_OFF,
        `whale_summarizer model capability check failed for ${route.provider}/${route.model}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }
  throw new WhaleSummarizerError(
    ERROR_CODES.UNSUPPORTED_REASONING_OFF,
    `whale_summarizer cannot guarantee reasoningEffort "off" for ${route.provider}/${route.model}`,
  );
}

export function createWhaleSummarizerService(ctx) {
  return {
    version: 1,
    async summarize(input, runtime = {}) {
      const agent = runtime?.agent ?? ctx?.agent;
      const signal = runtime?.signal;
      if (signal?.aborted === true) {
        const error = new Error("whale_summarizer summarize aborted before start");
        error.name = "AbortError";
        throw error;
      }
      const services = {
        kazMode: resolveServiceValue(ctx, "kazMode"),
        kaWhaleWorkflow: resolveServiceValue(ctx, "kaWhaleWorkflow"),
      };
      if (!isWhaleSummarizerScopeAllowed(services, agent)) {
        throw new WhaleSummarizerError(
          ERROR_CODES.SCOPE_DENIED,
          "WHALE_SUMMARIZER_SCOPE_DENIED: whaleSummarizer is restricted to Kaz mode and controlled Kaz subagents.",
        );
      }
      const validated = validateSummarizeInput(input);
      if (validated.error) {
        throw new WhaleSummarizerError(validated.error.code, validated.error.message);
      }
      const normalized = validated.input;
      const route = resolveWhaleSummarizerRoute(ctx, agent);
      await ensureReasoningOffSupported(ctx, route, signal);

      let lastError;
      const maxAttempts = normalized.opts.maxAttempts;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (signal?.aborted === true) {
          const error = new Error("whale_summarizer summarize aborted during retry");
          error.name = "AbortError";
          throw error;
        }
        try {
          const summary = await runSingleLlmAttempt(ctx, {
            normalized,
            route,
            agent,
            signal,
          });
          return {
            summary,
            sourceIds: sourceIdsOf(normalized),
          };
        } catch (error) {
          if (error?.name === "AbortError" || signal?.aborted === true) throw error;
          lastError = error;
        }
      }
      throw new WhaleSummarizerError(
        ERROR_CODES.SUMMARY_FAILED,
        `whale_summarizer failed after ${maxAttempts} total attempt(s); no deterministic fallback is used`,
        { cause: lastError },
      );
    },
  };
}

export default {
  name: "whale-summarizer",
  inject: ["llm"],
  apply(ctx, _config = {}) {
    const service = createWhaleSummarizerService(ctx);
    ctx.effect(() => {
      const disposeService = ctx.provide("whaleSummarizer", service);
      return () => {
        if (typeof disposeService === "function") disposeService();
      };
    }, "whale-summarizer: publish internal whaleSummarizer service (model-invisible)");
  },
};
