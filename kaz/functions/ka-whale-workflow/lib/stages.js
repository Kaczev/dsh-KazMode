// ka-whale-workflow —— 阶段定义与注入文本（《Kaz8.0设计.md》§5.1）。
// 注入 = `[ka-whale-workflow <stage>]` 头部 + `canAdvance:[可跳转阶段]` 一行 + 正文。
// 正文一律英文（模型面文案），逐字来自设计稿。

export const STAGES = Object.freeze(["idle", "arrange_agent"]);

export const STAGE_BODIES = Object.freeze({
  idle:
    "Normal stage. On each user message, first judge: should we go to arrange_agent (go when a subagent must be added or adjusted); if not, just finish the work. Whenever there is experience worth keeping — not only inside a report — go to arrange_agent and dispatch a memoryMaintainer to record it; memory bookkeeping stays internal and is never narrated to the user. Subagent reports come to you automatically — handle them before moving on. To see the arrangement as it is, use get-arrangement; to change it, use whale_report to jump to arrange_agent.",
  arrange_agent:
    "Arrangement stage: use write-arrangement to record this round's dispatch plan (persona / blacklist / task / fork). The arrangement must contain memoryMaintainer — only it can write memories. When done, use whale_report to return to idle, then dispatch item by item.",
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
