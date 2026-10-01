// kaz-shared —— 「上一轮的回复被判为非法」的恢复：**有界重试 + 一条给模型看的报错**。
//
// ── 为什么需要它（2026-10-01 实测）────────────────────────────────────────────
// dsh 官方的 DeepSeek Messages 适配器在**流结算那一刻**把每个已完成的 tool call 的
// 参数 JSON.parse 一遍，只要有一个不合法就抛 `MALFORMED_RESPONSE`
// （packages/llm/llm-deepseek/src/translate.ts 的那句
// `try { parsed = JSON.parse(content.arguments) } catch { return malformed('tool input is invalid JSON') }`）。
//
// 这一抛**发生在派发之前**：工具一次都没跑，模型写的参数整份作废。实测那次是
// `write_arrangement` 的 3853 字参数里每条 `"task": "…"` 后面各多一个 `]`，
// 于是 whale_report 刚刚跳进 arrange_agent 的整轮全丢，模型连"我写坏了"都学不到。
//
// 而 `MALFORMED_RESPONSE` **不在默认重试码里**（llm/src/retry-policy.ts 只有
// EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT），所以 llm-retry 也不会管它。
//
// 换一条路由就是另一种命运：同为 DeepSeek 的 pi-ai 适配器对同样的坏参数只降级成 `{}`，
// 由工具层回一句 `invalid arguments: "arguments" must be an object`，模型自己重写一次就过去了。
// 数据侧看得见这个分界：历史里 `write_arrangement` 参数不合法共 64 次，全部落在
// 9/13–9/23 的 v3 会话（旧运行时），其中 56 次那一轮**正常跑完**；唯一一次整轮死亡是
// 10/01、也就是 Messages-only 适配器上线（99e22ebbeb，9/19）之后。
//
// ── 为什么恢复写在这里，而不是写进工具 ───────────────────────────────────────
// 工具够不着：参数在派发之前就被拒了，`execute` 根本没进。但 dsh 的 agent-loop 把这次失败
// 当作一个**瀑布事件**交出来，让部署方决定动作 —— `agent/request-error`
// （见 packages/core/agent/src/runtime-types.ts：`A listener returns { kind: 'retry' }
// without calling next() when it owns recovery, or calls next() to delegate`），
// 并且设计文档把这件事写成了原则：**适配器报告事实，动作属于部署策略**
//（.agents/notes/implemented/architecture/2026-06-21-bounded-llm-request-recovery.md）。
// 这个模块就是 Kaz 这条部署策略。
//
// ── 三处判断的理由 ───────────────────────────────────────────────────────────
// 1) 认领整个 `MALFORMED_RESPONSE`，不按报错文案匹配：文案是上游随时可改的东西，
//    拿它当判据等于给自己埋一根看不见的引线。整码认领的代价只是"别的非法流也会被重试一次"，
//    而那几种（SSE 不是 JSON、块下标非法、stop_reason 不认识）同样是重发一次就可能好的东西。
//    也就是说：判宽了只是多花一次采样，判窄了才是漏掉真正要救的那次。
// 2) 重试前先插一条提示：光重试等于"再采一次样"，模型不知道上一轮为什么被丢，
//    很可能照着同一份结构再写一遍、坏在同一处。把"你那轮被丢了"说清楚，重试才有方向。
// 3) **每个 step 只救一次**：坏输出是模型自己产出的，不是网络的，无限重试只会在同一个坏结构上
//    烧 token。一次足够——重试是在**同一个 step 内**重来，请求从已提交的历史重建
//    （失败的那次只落成非 surface 的 `assistant/attempt`，见上面那份设计文档），
//    上下文一点没少，模型完全有能力一次改对。第二次还坏就按原样把失败交给上层（turn 结束）。
//
// ── 已知耦合（改上层时要回来看这里）────────────────────────────────────────
// 这条恢复**排在 llm-retry 后面**：瀑布按注册顺序走，而 llm-retry 对不在自己重试码里的失败
// 会 `next()` 放行，所以今天轮得到我们。哪天有人把 `MALFORMED_RESPONSE` 加进
// provider 的 `retryPolicy.retryableCodes`，llm-retry 会先认领（静默重试、不吃我们这条提示），
// 本模块就静默失效——不会报错，只会不再说话。

import { createUserMessage } from "@deepseek-ai/dsh-llm";

/** 被适配器判为非法的那一类失败码（dsh 的 LlmFailure.code）。 */
export const MALFORMED_RESPONSE_CODE = "MALFORMED_RESPONSE";

/** 同一个 step 最多救几次。1 = 只给模型一次改正的机会。 */
export const MAX_RECOVERIES_PER_STEP = 1;

/** 提示的注入头（与阶段注入、其它提示分开：日志里按头分类）。 */
export const MALFORMED_HINT_HEADER = "[kaz-shared malformed-stream]";

