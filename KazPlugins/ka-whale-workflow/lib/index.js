// ka-whale-workflow —— 鲸鱼工作流（v0.8 Step A：主/子两套新流程 + 工具面稳定）
// ===========================================================================
// 流程：
//   1) 主模型注入 [ka-whale-workflow main flow]（一次/新会话），描述 v0.8 主线：
//      Minimal → 简单/复杂判断 → 质疑并找最小方案 → 明确工具/子代理需求 →
//      工作流 → Communication → 汇报候选记忆/技能建议。
//   2) 子代理注入 [ka-whale-workflow subagent flow]（一次），描述 v0.8 子线：
//      Minimal → 质疑委派 → 判断主模型指定工具是否足够 → Working/Communication →
//      汇报候选经验/技能建议（不自写记忆/技能）。
//   3) 非 complete goal 时按轮注入 [ka-whale-workflow goal continuation] 确认
//      继续原 Goal / 新任务 / 结束。
//   4) whale_report 在 Stable Main Surface 常驻，只做工作簿记/模式记录；不再触发
//      “只剩 whale_report”的阶段级工具面切换。
//
// 工具面（由 kaz-mode + kaz-shared 执行）：
//   - 主模型：minimal（首次工具调用前 ≤2）→ Stable Main Surface（固定集）；
//   - 子代理：minimal → Stable Subagent Base（Step A 静态保守集，assigned 待后续）；
//   - v0.8 Step B1：原生 Plan 已移除，纯 minimal → Stable Main 一次变化。
//
// 阶段状态（内部兼容）：
//   写入插件自己的 JSON 存储（~/.dsh/storages/ka-whale-workflow-stage.json，
//   按 session id 索引），重启/续接会话自然恢复。旧 reconstruction/classification
//   值只作存储兼容与 review/skill-review 边界；旧阶段文案不再注入，也不再注册
//   ka-whale-workflow:prompt system 段或做阶段工具过滤。
// ===========================================================================

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import {
  DEFAULT_RECONSTRUCTION_TOOLS,
  reviewGuidanceText,
  toolCallable,
  skillLifecycleCallable,
  skillReviewGuidanceText,
  SKILL_BOUNDARY_MAX_CHANGES,
  SKILL_PRIVATE_DIR_NAME,
  SKILL_PROCESS_DIR_NAME,
  ENABLE_TOOL,
  normalizeOptionalTools,
  compactOptionalToolDirectory,
  validateOptionalToolCount,
  AGENT_MANAGED_STORAGE_FILE,
  normalizeAgentManagedRegistry,
  normalizeSkillLifecycle,
  auditSkillLifecycle,
  projectRegistryFromLifecycle,
  transitionAllowed,
  skillKeyOf,
} from "kaz-shared";
import { readJsonFileSafe, writeJsonFileSafe } from "kaz-shared/lib/safe-json-file.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export { DEFAULT_RECONSTRUCTION_TOOLS };

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

/** whale_report：v0.8 Step A 后为 Stable Main Surface 常驻工具（不再由阶段临时放行）。 */
export const WHALE_REPORT_TOOL = "whale_report";

/** 用户手动指令开启模式的命令名（v0.8 Step B1：/plan 已移除，仅剩 /goal）。 */
const MANUAL_COMMAND_NAMES = ["goal"];

/** v0.8 Step A 主流程上下文注入文案（不再有 TaskReconstruction/Classification）。 */
export const MAIN_FLOW_TEXT = `[ka-whale-workflow main flow]
>
This session uses the v0.8 main-line workflow:
- Minimal (before the first tool call): judge whether the task is simple or complex using only the few visible tools.
- Simple: communicate the answer; do not expand the surface.
- Complex: challenge the user's proposed approach when needed, find the smallest-workable solution, decide what tools are required, and decide whether a subagent should create tools. Write the working plan with per-item subagent and tool assignments.
- If the task should be a Goal, start or resume it via the stable Goal tools (create_goal/get_goal/update_goal) or whale_report once; otherwise continue Working with the stable surface.
- During Working, keep gray reasoning concise; delegate specialized subtasks to subagent instead of expanding your own tool surface.
- Communicate results to Kaczev, then report candidate memory/skill suggestions. Memory/skill write tools belong to maintenance subagents only.
The tool surface is fixed after the first tool call: KAZ_BASE_TOOLS + Goal tools + whale_report + subagent. Old reconstruction/classification stage prompts no longer exist; do not wait for them.`;

/** v0.8 Step A 子代理流程上下文注入文案。 */
export const SUBAGENT_FLOW_TEXT = `[ka-whale-workflow subagent flow]
>
This session uses the v0.8 subagent workflow:
- Minimal (before the first tool call): judge whether the delegated task is simple or complex.
- If the delegation is ambiguous or complex: challenge it with the main model, find the minimal solution, and check whether the tools the main model specified are sufficient.
- Sufficient tools: go to Working.
- Insufficient tools: report to the main model (Communication) and ask for another delegation; do not explore or create tools on your own.
- Do not create a new subagent that carries tools. Do not write memory or skills yourself.
- At the end, report candidate experience/skill suggestions to the main model; actual writes are done by maintenance subagents.`;

/** 非 complete goal 时的继续/新任务/结束确认文案（替代旧 goal-recovery 提示）。 */
export const GOAL_CONTINUATION_TEXT = `[ka-whale-workflow goal continuation]
>
A non-complete goal already exists in this session. Before routing this human message as a new task, confirm Kaczev's intent with ask_user_question:
- Continue the original goal: resume it through the stable Goal tools (or whale_report({mode:'goal'}) without a new objective when a resume is actually needed).
- Start a new task: treat this message as a new main-flow task; do not silently modify or clear the existing goal.
- End the current goal: do not resume or silently create; tell Kaczev to complete/clear it or choose another option.`;

/** Goal 恢复阶段名：非 complete goal（blocked / paused / disarmed active）存在时使用。 */
export const GOAL_RECOVERY_STAGE = "goal-recovery";

