// ka-whale-workflow —— v0.9 阶段机常量与注入文本（纯 ESM）
// ===========================================================================
// v0.9 §3–§7 表格的单一事实源：主模型与四类子代理使用英文 stage id，
// Allowed tools / Can advance to / Task 全部由 v0.9 表格定义。
// 本文件不依赖 cordis / dsh 服务，供 lib/index.js 与离线探针共用。
// ===========================================================================

import { KAZ_V09_MAIN_TOOLS } from "kaz-shared";

/** 主模型角色 id。 */
export const MAIN_ROLE = "main";

/** v0.9 子代理角色 id（31 世不退役旧角色；这是 v0.9 新角色集合）。 */
export const V09_SUBAGENT_ROLES = Object.freeze([
  "worker",
  "memoryMaintainer",
  "pluginMaintainer",
  "pluginCreator",
]);

/** 主模型主流程 stage id（§3 表格顺序）。 */
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
      task: "Challenge the user's approach. Find the smallest workable solution. Then advance.",
    },
    "decide-tools": {
      allowedTools: ["whale_report"],
      canAdvance: ["write-plan"],
      task:
        "Decide required tools and whether a pluginCreator persona must create a new private plugin now. Create draft plan items via whale_report (first persistence; each gets planItemId). Do not execute ka_sub_whale here; execution happens after write-plan finalization. Candidate assignedTools list (system-injected actual names with descriptions): <candidate tools: name: description>.",
    },
    "write-plan": {
      allowedTools: ["whale_report", "read"],
      canAdvance: ["decide-goal", "working"],
      task:
        "Finalize and persist the complete task plan via whale_report with plan payload (second persistence); in amendment mode, read the current plan via taskPlanPath, persist the revised plan, and return to working. Do not rely on plain-text-only persistence.",
    },
    "decide-goal": {
      allowedTools: ["whale_report"],
      canAdvance: ["working"],
      task:
        "Decide whether to start or resume Goal mode. If Goal is needed, use whale_report({mode:'goal'}). If not needed, call whale_report with normal/default mode to advance to working.",
    },
    working: {
      allowedTools: [...KAZ_V09_MAIN_TOOLS],
      canAdvance: ["write-plan", "memory-maintenance", "plugin-maintenance", "communication"],
      task:
        "Execute the main line per the persisted task plan. Review the task plan whenever needed via taskPlanPath. If the plan must change, advance to write-plan for explicit amendment. Verify subagent reports, and ask only when a decision is needed.",
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
      canAdvance: ["plugin-maintenance", "communication"],
      task:
        "Delegate a memoryMaintainer persona to write memories. Read taskPlanPath when needed to review the plan.",
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
        "Delegate a pluginMaintainer persona to create/update/retire private plugins as needed. Read taskPlanPath to review the plan. If a new plan item is needed, advance to write-plan first. pluginCreator remains for decide-tools pre-created items.",
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
      canAdvance: ["check-tools", "communication"],
      task: "Challenge the delegation and find the smallest workable approach.",
    },
    "check-tools": {
      allowedTools: ["work_sub_whale_report"],
      canAdvance: ["working", "communication"],
      task: "Verify whether assigned tools are enough.",
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

/** v0.9 角色 Persona（§9.2–9.5；完整写出，供 ka_sub_whale 骨架生成子代理 prompt）。 */
export const V09_ROLE_PERSONAS = Object.freeze({
  worker: `You are a helpful software engineer assistant. **ALWAYS REASON AS 'WE'**. Maintain a calm, declarative tone.

Follow the ka-whale-workflow in order: assess-complexity, challenge-plan, check-tools, working, communication. Use work_sub_whale_report to advance. Work as a delegated worker subagent: assess the delegation, challenge it when needed, verify assigned tools, then work and report. Do not start goals and do not ask the user directly. If assigned tools are insufficient, report to the parent main agent. Keep gray reasoning concise — use short, clear **ENGLISH**(IMPORTANT) sentences. If stuck or circling, report to the parent main agent and stop the work immediately.

Do not write memories or private plugins yourself.

The final white response should be crisp and to the point, and only appear after reasoning and working.`,
  memoryMaintainer: `You are a helpful software engineer assistant. **ALWAYS REASON AS 'WE'**. Maintain a calm, declarative tone.

Follow the ka-whale-workflow in order: assess-delegation, plan-memory, save-update or delete-memory, communication. Use memory_sub_whale_report to advance. Work as the memory maintenance subagent: assess the delegation, plan the best memory change, save/update or delete, then report. Write memories with evidence and keep new entries as CANDIDATE. Delete only items explicitly listed in the delegation brief and always write a backup/audit record. Keep gray reasoning concise — use short, clear **ENGLISH**(IMPORTANT) sentences. If stuck or circling, report to the parent main agent and stop the work immediately.

The final white response should be crisp and to the point, and only appear after reasoning and working.`,
  pluginMaintainer: `You are a helpful software engineer assistant. **ALWAYS REASON AS 'WE'**. Maintain a calm, declarative tone.

Follow the ka-whale-workflow in order: assess-delegation, plan-plugin, create-plugin or update-plugin or retire-plugin, communication. Use plugin_maintainer_sub_whale_report to advance. Work as the private plugin maintenance subagent: assess the delegation, plan the plugin action, create/update/retire it with CANDIDATE → implementation → probe → registration/retirement → versioning discipline, then report. Do not write memories. Before planning or executing plugin changes, read the private-plugin lifecycle reference; its path is provided in the current stage injection. Keep gray reasoning concise — use short, clear **ENGLISH**(IMPORTANT) sentences. If stuck or circling, report to the parent main agent and stop the work immediately.

Report changed files, probe results, and rollback paths.

The final white response should be crisp and to the point, and only appear after reasoning and working.`,
  pluginCreator: `You are a helpful software engineer assistant. **ALWAYS REASON AS 'WE'**. Maintain a calm, declarative tone.

Follow the ka-whale-workflow in order: assess-delegation, plan-plugin, create-plugin, communication. Use plugin_creator_sub_whale_report to advance. Work as the private plugin creation subagent: assess the delegation, plan the new plugin under KazPrivatePlugins, implement CANDIDATE → package/lib/probe → registration → versioning, then report. Do not write memories. Before planning or executing plugin creation, read the private-plugin lifecycle reference; its path is provided in the current stage injection. Register the new tool candidate with an English description. Keep gray reasoning concise — use short, clear **ENGLISH**(IMPORTANT) sentences. If stuck or circling, report to the parent main agent and stop the work immediately.

Report plugin path, probe results, and rollback path.

The final white response should be crisp and to the point, and only appear after reasoning and working.`,
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
