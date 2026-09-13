// kaz-context-policy —— 上下文压缩提醒（§四）。
//
// 形态：一条 plugin 消息（**上下文注入**，不是系统提示段）。
// 时机：占用 ≥50% 后开始提醒；之后每再涨 ≥5 个百分点就再提醒一次。回落到 50% 以下即清空
//       状态，之后再涨到 50% 以上会重新从第一次的措辞开始。每个 step 检查一次。
//
// 反"被当噪音"的三条设计（依据：一次真实事故——同一条恒定措辞重复 4 次，全部被忽略）：
//   1) **带增量**：重复提醒会写明"比上次提醒时又涨了 N 个点"，让它是新信息而不是回声。
//   2) **带升级**：第 3 次起换标题与措辞（ACTION REQUIRED、要求先压缩再继续），
//      不再和第一次长得一样。
//   3) **消解顾虑**：明说"压缩已收尾的旧中段不影响眼前任务"——把"会不会丢正在用的东西"
//      这个最常见的拖延理由直接堵掉。
//   （曾试过"被忽略后把门槛降到 2 点"来加强提醒，实测正好相反：它让提示更频繁、更像噪音，
//     已移除。降噪的方向是**更少但更有信息量**，不是更密。）
//
// 数据：contextPressure 投影（pressureTokens = 最近一次请求的占用；contextWindow = 窗口）。

import { createUserMessage } from "@deepseek-ai/dsh-llm";

/** 注入阈值：占用达到窗口的这个百分比就开始提醒。 */
export const HINT_THRESHOLD_PERCENT = 50;

/** 触发步长：比上次提醒时又涨这么多就再提醒。 */
export const HINT_STEP_PERCENT = 5;

/** 建议目标：压到窗口的这个百分比以下。 */
export const HINT_TARGET_PERCENT = 35;

/** 第几次起换措辞（升级为 ACTION REQUIRED）。 */
export const HINT_ESCALATE_AT = 3;

/** 占用比上次提醒时下降这么多点，就认为"压过了"（据此改用"压了但不够"的口径）。 */
export const HINT_COMPRESSED_DROP_PERCENT = 10;

/** 每个对话的提醒状态：上次提醒时的占用，以及提醒过几次。回落阈值以下就清空。 */
const hintState = new Map();

/** 只读：取某会话当前的提醒状态（供测试/诊断，不改变行为）。 */
export function peekHintState(sessionId) {
  return hintState.get(sessionId);
}

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

/** 建议至少压掉多少 token：当前占用 − 35%×窗口。 */
export function hintNeedTokens(pressure) {
  const need = Math.ceil(pressure.used - (HINT_TARGET_PERCENT / 100) * pressure.window);
  return need > 0 ? need : 0;
}

/**
 * 达到阈值时的提醒原文（英文）；未达阈值返回空串。
 * @param {object} ctx - 插件上下文（读投影）。
 * @param {object} session - 会话。
 * @param {object} [state] - 该会话的提醒状态 `{ percent, count }`（上次提醒时）。
 * @param {{compressed?: boolean}} [options] - `compressed` 为真表示上次提醒后确实压过（但没压够）。
 */
export function hintText(ctx, session, state, options) {
  const pressure = readPressure(ctx, session);
  if (pressure === null || pressure.percent < HINT_THRESHOLD_PERCENT) return "";
  const need = hintNeedTokens(pressure);
  const count = typeof state?.count === "number" ? state.count : 0;
  const previous = typeof state?.percent === "number" ? state.percent : undefined;
  const grew = previous === undefined ? undefined : pressure.percent - previous;
  const escalated = count + 1 >= HINT_ESCALATE_AT;
  // 上次提醒之后是否压过（但没压够）：由门控传入，或在占用下降时推断。
  const underCompressed = options?.compressed === true || (grew !== undefined && grew < 0);

  const head = escalated ? "[ka-context-policy compression-hint · ACTION REQUIRED]" : "[ka-context-policy compression-hint]";
  const lines = [head];

  if (grew === undefined) {
    lines.push(
      `Context usage is ${pressure.percent}% (${pressure.used} / ${pressure.window} tokens). Compress now: pick an already-finished middle span and run context_compress with its from_seq and to_seq.`,
    );
  } else if (underCompressed) {
    // 关键反馈：上次压缩确实生效了，但幅度不够——明确说出来，并给出还差多少。
    // 下降幅度：本次检查看到的（grew<0），或跨阈值时记下的 fell。
    const fell = grew !== undefined && grew < 0 ? -grew : typeof state?.fell === "number" ? state.fell : undefined;
    lines.push(
      `Context usage is ${pressure.percent}% (${pressure.used} / ${pressure.window} tokens). The compression since this reminder did work` +
        (fell === undefined ? "" : ` — usage fell ${fell} point(s)`) +
        `, but not enough: it is back above ${HINT_THRESHOLD_PERCENT}% and still ${need} tokens over the ${HINT_TARGET_PERCENT}% target.`,
    );
    lines.push(
      "Fold a larger span this time: pick the oldest spans whose work is already finished, not the smallest one that fits.",
    );
  } else {
    lines.push(
      `Context usage is ${pressure.percent}% (${pressure.used} / ${pressure.window} tokens) — up ${grew} point(s) since this reminder was last given` +
        (escalated ? `, and it has now been ignored ${count} time(s).` : "."),
    );
    lines.push(
      escalated
        ? "Stop other work and compress before continuing: an already-finished middle span is safe to fold, and folding it does not disturb the task in front of you."
        : "Compress soon: fold an already-finished middle span (from_seq / to_seq). Folding old, settled work does not disturb the task in front of you.",
    );
  }

  lines.push(`Compressing at least ~${need} tokens brings usage under ${HINT_TARGET_PERCENT}%.`);
  return lines.join("\n");
}

/**
 * 注册上下文注入：每个 step 检查占用，按"涨了 5 个点"或"被忽略后涨了 2 个点"追加提醒。
 * 回落 <50% 清空状态，重新计数。
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
      // 回落到阈值以下：状态清空。但若这次下降幅度够大，说明刚刚压过——
      // 把这个事实带过阈值线，下一次提醒才能以"压了但不够"的口径说话。
      const previous = typeof sessionId === "string" ? hintState.get(sessionId) : undefined;
      const justCompressed = previous !== undefined && pressure.percent <= previous.percent - HINT_COMPRESSED_DROP_PERCENT;
      if (typeof sessionId === "string") {
        if (justCompressed) {
          // 把"降了多少点"一并记下——跨过阈值后就看不到那次降幅了。
          hintState.set(sessionId, { percent: pressure.percent, count: 0, compressed: true, fell: previous.percent - pressure.percent });
        } else {
          hintState.delete(sessionId);
        }
      }
      return decision;
    }
    const state = typeof sessionId === "string" ? hintState.get(sessionId) : undefined;
    // "压过了"的两种来源：跨越阈值时记下的标记，或本次检查发现占用比上次提醒时明显下降。
    const compressed =
      state?.compressed === true || (state !== undefined && pressure.percent <= state.percent - HINT_COMPRESSED_DROP_PERCENT);
    const count = compressed ? 0 : (state?.count ?? 0);
    if (state !== undefined && !compressed && pressure.percent - state.percent < HINT_STEP_PERCENT) return decision;
    if (typeof sessionId === "string") hintState.set(sessionId, { percent: pressure.percent, count: count + 1, compressed });
    const text = hintText(ctx, agent.session, state, { compressed });
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