/** 同一 turn/stage 内最多自动提醒次数（v0.8 Step A 不再用于旧阶段提示，保留常量以免破坏旧探针导入）。 */
export const MAX_WHALE_REMINDERS = 0;

/** v0.8 Step A 后不再需要阶段级 whale_report 提醒；保留空实现以免旧调用报错。 */
export function whaleReportReminderText(_stage) {
  return "";
}

/** 任务完成 / goal 结束时的紧凑复盘指引（方向1）：语义/文本已解耦到 kaz-shared。 */
export { reviewGuidanceText, skillReviewGuidanceText };

/** 设置 schema（同时驱动设置页 UI）。 */
const SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(true),
  /** 子代理是否也走鲸鱼工作流；默认关（与 round-minimal 的语义一致）。 */
  includeSubagents: z.boolean().default(false),
  /** 任务重构工具清单（配置面板代码框；白名单之上的过滤器）。 */
  reconstructionTools: z.array(z.string()).default([...DEFAULT_RECONSTRUCTION_TOOLS]),
  /** 第三次升级：任务分类工具选择总开关；关闭后回到旧“放行全量 Kaz 白名单”。 */
  taskToolSelectionEnabled: z.boolean().default(true),
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
  reconstructionTools: [...DEFAULT_RECONSTRUCTION_TOOLS],
  taskToolSelectionEnabled: true,
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
  const tools = normalizeToolList(value.reconstructionTools);
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
    reconstructionTools: tools.length > 0 ? tools : [...DEFAULT_RECONSTRUCTION_TOOLS],
    taskToolSelectionEnabled: value.taskToolSelectionEnabled !== false,
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

/** 由 audit 建议动作生成给 [skill Review] 的英文摘要；无动作返回空串。 */
export function lifecycleSummaryText(actions) {
  const list = Array.isArray(actions) ? actions : [];
  const autoRetired = list.filter((a) => a?.type === "retire").length;
  const pending = list.filter((a) => a?.type === "retire-pending").length;
  const needsUpdate = list.filter((a) => a?.type === "update-needed" || a?.type === "commit-update").length;
  const reconcile = list.filter((a) => a?.type === "reconcile-registry" || a?.type === "bootstrap-active").length;
  if (list.length === 0) return "";
  return `Lifecycle summary: auto-retired: ${autoRetired}; retire-pending: ${pending}; update-needed: ${needsUpdate}; reconcile/bootstrap: ${reconcile}.`;
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

/** 是否存在需要“Goal 恢复确认”的非 complete goal：blocked / paused / disarmed active。
 *  返回 goal view；无目标、complete、active+armed 或 activation 未知时返回 null。 */
export function goalRecoveryNeededOf(agent, goals) {
  const goal = currentGoalOf(agent, goals);
  if (goal === null || goal.phase === "complete") return null;
  if (goal.phase === "blocked" || goal.phase === "paused") return goal;
  if (goal.phase === "active" && goal.activation === "disarmed") return goal;
  return null;
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

/** 任务工具状态允许的 mode。 */
const TASK_TOOL_STATE_MODES = new Set(["normal", "plan", "goal"]);

/** 归一化一条任务工具状态；损坏/字段形状错误返回 null（调用方按“feature off”处理）。 */
export function normalizeTaskToolStateValue(raw) {
  if (raw === null || raw === undefined || typeof raw !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(raw, "initialOptionalTools") && !Array.isArray(raw.initialOptionalTools)) return null;
  if (Object.prototype.hasOwnProperty.call(raw, "jitEnabledTools") && !Array.isArray(raw.jitEnabledTools)) return null;
  if (raw.taskRunId !== undefined && !(Number.isInteger(raw.taskRunId) && raw.taskRunId > 0)) return null;
  if (raw.mode !== undefined && !TASK_TOOL_STATE_MODES.has(raw.mode)) return null;
  const initialOptionalTools = normalizeToolList(raw.initialOptionalTools);
  const jitEnabledTools = [];
  for (const entry of Array.isArray(raw.jitEnabledTools) ? raw.jitEnabledTools : []) {
    if (entry === null || typeof entry !== "object") continue;
    if (typeof entry.tool !== "string" || entry.tool.trim().length === 0) continue;
    jitEnabledTools.push({
      tool: entry.tool.trim(),
      reason: typeof entry.reason === "string" ? entry.reason : "",
      at: typeof entry.at === "string" ? entry.at : "",
    });
  }
  return {
    taskRunId: Number.isInteger(raw.taskRunId) && raw.taskRunId > 0 ? raw.taskRunId : 0,
    mode: TASK_TOOL_STATE_MODES.has(raw.mode) ? raw.mode : "normal",
    initialOptionalTools,
    jitEnabledTools,
  };
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

/**
 * 创建阶段状态存储（可注入文件路径，便于探针用临时文件）。
 * 结构：{ version: 3, sessions: { "<sessionId>": "reconstruction"|"goal-recovery"|"classification"|"done" },
 *        taskToolState: { "<sessionId>": { taskRunId, mode, initialOptionalTools, jitEnabledTools } },
 *        contractState: { "<sessionId>": { status, contractText, confirmedAt } } }
 * 旧文件缺少 taskToolState / contractState 时仍按旧版读取；损坏 JSON / 损坏状态一律丢弃。
 */
export function createStageStore(file) {
  const sessions = {};
  const taskToolState = {};
  const contractState = {};
  try {
    if (file !== undefined && file !== null && existsSync(file)) {
      let raw = readFileSync(file, "utf8");
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      const parsed = JSON.parse(raw);
      const data = parsed !== null && typeof parsed === "object" ? parsed.sessions : undefined;
      if (data !== null && typeof data === "object") {
        for (const [id, stage] of Object.entries(data)) {
          if (id.length > 0 && (stage === "reconstruction" || stage === "goal-recovery" || stage === "classification" || stage === "done")) {
            sessions[id] = stage;
          }
        }
      }
      const rawStates = parsed !== null && typeof parsed === "object" ? parsed.taskToolState : undefined;
      if (rawStates !== null && typeof rawStates === "object") {
        for (const [id, rawState] of Object.entries(rawStates)) {
          if (id.length === 0) continue;
          const normalized = normalizeTaskToolStateValue(rawState);
          if (normalized !== null) taskToolState[id] = normalized;
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
    }
  } catch {
    // 存储损坏时从空状态开始，不影响主流程
  }
  function persist() {
    if (typeof file !== "string" || file.length === 0) return true;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ version: 3, sessions, taskToolState, contractState }, null, 2) + String.fromCharCode(10), "utf8");
      return true;
    } catch {
      return false;
    }
  }
  return {
    file,
    get(sessionId) {
      return typeof sessionId === "string" && sessionId.length > 0 ? sessions[sessionId] ?? null : null;
    },
    set(sessionId, stage) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return false;
      sessions[sessionId] = stage;
      return persist();
    },
    remove(sessionId) {
      if (typeof sessionId === "string") delete sessions[sessionId];
      persist();
    },
    getTaskToolState(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return null;
      const value = taskToolState[sessionId];
      return value === undefined ? null : JSON.parse(JSON.stringify(value));
    },
    setTaskToolState(sessionId, value) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return false;
      const normalized = normalizeTaskToolStateValue(value);
      if (normalized === null) return false;
      taskToolState[sessionId] = normalized;
      return persist();
    },
    removeTaskToolState(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return false;
      if (!Object.prototype.hasOwnProperty.call(taskToolState, sessionId)) return false;
      delete taskToolState[sessionId];
      persist();
      return true;
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
  };
}

