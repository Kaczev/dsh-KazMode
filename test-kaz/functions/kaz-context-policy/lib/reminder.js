// kaz-context-policy —— 上下文压缩提醒（§四）。
//
// 形态：系统提示里的独立一段、只有一行；本会话占用 ≥50% 时出现，压缩后回落即消失。
// 数据：contextPressure 投影（pressureTokens=最近一次请求的占用；contextWindow=窗口）。

export const HINT_SECTION_NAME = "kaz-context-policy:compression-hint";

/** 段落顺序：TOOL_REPORT(2900) 与 TOOLS_SDK(5000) 之间，属于模型面提示。 */
export const HINT_ORDER = 2950;

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

/** 达到阈值时的注入原文（英文）；否则空串（空段不渲染）。 */
export function hintText(ctx, session) {
  const pressure = readPressure(ctx, session);
  if (pressure === null || pressure.percent < HINT_THRESHOLD_PERCENT) return "";
  return [
    "[ka-context-policy compression-hint]",
    `Context usage is ${pressure.percent}% (${pressure.used} / ${pressure.window} tokens). No need to compress immediately, but pick a redundant middle span and run context_compress soon (say what to drop; the tool locates the range). This hint disappears once compression is done.`,
  ].join("\n");
}

/** 注册动态段落：每轮 assemble 时按当前 agent 的占用决定是否注入。 */
export function installHintSection(ctx) {
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: HINT_SECTION_NAME,
        order: HINT_ORDER,
        text: (context) => hintText(ctx, context?.agent?.session),
      }),
    "kaz-context-policy compression hint",
  );
}
