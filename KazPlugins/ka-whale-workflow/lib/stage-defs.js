// ka-whale-workflow —— v0.9 阶段机常量与注入文本（纯 ESM）
// ===========================================================================
// v0.9 §3–§6 表格的单一事实源：主模型与三类子代理使用英文 stage id，
// Allowed tools / Can advance to / Task 全部由 v0.9 表格定义。
// 本文件不依赖 cordis / dsh 服务，供 lib/index.js 与离线探针共用。
// ===========================================================================

import { KAZ_ROLE_PROMPTS, KAZ_V09_MAIN_TOOLS } from "kaz-shared";

/** 主模型角色 id。 */
export const MAIN_ROLE = "main";

/** v0.9 子代理角色 id（31 世不退役旧角色；这是 v0.9 新角色集合）。 */
export const V09_SUBAGENT_ROLES = Object.freeze([
  "worker",
  "memoryMaintainer",
  "pluginMaintainer",
]);

/** 主模型主流程 stage id（§3 表格顺序）。 */
export const MAIN_STAGE_IDS = Object.freeze([
  "assess-complexity",
  "challenge-plan",
  "decide-tools-before-writing-plan",
  "write-plan",
  "working",
  "memory-maintenance",
  "plugin-maintenance",
  "compass_context_before_communication",
  "communication",
]);

/** worker 普通子代理 stage id（v0.10a：无独立 terminal stage）。 */
export const WORKER_STAGE_IDS = Object.freeze([
  "challenge-plan",
  "working-then-compress-context-then-report",
]);

/** memoryMaintainer 子代理 stage id（v0.10a：无独立 terminal stage）。 */
export const MEMORY_MAINTAINER_STAGE_IDS = Object.freeze([
  "plan-memory",
  "save-update-then-compress-context-then-report",
  "delete-memory-then-compress-context-then-report",
]);

/** pluginMaintainer 子代理 stage id（v0.10a：无独立 terminal stage）。 */
export const PLUGIN_MAINTAINER_STAGE_IDS = Object.freeze([
  "plan-plugin",
  "create-plugin-then-compress-context-then-report",
  "update-plugin-then-compress-context-then-report",
  "retire-plugin-then-compress-context-then-report",
]);

/** 所有 v0.9 stage id（不含 idle/done/end 等状态壳）。 */
export const V09_STAGE_IDS = Object.freeze([
  ...new Set([
    ...MAIN_STAGE_IDS,
    ...WORKER_STAGE_IDS,
    ...MEMORY_MAINTAINER_STAGE_IDS,
    ...PLUGIN_MAINTAINER_STAGE_IDS,
  ]),
]);

/** 阶段定义（Task 文本来自 Kaz7.0v2 候选稿 §2–§5 精简正文；
 *  taskPlanPath / lifecyclePath 由 stageInjectionText 按 options 追加）。 */
