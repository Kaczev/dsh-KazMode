// kaz-shared —— "自己动手造东西"提示（building hint）的计数与触发点。
//
// 目的：主代理在一个回合里**用自己的手**写出了文件（write / edit 真的成功落盘）、
// 而这一轮既没写过安排、也没派过子代理 —— 那就值得问一句"这件东西该不该由我亲手造"。
// 提示文本由 ka-whale-workflow 在 agent/pre-step 里注入（`[ka-whale-workflow building-hint]`），
// 本模块只负责"该不该提示"。
//
// **为什么触发点落在"写成功之后"，而不是"看到写这个动作"**：一个 `tool/call` 事件在调用
// **发出时**就 append 了，而结果要等这一步跑完才 commit（dsh-agent-loop：`appendToolCall`
// 在 :586、`appendToolResult` 在 :577 的 commitReady 里）。所以只数 `tool/call` 的话，
// 提示会在**文件还不存在**的时候说"You have just written …"——提示本身成了假话。
// 这一条是本模块存在的理由，不是实现细节。
//
// 与 memory-hint.js / diving-hint.js 的分工：
//   * memory-hint 数"连续侦察却没去派发"（要不要存记忆）；
//   * diving-hint 数"一轮内全部工具调用总数"（有没有陷进去）；
//   * 本模块只认**成对的** write/edit 调用与结果（有没有在亲手造东西）。
// 三者独立，互不影响。
//
// 读的是**会话事件流**（`session.snapshotEvents()`），由调用方用"已扫到的 seq"做守卫，
// 所以每个事件只算一次、重复调用幂等、重启后可从事件流重建。

/**
 * "自己的手"工具集：写下文件的工具。
 *
 * ⚠ 已知漏口，写在这里而不是藏着：`pwsh` 能做 `write` / `edit` 能做的**一切**
 * （见 skills/building-something-new 的 blacklist 说明：a read-only role that keeps
 * `pwsh` is not read-only）。主代理用 `pwsh` 落盘时，这条提示不会触发。把 `pwsh` 收进来
 * 是错的——工具面里最常调的就是它，收进来等于"每次 pwsh 都提示"，提示立刻变成噪音。
 * 真正的判别需要"这个文件在写之前不存在"，而那只能从工具结果**正文**里读，本预设别处
 * 都不读结果正文，为一条提示开这个先例不值得。**当前选择：漏掉 pwsh，宁可少提示，
 * 不制造天天误响的提示。**
 */
export const OWN_HANDS_TOOLS = Object.freeze(["write", "edit"]);

/** 调用是否属于"自己的手"。 */
function isOwnHands(name) {
  return typeof name === "string" && OWN_HANDS_TOOLS.includes(name);
}

/** 本轮开始：用户消息（真人发的，插件注入的不算）。 */
function isRoundStart(event) {
  return event?.type === "user/message" && event?.data?.source?.kind === "user";
}

/**
 * 结果是不是成功的。
 *
 * 判据按可靠性排序，两条都来自事件结构本身：
 *   * 结果报文里**那一个** `tool-result` 块的 `isError`（session-format 要求恰好一块，
 *     且 `toolCallId` 必须等于调用的 `callId`——见 dsh-session/lib/index.js:955）；
 *   * 事件自带的 `data.error`（`appendToolResult` 只在 `result.error?.info` 存在时才写它）。
 * 两条都读不到时**不认它成功**：宁可漏一次提示，也不说一句没有依据的话。
 * @param {object} event - `tool/result` 事件。
 * @param {string} callId - 该结果所配调用的 id。
 * @returns {boolean} 是否确认成功。
 */
function resultSucceeded(event, callId) {
  const data = event?.data;
  if (data === null || typeof data !== "object") return false;
  if (data.error !== undefined && data.error !== null) return false;
  const content = data.message?.content;
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    if (block?.type !== "tool-result") continue;
    if (block.toolCallId !== callId) continue;
    return block.isError !== true;
  }
  return false;
}

/**
 * 从一个会话事件里取"这次结果配的是哪次调用"的 id，取不到返回空串。
 *
 * **只认** `message.content` 里那个 `tool-result` 块的 `toolCallId`。这是会话格式自己保证的
 * 关系：一个结果报文必须**恰好**含一个 `tool-result` 块，且它的 `toolCallId` 必须等于
 * 发起调用的 `callId`，对不上就直接抛错（dsh-session/lib/index.js:955）。
 * 也就是说这条字段在实际事件里**必然在场**，取不到只可能是事件压根不是我们要的形状。
 *
 * 曾经想再留一条"靠 `sourceEventSeqs` 回指调用 seq"的退路，**已删**：那条退路要求事件里
 * **没有** `tool-result` 块，而下面的 `resultSucceeded` 要求**有**那个块——两个条件互斥，
 * 它一次都不可能走通。留着它只会让配对看起来比实际更可靠。
 * @param {object} event - `tool/result` 事件。
 * @returns {string} callId，取不到时为空串。
 */
