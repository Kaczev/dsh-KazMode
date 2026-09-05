// ka-whale-workflow —— 鲸鱼工作流（v0.9：主/受控子代理阶段机 + 工具面稳定）
// ===========================================================================
// 流程：
//   1) 主模型注入 [ka-whale-workflow main flow]（一次/新会话）与各 v0.9 阶段入口。
//   2) 受控 v0.9 子代理注入 role 专属 stage；普通旧未知子代理（includeSubagents=true）
//      注入旧通用 subagent-flow。
//   3) whale_report 在 Stable Main Surface 常驻，是主模型 stage 推进与 task plan
//      持久化的唯一 bookkeeping 入口。
//   4) v0.9 Goal 由 whale_report({mode:'goal'}) 启动/恢复；goal-active 是外部模式。
//
// 工具面（由 kaz-mode + kaz-shared 执行）：
//   - 主模型：minimal（首次工具调用前 ≤2）→ Stable Main Surface（固定集）；
//   - 受控子代理：role Minimal → role Stable Base + assignedTools；
//   - v0.8 Step B1：原生 Plan 已移除，纯 minimal → Stable Main 一次变化。
//
// 阶段状态：
//   写入插件自己的 JSON 存储（~/.dsh/storages/ka-whale-workflow-stage.json，
//   按 session id 索引），重启/续接会话自然恢复。v0.9 B5 后只接受 v0.9 stage /
//   goal-active / working-resumed 与 idle/done/end 状态壳，不再读写旧
//   reconstruction / classification / goal-recovery 值。
// ===========================================================================

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import {
  SKILL_BOUNDARY_MAX_CHANGES,
  SKILL_PRIVATE_DIR_NAME,
  SKILL_PROCESS_DIR_NAME,
  AGENT_MANAGED_STORAGE_FILE,
  normalizeAgentManagedRegistry,
  normalizeSkillLifecycle,
  auditSkillLifecycle,
  projectRegistryFromLifecycle,
  transitionAllowed,
  skillKeyOf,
  KAZ_TASK_PLAN_STORE_PATH,
  KAZ_PRIVATE_PLUGIN_LIFECYCLE_PATH,
  KAZ_PRIVATE_PLUGIN_CANDIDATE_PATH,
  KAZ_ROLE_PROMPTS,
  KAZ_V09_MAIN_TOOLS,
  KAZ_V09_SUB_WHALE_REPORT_TOOLS,
  KAZ_V09_SUBAGENT_ROLE_TOOLS,
  V09_SUBAGENT_ROLE_IDS,
  V09_SUBAGENT_ROLE_MINIMAL_TOOLS,
  V09_SUBAGENT_ROLE_STABLE_BASE,
  V09_SUBAGENT_ROLE_PERSONA_REFS,
  V09_SUBAGENT_ROLE_TOOL_FILTERS,
  V09_TOOL_JOBS,
  V09_ASSIGNED_TOOLS_WARN_THRESHOLD,
  V09_ASSIGNED_TOOLS_MAX,
  normalizeV09Role,
  v09ToolFilterForRole,
  computeV09FinalSurface,
  resolveV09AssignedTools,
  normalizeAgentManagedCandidateRegistry,
  availablePrivatePluginCandidateToolNames,
  privatePluginCandidateToolNames,
} from "kaz-shared";
import { readJsonFileSafe, writeJsonFileSafe } from "kaz-shared/lib/safe-json-file.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  MAIN_ROLE,
  MAIN_STAGE_IDS,
  GOAL_ACTIVE_STAGE,
  WORKING_RESUMED_STAGE,
  GOAL_ACTIVE_CONTEXT_TEXT,
  workingResumedContextText,
  V09_SUBAGENT_ROLES,
  V09_STAGE_IDS,
  V09_ROLE_PERSONAS,
  V09_ROLE_REPORT_TOOLS,
  V09_KA_SUB_WHALE_STAGE_PERSONAS,
  stageDefinitionFor,
  stageInjectionText,
  stageIdsForRole,
  canAdvance,
  isMainWorkflowStage,
  isSubagentWorkflowStage,
  stageNeedsLifecyclePath,
  stageNeedsTaskPlanPath,
} from "./stage-defs.js";
import {
  createTaskPlanStore,
  resolvePlanItemForDelegation,
} from "./task-plan-store.js";

/** 设置命名空间：~/.dsh/settings.yaml 中的 ka-whale-workflow: 段。 */
const NAMESPACE = settingsNamespace("ka-whale-workflow");

/** 终案 E：lifecycle 意图源 / 机器审计 / agent-managed registry 文件（DSH_HOME/storages）。 */
const LIFECYCLE_FILE_NAME = "kaz-skill-lifecycle.json";
const LIFECYCLE_AUDIT_FILE_NAME = "kaz-skill-lifecycle-audit.jsonl";

function defaultLifecycleFile() {
  return join(process.env.DSH_HOME || join(homedir(), ".dsh"), "storages", LIFECYCLE_FILE_NAME);
}

function defaultLifecycleAuditFile() {
  return join(process.env.DSH_HOME || join(homedir(), ".dsh"), "storages", LIFECYCLE_AUDIT_FILE_NAME);
}

function defaultAgentManagedRegistryFile() {
  return join(process.env.DSH_HOME || join(homedir(), ".dsh"), "storages", AGENT_MANAGED_STORAGE_FILE);
}

/** whale_report：v0.9 主模型 stage 推进/任务计划持久化工具。 */
export const WHALE_REPORT_TOOL = "whale_report";

/** v0.9 受控委派工具名（32 世实际 continuable 委派层）。 */
export const KA_SUB_WHALE_TOOL = "ka_sub_whale";

/** v0.9 子代理 report 工具名（ka-whale-workflow 注册并包装子代理 report 能力）。 */
export const WORK_SUB_WHALE_REPORT_TOOL = "work_sub_whale_report";
export const MEMORY_SUB_WHALE_REPORT_TOOL = "memory_sub_whale_report";
export const PLUGIN_MAINTAINER_SUB_WHALE_REPORT_TOOL = "plugin_maintainer_sub_whale_report";
export const PLUGIN_CREATOR_SUB_WHALE_REPORT_TOOL = "plugin_creator_sub_whale_report";

/** v0.9 stage 常量（再导出，便于探针/下游引用）。 */
export { MAIN_ROLE, MAIN_STAGE_IDS, V09_SUBAGENT_ROLES, V09_STAGE_IDS };

/** v0.9 Goal-active 外部模式/边界注入常量（再导出，便于探针/下游引用）。 */
export {
  GOAL_ACTIVE_STAGE,
  WORKING_RESUMED_STAGE,
  GOAL_ACTIVE_CONTEXT_TEXT,
  workingResumedContextText,
};

/** 任务计划独立存储路径常量（由 kaz-shared 定义，这里再导出便于探针）。 */
export { KAZ_TASK_PLAN_STORE_PATH, KAZ_PRIVATE_PLUGIN_LIFECYCLE_PATH };

/** 用户手动指令开启模式的命令名（v0.8 Step B1：/plan 已移除，仅剩 /goal）。 */
const MANUAL_COMMAND_NAMES = ["goal"];

/** v0.9 主流程上下文文案（v0.9 §9.1 Persona Goal-active 口径；阶段注入另行按 run 追加）。
 *  正文取自 kaz-shared 的 KAZ_ROLE_PROMPTS.main，避免双源漂移。 */
export const MAIN_FLOW_TEXT = `[ka-whale-workflow main flow]
>
${KAZ_ROLE_PROMPTS.main}`;

/** v0.9 worker 子代理流程上下文文案（§9.2；其它 role 由各自 stage 注入覆盖）。
 *  正文取自 kaz-shared 的 KAZ_ROLE_PROMPTS.subagent.worker。 */
export const SUBAGENT_FLOW_TEXT = `[ka-whale-workflow subagent flow]
>
${KAZ_ROLE_PROMPTS.subagent.worker}`;

/** v0.9 受控子代理 role → 首个 workflow stage（§4 worker；§5–§7 其它 role）。 */
export const V09_SUBAGENT_ROLE_INITIAL_STAGES = Object.freeze({
  worker: "assess-complexity",
  memoryMaintainer: "assess-delegation",
  pluginMaintainer: "assess-delegation",
  pluginCreator: "assess-delegation",
});

/** 设置 schema（同时驱动设置页 UI）。 */
const SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(true),
  /** 子代理是否也走鲸鱼工作流；默认关（与 round-minimal 的语义一致）。 */
  includeSubagents: z.boolean().default(false),
  /** 自主 skill 管理总开关；关闭后回到一阶段“按需自升级”。 */
  skillAutonomyEnabled: z.boolean().default(true),
  /** 每个安全边界允许的技能变更数上限（v2.0 硬上限为 1，设置值会被钳制到 1）。 */
  skillAutonomyMaxChangesPerBoundary: z.number().min(1).default(1),
  /** 私有技能根目录；空串时回退到 DSH_HOME/profiles/web/KazPrivatePlugins。 */
  skillPrivateRoot: z.string().default(""),
  /** 终案 E：全自动 Skill 生命周期（Kaz 面板总开关与参数）。 */
  skillAutoLifecycleEnabled: z.boolean().default(true),
  skillLifecycleUnusedDays: z.number().min(1).default(60),
  skillLifecyclePendingDays: z.number().min(1).default(7),
  skillLifecycleAuditIntervalHours: z.number().min(1).default(24),
  skillLifecycleMaxAutoActions: z.number().min(1).default(1),
});

/** 本插件 settings.yaml 段的默认配置（镜像作者 settings.yaml；仅含非运行时字段）。 */
export const DEFAULT_SECTION = {
  enabled: true,
  includeSubagents: false,
  skillAutonomyEnabled: true,
  skillAutonomyMaxChangesPerBoundary: 1,
  skillPrivateRoot: "",
  skillAutoLifecycleEnabled: true,
  skillLifecycleUnusedDays: 60,
  skillLifecyclePendingDays: 7,
  skillLifecycleAuditIntervalHours: 24,
  skillLifecycleMaxAutoActions: 1,
};

// ---------------------------------------------------------------------------
// settings 自愈（纯方案 A：kazMode.pluginConfig 优先，settings.yaml 仅作兜底）
// ---------------------------------------------------------------------------

/** 卸载判定：插件 fiber 正在拆除时不再回写 source（与 dsh-settings 内部一致）。 */
function isUnloading(ctx) {
  const state = ctx.fiber.state;
  return state === 5 || state === 4; // FiberState.Unloading / Disposed
}

function installSettingsWithDefaults(ctx, ns, schema, entry, defaults, hooks) {
  ctx.inject(["settings"], (sctx) => {
    const scope = sctx.settings.register(ns, schema, { base: entry });
    hooks.setSource(() => scope.get());
    sctx.effect(() => () => {
      if (isUnloading(ctx)) return;
      hooks.setSource(() => entry);
      hooks.onChange();
    });
    hooks.onChange();
    scope.watch(() => {
      if (isUnloading(ctx)) return;
      hooks.onChange();
    });
  });
}

/** 归一化工具清单：只保留非空字符串、trim、去重。 */
function normalizeToolList(value) {
  const out = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item !== "string") continue;
    const tool = item.trim();
    if (tool.length > 0 && !out.includes(tool)) out.push(tool);
  }
  return out;
}

/** 归一化任意来源（组合行 config / settings 解析值）的配置。 */
function normalizeConfig(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const rawMaxChanges = value.skillAutonomyMaxChangesPerBoundary;
  const maxChanges =
    Number.isInteger(rawMaxChanges) && rawMaxChanges >= 1
      ? Math.min(rawMaxChanges, SKILL_BOUNDARY_MAX_CHANGES)
      : SKILL_BOUNDARY_MAX_CHANGES;
  const intDefault = (rawValue, fallback) =>
    Number.isInteger(rawValue) && rawValue >= 1 ? rawValue : fallback;
  return {
    enabled: value.enabled !== false,
    includeSubagents: value.includeSubagents === true,
    skillAutonomyEnabled: value.skillAutonomyEnabled !== false,
    skillAutonomyMaxChangesPerBoundary: maxChanges,
    skillPrivateRoot:
      typeof value.skillPrivateRoot === "string" && value.skillPrivateRoot.trim().length > 0
        ? value.skillPrivateRoot.trim()
        : "",
    // 终案 E：全自动 Skill 生命周期配置。
    skillAutoLifecycleEnabled: value.skillAutoLifecycleEnabled !== false,
    skillLifecycleUnusedDays: intDefault(value.skillLifecycleUnusedDays, 60),
    skillLifecyclePendingDays: intDefault(value.skillLifecyclePendingDays, 7),
    skillLifecycleAuditIntervalHours: intDefault(value.skillLifecycleAuditIntervalHours, 24),
    skillLifecycleMaxAutoActions: 1, // 硬性护栏：每周期最多 1 个自动动作
  };
}

/**
 * tools/result 埋点过滤（纯函数）：只统计顶层调用（exec.parent === undefined）。
 * 返回 { name, isError, agentId, subagent }；不满足条件返回 null。
 */
export function skillToolUseEvent(exec, result) {
  if (exec === null || exec === undefined || typeof exec !== "object") return null;
  if (exec.parent !== undefined && exec.parent !== null) return null;
  if (typeof exec.name !== "string" || exec.name.trim().length === 0) return null;
  if (result === null || result === undefined || typeof result !== "object") return null;
  const agent = exec.agent;
  return {
    name: exec.name.trim(),
    isError: result.isError === true,
    agentId:
      typeof agent?.session?.id === "string"
        ? agent.session.id
        : typeof agent?.id === "string"
          ? agent.id
          : null,
    subagent: typeof agent?.options?.subagentDepth === "number" && agent.options.subagentDepth > 0,
  };
}