const DEFINITIONS = {
  [MAIN_ROLE]: {
    // assess-complexity 的 allowedTools 是“该阶段软闸门”，不是首轮 Minimal 列表。
    // Minimal 执行语义由 kaz-mode firstRoundTools（主）/ V09_SUBAGENT_ROLE_MINIMAL_TOOLS
    // （受控子代理）在“首次工具调用前”独立收口；stageInjectionText 仅在调用方传入
    // options.minimalTools 时输出一行描述性 Minimal 提示，不参与工具面收口。
    // 不加 ask_user_question：需要澄清的任务推进 challenge-plan（其持有该工具）。
    "assess-complexity": {
      allowedTools: [
        "memory_search",
        "memory_detail",
        "memory_list",
        "context_search",
        "context_read",
        "whale_report",
      ],
      canAdvance: ["challenge-plan", "communication", "compass_context_before_communication"],
      task:
        `Judge complexity AND unpack intent.

Before deciding, always form a compact Intent Map:
1) What outcome does the user want to experience?
2) What domain priors does this request evoke?
   Example: "foam" => sticky, coalescing, bubbly, rough, lumpy, NOT isolated small balls.
   Example: "UI" => visual hierarchy, whitespace, typography, aesthetics, not just layout.
3) Does the user's wording conflict with the likely desired outcome? If so, state it.
4) How should success be verified — by code review, by rendered output, or by user feel?

Simple direct answers may advance to communication.
Creative/visual/implementation-heavy requests advance to challenge-plan.
Do not advance only to satisfy process; advance when a real decision needs scrutiny.`,
    },
    "challenge-plan": {
      allowedTools: [
        "ask_user_question",
        "glob",
        "grep",
        "memory_detail",
        "memory_list",
        "memory_search",
        "read",
        "context_search",
        "context_read",
        "web_search",
        "whale_report",
      ],
      canAdvance: ["decide-tools-before-writing-plan"],
      task:
        `Critique the approach first; identify real weaknesses and missed opportunities; do not manufacture criticism. Then, propose concrete enhancements that would make the result more polished, practical, and balanced — avoid extremes of over-engineering or under-delivering. Aim for a solution that is appropriate to the task's complexity and context.

When proposing improvements, be specific. Instead of asking vague questions like “What would you prefer?”, ask concrete questions about the task's scope, priorities, constraints, edge cases, user expectations, or trade-offs that need to be made. Use ask_user_question as many times as needed to gather clear, actionable preferences. Do not settle for vague terms like “better” or “improved” — translate them into specific decisions.

Present your enhancement ideas to the user and ask for their preference before proceeding. Do not write task plans here and do not call ka_sub_whale. Ask user questions as many times as needed for true intent.

Treat user words as intent signals, not a final specification.
Surface conflicts between wording and likely outcome.
propose an outcome-level correction before accepting the implementation hint.

For visual/creative tasks, ask about look-and-feel/references first.
Do not ask about implementation knobs until the look is agreed.`,
    },
    "decide-tools-before-writing-plan": {
      allowedTools: ["context_search", "context_read", "context_compress", "whale_report"],
      canAdvance: ["write-plan"],
      task:`Decide which tools from the candidate private plugins list are required for this work. Do not write task plans here — persistence is handled by the write-plan stage. Advance to write-plan when ready.

The candidate tools (private plugins) are: <candidate tools: name: description>.

Only these private plugins and tool_jobs(job_list, job_output, job_kill) may be included in assignedTools. Regular file tools and memory tools are part of the base role surface and must not be listed.`,
    },
    "write-plan": {
      allowedTools: ["whale_report", "plan_read", "read", "grep", "glob", "web_search", "memory_detail", "memory_search", "memory_list",  "context_search", "context_read"],
      canAdvance: ["working", "memory-maintenance", "plugin-maintenance", "compass_context_before_communication", "communication"],
      task:`Create and finalize the complete task plan via "whale_report(finalPlanPayload)".
Use plan_read to inspect the active run plan and its work-log; prefer it over raw read of JSON files. Completed subagent terminal reports are appended to the run work-log beside the task plan; later delegations can reference that work-log path when dependsOn points at earlier items.

PlanItem rules:
- One planItem per coherent task. Do not pack all work into one.
- persona is a fixed enum and must be exactly one of: main, worker, memoryMaintainer, pluginMaintainer.
- Required item fields: planItemId, persona, task. Optional structured fields: summary (one-line purpose), dependsOn (planItemIds this item depends on), targets (files/dirs/domains), verification (concrete checks), assignedTools.
- whale_report validates the entire payload first: an invalid persona, a missing required field, or a malformed payload rejects the whole payload with a structured plan-item-invalid error; nothing is persisted and no item is silently dropped.
- "worker": delegated individually during Working.
- "memoryMaintainer": create at least one if the work produces new insights, lessons, or reusable patterns — even if uncertain.
- "pluginMaintainer": create a new private plugin only when existing plugins cannot meet requirements (e.g., repetitive work that could be automated).
- Every build-type planItem must include, for visual/creative work:
  (a) intended user experience;
  (b) visual acceptance criteria ("what success looks like");
  (c) explicit failure examples.
- Reviewers must judge fidelity to the intended experience, not only whether code exists.
- If rendered output cannot be produced/checked, say so in the task instead of pretending code review is enough.

Delegation and splitting rules:
- Delegate every worker planItem via "ka-sub-whale". Do not execute directly.
- Split heavy tasks into smaller, parallelizable pieces when dependencies allow.
- For complex systems, break down by natural subsystems or functional modules — each as its own planItem with its own subagent, as long as they can be developed independently and integrated later.
- Prefer parallel execution over sequential when possible.
- Reuse existing idle subagents with relevant expertise; create new ones only when none suitable exists.
- For each delegated task, provide the fullest possible description: objective, detailed step-by-step actions, expected outputs, constraints, relevant context, assumptions, potential pitfalls. When in doubt, include it. Spell everything out — do not assume the subagent can infer.
- Max 8 tools per planItem.
- Single delivery file (e.g., one HTML) is not a reason to use one subagent. Split when: >~300 lines of code, spans multiple domains (geometry/physics/rendering/UI), has independently verifiable acceptance criteria, or would benefit from independent review.
- Every build-type task should include at least one "builder" and one "reviewer" planItem. The reviewer checks against requirements to avoid "author verifying own work."
- Before finalizing, ask: "Is there at least one verification step independent of the builder?" If not, the plan is insufficiently split.

Amendment rules:
- In amendment mode: use plan_read to read the current run plan first, persist revised plan, then advance.

Communication rules:
- Before advancing to communication, call "compass_context_before_communication" to compact and tidy the session context.`,
    },
    working: {
      allowedTools: [...KAZ_V09_MAIN_TOOLS],
      canAdvance: ["decide-tools-before-writing-plan", "write-plan", "memory-maintenance"],
      task:
        `Execute persona=main plan items on the main line; delegate each persona=worker plan item individually via ka_sub_whale. Do not delegate memory/plugin items here; they are reserved for memory-maintenance/plugin-maintenance.

After ka_sub_whale, end the turn. The child works inside its execution stage; it may pause mid-work with a *_sub_whale_report that has neither final:true nor nextStage (reply with send_message to resume). When finished, it evaluates optional context_compress and sends its TERMINAL full report via *_sub_whale_report({ final: true }); that report arrives as a single subagent-settled message, after which you reply with send_message to resume it or begin the next round. The child must have a response to proceed. Let the child run its own workflow at its own pace; we do not rush it. We wait for the report, verify it, and decide the next step.

Amend plans only through write-plan. Use plan_read to inspect the active run plan and its work-log; prefer it over raw read of JSON. When delegating a planItem whose dependsOn references earlier completed items, include the actual workLogFile path from plan_read in the delegation/follow-up message; parallel subagents do not see each other's raw logs. When complete, advance to memory-maintenance before communication. Before calling ka_sub_whale:
1. Call list_agents.
2. If an idle child exists with matching context (same file / same domain / closely related objective), use send_message to continue that child.
3. Only when no matching child exists, create a new one via ka_sub_whale.

Do not open a new worker just because a new planItem exists;
a small change to the same file should continue the child that already knows that file. Messages can be sent directly to the same 'surface + idle child', otherwise a new ka_sub_whale will be opened.`,
    },
    "memory-maintenance": {
      allowedTools: [
        "whale_report",
        "plan_read",
        "ka_sub_whale",
        "list_agents",
        "send_message",
        "interrupt_agent",
        "context_search",
        "context_read",
        "memory_search",
        "memory_detail",
        "memory_list",
      ],
      canAdvance: ["plugin-maintenance", "communication", "write-plan", "compass_context_before_communication"],
      task:
        `Delegate memoryMaintainer plan items via ka_sub_whale, one at a time. Each child works inside save-update/delete-memory; it may pause mid-work (report without final/nextStage), and when finished it evaluates optional context_compress and sends its TERMINAL full report via memory_sub_whale_report({ final: true }), which arrives as one subagent-settled message. Use plan_read to review remaining plan items and the run work-log; taskPlanPath is injected for reference but prefer plan_read over raw read. When a memory planItem depends on earlier completed items, include the actual workLogFile path in the delegation/follow-up message; parallel subagents do not see each other's raw logs.

If no memoryMaintainer planItem exists, check whether the completed work has produced any insights, lessons learned, or reusable patterns worth saving. If so, advance to write-plan to add a memoryMaintainer planItem, then return to this stage.

If the plan must change, advance to write-plan first; otherwise continue or advance. The same memoryMaintainer sub-agent can be reused multiple times; each round starts with the 'plan-memory' process, with the context from the previous round still present but the current round being an independent delegation.

**Before advancing to communication or calling compress_context_before_communication, we must first evaluate whether a private plugin would improve future efficiency. Consider: are there repetitive patterns, manual steps, or recurring operations in this work that could be automated? If yes, advance to write-plan to add a pluginMaintainer planItem, then proceed to plugin-maintenance. If no, we may proceed to communication.**

Before advancing to communication, call "compass_context_before_communication" to compact and tidy the session context.`,
    },
    "plugin-maintenance": {
      allowedTools: [
        "whale_report",
        "plan_read",
        "ka_sub_whale",
        "list_agents",
        "send_message",
        "interrupt_agent",
        "context_search",
        "context_read",
      ],
      canAdvance: ["write-plan", "communication", "compass_context_before_communication"],
      task:
        `Delegate pluginMaintainer plan items via ka_sub_whale, one at a time. Each child works inside create/update/retire-plugin; it may pause mid-work (report without final/nextStage), and when finished it evaluates optional context_compress and sends its TERMINAL full report via plugin_maintainer_sub_whale_report({ final: true }), which arrives as one subagent-settled message. Use plan_read to review remaining plan items and the run work-log; taskPlanPath is injected for reference but prefer plan_read over raw read. When a plugin planItem depends on earlier completed items, include the actual workLogFile path in the delegation/follow-up message; parallel subagents do not see each other's raw logs.

If no pluginMaintainer planItem exists, check whether the completed work reveals repetitive patterns or manual steps that could be automated with a private plugin. If so, advance to write-plan to add a pluginMaintainer planItem, then return to this stage.

If a new plan item is needed, advance to write-plan first. Whether to reuse is determined by the main agent: messages can be sent directly to the same 'surface + idle child', otherwise a new ka_sub_whale will be opened.

After pluginMaintainer tasks are complete, advance to communication. Before advancing to communication, call "compass_context_before_communication" to compact and tidy the session context.`,
    },
    "compass_context_before_communication": {
      allowedTools: ["context_compress", "whale_report", "plan_read"],
      canAdvance: ["communication"],
      task:
        "Tidy the context: if the session is long, preview with context_compress suggest, then fold when the candidate is large enough. Manual compression is primary; auto compression is only a fallback. After tidying, advance to communication.",
    },
    communication: {
      allowedTools: ["whale_report", "plan_read"],
      canAdvance: ["assess-complexity"],
      task: "Report the outcome. If we have a extract task, advance to assess-complexity; otherwise, END the workflow.",
    },
  },
  worker: {
    "challenge-plan": {
      allowedTools: [
        "glob",
        "grep",
        "memory_detail",
        "memory_list",
        "memory_search",
        "read",
        "context_search",
        "context_read",
        "web_search",
        "work_sub_whale_report",
      ],
      canAdvance: ["working-then-compress-context-then-report"],
      task:
        `Critique the assigned task first; identify real weaknesses and missed opportunities; do not manufacture criticism. Then, propose concrete enhancements that would make the result more polished, practical, and balanced — avoid extremes of over-engineering or under-delivering, and keep the solution appropriate to the task's complexity.

When proposing improvements, be specific. Instead of vague suggestions, spell out concrete trade-offs, scope adjustments, priority shifts, edge cases, or user expectations that should be considered. Present these ideas clearly to the parent main agent and wait for its decision before proceeding. Do not assume approval — the parent must confirm or adjust.

Do not write task plans here and do not call ka_sub_whale. Ask the parent main agent for clarification when the task intent is unclear.`,
    },
    "working-then-compress-context-then-report": {
      allowedTools: [
        "edit",
        "glob",
        "grep",
        "memory_detail",
        "memory_list",
        "memory_search",
        "pwsh",
        "read",
        "context_search",
        "context_read",
        "context_compress",
        "todo_write",
        "web_search",
        "write",
        "work_sub_whale_report",
      ],
      canAdvance: ["challenge-plan"],
      task:
        `Execute the delegated work with care and completeness. We deliver work that is functional, readable, and properly tested — not just “done”, but done well.

During execution:
- Follow the task description closely. If ambiguity arises, we may ask the parent for clarification via the report.
- We do not write memories or plugins. These are handled by the parent and the corresponding specialized subagents.
- We keep our work self-contained within the delegated scope. We do not expand the scope without parent approval.

When work is finished, first review our own work: does it meet the objective? Are all steps completed? Are there any edge cases missed?
THEN **OPTIONAL BUT IMPORTANT (IMPORTANT)**: preview with context_compress suggest first before reporting, then fold when the candidate is large enough. Manual compression is primary; auto compression is only a fallback.
Then call work_sub_whale_report({ final: true }) with NO nextStage and write the FULL final report as the final message, then end the turn:
- What was done (summary of actions taken)
- How it was done (key decisions, tools used, approach taken)
- What was produced (files, changes, outputs)
- What remains (open questions, incomplete items, risks, or follow-up work)
- Any clarification needed from the parent`,
    },
  },
  memoryMaintainer: {
    "plan-memory": {
      allowedTools: [
        "memory_search",
        "memory_detail",
        "memory_list",
        "glob",
        "grep",
        "read",
        "context_search",
        "context_read",
        "memory_sub_whale_report",
      ],
      canAdvance: ["save-update-then-compress-context-then-report", "delete-then-compress-context-then-report"],
      task: "Plan the best memory change.",
    },
    "save-update-then-compress-context-then-report": {
      allowedTools: [
        "memory_save",
        "memory_update",
        "memory_detail",
        "memory_search",
        "memory_list",
        "context_search",
        "context_read",
        "context_compress",
        "memory_sub_whale_report",
      ],
      canAdvance: ["plan-memory", "delete-then-compress-context-then-report"],
      task:
        "Save/update memories with evidence. Keep new entries as CANDIDATE. When work is finished, review own work; THEN **OPTIONAL BUT IMPORTANT (IMPORTANT)**: preview with context_compress suggest first before reporting, fold when large; manual primary, auto fallback. Then call memory_sub_whale_report({ final: true }) with NO nextStage and write the FULL final report (ids, evidence, audit) as the final message, then end the turn.",
    },
    "delete-then-compress-context-then-report": {
      allowedTools: [
        "memory_forget",
        "memory_search",
        "memory_list",
        "context_search",
        "context_read",
        "context_compress",
        "memory_sub_whale_report",
      ],
      canAdvance: ["plan-memory", "save-update-then-compress-context-then-report"],
      task:
        "Delete only items explicitly listed in the delegation brief. memory_forget performs internal backup/audit before deletion; do not claim backup without an auditable record. When work is finished, review own work; THEN **OPTIONAL BUT IMPORTANT (IMPORTANT)**: preview with context_compress suggest first before reporting, fold when large; manual primary, auto fallback. Then call memory_sub_whale_report({ final: true }) with NO nextStage and write the FULL final report (ids, evidence, audit) as the final message, then end the turn.",
    },
  },
  pluginMaintainer: {
    "plan-plugin": {
      allowedTools: [
        "read",
        "context_search",
        "context_read",
        "memory_search",
        "memory_detail",
        "memory_list",
        "glob",
        "grep",
        "web_search",
        "plugin_maintainer_sub_whale_report",
      ],
      canAdvance: ["create-plugin-then-compress-context-then-report", "update-plugin-then-compress-context-then-report", "retire-plugin-then-compress-context-then-report"],
      task: "Plan the plugin create/update/retire action.",
    },
    "create-plugin-then-compress-context-then-report": {
      allowedTools: [
        "write",
        "edit",
        "read",
        "context_search",
        "context_read",
        "context_compress",
        "memory_search",
        "memory_detail",
        "memory_list",
        "glob",
        "grep",
        "web_search",
        "pwsh",
        "todo_write",
        "plugin_maintainer_sub_whale_report",
      ],
      canAdvance: ["plan-plugin"],
      task:
        "Create a new private plugin under KazPrivatePlugins. Follow CANDIDATE → implementation → probe → registration → versioning; sync candidate registry. When work is finished, review own work; THEN **OPTIONAL BUT IMPORTANT (IMPORTANT)**: preview with context_compress suggest first before reporting, fold when large; manual primary, auto fallback. Then call plugin_maintainer_sub_whale_report({ final: true }) with NO nextStage and write the FULL final report (changed files, probe results, rollback paths) as the final message, then end the turn.",
    },
    "update-plugin-then-compress-context-then-report": {
      allowedTools: [
        "write",
        "edit",
        "read",
        "context_search",
        "context_read",
        "context_compress",
        "memory_search",
        "memory_detail",
        "memory_list",
        "glob",
        "grep",
        "web_search",
        "pwsh",
        "todo_write",
        "plugin_maintainer_sub_whale_report",
      ],
      canAdvance: ["plan-plugin"],
      task:
        "Update/version the existing private plugin with probe discipline: record change/CANDIDATE, edit under KazPrivatePlugins/<plugin>/, run probes + node --check, version/register, sync candidate registry; hot reload only if probes passed. When work is finished, review own work; THEN **OPTIONAL BUT IMPORTANT (IMPORTANT)**: preview with context_compress suggest first before reporting, fold when large; manual primary, auto fallback. Then call plugin_maintainer_sub_whale_report({ final: true }) with NO nextStage and write the FULL final report (changed files, probe results, rollback paths) as the final message, then end the turn.",
    },
    "retire-plugin-then-compress-context-then-report": {
      allowedTools: [
        "read",
        "context_search",
        "context_read",
        "context_compress",
        "memory_search",
        "memory_detail",
        "memory_list",
        "glob",
        "grep",
        "pwsh",
        "plugin_maintainer_sub_whale_report",
      ],
      canAdvance: ["plan-plugin"],
      task:
        "Retire/delete only plugins explicitly listed in the delegation brief: backup/audit, remove only KazPrivatePlugins/<plugin>/ in brief, sync candidate registry; no public/official deletions. When work is finished, review own work; THEN **OPTIONAL BUT IMPORTANT (IMPORTANT)**: preview with context_compress suggest first before reporting, fold when large; manual primary, auto fallback. Then call plugin_maintainer_sub_whale_report({ final: true }) with NO nextStage and write the FULL final report (changed files, probe results, rollback paths) as the final message, then end the turn.",
    },
  },
};

