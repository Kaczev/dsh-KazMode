// kaz-context-policy —— 上下文压缩提醒（§四）。
//
// 形态：一条 plugin 消息（**上下文注入**，不是系统提示段），只有一行；
//       在"用户发消息的那一轮开头"注入；占用 ≥50% 才出现，压缩回落后自然不再出现。
// 数据：contextPressure 投影（pressureTokens = 最近一次请求的占用；contextWindow = 窗口）。

import { createUserMessage } from "@deepseek-ai/dsh-llm";

/** 注入阈值：占用达到窗口的这个百分比就开始提醒。 */
export const HINT_THRESHOLD_PERCENT = 50;

/** 读上下文占用；拿不到就返回 null。 */
export function readPressure(ctx, session) {
  if (session === undefined || session === null) return null;
  try {
    const projections = ctx.get("sessionProjections");
    if (projections === undefined || typeof projections.snapshot !== "function") return null;
    const value = projections.snapshot(session, ["contextPressure"])?.values?.contextPressure;
    if (value === undefined || value === null) return null;
    const contextWindow = value.contextWindow;
    const used = typeof value.projectedTokens === "number" ? value.projectedTokens : value.pressureTokens;
    if (typeof contextWindow !== "number" || contextWindow <= 0 || typeof used !== "number" || used < 0) return null;
    return { percent: Math.round((used / contextWindow) * 100), used, window: contextWindow };
  } catch {
    return null;
  }
}

/** 达到阈值时的提醒原文（英文）；否则空串。 */
export function hintText(ctx, session) {
  const pressure = readPressure(ctx, session);
  if (pressure === null || pressure.percent < HINT_THRESHOLD_PERCENT) return "";
  return [
    "[ka-context-policy compression-hint]",
    `Context usage is ${pressure.percent}% (${pressure.used} / ${pressure.window} tokens). No need to compress immediately, but pick a redundant middle span and run context_compress soon (say what to drop; the tool locates the range). This hint disappears once compression is done.`,
  ].join("\n");
}

/** 注册上下文注入：用户消息那一轮的开头、且占用 ≥ 阈值时，追加一条提醒消息。 */
export function installHintInjection(ctx) {
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (decision === null || typeof decision !== "object" || decision.kind !== "enter") return decision;
    const agent = payload?.agent;
    if (agent === undefined || agent === null || typeof agent !== "object") return decision;
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    const userTurn = payload?.step === 1 && messages.some((message) => message?.source?.kind === "user");
    if (!userTurn) return decision;
    const text = hintText(ctx, agent.session);
    if (text.length === 0) return decision;
    decision.messages.push(
      createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "plugin", plugin: "kaz-context-policy", form: "notice", summary: "compression-hint" },
      }),
    );
    return decision;
  });
}