/**
 * 把一次顶层工具结果并入单条 lifecycle 记录（纯函数，返回新记录，不改入参）。
 * 真实使用会使 retire-pending/retired 复活为 active；active/update-needed 保持原状态。
 */
export function applySkillToolUse(record, result, nowIso = new Date().toISOString()) {
  if (record === null || record === undefined || typeof record !== "object") return null;
  if (result === null || result === undefined || typeof result !== "object") return null;
  const isError = result.isError === true;
  const wasNonActive = record.status === "retire-pending" || record.status === "retired";
  const status = wasNonActive ? "active" : record.status;
  const now = typeof nowIso === "string" && nowIso.length > 0 ? nowIso : new Date().toISOString();
  return {
    ...record,
    status,
    statusChangedAt: wasNonActive ? now : record.statusChangedAt,
    lastUsedAt: now,
    lastSuccessfulAt: isError ? record.lastSuccessfulAt : now,
    lastErrorAt: isError ? now : record.lastErrorAt,
    usageCount: (Number.isInteger(record.usageCount) ? record.usageCount : 0) + 1,
    failureCount: (Number.isInteger(record.failureCount) ? record.failureCount : 0) + (isError ? 1 : 0),
    consecutiveFailures: isError
      ? (Number.isInteger(record.consecutiveFailures) ? record.consecutiveFailures : 0) + 1
      : 0,
    retire:
      wasNonActive
        ? { reason: null, pendingAt: null, confirmedAt: null }
        : record.retire ?? { reason: null, pendingAt: null, confirmedAt: null },
  };
}

/** 由 registry 条目构造一条新的 lifecycle 记录（active，createdAt=firstSeenAt=now）。 */
export function createLifecycleRecord(plugin, tool, nowIso = new Date().toISOString()) {
  const now = typeof nowIso === "string" && nowIso.length > 0 ? nowIso : new Date().toISOString();
  return {
    plugin: typeof plugin === "string" ? plugin.trim() : "",
    tool: typeof tool === "string" ? tool.trim() : "",
    version: "0.0.0",
    status: "active",
    statusChangedAt: now,
    createdAt: now,
    firstSeenAt: now,
    lastUsedAt: null,
    lastSuccessfulAt: null,
    lastErrorAt: null,
    usageCount: 0,
    failureCount: 0,
    consecutiveFailures: 0,
    probe: { lastRunAt: null, lastResult: "not-run", failCount: 0, passCount: 0 },
    retire: { reason: null, pendingAt: null, confirmedAt: null },
    update: { state: "none", evidence: [], patchRef: null, stagedVersion: null },
    manifestRel: "",
    switchRel: "",
    audit: { lastAction: null, lastActionAt: null, actionCount: 0 },
    autoFixPolicy: "never",
  };
}

/** 是否为会话型子代理（含 workflow / ralph 派生的子会话）。 */
function isSubagent(agent) {
  try {
    const depth = agent?.options?.subagentDepth;
    if (typeof depth === "number" && depth > 0) return true;
    const events = agent?.session?.events;
    if (Array.isArray(events)) {
      for (const event of events) {
        if (event !== null && typeof event === "object" && event.type === "subagent/descriptor") return true;
      }
    }
  } catch {
    // fall through
  }
  return false;
}

/** 从 session 对象判断是否子代理（session/event 形态用）。 */
function isSubagentSession(session) {
  try {
    const header = session?.header;
    if (header === null || header === undefined || typeof header !== "object") return false;
    return header.origin === "subagent" || typeof header.parentSession === "string";
  } catch {
    return false;
  }
}

/** 从消息中提取纯文本：content 数组的 text 部分；无则回退 source.summary。 */
export function messageTextOf(message) {
  try {
    if (message === null || message === undefined || typeof message !== "object") return "";
    const content = Array.isArray(message.content) ? message.content : [];
    const parts = [];
    for (const part of content) {
      if (
        part !== null &&
        typeof part === "object" &&
        typeof part.text === "string" &&
        part.text.trim().length > 0
      ) {
        parts.push(part.text);
      }
    }
    if (parts.length > 0) return parts.join("\n");
    const source = message.source;
    if (source !== null && typeof source === "object" && typeof source.summary === "string") {
      return source.summary;
    }
    return "";
  } catch {
    return "";
  }
}

/** 把多行文本压成单行摘要；超长截断到 max（默认 240）。 */
export function oneLineSummary(value, max = 240) {
  const text = typeof value === "string" ? value : "";
  const line = text.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  return line.length > max ? line.slice(0, max) + "…" : line;
}

/** 是否为 DSH 子代理 report/settled 内部消息。 */
export function isSubagentReportMessage(message) {
  try {
    const source = message?.source;
    if (source === null || source === undefined || typeof source !== "object") return false;
    return source.kind === "subagent-report" || source.kind === "subagent-settled";
  } catch {
    return false;
  }
}

/** 提取子代理 report/settled 消息的单行摘要；非该类消息返回空串。 */
export function subagentReportSummaryOf(message) {
  if (!isSubagentReportMessage(message)) return "";
  return oneLineSummary(messageTextOf(message));
}

/** 会话里是否已发生第一次工具调用。 */
function hasToolCall(agent) {
  try {
    const events = agent?.session?.events;
    if (!Array.isArray(events)) return false;
    return events.some((event) => event !== null && typeof event === "object" && event.type === "tool/call");
  } catch {
    return false;
  }
}

/** 该 agent 会话是否处于 goal 模式：经 goals 服务查询，phase 为 active/paused
 *  即为激活（与 kaz-mode 的 goalActive 同源；服务缺失按未开启处理）。 */
export function goalModeActiveOf(agent, goals) {
  const goal = currentGoalOf(agent, goals);
  return goal !== null && (goal.phase === "active" || goal.phase === "paused");
}

/** 读取 goals 服务返回的当前 goal view；无目标/服务缺失/异常一律返回 null。 */
export function currentGoalOf(agent, goals) {
  try {
    if (
      goals === undefined ||
      goals === null ||
      typeof goals.get !== "function" ||
      agent === null ||
      agent === undefined
    ) {
      return null;
    }
    const goal = goals.get(agent);
    if (goal === null || goal === undefined || typeof goal !== "object") return null;
    return goal;
  } catch {
    return null;
  }
}

/** 当前开启的模型回合内是否出现真实人类消息（source.kind === "user"）。
 *  与 @deepseek-ai/dsh-tool-goal 的 requireDirectHuman 语义一致。 */
export function hasDirectHumanInOpenTurn(agent) {
  try {
    const events = agent?.session?.events;
    if (!Array.isArray(events)) return false;
    let start = -1;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const boundary = events[index];
      if (boundary === null || typeof boundary !== "object") continue;
      if (boundary.type === "turn/end") return false;
      if (boundary.type === "turn/start") {
        start = index;
        break;
      }
    }
    if (start === -1) return false;
    for (let index = start + 1; index < events.length; index += 1) {
      const event = events[index];
      if (event === null || typeof event !== "object" || event.type !== "user/message") continue;
      if (event.data?.source?.kind === "user") return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** 插件自己的阶段状态文件名（DSH_HOME/storages 下，按 session id 索引）。
 *  注意：不能再用 agent.session.append("ka-whale-workflow/stage", ...) 持久化——
 *  DSH 的会话日志会把未注册的自定义事件视为未知且不可忽略，重载时直接拒绝读取
 *  整个 session（SessionFormatUnsupportedError）。改用插件自己的 JSON 存储。 */
const STAGE_FILE_NAME = "ka-whale-workflow-stage.json";

/** 默认阶段状态文件：~/.dsh/storages/ka-whale-workflow-stage.json。 */
function defaultStageFile() {
  return join(process.env.DSH_HOME || join(homedir(), ".dsh"), "storages", STAGE_FILE_NAME);
}

/** 会话 id：session.id 优先，回退 agent.id。 */
export function sessionIdOf(agent) {
  try {
    const id = agent?.session?.id || agent?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** 任务契约状态：pending = 模型已产出契约等待 ask_user_question；
 *  confirmed = 用户确认（可展开 Task Surface）；modified/abandoned 未确认。 */
const CONTRACT_STATUSES = new Set(["none", "pending", "confirmed", "modified", "abandoned"]);

/** 归一化一条任务契约状态；损坏/字段形状错误返回 null。 */
export function normalizeContractStateValue(raw) {
  if (raw === null || raw === undefined || typeof raw !== "object") return null;
  const status = CONTRACT_STATUSES.has(raw.status) ? raw.status : "none";
  return {
    status,
    contractText: typeof raw.contractText === "string" ? raw.contractText : "",
    confirmedAt: typeof raw.confirmedAt === "string" ? raw.confirmedAt : "",
  };
}

/** 归一化一条受控子代理角色记录（v0.9 B3）。 */
export function normalizeSubagentRoleRecord(raw) {
  if (raw === null || raw === undefined || typeof raw !== "object") return null;
  const planItemId = typeof raw.planItemId === "string" ? raw.planItemId.trim() : "";
  const persona = typeof raw.persona === "string" ? raw.persona.trim() : "";
  if (planItemId.length === 0 || persona.length === 0 || !V09_SUBAGENT_ROLES.includes(persona)) return null;
  return {
    planItemId,
    persona,
    assignedTools: normalizeToolList(raw.assignedTools),
    finalTools: normalizeToolList(raw.finalTools),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
  };
}

/** 存储可接受的所有 stage 值：v0.9 + goal-active 外部模式/working-resumed 边界 + 状态壳。
 *  B5 后已删除旧阶段字符串。 */
const KNOWN_SESSION_STAGES = new Set([
  ...V09_STAGE_IDS,
  GOAL_ACTIVE_STAGE,
  WORKING_RESUMED_STAGE,
  "idle",
  "done",
  "end",
]);

/**
 * 创建阶段状态存储（可注入文件路径，便于探针用临时文件）。
 * 结构：{ version: 6,
 *        sessions: { "<sessionId>": "<v0.9 stage>" },
 *        contractState: { "<sessionId>": {...} },
 *        workflowRuns: { "<sessionId>": { runId, enteredStages } },
 *        pendingStageInjection: { "<sessionId>": "<stage>" },
 *        subagentRoles: { "<childSessionId>": { planItemId, persona,
 *          assignedTools, finalTools, createdAt, updatedAt } } }
 * 旧文件缺少 contractState / workflowRuns 时仍按旧版读取；taskToolState 字段 B5 起不再读。
 */
export function createStageStore(file) {
  const sessions = {};
  const contractState = {};
  const workflowRuns = {};
  const pendingStageInjection = {};
  const subagentRoles = {};
  try {
    if (file !== undefined && file !== null && existsSync(file)) {
      let raw = readFileSync(file, "utf8");
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      const parsed = JSON.parse(raw);
      const data = parsed !== null && typeof parsed === "object" ? parsed.sessions : undefined;
      if (data !== null && typeof data === "object") {
        for (const [id, stage] of Object.entries(data)) {
          if (id.length > 0 && typeof stage === "string" && KNOWN_SESSION_STAGES.has(stage)) {
            sessions[id] = stage;
          }
        }
      }
      const rawContracts = parsed !== null && typeof parsed === "object" ? parsed.contractState : undefined;
      if (rawContracts !== null && typeof rawContracts === "object") {
        for (const [id, rawContract] of Object.entries(rawContracts)) {
          if (id.length === 0) continue;
          const normalized = normalizeContractStateValue(rawContract);
          if (normalized !== null) contractState[id] = normalized;
        }
      }
      const rawRuns = parsed !== null && typeof parsed === "object" ? parsed.workflowRuns : undefined;
      if (rawRuns !== null && typeof rawRuns === "object") {
        for (const [id, rawRun] of Object.entries(rawRuns)) {
          if (id.length === 0 || rawRun === null || typeof rawRun !== "object") continue;
          const runId = Number.isSafeInteger(rawRun.runId) && rawRun.runId > 0 ? rawRun.runId : 0;
          const enteredStages = Array.isArray(rawRun.enteredStages)
            ? rawRun.enteredStages.filter((item) => typeof item === "string")
            : [];
          workflowRuns[id] = { runId, enteredStages };
        }
      }
      const rawPending = parsed !== null && typeof parsed === "object" ? parsed.pendingStageInjection : undefined;
      if (rawPending !== null && typeof rawPending === "object") {
        for (const [id, stage] of Object.entries(rawPending)) {
          if (id.length === 0 || typeof stage !== "string") continue;
          if (KNOWN_SESSION_STAGES.has(stage)) pendingStageInjection[id] = stage;
        }
      }
      const rawSubagentRoles =
        parsed !== null && typeof parsed === "object" ? parsed.subagentRoles : undefined;
      if (rawSubagentRoles !== null && typeof rawSubagentRoles === "object") {
        for (const [id, rawRole] of Object.entries(rawSubagentRoles)) {
          if (id.length === 0) continue;
          const normalized = normalizeSubagentRoleRecord(rawRole);
          if (normalized !== null) subagentRoles[id] = normalized;
        }
      }
    }
  } catch {
    // 存储损坏时从空状态开始，不影响主流程
  }
  function persist() {
    if (typeof file !== "string" || file.length === 0) return true;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify(
          {
            version: 6,
            sessions,
            contractState,
            workflowRuns,
            pendingStageInjection,
            subagentRoles,
          },
          null,
          2,
        ) + String.fromCharCode(10),
        "utf8",
      );
      return true;
    } catch {
      return false;
    }
  }
  const runStateOf = (sessionId) => {
    let state = workflowRuns[sessionId];
    if (state === undefined) {
      state = { runId: 0, enteredStages: [] };
      workflowRuns[sessionId] = state;
    }
    return state;
  };
  return {
    file,
    get(sessionId) {
      return typeof sessionId === "string" && sessionId.length > 0 ? sessions[sessionId] ?? null : null;
    },
    set(sessionId, stage) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return false;
      if (typeof stage !== "string" || !KNOWN_SESSION_STAGES.has(stage)) return false;
      sessions[sessionId] = stage;
      return persist();
    },
    remove(sessionId) {
      if (typeof sessionId === "string") delete sessions[sessionId];
      persist();
    },
    getContractState(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return null;
      const value = contractState[sessionId];
      return value === undefined ? null : JSON.parse(JSON.stringify(value));
    },
    setContractState(sessionId, value) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return false;
      const normalized = normalizeContractStateValue(value);
      if (normalized === null) return false;
      contractState[sessionId] = normalized;
      return persist();
    },
    removeContractState(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return false;
      if (!Object.prototype.hasOwnProperty.call(contractState, sessionId)) return false;
      delete contractState[sessionId];
      persist();
      return true;
    },
    /** workflow-run 状态：{ runId, enteredStages }。 */
    getWorkflowRun(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return null;
      return JSON.parse(JSON.stringify(runStateOf(sessionId)));
    },
    beginWorkflowRun(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return false;
      const state = runStateOf(sessionId);
      state.runId = Number.isSafeInteger(state.runId) ? state.runId + 1 : 1;
      state.enteredStages = [];
      return persist();
    },
    addWorkflowRunStage(sessionId, stage) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return false;
      const state = runStateOf(sessionId);
      state.enteredStages.push(stage);
      return persist();
    },
    hasWorkflowRunStage(sessionId, stage) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return false;
      return runStateOf(sessionId).enteredStages.includes(stage);
    },
    getPendingStageInjection(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return null;
      return pendingStageInjection[sessionId] ?? null;
    },
    setPendingStageInjection(sessionId, stage) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return false;
      if (typeof stage !== "string" || !KNOWN_SESSION_STAGES.has(stage)) return false;
      pendingStageInjection[sessionId] = stage;
      return persist();
    },
    clearPendingStageInjection(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return false;
      if (!Object.prototype.hasOwnProperty.call(pendingStageInjection, sessionId)) return false;
      delete pendingStageInjection[sessionId];
      persist();
      return true;
    },
    getSubagentRole(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return null;
      const value = subagentRoles[sessionId];
      return value === undefined ? null : JSON.parse(JSON.stringify(value));
    },
    setSubagentRole(sessionId, value) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return false;
      const normalized = normalizeSubagentRoleRecord(value);
      if (normalized === null) return false;
      const previous = subagentRoles[sessionId];
      const timestamp = new Date().toISOString();
      subagentRoles[sessionId] = {
        ...normalized,
        createdAt: previous?.createdAt || timestamp,
        updatedAt: timestamp,
      };
      return persist();
    },
    removeSubagentRole(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return false;
      if (!Object.prototype.hasOwnProperty.call(subagentRoles, sessionId)) return false;
      delete subagentRoles[sessionId];
      persist();
      return true;
    },
  };
}