/** 返回 role 的定义表；未知角色返回 null。 */
export function stageDefinitionsForRole(role) {
  return DEFINITIONS[role] ?? null;
}

/** 返回某 role/stage 的定义；未知返回 null。 */
export function stageDefinitionFor(role, stage) {
  const table = stageDefinitionsForRole(role);
  if (table === null || table === undefined) return null;
  return table[stage] ?? null;
}

/** 返回某 role 的 stage id 列表；未知返回 []。 */
export function stageIdsForRole(role) {
  if (role === MAIN_ROLE) return [...MAIN_STAGE_IDS];
  if (role === "worker") return [...WORKER_STAGE_IDS];
  if (role === "memoryMaintainer") return [...MEMORY_MAINTAINER_STAGE_IDS];
  if (role === "pluginMaintainer") return [...PLUGIN_MAINTAINER_STAGE_IDS];
  return [];
}

/** v0.9 主阶段 → ka_sub_whale 唯一可委派的 persona（36.8 + 37.5 stage-persona mapping）。 */
export const V09_KA_SUB_WHALE_STAGE_PERSONAS = Object.freeze({
  working: "worker",
  "memory-maintenance": "memoryMaintainer",
  "plugin-maintenance": "pluginMaintainer",
});

/** 判断 role/stage 是否合法 v0.9 阶段。 */
export function isKnownStage(role, stage) {
  return stageDefinitionFor(role, stage) !== null;
}