/** 从会话事件折叠旧版鲸鱼工作流阶段（兼容旧日志；只读，不再追加）。 */
function legacyStageOf(agent) {
  try {
    const events = agent?.session?.events;
    if (!Array.isArray(events)) return "idle";
    let stage = "idle";
    for (const event of events) {
      if (event === null || typeof event !== "object" || event.type !== "ka-whale-workflow/stage") continue;
      const value = event.data?.stage;
      if (value === "reconstruction" || value === "classification" || value === "done") stage = value;
    }
    return stage;
  } catch {
    return "idle";
  }
}

/** 读取当前阶段：插件 JSON 存储优先，旧会话事件兜底；无记录返回 "idle"。 */
export function stageOf(agent, store = null) {
  const sessionId = sessionIdOf(agent);
  if (store !== null && store !== undefined && typeof store.get === "function") {
    const stored = store.get(sessionId);
    if (stored === "reconstruction" || stored === "goal-recovery" || stored === "classification" || stored === "done") return stored;
  }
  return legacyStageOf(agent);
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

/** 新一轮真实用户消息（第 2、3、4……轮，模型不在运行）默认进入「任务重构」。
 *  非 complete goal 需要恢复确认时（context.goalRecovery 非空）先进入 goal-recovery；
 *  Goal 模式激活时（context.goalActive=true）保持 idle/done，不进入任务重构。
 *  v0.8 Step B1：原生 Plan 已移除，不再有 plan mode 分支。 */
export function nextStageOnUserMessage(current, _turn, context = {}) {
  if (context?.goalRecovery !== null && context?.goalRecovery !== undefined) {
    if (current === "idle" || current === "done" || current === GOAL_RECOVERY_STAGE) return GOAL_RECOVERY_STAGE;
  }
  if (context?.goalActive === true && (current === "idle" || current === "done")) return current;
  return "reconstruction";
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
    /** 当前会话的鲸鱼工作流阶段（JSON 存储优先，旧会话事件只读兜底）。 */
    function stageOfAgent(agent) {
      return stageOf(agent, stageStore);
    }
    /** 推进鲸鱼工作流阶段（写 JSON 存储；不再 append 会话事件）。
     *  进入 reconstruction = 新逻辑任务运行开始，递增 [ka-whale-memory Review] 与
     *  skill-review 各自的 taskRunId，并清除该 session 的旧任务工具状态
     *  （第三次升级：新一轮任务重新分类选择）。 */
    function setStageAgent(agent, stage) {
      const changed = setStage(agent, stage, stageStore);
      if (changed === true && stage === "reconstruction") {
        const sessionId = sessionIdOf(agent);
        if (typeof sessionId === "string" && sessionId.length > 0) {
          beginReviewTaskRun(sessionId);
          beginSkillReviewTaskRun(sessionId);
          stageStore.removeTaskToolState(sessionId);
          stageStore.removeContractState(sessionId);
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

    /** 第三次升级：任务工具选择是否开启（插件 enabled 且字段缺失按默认 true）。 */
    function taskToolSelectionEnabledFor(agent) {
      const current = liveFor(agent);
      return current?.enabled !== false && current?.taskToolSelectionEnabled !== false;
    }

    /** 从 kazMode 服务读取当前可选工具池；服务缺失/异常返回 null（视为特性不可用）。 */
    function kazModeTaskToolPoolFor(agent) {
      try {
        const svc = ctx.get("kazMode");
        if (svc !== undefined && svc !== null && typeof svc.taskToolPoolOf === "function") {
          const pool = svc.taskToolPoolOf(agent);
          return Array.isArray(pool) ? pool : null;
        }
      } catch {
        // fall through
      }
      return null;
    }

    /** 任务工具状态：特性未开 / 插件关 / manual bypass / 非 done / 无状态 → null。 */
    function taskToolStateOfAgent(agent) {
      if (agent === null || agent === undefined || typeof agent !== "object") return null;
      if (liveFor(agent).enabled !== true) return null;
      if (taskToolSelectionEnabledFor(agent) !== true) return null;
      if (isBypassed(agent)) return null;
      const sessionId = sessionIdOf(agent);
      if (sessionId === null) return null;
      if (stageOfAgent(agent) !== "done") return null;
      try {
        return stageStore.getTaskToolState(sessionId);
      } catch {
        return null;
      }
    }

    /** 分类阶段 compact optional-tool 目录：名字来自 kazMode 池，描述来自注册工具 schema。 */
    function optionalToolDirectoryFor(agent) {
      try {
        if (taskToolSelectionEnabledFor(agent) !== true) return "";
        const pool = kazModeTaskToolPoolFor(agent);
        if (!Array.isArray(pool)) return "";
        if (pool.length === 0) return "(no optional tools available)";
        const tools = ctx.get("tools");
        if (tools === undefined || tools === null || typeof tools.schemas !== "function") return "";
        const schemas = tools.schemas(agent);
        const byName = new Map();
        for (const schema of Array.isArray(schemas) ? schemas : []) {
          if (schema !== null && typeof schema === "object" && typeof schema.name === "string" && schema.name.length > 0) {
            byName.set(schema.name, typeof schema.description === "string" ? schema.description : "");
          }
        }
        return compactOptionalToolDirectory(
          pool.map((name) => ({ name, description: byName.get(name) ?? "" })),
        );
      } catch {
        return "";
      }
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

    /** 是否存在需要 Goal 恢复确认的非 complete goal（blocked / paused / disarmed active）。 */
    function goalRecoveryNeeded(agent) {
      return goalRecoveryNeededOf(agent, ctx.get("goals"));
    }

    /** memory_save 当前环境是否可调用（可用性判断已抽到 kaz-shared）。 */
    function memorySaveCallable(agent) {
      return toolCallable({ kazMode: ctx.get("kazMode"), tools: ctx.get("tools") }, agent, "memory_save");
    }

    /** 生效的自主 skill 管理配置（kazMode 面板优先；缺失时按默认开、每边界 1 个）。 */
    function skillAutonomyFor(agent) {
      const current = liveFor(agent);
      const enabled = current?.skillAutonomyEnabled !== false;
      const rawMax = current?.skillAutonomyMaxChangesPerBoundary;
      const maxChanges =
        Number.isInteger(rawMax) && rawMax >= 1
          ? Math.min(rawMax, SKILL_BOUNDARY_MAX_CHANGES)
          : SKILL_BOUNDARY_MAX_CHANGES;
      return { enabled, maxChanges };
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

    /** 尝试把本插件给模型发送的信息上报给 round-display（best-effort）。 */
    function reportRoundDisplay(agent, content, title) {
      try {
        const rd = ctx.get("roundDisplay");
        if (rd !== undefined && rd !== null && typeof rd.report === "function" && typeof content === "string" && content.trim().length > 0) {
          rd.report({ agent, plugin: "ka-whale-workflow", title: title || "工作流", content });
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
      // 防止“已自动续跑”的 paused goal 在 goal-recovery 残留阶段重复 resume 报错。
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
    // whale_report 工具：重构/分类各调用一次，向插件汇报阶段完成。
    // -----------------------------------------------------------------------
    const whaleReportDef = defineTool({
      name: WHALE_REPORT_TOOL,
      description:
        "Report workflow bookkeeping or mode to ka-whale-workflow. v0.8 Stable Main Surface keeps this tool constant; it no longer narrows the tool surface. Pass mode='goal' to create/resume a Goal, or no mode for normal completion. During goal continuation, pass mode='goal' only when a resume is actually needed; an already active+armed goal is a no-op. Native Plan was removed in v0.8 Step B1: mode='plan' is no longer accepted.",
      parameters: {
        mode: {
          type: "string",
          description:
            "'normal' (default) finishes workflow bookkeeping; 'goal' creates a new Goal or resumes a non-complete one. During goal continuation, pass 'goal' only when a resume is required; omit mode only when starting a new task.",
        },
        objective: {
          type: "string",
          description: "Required when mode='goal' creates a new goal (no current goal or current phase=complete). When a non-complete goal exists, omit objective to resume it; passing a different objective is rejected with guidance instead of silently creating a new goal.",
        },
        max_goal_rounds: {
          type: "number",
          description: "Optional positive integer for mode='goal': automatic continuation round cap.",
        },
        optional_tools: {
          type: "array",
          items: { type: "string" },
          description:
            "Deprecated in v0.8 Step A (main stable surface no longer uses task optional tools); retained only for old compatibility calls. Empty or omitted means deliberately use none.",
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
        if (current === GOAL_RECOVERY_STAGE) {
          // Goal 恢复：继续原 Goal → whale_report({mode:'goal'})；新任务 → whale_report()。
          if (args?.mode === "goal") {
            try {
              await launchGoalMode(agent, ctx.get("goals"), args);
            } catch (error) {
              return Promise.reject(error instanceof Error ? error : new Error(String(error)));
            }
            setStageAgent(agent, "done");
            reportRoundDisplay(agent, "已确认继续原 Goal，目标模式已恢复。", "工作流切换");
            return Promise.resolve({ ok: true, stage: "done", restarted: false });
          }
          if (setStageAgent(agent, "reconstruction")) {
            reportRoundDisplay(agent, "已确认开始新任务，进入新一轮主工作流。", "工作流切换");
          }
          return Promise.resolve({ ok: true, stage: "reconstruction", restarted: false });
        }
        // v0.8 Step A/B1：非 goal-recovery 状态下 whale_report 是一次性 bookkeeping；
        // 原生 Plan 已移除，不再接受 mode='plan'，只完成 normal/goal。
        if (args?.mode === "plan") {
          return Promise.reject(new Error("whale_report mode='plan' is no longer supported: native Plan was removed in v0.8 Step B1"));
        }
        const mode = args?.mode === "goal" ? "goal" : "normal";
        const launches = [];
        if (mode === "goal") {
          try {
            await launchGoalMode(agent, ctx.get("goals"), args);
            launches.push("goal");
          } catch (error) {
            return Promise.reject(error instanceof Error ? error : new Error(String(error)));
          }
        }
        setStageAgent(agent, "done");
        reportRoundDisplay(
          agent,
          "whale_report（模式：" + mode + (launches.length > 0 ? "，已启动 " + launches.join("、") : "") + "）：工作流记录完成，Stable Main Surface 不变。",
          "鲸鱼工作流",
        );
        return Promise.resolve({ ok: true, stage: "done", restarted: false });
      },
      presentCall: () => ({ card: "generic", title: "鲸鱼工作流汇报", kind: "other" }),
    });

    // -----------------------------------------------------------------------
    // enable_tool：任务内按需点亮 optional 工具（第三次升级 · 方案四 JIT escalation）。
    // 只允许点亮“当前 Kaz 生效面内、非基础、非模式限定、且本任务尚未启用”的 optional
    // 工具；reason 必填并持久化到 stage store 的 jitEnabledTools（审计即状态本身）。
    // -----------------------------------------------------------------------
    const enableToolDef = defineTool({
      name: ENABLE_TOOL,
      description:
        "Enable an optional tool for the current task. Only tools in the current Kaz optional pool (non-base, non-mode-scoped, currently enabled in Kaz) can be enabled, and only if they are not already enabled for this task. The reason is recorded in the task audit trail.",
      parameters: {
        tool: {
          type: "string",
          required: true,
          description: "Optional tool name to enable for this task.",
        },
        reason: {
          type: "string",
          required: true,
          description: "Required reason; recorded in the task audit trail.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            tool: { type: "string", required: true },
            reason: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const agent = exec?.agent;
        if (agent === null || agent === undefined || typeof agent !== "object") {
          return Promise.reject(new Error("enable_tool requires a calling agent"));
        }
        const sessionId = sessionIdOf(agent);
        if (sessionId === null) {
          return Promise.reject(new Error("enable_tool requires a session id"));
        }
        const state = taskToolStateOfAgent(agent);
        if (state === null) {
          const msg = "enable_tool denied: task tool filtering is inactive (feature disabled, no task tool state, or manual bypass)";
          ctx.logger.info(`[ka-whale-workflow] ${msg}`);
          return Promise.reject(new Error(msg));
        }
        const tool = typeof args?.tool === "string" ? args.tool.trim() : "";
        const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
        if (tool.length === 0) {
          const msg = "enable_tool denied: missing tool";
          ctx.logger.info(`[ka-whale-workflow] ${msg}`);
          return Promise.reject(new Error(msg));
        }
        if (reason.length === 0) {
          const msg = "enable_tool denied: missing reason (reason is required and recorded)";
          ctx.logger.info(`[ka-whale-workflow] ${msg}`);
          return Promise.reject(new Error(msg));
        }
        if (reason.length > 300) {
          const msg = "enable_tool denied: reason exceeds 300 characters";
          ctx.logger.info(`[ka-whale-workflow] ${msg}`);
          return Promise.reject(new Error(msg));
        }
        const pool = kazModeTaskToolPoolFor(agent);
        if (!Array.isArray(pool) || pool.length === 0 || !pool.includes(tool)) {
          const allowed = Array.isArray(pool) && pool.length > 0 ? pool.join(", ") : "(no optional tools available)";
          const msg = `enable_tool denied: "${tool}" is not in the current optional tool pool (base/mode-scoped/unknown/not in Kaz surface). Allowed: ${allowed}`;
          ctx.logger.info(`[ka-whale-workflow] ${msg}`);
          return Promise.reject(new Error(msg));
        }
        const initial = Array.isArray(state.initialOptionalTools) ? state.initialOptionalTools : [];
        const jit = Array.isArray(state.jitEnabledTools) ? state.jitEnabledTools : [];
        if (initial.includes(tool)) {
          const msg = `enable_tool denied: "${tool}" is already enabled as an initial optional tool for this task`;
          ctx.logger.info(`[ka-whale-workflow] ${msg}`);
          return Promise.reject(new Error(msg));
        }
        if (jit.some((entry) => entry !== null && typeof entry === "object" && entry.tool === tool)) {
          const msg = `enable_tool denied: "${tool}" is already enabled for this task`;
          ctx.logger.info(`[ka-whale-workflow] ${msg}`);
          return Promise.reject(new Error(msg));
        }
        const entry = { tool, reason, at: new Date().toISOString() };
        const saved = stageStore.setTaskToolState(sessionId, {
          ...state,
          jitEnabledTools: [...jit, entry],
        });
        if (saved !== true) {
          const msg = "enable_tool failed: could not persist task tool state";
          ctx.logger.info(`[ka-whale-workflow] ${msg}`);
          return Promise.reject(new Error(msg));
        }
        reportRoundDisplay(agent, `enable_tool: ${tool} (${reason})`, "任务工具面");
        ctx.logger.info(`[ka-whale-workflow] enable_tool ok: ${tool} (${reason}) session=${sessionId}`);
        return Promise.resolve({ ok: true, tool, reason });
      },
      presentCall: () => ({ card: "generic", title: "点亮任务工具", kind: "other" }),
    });

    let toolDisposers = [];
    function installTools() {
      if (toolDisposers.length > 0) return;
      try {
        toolDisposers.push(ctx.tools.register(whaleReportDef));
        toolDisposers.push(ctx.tools.register(enableToolDef));
      } catch (error) {
        ctx.logger.warn(`[ka-whale-workflow] 注册 ${WHALE_REPORT_TOOL}/${ENABLE_TOOL} 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    function uninstallTools() {
      for (const dispose of toolDisposers) {
        try {
          dispose();
        } catch (error) {
          ctx.logger.warn(`[ka-whale-workflow] 注销 ${WHALE_REPORT_TOOL} 失败：${error instanceof Error ? error.message : String(error)}`);
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
      version: 1,
      stageOf: (agent) => stageOfAgent(agent),
      enabledFor: (agent) => liveFor(agent).enabled === true,
      taskToolStateOf: (agent) => taskToolStateOfAgent(agent),
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
    // 终案 E 运行时接线：tools/result 埋点 + 后台周期审计 + 启动 dry-run。
    // 监听器内部都会再读总开关；timer 服务缺失时静默降级（离线探针兼容）。
    // -----------------------------------------------------------------------

    /** 从 ask_user_question 的结果推断用户对任务契约的选择，并写入 stage store。 */
    function recordContractFromAskResult(exec, result) {
      try {
        if (exec === null || exec === undefined || typeof exec !== "object") return;
        if (exec.name !== "ask_user_question") return;
        const agent = exec.agent;
        const sessionId = sessionIdOf(agent);
        if (typeof sessionId !== "string" || sessionId.length === 0) return;
        if (stageOfAgent(agent) !== "classification") return;
        const text = JSON.stringify(result ?? {});
        const lower = text.toLowerCase();
        let status = null;
        if (/(确认|confirm)/.test(lower)) status = "confirmed";
        else if (/(修改|modify|调整)/.test(lower)) status = "modified";
        else if (/(放弃|abandon|取消)/.test(lower)) status = "abandoned";
        if (status === null) return;
        const existing = stageStore.getContractState(sessionId) ?? { status: "none", contractText: "", confirmedAt: "" };
        stageStore.setContractState(sessionId, {
          ...existing,
          status,
          confirmedAt: status === "confirmed" ? new Date().toISOString() : existing.confirmedAt,
        });
        ctx.logger.info(
          `[ka-whale-workflow] 任务契约 ask_user_question 结果写入 stage store：${status} (session=${sessionId})`,
        );
      } catch (error) {
        ctx.logger?.debug?.(
          `[ka-whale-workflow] 记录 ask_user_question 契约结果失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    try {
      const disposer = ctx.on("tools/result", (exec, result) => {
        try {
          recordContractFromAskResult(exec, result);
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
    /** 每个 session 在当前 turn/stage 已自动提醒过的次数（防止 steer 死循环）。 */
    const turnReminderCounts = new Map();
    /** [ka-whale-memory Review] task-run 状态：每 session { kinds, taskRunId, injectedRunId }。
     *  kinds = session 级“每 kind 最多一次”；taskRunId = 逻辑任务运行标识；
     *  injectedRunId = 上次注入所属的 taskRunId（同一任务运行最多注入一次复盘）。 */
    const reviewRunState = new Map();
    /** 技能自省（skill-review）task-run 状态：与 memory review 同构但独立，
     *  每 session { kinds, taskRunId, injectedRunId }；同一逻辑任务运行最多注入一次。 */
    const skillReviewRunState = new Map();
    /** 技能自省用的 goal 激活状态观察（与 memory review 相互独立；v0.8 Step B1 无 plan）。 */
    const skillLastGoalActive = new Map();
    /** 每 session 上一次观察到的 goal 激活状态（用于检测结束节点）。 */
    const lastGoalActive = new Map();

    /** 进入新的逻辑任务运行：进入 reconstruction 或新 goal 激活时递增 taskRunId。 */
    function beginReviewTaskRun(sessionId) {
      let state = reviewRunState.get(sessionId);
      if (state === undefined) {
        state = { kinds: new Set(), taskRunId: 0, injectedRunId: null };
      }
      state.taskRunId += 1;
      reviewRunState.set(sessionId, state);
    }

    /** 读取（惰性创建）[ka-whale-memory Review] 运行状态。 */
    function reviewRunStateOf(sessionId) {
      let state = reviewRunState.get(sessionId);
      if (state === undefined) {
        state = { kinds: new Set(), taskRunId: 0, injectedRunId: null };
        reviewRunState.set(sessionId, state);
      }
      return state;
    }

    /** 进入新的逻辑任务运行：skill-review 的独立 taskRunId（与 memory review 同步递增点）。 */
    function beginSkillReviewTaskRun(sessionId) {
      let state = skillReviewRunState.get(sessionId);
      if (state === undefined) {
        state = { kinds: new Set(), taskRunId: 0, injectedRunId: null };
      }
      state.taskRunId += 1;
      skillReviewRunState.set(sessionId, state);
    }

    /** 读取（惰性创建）skill-review 运行状态。 */
    function skillReviewRunStateOf(sessionId) {
      let state = skillReviewRunState.get(sessionId);
      if (state === undefined) {
        state = { kinds: new Set(), taskRunId: 0, injectedRunId: null };
        skillReviewRunState.set(sessionId, state);
      }
      return state;
    }

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
      if (liveFor(agent).includeSubagents !== true && isSubagent(agent)) return;
      if (!isUserMessage(message)) return;
      const sessionId = agent?.session?.id || agent?.id;
      if (typeof sessionId !== "string" || sessionId.length === 0) return;
      // /goal 命令触发的消息：只跳过鲸鱼工作流，round-minimal 极简仍生效。
      const manual = consumeManualCommand(agent);
      if (manual !== null) {
        manualBypassSessions.add(sessionId);
        // 直接 /goal 旁路 = 新逻辑任务运行且没有分类选择：清除旧任务工具状态，
        // 本轮 taskToolStateOf 因 manualBypassSessions 命中而返回 null（任务过滤关闭）。
        stageStore.removeTaskToolState(sessionId);
        reportRoundDisplay(agent, `检测到 /${manual.name} 指令：本消息跳过鲸鱼工作流，直接放行白名单工具。`, "工作流旁路");
        return;
      }
      manualBypassSessions.delete(sessionId);
      const current = stageOfAgent(agent);
      const goalActive = goalModeActive(agent);
      const recoveryGoal = goalRecoveryNeeded(agent);
      // 第 2、3、4……轮（turn>=2，模型不在运行）：有非 complete goal 时先进
      // Goal 恢复确认；否则 Goal 模式激活时保持 idle/done，不进入任务重构；
      // 其余进入任务重构。
      if (typeof turn === "number" && turn >= 2) {
        const next = nextStageOnUserMessage(current, turn, { goalActive, goalRecovery: recoveryGoal });
        if (setStageAgent(agent, next)) {
          reportRoundDisplay(
            agent,
            next === GOAL_RECOVERY_STAGE
              ? "收到新一轮消息：存在非 complete goal，先确认是否继续原 Goal。"
              : "收到新一轮消息，重新进入主工作流。",
            "阶段切换",
          );
        }
        return;
      }
      // 插话（模型运行中）不改变当前工作流阶段；仅尚未开始（idle）时进入任务重构。
      if (current !== "idle") return;
      // Goal 模式激活时不开启任务重构，保持在当前模式。
      if (goalActive) return;
      // 非 complete goal（如 blocked）在 idle 起手时也先进入 Goal 恢复确认。
      if (recoveryGoal !== null) {
        if (setStageAgent(agent, GOAL_RECOVERY_STAGE)) {
          reportRoundDisplay(agent, "存在非 complete goal，先确认是否继续原 Goal。", "阶段切换");
        }
        return;
      }
      if (isMinimal(agent)) {
        pendingStart.add(sessionId);
        return;
      }
      if (setStageAgent(agent, "reconstruction")) {
        reportRoundDisplay(agent, "进入新一轮主工作流。", "阶段切换");
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
      if (liveFor(agent).includeSubagents !== true && isSubagentSession(session)) return;
      const current = stageOfAgent(agent);
      if (current !== "idle") return;
      // Goal 模式激活时不开启任务重构，保持在当前模式。
      if (goalModeActive(agent)) return;
      // 非 complete goal（如 blocked）在 round-minimal 解除后也先进 Goal 恢复确认。
      if (goalRecoveryNeeded(agent) !== null) {
        if (setStageAgent(agent, GOAL_RECOVERY_STAGE)) {
          reportRoundDisplay(agent, "round-minimal 已解除：存在非 complete goal，先确认是否继续原 Goal。", "阶段切换");
        }
        return;
      }
      if (setStageAgent(agent, "reconstruction")) {
        reportRoundDisplay(agent, "round-minimal 已解除，进入新一轮主工作流。", "阶段切换");
      }
    });

    // -----------------------------------------------------------------------
    // 任务完成 / goal 结束节点：注入紧凑复盘指引（方向1）。
    //   只在 ka-whale-workflow 进入 done 后（任务被执行）且检测到结束节点时触发；
    //   每 session 每种类型最多注入一次；没有实质结论时模型应不写记忆。
    //   v0.8 Step B1：原生 Plan 已移除，不再有 plan kind 复盘边界。
    // -----------------------------------------------------------------------
    ctx.on("agent/turn-stopping", ({ agent, signal }) => {
      if (agent === null || agent === undefined || typeof agent !== "object") return;
      if (signal?.aborted === true) return;
      if (liveFor(agent).enabled !== true) return;
      if (liveFor(agent).includeSubagents !== true && isSubagent(agent)) return;
      if (isBypassed(agent)) return;
      const stage = stageOfAgent(agent);
      if (stage !== "done") return;
      const sessionId = sessionIdOf(agent);
      if (typeof sessionId !== "string" || sessionId.length === 0) return;
      const goalActive = goalModeActive(agent);
      const prevGoal = lastGoalActive.get(sessionId);
      lastGoalActive.set(sessionId, goalActive);
      // 新 goal 激活 = 新的逻辑任务运行（例如 /goal 或 goal 模式启动）。
      if (prevGoal === false && goalActive === true) {
        beginReviewTaskRun(sessionId);
        beginSkillReviewTaskRun(sessionId);
      }

      const inject = (kind) => {
        if (memorySaveCallable(agent) !== true) return false;
        const state = reviewRunStateOf(sessionId);
        // session 级：每种 kind（normal/goal）在整个 session 最多注入一次。
        if (state.kinds.has(kind)) return false;
        // task-run 级：同一个逻辑任务运行内最多注入一次复盘，先到边界获胜。
        if (state.injectedRunId !== null && state.injectedRunId === state.taskRunId) return false;
        const text = reviewGuidanceText(kind);
        let message;
        try {
          message = createUserMessage({
            content: [{ type: "text", text }],
            source: { kind: "plugin", plugin: "ka-whale-workflow", form: "review" },
          });
        } catch (error) {
          ctx.logger.warn(`[ka-whale-workflow] 构造复盘指引消息失败：${error instanceof Error ? error.message : String(error)}`);
          return false;
        }
        agent.steer(message);
        state.kinds.add(kind);
        state.injectedRunId = state.taskRunId;
        reviewRunState.set(sessionId, state);
        reportRoundDisplay(agent, text, "复盘指引");
        return true;
      };

      // Goal 结束：上一次 active，当前不再 active。
      if (prevGoal === true && goalActive === false) {
        inject("goal");
        return;
      }
      // Normal 任务完成：done 且当前无 goal 激活（每个 session 只注入一次 normal）。
      if (!goalActive) {
        inject("normal");
      }
    });

    // -----------------------------------------------------------------------
    // 二阶段技能自省（skill-review）：与 [ka-whale-memory Review] 同一批安全边界，
    // 但使用独立 form、独立 per-session per-kind 去重、独立可用性守卫；
    // 受 skillAutonomyEnabled 开关控制，且仅当技能闭环基础工具可用时注入。
    // -----------------------------------------------------------------------
    ctx.on("agent/turn-stopping", ({ agent, signal }) => {
      if (agent === null || agent === undefined || typeof agent !== "object") return;
      if (signal?.aborted === true) return;
      if (liveFor(agent).enabled !== true) return;
      if (liveFor(agent).includeSubagents !== true && isSubagent(agent)) return;
      if (isBypassed(agent)) return;
      const stage = stageOfAgent(agent);
      if (stage !== "done") return;
      const sessionId = sessionIdOf(agent);
      if (typeof sessionId !== "string" || sessionId.length === 0) return;
      const autonomy = skillAutonomyFor(agent);
      if (autonomy.enabled !== true) return;
      if (
        skillLifecycleCallable(
          { kazMode: ctx.get("kazMode"), tools: ctx.get("tools") },
          agent,
        ) !== true
      ) {
        return;
      }
      const goalActive = goalModeActive(agent);
      const prevGoal = skillLastGoalActive.get(sessionId);
      skillLastGoalActive.set(sessionId, goalActive);
      // 新 goal 激活 = 新的逻辑任务运行（skill-review 独立 taskRunId）。
      if (prevGoal === false && goalActive === true) beginSkillReviewTaskRun(sessionId);

      // 终案 E：在 [skill Review] 注入前跑一次真实审计（每边界最多 1 个自动动作），
      // 并把 lifecycle 摘要注入自省文本。
      let lifecycleSummary = "";
      if (skillLifecycleFor(agent).enabled === true) {
        try {
          const auditResult = runLifecycleAudit({ source: "boundary", agent, dryRun: false });
          lifecycleSummary = lifecycleSummaryText(
            Array.isArray(auditResult?.suggested) ? auditResult.suggested : [],
          );
        } catch (error) {
          ctx.logger?.debug?.(
            `[ka-whale-workflow] boundary lifecycle audit 失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      const injectSkill = (kind) => {
        const state = skillReviewRunStateOf(sessionId);
        // session 级：每种 kind（normal/goal）在整个 session 最多注入一次。
        if (state.kinds.has(kind)) return false;
        // task-run 级：同一个逻辑任务运行内最多注入一次 skill-review，先到边界获胜。
        if (state.injectedRunId !== null && state.injectedRunId === state.taskRunId) return false;
        const text = skillReviewGuidanceText(
          kind,
          skillProcessFolderOf(agent),
          skillPrivateRootOf(agent),
          lifecycleSummary,
        );
        let message;
        try {
          message = createUserMessage({
            content: [{ type: "text", text }],
            source: { kind: "plugin", plugin: "ka-whale-workflow", form: "skill-review" },
          });
        } catch (error) {
          ctx.logger.warn(`[ka-whale-workflow] 构造技能自省指引消息失败：${error instanceof Error ? error.message : String(error)}`);
          return false;
        }
        agent.steer(message);
        state.kinds.add(kind);
        state.injectedRunId = state.taskRunId;
        skillReviewRunState.set(sessionId, state);
        reportRoundDisplay(agent, text, "技能自省");
        return true;
      };

      // 与 memory review 相同的边界判定：Goal 结束 / Normal 完成（无 Plan）。
      if (prevGoal === true && goalActive === false) {
        injectSkill("goal");
        return;
      }
      if (!goalActive) {
        injectSkill("normal");
      }
    });

    // -----------------------------------------------------------------------
    // 上下文注入：主/子流程与 Goal 继续确认按 turn 去重注入一次。
    // -----------------------------------------------------------------------
    ctx.on("agent/pre-step", async (payload, next) => {
      const agent = payload?.agent;
      if (agent !== null && agent !== undefined && typeof agent === "object") {
        const live = liveFor(agent);
        const skipSubagent = live.includeSubagents !== true && isSubagent(agent);
        const messages = Array.isArray(payload?.messages) ? payload.messages : [];
        const hasRealUserMessage = messages.some((message) => isUserMessage(message));
        const turn = typeof payload?.turn === "number" ? payload.turn : currentTurnOf(agent);
        const bypassed = isBypassed(agent);
        if (live.enabled === true && !skipSubagent && !bypassed) {
          const stage = stageOfAgent(agent);
          const goalActive = goalModeActive(agent);
          const recoveryGoal = goalRecoveryNeeded(agent);
          if (hasRealUserMessage) {
            if (turn >= 2) {
              const next = nextStageOnUserMessage(stage, turn, { goalActive, goalRecovery: recoveryGoal });
              if (setStageAgent(agent, next)) {
                reportRoundDisplay(
                  agent,
                  next === GOAL_RECOVERY_STAGE
                    ? "收到新一轮消息：存在非 complete goal，先确认是否继续原 Goal（pre-step 兜底）。"
                    : "收到新一轮消息，重新进入主工作流（pre-step 兜底）。",
                  "阶段切换",
                );
              }
            } else if (stage === "idle" && !isMinimal(agent) && !goalActive) {
              const next = recoveryGoal !== null ? GOAL_RECOVERY_STAGE : "reconstruction";
              if (setStageAgent(agent, next)) {
                reportRoundDisplay(
                  agent,
                  next === GOAL_RECOVERY_STAGE
                    ? "进入 Goal 恢复确认（pre-step 兜底）。"
                    : "进入新一轮主工作流（pre-step 兜底）。",
                  "阶段切换",
                );
              }
            }
          } else if (turn < 2 && stage === "idle" && !isMinimal(agent) && hasToolCall(agent) && !goalActive) {
            const next = recoveryGoal !== null ? GOAL_RECOVERY_STAGE : "reconstruction";
            if (setStageAgent(agent, next)) {
              reportRoundDisplay(
                agent,
                next === GOAL_RECOVERY_STAGE
                  ? "round-minimal 已解除，先确认是否继续原 Goal（pre-step 兜底）。"
                  : "round-minimal 已解除，进入新一轮主工作流（pre-step 兜底）。",
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
      // v0.8 Step A：主/子流程上下文只以追加历史消息注入一次；Goal 继续确认在
      // goal-recovery 时按轮注入。不再注入 TaskReconstruction/TaskClassification。
      const liveNow = liveFor(agent);
      const skipSubagentNow = liveNow.includeSubagents !== true && isSubagent(agent);
      const stageNow = stageOfAgent(agent);
      const subagentNow = isSubagent(agent);
      const turn = typeof payload?.turn === "number" ? payload.turn : currentTurnOf(agent);
      if (liveNow.enabled === true && !skipSubagentNow && !isBypassed(agent)) {
        const recoveryNow = stageNow === GOAL_RECOVERY_STAGE;
        const form = recoveryNow ? "goal-continuation" : subagentNow ? "subagent-flow" : "main-flow";
        const alreadyInjectedTurn = hasInjectedInTurn(agent, form, turn);
        const alreadyInjectedBefore = !recoveryNow && hasInjectedBefore(agent, form);
        if (!alreadyInjectedTurn && !alreadyInjectedBefore) {
          const text = recoveryNow ? GOAL_CONTINUATION_TEXT : subagentNow ? SUBAGENT_FLOW_TEXT : MAIN_FLOW_TEXT;
          let message;
          try {
            message = createUserMessage({
              content: [{ type: "text", text }],
              source: { kind: "plugin", plugin: "ka-whale-workflow", form },
            });
          } catch (error) {
            ctx.logger.warn(
              `[ka-whale-workflow] 构造主/子流程上下文消息失败：${error instanceof Error ? error.message : String(error)}`,
            );
            return decision;
          }
          reportRoundDisplay(
            agent,
            text,
            recoveryNow ? "Goal 继续确认" : subagentNow ? "子代理流程" : "主流程",
          );
          return {
            ...decision,
            messages: Array.isArray(decision.messages) ? [...decision.messages, message] : decision.messages,
          };
        }
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
