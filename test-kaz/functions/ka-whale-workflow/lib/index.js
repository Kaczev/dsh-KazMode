// ka-whale-workflow —— 鲸鱼工作流（v0.9：主/受控子代理阶段机 + 工具面稳定）
// ===========================================================================
// 流程：
//   1) 主模型 Persona 由 kaz-system-prompt 把 deployment:persona 设为
//      KAZ_ROLE_PROMPTS.main 全文（每个 step 重新组装）；各 v0.9 阶段入口按 pending run 注入。
//   2) 受控 v0.9 子代理经 ka_sub_whale request.persona 获得 role Persona；旧
//      未知子代理在 includeSubagents=true 时仅走 workflow stage 外壳，不再注入
//      通用 subagent-flow 常量。
//   3) whale_report 在 Stable Main Surface 常驻，是主模型 stage 推进与 task plan
//      持久化的唯一 bookkeeping 入口。
//
// 工具面（由 kaz-mode + kaz-shared 执行）：
//   - 主模型：minimal（首次工具调用前 ≤2）→ Stable Main Surface（固定集）；
//   - 受控子代理：role Minimal → role Stable Base + assignedTools；
//   - v0.8 Step B1：原生 Plan 已移除，纯 minimal → Stable Main 一次变化。
//
// 阶段状态：
//   写入插件自己的 JSON 存储（~/.dsh/storages/ka-whale-workflow-stage.json，
//   按 session id 索引），重启/续接会话自然恢复。v0.9 只接受 v0.9 stage 与
//   idle/done/end 状态壳；旧 goal-active / working-resumed / reconstruction /
//   classification / goal-recovery 值不再读写。
// ===========================================================================

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
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
} from "../../kaz-shared/lib/tool-lists.js";
import { readJsonFileSafe, writeJsonFileSafe } from "../../kaz-shared/lib/safe-json-file.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  MAIN_ROLE,
  MAIN_STAGE_IDS,
  FIRST_ROUND_STARTUP_FORM,
  FIRST_ROUND_STARTUP_TEXT,
  V09_SUBAGENT_ROLES,
  V09_STAGE_IDS,
  V09_ROLE_PERSONAS,
  V09_ROLE_REPORT_TOOLS,
  V09_KA_SUB_WHALE_STAGE_PERSONAS,
  stageDefinitionFor,
  stageInjectionText,
  stageIdsForRole,
  canAdvance,
  advanceListFor,
  isFinalReportStage,
  isMainWorkflowStage,
  isSubagentWorkflowStage,
  stageNeedsLifecyclePath,
  stageNeedsTaskPlanPath,
  terminalStageIdsForRole,
} from "./stage-defs.js";
import {
  createTaskPlanStore,
  resolvePlanItemForDelegation,
  PLAN_PERSONAS,
  validateFinalPlanPayload,
  validateFinalPayloadItems,
  taskPlansDirectoryFor,
  runPlanFileFor,
  currentRunPointerFileFor,
  readRunPlanItems,
  readRunPlanRunMeta,
  readCurrentRunPointer,
  writeCurrentRunPointer,
  persistFinalPlanRun,
  workLogFileFor,
  readWorkLogEntries,
  appendWorkLogEntry,
} from "./task-plan-store.js";
import {
  defaultCostMeterDirectory,
  createCostMeterWriter,
} from "./cost-meter.js";
import {
  normalizeTier,
  normalizeTierSignals,
  normalizeUpgradeHistory,
  normalizeSMisjudgmentHistory,
  recordSMisjudgment,
  sessionDefaultTierAfterMisjudgments,
  canUpgradeTier,
  tierBudgetExceeded,
  PROVISIONAL_S_TIER_BUDGET,
} from "./tier.js";
import {
  EVIDENCE_CHECKLIST_TOOL_HINT,
  INTENT_MAP_TOOL_HINT,
  formatValidationFailure,
  normalizeEvidenceChecklist,
  normalizeIntentMap,
  runPromptDefectPass,
  validateEvidenceChecklistInput,
  validateIntentMapInput,
} from "./intent-map.js";
import {
  buildEvidenceShellRequest,
  evaluateEvidenceGate,
  normalizeNotVerifiedList,
  runMainRerunOnce,
  MAIN_RERUN_TIMEOUT_MS,
  NOT_VERIFIED_MAX_CHARS,
} from "./evidence-gate.js";

/** 设置命名空间：~/.dsh/settings.yaml 中的 ka-whale-workflow: 段。 */
const NAMESPACE = "ka-whale-workflow";

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

/** plan_read：主模型结构化读取当前 workflow-run task plan。 */
export const PLAN_READ_TOOL = "plan_read";

/** v0.9 受控委派工具名（32 世实际 continuable 委派层）。 */
export const KA_SUB_WHALE_TOOL = "ka_sub_whale";

/** v0.9 子代理 report 工具名（ka-whale-workflow 注册并包装子代理 report 能力）。 */
export const WORK_SUB_WHALE_REPORT_TOOL = "work_sub_whale_report";
export const MEMORY_SUB_WHALE_REPORT_TOOL = "memory_sub_whale_report";

/** *_sub_whale_report 成功后的硬等门提示（工具结果文案追加；子代理应把完整报告作为最终消息结束回合，父主以 subagent-settled 收到）。 */
export const SUB_WHALE_REPORT_WAIT_NOTICE =
  "Stage advanced; now output your full report as your final message and end the turn; parent receives it as subagent-settled; do not call further tools.";

/** tools/pre-execute 对 awaitingParent 受控子代理的结构化拒绝 code。 */
export const SUB_WHALE_REPORT_WAIT_DENY_CODE = "subagent-report-wait-deny";

/** v0.9 stage 常量（再导出，便于探针/下游引用）。 */
export { MAIN_ROLE, MAIN_STAGE_IDS, V09_SUBAGENT_ROLES, V09_STAGE_IDS };

/** 任务计划独立存储路径常量（由 kaz-shared 定义，这里再导出便于探针）。 */
export { KAZ_TASK_PLAN_STORE_PATH, KAZ_PRIVATE_PLUGIN_LIFECYCLE_PATH };

/** v0.9 受控子代理 role → 首个 workflow stage（§4 worker；§5–§7 其它 role）。 */
export const V09_SUBAGENT_ROLE_INITIAL_STAGES = Object.freeze({
  worker: "challenge-plan",
  memoryMaintainer: "plan-memory",
});

/** 设置 schema（同时驱动设置页 UI）。 */
const SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(true),
  /** 子代理是否也走鲸鱼工作流；默认关（与首阶段 Minimal 的默认语义一致）。 */
  includeSubagents: z.boolean().default(false),
  /** 显式项目根覆盖；空串时从主 agent 会话 cwd 解析。 */
  projectRoot: z.string().default(""),
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
  /** 7.4 P1 S/M/L fast lane：默认 off（off = 无 tier ctx，7.3.5 静态行为）。 */
  tierFastLane: z.boolean().default(false),
  /** 7.4 P3 evidence/delivery gate：默认 off（off = advisory/不阻断，7.3.5 行为）。 */
  evidenceGate: z.boolean().default(false),
});