/** 判断一个 stage id 是否属于主模型 v0.9 主流程。 */
export function isMainWorkflowStage(stage) {
  return MAIN_STAGE_IDS.includes(stage);
}

/** 判断一个 stage id 是否属于任何子代理 v0.9 流程。 */
export function isSubagentWorkflowStage(stage) {
  return V09_STAGE_IDS.includes(stage) && !MAIN_STAGE_IDS.includes(stage);
}

/** 判断 role/stage 是否允许推进到 nextStage。 */
export function canAdvance(role, stage, nextStage) {
  if (typeof nextStage !== "string") return false;
  const def = stageDefinitionFor(role, stage);
  return def !== null && def.canAdvance.includes(nextStage);
}

/** 是否把附加路径注入该主阶段（按 v0.9 表格）。 */
export function stageNeedsTaskPlanPath(stage) {
  return (
    stage === "write-plan" ||
    stage === "working" ||
    stage === "memory-maintenance" ||
    stage === "plugin-maintenance"
  );
}

/** 是否把 lifecyclePath 注入该阶段（v0.9 plugin 创建/更新/退休阶段）。 */
export function stageNeedsLifecyclePath(stage) {
  return ["create-plugin", "update-plugin", "retire-plugin"].includes(stage);
}

/** v0.9 角色 Persona（§9.2–9.5；由 kaz-shared 的 KAZ_ROLE_PROMPTS 单一收口派生，
 *  供 ka_sub_whale 骨架生成子代理 prompt）。 */