function callIdOfResult(event) {
  const content = event?.data?.message?.content;
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (block?.type === "tool-result" && typeof block.toolCallId === "string" && block.toolCallId.length > 0) return block.toolCallId;
  }
  return "";
}

/**
 * 把一个会话事件计入"自己的手"状态。
 *
 * 语义（按设计）：
 *   * 用户发消息 → 新的一轮开始：把所有的证据全部清掉（本轮最多提示一次）；
 *   * `tool/call` 是 write/edit → 把它的 callId 记进待配表，**此时什么都还不算数**；
 *   * `tool/result` 配上一次成功的 write/edit → 落下"这一轮自己的手写过什么"（先到先得）；
 *   * `ka_sub_whale` / `write_arrangement` 被调用 → 各自置旗标（已经安排过了，提示没有意义）。
 *
 * @param {object} state - 会话状态（就地修改）。
 * @param {object} event - 一个会话事件（形状见 dsh-session：{ type, data, seq }）。
 * @returns {void}
 */
export function noteBuildingEvent(state, event) {
  if (state === null || typeof state !== "object" || event === null || typeof event !== "object") return;
  const pending = state.buildingPendingCalls instanceof Set ? state.buildingPendingCalls : null;
  if (pending === null) return;
  if (isRoundStart(event)) {
    pending.clear();
    state.ownHandsWritten = false;
    state.ownHandsPath = "";
    state.buildingDispatched = false;
    state.buildingArranged = false;
    state.buildingHinted = false;
    return;
  }
  if (event.type === "tool/call") {
    const data = event.data;
    if (data === null || typeof data !== "object") return;
    const name = data.name;
    if (name === "ka_sub_whale") state.buildingDispatched = true;
    if (name === "write_arrangement") state.buildingArranged = true;
    if (isOwnHands(name) && typeof data.callId === "string" && data.callId.length > 0) pending.add(data.callId);
    return;
  }
  if (event.type !== "tool/result") return;
  const callId = callIdOfResult(event);
  // 认不出是配哪次调用的结果 → 整条丢掉，**不删待配表里的任何一条**：这条结果证明不了自己
  // 属于谁，误删只会把真正的那一条弄丢。代价是一次都不回来的调用会留在表里，到本轮结束
  // 随清空一起消失——表很小，无所谓。
  if (callId.length === 0) return;
  // 配上了，但配的不是我们关心的 write/edit（普通工具的调用与结果也走这条路）→ 一样不动。
  if (!pending.has(callId)) return;
  pending.delete(callId);
  if (!resultSucceeded(event, callId)) return;
  state.ownHandsWritten = true;
  // 路径是机会性读来的：只有结果恰好带了 meta.path 才有。它只是让提示更具体，不参与判断。
  if (typeof state.ownHandsPath !== "string" || state.ownHandsPath.length === 0) {
    state.ownHandsPath = typeof event.data?.meta?.path === "string" ? event.data.meta.path : "";
  }
}

/**
 * 现在该不该注入"自己动手造东西"的提示。
 *
 * 触发条件：处于 idle 阶段、这一轮自己的手**确实**写出过东西（`ownHandsWritten`）、这一轮既没
 * 写过安排也没派过子代理、且本轮还没提示过。命中后把本轮的"已提示"标记置上——**同一轮里只提示
 * 一次**。
 *
 * 为什么"写过"与"路径"是两个字段：路径是**机会性**读来的（只有结果恰好带了 meta.path 才有），
 * 而"写过"是确定的。合成一个字段的话，读不到路径就等于不提示，触发条件会平白少掉一大块——
 * 路径只该让提示更具体，不该决定提示发不发。
 * @param {object} state - 会话状态（命中时就地置 buildingHinted）。
 * @returns {boolean} 是否应当注入。
 */
export function shouldHintBuilding(state) {
  if (state === null || typeof state !== "object") return false;
  if (state.stage !== "idle") return false;
  if (state.buildingHinted === true) return false;
  if (state.buildingDispatched === true || state.buildingArranged === true) return false;
  if (state.ownHandsWritten !== true) return false;
  state.buildingHinted = true;
  return true;
}
