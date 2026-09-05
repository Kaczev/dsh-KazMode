// ka-whale-workflow —— v0.9 阶段机常量与注入文本（纯 ESM）
// ===========================================================================
// v0.9 §3–§7 表格的单一事实源：主模型与四类子代理使用英文 stage id，
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
  "pluginCreator",
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

/** pluginCreator 子代理 stage id（§7）。 */
export const PLUGIN_CREATOR_STAGE_IDS = Object.freeze([
  "assess-delegation",
  "plan-plugin",
  "create-plugin",
  "communication",
]);

/** 所有 v0.9 stage id（不含 idle/done/end 等状态壳）。 */
export const V09_STAGE_IDS = Object.freeze([
  ...new Set([
    ...MAIN_STAGE_IDS,
    ...WORKER_STAGE_IDS,
    ...MEMORY_MAINTAINER_STAGE_IDS,
    ...PLUGIN_MAINTAINER_STAGE_IDS,
    ...PLUGIN_CREATOR_STAGE_IDS,
  ]),
]);

/** 阶段定义（Task 文本来自 v0.9 表格；{KAZ_PRIVATE_PLUGIN_LIFECYCLE_PATH} 占位由注入层替换）。 */
const DEFINITIONS = {
  [MAIN_ROLE]: {
    "assess-complexity": {
      allowedTools: ["memory_search", "ask_user_question", "whale_report"],
      canAdvance: ["challenge-plan", "communication"],
      task:
        "Judge whether the request is simple or complex. Minimal applies only before the first tool call of the first round: only memory_search and ask_user_question are visible. After the first tool call, schema expands to Stable Main Surface, but the stage soft gate still only allows memory_search, ask_user_question, and whale_report; other calls return workflow-stage-deny. If simple, advance to communication (no-tool-call is a legal exception). If complex, advance to challenge-plan.",
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
        "web_search",
        "whale_report",
      ],
      canAdvance: ["decide-tools", "communication"],
      task:
        "Critique the user's approach first; identify real weaknesses; do not manufacture criticism. Find the smallest workable solution. Do not write or finalize task plans here (decide-tools/write-plan own plan persistence) and do not call ka_sub_whale. Then advance.",
    },
    "decide-tools": {
      allowedTools: ["whale_report"],
      canAdvance: ["write-plan"],
      task:
        "Decide required tools. Create draft plan items via whale_report (first persistence; each gets planItemId). Then advance to write-plan. Do not execute ka_sub_whale here. Candidate assignedTools list (system-injected actual names with descriptions): <candidate tools: name: description>.",
    },
    "write-plan": {
      allowedTools: ["whale_report", "read"],
      canAdvance: ["decide-goal", "working", "memory-maintenance", "plugin-maintenance", "communication"],
      task:
        "Finalize and persist the complete task plan via whale_report with finalPlanPayload (second persistence). Use separate planItems per coherent task; do not pack all work into one planItem. worker planItems are delegated individually in working; memoryMaintainer/pluginMaintainer planItems are reserved for memory-maintenance/plugin-maintenance. In amendment mode, read the current plan via taskPlanPath, persist the revised plan, then advance to the appropriate next stage (working, memory-maintenance, plugin-maintenance, or communication). Do not rely on plain-text-only persistence.",
    },
    "decide-goal": {
      allowedTools: ["whale_report"],
      canAdvance: ["working", GOAL_ACTIVE_STAGE],
      task:
        "Decide whether to use Goal or normal. Choose normal when the task can be completed in this workflow-run and does not need official Goal-driver cross-round auto-continuation or resume; multi-step is still normal when the task plan can manage it in working. Choose goal when the objective is clear but naturally requires multi-round autonomous iteration, progress tracking/resume, or an active/paused Goal already exists and the user wants to continue it. If Goal is needed, call whale_report({mode:'goal', objective, max_goal_rounds?}); that enters goal-active. If normal, call whale_report with normal/default mode to advance to working.",
    },
    working: {
      allowedTools: [...KAZ_V09_MAIN_TOOLS],
      canAdvance: ["write-plan", "memory-maintenance"],
      task:
        "Execute persona=main plan items on the main line; delegate each persona=worker plan item individually via ka_sub_whale. Do not delegate memoryMaintainer/pluginMaintainer plan items in working; memory/plugin items are reserved for memory-maintenance/plugin-maintenance. After ka_sub_whale, end the current turn and wait for the subagent's report/finished message; do not use pwsh sleep or poll list_agents to wait (list_agents/send_message are not wait primitives). Review the task plan whenever needed via taskPlanPath. Main critically evaluates subagent reports and their critiques instead of accepting them blindly, verifies results, amends only through write-plan, and asks only for decisions outside the plan. After working is complete, always advance to memory-maintenance before any communication; advance to plugin-maintenance from memory-maintenance only when plugin work remains.",
    },
    "memory-maintenance": {
      allowedTools: [
        "whale_report",
        "ka_sub_whale",
        "list_agents",
        "send_message",
        "interrupt_agent",
        "read",
        "memory_search",
        "memory_detail",
        "memory_list",
      ],
      canAdvance: ["plugin-maintenance", "communication", "write-plan"],
      task:
        "Delegate a memoryMaintainer persona to write memories. Delegate only persona=memoryMaintainer plan items in this stage. After each ka_sub_whale delegation, end the current turn and wait for the subagent's report/finished message; do not use pwsh sleep or poll list_agents to wait (list_agents/send_message are not wait primitives). Read taskPlanPath when needed to review the plan. If task-plan changes are required, advance to write-plan first; otherwise advance to plugin-maintenance only when plugin work remains, or communication.",
    },
    "plugin-maintenance": {
      allowedTools: [
        "whale_report",
        "ka_sub_whale",
        "list_agents",
        "send_message",
        "interrupt_agent",
        "read",
      ],
      canAdvance: ["write-plan", "communication"],
      task:
        "Delegate a pluginMaintainer persona to create/update/retire private plugins as needed. Delegate only persona=pluginMaintainer plan items in this stage. After each ka_sub_whale delegation, end the current turn and wait for the subagent's report/finished message; do not use pwsh sleep or poll list_agents to wait (list_agents/send_message are not wait primitives). Read taskPlanPath to review the plan. If a new plan item is needed, advance to write-plan first.",
    },
    communication: {
      allowedTools: [],
      canAdvance: ["end"],
      task: "Report the outcome to Kaczev. End.",
    },
  },
  worker: {
    "assess-complexity": {
      allowedTools: ["memory_search", "work_sub_whale_report"],
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
        "web_search",
        "work_sub_whale_report",
      ],
      canAdvance: ["check-tools"],
      task:
        "Critique the delegation first; identify real weaknesses; do not manufacture criticism. Find the smallest workable approach. Planning here uses read-only access; the full working file-tool set (edit, write, pwsh, read) is granted in the working stage, not in challenge-plan or check-tools. Do not report tool insufficiency before reaching working. Then advance to check-tools.",
    },
    "check-tools": {
      allowedTools: ["work_sub_whale_report"],
      canAdvance: ["working", "communication"],
      task:
        "Verify whether assigned tools are enough for the work. The full working file-tool set (edit, write, pwsh, read) is granted in the working stage, not here; do not report tool insufficiency before reaching working. Advance to working, or advance to communication only for a genuine blocker.",
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
        "todo_write",
        "web_search",
        "write",
        "work_sub_whale_report",
      ],
      canAdvance: ["communication"],
      task: "Execute the delegated work. Do not write memories or plugins.",
    },
    communication: {
      allowedTools: [],
      canAdvance: ["end"],
      task: "Report results and candidate suggestions.",
    },
  },
  memoryMaintainer: {
    "assess-delegation": {
      allowedTools: ["memory_search", "memory_sub_whale_report"],
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
        "glob",
        "grep",
        "memory_sub_whale_report",
      ],
      canAdvance: ["communication"],
      task:
        "Delete only items explicitly listed in the delegation brief. memory_forget performs internal backup/audit before deletion; do not claim backup without an auditable record.",
    },
    communication: {
      allowedTools: [],
      canAdvance: ["end"],
      task: "Report ids, evidence, and audit.",
    },
  },
  pluginMaintainer: {
    "assess-delegation": {
      allowedTools: ["read", "plugin_maintainer_sub_whale_report"],
      canAdvance: ["plan-plugin", "communication"],
      task: "Judge whether the plugin maintenance delegation is clear.",
    },
    "plan-plugin": {
      allowedTools: [
        "read",
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
        "glob",
        "grep",
        "pwsh",
        "todo_write",
        "plugin_maintainer_sub_whale_report",
      ],
      canAdvance: ["communication"],
      task:
        "Create a new private plugin under KazPrivatePlugins with lifecyclePath: {KAZ_PRIVATE_PLUGIN_LIFECYCLE_PATH}. Follow CANDIDATE → implementation → probe → registration → versioning; sync candidate registry.",
    },
    "update-plugin": {
      allowedTools: [
        "write",
        "edit",
        "read",
        "glob",
        "grep",
        "pwsh",
        "todo_write",
        "plugin_maintainer_sub_whale_report",
      ],
      canAdvance: ["communication"],
      task:
        "Update/version existing private plugin with probe discipline. Plugin lifecycle checklist: 1) record change/CANDIDATE; 2) edit under KazPrivatePlugins/<plugin>/; 3) probes + node --check; 4) version/register; 5) sync candidate registry; 6) hot reload only if probe passed, otherwise next task/restart. Read detailed rules from lifecyclePath: {KAZ_PRIVATE_PLUGIN_LIFECYCLE_PATH}.",
    },
    "retire-plugin": {
      allowedTools: [
        "read",
        "glob",
        "grep",
        "pwsh",
        "plugin_maintainer_sub_whale_report",
      ],
      canAdvance: ["communication"],
      task:
        "Retire/delete only plugins explicitly listed in the delegation brief. Plugin lifecycle checklist: 1) backup/audit; 2) remove only KazPrivatePlugins/<plugin>/ in brief; 3) sync candidate registry; 4) no public KazPlugins/official deletions. Read detailed rules from lifecyclePath: {KAZ_PRIVATE_PLUGIN_LIFECYCLE_PATH}.",
    },
    communication: {
      allowedTools: [],
      canAdvance: ["end"],
      task: "Report changed files, probe results, and rollback paths.",
    },
  },
  pluginCreator: {
    "assess-delegation": {
      allowedTools: ["read", "plugin_creator_sub_whale_report"],
      canAdvance: ["plan-plugin", "communication"],
      task: "Judge whether the plugin creation delegation is clear.",
    },
    "plan-plugin": {
      allowedTools: [
        "read",
        "glob",
        "grep",
        "pwsh",
        "todo_write",
        "plugin_creator_sub_whale_report",
      ],
      canAdvance: ["create-plugin", "communication"],
      task: "Plan the new private plugin under KazPrivatePlugins.",
    },
    "create-plugin": {
      allowedTools: [
        "write",
        "edit",
        "read",
        "glob",
        "grep",
        "pwsh",
        "todo_write",
        "plugin_creator_sub_whale_report",
      ],
      canAdvance: ["communication"],
      task:
        "Implement CANDIDATE → package/lib/probe → registration → versioning. Plugin lifecycle checklist: 1) CANDIDATE.md; 2) implement under KazPrivatePlugins/<plugin>/; 3) probes + node --check; 4) register/version; 5) sync candidate registry with English description; 6) hot reload only if probe passed, otherwise next task/restart. Read detailed rules from lifecyclePath: {KAZ_PRIVATE_PLUGIN_LIFECYCLE_PATH}.",
    },
    communication: {
      allowedTools: [],
      canAdvance: ["end"],
      task: "Report plugin path, probes, and rollback path.",
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
  if (role === "pluginCreator") return [...PLUGIN_CREATOR_STAGE_IDS];
  return [];
}

/** v0.9 主阶段 → ka_sub_whale 唯一可委派的 persona（36.8 + 37.5 stage-persona mapping）。
 *  pluginCreator is store-only/unused: no main stage maps to it. */
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
  pluginCreator: KAZ_ROLE_PROMPTS.subagent.pluginCreator,
});

/** v0.9 角色 → report 工具名。 */
export const V09_ROLE_REPORT_TOOLS = Object.freeze({
  worker: "work_sub_whale_report",
  memoryMaintainer: "memory_sub_whale_report",
  pluginMaintainer: "plugin_maintainer_sub_whale_report",
  pluginCreator: "plugin_creator_sub_whale_report",
});

/**
 * 构造 v0.9 阶段入口注入文本。
 * @param {string} role
 * @param {string} stage
 * @param {{taskPlanPath?: string, lifecyclePath?: string, candidateToolDirectory?: string}} options
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
taskPlanPath: ${path}
<`;
}