export const V09_ROLE_PERSONAS = Object.freeze({
  worker: KAZ_ROLE_PROMPTS.subagent.worker,
  memoryMaintainer: KAZ_ROLE_PROMPTS.subagent.memoryMaintainer,
  pluginMaintainer: KAZ_ROLE_PROMPTS.subagent.pluginMaintainer,
});

/** v0.9 角色 → report 工具名。 */
export const V09_ROLE_REPORT_TOOLS = Object.freeze({
  worker: "work_sub_whale_report",
  memoryMaintainer: "memory_sub_whale_report",
  pluginMaintainer: "plugin_maintainer_sub_whale_report",
});

/**
 * v0.9 阶段级 Context 注记：进入对应 stage 时，stageInjectionText 在
 * `Task:` 行之后输出一行 `Context: <text>`；没有注记的 stage 不输出。
 * 文案与 kaz-shared KAZ_ROLE_PROMPTS 的 context 自管理纪律保持一致。
 */
export const STAGE_CONTEXT_NOTES = Object.freeze({
  [MAIN_ROLE]: Object.freeze({
    "assess-complexity":
      "Before judging, if the request involves earlier session content, first use context_search then context_read to grasp the background.",
    "challenge-plan":
      "Before critiquing, if the critique involves earlier session content, first use context_search then context_read to grasp the background.",
    communication:
      "Before the final reply, if exact earlier content may have been summarized and needs reproducing, first use context_search then context_read.",
  }),
  worker: Object.freeze({
    "challenge-plan":
      "Before critiquing, if the delegation involves earlier session content, first use context_search then context_read to grasp the background.",
    "working-then-compress-context-then-report":
      "Before the final report, if exact earlier content may have been summarized and needs reproducing, first use context_search then context_read.",
  }),
  memoryMaintainer: Object.freeze({
    "save-update-then-compress-context-then-report":
      "Before the final report, review old context first when the report depends on earlier session content: use context_search then context_read.",
    "delete-memory-then-compress-context-then-report":
      "Before the final report, review old context first when the report depends on earlier session content: use context_search then context_read.",
  }),
  pluginMaintainer: Object.freeze({
    "create-plugin-then-compress-context-then-report":
      "Before the final report, review old context first when the report depends on earlier session content: use context_search then context_read.",
    "update-plugin-then-compress-context-then-report":
      "Before the final report, review old context first when the report depends on earlier session content: use context_search then context_read.",
    "retire-plugin-then-compress-context-then-report":
      "Before the final report, review old context first when the report depends on earlier session content: use context_search then context_read.",
  }),
});

