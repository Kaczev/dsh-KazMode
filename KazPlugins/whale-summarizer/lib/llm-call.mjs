// whale-summarizer —— auxiliary LLM call seam.
// ===========================================================================
// One standalone ctx.llm.stream request per summarize attempt:
//   - provider/model selected by route resolver (never switched during retries);
//   - reasoningEffort: "off" (prechecked by the caller/service);
//   - one independent user message; no system, no tools, no DSH purpose,
//     no main-session history.
// ===========================================================================

import {
  BlockAssembler,
  createUserMessage,
} from "@deepseek-ai/dsh-llm";
import { buildPrompt, assembleSummaryText, finishErrorOf } from "./core.mjs";

export const DEFAULT_MAX_SUMMARY_TOKENS = 600;

/** Build the exact GenerateOptions object for one summarize attempt. */
export function buildGenerateOptions({ normalized, route, agent, signal }) {
  const prompt = buildPrompt(normalized);
  const messages = [
    createUserMessage({
      content: [{ type: "text", text: prompt }],
      source: { kind: "plugin", plugin: "whale-summarizer" },
    }),
  ];
  return {
    provider: route.provider,
    model: route.model,
    reasoningEffort: "off",
    messages,
    maxTokens: DEFAULT_MAX_SUMMARY_TOKENS,
    ...(agent?.session?.id !== undefined && agent.session.id !== null
      ? { sessionId: agent.session.id }
      : {}),
    ...(signal !== undefined ? { signal } : {}),
  };
}

/**
 * Run one stream attempt and return the validated summary text.
 * Throws WhaleSummarizerError on stream/output failure; the caller owns retry.
 */
export async function runSingleLlmAttempt(ctx, deps) {
  const options = buildGenerateOptions(deps);
  const assembler = new BlockAssembler();
  const stream = ctx?.llm?.stream;
  if (typeof stream !== "function") {
    throw new Error("WHALE_SUMMARIZER_LLM_UNAVAILABLE: ctx.llm.stream is not a function");
  }
  try {
    for await (const chunk of stream.call(ctx.llm, options)) {
      if (deps.signal?.aborted === true) {
        const error = new Error("whale_summarizer request aborted");
        error.name = "AbortError";
        throw error;
      }
      assembler.push(chunk);
    }
  } catch (error) {
    if (error?.name === "AbortError" || deps.signal?.aborted === true) throw error;
    throw error;
  }
  const finishError = finishErrorOf(assembler.finish);
  if (finishError !== null && finishError !== undefined) throw finishError;
  const parsed = assembleSummaryText(assembler.blocks(), deps.normalized.opts.maxSummaryChars);
  if (parsed.error) {
    const error = new Error(parsed.error.message);
    error.code = parsed.error.code;
    throw error;
  }
  return parsed.summary;
}