/** 读取当前阶段：插件 JSON 存储优先；无记录返回 "idle"。 */
export function stageOf(agent, store = null) {
  const sessionId = sessionIdOf(agent);
  if (store !== null && store !== undefined && typeof store.get === "function") {
    const stored = store.get(sessionId);
    if (typeof stored === "string" && KNOWN_SESSION_STAGES.has(stored)) return stored;
  }
  return "idle";
}

/** 设置阶段（仅当与当前阶段不同）：写入插件自己的 JSON 存储，不再 append 会话事件。 */
export function setStage(agent, stage, store = null) {
  const current = stageOf(agent, store);
  if (current === stage) return false;
  const sessionId = sessionIdOf(agent);
  if (sessionId === null) return false;
  if (store !== null && store !== undefined && typeof store.set === "function") {
    return store.set(sessionId, stage);
  }
  return false;
}

/** 是否真实用户消息（跳过 plugin / goal / tool 注入消息）。 */
export function isUserMessage(message) {
  if (message === null || message === undefined || typeof message !== "object") return false;
  const source = message.source;
  if (source === null || source === undefined || typeof source !== "object") return true;
  if (source.kind === "plugin" || source.kind === "goal" || source.kind === "tool") return false;
  // DSH continuable-subagent 消息不是真实用户：report / settlement / child / diagnostic
  // 都不应触发主模型“新一轮任务”或“真实用户消息”路由。
  if (
    source.kind === "subagent-report" ||
    source.kind === "subagent-settled" ||
    source.kind === "diagnostic" ||
    source.kind === "child"
  ) {
    return false;
  }
  if (typeof source.plugin === "string" && source.plugin.length > 0) return false;
  return true;
}

/** 会话日志里是否已注入过 ka-whale-workflow 的指定 form 消息。 */
function hasInjectedBefore(agent, form) {
  try {
    const events = agent?.session?.events;
    if (!Array.isArray(events)) return false;
    return events.some((event) => {
      if (event === null || typeof event !== "object" || event.type !== "user/message") return false;
      const data = event.data;
      if (data === null || typeof data !== "object") return false;
      const source = data.source;
      if (source === null || typeof source !== "object") return false;
      if (source.kind !== "plugin" || source.plugin !== "ka-whale-workflow") return false;
      return form === undefined || source.form === form;
    });
  } catch {
    return false;
  }
}

/** 会话日志里当前轮次（最后一个 turn/start 的 turn；无则 0）。 */
function currentTurnOf(agent) {
  try {
    const events = agent?.session?.events;
    if (!Array.isArray(events)) return 0;
    let turn = 0;
    for (const event of events) {
      if (
        event !== null &&
        typeof event === "object" &&
        event.type === "turn/start" &&
        event.data !== null &&
        typeof event.data === "object" &&
        typeof event.data.turn === "number" &&
        event.data.turn > turn
      ) {
        turn = event.data.turn;
      }
    }
    return turn;
  } catch {
    return 0;
  }
}

