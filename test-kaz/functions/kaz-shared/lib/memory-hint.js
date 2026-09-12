// kaz-shared —— 记忆提示用的"观察工具集"与"连续调用"计数。
//
// 目的：主代理在一条会话里**连续**调用这些工具（侦察/排查动作）到一定次数、却始终没进
// arrange_agent 派发，就值得问一句"这轮有没有值得存的经验"。提示文本由 ka-whale-workflow
// 在 agent/pre-step 里注入（`[ka-whale-workflow memory_hint]`），本模块只负责"数够了没有"。
//
// 读的是**会话事件流**（`session.snapshotEvents()`），不是内存计数——所以：
//   * 每个事件只处理一次（调用方用"已扫到的 seq"做守卫），重复调用天然幂等；
//   * 重启后从事件流重建，不依赖进程状态。

/** 观察工具集：主代理连续调用这些工具到阈值就提示。 */
export const MEMORY_HINT_TOOLS = Object.freeze(["grep", "glob", "read", "pwsh"]);

/** 连续调用多少次才提示。 */
export const MEMORY_HINT_THRESHOLD = 5;

/** 本轮（自最近一条用户消息以来）是否提示过。 */
function isRoundStart(event) {
  return event?.type === "user/message" && event?.data?.source?.kind === "user";
}

/**
 * 把一个会话事件计入"连续调用"状态。
 *
 * 语义（按设计）：
 *   * 用户发消息 → 新的一轮开始：连续计数清零、本轮的"已提示"标记清零（提示按轮计，每轮最多一次）；
 *   * 调用了**不在**观察集里的工具（或非工具事件里出现阶段变化）→ 连续中断，计数清零；
 *   * 调用了观察集里的工具 → 计数 +1；
 *   * 进入 arrange_agent（stage !== "idle"）→ 计数清零（已经去派发了，提示没有意义）。
 *
 * @param {object} state - 会话状态（就地修改 streak / roundHinted）。
 * @param {object} event - 一个会话事件（形状见 dsh-session：{ type, data, seq }）。
 * @returns {void}
 */
export function noteMemoryHintEvent(state, event) {
  if (state === null || typeof state !== "object" || event === null || typeof event !== "object") return;
  if (isRoundStart(event)) {
    state.streak = 0;
    state.roundHinted = false;
    return;
  }
  if (state.stage !== "idle") {
    state.streak = 0;
    return;
  }
  if (event.type !== "tool/call") return;
  const name = event?.data?.name;
  state.streak = typeof name === "string" && MEMORY_HINT_TOOLS.includes(name) ? state.streak + 1 : 0;
}

/**
 * 现在该不该注入记忆提示。
 *
 * 触发条件：处于 idle 阶段、本轮还没提示过、且连续调用观察集工具已达阈值。
 * 命中后把本轮的"已提示"标记置上——**同一轮里只提示一次**，避免每一步都刷屏。
 *
 * @param {object} state - 会话状态（命中时就地置 roundHinted）。
 * @returns {boolean} 是否应当注入。
 */
export function shouldHintMemory(state) {
  if (state === null || typeof state !== "object") return false;
  if (state.stage !== "idle") return false;
  if (state.roundHinted === true) return false;
  if (!(state.streak >= MEMORY_HINT_THRESHOLD)) return false;
  state.roundHinted = true;
  return true;
}
