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
        `Judge complexity AND unpack intent. Form a compact Intent Map before deciding: wanted outcome, domain priors, wording-vs-goal conflicts, and how success is verified (rendered output / code review / user feel). Simple direct answers may advance to communication; creative/visual/implementation-heavy requests advance to challenge-plan. Do not advance merely to satisfy process — advance when a real decision needs scrutiny. You may set this run's delivery gate alone via whale_report({ evidenceGate: true|false }); default off, set only here, immutable for the run.`,
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
        `Critique the approach first; identify real weaknesses and missed opportunities; do not manufacture criticism. Propose concrete, specific enhancements; avoid over-engineering. Ask concrete scope/priority/trade-off questions. Do not write task plans here and do not call ka_sub_whale. Treat user words as intent signals; surface conflicts; ask about look/feel before implementation knobs. Present ideas and wait for a decision.`,
    },
    "decide-tools-before-writing-plan": {
      allowedTools: ["context_search", "context_read", "context_compress", "whale_report"],
      canAdvance: ["write-plan"],
      task:`Choose required tools from the candidate private plugins list. Do not write task plans here — write-plan persists plans. Candidates: <candidate tools: name: description>. Only these private plugins and tool_jobs (job_list/job_output/job_kill) may go in assignedTools; regular file/memory tools are base surface and must not be listed. Advance to write-plan when ready.`,
    },
    "write-plan": {
      allowedTools: ["whale_report", "plan_read", "read", "grep", "glob", "web_search", "memory_detail", "memory_search", "memory_list",  "context_search", "context_read"],
      canAdvance: ["working", "memory-maintenance", "plugin-maintenance", "compass_context_before_communication", "communication"],
      task:`Finalize plan via whale_report(finalPlanPayload); use plan_read. One planItem per coherent task; do not pack all work into one. persona: main, worker, memoryMaintainer, pluginMaintainer; required planItemId/persona/task; optional summary (one-line purpose), dependsOn (planItemIds this item depends on), targets (files/dirs/domains), verification (concrete checks), assignedTools. Invalid payloads are rejected with structured plan-item-invalid error; nothing is persisted and no item is silently dropped. Delegation/memory/reviewer/visual rules: README §7.4.`,
    },
    working: {
      allowedTools: [...KAZ_V09_MAIN_TOOLS],
      canAdvance: ["decide-tools-before-writing-plan", "write-plan", "memory-maintenance"],
      task:
        `Delegate each persona=worker plan item individually via ka_sub_whale; do not delegate memory/plugin items here; advance to memory-maintenance before communication. After ka_sub_whale, end the turn. Child may pause mid-work (report without final:true/nextStage) — reply with send_message to resume it; finished child sends TERMINAL full report via *_sub_whale_report({ final: true }) as a single subagent-settled message. We wait for the report, verify it, decide next. Reuse an idle child with matching context via send_message to continue that child; else ka_sub_whale. Amend via write-plan.`,
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
        `Delegate memoryMaintainer plan items via ka_sub_whale, one at a time. A child may pause mid-work (report without final/nextStage) and sends its TERMINAL full report via memory_sub_whale_report({ final: true }) as one subagent-settled message. Review with plan_read; plan changes go through write-plan. The same memoryMaintainer sub-agent can be reused multiple times; each round starts at plan-memory. Before communication, call compass_context_before_communication. Memory/plugin on-demand rules: read KazPlugins/ka-whale-workflow/README.md §7.4.`,
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
        `Delegate pluginMaintainer plan items via ka_sub_whale, one at a time. A child may pause mid-work (report without final/nextStage) and sends its TERMINAL full report via plugin_maintainer_sub_whale_report({ final: true }) as one subagent-settled message. Review with plan_read; plan changes go through write-plan. Whether to reuse is determined by the main agent: send_message to the same surface + idle child, otherwise ka_sub_whale. Before communication, call compass_context_before_communication. Full lifecycle rules: read KazPlugins/ka-whale-workflow/README.md §7.4.`,
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
        `Critique the assigned task first; identify real weaknesses and missed opportunities; do not manufacture criticism. Propose concrete enhancements and present them clearly to the parent main agent, then wait for its decision — do not assume approval. Do not write task plans here and do not call ka_sub_whale. Ask the parent for clarification when task intent is unclear.`,
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
      terminal: true,
      task:
        `Execute the delegated work with care; follow the task closely; stay self-contained; no memories/plugins. When finished, review own work. THEN **OPTIONAL BUT IMPORTANT**: context_compress suggest, then fold when large (manual primary, auto fallback). Call work_sub_whale_report({ final: true }) with NO nextStage and write the FULL final report, then end turn: what/how/produced/remains/clarification.`,
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
      canAdvance: ["save-update-then-compress-context-then-report", "delete-memory-then-compress-context-then-report"],
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
      canAdvance: ["plan-memory", "delete-memory-then-compress-context-then-report"],
      terminal: true,
      task:
        "Save/update memories with evidence. Keep new entries as CANDIDATE. When work is finished, review own work; THEN **OPTIONAL BUT IMPORTANT (IMPORTANT)**: preview with context_compress suggest first before reporting, fold when large; manual primary, auto fallback. Then call memory_sub_whale_report({ final: true }) with NO nextStage and write the FULL final report (ids, evidence, audit) as the final message, then end the turn.",
    },
    "delete-memory-then-compress-context-then-report": {
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
      terminal: true,
      task:
        "Delete only items explicitly listed in the brief; memory_forget does backup/audit — do not claim backup without an auditable record. When finished, review; THEN **OPTIONAL BUT IMPORTANT**: preview with context_compress suggest first, fold when large (manual primary, auto fallback). Then call memory_sub_whale_report({ final: true }) with NO nextStage and write the FULL final report (ids, evidence, audit), then end turn.",
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
      terminal: true,
      task:
        "Create a new private plugin under KazPrivatePlugins: CANDIDATE → implementation → probe → registration/versioning, then sync the candidate registry. When finished, review; THEN **OPTIONAL BUT IMPORTANT**: preview with context_compress suggest first before reporting, fold when large (manual primary, auto fallback). Then call plugin_maintainer_sub_whale_report({ final: true }) with NO nextStage and write the FULL final report, then end turn.",
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
      terminal: true,
      task:
        "Update/version an existing private plugin: record change/CANDIDATE, edit KazPrivatePlugins/<plugin>/, probe + node --check, version/register, sync candidate registry. THEN **OPTIONAL BUT IMPORTANT**: preview with context_compress suggest first before reporting, fold when large (manual primary, auto fallback). Then call plugin_maintainer_sub_whale_report({ final: true }) with NO nextStage and write the FULL final report, then end turn.",
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
      terminal: true,
      task:
        "Retire/delete only plugins explicitly listed in the brief: backup/audit, remove only listed KazPrivatePlugins/<plugin>/, sync candidate registry; no public/official deletions. When finished, review; optional: context_compress suggest, then fold when large (manual primary, auto fallback). Then call plugin_maintainer_sub_whale_report({ final: true }) with NO nextStage and write the FULL final report, then end turn.",
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

/** 7.4 P1：S-only gated 主流程边（只有 ctx.tier==="S" + role==="main" 时可见）。 */
const S_ONLY_MAIN_ADVANCE = Object.freeze({
  "assess-complexity": Object.freeze(["working"]),
  working: Object.freeze(["communication"]),
});

/**
 * 单一派生函数：某 role/stage 在给定 tier ctx 下的合法 nextStage 列表。
 * - role==="main" 且 ctx.tier==="S"：只输出 S gated 边；其它主 stage 无合法 S 边。
 * - 其余情况（含所有子代理、无 ctx、tier M/L）原样返回静态 def.canAdvance。
 */
export function advanceListFor(role, stage, ctx) {
  const def = stageDefinitionFor(role, stage);
  if (def === null) return [];
  const tier = ctx !== null && ctx !== undefined && typeof ctx === "object" ? ctx.tier : undefined;
  if (role === MAIN_ROLE && tier === "S") {
    return S_ONLY_MAIN_ADVANCE[stage] !== undefined
      ? [...S_ONLY_MAIN_ADVANCE[stage]]
      : [];
  }
  return [...def.canAdvance];
}

/** 判断 role/stage 是否允许推进到 nextStage（ctx.tier 只对 main 生效）。 */
export function canAdvance(role, stage, nextStage, ctx) {
  if (typeof nextStage !== "string") return false;
  return advanceListFor(role, stage, ctx).includes(nextStage);
}

/** 判断 role/stage 是否为该 role 的 terminal（final:true 合法）执行阶段。 */
export function isFinalReportStage(role, stage) {
  return stageDefinitionFor(role, stage)?.terminal === true;
}

/** 返回某 role 的 terminal 执行 stage id（声明顺序，由 terminal:true 单一派生）。 */
export function terminalStageIdsForRole(role) {
  return stageIdsForRole(role).filter(
    (stage) => stageDefinitionFor(role, stage)?.terminal === true,
  );
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

/** 是否把 lifecyclePath 注入该阶段（v0.9 plugin 创建/更新/退休执行阶段）。 */
export function stageNeedsLifecyclePath(stage) {
  return PLUGIN_MAINTAINER_STAGE_IDS.includes(stage) && stage !== "plan-plugin";
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
 * @param {{taskPlanPath?: string, lifecyclePath?: string, candidateToolDirectory?: string, minimalTools?: string[], tier?: "S"|"M"|"L", ctx?: {tier?: "S"|"M"|"L"}}} options
 * options.minimalTools：可选；提供时在 `Can advance to:` 行后、`Task:` 行前输出
 * `Minimal (first round only): [...] until your first tool call; then the Allowed tools above unlock.`
 * options.tier / options.ctx：7.4 P1 可选 tier ctx；仅 main 且 tier==="S" 时改变
 * `Can advance to:` 行（缺省 = 静态 def.canAdvance，与 7.3.5 逐字节一致）。
 * @returns {string} 注入文本；role/stage 未知时返回空串。
 */
export function stageInjectionText(role, stage, options = {}) {
  const def = stageDefinitionFor(role, stage);
  if (def === null) return "";
  const tierCtx =
    options && options.ctx !== null && options.ctx !== undefined && typeof options.ctx === "object"
      ? options.ctx
      : typeof options?.tier === "string"
        ? { tier: options.tier }
        : undefined;
  const lines = [];
  lines.push(`[ka-whale-workflow ${stage}]`);
  lines.push(">");
  lines.push(`Allowed tools: [${def.allowedTools.join(", ")}]`);
  lines.push(`Can advance to: [${advanceListFor(role, stage, tierCtx).join(", ")}]`);
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