/** 指定 turn 内是否已注入过 ka-whale-workflow 的指定 form 消息。 */
export function hasInjectedInTurn(agent, form, turn) {
  try {
    const events = agent?.session?.events;
    if (!Array.isArray(events)) return false;
    let turnStartIndex = -1;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (
        event !== null &&
        typeof event === "object" &&
        event.type === "turn/start" &&
        event.data !== null &&
        typeof event.data === "object" &&
        event.data.turn === turn
      ) {
        turnStartIndex = index;
      }
    }
    if (turnStartIndex === -1) return false;
    for (let index = turnStartIndex + 1; index < events.length; index += 1) {
      const event = events[index];
      if (event === null || typeof event !== "object" || event.type !== "user/message") continue;
      const data = event.data;
      if (data === null || typeof data !== "object") continue;
      const source = data.source;
      if (source === null || typeof source !== "object") continue;
      if (source.kind !== "plugin" || source.plugin !== "ka-whale-workflow") continue;
      if (form === undefined || source.form === form) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** 新一轮真实用户消息（第 2、3、4……轮，模型不在运行）的路由。
 *  36.5 语义：
 *  - Goal 激活时不重新开启 assess-complexity，保持 goal-active；
 *  - stale goal-active（Goal 已不在 active/paused）回到 assess-complexity；
 *  - 真实用户消息出现在非终态活动阶段时保留当前阶段，不重置为 assess-complexity；
 *  - 只有 idle/done/end/communication 等终态或未开始状态才进入 assess-complexity
 *    （Minimal 不再重复，由 round-minimal 按“会话第一次 tool/call”判定）。
 */
export function nextStageOnUserMessage(current, _turn, context = {}) {
  if (context?.goalActive === true) {
    // v0.9：Goal 激活期间外部模式为 goal-active，不重新开启 assess-complexity。
    return GOAL_ACTIVE_STAGE;
  }
  if (current === GOAL_ACTIVE_STAGE) {
    // 36.5 verification-gap follow-up：stale goal-active（无 active/paused goal）
    // 不应停留在失效的外部模式，恢复为重新进入 assess-complexity。
    return "assess-complexity";
  }
  if (
    current === "idle" ||
    current === "done" ||
    current === "end" ||
    current === "communication"
  ) {
    return "assess-complexity";
  }
  if (typeof current !== "string" || current.trim().length === 0) {
    return "assess-complexity";
  }
  // 非终态活动阶段（含 working-resumed；goal-active 仅在仍激活时由上方分支保持）。
  return current;
}

/** 检测 /goal 命令触发的消息：最后一个 turn/end 之后有成功的 command/run。
 *  返回 { commandId, name }；调用方负责消费（每个 commandId 只旁路一次）。
 *  v0.8 Step B1：/plan 已随原生 Plan 移除，不再识别。 */
export function manualCommandIdOf(agent) {
  try {
    const events = agent?.session?.events;
    if (!Array.isArray(events)) return null;
    let start = 0;
    for (let index = 0; index < events.length; index += 1) {
      if (events[index]?.type === "turn/end") start = index + 1;
    }
    let found = null;
    for (let index = start; index < events.length; index += 1) {
      const event = events[index];
      if (event === null || typeof event !== "object" || event.type !== "command/run") continue;
      const data = event.data;
      if (data === null || typeof data !== "object") continue;
      const name = data.name;
      if (typeof name !== "string" || !MANUAL_COMMAND_NAMES.includes(name)) continue;
      found = { commandId: data.commandId, name };
    }
    if (found === null) return null;
    const done = events.slice(start).some(
      (event) =>
        event !== null &&
        typeof event === "object" &&
        event.type === "command/done" &&
        event.data !== null &&
        typeof event.data === "object" &&
        event.data.commandId === found.commandId &&
        event.data.kind === "success",
    );
    return done ? found : null;
  } catch {
    return null;
  }
}

/** 提取 assembly.tools 里的工具名（去重、保留顺序）。 */
function toolNamesOf(tools) {
  const names = [];
  const seen = new Set();
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (tool === null || typeof tool !== "object") continue;
    const name = tool.name;
    if (typeof name !== "string" || name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

export default {
  name: "ka-whale-workflow",
  inject: ["systemPrompt", "tools", "timer"],
  apply(ctx, config = {}) {
    const entry = normalizeConfig(config);
    let source = () => entry;
    installSettingsWithDefaults(ctx, NAMESPACE, SETTINGS_SCHEMA, entry, DEFAULT_SECTION, {
      setSource: (getValue) => {
        source = () => normalizeConfig(getValue());
      },
      onChange: () => {
        const live = source();
        ctx.logger.info(
          `[ka-whale-workflow] 配置已热更新：enabled=${live.enabled}, includeSubagents=${live.includeSubagents}`,
        );
        handleChange();
      },
    });

    /** 阶段状态存储：插件自己的 JSON（config.stageStore 可覆盖，探针用临时文件）。
     *  绝不写会话事件——自定义事件会让 dsh 重载会话日志时拒绝整条日志。 */
    const stageStore = createStageStore(
      typeof config.stageStore === "string" && config.stageStore.trim().length > 0
        ? config.stageStore.trim()
        : defaultStageFile(),
    );

    /** v0.9 task plan 独立存储（config.taskPlanStore 可覆盖，探针用临时文件）。 */
    const taskPlanStore = createTaskPlanStore(
      typeof config.taskPlanStore === "string" && config.taskPlanStore.trim().length > 0
        ? config.taskPlanStore.trim()
        : KAZ_TASK_PLAN_STORE_PATH,
    );

    /** 生命周期参考文件实际路径（config.lifecyclePath 可覆盖，探针用临时文件）。 */
    const lifecycleReferencePath =
      typeof config.lifecyclePath === "string" && config.lifecyclePath.trim().length > 0
        ? config.lifecyclePath.trim()
        : KAZ_PRIVATE_PLUGIN_LIFECYCLE_PATH;

    // -----------------------------------------------------------------------
    // 终案 E：lifecycle / registry / audit 文件路径（config 覆盖仅供离线探针）。
    // -----------------------------------------------------------------------
    const lifecycleFile =
      typeof config.lifecycleFile === "string" && config.lifecycleFile.trim().length > 0
        ? config.lifecycleFile.trim()
        : defaultLifecycleFile();
    const lifecycleAuditFile =
      typeof config.lifecycleAuditFile === "string" && config.lifecycleAuditFile.trim().length > 0
        ? config.lifecycleAuditFile.trim()
        : defaultLifecycleAuditFile();
    const agentManagedRegistryFile =
      typeof config.agentManagedRegistryFile === "string" &&
      config.agentManagedRegistryFile.trim().length > 0
        ? config.agentManagedRegistryFile.trim()
        : defaultAgentManagedRegistryFile();
    const lifecycleBackupDir =
      typeof config.lifecycleBackupDir === "string" && config.lifecycleBackupDir.trim().length > 0
        ? config.lifecycleBackupDir.trim()
        : dirname(lifecycleFile);

    /** 读取并归一化 lifecycle JSON；缺失/损坏 → { ok:false }（feature off）。 */
    function readLifecycleData() {
      const fileResult = readJsonFileSafe(lifecycleFile);
      return normalizeSkillLifecycle(fileResult.ok === true ? fileResult.data : null);
    }

    /** 读取 agent-managed registry（缺失/损坏 → 空 registry）。 */
    function readRegistryData() {
      const fileResult = readJsonFileSafe(agentManagedRegistryFile);
      return normalizeAgentManagedRegistry(fileResult.ok === true ? fileResult.data : null);
    }

    /** 内存 lifecycle 副本（埋点先改内存，debounce 落盘，卸载前 flush）。 */
    const lifecycleMemory = {
      lifecycle: null,
      dirty: false,
      debounced: null,
    };

    function loadLifecycleMemory() {
      const result = readLifecycleData();
      lifecycleMemory.lifecycle = result.ok === true ? result.lifecycle : null;
      lifecycleMemory.dirty = false;
      return lifecycleMemory.lifecycle;
    }

    function persistLifecycleNow() {
      if (lifecycleMemory.lifecycle === null) return false;
      lifecycleMemory.lifecycle.updatedAt = new Date().toISOString();
      const write = writeJsonFileSafe(lifecycleFile, lifecycleMemory.lifecycle, {
        backupDir: lifecycleBackupDir,
      });
      if (write.ok === true) {
        lifecycleMemory.dirty = false;
        return true;
      }
      ctx.logger?.warn?.(
        `[ka-whale-workflow] lifecycle 落盘失败：${write.error ?? "unknown"} (${lifecycleFile})`,
      );
      return false;
    }

    function scheduleLifecyclePersist() {
      if (lifecycleMemory.lifecycle === null) return;
      lifecycleMemory.dirty = true;
      if (typeof ctx.debounce !== "function") {
        persistLifecycleNow();
        return;
      }
      if (lifecycleMemory.debounced !== null) return; // 已有待落盘任务
      const debounced = ctx.debounce(() => {
        lifecycleMemory.debounced = null;
        if (lifecycleMemory.dirty) persistLifecycleNow();
      }, 1500);
      lifecycleMemory.debounced = debounced;
      debounced();
    }
    /** 当前会话的鲸鱼工作流阶段（JSON 存储优先）。 */
    function stageOfAgent(agent) {
      return stageOf(agent, stageStore);
    }
    /** 推进鲸鱼工作流阶段（写 JSON 存储；不再 append 会话事件）。
     *  v0.9：进入 assess-complexity = 新 workflow-run 开始，清除旧契约状态，
     *  并记录该 run 的已进入 stage（pending injection 一次）。
     *  goal-active 是外部模式，也挂 pending 以便按边界注入 §3.1 文案。 */
    function setStageAgent(agent, stage) {
      const changed = setStage(agent, stage, stageStore);
      if (changed !== true) return changed;
      const sessionId = sessionIdOf(agent);
      if (typeof sessionId === "string" && sessionId.length > 0) {
        if (stage === "assess-complexity") {
          stageStore.removeContractState(sessionId);
          stageStore.beginWorkflowRun(sessionId);
        }
        if (V09_STAGE_IDS.includes(stage) || stage === GOAL_ACTIVE_STAGE) {
          stageStore.setPendingStageInjection(sessionId, stage);
          stageStore.addWorkflowRunStage(sessionId, stage);
        }
      }
      return changed;
    }

    /**
     * Goal 结束边界：当前 stage 是 goal-active 但 goals 服务已无 active/paused goal。
     * 把会话状态切到 working，并只挂 working-resumed 边界注入（不触发普通 working stage 注入）。
     * @returns {boolean} 是否发生该边界转换。
     */
    function transitionGoalActiveToWorkingResumed(agent) {
      const sessionId = sessionIdOf(agent);
      if (typeof sessionId !== "string" || sessionId.length === 0) return false;
      if (stageStore.get(sessionId) !== GOAL_ACTIVE_STAGE) return false;
      if (goalModeActive(agent)) return false;
      if (stageStore.set(sessionId, "working") !== true) return false;
      stageStore.setPendingStageInjection(sessionId, WORKING_RESUMED_STAGE);
      stageStore.addWorkflowRunStage(sessionId, WORKING_RESUMED_STAGE);
      reportRoundDisplay(agent, "Goal 已结束：等价于 working 结束，进入 working-resumed 边界。", "工作流切换", "goal-context");
      return true;
    }

    /** 生效配置 = kazMode.pluginConfig（完整）；服务缺失时回落到插件自身 settings.yaml。 */
    function liveFor(agent) {
      try {
        const svc = ctx.get("kazMode");
        if (svc !== undefined && svc !== null && typeof svc.pluginConfig === "function") {
          const cfg = svc.pluginConfig(agent, "ka-whale-workflow");
          if (cfg !== null && cfg !== undefined && typeof cfg === "object") return cfg;
        }
      } catch {
        // fall through
      }
      return source();
    }

    /** 是否处于 round-minimal 极简阶段（服务缺失按 false 处理）。 */
    function isMinimal(agent) {
      try {
        const rm = ctx.get("roundMinimal");
        if (rm !== undefined && rm !== null && typeof rm.isMinimal === "function") {
          return rm.isMinimal(agent) === true;
        }
      } catch {
        // fall through
      }
      return false;
    }

    /** 该 agent 会话是否处于 goal 模式（active/paused；与 kaz-mode 同源）。 */
    function goalModeActive(agent) {
      try {
        return goalModeActiveOf(agent, ctx.get("goals"));
      } catch {
        return false;
      }
    }

    /** 受控 v0.9 子代理检测：stageStore.subagentRoles 中存在该 session 的角色记录。
     *  这类子代理即使 includeSubagents=false 也必须走 ka-whale-workflow。 */
    function controlledSubagentRoleOfAgent(agent) {
      if (agent === null || agent === undefined || typeof agent !== "object") return null;
      const sessionId = sessionIdOf(agent);
      if (typeof sessionId !== "string" || sessionId.length === 0) return null;
      try {
        const record = stageStore.getSubagentRole(sessionId);
        return record !== null && V09_SUBAGENT_ROLES.includes(record.persona)
          ? record.persona
          : null;
      } catch {
        return null;
      }
    }

    /** 受控 v0.9 子代理 idle 时初始化其 role 专属首阶段：
     *  worker=assess-complexity；memoryMaintainer/pluginMaintainer/pluginCreator=assess-delegation。 */
    function ensureControlledSubagentStarted(agent) {
      const role = controlledSubagentRoleOfAgent(agent);
      if (role === null) return null;
      if (liveFor(agent).enabled !== true) return role;
      const current = stageOfAgent(agent);
      const initial = V09_SUBAGENT_ROLE_INITIAL_STAGES[role] ?? null;
      if (initial === null) return role;
      const alreadyInRoleFlow =
        current !== "idle" &&
        current !== "done" &&
        current !== "end" &&
        stageDefinitionFor(role, current) !== null;
      if (alreadyInRoleFlow) return role;
      if (setStageAgent(agent, initial)) {
        reportRoundDisplay(agent, `受控 ${role} 子代理进入 ${initial}。`, "阶段切换");
      }
      return role;
    }

    /** 终案 E：全自动 Skill 生命周期生效配置（总开关 + 阈值；max 恒钳制到 1）。 */
    function skillLifecycleFor(agent) {
      const current = liveFor(agent);
      const intDefault = (rawValue, fallback) =>
        Number.isInteger(rawValue) && rawValue >= 1 ? rawValue : fallback;
      return {
        enabled: current?.enabled !== false && current?.skillAutoLifecycleEnabled !== false,
        unusedDays: intDefault(current?.skillLifecycleUnusedDays, 60),
        pendingDays: intDefault(current?.skillLifecyclePendingDays, 7),
        auditIntervalHours: intDefault(current?.skillLifecycleAuditIntervalHours, 24),
        maxAutoActions: 1,
      };
    }

    /** 私有技能根目录：配置 skillPrivateRoot 优先；空时回退到 DSH_HOME/profiles/web/KazPrivatePlugins。 */
    function skillPrivateRootOf(agent) {
      const configured = liveFor(agent)?.skillPrivateRoot;
      if (typeof configured === "string" && configured.trim().length > 0) return configured.trim();
      return join(
        process.env.DSH_HOME || join(homedir(), ".dsh"),
        "profiles",
        "web",
        SKILL_PRIVATE_DIR_NAME,
      );
    }

    /** 私有过程文档目录：KazPrivatePlugins/process。 */
    function skillProcessFolderOf(agent) {
      return join(skillPrivateRootOf(agent), SKILL_PROCESS_DIR_NAME);
    }

    // -----------------------------------------------------------------------
    // 终案 E：lifecycle 执行器（内部，不注册任何用户可见工具）。
    // -----------------------------------------------------------------------

    /** 追加一行机器审计 JSONL（只追加，不覆盖）。 */
    function appendLifecycleAudit(entry) {
      try {
        mkdirSync(dirname(lifecycleAuditFile), { recursive: true });
        appendFileSync(lifecycleAuditFile, JSON.stringify(entry) + String.fromCharCode(10), "utf8");
      } catch (error) {
        ctx.logger?.warn?.(
          `[ka-whale-workflow] lifecycle audit 追加失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    /** 依据 record 的 manifestRel/switchRel（相对 KazPrivatePlugins 根）解析绝对路径。 */
    function lifecycleRelFile(agent, rel) {
      if (typeof rel !== "string" || rel.trim().length === 0) return null;
      return join(skillPrivateRootOf(agent), rel.trim());
    }

    /** 写 lifecycle 文件（安全 JSON 写：无 BOM + 备份 + temp rename）。 */
    function writeLifecycleFile(lifecycle) {
      lifecycle.updatedAt = new Date().toISOString();
      return writeJsonFileSafe(lifecycleFile, lifecycle, { backupDir: lifecycleBackupDir });
    }

    /** 写 registry 投影文件（不改 schema：version + plugins.agentManaged/tools）。 */
    function writeRegistryFile(registry) {
      return writeJsonFileSafe(agentManagedRegistryFile, registry, { backupDir: lifecycleBackupDir });
    }

    /** 写技能本地 switch/manifest（同步执行硬开关与记录）。 */
    function writeSkillSideEffect(agent, rel, kind, payload) {
      if (rel === null) return null;
      const file = lifecycleRelFile(agent, rel);
      if (file === null) return null;
      try {
        if (kind === "switch") {
          return writeJsonFileSafe(file, { enabled: payload.enabled === true }, { backupDir: lifecycleBackupDir });
        }
        if (kind === "manifest") {
          const current = readJsonFileSafe(file);
          const old = current.ok === true && current.data !== null && typeof current.data === "object" ? current.data : {};
          return writeJsonFileSafe(
            file,
            { ...old, ...payload, version: payload.version ?? old.version ?? "0.0.0", status: payload.status ?? old.status ?? "active" },
            { backupDir: lifecycleBackupDir },
          );
        }
      } catch (error) {
        ctx.logger?.warn?.(
          `[ka-whale-workflow] 写技能本地 ${kind} 失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return null;
    }

    /**
     * 应用单个审计动作（已先由 auditSkillLifecycle 产出；此处再校验状态机）。
     * 返回 { ok, action, backups, note }；任何写失败 → ok:false（调用方记审计并停止本轮）。
     */
    function applyLifecycleAction(action, lifecycle, registry, agent, source, nowIso) {
      const now = nowIso;
      const nextLifecycle = JSON.parse(JSON.stringify(lifecycle));
      const nextRegistry = JSON.parse(JSON.stringify(registry));
      const backups = [];
      const recordKey = action.key;
      let oldRecord = nextLifecycle.skills[recordKey] ?? null;
      let changedLifecycle = false;
      let changedRegistry = false;
      const sideEffects = [];

      const setRecord = (record) => {
        nextLifecycle.skills[recordKey] = record;
        oldRecord = record;
        changedLifecycle = true;
        record.audit = {
          lastAction: action.type,
          lastActionAt: now,
          actionCount: (Number.isInteger(record.audit?.actionCount) ? record.audit.actionCount : 0) + 1,
        };
      };

      if (action.type === "bootstrap-active") {
        const record = createLifecycleRecord(action.plugin, action.tool, now);
        setRecord(record);
      } else if (action.type === "retire-pending") {
        if (oldRecord === null || !transitionAllowed(oldRecord.status, "retire-pending")) {
          return { ok: false, action, backups, note: "retire-pending transition rejected" };
        }
        setRecord({
          ...oldRecord,
          status: "retire-pending",
          statusChangedAt: now,
          retire: { reason: action.reason ?? "idle", pendingAt: now, confirmedAt: null },
        });
      } else if (action.type === "retire") {
        if (oldRecord === null || !transitionAllowed(oldRecord.status, "retired")) {
          return { ok: false, action, backups, note: "retire transition rejected" };
        }
        setRecord({
          ...oldRecord,
          status: "retired",
          statusChangedAt: now,
          retire: {
            ...oldRecord.retire,
            reason: oldRecord.retire?.reason ?? action.reason ?? "idle",
            confirmedAt: now,
          },
        });
        sideEffects.push({ rel: oldRecord.switchRel, kind: "switch", payload: { enabled: false } });
        sideEffects.push({ rel: oldRecord.manifestRel, kind: "manifest", payload: { status: "retired" } });
      } else if (action.type === "reactivate") {
        if (oldRecord === null || !transitionAllowed(oldRecord.status, "active")) {
          return { ok: false, action, backups, note: "reactivate transition rejected" };
        }
        setRecord({
          ...oldRecord,
          status: "active",
          statusChangedAt: now,
          retire: { reason: null, pendingAt: null, confirmedAt: null },
        });
        sideEffects.push({ rel: oldRecord.switchRel, kind: "switch", payload: { enabled: true } });
        sideEffects.push({ rel: oldRecord.manifestRel, kind: "manifest", payload: { status: "active" } });
      } else if (action.type === "update-needed") {
        if (oldRecord === null || !transitionAllowed(oldRecord.status, "update-needed")) {
          return { ok: false, action, backups, note: "update-needed transition rejected" };
        }
        setRecord({
          ...oldRecord,
          status: "update-needed",
          statusChangedAt: now,
          update: { ...oldRecord.update, state: "needed" },
        });
      } else if (action.type === "commit-update") {
        if (oldRecord === null || !transitionAllowed(oldRecord.status, "active")) {
          return { ok: false, action, backups, note: "commit-update transition rejected" };
        }
        const stagedVersion =
          typeof oldRecord.update?.stagedVersion === "string" && oldRecord.update.stagedVersion.length > 0
            ? oldRecord.update.stagedVersion
            : oldRecord.version;
        setRecord({
          ...oldRecord,
          status: "active",
          statusChangedAt: now,
          version: stagedVersion,
          update: { state: "none", evidence: [], patchRef: null, stagedVersion: null },
        });
        sideEffects.push({ rel: oldRecord.manifestRel, kind: "manifest", payload: { status: "active", version: stagedVersion } });
      } else if (action.type === "reconcile-registry") {
        changedLifecycle = false;
        if (oldRecord === null) {
          // registry 含但 lifecycle 缺的动作由 bootstrap-active 处理；此处不应发生。
          return { ok: false, action, backups, note: "reconcile without lifecycle record" };
        }
      } else {
        return { ok: false, action, backups, note: `unknown action type ${action.type}` };
      }

      // registry 投影：retire / reactivate / bootstrap / reconcile 都要求 registry 与意图一致。
      const projected = projectRegistryFromLifecycle(nextLifecycle, registry);
      const beforeRegistryJson = JSON.stringify(nextRegistry);
      const afterRegistryJson = JSON.stringify(projected);
      if (beforeRegistryJson !== afterRegistryJson) {
        nextRegistry.plugins = projected.plugins;
        nextRegistry.version = projected.version;
        changedRegistry = true;
      }

      if (changedLifecycle) {
        const write = writeLifecycleFile(nextLifecycle);
        if (write.ok !== true) {
          return { ok: false, action, backups, note: `lifecycle write failed: ${write.error ?? "unknown"}` };
        }
        if (write.backup !== null) backups.push(write.backup);
      }
      if (changedRegistry) {
        const write = writeRegistryFile(nextRegistry);
        if (write.ok !== true) {
          return { ok: false, action, backups, note: `registry write failed: ${write.error ?? "unknown"}` };
        }
        if (write.backup !== null) backups.push(write.backup);
      }
      for (const side of sideEffects) {
        const write = writeSkillSideEffect(agent, side.rel, side.kind, side.payload);
        if (write !== null && write.ok !== true) {
          return { ok: false, action, backups, note: `skill ${side.kind} write failed: ${write.error ?? "unknown"}` };
        }
        if (write !== null && write.backup !== null) backups.push(write.backup);
      }
      return { ok: true, action, backups, note: action.reason ?? action.type };
    }

    /** 终案 E 审计入口：dryRun 只返回建议；真实执行 ≤ maxAutoActions（恒 1）。 */
    let lifecycleBusy = false;
    function runLifecycleAudit({ source = "manual", agent = null, dryRun = false } = {}) {
      if (lifecycleBusy) {
        return { ok: false, busy: true, dryRun, actions: [], suggested: [], executed: [] };
      }
      const cfg = skillLifecycleFor(agent);
      if (cfg.enabled !== true) {
        return { ok: false, disabled: true, dryRun, actions: [], suggested: [], executed: [] };
      }
      lifecycleBusy = true;
      try {
        const lifecycleResult = readLifecycleData();
        if (lifecycleResult.ok !== true) {
          return { ok: false, featureOff: true, dryRun, actions: [], suggested: [], executed: [] };
        }
        const lifecycle = lifecycleResult.lifecycle;
        const registry = readRegistryData();
        const nowIso = new Date().toISOString();
        const patchExists = (key) => {
          const record = lifecycle.skills[key];
          const ref = record?.update?.patchRef;
          if (typeof ref !== "string" || ref.trim().length === 0) return false;
          const candidate = join(skillPrivateRootOf(agent), ref.trim());
          return existsSync(candidate);
        };
        const suggested = auditSkillLifecycle(lifecycle, registry, nowIso, { patchExists });
        if (dryRun) {
          return { ok: true, dryRun: true, actions: suggested, suggested, executed: [] };
        }
        const chosen = suggested.slice(0, cfg.maxAutoActions);
        const executed = [];
        for (const action of chosen) {
          const applied = applyLifecycleAction(action, lifecycle, registry, agent, source, nowIso);
          if (applied.ok !== true) {
            appendLifecycleAudit({
              at: nowIso,
              source,
              action: action.type,
              skillKey: action.key,
              ok: false,
              note: applied.note ?? "apply failed",
              backups: applied.backups ?? [],
              lifecycleFile,
              registryFile: agentManagedRegistryFile,
            });
            return { ok: false, dryRun: false, actions: [action], suggested, executed, error: applied.note };
          }
          executed.push(action);
          // 执行器直接写文件后，把内存副本重新同步（避免旧内存覆盖新状态）。
          const synced = readLifecycleData();
          if (synced.ok === true) {
            lifecycleMemory.lifecycle = synced.lifecycle;
            lifecycleMemory.dirty = false;
          }
          appendLifecycleAudit({
            at: nowIso,
            source,
            action: action.type,
            skillKey: action.key,
            plugin: action.plugin,
            tool: action.tool,
            from: action.from,
            to: action.to,
            ok: true,
            note: applied.note ?? "",
            backups: applied.backups ?? [],
            lifecycleFile,
            registryFile: agentManagedRegistryFile,
            rollback: applied.backups.length > 0 ? `Copy-Item '${applied.backups.join("', '")}' back to original paths` : "no backup created",
          });
        }
        return { ok: true, dryRun: false, actions: chosen, suggested, executed };
      } finally {
        lifecycleBusy = false;
      }
    }

    /** tools/result 埋点：只统计顶层调用、agent-managed/lifecycle 登记工具；内存更新 + debounce。 */
    function recordToolUse(exec, result) {
      const event = skillToolUseEvent(exec, result);
      if (event === null) return false;
      const cfg = skillLifecycleFor(exec?.agent);
      if (cfg.enabled !== true) return false;
      let lifecycle = lifecycleMemory.lifecycle;
      if (lifecycle === null) {
        lifecycle = loadLifecycleMemory();
        if (lifecycle === null) return false;
      }
      const registry = readRegistryData();
      let foundKey = null;
      for (const [plugin, entry] of Object.entries(registry.plugins)) {
        if (!entry.tools.includes(event.name)) continue;
        const key = skillKeyOf(plugin, event.name);
        if (key.length > 0 && Object.prototype.hasOwnProperty.call(lifecycle.skills, key)) {
          foundKey = key;
          break;
        }
      }
      if (foundKey === null) return false;
      const nowIso = new Date().toISOString();
      const updated = applySkillToolUse(lifecycle.skills[foundKey], result, nowIso);
      if (updated === null) return false;
      lifecycle.skills[foundKey] = updated;
      lifecycle.updatedAt = nowIso;
      scheduleLifecyclePersist();
      return true;
    }

    /** v0.8 Step A：主/子流程上下文文案（按代理类型选择；不再按 stage 渲染工具清单）。 */
    function flowTextFor(agent) {
      return isSubagent(agent) ? SUBAGENT_FLOW_TEXT : MAIN_FLOW_TEXT;
    }

    /** 尝试把本插件给模型发送的信息上报给 round-display（best-effort）。
     *  v0.9 B6：只给白名单类别显式 category；阶段切换/whale_report 噪音不带
     *  category，由 round-display 统一过滤。 */
    function reportRoundDisplay(agent, content, title, category) {
      try {
        const rd = ctx.get("roundDisplay");
        if (rd !== undefined && rd !== null && typeof rd.report === "function" && typeof content === "string" && content.trim().length > 0) {
          rd.report({
            agent,
            plugin: "ka-whale-workflow",
            title: title || "工作流",
            content,
            ...(typeof category === "string" && category.trim().length > 0 ? { category: category.trim() } : {}),
          });
        }
      } catch (error) {
        ctx.logger?.debug?.(`[ka-whale-workflow] 上报 round-display 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    /**
     * C15 / 描述v0.4 §9.3：mode='goal' 的统一启动/恢复逻辑。
     *  - 无 goal 或 phase=complete → goals.create（必须给 objective）；
     *  - 已存在非 complete goal → 直接人类回合且轮次未耗尽时 goals.resume；
     *    轮次耗尽 / 想换目标 → 结构化拒绝，绝不静默 create/edit/clear。
     */
    function launchGoalMode(agent, goals, args) {
      if (goals === undefined || goals === null || typeof goals.get !== "function" || typeof goals.create !== "function") {
        throw new Error("goals service is unavailable; cannot start or resume goal");
      }
      const objective = typeof args?.objective === "string" ? args.objective.trim() : "";
      const existing = currentGoalOf(agent, goals);
      if (existing === null || existing.phase === "complete") {
        if (objective.length === 0) {
          throw new Error("whale_report mode=goal requires an objective when creating a new goal");
        }
        goals.create(agent, {
          objective,
          ...(typeof args?.max_goal_rounds === "number" && Number.isInteger(args.max_goal_rounds) && args.max_goal_rounds > 0
            ? { maxGoalRounds: args.max_goal_rounds }
            : {}),
        });
        return;
      }
      if (typeof goals.resume !== "function") {
        throw new Error("goals service cannot resume an existing goal (resume is unavailable)");
      }
      const ref = { id: existing.id, revision: existing.revision };
      const roundsStarted = Number.isSafeInteger(existing.roundsStarted) ? existing.roundsStarted : 0;
      const maxGoalRounds = Number.isSafeInteger(existing.maxGoalRounds) ? existing.maxGoalRounds : 1;
      if (objective.length > 0 && objective !== existing.objective) {
        throw new Error(
          `cannot create a new goal while a non-complete goal already exists (phase=${existing.phase}); ` +
            `complete/clear the current goal first. To continue the existing goal, call whale_report({mode:'goal'}) without a new objective.`,
        );
      }
      // v0.8 Step A / active-armed no-op：Goal 已在 active+armed 时无需 resume；
      // 防止“已自动续跑”的 paused goal 重复 resume 报错。
      if (existing.phase === "active" && existing.activation === "armed") {
        return;
      }
      if (!hasDirectHumanInOpenTurn(agent)) {
        throw new Error("whale_report mode=goal cannot resume an existing goal without a direct human turn on a top-level agent");
      }
      if (roundsStarted >= maxGoalRounds) {
        throw new Error(
          `goal "${existing.id}" has exhausted ${roundsStarted}/${maxGoalRounds} goal rounds; ` +
            `raise maxGoalRounds (e.g. /goal edit) and then resume, or complete/clear it before creating a new goal.`,
        );
      }
      goals.resume(agent, ref);
    }

    // -----------------------------------------------------------------------
    // whale_report 工具：v0.9 主模型 stage 推进与 task plan 持久化。
    // -----------------------------------------------------------------------
    const whaleReportDef = defineTool({
      name: WHALE_REPORT_TOOL,
      description:
        "Report v0.9 workflow bookkeeping or mode to ka-whale-workflow. Use whale_report to advance to a legal next stage. Pass nextStage to select the target stage. In decide-tools pass draftPlanItems for first (draft) task-plan persistence; in plugin-preflight pass finalPlanPayload containing only pluginCreator items for pre-finalization; in write-plan pass finalPlanPayload with status finalized for full second persistence. Pass mode='goal' to create/resume a Goal; that enters goal-active from decide-goal. While goal-active, ordinary stage progression is suspended, so whale_report only accepts mode='goal'.",
      parameters: {
        mode: {
          type: "string",
          description:
            "'normal' (default) for non-goal bookkeeping; 'goal' creates a new Goal or resumes a non-complete one through whale_report and enters goal-active. During goal continuation, pass 'goal' only when a resume is required; omit mode only when starting a new task.",
        },
        nextStage: {
          type: "string",
          description:
            "Legal main-model next stage id from the current stage's Can advance to list, e.g. challenge-plan, communication, decide-tools, plugin-preflight, write-plan, decide-goal, working, goal-active, memory-maintenance, plugin-maintenance. In decide-tools/write-plan/plugin-preflight it may be omitted when the payload implies the only/default transition.",
        },
        objective: {
          type: "string",
          description: "Required when mode='goal' creates a new goal (no current goal or current phase=complete). When a non-complete goal exists, omit objective to resume it; passing a different objective is rejected with guidance instead of silently creating a new goal.",
        },
        max_goal_rounds: {
          type: "number",
          description: "Optional positive integer for mode='goal': automatic continuation round cap.",
        },
        draftPlanItems: {
          type: "array",
          items: { type: "json" },
          description: "Used in decide-tools: array of { planItemId, persona, task, assignedTools } to persist as draft task plan items (first persistence).",
        },
        finalPlanPayload: {
          type: "json",
          description: "Used in plugin-preflight: { items: [{ planItemId, persona: 'pluginCreator', task, assignedTools }] } to pre-finalize only pluginCreator items. Used in write-plan: { status: 'finalized', items: [...] } to persist/finalize the complete task plan (second persistence).",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            stage: { type: "string", required: true },
            restarted: { type: "boolean", required: true },
            warning: { type: "string" },
          },
        },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const agent = exec?.agent;
        if (agent === null || agent === undefined || typeof agent !== "object") {
          return Promise.reject(new Error("whale_report requires a calling agent"));
        }
        const current = stageOfAgent(agent);
        if (current === GOAL_ACTIVE_STAGE) {
          // goal-active 是外部模式：不允许 whale_report 推进普通 stage。
          if (args?.mode !== "goal") {
            const reason =
              `workflow-stage-deny: whale_report cannot advance ordinary stages from "${current}". ` +
              `Goal is active; ka-whale-workflow ordinary stage progression is suspended. ` +
              `Use get_goal/update_goal per official Goal rules, or wait for Goal to end.`;
            return Promise.reject(new Error(reason));
          }
          try {
            await launchGoalMode(agent, ctx.get("goals"), args);
          } catch (error) {
            return Promise.reject(error instanceof Error ? error : new Error(String(error)));
          }
          return Promise.resolve({ ok: true, stage: GOAL_ACTIVE_STAGE, restarted: false });
        }
        if (!isMainWorkflowStage(current)) {
          // 非 v0.9 主 stage（idle/done/end 等状态壳）：只接受明确 goal 启动/恢复入口。
          if (args?.mode === "goal") {
            try {
              await launchGoalMode(agent, ctx.get("goals"), args);
            } catch (error) {
              return Promise.reject(error instanceof Error ? error : new Error(String(error)));
            }
            setStageAgent(agent, GOAL_ACTIVE_STAGE);
            return Promise.resolve({ ok: true, stage: GOAL_ACTIVE_STAGE, restarted: false });
          }
          const def = stageDefinitionFor(MAIN_ROLE, "assess-complexity");
          const reason =
            `workflow-stage-deny: whale_report cannot advance from outside the v0.9 main stage machine ` +
            `(current="${current}"). Current allowed tools: ${def.allowedTools.join(", ")}. ` +
            `Suggested: start a new task through assess-complexity or resume an existing Goal with mode='goal'.`;
          return Promise.reject(new Error(reason));
        }

        // v0.9 task plan persistence stage guards.
        // challenge-plan / decide-tools cannot write or finalize task plans outside
        // their own persistence stages; plugin-preflight only pre-finalizes pluginCreator.
        const hasDraftPlanItems = Array.isArray(args?.draftPlanItems);
        const hasFinalPlanPayload =
          args?.finalPlanPayload !== null && args?.finalPlanPayload !== undefined;
        if (hasDraftPlanItems && current !== "decide-tools") {
          return Promise.reject(
            new Error(
              `workflow-stage-deny: draftPlanItems can only be persisted in decide-tools (current="${current}"). ` +
                `Writing/finalizing task plans here is not allowed.`,
            ),
          );
        }
        if (hasFinalPlanPayload && current !== "write-plan" && current !== "plugin-preflight") {
          return Promise.reject(
            new Error(
              `workflow-stage-deny: finalPlanPayload can only be used in write-plan or plugin-preflight (current="${current}"). ` +
                `Writing/finalizing task plans here is not allowed.`,
            ),
          );
        }
        if (current === "decide-tools" && hasDraftPlanItems) {
          const persisted = taskPlanStore.persistDraftItems(args.draftPlanItems);
          if (persisted.ok !== true) {
            return Promise.reject(new Error("whale_report failed to persist draft task plan items; task plan store write failed."));
          }
        }
        if (current === "plugin-preflight") {
          const payload = args?.finalPlanPayload;
          if (payload === null || payload === undefined || typeof payload !== "object") {
            const def = stageDefinitionFor(MAIN_ROLE, "plugin-preflight");
            return Promise.reject(
              new Error(
                `workflow-stage-deny: plugin-preflight requires whale_report(finalPlanPayload) with only persona=pluginCreator items to pre-finalize; ` +
                  `current allowed tools: [${def.allowedTools.join(", ")}].`,
              ),
            );
          }
          const items = Array.isArray(payload.items) ? payload.items : [];
          const hasNonPluginCreator = items.some(
            (item) => item === null || typeof item !== "object" || item.persona !== "pluginCreator",
          );
          if (items.length === 0 || hasNonPluginCreator) {
            return Promise.reject(
              new Error(
                "workflow-stage-deny: plugin-preflight accepts finalPlanPayload only when every item has persona=pluginCreator; other personas must be finalized later in write-plan.",
              ),
            );
          }
          const persisted = taskPlanStore.persistFinalPayload(payload);
          if (persisted.ok !== true) {
            return Promise.reject(new Error("whale_report failed to persist pluginCreator pre-finalization; task plan store write failed."));
          }
        }
        if (current === "write-plan") {
          const payload = args?.finalPlanPayload;
          if (payload === null || payload === undefined || typeof payload !== "object") {
            const def = stageDefinitionFor(MAIN_ROLE, "write-plan");
            return Promise.reject(
              new Error(
                `workflow-stage-deny: write-plan requires whale_report(finalPlanPayload) with { status: 'finalized', items: [...] }; ` +
                  `current allowed tools: [${def.allowedTools.join(", ")}].`,
              ),
            );
          }
          const persisted = taskPlanStore.persistFinalPayload(payload);
          if (persisted.ok !== true) {
            return Promise.reject(new Error("whale_report failed to persist finalized task plan; task plan store write failed."));
          }
        }

        const def = stageDefinitionFor(MAIN_ROLE, current);
        const defaultNext =
          current === "assess-complexity" || current === "communication"
            ? null
            : current === "challenge-plan"
              ? "decide-tools"
              : current === "decide-tools"
                ? "write-plan"
                : current === "plugin-preflight"
                  ? "decide-tools"
                  : current === "write-plan"
                    ? "decide-goal"
                    : current === "decide-goal"
                      ? args?.mode === "goal"
                        ? GOAL_ACTIVE_STAGE
                        : "working"
                      : current === "working"
                        ? "memory-maintenance"
                        : "communication";
        const requested =
          typeof args?.nextStage === "string" && args.nextStage.trim().length > 0
            ? args.nextStage.trim()
            : null;
        // mode='goal' from decide-goal always enters goal-active (v0.9 §3.2); the
        // explicit nextStage is kept for the normal/default path.
        const target =
          current === "decide-goal" && args?.mode === "goal"
            ? GOAL_ACTIVE_STAGE
            : requested !== null
              ? requested
              : defaultNext;

        if (target === null || !canAdvance(MAIN_ROLE, current, target)) {
          const reason =
            `workflow-stage-deny: whale_report cannot advance from "${current}" to "${String(target)}". ` +
            `Current allowed tools: [${def.allowedTools.join(", ")}]. Can advance to: [${def.canAdvance.join(", ")}]. ` +
            `Suggested: call whale_report with a legal nextStage from the Can advance to list.`;
          return Promise.reject(new Error(reason));
        }

        if (args?.mode === "goal") {
          try {
            await launchGoalMode(agent, ctx.get("goals"), args);
          } catch (error) {
            return Promise.reject(error instanceof Error ? error : new Error(String(error)));
          }
        }
        if (target !== "end") {
          setStageAgent(agent, target);
        } else {
          setStageAgent(agent, "done");
        }
        reportRoundDisplay(
          agent,
          `whale_report：${current} → ${target}（mode=${args?.mode ?? "normal"}）`,
          "鲸鱼工作流",
        );
        return Promise.resolve({ ok: true, stage: target === "end" ? "done" : target, restarted: false });
      },
      presentCall: () => ({ card: "generic", title: "鲸鱼工作流汇报", kind: "other" }),
    });

    // -----------------------------------------------------------------------
    // ka_sub_whale：v0.9 B3 受控委派层。
    // 模型只能传 planItemId；persona/task/assignedTools/toolFilter 全部由
    // 已 finalized task plan + role Stable Surface 计算，再经
    // ctx.subagents.startContinuable 创建 continuable child。
    // -----------------------------------------------------------------------
    const kaSubWhaleDef = defineTool({
      name: KA_SUB_WHALE_TOOL,
      description:
        "Kaz controlled delegation tool: create a continuable subagent from a finalized task-plan planItemId. The persona, task, and assignedTools are bound from the persisted task plan; pass only planItemId. Draft, missing, or not-yet-persisted ids are rejected with a structured refusal. After a successful start, the subagent runs asynchronously: end the current turn and await its report/finished message; do not use pwsh sleep or poll list_agents, and list_agents/send_message are not wait primitives.",
      parameters: {
        planItemId: {
          type: "string",
          required: true,
          description: "planItemId of a finalized item in the persisted task plan.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            code: { type: "string" },
            reason: { type: "string" },
            status: { type: "string" },
            planItemId: { type: "string" },
            persona: { type: "string" },
            task: { type: "string" },
            assignedTools: { type: "array", items: { type: "string" } },
            finalSurface: { type: "array", items: { type: "string" } },
            subagentId: { type: "string" },
            notice: { type: "string" },
            warning: { type: "string" },
          },
        },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const agent = exec?.agent;
        if (agent === null || agent === undefined || typeof agent !== "object") {
          return Promise.resolve({
            ok: false,
            code: "agent-unavailable",
            reason: "ka_sub_whale requires a calling agent.",
          });
        }
        // R-B3-7 单层委派：子代理不能通过 ka_sub_whale 创建带工具的新子代理。
        if (isSubagent(agent)) {
          return Promise.resolve({
            ok: false,
            code: "subagent-delegation-denied",
            reason: "ka_sub_whale is available only to the main agent; subagents cannot create further delegated subagents.",
          });
        }
        const resolved = resolvePlanItemForDelegation(taskPlanStore, args?.planItemId);
        if (resolved.ok !== true) {
          return Promise.resolve({
            ok: false,
            code: resolved.code,
            reason: resolved.reason,
          });
        }
        const item = resolved.item;
        if (item.persona === "main") {
          // 36.5：persona=main plan items are executed by the main line, not delegated.
          return Promise.resolve({
            ok: false,
            code: "main-persona-delegation-denied",
            reason: `ka_sub_whale rejected plan item "${item.planItemId}": persona=main plan items are executed by the main line and must not be delegated via ka_sub_whale.`,
          });
        }
        const role = normalizeV09Role(item.persona);
        if (role === null) {
          return Promise.resolve({
            ok: false,
            code: "unknown-v09-role",
            reason: `ka_sub_whale rejected plan item "${item.planItemId}": persona "${item.persona}" is not in the v0.9 role set.`,
          });
        }
        // 36.8 stage-persona mapping enforcement:
        //   plugin-preflight → pluginCreator; working → worker;
        //   memory-maintenance → memoryMaintainer; plugin-maintenance → pluginMaintainer.
        const currentStage = stageOfAgent(agent);
        const expectedPersona = V09_KA_SUB_WHALE_STAGE_PERSONAS[currentStage];
        if (expectedPersona !== undefined && role !== expectedPersona) {
          return Promise.resolve({
            ok: false,
            code: "stage-persona-mismatch",
            reason: `ka_sub_whale rejected plan item "${item.planItemId}" in ${currentStage}: persona "${role}" does not match the only delegable persona "${expectedPersona}" for this stage. Working delegates only worker; memory-maintenance only memoryMaintainer; plugin-maintenance only pluginMaintainer; plugin-preflight only pluginCreator.`,
          });
        }

        // R-B3-4/R-B3-5：assignedTools 来源 + 数量护栏。
        const registryResult = readJsonFileSafe(agentManagedRegistryFile);
        const candidateRegistry = normalizeAgentManagedCandidateRegistry(
          registryResult.ok === true ? registryResult.data : null,
        );
        const assignedValidation = resolveV09AssignedTools({
          role,
          assignedTools: item.assignedTools,
          candidateRegistry,
        });
        if (assignedValidation.ok !== true) {
          return Promise.resolve({
            ok: false,
            code: assignedValidation.code,
            reason: assignedValidation.reason,
          });
        }

        // R-B3-6/R-B3-9：最终角色面 = role Stable Base + assignedTools。
        const finalSurface = computeV09FinalSurface({
          role,
          assignedTools: assignedValidation.tools,
        });

        const subagents = ctx.get("subagents");
        if (
          subagents === undefined ||
          subagents === null ||
          typeof subagents.startContinuable !== "function"
        ) {
          return Promise.resolve({
            ok: false,
            code: "subagent-service-unavailable",
            reason:
              "ka_sub_whale cannot create a subagent: DSH continuable subagent service is not present. Add @deepseek-ai/dsh-tool-subagent-report/subagent providers and restart.",
          });
        }

        const personaText = V09_ROLE_PERSONAS[role] ?? role;
        const lifecycleNote =
          role === "pluginMaintainer" || role === "pluginCreator"
            ? `\n\nlifecyclePath: ${lifecycleReferencePath}`
            : "";
        const promptText = `${item.task}${lifecycleNote}`;
        try {
          const started = await subagents.startContinuable({
            provider: "spawn",
            label: `kaz:${role}:${item.planItemId}`,
            request: {
              label: item.planItemId,
              prompt: [{ type: "text", text: promptText }],
              parent: agent,
              persona: personaText,
              toolFilter: { allow: finalSurface },
              maxDepth: 1,
            },
            signal: exec.signal,
          });
          const subagentId =
            started !== null && typeof started === "object" && typeof started.childId === "string"
              ? started.childId
              : "";
          if (subagentId.length === 0) {
            return Promise.resolve({
              ok: false,
              code: "subagent-start-failed",
              reason: "ka_sub_whale started a continuable child but no subagentId was returned.",
            });
          }
          const now = new Date().toISOString();
          stageStore.setSubagentRole(subagentId, {
            planItemId: item.planItemId,
            persona: role,
            assignedTools: assignedValidation.tools,
            finalTools: finalSurface,
            createdAt: now,
            updatedAt: now,
          });
          reportRoundDisplay(
            agent,
            `ka_sub_whale created ${role} subagent ${subagentId} for plan item ${item.planItemId}.`,
            "受控委派",
          );
          return Promise.resolve({
            ok: true,
            code: "subagent-created",
            status: "created",
            planItemId: item.planItemId,
            persona: role,
            task: item.task,
            assignedTools: assignedValidation.tools,
            finalSurface,
            subagentId,
            notice:
              "Subagent started asynchronously. End the current turn and await its report/finished message; do not use pwsh sleep or poll list_agents, and list_agents/send_message are not wait primitives.",
            ...(typeof assignedValidation.warning === "string" && assignedValidation.warning.length > 0
              ? { warning: assignedValidation.warning }
              : {}),
          });
        } catch (error) {
          return Promise.resolve({
            ok: false,
            code: "subagent-start-failed",
            reason: `ka_sub_whale could not start subagent: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      },
      presentCall: () => ({ card: "generic", title: "受控委派 ka_sub_whale", kind: "other" }),
    });

    // -----------------------------------------------------------------------
    // *_sub_whale_report：子代理作用域的 v0.9 report 包装。
    // 它同时具备两个能力：
    //   1) 与主模型 whale_report 相同的“推进本角色 workflow”能力（nextStage）；
    //   2) 原生子代理 report：把输出汇报给主模型（output）。
    // 每个受控角色只放行自己的 *_sub_whale_report，阶段机也按角色不同。
    // -----------------------------------------------------------------------
    const subWhaleReportDefs = [];
    const roleOfReportTool = (tool) => {
      for (const [role, name] of Object.entries(V09_ROLE_REPORT_TOOLS)) {
        if (name === tool) return role;
      }
      return null;
    };
    for (const reportTool of KAZ_V09_SUB_WHALE_REPORT_TOOLS) {
      const role = roleOfReportTool(reportTool);
      if (role === null) continue;
      const roleFlow = stageIdsForRole(role).join(" → ");
      const reportDef = defineTool({
        name: reportTool,
        description:
          `Advance/report through the v0.9 ${role} subagent workflow (${roleFlow}). ` +
          `This tool is available only inside the matching v0.9 subagent role. ` +
          `Pass output for the native report to the parent main model, and nextStage to advance ` +
          `this role's ka-whale-workflow stage before reporting (must be in the current stage's ` +
          `Can advance to list). If nextStage is omitted, only the report is sent and the stage stays unchanged.`,
        parameters: {
          output: {
            type: "string",
            required: true,
            description: "Report/result text sent to the parent main model through the native subagent report.",
          },
          nextStage: {
            type: "string",
            description: `Legal next v0.9 stage for ${role} (e.g. one of: ${roleFlow}). Advances the workflow before reporting.`,
          },
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              messageId: { type: "string" },
              role: { type: "string" },
              stage: { type: "string" },
              advanced: { type: "boolean" },
            },
          },
          render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
          const agent = exec?.agent;
          if (agent === null || agent === undefined || typeof agent !== "object") {
            return Promise.reject(new Error(`${reportTool} requires a calling subagent`));
          }
          const controlledRole = controlledSubagentRoleOfAgent(agent);
          if (controlledRole !== role) {
            return Promise.reject(
              new Error(`${reportTool} can only be called by a controlled v0.9 "${role}" subagent`),
            );
          }
          ensureControlledSubagentStarted(agent);
          const subagents = ctx.get("subagents");
          if (
            subagents === undefined ||
            subagents === null ||
            typeof subagents.reportFrom !== "function"
          ) {
            return Promise.reject(
              new Error(`${reportTool} is unavailable: DSH subagent report service is not present.`),
            );
          }
          const output = typeof args?.output === "string" ? args.output : "";
          if (output.trim().length === 0) {
            return Promise.reject(new Error(`${reportTool} requires a non-empty output.`));
          }
          const nextStage = typeof args?.nextStage === "string" ? args.nextStage.trim() : "";
          const current = stageOfAgent(agent);
          let advanced = false;
          if (nextStage.length > 0) {
            const def = stageDefinitionFor(role, current);
            if (def === null || !def.canAdvance.includes(nextStage)) {
              const allowed = def === null ? "(unknown stage)" : def.canAdvance.join(", ");
              return Promise.reject(
                new Error(
                  `${reportTool} cannot advance from "${current}" to "${nextStage}" for role "${role}". ` +
                    `Allowed next stages: ${allowed}`,
                ),
              );
            }
            if (setStageAgent(agent, nextStage)) {
              advanced = true;
              reportRoundDisplay(agent, `${reportTool}: ${role} ${current} → ${nextStage}`, "阶段切换");
            }
          }
          const content = [{ type: "text", text: output }];
          const messageId = await subagents.reportFrom(agent, content, {
            delivery: "next-step",
            signal: exec.signal,
          });
          // 36.6: child-side round-display report removed. The report message is
          // delivered to the parent main line and captured in agent/pre-step there,
          // so it is recorded under the parent/main agent, not this child session.
          return {
            messageId,
            role,
            stage: nextStage.length > 0 ? nextStage : current,
            advanced,
          };
        },
      });
      subWhaleReportDefs.push(reportDef);
    }

    let toolDisposers = [];
    function installTools() {
      if (toolDisposers.length > 0) return;
      try {
        toolDisposers.push(ctx.tools.register(whaleReportDef));
        toolDisposers.push(ctx.tools.register(kaSubWhaleDef));
        for (const reportDef of subWhaleReportDefs) {
          toolDisposers.push(ctx.tools.register(reportDef));
        }
      } catch (error) {
        ctx.logger.warn(`[ka-whale-workflow] 注册 ${WHALE_REPORT_TOOL}/${KA_SUB_WHALE_TOOL}/sub-whale-report 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    function uninstallTools() {
      for (const dispose of toolDisposers) {
        try {
          dispose();
        } catch (error) {
          ctx.logger.warn(`[ka-whale-workflow] 注销工具失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      toolDisposers = [];
    }
    function handleChange() {
      const enabled = source()?.enabled !== false;
      if (enabled) installTools();
      else uninstallTools();
    }

    // -----------------------------------------------------------------------
    // 对外信号：kaWhaleWorkflow 服务（供 kaz-mode / round-display / 探针读取状态）。
    // -----------------------------------------------------------------------
    const kaWhaleWorkflowService = {
      version: 3,
      stageOf: (agent) => stageOfAgent(agent),
      enabledFor: (agent) => liveFor(agent).enabled === true,
      taskPlanStoreFile: taskPlanStore.file,
      lifecycleReferencePath,
      /** v0.9 B3：受控子代理角色记录 / 最终工具面（kaz-mode 组装时读取）。 */
      subagentRoleOf: (agent) => {
        const sessionId = sessionIdOf(agent);
        if (typeof sessionId !== "string" || sessionId.length === 0) return null;
        return stageStore.getSubagentRole(sessionId);
      },
      subagentSurfaceOf: (agent) => {
        const record =
          agent !== null && typeof agent === "object" ? kaWhaleWorkflowService.subagentRoleOf(agent) : null;
        return record !== null && Array.isArray(record.finalTools)
          ? [...record.finalTools]
          : null;
      },
      /** 当前读取的候选注册表文件路径（与 agent-managed registry 同源）。 */
      candidateRegistryFile: agentManagedRegistryFile,
      // 终案 E：内部执行器入口（探针/定时器/边界共用；不是用户可见工具）。
      runLifecycleAudit,
      recordToolUse,
      lifecycleFile,
      lifecycleAuditFile,
      agentManagedRegistryFile,
    };
    ctx.effect(() => {
      const disposeService = ctx.provide("kaWhaleWorkflow", kaWhaleWorkflowService);
      return () => {
        if (typeof disposeService === "function") disposeService();
      };
    }, "ka-whale-workflow: 发布 kaWhaleWorkflow 阶段服务");

    // -----------------------------------------------------------------------
    // v0.9 tools/pre-execute 软闸门：主/受控子代理 stage 的 Allowed tools 约束。
    // 返回统一 workflow-stage-deny；不改变 schema，也不视为模型失败惩罚。
    // -----------------------------------------------------------------------
    ctx.on("tools/pre-execute", (exec, next) => {
      const agent = exec?.agent;
      if (agent === null || agent === undefined || typeof agent !== "object") return next();
      if (liveFor(agent).enabled !== true) return next();
      const controlledRole = controlledSubagentRoleOfAgent(agent);
      if (controlledRole !== null) {
        ensureControlledSubagentStarted(agent);
        const current = stageOfAgent(agent);
        const def = stageDefinitionFor(controlledRole, current);
        if (def === null) return next();
        const name = exec?.name;
        if (typeof name !== "string" || def.allowedTools.includes(name)) return next();
        ctx.logger.info(
          `[ka-whale-workflow] workflow-stage-deny: "${name}" not allowed in ${controlledRole} stage "${current}"`,
        );
        return {
          kind: "deny",
          reason:
            `workflow-stage-deny: "${name}" is not allowed in current ka-whale-workflow stage "${current}" ` +
            `(role "${controlledRole}"). Allowed tools: [${def.allowedTools.join(", ")}]. ` +
            `Can advance to: [${def.canAdvance.join(", ")}]. ` +
            `Suggested: use one of the allowed tools, or call ${
              V09_ROLE_REPORT_TOOLS[controlledRole] ?? "the role report tool"
            } to advance/report from "${current}".`,
        };
      }
      if (liveFor(agent).includeSubagents !== true && isSubagent(agent)) return next();
      const current = stageOfAgent(agent);
      if (!isMainWorkflowStage(current)) return next();
      const def = stageDefinitionFor(MAIN_ROLE, current);
      if (def === null) return next();
      const name = exec?.name;
      if (typeof name !== "string" || def.allowedTools.includes(name)) return next();
      ctx.logger.info(
        `[ka-whale-workflow] workflow-stage-deny: "${name}" not allowed in stage "${current}"`,
      );
      return {
        kind: "deny",
        reason:
          `workflow-stage-deny: "${name}" is not allowed in current ka-whale-workflow stage "${current}". ` +
          `Allowed tools: [${def.allowedTools.join(", ")}]. Can advance to: [${def.canAdvance.join(", ")}]. ` +
          `Suggested: use one of the allowed tools, or call whale_report with a legal nextStage to advance.`,
      };
    });

    try {
      const disposer = ctx.on("tools/result", (exec, result) => {
        try {
          recordToolUse(exec, result);
        } catch (error) {
          ctx.logger?.debug?.(
            `[ka-whale-workflow] recordToolUse 失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
      ctx.effect(() => () => {
        try {
          if (typeof disposer === "function") disposer();
        } catch {
          // ignore cleanup errors
        }
      }, "ka-whale-workflow: 释放 tools/result 埋点");
    } catch (error) {
      ctx.logger?.warn?.(
        `[ka-whale-workflow] tools/result 监听注册失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const lifecycleIntervalHours = skillLifecycleFor(null).auditIntervalHours;
    ctx.effect(() => {
      if (typeof ctx.interval !== "function") return;
      const dispose = ctx.interval(() => {
        try {
          runLifecycleAudit({ source: "timer", dryRun: false });
        } catch (error) {
          ctx.logger?.warn?.(
            `[ka-whale-workflow] 周期生命周期审计失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }, Math.max(1, Number.isFinite(lifecycleIntervalHours) ? lifecycleIntervalHours : 24) * 3600000);
      return () => {
        try {
          dispose();
        } catch {
          // ignore cleanup errors
        }
      };
    }, "ka-whale-workflow: 终案 E 周期审计 timer");

    if (typeof ctx.timeout === "function") {
      ctx.timeout(() => {
        try {
          runLifecycleAudit({ source: "startup", dryRun: true });
        } catch (error) {
          ctx.logger?.debug?.(
            `[ka-whale-workflow] 启动 dry-run 生命周期审计失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }, 5000);
    }

    // -----------------------------------------------------------------------
    // 启动：真实用户消息被 inbox claim 后、assembly 之前进入对应阶段。
    //   - /goal 命令触发的消息：旁路鲸鱼工作流（不进入重构），
    //     round-minimal 极简过滤仍照常生效。（v0.8 Step B1：/plan 已移除）
    //   - 用户插话不改变当前阶段；仅首轮/未开始且已解除极简时进入任务重构。
    // -----------------------------------------------------------------------
    const pendingStart = new Set();
    /** 进程内已消费的 /goal 命令 id（每个命令只旁路下一次 claim）。 */
    const consumedManualCommands = new Set();
    /** 当前处于命令旁路的 session id 集合（assemble / pre-step 读取）。 */
    const manualBypassSessions = new Set();
    /** 当前会话是否处于命令旁路。 */
    function isBypassed(agent) {
      const sessionId = sessionIdOf(agent);
      return typeof sessionId === "string" && sessionId.length > 0 && manualBypassSessions.has(sessionId);
    }

    /** 查询并消费一次命令旁路：命中返回命令信息，未命中返回 null。 */
    function consumeManualCommand(agent) {
      const found = manualCommandIdOf(agent);
      if (found === null || found.commandId === undefined || found.commandId === null) return null;
      if (consumedManualCommands.has(found.commandId)) return null;
      consumedManualCommands.add(found.commandId);
      return found;
    }

    ctx.on("agent/inbox/claimed", ({ agent, message, turn }) => {
      if (agent === null || agent === undefined || typeof agent !== "object") return;
      if (liveFor(agent).enabled !== true) return;
      // 受控 v0.9 子代理不受 includeSubagents=false 跳过：idle 时先进入其 role 首阶段。
      const controlledRole = controlledSubagentRoleOfAgent(agent);
      if (controlledRole !== null) {
        ensureControlledSubagentStarted(agent);
        return;
      }
      if (liveFor(agent).includeSubagents !== true && isSubagent(agent)) return;
      if (!isUserMessage(message)) return;
      const sessionId = agent?.session?.id || agent?.id;
      if (typeof sessionId !== "string" || sessionId.length === 0) return;
      // /goal 命令触发的消息：只跳过鲸鱼工作流，round-minimal 极简仍生效。
      const manual = consumeManualCommand(agent);
      if (manual !== null) {
        manualBypassSessions.add(sessionId);
        reportRoundDisplay(agent, `检测到 /${manual.name} 指令：本消息跳过鲸鱼工作流，直接放行白名单工具。`, "工作流旁路");
        return;
      }
      manualBypassSessions.delete(sessionId);
      const current = stageOfAgent(agent);
      const goalActive = goalModeActive(agent);
      // 第 2、3、4……轮（turn>=2，模型不在运行）：非终态活动阶段保留当前阶段；
      // 只有 idle/done/end/communication 才重新进入 assess-complexity（36.5）。
      if (typeof turn === "number" && turn >= 2) {
        const next = nextStageOnUserMessage(current, turn, { goalActive });
        if (setStageAgent(agent, next)) {
          reportRoundDisplay(
            agent,
            next === GOAL_ACTIVE_STAGE
              ? "收到新一轮消息：Goal active，保持 goal-active。"
              : next === "assess-complexity"
                ? "收到新一轮消息：从终态重新进入 assess-complexity。"
                : `收到新一轮消息：保留当前活动阶段 ${next}。`,
            "阶段切换",
          );
        }
        return;
      }
      // 插话（模型运行中）不改变当前工作流阶段；仅尚未开始（idle）时进入 assess-complexity。
      if (current !== "idle") return;
      // Goal 模式激活时不开启任务重构，直接进入 goal-active 外部模式。
      if (goalActive) {
        if (setStageAgent(agent, GOAL_ACTIVE_STAGE)) {
          reportRoundDisplay(agent, "Goal 模式激活，直接进入 goal-active。", "阶段切换");
        }
        return;
      }
      if (isMinimal(agent)) {
        pendingStart.add(sessionId);
        return;
      }
      if (setStageAgent(agent, "assess-complexity")) {
        reportRoundDisplay(agent, "进入 assess-complexity。", "阶段切换");
      }
    });

    /** 从 session/event 的 session 对象解析 agent（output-beep 同款）。 */
    function sessionAgentOf(session) {
      try {
        const id =
          session !== null && typeof session === "object" && typeof session.id === "string"
            ? session.id
            : session?.sessionId;
        if (typeof id === "string" && id.length > 0) {
          const agents = ctx.get("agents");
          if (agents !== undefined && agents !== null && typeof agents.get === "function") {
            const agent = agents.get(id);
            if (agent !== undefined && agent !== null) return agent;
          }
        }
      } catch {
        // fall through
      }
      return undefined;
    }

    ctx.on("session/event", (session, event) => {
      if (event === null || typeof event !== "object" || event.type !== "tool/call") return;
      const sessionId = session !== null && typeof session === "object" && typeof session.id === "string"
        ? session.id
        : session?.sessionId;
      if (typeof sessionId !== "string" || sessionId.length === 0 || !pendingStart.has(sessionId)) return;
      pendingStart.delete(sessionId);
      const agent = sessionAgentOf(session);
      if (agent === null || agent === undefined || typeof agent !== "object") return;
      if (liveFor(agent).enabled !== true) return;
      // 受控 v0.9 子代理同样在 round-minimal 解除后进入 role 专属首阶段。
      const controlledRole = controlledSubagentRoleOfAgent(agent);
      if (controlledRole !== null) {
        ensureControlledSubagentStarted(agent);
        return;
      }
      if (liveFor(agent).includeSubagents !== true && isSubagentSession(session)) return;
      const current = stageOfAgent(agent);
      if (current !== "idle") return;
      // Goal 模式激活时直接进入 goal-active（不开启 assess-complexity）。
      if (goalModeActive(agent)) {
        if (setStageAgent(agent, GOAL_ACTIVE_STAGE)) {
          reportRoundDisplay(agent, "round-minimal 已解除：Goal 模式激活，直接进入 goal-active。", "阶段切换");
        }
        return;
      }
      if (setStageAgent(agent, "assess-complexity")) {
        reportRoundDisplay(agent, "round-minimal 已解除，进入 assess-complexity。", "阶段切换");
      }
    });

    // -----------------------------------------------------------------------
    // 上下文注入：主/子流程与 Goal 继续确认按 turn 去重注入一次。
    // -----------------------------------------------------------------------
    ctx.on("agent/pre-step", async (payload, next) => {
      const agent = payload?.agent;
      if (agent !== null && agent !== undefined && typeof agent === "object") {
        const live = liveFor(agent);
        const controlledRole = controlledSubagentRoleOfAgent(agent);
        // 受控 v0.9 子代理：先确保其 role 专属首阶段已初始化，不走主模型 Goal/新任务路由。
        if (controlledRole !== null && live.enabled === true) {
          ensureControlledSubagentStarted(agent);
        }
        const skipSubagent =
          controlledRole === null && live.includeSubagents !== true && isSubagent(agent);
        const messages = Array.isArray(payload?.messages) ? payload.messages : [];
        const hasRealUserMessage = messages.some((message) => isUserMessage(message));
        const turn = typeof payload?.turn === "number" ? payload.turn : currentTurnOf(agent);
        const bypassed = isBypassed(agent);
        if (live.enabled === true && controlledRole === null && !skipSubagent && !bypassed) {
          const stage = stageOfAgent(agent);
          const goalActive = goalModeActive(agent);
          // 无真实用户消息且 Goal 已结束：从 goal-active 进入 working-resumed 边界。
          if (!hasRealUserMessage && stage === GOAL_ACTIVE_STAGE && !goalActive) {
            transitionGoalActiveToWorkingResumed(agent);
          }
          if (hasRealUserMessage) {
            if (turn >= 2) {
              const next = nextStageOnUserMessage(stage, turn, { goalActive });
              if (setStageAgent(agent, next)) {
                reportRoundDisplay(
                  agent,
                  next === GOAL_ACTIVE_STAGE
                    ? "收到新一轮消息：Goal active，保持 goal-active（pre-step 兜底）。"
                    : next === "assess-complexity"
                      ? "收到新一轮消息：从终态重新进入 assess-complexity（pre-step 兜底）。"
                      : `收到新一轮消息：保留当前活动阶段 ${next}（pre-step 兜底）。`,
                  "阶段切换",
                );
              }
            } else if (stage === "idle" && !isMinimal(agent) && !goalActive) {
              if (setStageAgent(agent, "assess-complexity")) {
                reportRoundDisplay(
                  agent,
                  "进入 assess-complexity（pre-step 兜底）。",
                  "阶段切换",
                );
              }
            }
          } else if (turn < 2 && stage === "idle" && !isMinimal(agent) && hasToolCall(agent) && !goalActive) {
            if (setStageAgent(agent, "assess-complexity")) {
              reportRoundDisplay(
                agent,
                "round-minimal 已解除，进入 assess-complexity（pre-step 兜底）。",
                "阶段切换",
              );
            }
          }
        }
      }
      let decision = await next();
      if (decision === null || typeof decision !== "object" || decision.kind !== "enter") return decision;
      if (agent === null || agent === undefined || typeof agent !== "object") return decision;
      if (liveFor(agent).enabled !== true) return decision;
      if (isBypassed(agent)) return decision;
      // 上下文注入：
      //   - 主模型 / 旧未知子代理（includeSubagents=true）的 flow Persona 首次注入一次；
      //   - 受控 v0.9 子代理只注入 role-specific stage，不注入旧通用 subagent-flow；
      //   - v0.9 stage 注入按 pendingStageInjection 精确一次（同一 run 内重新
      //     进入某 stage 会再次 pending，因此会再次注入）。
      const liveNow = liveFor(agent);
      const controlledRoleNow = controlledSubagentRoleOfAgent(agent);
      const skipSubagentNow =
        controlledRoleNow === null && liveNow.includeSubagents !== true && isSubagent(agent);
      const subagentNow = isSubagent(agent);
      const sessionIdNow = sessionIdOf(agent);
      const turn = typeof payload?.turn === "number" ? payload.turn : currentTurnOf(agent);
      const messages = Array.isArray(decision.messages) ? decision.messages : [];
      // 36.6: main-side subagent report capture. The child-side *_sub_whale_report
      // no longer writes to round-display; when the parent main agent receives a
      // DSH subagent-report/subagent-settled message, record one line here under
      // the parent/main agent with the whitelisted subagent-report category.
      if (
        liveNow.enabled === true &&
        controlledRoleNow === null &&
        !skipSubagentNow &&
        !subagentNow &&
        !isBypassed(agent)
      ) {
        for (const message of messages) {
          const summary = subagentReportSummaryOf(message);
          if (summary.length > 0) {
            reportRoundDisplay(agent, summary, "子代理汇报", "subagent-report");
          }
        }
      }
      let appended = false;
      if (liveNow.enabled === true && !skipSubagentNow && !isBypassed(agent)) {
        // 受控 v0.9 子代理的 Persona 已由 ka_sub_whale 带入对应 role flow；
        // 不再注入旧通用 SUBAGENT_FLOW_TEXT，只注入 role-specific pending stage。
        if (controlledRoleNow === null) {
          const form = subagentNow ? "subagent-flow" : "main-flow";
          const alreadyInjectedTurn = hasInjectedInTurn(agent, form, turn);
          const alreadyInjectedBefore = hasInjectedBefore(agent, form);
          if (!alreadyInjectedTurn && !alreadyInjectedBefore) {
            const text = subagentNow ? SUBAGENT_FLOW_TEXT : MAIN_FLOW_TEXT;
            try {
              const message = createUserMessage({
                content: [{ type: "text", text }],
                source: { kind: "plugin", plugin: "ka-whale-workflow", form },
              });
              messages.push(message);
              appended = true;
              reportRoundDisplay(
                agent,
                text,
                subagentNow ? "子代理流程" : "主流程",
              );
            } catch (error) {
              ctx.logger.warn(
                `[ka-whale-workflow] 构造主/子流程上下文消息失败：${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
        }

        // v0.9 阶段入口注入 + goal-active/working-resumed 边界注入：
        // 每次进入 v0.9 stage 或跨越 Goal 边界时 pending 一次，注入后即清除。
        if (typeof sessionIdNow === "string" && sessionIdNow.length > 0) {
          const pendingStage = stageStore.getPendingStageInjection(sessionIdNow);
          let specialText = "";
          if (pendingStage === GOAL_ACTIVE_STAGE && !subagentNow) {
            specialText = GOAL_ACTIVE_CONTEXT_TEXT;
          } else if (pendingStage === WORKING_RESUMED_STAGE && !subagentNow) {
            specialText = workingResumedContextText(taskPlanStore.file);
          }
          if (specialText.length > 0) {
            try {
              const message = createUserMessage({
                content: [{ type: "text", text: specialText }],
                source: {
                  kind: "plugin",
                  plugin: "ka-whale-workflow",
                  form: `stage:${pendingStage}`,
                },
              });
              messages.push(message);
              appended = true;
              stageStore.clearPendingStageInjection(sessionIdNow);
              reportRoundDisplay(agent, specialText, `阶段 ${pendingStage}`);
            } catch (error) {
              ctx.logger.warn(
                `[ka-whale-workflow] 构造 ${pendingStage} 边界注入消息失败：${error instanceof Error ? error.message : String(error)}`,
              );
            }
          } else if (pendingStage !== null && controlledRoleNow !== null) {
            // 受控子代理：注入 role 专属 stage 文本；plugin 生命周期阶段附实际 lifecyclePath。
            const options = stageNeedsLifecyclePath(pendingStage)
              ? { lifecyclePath: lifecycleReferencePath }
              : {};
            const text = stageInjectionText(controlledRoleNow, pendingStage, options);
            if (text.length > 0) {
              try {
                const message = createUserMessage({
                  content: [{ type: "text", text }],
                  source: {
                    kind: "plugin",
                    plugin: "ka-whale-workflow",
                    form: `stage:${pendingStage}`,
                  },
                });
                messages.push(message);
                appended = true;
                stageStore.clearPendingStageInjection(sessionIdNow);
                reportRoundDisplay(agent, text, `阶段 ${pendingStage}`);
              } catch (error) {
                ctx.logger.warn(
                  `[ka-whale-workflow] 构造 ${controlledRoleNow} 阶段注入消息失败：${error instanceof Error ? error.message : String(error)}`,
                );
              }
            }
          } else if (
            pendingStage !== null &&
            isMainWorkflowStage(pendingStage) &&
            !subagentNow
          ) {
            const options = {
              ...(stageNeedsTaskPlanPath(pendingStage)
                ? { taskPlanPath: taskPlanStore.file }
                : {}),
              ...(stageNeedsLifecyclePath(pendingStage)
                ? { lifecyclePath: lifecycleReferencePath }
                : {}),
              ...(pendingStage === "decide-tools"
                ? {
                    candidateToolDirectory: (() => {
                      const fileResult = readJsonFileSafe(agentManagedRegistryFile);
                      const registry = normalizeAgentManagedCandidateRegistry(
                        fileResult.ok === true ? fileResult.data : null,
                      );
                      return registry.candidates.length > 0
                        ? registry.candidates
                            .map(
                              (candidate) =>
                                `${candidate.tool}: ${candidate.description}${
                                  candidate.available ? "" : " (unavailable)"
                                }`,
                            )
                            .join("\n")
                        : "(no private-plugin candidates available; fixed tool-jobs: job_list, job_output, job_kill)";
                    })(),
                  }
                : {}),
            };
            const text = stageInjectionText(MAIN_ROLE, pendingStage, options);
            if (text.length > 0) {
              try {
                const message = createUserMessage({
                  content: [{ type: "text", text }],
                  source: {
                    kind: "plugin",
                    plugin: "ka-whale-workflow",
                    form: `stage:${pendingStage}`,
                  },
                });
                messages.push(message);
                appended = true;
                stageStore.clearPendingStageInjection(sessionIdNow);
                reportRoundDisplay(agent, text, `阶段 ${pendingStage}`);
              } catch (error) {
                ctx.logger.warn(
                  `[ka-whale-workflow] 构造阶段注入消息失败：${error instanceof Error ? error.message : String(error)}`,
                );
              }
            }
          }
        }
      }
      if (appended) {
        return {
          ...decision,
          messages,
        };
      }
      return decision;
    });

    ctx.effect(() => () => {
      uninstallTools();
      // 插件卸载前 flush lifecycle 内存脏数据（进程退出/热重载都尽量不丢埋点）。
      if (lifecycleMemory.dirty) persistLifecycleNow();
    });
  },
};