/**
 * 提示正文（模型面文案，英文）。
 *
 * 措辞的两条约束：
 *   * **只说事实**：它说不出到底坏在哪（那是适配器的判据，不是我们的），所以不猜原因，
 *     只说"这一轮被丢了、什么都没留下、重发一遍"。
 *   * **给出最可能的那条规矩**：以 "if it carried a tool call" 起头，因为实测的唯一
 *     可达场景就是工具参数写坏（结构没闭合）。写成条件句而不是断言，是为了它同时适用于
 *     另一种非法流（那时这句只是无害的多余）。
 */
export const MALFORMED_HINT_BODY =
  "The last reply was dropped before anything ran: the provider rejected its stream as malformed, so none of it was kept and no tool call from it reached us. Re-emit that step now. If it carried a tool call, send one complete JSON object — close every bracket and quote, and put nothing after the closing brace.";

/**
 * 完整注入文本：头部 + 正文（与其它提示同形）。
 * @returns {string} 注入文本。
 */
export function renderMalformedRecoveryText() {
  return [MALFORMED_HINT_HEADER, MALFORMED_HINT_BODY].join("\n");
}

/**
 * 这次失败该不该由我们救。
 *
 * 判据只有一条：失败码是不是 `MALFORMED_RESPONSE`。不看文案（理由见文件头第 1 条）。
 * @param {unknown} failure - dsh 的 LlmFailure（`{ message, code, … }`）。
 * @returns {boolean} 是否认领。
 */
export function isMalformedResponse(failure) {
  return failure !== null && typeof failure === "object" && failure.code === MALFORMED_RESPONSE_CODE;
}

/**
 * 造一个 `agent/request-error` 监听器。
 *
 * 状态就一份：`recovered` —— 每个会话**在哪个 step 上救过几次**（`{ key, count }`）。
 * 按会话收敛成一个键，所以它不随 step 数增长；跨会话各算各的。
 *
 * @param {object} [deps] - 依赖。
 * @param {object} [deps.logger] - cordis logger（可选）。
 * @returns {(payload: object, next: () => Promise<object|undefined>) => Promise<object|undefined>}
 *   瀑布监听器：认领时返回 `{ kind: "retry" }`，否则 `next()`。
 */
export function createMalformedRecovery({ logger } = {}) {
  /** sessionId -> `{ key, count }`：这个会话在哪个 step 上已经救过几次。 */
  const recovered = new Map();

  return async function recoverFromMalformedStream(payload, next) {
    const { agent, turn, step, failure, signal } = payload ?? {};
    if (!isMalformedResponse(failure)) return next();
    // 取消优先：用户按了停止就不要再发一次请求（与 dsh 自己的恢复路径同一条规矩）。
    if (signal?.aborted) return next();

    const session = agent?.session;
    const sessionId = session?.id;
    if (typeof sessionId !== "string" || sessionId.length === 0) return next();
    if (typeof session?.append !== "function") return next();

    const stepKey = `${String(turn)}:${String(step)}`;
    const previous = recovered.get(sessionId);
    const used = previous?.key === stepKey ? previous.count : 0;
    if (used >= MAX_RECOVERIES_PER_STEP) return next();

    // 先插提示、再返回 retry：重试请求是从**已提交的历史**重建的，所以这条消息
    // 会出现在重试那次的请求里。来源标成 plugin + notice，与其它注入同形
    // （模型看得出这是插件说的话，不是用户说的）。
    try {
      session.append("user/message", createUserMessage({
        content: [{ type: "text", text: renderMalformedRecoveryText() }],
        source: {
          kind: "plugin:kaz-shared",
          form: "notice",
          summary: "malformed-stream",
        },
      }), { surfaceOp: "append" });
    } catch (error) {
      // 插不进去就**别重试**：重试一次而不告诉模型为什么，等于让它照着坏结构再写一遍，
      // 白烧一次采样。退回上层（失败照旧）比"悄悄重试"诚实。这一步的预算不动。
      logger?.warn?.(
        `[kaz-shared] malformed-stream recovery skipped: the notice could not be appended: ${error instanceof Error ? error.message : String(error)}`,
      );
      return next();
    }

    // 提示已经进去了，这一步的预算才真的花掉。
    recovered.set(sessionId, { key: stepKey, count: used + 1 });
    logger?.warn?.(
      `[kaz-shared] malformed stream (${String(failure.code)}) at turn ${String(turn)} step ${String(step)}: the failed attempt stayed out of history, the model was told, retrying this step`,
    );
    return { kind: "retry" };
  };
}

/**
 * 把恢复挂到 agent 的失败瀑布上。
 * @param {object} ctx - 插件上下文。
 */
export function installMalformedRecovery(ctx) {
  ctx.on("agent/request-error", createMalformedRecovery({ logger: ctx?.logger }));
}