/**
 * 构造 v0.9 阶段入口注入文本。
 * @param {string} role
 * @param {string} stage
 * @param {{taskPlanPath?: string, lifecyclePath?: string, candidateToolDirectory?: string, minimalTools?: string[]}} options
 * options.minimalTools：可选；提供时在 `Can advance to:` 行后、`Task:` 行前输出
 * `Minimal (first round only): [...] until your first tool call; then the Allowed tools above unlock.`
 * @returns {string} 注入文本；role/stage 未知时返回空串。
 */
export function stageInjectionText(role, stage, options = {}) {
  const def = stageDefinitionFor(role, stage);
  if (def === null) return "";
  const lines = [];
  lines.push(`[ka-whale-workflow ${stage}]`);
  lines.push(">");
  lines.push(`Allowed tools: [${def.allowedTools.join(", ")}]`);
  lines.push(`Can advance to: [${def.canAdvance.join(", ")}]`);
  if (
    options &&
    Array.isArray(options.minimalTools) &&
    options.minimalTools.length > 0
  ) {
    lines.push(
      `Minimal (first round only): [${options.minimalTools.join(", ")}] until your first tool call; then the Allowed tools above unlock.`,
    );
  }
  let task = def.task;
  if (
    stage === "decide-tools-before-writing-plan" &&
    options &&
    typeof options.candidateToolDirectory === "string" &&
    options.candidateToolDirectory.length > 0
  ) {
    task = task.replace("<candidate tools: name: description>", options.candidateToolDirectory);
  }
  lines.push(`Task: ${task}`);
  const contextNote = STAGE_CONTEXT_NOTES?.[role]?.[stage];
  if (typeof contextNote === "string" && contextNote.length > 0) {
    lines.push(`Context: ${contextNote}`);
  }
  if (options && typeof options.taskPlanPath === "string" && options.taskPlanPath.length > 0 && stageNeedsTaskPlanPath(stage)) {
    lines.push(`taskPlanPath: ${options.taskPlanPath}`);
  }
  if (options && typeof options.lifecyclePath === "string" && options.lifecyclePath.length > 0 && stageNeedsLifecyclePath(stage)) {
    lines.push(`lifecyclePath: ${options.lifecyclePath}`);
  }
  lines.push("<");
  return lines.join("\n");
}

/**
 * v0.9 首轮 startup hint：会话处于 idle + Minimal（尚无首次工具调用）时，
 * 主模型在 turn 1 的真实用户消息里只会看到 memory_search + context_search。
 * 这个一次性提示让模型知道必须先做一次工具调用，工作流才进入 assess-complexity。
 * 它不是 stage（无 Allowed tools / Can advance to / Task），也不使用已退役的
 * round-minimal 命名；source.form = FIRST_ROUND_STARTUP_FORM。
 */
export const FIRST_ROUND_STARTUP_FORM = "startup-tool-hint";

export const FIRST_ROUND_STARTUP_TEXT = `[ka-whale-workflow first-round]
>
Mode: Minimal startup (first round, before the first tool call).
Before we answer, call memory_search or context_search exactly once. After that first tool call, ka-whale-workflow enters assess-complexity and the stable tool surface unlocks. Do not end the turn before making the call.
<`;