/** 本插件 settings.yaml 段的默认配置（镜像作者 settings.yaml；仅含非运行时字段）。 */
export const DEFAULT_SECTION = {
  enabled: true,
  includeSubagents: false,
  projectRoot: "",
  skillAutonomyEnabled: true,
  skillAutonomyMaxChangesPerBoundary: 1,
  skillPrivateRoot: "",
  skillAutoLifecycleEnabled: true,
  skillLifecycleUnusedDays: 60,
  skillLifecyclePendingDays: 7,
  skillLifecycleAuditIntervalHours: 24,
  skillLifecycleMaxAutoActions: 1,
  tierFastLane: false,
  evidenceGate: false,
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
    projectRoot:
      typeof value.projectRoot === "string" && value.projectRoot.trim().length > 0
        ? value.projectRoot.trim()
        : "",
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
    tierFastLane: value.tierFastLane === true,
    evidenceGate: value.evidenceGate === true,
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
    const header = agent?.session?.header;
    if (header !== null && header !== undefined && typeof header === "object") {
      return header.origin === "subagent" || typeof header.parentSession === "string";
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

/** 是否为父主模型经 DSH send_message（ctx.subagents.followup）投递给受控子代理的消息。
 *  dsh 0.1.1 的 source 为 { kind: "coordinator", form: "relay", senderSessionId: parent.id }；
 *  dsh 0.1.5 起同一 seam 的 kind 变成 "agent-message"
 *  （@deepseek-ai/dsh-subagent 的 AgentMessageSource：{ kind: "agent-message",
 *  form: "relay", senderSessionId }）。两个 kind 都接受，form 必须是 "relay"；
 *  只认这一种形状，避免把普通用户消息或子代理汇报当成父级回复而误清硬等门。 */
export function isParentMainSendMessage(message) {
  try {
    const source = message?.source;
    if (source === null || source === undefined || typeof source !== "object") return false;
    if (source.form !== "relay") return false;
    return source.kind === "coordinator" || source.kind === "agent-message";
  } catch {
    return false;
  }
}

/** 提取子代理 report/settled 消息的单行摘要；非该类消息返回空串。 */
export function subagentReportSummaryOf(message) {
  if (!isSubagentReportMessage(message)) return "";
  return oneLineSummary(messageTextOf(message));
}

/** 提取子代理 report/settled 消息的 child session id；非该类消息返回空串。
 *  DSH continuable-subagent 消息 source 固定携带 senderSessionId。 */
export function subagentReportChildSessionIdOf(message) {
  try {
    if (!isSubagentReportMessage(message)) return "";
    const source = message?.source;
    if (source !== null && typeof source === "object") {
      const sender = source.senderSessionId;
      if (typeof sender === "string" && sender.length > 0) return sender;
      const sessionId = source.sessionId;
      if (typeof sessionId === "string" && sessionId.length > 0) return sessionId;
    }
    const session = message?.session;
    if (session !== null && typeof session === "object") {
      const id = typeof session.id === "string" ? session.id : session.sessionId;
      if (typeof id === "string" && id.length > 0) return id;
    }
    return "";
  } catch {
    return "";
  }
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

/** 归一化一条受控子代理角色记录（v0.9 B3 + memoryMaintainer 强制复用）。
 *  旧记录缺少 parentId/stage 时兼容读取（缺省空串）；awaitingParent 缺省 false。 */
export function normalizeSubagentRoleRecord(raw) {
  if (raw === null || raw === undefined || typeof raw !== "object") return null;
  const planItemId = typeof raw.planItemId === "string" ? raw.planItemId.trim() : "";
  const persona = typeof raw.persona === "string" ? raw.persona.trim() : "";
  if (planItemId.length === 0 || persona.length === 0 || !V09_SUBAGENT_ROLES.includes(persona)) return null;
  return {
    planItemId,
    persona,
    parentId: typeof raw.parentId === "string" ? raw.parentId.trim() : "",
    stage: typeof raw.stage === "string" ? raw.stage.trim() : "",
    assignedTools: normalizeToolList(raw.assignedTools),
    finalTools: normalizeToolList(raw.finalTools),
    // schema-compatible：旧记录没有该字段时按 false 读取；写入时总是归一化为布尔。
    awaitingParent: raw.awaitingParent === true,
    // v0.10a：terminalFinal=true 表示 child 已发 final:true terminal full report，
    // 父主 reply 后重置新轮；旧记录/旧阶段无此字段按 false。
    terminalFinal: raw.terminalFinal === true,
    // 7.0/2026-09：受控子代理首次 tool/call 后置 true 并持久化，避免 resume 后
    // kaz-mode 只依赖会话 tool/call 事件而把已解锁子代理重新判成 Minimal。
    minimalDone: raw.minimalDone === true,
    // 7.4 P3：terminal report notVerified 列表（由 *_sub_whale_report final:true 携带；
    // 旧记录缺省空数组 + missing marker）。
    notVerified: Array.isArray(raw.notVerified)
      ? raw.notVerified.filter((entry) => typeof entry === "string" && entry.trim().length > 0)
      : [],
    notVerifiedMissing: raw.notVerifiedMissing === true,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
  };
}

/** 旧版 subagent 合并尾部 stage：已从 stage-defs 删除，但 stage store 历史文件
 *  可能仍含该值，reload 时按 legacy 接受并兼容清门/复用（不写新状态）。 */
const LEGACY_SUBAGENT_TERMINAL_STAGE = "compress_context_then_communication";

/** 存储可接受的所有 stage 值：v0.9 + 状态壳。
 *  旧 goal-active / working-resumed / reconstruction / classification / goal-recovery
 *  已不再可写；历史文件中的这些值在读取时按未知值丢弃（等价回 idle）。
 *  LEGACY_SUBAGENT_TERMINAL_STAGE 仅作旧 in-flight 兼容读取。 */
const KNOWN_SESSION_STAGES = new Set([
  ...V09_STAGE_IDS,
  LEGACY_SUBAGENT_TERMINAL_STAGE,
  "idle",
  "done",
  "end",
]);

/**
 * 创建阶段状态存储（可注入文件路径，便于探针用临时文件）。
 * 结构：{ version: 6,
 *        sessions: { "<sessionId>": "<v0.9 stage>" },
 *        contractState: { "<sessionId>": {...} },
 *        workflowRuns: { "<sessionId>": { runId, enteredStages,
 *          tier?, tierReason?, tierSignals?, upgradeHistory?,
 *          intentMap?, evidenceChecklist? } },
 *        pendingStageInjection: { "<sessionId>": "<stage>" },
 *        subagentRoles: { "<childSessionId>": { planItemId, persona, parentId,
 *          stage, assignedTools, finalTools, awaitingParent, createdAt, updatedAt } },
 *        subagentRoleParents: { "<parentId>": { "<role>": ["<childSessionId>", ...] } } }
 * 旧文件缺少 contractState / workflowRuns / subagentRoleParents 时仍按旧版读取；
 * subagentRoles 记录缺 parentId/stage/awaitingParent 时按兼容缺省读取（version 保持 6）。
 */
export function createStageStore(file) {
  const sessions = {};
  const contractState = {};
  const workflowRuns = {};
  const pendingStageInjection = {};
  const subagentRoles = {};
  const subagentRoleParents = {};
  const sessionTierMisjudgments = {};
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
      const rawMisjudgments =
        parsed !== null && typeof parsed === "object" ? parsed.sessionTierMisjudgments : undefined;
      if (rawMisjudgments !== null && typeof rawMisjudgments === "object") {
        for (const [id, rawHistory] of Object.entries(rawMisjudgments)) {
          if (id.length === 0) continue;
          const history = normalizeSMisjudgmentHistory(rawHistory);
          if (history.length > 0) sessionTierMisjudgments[id] = history;
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
          const runRecord = { runId, enteredStages };
          const tier = normalizeTier(rawRun.tier);
          if (tier !== null) {
            runRecord.tier = tier;
            // 7.4 P2：tierCeiling 高水位；旧文件缺省回填 = tier，且永不低于 tier。
            const rawCeiling = normalizeTier(rawRun.tierCeiling);
            runRecord.tierCeiling =
              rawCeiling !== null && canUpgradeTier(tier, rawCeiling) ? rawCeiling : tier;
            if (typeof rawRun.tierReason === "string" && rawRun.tierReason.trim().length > 0) {
              runRecord.tierReason = rawRun.tierReason.trim();
            }
            const signals = normalizeTierSignals(rawRun.tierSignals);
            if (signals.length > 0) runRecord.tierSignals = signals;
            const history = normalizeUpgradeHistory(rawRun.upgradeHistory);
            if (history.length > 0) runRecord.upgradeHistory = history;
          }
          const runIntent = normalizeIntentMap(rawRun.intentMap);
          if (runIntent !== null) runRecord.intentMap = runIntent;
          if (rawRun.evidenceChecklist !== undefined && rawRun.evidenceChecklist !== null) {
            const checklist = normalizeEvidenceChecklist(rawRun.evidenceChecklist);
            if (checklist.length > 0) runRecord.evidenceChecklist = checklist;
          }
          if (rawRun.evidenceGateOverride === true || rawRun.evidenceGateOverride === false) {
            runRecord.evidenceGateOverride = rawRun.evidenceGateOverride;
            runRecord.evidenceGateSource =
              typeof rawRun.evidenceGateSource === "string" && rawRun.evidenceGateSource.length > 0
                ? rawRun.evidenceGateSource
                : "model";
          }
          workflowRuns[id] = runRecord;
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
      // 旧文件兼容/自愈：stage 从 sessions 回填；subagentRoleParents 每次从
      // subagentRoles 重建（不信任旧索引，避免 dispose 后的脏 childId 残留）。
      for (const [id, record] of Object.entries(subagentRoles)) {
        if (typeof record.stage !== "string" || record.stage.length === 0) {
          const sessionStage = sessions[id];
          if (typeof sessionStage === "string" && sessionStage.length > 0) record.stage = sessionStage;
        }
        if (typeof record.parentId === "string" && record.parentId.length > 0) {
          addRoleParentIndex(id, record);
        }
      }
    }
  } catch {
    // 存储损坏时从空状态开始，不影响主流程
  }
  /** 父索引：parentId → role → [childSessionId] 增删。 */
  function addRoleParentIndex(childId, record) {
    const parentId = record?.parentId ?? "";
    const persona = record?.persona ?? "";
    if (
      typeof childId !== "string" ||
      childId.length === 0 ||
      typeof parentId !== "string" ||
      parentId.length === 0 ||
      typeof persona !== "string" ||
      persona.length === 0
    ) {
      return;
    }
    let roleMap = subagentRoleParents[parentId];
    if (roleMap === undefined) {
      roleMap = {};
      subagentRoleParents[parentId] = roleMap;
    }
    let list = roleMap[persona];
    if (!Array.isArray(list)) {
      list = [];
      roleMap[persona] = list;
    }
    if (!list.includes(childId)) list.push(childId);
  }

  function removeRoleParentIndex(childId, record) {
    const parentId = record?.parentId ?? "";
    const persona = record?.persona ?? "";
    if (typeof parentId !== "string" || parentId.length === 0) return;
    if (typeof persona !== "string" || persona.length === 0) return;
    const roleMap = subagentRoleParents[parentId];
    if (roleMap === undefined) return;
    const list = Array.isArray(roleMap[persona]) ? roleMap[persona] : null;
    if (list !== null) {
      const index = list.indexOf(childId);
      if (index >= 0) list.splice(index, 1);
      if (list.length === 0) delete roleMap[persona];
    }
    if (Object.keys(roleMap).length === 0) delete subagentRoleParents[parentId];
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
            subagentRoleParents,
            sessionTierMisjudgments,
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
      const roleRecord = subagentRoles[sessionId];
      if (roleRecord !== undefined && roleRecord !== null) {
        subagentRoles[sessionId] = {
          ...roleRecord,
          stage,
          updatedAt: new Date().toISOString(),
        };
      }
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
    /** session 级连续 S 误判历史（跨 run 持久；最多最近 2 次 "S"）。 */
    getSessionTierMisjudgmentHistory(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return [];
      return [...normalizeSMisjudgmentHistory(sessionTierMisjudgments[sessionId])];
    },
    /** 连续 2 次 S 误判 → 返回 "M"；否则 null（分类时用该 API 覆盖 S）。 */
    sessionTierDefaultOf(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return null;
      return sessionDefaultTierAfterMisjudgments(
        normalizeSMisjudgmentHistory(sessionTierMisjudgments[sessionId]),
      );
    },
    /** 记录一次 S 误判（true=升 M 自动误判；false=成功 S run 完成，清零连续计数）。 */
    recordSessionSMisjudgment(sessionId, wasMisjudgedS = true) {
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return { ok: false, code: "tier-session-invalid", history: [], defaultTier: null };
      }
      const next = recordSMisjudgment(
        normalizeSMisjudgmentHistory(sessionTierMisjudgments[sessionId]),
        wasMisjudgedS === true,
      );
      if (next.length > 0) sessionTierMisjudgments[sessionId] = next;
      else delete sessionTierMisjudgments[sessionId];
      persist();
      return {
        ok: true,
        history: [...next],
        defaultTier: sessionDefaultTierAfterMisjudgments(next),
      };
    },
    /** workflow-run 状态：{ runId, enteredStages }。 */
    getWorkflowRun(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return null;
      return JSON.parse(JSON.stringify(runStateOf(sessionId)));
    },
    /** 当前 run 的 7.4 tier 记录；无显式 tier 返回 null（= 静态 7.3.5 行为）。 */
    getWorkflowRunTier(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return null;
      const run = runStateOf(sessionId);
      if (run.tier === undefined || normalizeTier(run.tier) === null) return null;
      const ceiling = normalizeTier(run.tierCeiling);
      return {
        tier: run.tier,
        tierCeiling: ceiling !== null && canUpgradeTier(run.tier, ceiling) ? ceiling : run.tier,
        tierReason: typeof run.tierReason === "string" ? run.tierReason : "",
        tierSignals: normalizeTierSignals(run.tierSignals),
        upgradeHistory: normalizeUpgradeHistory(run.upgradeHistory),
      };
    },
    /** 当前 run 的 7.4 evidence/delivery gate 模型覆盖；未设置返回 null。 */
    getWorkflowRunEvidenceGate(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return { evidenceGateOverride: null, evidenceGateSource: null };
      }
      const run = runStateOf(sessionId);
      const override =
        run.evidenceGateOverride === true
          ? true
          : run.evidenceGateOverride === false
            ? false
            : null;
      return {
        evidenceGateOverride: override,
        evidenceGateSource:
          override === null
            ? null
            : typeof run.evidenceGateSource === "string" && run.evidenceGateSource.length > 0
              ? run.evidenceGateSource
              : "model",
      };
    },
    /** 当前 run 的 7.4 Intent Map run 记录（canonical）；无记录返回空 meta。 */
    getWorkflowRunIntent(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return { intentMap: null, evidenceChecklist: [] };
      }
      const run = runStateOf(sessionId);
      return {
        intentMap: run.intentMap === undefined ? null : JSON.parse(JSON.stringify(run.intentMap)),
        evidenceChecklist:
          run.evidenceChecklist === undefined
            ? []
            : JSON.parse(JSON.stringify(run.evidenceChecklist)),
      };
    },
    /** 写入当前 run 的 Intent Map run 记录；结构非法返回 { ok:false, code }。 */
    setWorkflowRunIntent(sessionId, value) {
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return { ok: false, code: "tier-session-invalid" };
      }
      const rawIntent = value?.intentMap;
      if (rawIntent !== undefined && rawIntent !== null) {
        const check = validateIntentMapInput(rawIntent);
        if (check.ok !== true) return { ok: false, code: check.code, reason: check.reason };
        const normalized = normalizeIntentMap(rawIntent);
        if (normalized === null) {
          return { ok: false, code: "intent-map-invalid", reason: "intentMap did not normalize." };
        }
        runStateOf(sessionId).intentMap = normalized;
      }
      if (value?.evidenceChecklist !== undefined && value?.evidenceChecklist !== null) {
        runStateOf(sessionId).evidenceChecklist = normalizeEvidenceChecklist(
          value.evidenceChecklist,
        );
      }
      return persist() ? { ok: true } : { ok: false, code: "intent-persist-failed" };
    },
    /** 写入初始 tier 记录（同 run 内禁止降级；仅当尚无 tier 或等价保持时成功）。 */
    setWorkflowRunTier(sessionId, value) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return false;
      const tier = normalizeTier(value?.tier);
      if (tier === null) return false;
      const state = runStateOf(sessionId);
      if (state.tier !== undefined && state.tier !== null && state.tier !== tier) {
        if (!canUpgradeTier(state.tier, tier)) return false;
      }
      state.tier = tier;
      // 7.4 P2：tierCeiling = 只升不降高水位，恒 >= tier。
      const currentCeiling = normalizeTier(state.tierCeiling);
      const incomingCeiling = normalizeTier(value?.tierCeiling);
      let ceiling = tier;
      if (currentCeiling !== null && canUpgradeTier(ceiling, currentCeiling)) ceiling = currentCeiling;
      if (incomingCeiling !== null && canUpgradeTier(ceiling, incomingCeiling)) ceiling = incomingCeiling;
      state.tierCeiling = ceiling;
      state.tierReason =
        typeof value?.tierReason === "string" && value.tierReason.trim().length > 0
          ? value.tierReason.trim()
          : "";
      const signals = normalizeTierSignals(value?.tierSignals);
      if (signals.length > 0) state.tierSignals = signals;
      else delete state.tierSignals;
      const history = normalizeUpgradeHistory(value?.upgradeHistory);
      if (history.length > 0) state.upgradeHistory = history;
      else delete state.upgradeHistory;
      return persist();
    },
    /** 写入当前 run 的 evidence/delivery gate 模型覆盖；仅布尔；同值 no-op、异值拒绝（run 内不可变）。 */
    setWorkflowRunEvidenceGate(sessionId, value) {
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return { ok: false, code: "evidence-gate-session-invalid" };
      }
      if (typeof value !== "boolean") {
        return { ok: false, code: "evidence-gate-invalid" };
      }
      const state = runStateOf(sessionId);
      const existing =
        state.evidenceGateOverride === true
          ? true
          : state.evidenceGateOverride === false
            ? false
            : null;
      if (existing !== null && existing !== value) {
        return { ok: false, code: "evidence-gate-immutable" };
      }
      if (existing === value) {
        return { ok: true, changed: false, evidenceGateOverride: value };
      }
      const hadOverride = Object.prototype.hasOwnProperty.call(state, "evidenceGateOverride");
      const previousOverride = state.evidenceGateOverride;
      const hadSource = Object.prototype.hasOwnProperty.call(state, "evidenceGateSource");
      const previousSource = state.evidenceGateSource;
      state.evidenceGateOverride = value;
      state.evidenceGateSource = "model";
      if (persist()) return { ok: true, changed: true, evidenceGateOverride: value };
      if (hadOverride) state.evidenceGateOverride = previousOverride;
      else delete state.evidenceGateOverride;
      if (hadSource) state.evidenceGateSource = previousSource;
      else delete state.evidenceGateSource;
      return { ok: false, code: "evidence-gate-persist-failed" };
    },
    /** run 内升级（S→M/L）；写 upgradeHistory，只升不降。 */
    upgradeWorkflowRunTier(sessionId, { to, trigger, reason, at } = {}) {
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return { ok: false, code: "tier-session-invalid" };
      }
      const target = normalizeTier(to);
      if (target === null) return { ok: false, code: "tier-invalid" };
      const state = runStateOf(sessionId);
      const from = normalizeTier(state.tier);
      if (from === null) return { ok: false, code: "tier-no-current-tier" };
      if (!canUpgradeTier(from, target)) return { ok: false, code: "tier-downgrade-denied" };
      const history = normalizeUpgradeHistory(state.upgradeHistory);
      const entry = {
        from,
        to: target,
        trigger:
          typeof trigger === "string" && trigger.trim().length > 0 ? trigger.trim() : "unknown",
        at: typeof at === "string" && at.trim().length > 0 ? at : new Date().toISOString(),
      };
      history.push(entry);
      const persisted = this.setWorkflowRunTier(sessionId, {
        tier: target,
        tierReason:
          typeof reason === "string" && reason.trim().length > 0
            ? reason.trim()
            : typeof state.tierReason === "string"
              ? state.tierReason
              : "",
        tierSignals: state.tierSignals,
        upgradeHistory: history,
      });
      return persisted ? { ok: true, from, to: target, entry } : { ok: false, code: "tier-persist-failed" };
    },
    beginWorkflowRun(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return false;
      const state = runStateOf(sessionId);
      state.runId = Number.isSafeInteger(state.runId) ? state.runId + 1 : 1;
      state.enteredStages = [];
      delete state.tier;
      delete state.tierReason;
      delete state.tierSignals;
      delete state.tierCeiling;
      delete state.upgradeHistory;
      delete state.intentMap;
      delete state.evidenceChecklist;
      delete state.evidenceGateOverride;
      delete state.evidenceGateSource;
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
      if (previous !== undefined && previous !== null) removeRoleParentIndex(sessionId, previous);
      const timestamp = new Date().toISOString();
      const nextRecord = {
        ...normalized,
        createdAt: previous?.createdAt || timestamp,
        updatedAt: timestamp,
      };
      if ((typeof nextRecord.stage !== "string" || nextRecord.stage.length === 0) && sessions[sessionId]) {
        nextRecord.stage = sessions[sessionId];
      }
      subagentRoles[sessionId] = nextRecord;
      addRoleParentIndex(sessionId, nextRecord);
      return persist();
    },
    /** 硬等门：设置/清除受控子代理角色记录的 awaitingParent 标志。 */
    setSubagentRoleAwaitingParent(sessionId, awaitingParent) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return false;
      const current = subagentRoles[sessionId];
      if (current === undefined || current === null) return false;
      const flag = awaitingParent === true;
      if (current.awaitingParent === flag) return true;
      subagentRoles[sessionId] = {
        ...current,
        awaitingParent: flag,
        updatedAt: new Date().toISOString(),
      };
      return persist();
    },
    /** memoryMaintainer 强制复用：取同 parent + role 的可复用子代理候选取证记录。 */
    getReusableSubagentChildren(parentId, role) {
      if (typeof parentId !== "string" || parentId.length === 0) return [];
      if (typeof role !== "string" || role.length === 0 || !V09_SUBAGENT_ROLES.includes(role)) return [];
      const roleMap = subagentRoleParents[parentId];
      const childIds = Array.isArray(roleMap?.[role]) ? [...roleMap[role]] : [];
      const out = [];
      for (const childId of childIds) {
        const record = subagentRoles[childId];
        if (record === undefined || record === null) continue;
        if (record.persona !== role || record.parentId !== parentId) continue;
        out.push({
          childSessionId: childId,
          ...JSON.parse(JSON.stringify(record)),
        });
      }
      out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
      return out;
    },
    removeSubagentRole(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return false;
      if (!Object.prototype.hasOwnProperty.call(subagentRoles, sessionId)) return false;
      const current = subagentRoles[sessionId];
      removeRoleParentIndex(sessionId, current);
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
 *  36.5 语义（Goal 模式已移除）：
 *  - 真实用户消息出现在非终态活动阶段时保留当前阶段，不重置为 assess-complexity；
 *  - 只有 idle/done/end/communication/（旧）compress_context_then_communication 等
 *    终态或未开始状态才进入 assess-complexity
 *    （Minimal 不再重复，由 kaz-mode/ka-whale-workflow 按“会话第一次 tool/call”判定）；
 *  - 历史持久化的 goal-active/working-resumed 值只是旧数据：无 Goal 生命周期可恢复，
 *    一律按 assess-complexity 处理（不回退、不保留、无 Goal 特定文案）。
 */
export function nextStageOnUserMessage(current, _turn, _context = {}) {
  if (current === "goal-active" || current === "working-resumed") {
    // 旧版 Goal 外部模式/边界注入标记：Goal 模式已移除，重新进入普通任务流程。
    return "assess-complexity";
  }
  if (
    current === "idle" ||
    current === "done" ||
    current === "end" ||
    current === "communication" ||
    current === "compress_context_then_communication" // legacy in-flight only
  ) {
    return "assess-complexity";
  }
  if (typeof current !== "string" || current.trim().length === 0) {
    return "assess-complexity";
  }
  // 非终态活动阶段保持当前阶段。
  return current;
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
  inject: ["tools", "timer"],
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

    // v0.9 persona application: the main role system text is now applied by
    // kaz-system-prompt as the entire deployment:persona section
    // (KAZ_ROLE_PROMPTS.main). ka-whale-workflow no longer registers a second
    // ka-whale-workflow:main section; doing so would duplicate the full persona.

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

    /** 7.4 P0 cost meter（config.costMeterDirectory 可覆盖，探针用临时目录）。
     *  热路径只做内存累加；落盘去抖，失败只 warn。
     *  未显式配置时：探针/测试提供 config.stageStore 临时文件 → meter 放同目录
     *  cost-meter/；生产默认仍按 §7.2 用 DSH_HOME/storages/…。 */
    const costMeterDirectory =
      typeof config.costMeterDirectory === "string" && config.costMeterDirectory.trim().length > 0
        ? config.costMeterDirectory.trim()
        : typeof config.stageStore === "string" && config.stageStore.trim().length > 0
          ? join(dirname(config.stageStore.trim()), "cost-meter")
          : defaultCostMeterDirectory();
    const costMeter = createCostMeterWriter({
      directory: costMeterDirectory,
      logger: ctx.logger,
    });
    // 7.4 P1b：S 档预算。生产用 PROVISIONAL_S_TIER_BUDGET（PM3 未定稿）；
    // config.sTierBudget 只是探针内部测试缝，绝不进 settings schema / 模型面。
    const sTierBudget =
      config?.sTierBudget !== null &&
      config?.sTierBudget !== undefined &&
      typeof config?.sTierBudget === "object"
        ? config.sTierBudget
        : PROVISIONAL_S_TIER_BUDGET;

    // -----------------------------------------------------------------------
    // Project-root / per-run task plan resolution（k10-project-store）。
    // 与 ka-whale-memory 同源：优先显式 projectRoot，其次主 agent 会话
    // session.header.cwd。config.taskPlanStore 为 legacy 单文件模式（探针兼容）；
    // 项目根解析成功后写入 <project>/.dsh/storages/ka-whale-workflow/task-plans/。
    // -----------------------------------------------------------------------
    /** agent 会话 cwd（与 ka-whale-memory cwdOf 完全同 pattern）。 */
    function cwdOfAgent(agent) {
      return agent &&
        agent.session &&
        agent.session.header &&
        typeof agent.session.header.cwd === "string"
        ? agent.session.header.cwd
        : undefined;
    }
    const legacyTaskPlanOverride =
      typeof config.taskPlanStore === "string" && config.taskPlanStore.trim().length > 0
        ? config.taskPlanStore.trim()
        : "";
    function projectRootForAgent(agent) {
      const liveProjectRoot = source().projectRoot;
      if (typeof liveProjectRoot === "string" && liveProjectRoot.length > 0) return liveProjectRoot;
      return cwdOfAgent(agent);
    }
    function activeWorkflowRunForAgent(agent) {
      const sessionId = sessionIdOf(agent);
      if (typeof sessionId !== "string" || sessionId.length === 0) return null;
      const run = stageStore.getWorkflowRun(sessionId);
      if (run === null || !(Number.isSafeInteger(run.runId) && run.runId > 0)) return null;
      return run;
    }
    /**
     * 当前 agent 的 task-plan 上下文。
     * 返回 { mode:'legacy', store, file } 或
     *      { mode:'run', projectRoot, sessionId, runId, planFile, legacyFile }。
     * run mode 仅当 projectRoot 可解析且未显式 config.taskPlanStore。
     */
    function taskPlanContextForAgent(agent) {
      const projectRoot = projectRootForAgent(agent);
      if (legacyTaskPlanOverride.length > 0 || projectRoot === undefined) {
        return { mode: "legacy", store: taskPlanStore, file: taskPlanStore.file };
      }
      const sessionId = sessionIdOf(agent);
      const run = activeWorkflowRunForAgent(agent);
      const runId = run === null ? 0 : run.runId;
      return {
        mode: "run",
        projectRoot,
        sessionId: typeof sessionId === "string" ? sessionId : "",
        runId,
        planFile: runId > 0 ? runPlanFileFor(projectRoot, sessionId, runId) : null,
        legacyFile: taskPlanStore.file,
      };
    }
    /** 注入用 task plan 路径：run mode 有活动 run → run 文件；否则 legacy 路径。 */
    function taskPlanPathForAgent(agent) {
      const context = taskPlanContextForAgent(agent);
      return context.mode === "run" && context.planFile !== null ? context.planFile : context.file;
    }
    /** 活动 run 不存在时补一次 beginWorkflowRun（真实路径 assess 已 begin；兜底防 0）。 */
    function ensureActiveWorkflowRunForAgent(agent) {
      const sessionId = sessionIdOf(agent);
      if (typeof sessionId !== "string" || sessionId.length === 0) return null;
      const existing = activeWorkflowRunForAgent(agent);
      if (existing !== null) return existing;
      stageStore.beginWorkflowRun(sessionId);
      return activeWorkflowRunForAgent(agent);
    }

    /** 7.4 P1：tier fast lane 开关（off = 不注入/不读取 tier ctx）。 */
    function tierFastLaneEnabledFor(agent) {
      return liveFor(agent)?.tierFastLane === true;
    }
    /** 7.4 P3：evidence/delivery gate 开关（off = 不阻断、不执行 main 复跑）。
     *  run 级模型覆盖优先（不受 config flag / tierFastLane 影响）；未设置时回落 live config。 */
    function evidenceGateEnabledFor(agent) {
      const sessionId = sessionIdOf(agent);
      if (typeof sessionId === "string" && sessionId.length > 0) {
        const record = stageStore.getWorkflowRunEvidenceGate(sessionId);
        if (record.evidenceGateOverride !== null) return record.evidenceGateOverride;
      }
      return liveFor(agent)?.evidenceGate === true;
    }
    /** 当前 run 显式 tier 记录；无 run / 无 tier / flag off 返回 null。 */
    function workflowRunTierRecordFor(agent) {
      if (!tierFastLaneEnabledFor(agent)) return null;
      const sessionId = sessionIdOf(agent);
      if (typeof sessionId !== "string" || sessionId.length === 0) return null;
      return stageStore.getWorkflowRunTier(sessionId);
    }
    /** 当前 run tier 字符串（无 = null）；子代理永远 null（tier ctx main-only）。 */
    function workflowRunTierOf(agent) {
      return workflowRunTierRecordFor(agent)?.tier ?? null;
    }
    /** 把 whale_report 携带的初始分类写入当前 run；只允许 main + assess-complexity。
     *  已有不同 tier 时拒绝（后续变更必须走带 upgradeHistory 的升级入口）。 */
    function persistInitialWorkflowRunTier(agent, value) {
      const sessionId = sessionIdOf(agent);
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return { ok: false, code: "tier-session-invalid" };
      }
      ensureActiveWorkflowRunForAgent(agent);
      const tier = normalizeTier(value?.tier);
      if (tier === null) return { ok: false, code: "tier-invalid" };
      if (tier === "S" && stageStore.sessionTierDefaultOf(sessionId) === "M") {
        return {
          ok: false,
          code: "tier-session-default-m",
          reason: "session 连续 S 误判默认 M；本 run 不接受 S 分类",
        };
      }
      const existing = stageStore.getWorkflowRunTier(sessionId);
      if (existing !== null && existing.tier !== tier) {
        return { ok: false, code: "tier-upgrade-requires-history" };
      }
      const done = stageStore.setWorkflowRunTier(sessionId, {
        tier,
        tierReason:
          typeof value?.tierReason === "string" ? value.tierReason : "",
        tierSignals: normalizeTierSignals(value?.tierSignals),
      });
      return done ? { ok: true, tier } : { ok: false, code: "tier-persist-failed" };
    }

    /** 把 whale_report 携带的 per-run evidence gate 决策写入当前 run；只允许 main + assess-complexity。
     *  不可变性由 stageStore.setWorkflowRunEvidenceGate 收口（同值 no-op、异值 evidence-gate-immutable）。 */
    function persistWorkflowRunEvidenceGate(agent, value) {
      const sessionId = sessionIdOf(agent);
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return { ok: false, code: "evidence-gate-session-invalid" };
      }
      ensureActiveWorkflowRunForAgent(agent);
      return stageStore.setWorkflowRunEvidenceGate(sessionId, value);
    }

    /** 7.4 P2：finalPlanPayload 落盘成功后把 run tier/ceiling 抬到 maxItemTier。
     *  只升不降；无当前 tier 时直接落 tier=max（不写 upgradeHistory）；
     *  否则复用唯一自动升级入口（trigger=plan-finalization）。 */
    function applyPlanFinalizationTierCeiling(agent, maxItemTier) {
      if (!tierFastLaneEnabledFor(agent)) return null;
      const target = normalizeTier(maxItemTier);
      if (target === null) return null;
      const sessionId = sessionIdOf(agent);
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return { ok: false, code: "tier-session-invalid" };
      }
      const current = workflowRunTierRecordFor(agent);
      if (current === null) {
        ensureActiveWorkflowRunForAgent(agent);
        const done = stageStore.setWorkflowRunTier(sessionId, {
          tier: target,
          tierCeiling: target,
          tierReason: `plan finalization: max item tier ${target}`,
          tierSignals: [],
        });
        return done
          ? { ok: true, tier: target, tierCeiling: target, upgraded: false }
          : { ok: false, code: "tier-persist-failed" };
      }
      if (!canUpgradeTier(current.tier, target)) {
        return { ok: true, tier: current.tier, tierCeiling: current.tierCeiling, upgraded: false };
      }
      return autoUpgradeMainRunTier(agent, {
        to: target,
        trigger: "plan-finalization",
        reason: `write-plan finalization: max item tier ${target} exceeds run tier ${current.tier}`,
      });
    }

    /** 7.4 P1b：唯一内部 S→M 自动升级入口。
     *  写 upgradeHistory（只升不降）并对本次自动升级计一次 session S 误判。 */
    function autoUpgradeMainRunTier(agent, { to = "M", trigger, reason, at } = {}) {
      if (!tierFastLaneEnabledFor(agent)) return { ok: false, code: "tier-disabled" };
      const sessionId = sessionIdOf(agent);
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return { ok: false, code: "tier-session-invalid" };
      }
      if (activeWorkflowRunForAgent(agent) === null) {
        return { ok: false, code: "tier-no-active-run" };
      }
      const current = workflowRunTierRecordFor(agent);
      const target = normalizeTier(to);
      if (target === null) return { ok: false, code: "tier-invalid" };
      const result = stageStore.upgradeWorkflowRunTier(sessionId, {
        to: target,
        trigger,
        reason,
        at,
      });
      // 只在真实发生 S→M/L 自动升级时计一次误判；M→X/降级/无当前 tier 不计。
      if (result.ok === true && current !== null && current.tier === "S") {
        stageStore.recordSessionSMisjudgment(sessionId, true);
      }
      return result;
    }

    /** 成功 S run 到达 communication（无自动升级）→ 清零连续误判计数。 */
    function resetSessionSMisjudgmentAfterSuccessfulS(agent) {
      if (!tierFastLaneEnabledFor(agent)) return false;
      const record = workflowRunTierRecordFor(agent);
      if (record === null || record.tier !== "S") return false;
      const sessionId = sessionIdOf(agent);
      if (typeof sessionId !== "string" || sessionId.length === 0) return false;
      stageStore.recordSessionSMisjudgment(sessionId, false);
      return true;
    }

    /** 读取当前 run 的 cost-meter 聚合（内存优先；无则读盘）。 */
    function currentCostMeterForAgent(agent) {
      const key = costMeterKeyFor(agent);
      if (key === null) return null;
      return costMeter.read(key.sessionId, key.runId);
    }

    /** S run 实际工作量超预算 → 自动升 M（trigger=budget-exceeded）。 */
    function autoUpgradeBudgetExceeded(agent) {
      if (!tierFastLaneEnabledFor(agent)) return null;
      const current = workflowRunTierRecordFor(agent);
      if (current === null || current.tier !== "S") return null;
      const meter = currentCostMeterForAgent(agent);
      if (meter === null || !tierBudgetExceeded(meter, sTierBudget)) return null;
      return autoUpgradeMainRunTier(agent, {
        to: "M",
        trigger: "budget-exceeded",
        reason: `modelRequests=${meter.modelRequests} turns=${meter.turns} 超过 PM3 provisional S 预算`,
      });
    }

    /** S run 进入 working 且活动 run 已存在任何 plan item → 自动升 M（trigger=working-entry）。 */
    function autoUpgradeMainRunAtWorkingEntry(agent) {
      if (!tierFastLaneEnabledFor(agent)) return null;
      if (workflowRunTierOf(agent) !== "S") return null;
      const context = taskPlanContextForAgent(agent);
      if (
        context.mode !== "run" ||
        !(context.runId > 0) ||
        context.planFile === null ||
        typeof context.planFile !== "string"
      ) {
        return null;
      }
      let items = [];
      try {
        if (existsSync(context.planFile)) items = readRunPlanItems(context.planFile);
      } catch {
        items = [];
      }
      if (!Array.isArray(items) || items.length === 0) return null;
      const personas = [...new Set(items.map((item) => item?.persona).filter((p) => typeof p === "string"))];
      return autoUpgradeMainRunTier(agent, {
        to: "M",
        trigger: "working-entry",
        reason: `working 入口复评：S run 已有 ${items.length} 个 plan item（personas=[${personas.join(", ")}]）；S 是 main-only`,
      });
    }

    /** 当前 run 的 canonical evidenceChecklist（stage-store workflowRuns）。 */
    function evidenceChecklistForAgent(agent) {
      const sessionId = sessionIdOf(agent);
      if (typeof sessionId !== "string" || sessionId.length === 0) return [];
      return stageStore.getWorkflowRunIntent(sessionId).evidenceChecklist;
    }

    /** 把整份 normalized evidenceChecklist 写回 stage-store canonical。 */
    function persistEvidenceChecklistForAgent(agent, checklist) {
      const sessionId = sessionIdOf(agent);
      if (typeof sessionId !== "string" || sessionId.length === 0) return false;
      const result = stageStore.setWorkflowRunIntent(sessionId, {
        evidenceChecklist: normalizeEvidenceChecklist(checklist),
      });
      return result.ok === true;
    }

    /** main whale_report 到达 communication 时追加 main 的 notVerified work-log 条目。
     *  §9.3：列表是报告的一部分；此条目只在该行为 flag on 时产生（7.3.5 parity）。 */
    function appendMainCommunicationWorkLog(agent, notVerifiedInfo) {
      try {
        const context = taskPlanContextForAgent(agent);
        if (context.mode !== "run" || !(context.runId > 0)) return false;
        const result = appendWorkLogEntry({
          projectRoot: context.projectRoot,
          sessionId: context.sessionId,
          runId: context.runId,
          role: "main",
          planItemId: "",
          summary: "main whale_report advanced to communication",
          report: "",
          at: new Date().toISOString(),
          notVerified: notVerifiedInfo.notVerified,
          notVerifiedMissing: notVerifiedInfo.markers.includes("notVerifiedMissing"),
        });
        return result.ok === true;
      } catch {
        return false;
      }
    }

    /** 7.4 P3 live delivery gate（flag on、main 推进 communication 时调用）：
     *  任一 unmet → 拒绝；否则由本插件实际复跑第一条可复跑 met evidence（单命令、
     *  120s、无自动重试）。复跑结果写回 canonical checklist。 */
    async function enforceEvidenceGateOnCommunication(agent) {
      const sessionId = sessionIdOf(agent);
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return { ok: false, code: "evidence-gate-error", reason: "session unavailable." };
      }
      let checklist = normalizeEvidenceChecklist(evidenceChecklistForAgent(agent));
      if (checklist.length === 0) {
        return {
          ok: false,
          code: "evidence-no-evidence",
          reason: "evidence gate requires at least one evidence entry before communication.",
        };
      }
      const unmet = checklist.filter((entry) => entry.status === "unmet");
      if (unmet.length > 0) {
        return {
          ok: false,
          code: "evidence-unmet",
          reason: `evidence gate blocked by unmet entries: ${unmet.map((entry) => entry.id).join(", ")}.`,
          unmetIds: unmet.map((entry) => entry.id),
        };
      }
      const candidates = checklist.filter(
        (entry) =>
          entry.status === "met" &&
          typeof entry.command === "string" &&
          entry.command.trim().length > 0,
      );
      if (candidates.length === 0) {
        return {
          ok: false,
          code: "evidence-main-rerun-missing",
          reason: "delivery gate requires at least one met evidence command that main can rerun.",
        };
      }
      const chosen = candidates[0];
      const cwd = cwdOfAgent(agent);
      // Lazy per-call acquisition: the shell service is only requested when the
      // live gate actually reruns, so apply-time absence is harmless.
      const shellService =
        typeof ctx?.get === "function" ? ctx.get("shell") : undefined;
      const shellEnvService =
        typeof ctx?.get === "function" ? ctx.get("shellEnv") : undefined;
      const sandboxPolicyService =
        typeof ctx?.get === "function" ? ctx.get("sandboxPolicy") : undefined;
      let runShell;
      if (
        shellService !== undefined &&
        shellService !== null &&
        typeof shellService.resolve === "function" &&
        typeof shellService.run === "function"
      ) {
        runShell = async (request) => {
          const dshEnv =
            typeof shellEnvService?.collect === "function"
              ? shellEnvService.collect({ agent })
              : undefined;
          const sandboxPolicy =
            typeof sandboxPolicyService?.resolve === "function"
              ? sandboxPolicyService.resolve(
                  agent?.session === undefined || agent.session === null
                    ? {}
                    : { session: agent.session },
                )
              : undefined;
          const spec = shellService.resolve(
            buildEvidenceShellRequest({
              command: request.command,
              workdir: request.workdir,
              timeoutMs: request.timeoutMs,
              ...(dshEnv === undefined ? {} : { dshEnv }),
              ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
            }),
          );
          const result = await shellService.run(spec);
          return {
            exitCode:
              typeof result?.exitCode === "number" ? result.exitCode : null,
            stdout: { text: result?.stdout?.text ?? "" },
            stderr: { text: result?.stderr?.text ?? "" },
            timedOut: result?.timedOut === true,
          };
        };
      }
      const rerun = await runMainRerunOnce({
        command: chosen.command,
        expected: chosen.expected,
        cwd,
        timeoutMs: MAIN_RERUN_TIMEOUT_MS,
        ...(runShell === undefined ? {} : { runShell }),
      });
      const updated = normalizeEvidenceChecklist(
        checklist.map((entry) => {
          if (entry.id !== chosen.id) return entry;
          return {
            ...entry,
            status: rerun.matches ? entry.status : "unmet",
            mainRerun: {
              command: chosen.command,
              actualTail: rerun.actualTail,
              matches: rerun.matches === true,
            },
          };
        }),
      );
      persistEvidenceChecklistForAgent(agent, updated);
      if (rerun.matches === true) {
        return { ok: true, reason: `main reran evidence "${chosen.command}" and matches=true.` };
      }
      const timedOut = rerun.code === "evidence-timeout";
      return {
        ok: false,
        code: timedOut ? "evidence-timeout" : "evidence-main-rerun-failed",
        reason:
          rerun.reason && typeof rerun.reason === "string"
            ? rerun.reason
            : timedOut
              ? "main evidence rerun timed out; no automatic retry."
              : "main evidence rerun did not match; no automatic retry.",
        actualTail: typeof rerun.actualTail === "string" ? rerun.actualTail : "",
        command: chosen.command,
        exitCode: typeof rerun.exitCode === "number" ? rerun.exitCode : null,
        runnerCode: rerun.code ?? null,
      };
    }

    /** cost-meter key：与 task-plan 存储同源的 session/run 解析。
     *  child 没有自己的 workflowRun → runId=0（与基线 child workflowRunId=0 一致）。 */
    function costMeterKeyFor(agent) {
      const sessionId = sessionIdOf(agent);
      if (typeof sessionId !== "string" || sessionId.length === 0) return null;
      const run = activeWorkflowRunForAgent(agent);
      return { sessionId, runId: run === null ? 0 : run.runId };
    }
    /** 非负整数轮次；非法/缺失返回 0。 */
    function normalizedUserTurn(value) {
      const number = Number(value);
      return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
    }
    /** run 开始（进入 assess-complexity / 首个用户轮）时注入 run-local 基线。
     *  runId>0 的用户轮 N → baseline=max(0, N-1)；首轮 N=1 → 0。
     *  基线自描述地存进 v2 meter 文件（不在 stage-store run record 上）。 */
    function seedCostMeterRunBaselineForAgent(agent, turnHint) {
      const key = costMeterKeyFor(agent);
      if (key === null || key.runId <= 0) return false;
      if (costMeter.hasTurnBaseline(key.sessionId, key.runId)) return true;
      const cumulativeTurn = normalizedUserTurn(
        turnHint !== undefined && turnHint !== null
          ? turnHint
          : currentTurnOf(agent),
      );
      if (cumulativeTurn <= 0) return false;
      return costMeter.setTurnBaseline(key.sessionId, key.runId, Math.max(0, cumulativeTurn - 1));
    }
    function recordCostMeterAdd(agent, patch) {
      const key = costMeterKeyFor(agent);
      if (key === null) return false;
      return costMeter.recordAdd(key.sessionId, key.runId, patch);
    }
    /**
     * P8 语义：meter.turns 是 run-local 轮次，turnsCumulative 保留会话累计。
     * - runId>0：首次见用户轮时若无基线，做保守 legacy 播种
     *   baseline = min(max(0, turn-1), 既有 v1/v2 cumulative 值)；
     *   然后写 turns = max(0, turn - baseline)。
     * - runId=0（child / no-run）：v2 写 turns=0、turnsCumulative=累计轮，
     *   文档语义“no run → no run-local turn count; cumulative retained”。
     *   v1 runId=0 文件读盘时 turns 保持 as-is；新写入后 turns 归 0。
     */
    function recordCostMeterTurn(agent, turn) {
      const key = costMeterKeyFor(agent);
      if (key === null) return false;
      const cumulativeTurn = normalizedUserTurn(turn);
      if (cumulativeTurn <= 0) return false;
      if (key.runId <= 0) {
        costMeter.recordSet(key.sessionId, key.runId, { turns: 0 });
        return costMeter.recordMax(key.sessionId, key.runId, { turnsCumulative: cumulativeTurn });
      }
      let baseline = null;
      if (costMeter.hasTurnBaseline(key.sessionId, key.runId)) {
        baseline = costMeter.read(key.sessionId, key.runId).turnBaseline;
      } else {
        const existing = costMeter.read(key.sessionId, key.runId);
        // v1 没有 turnsCumulative：旧 turns 字段按 as-is 兼容，作为 legacy cumulative 上限。
        const existingCumulative =
          existing.version >= 2 ? existing.turnsCumulative : existing.turns;
        const currentMinusOne = Math.max(0, cumulativeTurn - 1);
        // 保守播种：只重建到既有 cumulative 偏移允许的范围，绝不把未知旧量当 0。
        const seeded = existingCumulative > 0
          ? Math.min(currentMinusOne, existingCumulative)
          : currentMinusOne;
        costMeter.setTurnBaseline(key.sessionId, key.runId, seeded);
        baseline = seeded;
      }
      const localTurns = Math.max(0, cumulativeTurn - baseline);
      costMeter.recordSet(key.sessionId, key.runId, { turns: localTurns });
      costMeter.recordMax(key.sessionId, key.runId, { turnsCumulative: cumulativeTurn });
      return true;
    }

    /**
     * k10-work-log：把 terminal full report 追加到 parent active run work-log。
     * v0.10a：primary 信号是 roleRecord.terminalFinal===true；legacy 兼容旧
     * compress_context_then_communication（pending 已消费）/communication 阶段。
     * best-effort：legacy/no-run/任何 I/O 失败都不抛错。返回 true/false。
     */
    function appendChildWorkLog({ parentAgent, childId, childRecord, message, loggedChildIds }) {
      try {
        if (childId === null || childId === undefined || childId === "") return false;
        if (loggedChildIds.has(childId)) return false;
        const roleRecord =
          childRecord !== null && typeof childRecord === "object"
            ? childRecord
            : stageStore.getSubagentRole(childId);
        if (roleRecord === null || typeof roleRecord !== "object") return false;
        const childStage =
          typeof roleRecord.stage === "string" && roleRecord.stage.length > 0
            ? roleRecord.stage
            : stageStore.get(childId) || "";
        const pending = stageStore.getPendingStageInjection(childId);
        const terminalFinalFlag = roleRecord.terminalFinal === true;
        const legacyTerminal =
          childStage === "communication" ||
          (childStage === "compress_context_then_communication" && pending !== childStage);
        if (!terminalFinalFlag && !legacyTerminal) return false;
        const summary = subagentReportSummaryOf(message);
        if (summary.length === 0) return false;
        const parentSessionId =
          typeof roleRecord.parentId === "string" && roleRecord.parentId.length > 0
            ? roleRecord.parentId
            : sessionIdOf(parentAgent);
        if (typeof parentSessionId !== "string" || parentSessionId.length === 0) return false;
        const parentForContext = {
          id: parentSessionId,
          session: { id: parentSessionId, header: { cwd: cwdOfAgent(parentAgent) } },
        };
        const context = taskPlanContextForAgent(parentForContext);
        if (context.mode !== "run" || context.runId <= 0) return false;
        const appendResult = appendWorkLogEntry({
          projectRoot: context.projectRoot,
          sessionId: parentSessionId,
          runId: context.runId,
          role: roleRecord.persona,
          planItemId: roleRecord.planItemId,
          summary,
          report: messageTextOf(message),
          at: new Date().toISOString(),
          notVerified: Array.isArray(roleRecord.notVerified) ? roleRecord.notVerified : [],
          notVerifiedMissing: roleRecord.notVerifiedMissing === true,
        });
        if (appendResult.ok === true) {
          loggedChildIds.add(childId);
          recordCostMeterAdd(parentAgent, { reportChars: messageTextOf(message).length });
          return true;
        }
        return false;
      } catch {
        return false;
      }
    }

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
     *  @param {number} [turnHint] 可选：调用方已知的用户轮（inbox/claimed 等），
     *  用于 run 开始即注入 meter turnBaseline（N-1），避免依赖事件扫描。 */
    function setStageAgent(agent, stage, turnHint) {
      const changed = setStage(agent, stage, stageStore);
      if (changed !== true) return changed;
      const sessionId = sessionIdOf(agent);
      if (typeof sessionId === "string" && sessionId.length > 0) {
        if (stage === "assess-complexity") {
          stageStore.removeContractState(sessionId);
          stageStore.beginWorkflowRun(sessionId);
          seedCostMeterRunBaselineForAgent(agent, turnHint);
        }
        if (V09_STAGE_IDS.includes(stage)) {
          stageStore.setPendingStageInjection(sessionId, stage);
          stageStore.addWorkflowRunStage(sessionId, stage);
        }
      }
      return changed;
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

    /** 是否处于首阶段极简（36.9：round-minimal 服务已删除，直接按本插件核心
     *  hasToolCall + 受控子代理持久化 minimalDone/role-stage 判定；调用处已排除
     *  includeSubagents=false 的旧子代理）。minimalDone=true 表示该受控子代理
     *  已完成首次工具调用；角色记录已进入非 idle role stage（如 plan-memory）
     *  也视为已解锁——即使 resume 后会话 tool/call 事件不可见也不回 Minimal。 */
    function isMinimal(agent) {
      // 预设化 v1：首轮极简机制整体移除。会话从一开始就不是 Minimal，
      // 首次 pre-step 即进入 assess-complexity（不再注入 first-round startup hint）。
      return false;
    }

    /** 受控 v0.9 子代理角色记录（含 awaitingParent 硬等门标志）。 */
    function controlledSubagentRecordOfAgent(agent) {
      if (agent === null || agent === undefined || typeof agent !== "object") return null;
      const sessionId = sessionIdOf(agent);
      if (typeof sessionId !== "string" || sessionId.length === 0) return null;
      try {
        return stageStore.getSubagentRole(sessionId);
      } catch {
        return null;
      }
    }

    /** 受控 v0.9 子代理检测：stageStore.subagentRoles 中存在该 session 的角色记录。
     *  这类子代理即使 includeSubagents=false 也必须走 ka-whale-workflow。 */
    function controlledSubagentRoleOfAgent(agent) {
      const record = controlledSubagentRecordOfAgent(agent);
      return record !== null && V09_SUBAGENT_ROLES.includes(record.persona)
        ? record.persona
        : null;
    }

    /** 受控子代理完成首次 tool/call 后，把 minimalDone 持久化到角色记录。
     *  返回是否已置为 true（已 true 也返回 true）。 */
    function markSubagentMinimalDone(agent) {
      if (agent === null || agent === undefined || typeof agent !== "object") return false;
      const record = controlledSubagentRecordOfAgent(agent);
      const sessionId = sessionIdOf(agent);
      if (record === null || typeof sessionId !== "string" || sessionId.length === 0) return false;
      if (record.minimalDone === true) return true;
      const updated = stageStore.setSubagentRole(sessionId, {
        ...record,
        minimalDone: true,
      });
      return updated === true;
    }

    /** 受控子代理首轮 Minimal startup hint（与主模型 [ka-whale-workflow first-round]
     *  对齐：首次工具调用前不注入完整 role stage 正文，只提示先做一次工具调用）。 */
    function controlledStartupHintText(role) {
      const initial = V09_SUBAGENT_ROLE_INITIAL_STAGES[role] ?? "";
      const report = V09_ROLE_REPORT_TOOLS[role] ?? "";
      return `[ka-whale-workflow first-round]
>
Mode: Minimal startup (${role} subagent, before the first tool call).
Before we answer, call memory_search or context_search exactly once. After that first tool call, ka-whale-workflow starts ${initial} and the full ${role} tool surface unlocks (including ${report}). Do not end the turn before making the call.
<`;
    }

    /** 解析父主 relay 的规范首行 `planItemId: <id>`（与 ka_sub_whale followup 同格式）。
     *  返回空串表示没有该行；不剥离正文，不影响原消息语义。 */
    function relayPlanItemIdOf(message) {
      const text = messageTextOf(message);
      const match = /^planItemId:[ \t]*(\S+)[ \t]*(?:\r?\n|$)/.exec(text);
      return match === null ? "" : match[1];
    }

    /** 检查 relay 声称的 planItemId 是否存在于父主活动 run 的 finalized plan 文件。
     *  复用 appendChildWorkLog 的 parent 伪 agent 构造：parentId + 子代理 cwd。
     *  任何解析失败/未知都视为不存在，调用方保持原行为。 */
    function relayPlanItemExistsInParentRun(record, agent, planItemId) {
      try {
        const parentId = typeof record.parentId === "string" ? record.parentId : "";
        const cwd = cwdOfAgent(agent);
        if (parentId.length === 0 || typeof cwd !== "string" || cwd.length === 0) return false;
        const parentAgentLike = {
          id: parentId,
          session: { id: parentId, header: { cwd } },
        };
        const context = taskPlanContextForAgent(parentAgentLike);
        if (
          context.mode !== "run" ||
          !(context.runId > 0) ||
          context.planFile === null ||
          typeof context.planFile !== "string"
        ) {
          return false;
        }
        return readRunPlanItems(context.planFile).some(
          (item) => item.planItemId === planItemId,
        );
      } catch {
        return false;
      }
    }

    /** 父主模型 send_message（coordinator/relay）到达受控子代理时清门：
     *  - terminalFinal=true（child 已发 final:true terminal full report）：重置为
     *    该角色初始阶段并清除 terminalFinal（新的一轮）；
     *  - 旧 in-flight legacy（旧 communication / compress_context_then_communication
     *    pending 已消费）也按终态重置，保证 reload 不崩；
     *  - 其它 mid-work pause / nextStage advance：只清 awaitingParent，stage 保持。
     *  只有 awaitingParent=true 且确实是父主 relay 时才动作。
     *  relay 若带规范首行 `planItemId: <id>` 且该 id 存在于父主活动 run，先更新
     *  子代理角色记录的 planItemId，使下一轮 terminal full report 计入新 item。 */
    function clearAwaitingParentOnParentReply(agent, message) {
      if (!isParentMainSendMessage(message)) return false;
      const sessionId = sessionIdOf(agent);
      if (typeof sessionId !== "string" || sessionId.length === 0) return false;
      const record = stageStore.getSubagentRole(sessionId);
      if (record === null || record.awaitingParent !== true) return false;
      const role = record.persona;
      const relayedPlanItemId = relayPlanItemIdOf(message);
      if (
        relayedPlanItemId.length > 0 &&
        relayedPlanItemId !== record.planItemId &&
        relayPlanItemExistsInParentRun(record, agent, relayedPlanItemId)
      ) {
        stageStore.setSubagentRole(sessionId, {
          ...record,
          planItemId: relayedPlanItemId,
        });
      }
      const current = stageOfAgent(agent);
      const pendingStage = stageStore.getPendingStageInjection(sessionId);
      const legacyOldFinal =
        current === "communication" ||
        (current === "compress_context_then_communication" && pendingStage !== current);
      const terminalReply = record.terminalFinal === true || legacyOldFinal;
      if (terminalReply) {
        const initial = V09_SUBAGENT_ROLE_INITIAL_STAGES[role] ?? current;
        if (setStageAgent(agent, initial)) {
          reportRoundDisplay(
            agent,
            `父主模型 send_message 到达：${role} 从 ${current} 重置到 ${initial}（新的一轮）。`,
            "阶段切换",
          );
        }
        const refreshed = stageStore.getSubagentRole(sessionId);
        if (refreshed !== null) {
          stageStore.setSubagentRole(sessionId, { ...refreshed, terminalFinal: false });
        }
      } else {
        reportRoundDisplay(
          agent,
          `父主模型 send_message 到达：清除 ${role} awaitingParent，继续当前 ${current}。`,
          "等待门",
        );
      }
      stageStore.setSubagentRoleAwaitingParent(sessionId, false);
      return true;
    }

    /** 受控 v0.9 子代理 idle 时初始化其 role 专属首阶段：
     *  worker=challenge-plan；memoryMaintainer=plan-memory。
     *  v0.9/主模型对齐：新受控子代理在首次 tool/call 前保持 stage=idle（只暴露
     *  Minimal 工具面 + startup hint），不提前注入完整 role stage；只有
     *  options.afterFirstTool=true（session/event 首次 tool/call）或会话已非
     *  Minimal（minimalDone / 已有 tool/call）时才真正进入 role 首阶段。 */
    function ensureControlledSubagentStarted(agent, options = {}) {
      const role = controlledSubagentRoleOfAgent(agent);
      if (role === null) return null;
      if (liveFor(agent).enabled !== true) return role;
      const current = stageOfAgent(agent);
      const afterFirstTool = options?.afterFirstTool === true;
      const initial = V09_SUBAGENT_ROLE_INITIAL_STAGES[role] ?? null;
      if (initial === null) return role;
      if (current === "idle" && !afterFirstTool && isMinimal(agent)) {
        // 尚未首次工具调用：与主模型一致，暂不进入 stage，等待 session/event
        // 首次 tool/call 后由 ensure(…, { afterFirstTool: true }) 进入。
        return role;
      }
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

    // -----------------------------------------------------------------------
    // whale_report 工具：v0.9 主模型 stage 推进与 task plan 持久化。
    // -----------------------------------------------------------------------
    const whaleReportDef = defineTool({
      name: WHALE_REPORT_TOOL,
      description:
        "Report bookkeeping and advance legal next stages; plans only in write-plan via finalPlanPayload. Pass evidenceGate alone at assess-complexity to set this run's delivery gate without advancing, or together with nextStage. Detail: README.md §Tool contract detail.",
      parameters: {
        mode: {
          type: "string",
          description:
            "Removed: Goal mode is no longer supported, so mode='goal' is rejected. Normal stage bookkeeping does not require mode.",
        },
        nextStage: {
          type: "string",
          description:
            "Legal main-model next stage id from the current stage's Can advance to list, e.g. challenge-plan, communication, decide-tools-before-writing-plan, write-plan, working, memory-maintenance. In decide-tools-before-writing-plan/write-plan it may be omitted when the payload implies the only/default transition.",
        },
        draftPlanItems: {
          type: "array",
          items: { type: "json" },
          description: "Rejected: task plans can only be written/finalized in write-plan via finalPlanPayload.",
        },
        finalPlanPayload: {
          type: "json",
          description:
            "Used in write-plan: { status: 'finalized', items: [...], intentMap?, evidenceChecklist? } to create/finalize the complete task plan. persona must be exactly one of main/worker/memoryMaintainer; allowed item fields are planItemId/persona/task/summary/dependsOn/targets/verification/assignedTools/tier/tierReason/tierSignals. Invalid payloads are rejected with a structured plan-item-invalid error and nothing is persisted.",
        },
        tier: {
          type: "string",
          description: "Optional run tier: S/M/L (assess-complexity only).",
        },
        tierReason: {
          type: "string",
          description: "Optional classification evidence; requires tier.",
        },
        tierSignals: {
          type: "array",
          items: { type: "string" },
          description: "Optional checkable signals; requires tier.",
        },
        evidenceGate: {
          type: "boolean",
          description:
            "Optional per-run delivery-gate decision (assess-complexity only; main agent only; immutable for the run). May be passed alone at assess-complexity to set it without advancing, or together with nextStage.",
        },
        intentMap: {
          type: "json",
          description: INTENT_MAP_TOOL_HINT,
        },
        evidenceChecklist: {
          type: "array",
          items: { type: "json" },
          description: EVIDENCE_CHECKLIST_TOOL_HINT,
        },
        notVerified: {
          type: "array",
          items: { type: "string" },
          description: `Optional notVerified list (each ≤${NOT_VERIFIED_MAX_CHARS} chars; never gate-blocking).`,
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
            advanced: { type: "boolean" },
            evidenceGate: { type: "boolean" },
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
        if (args?.mode === "goal") {
          return Promise.reject(
            new Error(
              `workflow-stage-deny: whale_report mode='goal' is not accepted because Goal mode has been removed. ` +
                `Advance with a legal nextStage through the normal workflow (current="${current}").`,
            ),
          );
        }
        // 7.4 D2：evidenceGate 只能在 main + assess-complexity 设置；检查先于非主阶段守卫，
        // 让子代理/错误阶段拿到结构化 evidence-gate-stage-invalid（不带该参数仍走 workflow-stage-deny）。
        const evidenceGateArgPresent = typeof args?.evidenceGate === "boolean";
        if (evidenceGateArgPresent) {
          const isSubagent = controlledSubagentRoleOfAgent(agent) !== null;
          if (isSubagent || current !== "assess-complexity") {
            const error = new Error(
              `evidence-gate-stage-invalid: whale_report evidenceGate can only be set by the main agent at assess-complexity ` +
                `(role=${isSubagent ? "subagent" : "main"}, current="${current}").`,
            );
            error.code = "evidence-gate-stage-invalid";
            return Promise.reject(error);
          }
        }
        if (!isMainWorkflowStage(current)) {
          const def = stageDefinitionFor(MAIN_ROLE, "assess-complexity");
          const reason =
            `workflow-stage-deny: whale_report cannot advance from outside the main stage machine ` +
            `(current="${current}"). Current allowed tools: ${def.allowedTools.join(", ")}. ` +
            `Suggested: start a new task through assess-complexity.`;
          return Promise.reject(new Error(reason));
        }

        // 7.4 P1/P2 classification carrier（assess-complexity only；flag off 时 tier 忽略）。
        const tierArgPresent =
          typeof args?.tier === "string" && args.tier.trim().length > 0;
        const rawIntentMap = args?.intentMap;
        const hasIntentMap =
          rawIntentMap !== null && rawIntentMap !== undefined;
        let intentRequiresConfirmation = false;
        let declaredTier = null;
        if (tierArgPresent) {
          declaredTier = normalizeTier(args.tier.trim());
          if (declaredTier === null) {
            const error = new Error(
              `tier-invalid: whale_report tier must be one of S/M/L (got "${String(args.tier)}").`,
            );
            error.code = "tier-invalid";
            return Promise.reject(error);
          }
          if (current !== "assess-complexity") {
            const error = new Error(
              `tier-invalid: whale_report tier can only be recorded in assess-complexity (current="${current}").`,
            );
            error.code = "tier-invalid";
            return Promise.reject(error);
          }
        }
        if (hasIntentMap) {
          if (current !== "assess-complexity") {
            const error = new Error(
              `intent-map-invalid: whale_report intentMap can only be recorded in assess-complexity (current="${current}").`,
            );
            error.code = "intent-map-invalid";
            return Promise.reject(error);
          }
          const intentCheck = validateIntentMapInput(rawIntentMap);
          if (intentCheck.ok !== true) {
            const error = new Error(formatValidationFailure(intentCheck));
            error.code = intentCheck.code;
            return Promise.reject(error);
          }
          // §8.4 prompt-defect pass：只对 defects 中命中的已知信号动作，绝不无条件改。
          const passed = runPromptDefectPass(rawIntentMap);
          if (passed.value === null) {
            const error = new Error("intent-map-invalid: intentMap did not normalize.");
            error.code = "intent-map-invalid";
            return Promise.reject(error);
          }
          ensureActiveWorkflowRunForAgent(agent);
          const intentResult = stageStore.setWorkflowRunIntent(sessionIdOf(agent), {
            intentMap: passed.value,
          });
          if (intentResult.ok !== true) {
            const error = new Error(
              `intent-map-invalid: whale_report could not persist intentMap: ${intentResult.code}.`,
            );
            error.code = "intent-map-invalid";
            return Promise.reject(error);
          }
          intentRequiresConfirmation = passed.value.requiresUserConfirmation === true;
        }
        if (tierArgPresent && declaredTier !== null) {
          if (tierFastLaneEnabledFor(agent)) {
            const initialResult = persistInitialWorkflowRunTier(agent, {
              tier: declaredTier,
              tierReason:
                typeof args?.tierReason === "string" ? args.tierReason : "",
              tierSignals: Array.isArray(args?.tierSignals) ? args.tierSignals : [],
            });
            if (initialResult.ok !== true) {
              const error = new Error(
                `tier-invalid: whale_report could not record tier "${declaredTier}": ${initialResult.code}.`,
              );
              error.code =
                initialResult.code === "tier-session-default-m"
                  ? "tier-session-default-m"
                  : "tier-invalid";
              return Promise.reject(error);
            }
            // 预算反作弊：初始 S 刚落盘就按当前 meter 检查一次，超预算立即升 M，
            // 因此同调用的 S-only nextStage 会在升 M 后被拒绝。
            autoUpgradeBudgetExceeded(agent);
          }
        }
        // 7.4 D3/D4：run 级 evidence gate 决策落盘（不可变；同值 no-op；被拒不动状态）。
        if (evidenceGateArgPresent) {
          const gateResult = persistWorkflowRunEvidenceGate(agent, args.evidenceGate);
          if (gateResult.ok !== true) {
            const error = new Error(
              gateResult.code === "evidence-gate-immutable"
                ? "evidence-gate-immutable: whale_report evidenceGate is already set for this run and is immutable."
                : `evidence-gate-invalid: whale_report could not record evidenceGate: ${gateResult.code}.`,
            );
            error.code =
              gateResult.code === "evidence-gate-immutable"
                ? "evidence-gate-immutable"
                : "evidence-gate-invalid";
            return Promise.reject(error);
          }
        }
        // P2 low-confidence/requires-confirmation intentMap：S run 必须走 P1 自动升级
        // 路径（同一 helper 计数一次 + 写 upgradeHistory），再评估 canAdvance。
        if (
          intentRequiresConfirmation &&
          workflowRunTierOf(agent) === "S"
        ) {
          autoUpgradeMainRunTier(agent, {
            to: "M",
            trigger: "requires-user-confirmation",
            reason:
              "Intent Map requiresUserConfirmation=true (discriminatingSignal missing/undecidable or §8.4 hit)",
          });
        }

        // 7.4 P3 evidenceChecklist run-record update（main stages；非 write-plan 的
        // finalPlanPayload 自带清单时由 write-plan 持久化块统一同步）。
        const hasFinalPlanPayload =
          args?.finalPlanPayload !== null && args?.finalPlanPayload !== undefined;
        const hasEvidenceChecklist = args?.evidenceChecklist !== null && args?.evidenceChecklist !== undefined;
        const finalPayloadCarriesEvidence =
          hasFinalPlanPayload &&
          args?.finalPlanPayload?.evidenceChecklist !== undefined &&
          args?.finalPlanPayload?.evidenceChecklist !== null;
        if (hasEvidenceChecklist && !(current === "write-plan" && finalPayloadCarriesEvidence)) {
          const evidenceCheck = validateEvidenceChecklistInput(args.evidenceChecklist);
          if (evidenceCheck.ok !== true) {
            const error = new Error(formatValidationFailure(evidenceCheck));
            error.code = evidenceCheck.code;
            return Promise.reject(error);
          }
          ensureActiveWorkflowRunForAgent(agent);
          if (!persistEvidenceChecklistForAgent(agent, args.evidenceChecklist)) {
            const error = new Error("evidence-checklist-invalid: whale_report could not persist evidenceChecklist.");
            error.code = "evidence-checklist-invalid";
            return Promise.reject(error);
          }
        }

        // v0.9 task plan persistence stage guard:
        // Task plans can only be written/finalized in write-plan via finalPlanPayload.
        // decide-tools cannot draft; memory-maintenance can only read/amend via write-plan.
        const hasDraftPlanItems = Array.isArray(args?.draftPlanItems);
        if (hasDraftPlanItems) {
          return Promise.reject(
            new Error(
              `workflow-stage-deny: draftPlanItems is no longer accepted in any stage (current="${current}"). ` +
                `Task plans can only be written/finalized in write-plan via finalPlanPayload.`,
            ),
          );
        }
        if (hasFinalPlanPayload && current !== "write-plan") {
          return Promise.reject(
            new Error(
              `workflow-stage-deny: finalPlanPayload can only be used in write-plan (current="${current}"). ` +
                `Writing/finalizing task plans here is not allowed; memory-maintenance must amend via write-plan.`,
            ),
          );
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
          const rejectPayload = (rejected) => {
            const codes = [...new Set(rejected.map((entry) => entry.code))];
            const ids = [
              ...new Set(
                rejected
                  .map((entry) => entry.planItemId)
                  .filter((id) => typeof id === "string" && id.length > 0),
              ),
            ];
            const reasons = rejected.map((entry) => entry.reason);
            const error = new Error(
              `plan-item-invalid: finalPlanPayload rejected before persistence; ` +
                `codes=[${codes.join(", ")}] ids=[${ids.join(", ")}] ` +
                `allowedPersonas=[${PLAN_PERSONAS.join(", ")}] reasons=${JSON.stringify(reasons)}`,
            );
            error.code = "plan-item-invalid";
            error.invalidCodes = codes;
            error.rejected = rejected.map((entry) => ({ ...entry }));
            error.allowedPersonas = [...PLAN_PERSONAS];
            return error;
          };
          const shapeCheck = validateFinalPlanPayload(payload);
          if (shapeCheck.ok !== true) {
            return Promise.reject(rejectPayload(shapeCheck.rejected));
          }
          const itemCheck = validateFinalPayloadItems(payload.items);
          if (itemCheck.ok !== true) {
            return Promise.reject(rejectPayload(itemCheck.rejected));
          }
          // 7.4 P2：run 级 tierCeiling/降级守卫与 tier 一样 gate 于 tierFastLane。
          const tierGuard = tierFastLaneEnabledFor(agent);
          const context = taskPlanContextForAgent(agent);
          let persisted;
          if (context.mode === "run") {
            const activeRun = ensureActiveWorkflowRunForAgent(agent);
            const sessionId = sessionIdOf(agent);
            persisted =
              activeRun !== null
                ? persistFinalPlanRun({
                    projectRoot: context.projectRoot,
                    sessionId,
                    runId: activeRun.runId,
                    payload,
                    options: { enforceTierDowngrade: tierGuard },
                  })
                : taskPlanStore.persistFinalPayload(payload, {
                    enforceTierDowngrade: tierGuard,
                  });
            if (persisted.ok === true) {
              // 双写一致性：v3 文件镜像已落盘；若 stage-store canonical 还缺 meta，
              // 用同 payload 的归一化值补写 stage store（stage-store 永远优先）。
              const syncMeta = {};
              if (payload.intentMap !== undefined && payload.intentMap !== null) {
                const passed = runPromptDefectPass(payload.intentMap);
                if (passed.value !== null) syncMeta.intentMap = passed.value;
              }
              if (payload.evidenceChecklist !== undefined && payload.evidenceChecklist !== null) {
                syncMeta.evidenceChecklist = normalizeEvidenceChecklist(
                  payload.evidenceChecklist,
                );
              }
              if (Object.keys(syncMeta).length > 0) {
                stageStore.setWorkflowRunIntent(sessionId, syncMeta);
              }
            }
          } else {
            persisted = taskPlanStore.persistFinalPayload(payload, {
              enforceTierDowngrade: tierGuard,
            });
          }
          if (persisted.ok !== true) {
            if (persisted.code === "plan-persist-failed") {
              return Promise.reject(new Error("whale_report failed to persist finalized task plan; task plan store write failed."));
            }
            return Promise.reject(rejectPayload(persisted.rejected ?? []));
          }
          // 7.4 P2：落盘成功后才抬 run tier/ceiling（best-effort，不假装原子）。
          if (tierGuard && typeof persisted.maxItemTier === "string") {
            applyPlanFinalizationTierCeiling(agent, persisted.maxItemTier);
          }
        }

        const def = stageDefinitionFor(MAIN_ROLE, current);
        const defaultNext =
          current === "assess-complexity" || current === "communication"
            ? null
            : current === "challenge-plan"
              ? "decide-tools-before-writing-plan"
              : current === "decide-tools-before-writing-plan"
                ? "write-plan"
                : current === "write-plan"
                  ? "working"
                  : current === "working"
                    ? "memory-maintenance"
                    : "communication";
        const requested =
          typeof args?.nextStage === "string" && args.nextStage.trim().length > 0
            ? args.nextStage.trim()
            : null;
        // 7.4 D4：assess-complexity 下可单独设置 evidenceGate（纯 run 设置，不推进 stage）。
        if (evidenceGateArgPresent && requested === null) {
          return Promise.resolve({
            ok: true,
            stage: current,
            restarted: false,
            advanced: false,
            evidenceGate: evidenceGateEnabledFor(agent),
          });
        }
        const target = requested !== null ? requested : defaultNext;

        const tierCtx = workflowRunTierRecordFor(agent);
        const effectiveTierCtx = tierCtx !== null ? { tier: tierCtx.tier } : undefined;
        const legalNext = advanceListFor(MAIN_ROLE, current, effectiveTierCtx);
        if (
          target === null ||
          !canAdvance(MAIN_ROLE, current, target, effectiveTierCtx)
        ) {
          const reason =
            `workflow-stage-deny: whale_report cannot advance from "${current}" to "${String(target)}". ` +
            `Current allowed tools: [${def.allowedTools.join(", ")}]. Can advance to: [${legalNext.join(", ")}]. ` +
            `Suggested: call whale_report with a legal nextStage from the Can advance to list.`;
          return Promise.reject(new Error(reason));
        }

        // 7.4 P3 live delivery gate（flag on）：communication 前实际复跑一条 evidence
        // 命令；unmet/超时/失败/缺 mainRerun 都结构化拒绝，不推进 stage。
        if (target === "communication") {
          if (evidenceGateEnabledFor(agent)) {
            const gateResult = await enforceEvidenceGateOnCommunication(agent);
            if (gateResult.ok !== true) {
              const error = new Error(
                `delivery-gate-deny: whale_report cannot advance to communication because ${gateResult.reason}` +
                  (typeof gateResult.actualTail === "string" && gateResult.actualTail.length > 0
                    ? `\nactualTail:\n${gateResult.actualTail}`
                    : ""),
              );
              error.code = gateResult.code;
              if (gateResult.actualTail !== undefined) error.actualTail = gateResult.actualTail;
              if (gateResult.command !== undefined) error.command = gateResult.command;
              if (gateResult.exitCode !== undefined) error.exitCode = gateResult.exitCode;
              if (gateResult.runnerCode !== undefined) error.runnerCode = gateResult.runnerCode;
              return Promise.reject(error);
            }
            appendMainCommunicationWorkLog(agent, normalizeNotVerifiedList(args?.notVerified));
          }
          // 成功的 S run 到达 communication（没有触发任何自动升级）→ 清零连续误判。
          resetSessionSMisjudgmentAfterSuccessfulS(agent);
        }

        if (target !== "end") {
          setStageAgent(agent, target);
        } else {
          setStageAgent(agent, "done");
        }
        reportRoundDisplay(
          agent,
          `whale_report：${current} → ${target}`,
          "鲸鱼工作流",
        );
        return Promise.resolve({
          ok: true,
          stage: target === "end" ? "done" : target,
          restarted: false,
          advanced: true,
          evidenceGate: evidenceGateEnabledFor(agent),
        });
      },
      presentCall: () => ({ card: "generic", title: "鲸鱼工作流汇报", kind: "other" }),
    });

    // -----------------------------------------------------------------------
    // ka_sub_whale：v0.9 B3 受控委派层。
    // 模型只能传 planItemId；persona/task/assignedTools/toolFilter 全部由
    // 已 finalized task plan + role Stable Surface 计算，再经
    // ctx.subagents.startContinuable 创建 continuable child。
    // -----------------------------------------------------------------------

    /** 工具面集合相等（忽略顺序/重复；空数组相等）。 */
    function sameToolSet(left, right) {
      const norm = (value) => {
        const out = [];
        const seen = new Set();
        for (const tool of Array.isArray(value) ? value : []) {
          if (typeof tool !== "string") continue;
          const name = tool.trim();
          if (name.length === 0 || seen.has(name)) continue;
          seen.add(name);
          out.push(name);
        }
        return out.sort();
      };
      const a = norm(left);
      const b = norm(right);
      return a.length === b.length && a.every((tool, index) => tool === b[index]);
    }

    /** memoryMaintainer 强制复用：同 parent + 同 role、finalSurface 集合一致、且
     *  terminalFinal=true（final:true full report 已发出；旧 communication 兼容）/
     *  ready 非忙碌 child 才通过 followup 投递下一轮。
     *  返回 null 表示没有可复用/复用服务不可用，调用方继续正常 spawn。 */
    async function tryReuseMemoryMaintainer({ parentId, agent, item, assignedTools, finalSurface, subagents, exec }) {
      if (
        typeof subagents?.listChildren !== "function" ||
        typeof subagents?.followup !== "function"
      ) {
        return null;
      }
      let children = [];
      try {
        const listed = await subagents.listChildren(parentId, exec.signal);
        children = Array.isArray(listed) ? listed : [];
      } catch (error) {
        ctx.logger?.warn?.(
          `[ka-whale-workflow] memoryMaintainer reuse cannot list children; falling back to spawn: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }
      const childrenById = new Map();
      for (const entry of children) {
        if (
          entry !== null &&
          typeof entry === "object" &&
          entry.kind === "child" &&
          entry.mode === "continuable" &&
          typeof entry.id === "string" &&
          entry.id.length > 0
        ) {
          childrenById.set(entry.id, entry);
        }
      }
      const candidates = stageStore.getReusableSubagentChildren(parentId, "memoryMaintainer");
      const agents = ctx.get("agents");
      let busyChildId = null;
      let busyStage = null;
      for (const candidate of candidates) {
        const childId = candidate.childSessionId;
        if (!childrenById.has(childId)) {
          // child 已释放/异常：从注册表清理，不作为可复用候选。
          stageStore.removeSubagentRole(childId);
          continue;
        }
        if (!sameToolSet(candidate.finalTools, finalSurface)) continue;
        const entry = childrenById.get(childId);
        const record = stageStore.getSubagentRole(childId) ?? candidate;
        const stageNow = stageStore.get(childId) || record.stage || "";
        const liveAgent =
          agents !== undefined && agents !== null && typeof agents.get === "function"
            ? agents.get(childId)
            : undefined;
        // v0.10a 真终态可复用：terminalFinal=true 的 child（final:true full report
        // 已发出）或旧 communication / 旧 compress_context_then_communication（pending
        // 已消费）都是 free；mid-work pause 或 awaitingParent 未终报视为 busy。
        const pendingStage = stageStore.getPendingStageInjection(childId);
        const legacyOldFinal =
          stageNow === "communication" ||
          (stageNow === "compress_context_then_communication" && pendingStage !== stageNow);
        const terminalFinal = record.terminalFinal === true || legacyOldFinal;
        const isBusy =
          !terminalFinal &&
          (record.awaitingParent === true || liveAgent !== undefined || entry.activity === "running");
        if (!terminalFinal && isBusy) {
          if (busyChildId === null) {
            busyChildId = childId;
            busyStage = stageNow;
          }
          continue;
        }
        // 可复用：先更新角色记录为新 planItem（不清除），再投递下一轮；
        // child 收到 coordinator/relay 后按终态重置规则进入 plan-memory。
        const currentRecord = stageStore.getSubagentRole(childId);
        if (currentRecord !== null) {
          stageStore.setSubagentRole(childId, {
            ...currentRecord,
            planItemId: item.planItemId,
            assignedTools,
            finalTools: finalSurface,
            stage: stageNow || currentRecord.stage || "",
          });
        }
        let messageId = "";
        try {
          const followupResult = await subagents.followup(
            agent,
            childId,
            [
              {
                type: "text",
                text: `planItemId: ${item.planItemId}\n\n${item.task}`,
              },
            ],
            {
              source: {
                kind: "coordinator",
                form: "relay",
                senderSessionId: parentId,
              },
              signal: exec.signal,
            },
          );
          messageId =
            typeof followupResult === "string"
              ? followupResult
              : typeof followupResult?.messageId === "string"
                ? followupResult.messageId
                : "";
        } catch (error) {
          stageStore.removeSubagentRole(childId);
          ctx.logger?.warn?.(
            `[ka-whale-workflow] memoryMaintainer reuse followup failed for ${childId}; removed reusable record: ${error instanceof Error ? error.message : String(error)}`,
          );
          return {
            ok: false,
            code: "subagent-reuse-failed",
            status: "reuse-failed",
            planItemId: item.planItemId,
            persona: "memoryMaintainer",
            childId,
            subagentId: childId,
            reason: `ka_sub_whale could not reuse memoryMaintainer subagent ${childId}: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        reportRoundDisplay(
          agent,
          `ka_sub_whale reused memoryMaintainer subagent ${childId} for plan item ${item.planItemId}.`,
          "受控委派复用",
        );
        return {
          ok: true,
          code: "subagent-reused",
          status: "reused",
          reused: true,
          planItemId: item.planItemId,
          persona: "memoryMaintainer",
          task: item.task,
          assignedTools,
          finalSurface,
          childId,
          subagentId: childId,
          messageId,
          notice:
            "MemoryMaintainer subagent reused for a new plan item. End the current turn and await its report/finished message; do not use pwsh sleep or poll list_agents.",
        };
      }
      if (busyChildId !== null) {
        return {
          ok: false,
          code: "subagent-busy",
          status: "busy",
          planItemId: item.planItemId,
          persona: "memoryMaintainer",
          childId: busyChildId,
          subagentId: busyChildId,
          reason:
            `ka_sub_whale cannot reuse memoryMaintainer subagent ${busyChildId}: ` +
            `compatible child is busy (stage="${busyStage}", awaitingParent or active). ` +
            "End the current turn and await its report before delegating the next memory-maintenance plan item.",
        };
      }
      return null;
    }

    const kaSubWhaleDef = defineTool({
      name: KA_SUB_WHALE_TOOL,
      description:
        "Controlled delegation from a finalized planItemId; end the current turn and await its report/finished message; do not poll/sleep. Detail: README.md §Tool contract detail.",
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
            childId: { type: "string" },
            reused: { type: "boolean" },
            messageId: { type: "string" },
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
        // 7.4 P1：S run = main-only；任何委派在 tier=S 时结构化拒绝（不自动降级）。
        if (workflowRunTierOf(agent) === "S") {
          return Promise.resolve({
            ok: false,
            code: "tier-s-delegation-denied",
            reason:
              "ka_sub_whale rejected delegation because the current run tier is S (main-only fast lane). " +
              "Upgrade the run to M (e.g. requires-user-confirmation / working re-evaluation) before delegating.",
          });
        }
        const context = taskPlanContextForAgent(agent);
        // Run mode resolves ONLY against the active run file (no legacy global
        // fallback). Legacy mode uses the single-file store for compatibility.
        const resolutionStore =
          context.mode === "run"
            ? createTaskPlanStore(context.planFile ?? "")
            : taskPlanStore;
        const resolved = resolvePlanItemForDelegation(resolutionStore, args?.planItemId);
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
            reason: `ka_sub_whale rejected plan item "${item.planItemId}": persona "${item.persona}" is not in the role set.`,
          });
        }
        // 36.8 + 37.5 stage-persona mapping enforcement:
        //   working → worker; memory-maintenance → memoryMaintainer.
        const currentStage = stageOfAgent(agent);
        const expectedPersona = V09_KA_SUB_WHALE_STAGE_PERSONAS[currentStage];
        if (expectedPersona !== undefined && role !== expectedPersona) {
          return Promise.resolve({
            ok: false,
            code: "stage-persona-mismatch",
            reason: `ka_sub_whale rejected plan item "${item.planItemId}" in ${currentStage}: persona "${role}" does not match the only delegable persona "${expectedPersona}" for this stage. Working delegates only worker; memory-maintenance only memoryMaintainer.`,
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
        // memoryMaintainer 强制复用：同 parent+role、finalSurface 一致且空闲才
        // 复用同一 child；忙碌返回 busy；无/不兼容/服务不可用才继续 spawn。
        const parentId = sessionIdOf(agent);
        if (
          role === "memoryMaintainer" &&
          typeof parentId === "string" &&
          parentId.length > 0
        ) {
          const reuseResult = await tryReuseMemoryMaintainer({
            parentId,
            agent,
            item,
            assignedTools: assignedValidation.tools,
            finalSurface,
            subagents,
            exec,
          });
          if (reuseResult !== null) return Promise.resolve(reuseResult);
        }
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
        const promptText = item.task;
        // 6.0.2: reserve the child id before materialization and write the role
        // record BEFORE startContinuable, so the child's first assembly already
        // sees its role instead of falling back to memory_search-only minimal.
        const childId = randomUUID();
        const now = new Date().toISOString();
        const roleRecord = {
          planItemId: item.planItemId,
          persona: role,
          parentId: typeof parentId === "string" ? parentId : "",
          stage: "idle",
          assignedTools: assignedValidation.tools,
          finalTools: finalSurface,
          minimalDone: false,
          createdAt: now,
          updatedAt: now,
        };
        if (stageStore.setSubagentRole(childId, roleRecord) !== true) {
          return Promise.resolve({
            ok: false,
            code: "subagent-start-failed",
            reason: "ka_sub_whale could not persist the child role record before starting the subagent.",
          });
        }
        try {
          const started = await subagents.startContinuable({
            childId,
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
          if (subagentId !== childId) {
            // Start did not materialize under the reserved id; remove the
            // pre-written role instead of leaving a stale record behind.
            stageStore.removeSubagentRole(childId);
            return Promise.resolve({
              ok: false,
              code: "subagent-start-failed",
              reason:
                "ka_sub_whale started a continuable child but the returned childId did not match the caller-reserved childId.",
            });
          }
          // Keep the post-start set for idempotency (preserves createdAt).
          stageStore.setSubagentRole(childId, roleRecord);
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
          stageStore.removeSubagentRole(childId);
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
    // *_sub_whale_report：子代理作用域的 v0.9 单一 subagent-settled 通道。
    // 它只负责：
    //   1) 推进本角色 workflow（nextStage）；
    //   2) 置 awaitingParent 硬等门。
    // 完整报告由子代理在工具结果后以“最终消息”写出；父主模型经 DSH
    // subagent-settled 单条收到。不再调用 reportFrom、不再 child-side 写摘要。
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
          `Advance/report through the ${role} subagent workflow (${roleFlow}); available only inside the matching role. ` +
          `Pass nextStage for planning → execution (must be in Can advance to); omit both final and nextStage for a mid-work pause; ` +
          `pass final:true only from the role's last execution stage and do NOT combine it with nextStage. ` +
          `A successful call is a hard stop: the child sets awaitingParent and waits for the parent main model's reply via send_message, ` +
          `which resumes it; the parent receives it as subagent-settled. final:true also sets terminalFinal=true; ` +
          `after the parent reply a fresh delegation starts at ${roleFlow.split(" → ")[0]}.`,
        parameters: {
          nextStage: {
            type: "string",
            description: `Legal next stage for ${role} (e.g. one of: ${roleFlow}). Advances the workflow before this report message. Cannot be combined with final:true.`,
          },
          final: {
            type: "boolean",
            description: `Optional terminal flag. final:true is valid only from the last execution stage of this role (one of: ${terminalStageIdsForRole(role).join(" / ")}) and must not be combined with nextStage. It sets terminalFinal=true and signals the FULL final report.`,
          },
          notVerified: {
            type: "array",
            items: { type: "string" },
            description: `Optional notVerified list (each ≤${NOT_VERIFIED_MAX_CHARS} chars; never gate-blocking).`,
          },
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              role: { type: "string" },
              stage: { type: "string" },
              advanced: { type: "boolean" },
              final: { type: "boolean" },
              terminalFinal: { type: "boolean" },
              notice: { type: "string" },
            },
          },
          render: (_args, value) => [
            { type: "text", text: `${JSON.stringify(value)}\n${SUB_WHALE_REPORT_WAIT_NOTICE}` },
          ],
        },
        async execute(args, exec) {
          const agent = exec?.agent;
          if (agent === null || agent === undefined || typeof agent !== "object") {
            return Promise.reject(new Error(`${reportTool} requires a calling subagent`));
          }
          const controlledRole = controlledSubagentRoleOfAgent(agent);
          if (controlledRole !== role) {
            return Promise.reject(
              new Error(`${reportTool} can only be called by a controlled "${role}" subagent`),
            );
          }
          // report 本身是一次真实工具调用：即使 session/event 未置 minimalDone，
          // 这里也确保角色记录已解锁（后续 resume 不再回 Minimal）。
          markSubagentMinimalDone(agent);
          ensureControlledSubagentStarted(agent);
          const isFinal = args?.final === true;
          const nextStage = typeof args?.nextStage === "string" ? args.nextStage.trim() : "";
          const current = stageOfAgent(agent);
          const def = stageDefinitionFor(role, current);
          let advanced = false;
          if (isFinal && nextStage.length > 0) {
            const error = new Error(
              `final-with-next-stage: ${reportTool} final:true cannot be combined with nextStage for role "${role}". ` +
                `Use final:true alone for the terminal full report, or nextStage for stage advance.`,
            );
            error.code = "final-with-next-stage";
            return Promise.reject(error);
          }
          if (isFinal) {
            const isExecutionTail = isFinalReportStage(role, current);
            if (!isExecutionTail) {
              const error = new Error(
                `final-report-stage-invalid: ${reportTool} final:true is valid only from the last execution stage of role "${role}" (one of: ${terminalStageIdsForRole(role).join(" / ")}), not from current="${current}".`,
              );
              error.code = "final-report-stage-invalid";
              return Promise.reject(error);
            }
          }
          if (!isFinal && nextStage.length > 0) {
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
          const terminalFinal = isFinal;
          // 7.4 P3：terminal report 的 notVerified（可选参数；missing → marker）。
          const notVerifiedInfo = normalizeNotVerifiedList(args?.notVerified);
          // 单一 subagent-settled 通道：工具不发送报告正文；子代理随后把报告
          // 作为最终消息写出，父主以 subagent-settled 收到。此处只置硬等门。
          const childId = sessionIdOf(agent);
          if (typeof childId === "string" && childId.length > 0) {
            const record = stageStore.getSubagentRole(childId);
            if (record !== null) {
              stageStore.setSubagentRole(childId, {
                ...record,
                terminalFinal,
                stage: nextStage.length > 0 ? nextStage : current,
                notVerified: notVerifiedInfo.notVerified,
                notVerifiedMissing: notVerifiedInfo.markers.includes("notVerifiedMissing"),
              });
            }
            stageStore.setSubagentRoleAwaitingParent(childId, true);
          }
          return {
            role,
            stage: nextStage.length > 0 ? nextStage : current,
            advanced,
            final: isFinal,
            terminalFinal,
            notice: SUB_WHALE_REPORT_WAIT_NOTICE,
          };
        },
      });
      subWhaleReportDefs.push(reportDef);
    }

    // -----------------------------------------------------------------------
    // plan_read：主模型专用，读取当前/指定 run 的 task plan（结构化 JSON）。
    // 子代理不持有；受控子代理经 ka_sub_whale 从 plan item 拿 task，不需要该工具。
    // -----------------------------------------------------------------------
    const planReadDef = defineTool({
      name: PLAN_READ_TOOL,
      description:
        "Read current/historical run task-plan/work-log (items, intentMap, evidenceChecklist) for main; prefer over raw JSON. Detail: README.md §Tool contract detail.",
      parameters: {
        runId: {
          type: "string",
          description:
            "Optional numeric run id to read. Omit to read the current active run of this session. Unknown run ids are rejected with plan-read-not-found.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            mode: { type: "string" },
            runId: { type: "string" },
            sessionId: { type: "string" },
            planFile: { type: "string" },
            workLogFile: { type: "string" },
            workLog: { type: "array", items: { type: "json" } },
            notice: { type: "string" },
            items: { type: "array", items: { type: "json" } },
            intentMap: { type: "json" },
            evidenceChecklist: { type: "array", items: { type: "json" } },
            tier: { type: "json" },
            tierCeiling: { type: "json" },
            code: { type: "string" },
            reason: { type: "string" },
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
            reason: "plan_read requires a calling agent.",
          });
        }
        if (controlledSubagentRoleOfAgent(agent) !== null) {
          return Promise.resolve({
            ok: false,
            code: "main-tool-denied",
            reason: "plan_read is available only to the main agent.",
          });
        }
        const sessionId = sessionIdOf(agent);
        const context = taskPlanContextForAgent(agent);
        const requestedRaw =
          typeof args?.runId === "string" ? args.runId.trim() : "";
        if (context.mode === "legacy") {
          if (requestedRaw.length > 0) {
            return Promise.resolve({
              ok: false,
              code: "plan-read-not-found",
              reason: `plan_read cannot read runId "${requestedRaw}" because this agent is in legacy single-file task-plan mode.`,
            });
          }
          return Promise.resolve({
            ok: true,
            mode: "legacy",
            runId: "",
            sessionId: typeof sessionId === "string" ? sessionId : "",
            planFile: context.file,
            workLogFile: "",
            workLog: [],
            items: context.store.list(),
            intentMap: null,
            evidenceChecklist: [],
            tier: null,
            tierCeiling: null,
          });
        }
        const activeRunId = context.runId;
        let targetRunId = activeRunId;
        if (requestedRaw.length > 0) {
          if (!/^\d+$/.test(requestedRaw)) {
            return Promise.resolve({
              ok: false,
              code: "plan-read-not-found",
              reason: `plan_read cannot resolve runId "${requestedRaw}"; run ids are numeric for this session.`,
            });
          }
          targetRunId = Number(requestedRaw);
        }
        if (typeof sessionId !== "string" || sessionId.length === 0 || !(targetRunId > 0)) {
          return Promise.resolve({
            ok: true,
            mode: "run",
            runId: "",
            sessionId: typeof sessionId === "string" ? sessionId : "",
            planFile: "",
            workLogFile: "",
            workLog: [],
            items: [],
            intentMap: null,
            evidenceChecklist: [],
            tier: null,
            tierCeiling: null,
            notice: "no active workflow run has been started yet.",
          });
        }
        const planFile = runPlanFileFor(context.projectRoot, sessionId, targetRunId);
        // 7.4 P2：run 级 meta canonical = stage-store workflowRuns（仅当前 run 有）；
        // 历史 run 或 stage 缺字段时回退到 v3 plan 文件顶层（stage-store 永远优先）。
        const stageRunIntent = stageStore.getWorkflowRunIntent(sessionId);
        const fileRunMeta = readRunPlanRunMeta(planFile);
        const useStageMeta = targetRunId === activeRunId;
        const stageRunTier = useStageMeta ? stageStore.getWorkflowRunTier(sessionId) : null;
        const runTier = stageRunTier !== null ? stageRunTier.tier : null;
        const runTierCeiling = stageRunTier !== null ? stageRunTier.tierCeiling : null;
        const intentMap =
          useStageMeta && stageRunIntent.intentMap !== null
            ? stageRunIntent.intentMap
            : fileRunMeta.intentMap;
        const evidenceChecklist =
          useStageMeta && stageRunIntent.evidenceChecklist.length > 0
            ? stageRunIntent.evidenceChecklist
            : fileRunMeta.evidenceChecklist;
        const workLogFile = workLogFileFor(context.projectRoot, sessionId, targetRunId);
        const workLog = readWorkLogEntries(context.projectRoot, sessionId, targetRunId);
        const requestedExplicit = requestedRaw.length > 0;
        if (!existsSync(planFile)) {
          if (requestedExplicit) {
            return Promise.resolve({
              ok: false,
              code: "plan-read-not-found",
              reason: `plan_read cannot find run file for runId "${targetRunId}" (${planFile}).`,
            });
          }
          return Promise.resolve({
            ok: true,
            mode: "run",
            runId: String(targetRunId),
            sessionId,
            planFile: "",
            workLogFile,
            workLog,
            items: [],
            intentMap,
            evidenceChecklist,
            tier: runTier,
            tierCeiling: runTierCeiling,
            notice: "no finalized plan for current run yet.",
          });
        }
        const items = readRunPlanItems(planFile);
        return Promise.resolve({
          ok: true,
          mode: "run",
          runId: String(targetRunId),
          sessionId,
          planFile,
          workLogFile,
          workLog,
          items,
          intentMap,
          evidenceChecklist,
          tier: runTier,
          tierCeiling: runTierCeiling,
          ...(items.length === 0 ? { notice: "run file exists but contains no plan items." } : {}),
        });
      },
    });

    let toolDisposers = [];
    function installTools() {
      if (toolDisposers.length > 0) return;
      try {
        toolDisposers.push(ctx.tools.register(whaleReportDef));
        toolDisposers.push(ctx.tools.register(planReadDef));
        toolDisposers.push(ctx.tools.register(kaSubWhaleDef));
        for (const reportDef of subWhaleReportDefs) {
          toolDisposers.push(ctx.tools.register(reportDef));
        }
      } catch (error) {
        ctx.logger.warn(`[ka-whale-workflow] 注册 ${WHALE_REPORT_TOOL}/${KA_SUB_WHALE_TOOL}/plan_read/sub-whale-report 失败：${error instanceof Error ? error.message : String(error)}`);
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
      /** k10-project-store：当前 agent 实际注入/使用的 task plan 文件（run 或 legacy）。 */
      taskPlanFileFor: (agent) => taskPlanPathForAgent(agent),
      /** k10-project-store：返回 taskPlanContextForAgent 的公开只读摘要。 */
      taskPlanContextFor: (agent) => {
        const context = taskPlanContextForAgent(agent);
        return context.mode === "run"
          ? {
              mode: "run",
              projectRoot: context.projectRoot,
              sessionId: context.sessionId,
              runId: context.runId,
              planFile: context.planFile,
            }
          : { mode: "legacy", file: context.file };
      },
      /** 7.4 P0 cost meter（只读 side-channel；其它插件用 recordInjectedChars 上报注入长度）。 */
      costMeter: {
        recordInjectedChars(agent, length) {
          if (agent === null || typeof agent !== "object") return false;
          const chars = Number(length);
          if (!Number.isFinite(chars) || chars <= 0) return false;
          return recordCostMeterAdd(agent, { injectedChars: Math.floor(chars) });
        },
        flush: () => costMeter.flush(),
        read: (sessionId, runId) => costMeter.read(sessionId, runId),
        fileFor: (sessionId, runId) => costMeter.fileFor(sessionId, runId),
      },
      /** 7.4 P1/P1b tier：只读记录 + 内部自动升级入口（P2 intentMap 接线；不是模型可见工具）。 */
      tierRecordOf: (agent) => workflowRunTierRecordFor(agent),
      upgradeRunTier: (agent, patch) => {
        // 统一走自动升级 helper：S→M 自动升级计一次 session 误判，写 upgradeHistory。
        return autoUpgradeMainRunTier(agent, patch ?? {});
      },
      /** session 级默认 tier 读 API（连续 2 次 S 误判 → "M"；分类阶段使用）。 */
      sessionTierDefaultOf: (sessionId) => stageStore.sessionTierDefaultOf(sessionId),
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
        const roleRecord = controlledSubagentRecordOfAgent(agent);
        const name = typeof exec?.name === "string" ? exec.name : "(unknown)";
        // 硬等门：最终报告将作为 subagent-settled 发出后，禁止继续调任何工具
        // （含再次 report），直到父主模型 send_message 到达清门。放在 stage
        // Allowed 检查之前，保证没有旁路。
        if (roleRecord !== null && roleRecord.awaitingParent === true) {
          ctx.logger.info(
            `[ka-whale-workflow] ${SUB_WHALE_REPORT_WAIT_DENY_CODE}: "${name}" blocked for ${controlledRole} subagent (awaitingParent=true)`,
          );
          return {
            kind: "deny",
            code: SUB_WHALE_REPORT_WAIT_DENY_CODE,
            reason:
              `${SUB_WHALE_REPORT_WAIT_DENY_CODE}: "${name}" is blocked because ${controlledRole} ` +
              `subagent has set awaitingParent=true; its full final report will be received as subagent-settled. ` +
              `No further tool calls ` +
              `(including ${V09_ROLE_REPORT_TOOLS[controlledRole] ?? "the role report tool"}) are allowed ` +
              `until the parent main model replies via send_message. Write your full report as your final message and end the turn.`,
          };
        }
        ensureControlledSubagentStarted(agent);
        const current = stageOfAgent(agent);
        const def = stageDefinitionFor(controlledRole, current);
        const roleMinimalTools = V09_SUBAGENT_ROLE_MINIMAL_TOOLS[controlledRole] ?? [];
        // 任何真实放行的受控子代理工具调用都视为 Minimal 解锁（不只依赖 session/event）：
        // 首次工具调用前 def===null（stage=idle），最小面工具调用即置 minimalDone。
        if (
          typeof exec?.name === "string" &&
          ((def !== null && def.allowedTools.includes(exec.name)) ||
            (def === null && roleMinimalTools.includes(exec.name)))
        ) {
          markSubagentMinimalDone(agent);
          return next();
        }
        if (def === null) return next();
        if (typeof exec?.name !== "string" || def.allowedTools.includes(exec.name)) return next();
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
      const mainTierRecord = workflowRunTierRecordFor(agent);
      const mainTierCtx =
        mainTierRecord !== null ? { tier: mainTierRecord.tier } : undefined;
      ctx.logger.info(
        `[ka-whale-workflow] workflow-stage-deny: "${name}" not allowed in stage "${current}"`,
      );
      return {
        kind: "deny",
        reason:
          `workflow-stage-deny: "${name}" is not allowed in current ka-whale-workflow stage "${current}". ` +
          `Allowed tools: [${def.allowedTools.join(", ")}]. Can advance to: [${advanceListFor(MAIN_ROLE, current, mainTierCtx).join(", ")}]. ` +
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
    //   - 用户插话不改变当前阶段；仅首轮/未开始且已解除极简时进入任务重构。
    //   - /goal /plan 等手动模式命令不再旁路鲸鱼工作流（Goal/Plan 模式已移除）。
    // -----------------------------------------------------------------------
    const pendingStart = new Set();

    // 子代理 dispose 时**不**删除角色注册：DSH continuable 子代理在每轮结束/被
    // interrupt 后可能 unload 成 ready（agent/disposed 会触发）；此时若删除
    // subagentRoles，父主 send_message 恢复时 controlled role 判定丢失，pending
    // 阶段注入不再发生，kaz-mode 也会把它当普通子代理退回 memory_search。
    // 真正已移除子代理的脏记录由 tryReuseMemoryMaintainer 经 subagents.listChildren
    // 对账清理（不在 children 列表即 removeSubagentRole），因此这里必须保留记录。
    ctx.on("agent/disposed", () => {
      // intentionally no-op: preserve continuable child role records across ready/unload.
    });

    ctx.on("agent/inbox/claimed", ({ agent, message, turn }) => {
      if (agent === null || agent === undefined || typeof agent !== "object") return;
      if (liveFor(agent).enabled !== true) return;
      // 受控 v0.9 子代理不受 includeSubagents=false 跳过：idle 时先进入其 role 首阶段。
      const controlledRole = controlledSubagentRoleOfAgent(agent);
      if (controlledRole !== null) {
        // 父主模型 send_message（coordinator/relay）到达：真终态（旧 communication
        // 兼容 / 合并尾部 terminal full report 已发出）重置新轮，中间态仅清门；
        // 先清门再 ensure，保证新轮从 role 初始阶段开始。
        clearAwaitingParentOnParentReply(agent, message);
        ensureControlledSubagentStarted(agent);
        return;
      }
      if (liveFor(agent).includeSubagents !== true && isSubagent(agent)) return;
      if (!isUserMessage(message)) return;
      const sessionId = agent?.session?.id || agent?.id;
      if (typeof sessionId !== "string" || sessionId.length === 0) return;
      const current = stageOfAgent(agent);
      // 第 2、3、4……轮（turn>=2，模型不在运行）：非终态活动阶段保留当前阶段；
      // 只有 idle/done/end/communication/（旧）compress_context_then_communication 或
      // 历史 goal-active/working-resumed 旧值才重新进入 assess-complexity（36.5；Goal 已移除）。
      if (typeof turn === "number" && turn >= 2) {
        const next = nextStageOnUserMessage(current, turn);
        if (setStageAgent(agent, next, turn)) {
          reportRoundDisplay(
            agent,
            next === "assess-complexity"
              ? "收到新一轮消息：从终态重新进入 assess-complexity。"
              : `收到新一轮消息：保留当前活动阶段 ${next}。`,
            "阶段切换",
          );
        }
        return;
      }
      // 插话（模型运行中）不改变当前工作流阶段；仅尚未开始（idle）时进入 assess-complexity。
      if (current !== "idle") return;
      if (isMinimal(agent)) {
        pendingStart.add(sessionId);
        return;
      }
      if (setStageAgent(agent, "assess-complexity", turn)) {
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

    /** 解析子代理 round-display 落点：优先 live agent，回退 session 对象。
     *  37.5：subagent-report/settled 到达父进程时 child 可能刚释放，session
     *  对象仍足以让 round-display 按 child session id + events 记录。 */
    function roundDisplayTargetOf(sessionId) {
      try {
        if (typeof sessionId !== "string" || sessionId.length === 0) return null;
        const agents = ctx.get("agents");
        if (agents !== undefined && agents !== null && typeof agents.get === "function") {
          const agent = agents.get(sessionId);
          if (agent !== undefined && agent !== null && typeof agent === "object") return agent;
        }
        const sessions = ctx.get("sessions");
        if (sessions !== undefined && sessions !== null && typeof sessions.get === "function") {
          const session = sessions.get(sessionId);
          if (session !== undefined && session !== null && typeof session === "object") return session;
        }
      } catch {
        // fall through
      }
      return null;
    }

    ctx.on("session/event", (session, event) => {
      if (event === null || typeof event !== "object" || event.type !== "tool/call") return;
      const sessionId = session !== null && typeof session === "object" && typeof session.id === "string"
        ? session.id
        : session?.sessionId;
      if (typeof sessionId !== "string" || sessionId.length === 0) return;
      const agent = sessionAgentOf(session);
      if (agent === null || agent === undefined || typeof agent !== "object") return;
      if (liveFor(agent).enabled !== true) return;
      // 受控 v0.9 子代理：首次 tool/call 持久化 minimalDone（resume/存储后仍视为
      // 已解锁），随后才进入 role 专属首阶段——与主模型“首次工具调用后才进
      // assess-complexity”的语义对齐。
      const controlledRole = controlledSubagentRoleOfAgent(agent);
      if (controlledRole !== null) {
        const marked = markSubagentMinimalDone(agent);
        if (marked) {
          reportRoundDisplay(
            agent,
            `受控 ${controlledRole} 子代理首次工具调用：minimalDone=true，工具面解锁。`,
            "工具面解锁",
          );
        }
        ensureControlledSubagentStarted(agent, { afterFirstTool: true });
        return;
      }
      if (!pendingStart.has(sessionId)) return;
      pendingStart.delete(sessionId);
      if (liveFor(agent).includeSubagents !== true && isSubagentSession(session)) return;
      const current = stageOfAgent(agent);
      if (current !== "idle") return;
      if (setStageAgent(agent, "assess-complexity")) {
        reportRoundDisplay(agent, "首阶段 Minimal 已解除，进入 assess-complexity。", "阶段切换");
      }
    });

    // -----------------------------------------------------------------------
    // 上下文注入：主 Persona 已由 kaz-system-prompt 作为 deployment:persona
    // 整段携带（不在此注入）；v0.9 阶段注入按 pending 精确一次。
    // -----------------------------------------------------------------------
    ctx.on("agent/pre-step", async (payload, next) => {
      const agent = payload?.agent;
      if (agent !== null && agent !== undefined && typeof agent === "object") {
        const live = liveFor(agent);
        const controlledRole = controlledSubagentRoleOfAgent(agent);
        // 7.4 P0 cost meter：agent/pre-step 一次 = 一次模型 request。
        // turns 从 round-display 同源（真实用户消息轮）镜像为最大值。
        if (live.enabled === true) {
          recordCostMeterAdd(agent, { modelRequests: 1 });
          const meterMessages = Array.isArray(payload?.messages) ? payload.messages : [];
          if (meterMessages.some((message) => isUserMessage(message))) {
            const userTurn =
              typeof payload?.turn === "number"
                ? payload.turn
                : currentTurnOf(agent);
            if (Number.isFinite(userTurn) && userTurn > 0) {
              recordCostMeterTurn(agent, userTurn);
            }
          }
          // 7.4 P1b：每次 request 增量后检查预算（主 S run 超预算立即升 M；
          // flag off / 非 S / 非 main 由 helper 内部短路，零行为变化）。
          autoUpgradeBudgetExceeded(agent);
        }
        // 受控 v0.9 子代理：先清父主 send_message 硬等门（claimed 已处理时此处幂等），
        // 再确保 role 专属首阶段已初始化，不走主模型新任务路由。
        if (controlledRole !== null && live.enabled === true) {
          const relayMessages = Array.isArray(payload?.messages) ? payload.messages : [];
          for (const relayMessage of relayMessages) {
            clearAwaitingParentOnParentReply(agent, relayMessage);
          }
          ensureControlledSubagentStarted(agent);
        }
        const skipSubagent =
          controlledRole === null && live.includeSubagents !== true && isSubagent(agent);
        const messages = Array.isArray(payload?.messages) ? payload.messages : [];
        const hasRealUserMessage = messages.some((message) => isUserMessage(message));
        const turn = typeof payload?.turn === "number" ? payload.turn : currentTurnOf(agent);
        if (live.enabled === true && controlledRole === null && !skipSubagent) {
          const stage = stageOfAgent(agent);
          if (hasRealUserMessage) {
            if (turn >= 2) {
              const next = nextStageOnUserMessage(stage, turn);
              if (setStageAgent(agent, next, turn)) {
                reportRoundDisplay(
                  agent,
                  next === "assess-complexity"
                    ? "收到新一轮消息：从终态重新进入 assess-complexity（pre-step 兜底）。"
                    : `收到新一轮消息：保留当前活动阶段 ${next}（pre-step 兜底）。`,
                  "阶段切换",
                );
              }
            } else if (stage === "idle" && !isMinimal(agent)) {
              if (setStageAgent(agent, "assess-complexity", turn)) {
                reportRoundDisplay(
                  agent,
                  "进入 assess-complexity（pre-step 兜底）。",
                  "阶段切换",
                );
              }
            }
          } else if (turn < 2 && stage === "idle" && !isMinimal(agent) && hasToolCall(agent)) {
            if (setStageAgent(agent, "assess-complexity", turn)) {
              reportRoundDisplay(
                agent,
                "首阶段 Minimal 已解除，进入 assess-complexity（pre-step 兜底）。",
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
      // 上下文注入：
      //   - 主 Persona 已是 kaz-system-prompt 整段 deployment:persona
      //     （KAZ_ROLE_PROMPTS.main），不再注入 user message；
      //   - 受控 v0.9 子代理只注入 role-specific stage；
      //   - v0.9 stage 注入按 pendingStageInjection 精确一次（同一 run 内重新
      //     进入某 stage 会再次 pending，因此会再次注入）。
      const liveNow = liveFor(agent);
      const controlledRoleNow = controlledSubagentRoleOfAgent(agent);
      const controlledRoleRecordNow =
        controlledRoleNow !== null ? controlledSubagentRecordOfAgent(agent) : null;
      const skipSubagentNow =
        controlledRoleNow === null && liveNow.includeSubagents !== true && isSubagent(agent);
      const subagentNow = isSubagent(agent);
      const sessionIdNow = sessionIdOf(agent);
      const turn = typeof payload?.turn === "number" ? payload.turn : currentTurnOf(agent);
      const messages = Array.isArray(decision.messages) ? decision.messages : [];
      // 兜底：若 claimed 未先清门（例如测试/内部投递直接进 pre-step），这里仍会在
      // 上下文注入前处理父主 send_message。claimed 已处理时本循环幂等无副作用。
      if (liveNow.enabled === true && controlledRoleNow !== null) {
        for (const message of messages) {
          clearAwaitingParentOnParentReply(agent, message);
        }
      }
      // Single subagent-settled channel: the child no longer writes a summary
      // through *_sub_whale_report. When the parent main agent receives a DSH
      // subagent-report/subagent-settled message, record the summary under BOTH
      // the parent/main agent and the child subagent session (resolved from
      // message.source.senderSessionId), keeping the main session summary and the
      // child page summary intact from the single settled message.
      if (
        liveNow.enabled === true &&
        controlledRoleNow === null &&
        !skipSubagentNow &&
        !subagentNow
      ) {
        const loggedChildIds = new Set();
        for (const message of messages) {
          const summary = subagentReportSummaryOf(message);
          if (summary.length === 0) continue;
          reportRoundDisplay(agent, summary, "子代理汇报", "subagent-report");
          const childId = subagentReportChildSessionIdOf(message);
          if (childId.length > 0 && childId !== sessionIdNow) {
            const childTarget = roundDisplayTargetOf(childId);
            if (childTarget !== null) {
              reportRoundDisplay(childTarget, summary, "子代理汇报", "subagent-report");
            }
            appendChildWorkLog({
              parentAgent: agent,
              childId,
              childRecord: null,
              message,
              loggedChildIds,
            });
          }
        }
      }
      let appended = false;
      if (liveNow.enabled === true && !skipSubagentNow) {
        // persona application（无双源/无一次性流程常量注入）：
        //   - main persona 由 kaz-system-prompt 每 step 以 deployment:persona 组装；
        //   - controlled v0.9 subagents 经 request.persona 携带 KAZ_ROLE_PROMPTS.subagent.*；
        //   - 旧 unknown-subagent 通用 SUBAGENT_FLOW_TEXT 注入路径已删除。

        // 首轮 startup hint：主模型与受控子代理在 idle + Minimal（首次工具调用前）
        // 都不注入完整 stage 正文；这里一次性提示先调用 memory_search / context_search
        // 解锁工作流。主模型首次 tool/call 后进入 assess-complexity；受控子代理首次
        // tool/call 后进入其 role 首阶段（challenge-plan / plan-memory / plan-plugin）。
        const isMainStartupCandidate = controlledRoleNow === null && !subagentNow;
        const isControlledStartupCandidate = controlledRoleNow !== null;
        const shouldInjectStartupHint =
          !skipSubagentNow &&
          (isMainStartupCandidate || isControlledStartupCandidate) &&
          typeof sessionIdNow === "string" &&
          sessionIdNow.length > 0 &&
          turn < 2 &&
          [
            ...(Array.isArray(payload?.messages) ? payload.messages : []),
            ...messages,
          ].some((message) => isUserMessage(message)) &&
          stageOfAgent(agent) === "idle" &&
          isMinimal(agent) &&
          !hasInjectedBefore(agent, FIRST_ROUND_STARTUP_FORM);
        if (shouldInjectStartupHint) {
          const startupHintText =
            controlledRoleNow !== null
              ? controlledStartupHintText(controlledRoleNow)
              : FIRST_ROUND_STARTUP_TEXT;
          try {
            const message = createUserMessage({
              content: [{ type: "text", text: startupHintText }],
              source: {
                kind: "plugin",
                plugin: "ka-whale-workflow",
                form: FIRST_ROUND_STARTUP_FORM,
              },
            });
            messages.push(message);
            appended = true;
            reportRoundDisplay(agent, startupHintText, "首轮 startup hint");
            recordCostMeterAdd(agent, { injectedChars: startupHintText.length });
          } catch (error) {
            ctx.logger.warn(
              `[ka-whale-workflow] 构造首轮 startup hint 注入消息失败：${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        // v0.9 阶段入口注入：每次进入 v0.9 stage 时 pending 一次，注入后即清除。
        if (typeof sessionIdNow === "string" && sessionIdNow.length > 0) {
          const pendingStage = stageStore.getPendingStageInjection(sessionIdNow);
          if (
            pendingStage !== null &&
            controlledRoleNow !== null &&
            // 硬等门守卫：report 送达后、父主 send_message 清门前的等待期，不注入
            // 下一 pending stage，也不 clear pending——保留给清门后的下一 pre-step。
            controlledRoleRecordNow !== null &&
            controlledRoleRecordNow.awaitingParent !== true
          ) {
            // 受控子代理：注入 role 专属 stage 文本；plugin 生命周期阶段附实际 lifecyclePath。
            // Minimal 首轮提示仅在会话尚未发生首次工具调用时随 stage 正文输出。
            const minimalTools = isMinimal(agent)
              ? [...(V09_SUBAGENT_ROLE_MINIMAL_TOOLS[controlledRoleNow] ?? [])]
              : undefined;
            const options = {
              ...(Array.isArray(minimalTools) && minimalTools.length > 0
                ? { minimalTools }
                : {}),
              ...(stageNeedsLifecyclePath(pendingStage)
                ? { lifecyclePath: lifecycleReferencePath }
                : {}),
            };
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
                recordCostMeterAdd(agent, { injectedChars: text.length });
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
            // 7.4 P1b：S run 进入 working 的入口复评必须发生在 stage 文本计算前；
            // 若该 run 已有任何 plan item（含 memory/plugin 需求），先升 M 再注入，
            // 使注入的 Can advance to: 行反映 M/static 边而非 S-only 边。
            if (pendingStage === "working") {
              autoUpgradeMainRunAtWorkingEntry(agent);
            }
            // Minimal 首轮提示：仅当会话尚未发生首次工具调用时随 main stage 正文输出。
            const mainMinimalTools = isMinimal(agent)
              ? ["memory_search", "context_search"]
              : undefined;
            const mainTierRecord = workflowRunTierRecordFor(agent);
            const options = {
              ...(Array.isArray(mainMinimalTools) && mainMinimalTools.length > 0
                ? { minimalTools: mainMinimalTools }
                : {}),
              ...(mainTierRecord !== null ? { tier: mainTierRecord.tier } : {}),
              ...(stageNeedsTaskPlanPath(pendingStage)
                ? { taskPlanPath: taskPlanPathForAgent(agent) }
                : {}),
              ...(stageNeedsLifecyclePath(pendingStage)
                ? { lifecyclePath: lifecycleReferencePath }
                : {}),
              ...(pendingStage === "decide-tools-before-writing-plan"
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
                recordCostMeterAdd(agent, { injectedChars: text.length });
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
      // 插件卸载前 flush 生命周期 + cost-meter 内存脏数据（进程退出/热重载都尽量不丢埋点）。
      try {
        costMeter.flush();
      } catch {
        // cost-meter 自身已 warn；卸载清理绝不阻塞。
      }
      if (lifecycleMemory.dirty) persistLifecycleNow();
    });
  },
};
