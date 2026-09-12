// kaz-context-policy —— 上下文压缩提醒（§四）。
//
// 形态：一条 plugin 消息（**上下文注入**，不是系统提示段），只有一行。
// 时机：占用 ≥50% 后，每再涨 5 个百分点就注入一次；回落到 50% 以下即停，
//       之后再涨到 50% 以上会重新开始计数。每个 step 检查一次（工具结果把占用
//       顶上去也算"涨"）。
// 内容：附上"建议至少压掉多少 token" = 当前占用 − 30%×窗口；压够就能回到 30% 以下。
// 数据：contextPressure 投影（pressureTokens = 最近一次请求的占用；contextWindow = 窗口）。

import { createUserMessage } from "@deepseek-ai/dsh-llm";

/** 注入阈值：占用达到窗口的这个百分比就开始提醒。 */
export const HINT_THRESHOLD_PERCENT = 50;

/** 触发步长：已经提醒过之后，占用再涨这么多个百分点就再提醒一次。 */
export const HINT_STEP_PERCENT = 5;

/** 建议目标：压到窗口的这个百分比以下。 */
export const HINT_TARGET_PERCENT = 30;

/** 每个对话最近一次提醒时的占用百分比（回落到阈值以下就清掉，重新计数）。 */
const hintedPercent = new Map();

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

/** 建议至少压掉多少 token：当前占用 − 30%×窗口。 */
export function hintNeedTokens(pressure) {
  const need = Math.ceil(pressure.used - (HINT_TARGET_PERCENT / 100) * pressure.window);
  return need > 0 ? need : 0;
}

/** 达到阈值时的提醒原文（英文）；未达阈值返回空串。 */
export function hintText(ctx, session) {
  const pressure = readPressure(ctx, session);
  if (pressure === null || pressure.percent < HINT_THRESHOLD_PERCENT) return "";
  const need = hintNeedTokens(pressure);
  return [
    "[ka-context-policy compression-hint]",
    `Context usage is ${pressure.percent}% (${pressure.used} / ${pressure.window} tokens). Pick a redundant middle span and run context_compress soon (box it with both from_seq and to_seq) — compressing at least ~${need} tokens brings usage under ${HINT_TARGET_PERCENT}%. This hint reappears every ${HINT_STEP_PERCENT}% of further growth.`,
  ].join("\n");
}

/**
 * 注册上下文注入：每个 step 检查占用；≥50% 且比上次提醒时又涨了 5 个百分点，
 * 就追加一条提醒消息。回落 <50% 清零，重新开始计数。
 */
export function installHintInjection(ctx) {
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (decision === null || typeof decision !== "object" || decision.kind !== "enter") return decision;
    const agent = payload?.agent;
    if (agent === undefined || agent === null || typeof agent !== "object") return decision;
    const sessionId = agent.session?.id;
    const pressure = readPressure(ctx, agent.session);
    if (pressure === null) return decision;
    if (pressure.percent < HINT_THRESHOLD_PERCENT) {
      if (typeof sessionId === "string") hintedPercent.delete(sessionId);
      return decision;
    }
    const last = typeof sessionId === "string" ? hintedPercent.get(sessionId) : undefined;
    if (last !== undefined && pressure.percent < last + HINT_STEP_PERCENT) return decision;
    if (typeof sessionId === "string") hintedPercent.set(sessionId, pressure.percent);
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
