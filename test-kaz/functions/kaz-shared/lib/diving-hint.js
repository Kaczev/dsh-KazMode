// kaz-shared —— "刹车"提示（diving hint）的计数与触发点。
//
// 目的：主代理在一个回合里埋头调用工具太久（一轮内总数跨过 32，之后每再满 16），
// 就该停下来问自己：是不是卡住了、是不是拖太久了、要不要向用户汇报。
// 提示文本由 ka-whale-workflow 在 agent/pre-step 里注入（`[ka-whale-workflow diving-hint]`）。
//
// 与 memory-hint.js 的分工：那条数的是"**连续**调用观察工具集"（侦察后要不要存记忆），
// 这条数的是"一轮内**所有**工具调用总数"（有没有陷进去）。两者独立，互不影响。
//
// 计数读会话事件流（`session.snapshotEvents()`），由调用方用"已扫到的 seq"做守卫，
// 所以每个事件只算一次、重复调用幂等、重启后可从事件流重建。

/** 第一次提示的门槛：一轮内第 32 次工具调用。 */
export const DIVING_FIRST_THRESHOLD = 32;

/** 之后的重复间隔：每再满 16 次各提示一次。 */
export const DIVING_REPEAT_EVERY = 16;

/**
 * 本轮的触发点列表：32, 48, 64, 80 …
 * @param {number} calls - 当前一轮内的工具调用总数。
 * @returns {number[]} 已跨过、应当触发过的节点。
 */
export function divingMilestonesReached(calls) {
  if (!(calls >= DIVING_FIRST_THRESHOLD)) return [];
  const out = [];
  for (let n = DIVING_FIRST_THRESHOLD; n <= calls; n += DIVING_REPEAT_EVERY) out.push(n);
  return out;
}

/** 本轮开始：用户消息重置计数与已触发节点。 */
function isRoundStart(event) {
  return event?.type === "user/message" && event?.data?.source?.kind === "user";
}

/**
 * 把一个会话事件计入本轮的工具调用总数。
 * @param {object} state - 会话状态（就地修改 roundToolCalls / divingMilestone）。
 * @param {object} event - 一个会话事件。
 * @returns {void}
 */
export function noteDivingEvent(state, event) {
  if (state === null || typeof state !== "object" || event === null || typeof event !== "object") return;
  if (isRoundStart(event)) {
    state.roundToolCalls = 0;
    state.divingMilestone = 0;
    return;
  }
  if (event.type === "tool/call") state.roundToolCalls += 1;
}

/**
 * 现在该不该注入"刹车"提示。
 *
 * 触发条件：本轮工具调用总数已跨过下一个节点（32 起、之后每 16）。同一节点只提示一次；
 * 一次跨过多个节点（例如一口气补扫了 20 次调用）也**只提示一次**，只把节点推进到最新——
 * 补发一串重复提示没有意义。
 *
 * @param {object} state - 会话状态（命中时就地推进 divingMilestone）。
 * @returns {boolean} 是否应当注入。
 */
export function shouldHintDiving(state) {
  if (state === null || typeof state !== "object") return false;
  const calls = Number.isFinite(state.roundToolCalls) ? state.roundToolCalls : 0;
  const reached = divingMilestonesReached(calls);
  if (reached.length === 0) return false;
  const latest = reached[reached.length - 1];
  const fired = Number.isFinite(state.divingMilestone) ? state.divingMilestone : 0;
  if (latest <= fired) return false;
  state.divingMilestone = latest;
  return true;
}

/**
 * 子代理专用状态上的合并入口：把事件计入、再判断是否该提示。
 *
 * 子代理的会话状态自己保管（不经过工作流的会话表），所以这里提供"一步到位"的辅助，
 * 让调用方只需要一个 `{ roundToolCalls, divingMilestone }` 形状的对象。
 *
 * @param {object} state - 子代理的刹车状态（就地修改）。
 * @param {object} event - 一个会话事件。
 * @returns {boolean} 是否应当注入。
 */
export function divingHintStep(state, event) {
  noteDivingEvent(state, event);
  return shouldHintDiving(state);
}
