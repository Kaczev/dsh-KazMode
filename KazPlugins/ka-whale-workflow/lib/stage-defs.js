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

/** 主模型主流程 stage id（§3 表格顺序；goal-active 是外部模式，不列入这里）。 */
export const MAIN_STAGE_IDS = Object.freeze([
  "assess-complexity",
  "challenge-plan",
  "decide-tools",
  "write-plan",
  "decide-goal",
  "working",
  "memory-maintenance",
  "plugin-maintenance",
  "communication",
]);

/** Goal 驱动器作用期间的外部模式标记（v0.9 §3 补充；不是普通 stage，不加入 MAIN_STAGE_IDS）。 */
export const GOAL_ACTIVE_STAGE = "goal-active";

/** Goal 结束后回到 working 语义的边界注入 id（不是普通 stage，也不作为持久化主 stage）。 */
export const WORKING_RESUMED_STAGE = "working-resumed";

/** worker 普通子代理 stage id（§4）。 */
export const WORKER_STAGE_IDS = Object.freeze([
  "assess-complexity",
  "challenge-plan",
  "check-tools",
  "working",
  "communication",
]);

/** memoryMaintainer 子代理 stage id（§5）。 */
export const MEMORY_MAINTAINER_STAGE_IDS = Object.freeze([
  "assess-delegation",
  "plan-memory",
  "save-update",
  "delete-memory",
  "communication",
]);

