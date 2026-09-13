// ka-whale-workflow —— 阶段定义与注入文本（《Kaz8.0设计.md》§5.1）。
// 注入 = `[ka-whale-workflow <stage>]` 头部 + `canAdvance:[可跳转阶段]` 一行 + 正文。
// 正文一律英文（模型面文案），逐字来自设计稿。

export const STAGES = Object.freeze(["idle", "arrange_agent"]);

export const STAGE_BODIES = Object.freeze({
  idle:
    "On each user message, first judge the work: is it one self-contained step that only we can do (talking to the user, the final integration, a decision), or does it contain any part with its own goal that can be verified on its own? Work with parts goes to arrange_agent and gets dispatched; work without parts we finish ourselves. Delegation is judged every round, not remembered from last round. Whenever there is experience worth keeping — not only inside a report — go to arrange_agent and dispatch a memoryMaintainer to record it; memory bookkeeping stays internal and is never narrated to the user. Subagent reports come to you automatically — handle them before moving on. To see the arrangement as it is, use get_arrangement; to change it, use whale_report to jump to arrange_agent.",
  arrange_agent:
    "Arrangement stage: use write_arrangement to record this round's dispatch plan (persona / blacklist / task / fork). The arrangement must contain memoryMaintainer — only it can write memories. When done, use whale_report to return to idle, then dispatch item by item.",
});

/** 可跳转关系（§5.1 表格的"可跳转"列）。 */
export const LEGAL_TRANSITIONS = Object.freeze({
  idle: Object.freeze(["arrange_agent"]),
  arrange_agent: Object.freeze(["idle"]),
});

/** 注入头。 */
export function stageHeader(stage) {
  return `[ka-whale-workflow ${stage}]`;
}

/** 记忆提示的注入头（与阶段注入分开：只在"连续侦察够久又没去派发"时出现）。 */
export const MEMORY_HINT_HEADER = "[ka-whale-workflow memory_hint]";

/** 记忆提示正文（模型面文案，英文）。 */
export const MEMORY_HINT_BODY = "Do we need to save memory?";

/**
 * 记忆提示的完整注入文本：头部 + 正文。
 * 触发条件见 kaz-shared/lib/memory-hint.js（连续调用观察工具集达阈值且仍在 idle）。
 * @returns {string} 注入文本。
 */
export function renderMemoryHintText() {
  return [MEMORY_HINT_HEADER, MEMORY_HINT_BODY].join("\n");
}

/** "刹车"提示的注入头：一轮里工具调用太多时出现（见 kaz-shared/lib/diving-hint.js）。 */
export const DIVING_HINT_HEADER = "[ka-whale-workflow diving-hint]";

/** "刹车"提示正文（模型面文案，英文）。 */
export const DIVING_HINT_BODY =
  "Have we encountered any unsolvable problems? Has it been too long? Do we need to report to the users?";

/**
 * "刹车"提示的完整注入文本：头部 + 正文。
 * 触发点：一轮内第 32 次工具调用，之后每再满 16 次。
 * @returns {string} 注入文本。
 */
export function renderDivingHintText() {
  return [DIVING_HINT_HEADER, DIVING_HINT_BODY].join("\n");
}

/**
 * 子代理版的刹车提示正文。
 *
 * 只改一处措辞：子代理不是对用户说话，它的汇报对象是**派发它的主代理**（见三方 persona：
 * "To message the main agent, we put it in our closing message and end our turn"）。
 * 说得再紧一点（"hand back"），因为子代理一交回就结束了，没有后续。
 */
export const DIVING_HINT_BODY_SUBAGENT =
  "Have we encountered any unsolvable problems? Has it been too long? Do we need to report to the main agent and hand back?";

/**
 * 子代理版刹车提示的完整注入文本。
 * @returns {string} 注入文本。
 */
export function renderDivingHintTextForSubagent() {
  return [DIVING_HINT_HEADER, DIVING_HINT_BODY_SUBAGENT].join("\n");
}

/** 合法跳转行（§5.1 表格的"可跳转"列，模型可见）。 */
export function stageAdvanceLine(stage) {
  const targets = LEGAL_TRANSITIONS[stage] ?? [];
  return `canAdvance:[${targets.join(", ")}]`;
}

/**
 * 组装某一阶段的注入文本：头部 + canAdvance 行 + 正文。
 * @param {string} stage - 阶段名。
 * @returns {string} 注入文本。
 */
export function renderStageText(stage) {
  const body = STAGE_BODIES[stage] ?? STAGE_BODIES.idle;
  return [stageHeader(stage), stageAdvanceLine(stage), body].join("\n");
}