/** pluginMaintainer 子代理 stage id（§6）。 */
export const PLUGIN_MAINTAINER_STAGE_IDS = Object.freeze([
  "assess-delegation",
  "plan-plugin",
  "create-plugin",
  "update-plugin",
  "retire-plugin",
  "communication",
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
        "context_search",
        "context_read",
        "context_compress",
        "whale_report",
      ],
      canAdvance: ["challenge-plan", "communication"],
      task:
        "Judge whether the request is simple or complex. If simple, advance to communication (no-tool-call is legal). If complex, advance to challenge-plan.",
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
        "context_compress",
        "web_search",
        "whale_report",
      ],
      canAdvance: ["decide-tools", "communication"],
      task:
        "Critique the approach first; identify real weaknesses; do not manufacture criticism. Find the smallest workable solution. Do not write task plans here and do not call ka_sub_whale.",
    },
    "decide-tools": {
      allowedTools: ["context_search", "context_read", "context_compress", "whale_report"],
      canAdvance: ["write-plan"],
      task:
        "Decide required tools for the work. Do not write task plans here (write-plan owns persistence). Advance to write-plan. Candidate assignedTools list (system-injected): <candidate tools: name: description>.",
    },
    "write-plan": {
      allowedTools: ["whale_report", "read", "context_search", "context_read", "context_compress"],
      canAdvance: ["decide-goal", "working", "memory-maintenance", "plugin-maintenance", "communication"],
      task:
        "Create and finalize the complete task plan via whale_report(finalPlanPayload). Use separate planItems per coherent task; do not pack all work into one planItem. worker planItems are delegated individually in working; memoryMaintainer/pluginMaintainer planItems are reserved for memory-maintenance/plugin-maintenance. In amendment mode, read the current plan first, persist the revised plan, then advance.",
    },
    "decide-goal": {
      allowedTools: ["context_search", "context_read", "context_compress", "whale_report"],
      canAdvance: ["working", GOAL_ACTIVE_STAGE],
      task:
        "Decide whether to use Goal or normal. NORMAL: completable in this workflow-run, no cross-round auto-continuation; multi-step is still normal when the task plan can manage it. GOAL: clear objective that naturally needs multi-round autonomous iteration, progress tracking/resume, or an already active/paused Goal you want to continue. Note: Goal mode and normal mode expose the SAME Allowed tools; choosing Goal never changes your tool surface. If Goal is needed, call whale_report({mode:'goal', objective, max_goal_rounds?}) to enter goal-active; if normal, call whale_report to advance to working.",
    },
    working: {
      allowedTools: [...KAZ_V09_MAIN_TOOLS],
      canAdvance: ["write-plan", "memory-maintenance"],
      task:
        "Execute persona=main plan items on the main line; delegate each persona=worker plan item individually via ka_sub_whale. Do not delegate memory/plugin items here; they are reserved for memory-maintenance/plugin-maintenance. After ka_sub_whale, end the turn; the child's full report arrives as a single subagent-settled message after it calls *_sub_whale_report. Reply once with send_message to resume it cause it must have a response in order to proceed. Monitor/verify reports; amend plans only through write-plan. When complete, advance to memory-maintenance before communication. Whether to reuse is determined by the main agent: messages can be sent directly to the same 'surface + idle child', otherwise a new ka_sub_whale will be opened.",
    },
    "memory-maintenance": {
      allowedTools: [
        "whale_report",
        "ka_sub_whale",
        "list_agents",
        "send_message",
        "interrupt_agent",
        "read",
        "context_search",
        "context_read",
        "context_compress",
        "memory_search",
        "memory_detail",
        "memory_list",
      ],
      canAdvance: ["plugin-maintenance", "communication", "write-plan"],
      task:
        "Delegate memoryMaintainer plan items via ka_sub_whale, one at a time; each child's full report arrives as one subagent-settled message, then reply once with send_message to resume. Read taskPlanPath to review remaining items. If the plan must change, advance to write-plan first; otherwise continue or advance. The same memoryMaintainer sub-agent can be reused multiple times; each round starts with the 'assess-delegation' process, with the context from the previous round still present but the current round being an independent delegation.",
    },
    "plugin-maintenance": {
      allowedTools: [
        "whale_report",
        "ka_sub_whale",
        "list_agents",
        "send_message",
        "interrupt_agent",
        "read",
        "context_search",
        "context_read",
        "context_compress",
      ],
      canAdvance: ["write-plan", "communication"],
      task:
        "Delegate pluginMaintainer plan items via ka_sub_whale, one at a time; each child's full report arrives as one subagent-settled message, then reply once with send_message to resume. Read taskPlanPath to review remaining items. If a new plan item is needed, advance to write-plan first. Whether to reuse is determined by the main agent: messages can be sent directly to the same 'surface + idle child', otherwise a new ka_sub_whale will be opened.",
    },
    communication: {
      allowedTools: ["context_search", "context_read", "context_compress"],
      canAdvance: ["end"],
      task: "Report the outcome to Kaczev. End.",
    },
  },
  worker: {
    "assess-complexity": {
      allowedTools: [
        "memory_search",
        "context_search",
        "context_read",
        "context_compress",
        "work_sub_whale_report",
      ],
      canAdvance: ["challenge-plan", "communication"],
      task: "Judge whether the delegation is simple or complex.",
    },
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
        "context_compress",
        "web_search",
        "work_sub_whale_report",
      ],
      canAdvance: ["check-tools"],
      task:
        "Critique the delegation first; identify real weaknesses; do not manufacture criticism. Find the smallest workable approach. The full working file-tool set (edit, write, pwsh, read) is granted in working, not here. Then advance to check-tools.",
    },
    "check-tools": {
      allowedTools: ["context_search", "context_read", "context_compress", "work_sub_whale_report"],
      canAdvance: ["working", "communication"],
      task:
        "Verify whether assigned tools are enough. Advance to working, or to communication only for a genuine blocker. Do not report tool insufficiency before reaching working.",
    },
    working: {
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
      canAdvance: ["communication"],
      task:
        "Execute the delegated work. Do not write memories or plugins. When done, call work_sub_whale_report({nextStage:'communication'}) to advance and set awaitingParent, then do not call more tools; write your full report as your final message, end the turn, and wait for the parent reply (received as subagent-settled).",
    },
    communication: {
      allowedTools: ["context_search", "context_read", "context_compress"],
      canAdvance: ["end"],
      task: "Report results and candidate suggestions.",
    },
  },
  memoryMaintainer: {
    "assess-delegation": {
      allowedTools: [
        "memory_search",
        "context_search",
        "context_read",
        "context_compress",
        "memory_sub_whale_report",
      ],
      canAdvance: ["plan-memory", "communication"],
      task: "Judge whether the memory delegation is clear.",
    },
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
        "context_compress",
        "memory_sub_whale_report",
      ],
      canAdvance: ["save-update", "delete-memory", "communication"],
      task: "Plan the best memory change.",
    },
    "save-update": {
      allowedTools: [
        "memory_save",
        "memory_update",
        "memory_detail",
        "memory_search",
        "memory_list",
        "read",
        "context_search",
        "context_read",
        "context_compress",
        "glob",
        "grep",
        "memory_sub_whale_report",
      ],
      canAdvance: ["communication"],
      task: "Save/update memories with evidence. Keep new entries as CANDIDATE.",
    },
    "delete-memory": {
      allowedTools: [
        "memory_forget",
        "memory_search",
        "memory_list",
        "read",
        "context_search",
        "context_read",
        "context_compress",
        "glob",
        "grep",
        "memory_sub_whale_report",
      ],
      canAdvance: ["communication"],
      task:
        "Delete only items explicitly listed in the delegation brief. memory_forget performs internal backup/audit before deletion; do not claim backup without an auditable record.",
    },
    communication: {
      allowedTools: ["context_search", "context_read", "context_compress"],
      canAdvance: ["end"],
      task: "Report ids, evidence, and audit.",
    },
  },
  pluginMaintainer: {
    "assess-delegation": {
      allowedTools: [
        "memory_search",
        "context_search",
        "context_read",
        "context_compress",
        "plugin_maintainer_sub_whale_report",
      ],
      canAdvance: ["plan-plugin", "communication"],
      task: "Judge whether the plugin maintenance delegation is clear.",
    },
    "plan-plugin": {
      allowedTools: [
        "read",
        "context_search",
        "context_read",
        "context_compress",
        "glob",
        "grep",
        "pwsh",
        "todo_write",
        "plugin_maintainer_sub_whale_report",
      ],
      canAdvance: ["create-plugin", "update-plugin", "retire-plugin", "communication"],
      task: "Plan the plugin create/update/retire action.",
    },
    "create-plugin": {
      allowedTools: [
        "write",
        "edit",
        "read",
        "context_search",
        "context_read",
        "context_compress",
        "glob",
        "grep",
        "pwsh",
        "todo_write",
        "plugin_maintainer_sub_whale_report",
      ],
      canAdvance: ["communication"],
      task:
        "Create a new private plugin under KazPrivatePlugins. Follow CANDIDATE → implementation → probe → registration → versioning; sync candidate registry.",
    },
    "update-plugin": {
      allowedTools: [
        "write",
        "edit",
        "read",
        "context_search",
        "context_read",
        "context_compress",
        "glob",
        "grep",
        "pwsh",
        "todo_write",
        "plugin_maintainer_sub_whale_report",
      ],
      canAdvance: ["communication"],
      task:
        "Update/version the existing private plugin with probe discipline: record change/CANDIDATE, edit under KazPrivatePlugins/<plugin>/, run probes + node --check, version/register, sync candidate registry; hot reload only if probes passed.",
    },
    "retire-plugin": {
      allowedTools: [
        "read",
        "context_search",
        "context_read",
        "context_compress",
        "glob",
        "grep",
        "pwsh",
        "plugin_maintainer_sub_whale_report",
      ],
      canAdvance: ["communication"],
      task:
        "Retire/delete only plugins explicitly listed in the delegation brief: backup/audit, remove only KazPrivatePlugins/<plugin>/ in brief, sync candidate registry; no public/official deletions.",
    },
    communication: {
      allowedTools: ["context_search", "context_read", "context_compress"],
      canAdvance: ["end"],
      task: "Report changed files, probe results, and rollback paths.",
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
      "Before the final reply, if exact earlier content may have been summarized and needs reproducing, first use context_search then context_read. If the session is very long and about to close, first preview with context_compress suggest; manual compression comes first, auto compression is only a safety net.",
  }),
  worker: Object.freeze({
    "assess-complexity":
      "Before judging, if the delegation involves earlier session content, first use context_search then context_read to grasp the background.",
    "challenge-plan":
      "Before critiquing, if the delegation involves earlier session content, first use context_search then context_read to grasp the background.",
    communication:
      "Before reporting, if exact earlier content may have been summarized and needs reproducing, first use context_search then context_read.",
  }),
  memoryMaintainer: Object.freeze({
    communication:
      "Before reporting, review old context first when the report depends on earlier session content: use context_search then context_read.",
  }),
  pluginMaintainer: Object.freeze({
    communication:
      "Before reporting, review old context first when the report depends on earlier session content: use context_search then context_read.",
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
    stage === "decide-tools" &&
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

/** v0.9 §3.1 goal-active 上下文注入（进入 goal-active 时追加一次）。 */
export const GOAL_ACTIVE_CONTEXT_TEXT = `[ka-whale-workflow goal-active]
>
Mode: Goal is active; ka-whale-workflow ordinary stage progression is suspended.
Allowed tools: [main stable surface minus whale_report progression usage]
Use get_goal/update_goal per official Goal rules. Goal context and rounds are driven by the official Goal driver. Persona is unchanged.
Context: Before continuing, if earlier exact goal/session content may have been summarized, use context_search then context_read; if the Goal session is very long, preview with context_compress suggest before folding.
<`;

/**
 * v0.9 §3.1 working-resumed 上下文注入。
 * @param {string} [taskPlanPath] 实际 task plan 路径；缺省时保留基准占位。
 * @returns {string}
 */
export function workingResumedContextText(taskPlanPath) {
  const path =
    typeof taskPlanPath === "string" && taskPlanPath.trim().length > 0
      ? taskPlanPath.trim()
      : "{KAZ_TASK_PLAN_STORE_PATH}";
  return `[ka-whale-workflow working-resumed]
>
Mode: Goal ended; workflow resumes as if working finished.
Allowed tools: [main stable surface]
Can advance to: [write-plan (amendment), memory-maintenance]
Task: Continue as working-ended: execute/amend remaining plan items under the same semantics as the end of working, then advance.
taskPlanPath: ${path}
<`;
}
