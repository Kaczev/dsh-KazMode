// ka-whale-workflow —— 鲸鱼工作流（任务重构 → 任务分类 → done）
// ===========================================================================
// 流程：
//   1) 首轮真实用户消息（turn=1）进入「任务重构」：
//        - 系统提示词段 ka-whale-workflow:prompt 显示重构 prompt；
//        - 上下文注入 [ka-whale-workflow TaskReconstruction]；
//        - 工具面收敛为「ka-whale-workflow 配置面板重构清单 ∩ Kaz 白名单」
//          + 自动启用面板临时放行的 whale_report。
//   2) whale_report 后进入「任务分类」：
//        - 系统提示词段切为分类 prompt；
//        - 上下文注入 [ka-whale-workflow TaskClassification]；
//        - 工具面收敛为 whale_report。
//   3) whale_report({mode}) 自动启动 plan/goal 后进入 done：不再过滤，放行 Kaz 白名单。
//      plan 模式由 whale_report 内部经 create_plan 工具（planning isolate 组内）切换，
//      因为 whale_report 自身在 host 层解析不到 planMode 服务。
//   4) 插话（模型运行中，同一轮中途追加消息）不改变当前工作流阶段。
//      第 2、3、4……轮（turn>=2、模型不在运行）直接重新进入「任务重构」；
//      Plan/Goal 模式激活时除外——用户回复不进入任务重构，保持在当前模式。
//   5) 用户通过 /plan 或 /goal 指令开启模式的那一条消息：跳过鲸鱼工作流，
//      不进入任务重构；round-minimal 极简过滤仍照常生效。
//
// 与 round-minimal：
//   round-minimal 优先。极简阶段（首次工具调用前）不进入重构；第一次 tool/call
//   解除极简后立刻进入重构。命令旁路不影响 round-minimal。
//
// 阶段状态：
//   写入插件自己的 JSON 存储（~/.dsh/storages/ka-whale-workflow-stage.json，
//   按 session id 索引），重启/续接会话自然恢复。
//   不再写入会话事件 ka-whale-workflow/stage——DSH 会把未知自定义事件视为
//   "not marked ignorable"，导致重载会话日志时拒绝读取整条日志。
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

/** whale_report：由 kaz_tool_auto_on「鲸鱼工作流」临时放行（重构 + 分类）。 */
export const WHALE_REPORT_TOOL = "whale_report";

/** create_plan：planning isolate 组内的 realm 桥。whale_report 通过它进入/退出 plan 模式。 */
const CREATE_PLAN_TOOL = "create_plan";

/** 用户手动指令开启模式的命令名（/plan、/goal）。 */
const MANUAL_COMMAND_NAMES = ["plan", "goal"];

/** 任务重构 prompt（草案原文；<工具列表> 渲染为当前阶段实际可见工具）。 */
export const RECONSTRUCTION_PROMPT =`Task reconstruction stage: rewrite the user's request into a structured task description preserving all key points, intent, and system-level constraints. No analysis, diagnosis, or solutions — later.

Write it in English even for Chinese input; it's context for classification (next stage), not a user deliverable; English saves tokens.

Record:
- Clarity: fully specified / partially specified / open-ended
- Open design decisions: unspecified choices the task requires
- Deliverable shape: text / code / page / plan / analysis / other
- Exploration or design needed: codebase exploration, option comparison, or approach design?
- Expected shape: single-turn answer / multi-round iterative / plan-then-approval

Keep original ambiguity; don't silently concretize vague requests; quote/summarize what's open. Mark design-type: design, proposal, "why", or how-to-improve requests.

Only use <工具列表> tools. When done, call whale_report to proceed to classification. Call whale_report before ending your turn; never end this stage with only the stage text.`;

/** 任务分类 prompt：无任务工具选择段的基础版（特性关闭 / 服务不可用时的 back-compat）。 */
export const CLASSIFICATION_PROMPT_BODY = `We are now in the task classification stage. Based on the reconstructed task description — including its clarity and open-design metadata — decide which execution mode best fits.

Use this decision order:
1. Normal — only if the task is fully specified, requires no exploration or design decisions, and can be completed in one turn.
2. Plan — if the task involves significant unknowns, open design choices, requires exploring the codebase, or asks for a design, a proposal, a migration plan, an analysis, or an explanation of why/how something should change.
3. Goal — clear objective, naturally multi-turn (iterative build-and-refine, progress tracking, recovery). When chosen: split into small todos, do one per round, never finish the whole goal in one turn.

Tie-breakers:
- If unsure between Normal and Plan, prefer Plan when the user asked for design, a proposal, or "why / how to improve".
- Generating a code snippet is Normal only when the request is concrete and single-turn. Building/designing a page or feature with unspecified details is Plan (or Goal when the user gave a clear objective to iterate on).
- Do not rely only on the cleaned reconstruction: preserve signals from the original request's ambiguity.

Call whale_report with the chosen mode; it will launch plan/goal mode if needed and quit task classification stage. Call whale_report before ending your turn; never end this stage with only the stage text.`;

/** 任务分类 prompt（完整版）：任务工具选择开启时渲染 <可选工具目录> 并强制 optional_tools。 */
export const CLASSIFICATION_PROMPT = `${CLASSIFICATION_PROMPT_BODY}

Optional tools for this task (non-base, currently enabled in Kaz; empty list = deliberately use none):
<可选工具目录>

Call whale_report with the chosen mode and \`optional_tools\`: an array of optional tool names to pre-enable for this task. Do not list base tools or mode auto-on tools. If you deliberately want no optional tools, pass \`optional_tools: []\`. \`enable_tool\` remains available during execution, so nothing is locked.`;

/** 首轮全流程介绍：仅新对话第一轮注入一次，位置早于 TaskReconstruction 块。 */
export const FIRST_ROUND_OVERVIEW = `[ka-whale-workflow overview]
>
This conversation uses ka-whale-workflow. The workflow activates after the first tool call, and guides every task through three phases:
1. Task reconstruction — tool surface narrows; rewrite the request into a structured task description, then call whale_report (without mode) to advance.
2. Task classification — only whale_report is visible; choose normal, plan, or goal, and call whale_report({mode}) to finish the workflow and launch that mode.
3. Execution — full Kaz tools are restored. For subsequent user turns, the workflow normally re-enters reconstruction, unless a plan/goal mode is still active.
  
When the conversation ends, ka-whale-workflow will remind us to save insights and distill skills from this session.
<`;

/** 同一 turn/stage 内最多自动提醒次数（防止模型反复漏调 whale_report 导致死循环）。 */
export const MAX_WHALE_REMINDERS = 2;

/** 任务重构/分类阶段漏调 whale_report 时的提醒消息文本。 */
export function whaleReportReminderText(stage) {
  if (stage === "classification") {
    return `[ka-whale-workflow Reminder]
>
Task classification is complete, but the turn ended before calling whale_report. Call whale_report now with the chosen mode ('normal', 'plan', or 'goal') to finish the workflow and launch that mode if needed. Do not end the turn without calling whale_report.
<`;
  }
  return `[ka-whale-workflow Reminder]
>
Task reconstruction is complete, but the turn ended before calling whale_report. Call whale_report now with no arguments to advance to task classification. Do not end the turn without calling whale_report.
<`;
}

/** 任务完成 / plan-goal 结束时的紧凑复盘指引（方向1）：语义/文本已解耦到 kaz-shared。 */
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

/** 该 agent 会话是否处于 plan 模式：以 session.events 里最后一个 plan/mode
 *  事件的 active 为准（与 kaz-mode 的 planModeActive 同源；不依赖隔离服务）。 */
export function planModeActiveOf(agent) {
  try {
    const events = agent?.session?.events;
    if (!Array.isArray(events)) return false;
    let active = false;
    for (const event of events) {
      if (
        event !== null &&
        typeof event === "object" &&
        event.type === "plan/mode" &&
        event.data !== null &&
        typeof event.data === "object" &&
        typeof event.data.active === "boolean"
      ) {
        active = event.data.active;
      }
    }
    return active;
  } catch {
    return false;
  }
}

/** 该 agent 会话是否处于 goal 模式：经 goals 服务查询，phase 为 active/paused
 *  即为激活（与 kaz-mode 的 goalActive 同源；服务缺失按未开启处理）。 */
export function goalModeActiveOf(agent, goals) {
  try {
    if (
      goals === undefined ||
      goals === null ||
      typeof goals.get !== "function" ||
      agent === null ||
      agent === undefined
    ) {
      return false;
    }
    const goal = goals.get(agent);
    if (goal === null || goal === undefined || typeof goal !== "object") return false;
    return goal.phase === "active" || goal.phase === "paused";
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

/**
 * 创建阶段状态存储（可注入文件路径，便于探针用临时文件）。
 * 结构：{ version: 2, sessions: { "<sessionId>": "reconstruction"|"classification"|"done" },
 *        taskToolState: { "<sessionId>": { taskRunId, mode, initialOptionalTools, jitEnabledTools } } }
 * 旧文件缺少 taskToolState 时仍按 v1 读取；损坏 JSON / 损坏状态一律丢弃。
 */
export function createStageStore(file) {
  const sessions = {};
  const taskToolState = {};
  try {
    if (file !== undefined && file !== null && existsSync(file)) {
      let raw = readFileSync(file, "utf8");
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      const parsed = JSON.parse(raw);
      const data = parsed !== null && typeof parsed === "object" ? parsed.sessions : undefined;
      if (data !== null && typeof data === "object") {
        for (const [id, stage] of Object.entries(data)) {
          if (id.length > 0 && (stage === "reconstruction" || stage === "classification" || stage === "done")) {
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
    }
  } catch {
    // 存储损坏时从空状态开始，不影响主流程
  }
  function persist() {
    if (typeof file !== "string" || file.length === 0) return true;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ version: 2, sessions, taskToolState }, null, 2) + String.fromCharCode(10), "utf8");
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
    if (stored === "reconstruction" || stored === "classification" || stored === "done") return stored;
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

/** 新一轮真实用户消息（第 2、3、4……轮，模型不在运行）直接重新进入「任务重构」。
 *  Plan/Goal 模式激活时（context.modeActive=true）保持 idle/done，不进入任务重构。 */
export function nextStageOnUserMessage(current, _turn, context = {}) {
  if (context?.modeActive === true && (current === "idle" || current === "done")) return current;
  return "reconstruction";
}

/** 检测 /plan 或 /goal 命令触发的消息：最后一个 turn/end 之后有成功的 command/run。
 *  返回 { commandId, name }；调用方负责消费（每个 commandId 只旁路一次）。 */
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
      if (name === "plan" && typeof data.args === "string" && data.args.trim() === "off") continue;
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
     *  进入 reconstruction = 新逻辑任务运行开始，递增 [kaz-memory Review] 与
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

    /** ka-whale-workflow 配置面板里的重构工具清单（白名单之上的过滤器）。 */
    function reconstructionToolsFor(agent) {
      const current = liveFor(agent);
      const tools = Array.isArray(current.reconstructionTools)
        ? current.reconstructionTools.filter((tool) => typeof tool === "string" && tool.trim().length > 0)
        : [];
      return tools.length > 0 ? tools : [...DEFAULT_RECONSTRUCTION_TOOLS];
    }

    /** 当前阶段实际可见工具（供 prompt 里的 <工具列表> 渲染）。 */
    function availableStageTools(agent, stage) {
      const candidates =
        stage === "reconstruction"
          ? [...reconstructionToolsFor(agent), WHALE_REPORT_TOOL]
          : stage === "classification"
            ? [WHALE_REPORT_TOOL]
            : [];
      const out = [];
      for (const tool of candidates) {
        if (out.includes(tool)) continue;
        try {
          const svc = ctx.get("kazMode");
          if (svc !== undefined && svc !== null && typeof svc.toolVisible === "function") {
            if (svc.toolVisible(agent, tool) !== true) continue;
          }
        } catch {
          // 服务异常时保留候选
        }
        out.push(tool);
      }
      return out;
    }

    function renderPrompt(agent, stage) {
      const toolSelectionUsable =
        stage === "classification" &&
        taskToolSelectionEnabledFor(agent) === true &&
        kazModeTaskToolPoolFor(agent) !== null;
      const prompt =
        stage === "reconstruction"
          ? RECONSTRUCTION_PROMPT
          : stage === "classification"
            ? toolSelectionUsable
              ? CLASSIFICATION_PROMPT
              : CLASSIFICATION_PROMPT_BODY
            : "";
      const tools = availableStageTools(agent, stage);
      const list = tools.length > 0 ? tools.join(", ") : "the currently available tools";
      let rendered = prompt.replace(/<工具列表>/g, list);
      if (stage === "classification" && toolSelectionUsable) {
        rendered = rendered.replace(/<可选工具目录>/g, optionalToolDirectoryFor(agent) || "(no optional tools available)");
      }
      return rendered;
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
     * 通过 create_plan 工具（planning isolate 组内）执行 plan 模式切换。
     * whale_report 自身在 host 层解析不到 planMode 服务，必须借 create_plan
     * 的 realm 执行上下文来调用 planMode.set。
     */
    function runPlanBridge(agent, exec, active) {
      const tools = ctx.get("tools");
      const tool =
        tools !== undefined &&
        tools !== null &&
        typeof tools.get === "function"
          ? tools.get(CREATE_PLAN_TOOL, agent)
          : undefined;
      if (tool === undefined || tool === null || typeof tool.execute !== "function") {
        throw new Error(`create_plan bridge is unavailable; cannot ${active ? "enter" : "exit"} plan mode`);
      }
      return tool.execute({ active }, exec);
    }

    // -----------------------------------------------------------------------
    // whale_report 工具：重构/分类各调用一次，向插件汇报阶段完成。
    // -----------------------------------------------------------------------
    const whaleReportDef = defineTool({
      name: WHALE_REPORT_TOOL,
      description:
        "Report that the current ka-whale-workflow stage is complete and advance to the next stage. Call once per stage: during task reconstruction, calling without mode only advances to task classification (stage='classification'); during task classification, pass mode ('normal' | 'plan' | 'goal') to finish the workflow (stage='done') and launch plan/goal mode if needed, so create_plan/create_goal are not needed. For goal mode, also pass objective.",
      parameters: {
        mode: {
          type: "string",
          description:
            "Only for the task classification stage: 'normal' (no mode, default), 'plan' (enter plan mode), or 'goal' (create a goal; objective required).",
        },
        objective: {
          type: "string",
          description: "Required when mode='goal': the concrete completion objective for the goal.",
        },
        max_goal_rounds: {
          type: "number",
          description: "Optional positive integer for mode='goal': automatic continuation round cap.",
        },
        optional_tools: {
          type: "array",
          items: { type: "string" },
          description:
            "Only for the task classification stage when task tool selection is enabled: initial optional (non-base) tools to pre-enable for this task. Empty or omitted means deliberately use none.",
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
        if (current === "reconstruction") {
          setStageAgent(agent, "classification");
          reportRoundDisplay(agent, "任务重构完成，进入任务分类。", "阶段切换");
          return Promise.resolve({ ok: true, stage: "classification", restarted: false });
        }
        if (current === "classification") {
          const mode = args?.mode === "plan" ? "plan" : args?.mode === "goal" ? "goal" : "normal";
          const sessionId = sessionIdOf(agent);
          // 第三次升级：分类阶段必须输出 initial optional_tools；先纯校验，避免半启动。
          const toolSelectionUsable =
            taskToolSelectionEnabledFor(agent) === true && kazModeTaskToolPoolFor(agent) !== null;
          let selectedOptionalTools = [];
          if (toolSelectionUsable) {
            const pool = kazModeTaskToolPoolFor(agent);
            selectedOptionalTools = normalizeOptionalTools(args?.optional_tools);
            const invalid = selectedOptionalTools.find((tool) => !pool.includes(tool));
            if (invalid !== undefined) {
              const allowed = pool.length > 0 ? pool.join(", ") : "(no optional tools available)";
              ctx.logger.info(
                `[ka-whale-workflow] whale_report 拒绝 optional_tools 含未知/越权工具 "${invalid}"（可选池：${allowed}）`,
              );
              return Promise.reject(
                new Error(
                  `whale_report rejected: optional_tools contains "${invalid}", which is not in the current optional tool pool (base/mode-scoped/unknown/not in Kaz surface). Allowed: ${allowed}`,
                ),
              );
            }
          }
          const launches = [];
          if (mode === "plan") {
            try {
              const result = await runPlanBridge(agent, exec, true);
              if (result === null || typeof result !== "object" || result.ok !== true) {
                throw new Error("unexpected create_plan result: " + JSON.stringify(result));
              }
              launches.push("plan");
            } catch (error) {
              return Promise.reject(new Error("failed to enter plan mode: " + (error instanceof Error ? error.message : String(error))));
            }
          } else if (mode === "goal") {
            const objective = typeof args?.objective === "string" ? args.objective.trim() : "";
            if (objective.length === 0) {
              return Promise.reject(new Error("whale_report mode=goal requires an objective"));
            }
            const goals = ctx.get("goals");
            if (goals === undefined || goals === null || typeof goals.create !== "function") {
              return Promise.reject(new Error("goals service is unavailable; cannot create goal"));
            }
            try {
              goals.create(agent, {
                objective,
                ...(typeof args?.max_goal_rounds === "number" && Number.isInteger(args.max_goal_rounds) && args.max_goal_rounds > 0
                  ? { maxGoalRounds: args.max_goal_rounds }
                  : {}),
              });
              launches.push("goal");
            } catch (error) {
              return Promise.reject(new Error("failed to create goal: " + (error instanceof Error ? error.message : String(error))));
            }
          }
          // 全部成功后才写任务工具状态（plan/goal bridge 失败时不写状态、保持 classification）。
          if (toolSelectionUsable && typeof sessionId === "string" && sessionId.length > 0) {
            const taskRunId = reviewRunStateOf(sessionId).taskRunId;
            stageStore.setTaskToolState(sessionId, {
              taskRunId,
              mode,
              initialOptionalTools: selectedOptionalTools,
              jitEnabledTools: [],
            });
          }
          setStageAgent(agent, "done");
          reportRoundDisplay(
            agent,
            "任务分类完成（模式：" + mode + (launches.length > 0 ? "，已启动 " + launches.join("、") : "") + "），鲸鱼工作流结束" + (toolSelectionUsable ? "，任务工具面已按 optional_tools 收敛" : "，放行 Kaz 白名单工具") + "。",
            "阶段切换",
          );
          return Promise.resolve({ ok: true, stage: "done", restarted: false });
        }
        return Promise.reject(
          new Error("whale_report can only be called during task reconstruction or task classification"),
        );
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
    // 对外信号：kaWhaleWorkflow 服务（供 kaz-mode 的 auto-on 读取阶段）。
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
    //   - /plan /goal 命令触发的消息：旁路鲸鱼工作流（不进入重构），
    //     round-minimal 极简过滤仍照常生效。
    //   - 用户插话不改变当前阶段；仅首轮/未开始且已解除极简时进入任务重构。
    // -----------------------------------------------------------------------
    const pendingStart = new Set();
    /** 进程内已消费的 /plan /goal 命令 id（每个命令只旁路下一次 claim）。 */
    const consumedManualCommands = new Set();
    /** 当前处于命令旁路的 session id 集合（assemble / pre-step 读取）。 */
    const manualBypassSessions = new Set();
    /** 每个 session 在当前 turn/stage 已自动提醒过的次数（防止 steer 死循环）。 */
    const turnReminderCounts = new Map();
    /** [kaz-memory Review] task-run 状态：每 session { kinds, taskRunId, injectedRunId }。
     *  kinds = session 级“每 kind 最多一次”；taskRunId = 逻辑任务运行标识；
     *  injectedRunId = 上次注入所属的 taskRunId（同一任务运行最多注入一次复盘）。 */
    const reviewRunState = new Map();
    /** 技能自省（skill-review）task-run 状态：与 memory review 同构但独立，
     *  每 session { kinds, taskRunId, injectedRunId }；同一逻辑任务运行最多注入一次。 */
    const skillReviewRunState = new Map();
    /** 技能自省用的 plan/goal 激活状态观察（与 memory review 相互独立）。 */
    const skillLastPlanActive = new Map();
    const skillLastGoalActive = new Map();
    /** 每 session 上一次观察到的 plan/goal 激活状态（用于检测结束节点）。 */
    const lastPlanActive = new Map();
    const lastGoalActive = new Map();

    /** 进入新的逻辑任务运行：进入 reconstruction 或新 plan/goal 激活时递增 taskRunId。 */
    function beginReviewTaskRun(sessionId) {
      let state = reviewRunState.get(sessionId);
      if (state === undefined) {
        state = { kinds: new Set(), taskRunId: 0, injectedRunId: null };
      }
      state.taskRunId += 1;
      reviewRunState.set(sessionId, state);
    }

    /** 读取（惰性创建）[kaz-memory Review] 运行状态。 */
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
      // /plan /goal 命令触发的消息：只跳过鲸鱼工作流，round-minimal 极简仍生效。
      const manual = consumeManualCommand(agent);
      if (manual !== null) {
        manualBypassSessions.add(sessionId);
        // 直接 /plan /goal 旁路 = 新逻辑任务运行且没有分类选择：清除旧任务工具状态，
        // 本轮 taskToolStateOf 因 manualBypassSessions 命中而返回 null（任务过滤关闭）。
        stageStore.removeTaskToolState(sessionId);
        reportRoundDisplay(agent, `检测到 /${manual.name} 指令：本消息跳过鲸鱼工作流，直接放行白名单工具。`, "工作流旁路");
        return;
      }
      manualBypassSessions.delete(sessionId);
      const current = stageOfAgent(agent);
      const planActive = planModeActiveOf(agent);
      const goalActive = goalModeActive(agent);
      const modeActive = planActive || goalActive;
      // 第 2、3、4……轮（turn>=2，模型不在运行）：直接重新进入任务重构；
      // Plan/Goal 模式激活时保持 idle/done，不进入任务重构。
      if (typeof turn === "number" && turn >= 2) {
        const next = nextStageOnUserMessage(current, turn, { modeActive });
        if (setStageAgent(agent, next)) {
          reportRoundDisplay(agent, "收到新一轮消息，重新进入任务重构。", "阶段切换");
        }
        return;
      }
      // 插话（模型运行中）不改变当前工作流阶段；仅尚未开始（idle）时进入任务重构。
      if (current !== "idle") return;
      // Plan/Goal 模式激活时不开启任务重构，保持在当前模式。
      if (modeActive) return;
      if (isMinimal(agent)) {
        pendingStart.add(sessionId);
        return;
      }
      if (setStageAgent(agent, "reconstruction")) {
        reportRoundDisplay(agent, "进入任务重构。", "阶段切换");
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
      // Plan/Goal 模式激活时不开启任务重构，保持在当前模式。
      if (planModeActiveOf(agent) || goalModeActive(agent)) return;
      if (setStageAgent(agent, "reconstruction")) {
        reportRoundDisplay(agent, "round-minimal 已解除，进入任务重构。", "阶段切换");
      }
    });

    // -----------------------------------------------------------------------
    // 回合关闭兜底：重构/分类阶段模型漏掉 whale_report 时，steer 一条提醒，
    // 让回合继续而不是“停止对话”。同一 turn/stage 最多提醒 MAX_WHALE_REMINDERS 次。
    // -----------------------------------------------------------------------
    ctx.on("agent/turn-stopping", ({ agent, turn, signal }) => {
      if (agent === null || agent === undefined || typeof agent !== "object") return;
      if (signal?.aborted === true) return;
      if (liveFor(agent).enabled !== true) return;
      if (liveFor(agent).includeSubagents !== true && isSubagent(agent)) return;
      if (isBypassed(agent)) return;
      const stage = stageOfAgent(agent);
      if (stage !== "reconstruction" && stage !== "classification") return;
      const sessionId = sessionIdOf(agent);
      if (typeof sessionId !== "string" || sessionId.length === 0) return;
      let state = turnReminderCounts.get(sessionId);
      if (state === undefined || state.turn !== turn || state.stage !== stage) {
        state = { turn, stage, count: 0 };
      }
      if (state.count >= MAX_WHALE_REMINDERS) {
        turnReminderCounts.set(sessionId, state);
        return;
      }
      let message;
      try {
        message = createUserMessage({
          content: [{ type: "text", text: whaleReportReminderText(stage) }],
          source: { kind: "plugin", plugin: "ka-whale-workflow", form: "reminder" },
        });
      } catch (error) {
        ctx.logger.warn(
          `[ka-whale-workflow] 构造 whale_report 提醒消息失败：${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      agent.steer(message);
      state.count += 1;
      turnReminderCounts.set(sessionId, state);
      reportRoundDisplay(agent, whaleReportReminderText(stage), "工作流提醒");
    });

    // -----------------------------------------------------------------------
    // 任务完成 / plan-goal 结束节点：注入紧凑复盘指引（方向1）。
    //   只在 ka-whale-workflow 进入 done 后（任务被执行）且检测到结束节点时触发；
    //   每 session 每种类型最多注入一次；没有实质结论时模型应不写记忆。
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
      const planActive = planModeActiveOf(agent);
      const goalActive = goalModeActive(agent);
      const prevPlan = lastPlanActive.get(sessionId);
      const prevGoal = lastGoalActive.get(sessionId);
      lastPlanActive.set(sessionId, planActive);
      lastGoalActive.set(sessionId, goalActive);
      // 新 plan/goal 激活 = 新的逻辑任务运行（例如 /plan、/goal 或分类后启动模式）。
      if (prevPlan === false && planActive === true) {
        beginReviewTaskRun(sessionId);
        beginSkillReviewTaskRun(sessionId);
      }
      if (prevGoal === false && goalActive === true) {
        beginReviewTaskRun(sessionId);
        beginSkillReviewTaskRun(sessionId);
      }

      const inject = (kind) => {
        if (memorySaveCallable(agent) !== true) return false;
        const state = reviewRunStateOf(sessionId);
        // session 级：每种 kind（normal/plan/goal）在整个 session 最多注入一次。
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

      // Plan 结束：上一次 active=true，当前 false。
      if (prevPlan === true && planActive === false) {
        inject("plan");
        return;
      }
      // Goal 结束：上一次 active，当前不再 active。
      if (prevGoal === true && goalActive === false) {
        inject("goal");
        return;
      }
      // Normal 任务完成：done 且当前无 plan/goal 激活（每个 session 只注入一次 normal）。
      if (!planActive && !goalActive) {
        inject("normal");
      }
    });

    // -----------------------------------------------------------------------
    // 二阶段技能自省（skill-review）：与 [kaz-memory Review] 同一批安全边界，
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
      const planActive = planModeActiveOf(agent);
      const goalActive = goalModeActive(agent);
      const prevPlan = skillLastPlanActive.get(sessionId);
      const prevGoal = skillLastGoalActive.get(sessionId);
      skillLastPlanActive.set(sessionId, planActive);
      skillLastGoalActive.set(sessionId, goalActive);
      // 新 plan/goal 激活 = 新的逻辑任务运行（skill-review 独立 taskRunId）。
      if (prevPlan === false && planActive === true) beginSkillReviewTaskRun(sessionId);
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
        // session 级：每种 kind（normal/plan/goal）在整个 session 最多注入一次。
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

      // 与 memory review 相同的边界判定：Plan 结束 / Goal 结束 / Normal 完成。
      if (prevPlan === true && planActive === false) {
        injectSkill("plan");
        return;
      }
      if (prevGoal === true && goalActive === false) {
        injectSkill("goal");
        return;
      }
      if (!planActive && !goalActive) {
        injectSkill("normal");
      }
    });

    // -----------------------------------------------------------------------
    // 上下文注入：重构/分类按 turn 去重注入一次。
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
          const planActive = planModeActiveOf(agent);
          const goalActive = goalModeActive(agent);
          const modeActive = planActive || goalActive;
          if (hasRealUserMessage) {
            if (turn >= 2) {
              const next = nextStageOnUserMessage(stage, turn, { modeActive });
              if (setStageAgent(agent, next)) {
                reportRoundDisplay(
                  agent,
                  "收到新一轮消息，重新进入任务重构（pre-step 兜底）。",
                  "阶段切换",
                );
              }
            } else if (stage === "idle" && !isMinimal(agent) && !modeActive) {
              if (setStageAgent(agent, "reconstruction")) {
                reportRoundDisplay(agent, "进入任务重构（pre-step 兜底）。", "阶段切换");
              }
            }
          } else if (turn < 2 && stage === "idle" && !isMinimal(agent) && hasToolCall(agent) && !modeActive) {
            if (setStageAgent(agent, "reconstruction")) {
              reportRoundDisplay(agent, "round-minimal 已解除，进入任务重构（pre-step 兜底）。", "阶段切换");
            }
          }
        }
      }
      let decision = await next();
      if (decision === null || typeof decision !== "object" || decision.kind !== "enter") return decision;
      if (agent === null || agent === undefined || typeof agent !== "object") return decision;
      if (liveFor(agent).enabled !== true) return decision;
      if (isBypassed(agent)) return decision;
      // 首轮全流程介绍：仅新对话第一轮注入一次，且早于 TaskReconstruction 块。
      const liveNow = liveFor(agent);
      const skipSubagentNow = liveNow.includeSubagents !== true && isSubagent(agent);
      const turn = typeof payload?.turn === "number" ? payload.turn : currentTurnOf(agent);
      const hasRealUserMessageNow = Array.isArray(payload?.messages)
        ? payload.messages.some((message) => isUserMessage(message))
        : false;
      const hasPriorUserMessage =
        agent.session !== undefined &&
        agent.session !== null &&
        Array.isArray(agent.session.events) &&
        agent.session.events.some(
          (event) => event !== null && typeof event === "object" && event.type === "user/message",
        );
      const isNewConversation = !hasPriorUserMessage && turn === 1 && hasRealUserMessageNow;
      if (
        isNewConversation &&
        liveNow.enabled === true &&
        !skipSubagentNow &&
        !hasInjectedBefore(agent, "overview")
      ) {
        let overviewMessage;
        try {
          overviewMessage = createUserMessage({
            content: [{ type: "text", text: FIRST_ROUND_OVERVIEW }],
            source: { kind: "plugin", plugin: "ka-whale-workflow", form: "overview" },
          });
        } catch (error) {
          ctx.logger.warn(
            `[ka-whale-workflow] 构造首轮介绍消息失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (overviewMessage !== undefined) {
          reportRoundDisplay(agent, FIRST_ROUND_OVERVIEW, "首轮介绍");
          decision = {
            ...decision,
            messages: Array.isArray(decision.messages)
              ? [...decision.messages, overviewMessage]
              : decision.messages,
          };
        }
      }
      const stage = stageOfAgent(agent);
      const form =
        stage === "reconstruction"
          ? "reconstruction"
          : stage === "classification"
            ? "classification"
            : null;
      if (form === null) return decision;
      if (hasInjectedInTurn(agent, form, turn)) return decision;
      const title =
        stage === "reconstruction"
          ? "ka-whale-workflow TaskReconstruction"
          : "ka-whale-workflow TaskClassification";
      const text = ["[" + title + "]", ">", renderPrompt(agent, stage), "<"].join("\n");
      let message;
      try {
        message = createUserMessage({
          content: [{ type: "text", text }],
          source: { kind: "plugin", plugin: "ka-whale-workflow", form },
        });
      } catch (error) {
        ctx.logger.warn(`[ka-whale-workflow] 构造上下文消息失败：${error instanceof Error ? error.message : String(error)}`);
        return decision;
      }
      reportRoundDisplay(
        agent,
        text,
        stage === "reconstruction" ? "任务重构" : "任务分类",
      );
      return { ...decision, messages: Array.isArray(decision.messages) ? [...decision.messages, message] : decision.messages };
    });

    // -----------------------------------------------------------------------
    // 系统提示词段：接在 persona 后面（kaz-system-prompt 会保留本段）。
    // -----------------------------------------------------------------------
    ctx.systemPrompt.section({
      name: "ka-whale-workflow:prompt",
      order: 40,
      text: (context) => {
        const agent = context?.agent;
        if (agent === null || agent === undefined || typeof agent !== "object") return "";
        if (liveFor(agent).enabled !== true) return "";
        const stage = stageOfAgent(agent);
        if (stage !== "reconstruction" && stage !== "classification") return "";
        if (isBypassed(agent)) return "";
        return renderPrompt(agent, stage);
      },
    });

    // -----------------------------------------------------------------------
    // 工具面过滤：重构/分类按阶段清单过滤；命令旁路/done/idle 放行白名单。
    // -----------------------------------------------------------------------
    ctx.on("system-prompt/assemble", async function (assembly, context, next) {
      const agent = context?.agent;
      const before = toolNamesOf(assembly?.tools);
      const enabled = agent !== null && agent !== undefined && typeof agent === "object" && liveFor(agent).enabled === true;
      const bypassed = enabled && isBypassed(agent);
      // /plan /goal 命令消息：跳过鲸鱼工作流过滤与提示词段，直接放行白名单工具。
      if (bypassed) {
        const whaleSection = assembly.sections.find(
          (section) => typeof section?.name === "string" && section.name === "ka-whale-workflow:prompt",
        );
        if (whaleSection !== null && whaleSection !== undefined) whaleSection.text = "";
        const nextResult = await next();
        const finalAssembly = nextResult ?? assembly;
        const after = toolNamesOf(finalAssembly?.tools);
        if (before.join(",") !== after.join(",")) {
          reportRoundDisplay(
            agent,
            "工具面变化（命令旁路）\n- 阶段：manual-command\n- 当前工具（" + after.length + "）：" + (after.length > 0 ? after.join(", ") : "（无）"),
            "工作流工具面",
          );
        }
        return nextResult;
      }
      let stage = enabled ? stageOfAgent(agent) : "idle";
      // assemble 兜底：round-minimal 解除后、首次 tool/call 的下一步组装时，
      // 阶段可能还没被 session/event 路径推进（assemble 先于 agent/pre-step 执行）。
      // 在这里补一次阶段切换，使【紧跟在首次工具调用后的那次请求】就拿到对应工具面
      // 和系统提示词段，而不是再等一个 step。阶段丢失时一律进入任务重构；
      // Plan/Goal 模式激活时除外。
      if (
        enabled &&
        stage === "idle" &&
        liveFor(agent).includeSubagents !== true &&
        !isSubagent(agent) &&
        !isMinimal(agent) &&
        hasToolCall(agent) &&
        !planModeActiveOf(agent) &&
        !goalModeActive(agent)
      ) {
        if (setStageAgent(agent, "reconstruction")) {
          reportRoundDisplay(
            agent,
            "round-minimal 已解除，进入任务重构（assemble 兜底）。",
            "阶段切换",
          );
          stage = "reconstruction";
        }
      }
      let allowed = null;
      if (stage === "reconstruction") {
        allowed = new Set([...reconstructionToolsFor(agent), WHALE_REPORT_TOOL]);
      } else if (stage === "classification") {
        allowed = new Set([WHALE_REPORT_TOOL]);
      }
      if (allowed !== null) {
        assembly.tools = assembly.tools.filter(
          (tool) => tool !== null && typeof tool === "object" && allowed.has(tool.name),
        );
        assembly.sections = assembly.sections.filter((section) => {
          if (typeof section?.name !== "string" || !section.name.startsWith("tool:")) return true;
          return allowed.has(section.name.slice("tool:".length));
        });
        // 本插件自己的提示词段在 assemble 开始时已按旧阶段渲染成空串；
        // 阶段刚被推进时在这里补写，让同一请求的 system 里就带对应阶段提示。
        const whaleSection = assembly.sections.find(
          (section) => typeof section?.name === "string" && section.name === "ka-whale-workflow:prompt",
        );
        if (whaleSection !== null && whaleSection !== undefined) {
          whaleSection.text = renderPrompt(agent, stage);
        }
      }
      const nextResult = await next();
      const finalAssembly = nextResult ?? assembly;
      const after = toolNamesOf(finalAssembly?.tools);
      if (before.join(",") !== after.join(",")) {
        reportRoundDisplay(
          agent,
          "工具面变化（ka-whale-workflow 阶段过滤）\n- 阶段：" + stage + "\n- 当前工具（" + after.length + "）：" + (after.length > 0 ? after.join(", ") : "（无）"),
          "工作流工具面",
        );
      }
      return nextResult;
    });

    // -----------------------------------------------------------------------
    // 执行层闸门：重构/分类阶段只允许阶段工具（纵深防御，组装层已隐藏）。
    // -----------------------------------------------------------------------
    ctx.on("tools/pre-execute", (exec, next) => {
      const agent = exec?.agent;
      if (agent === null || agent === undefined || typeof agent !== "object") return next();
      if (liveFor(agent).enabled !== true) return next();
      if (liveFor(agent).includeSubagents !== true && isSubagent(agent)) return next();
      if (isBypassed(agent)) return next();
      const stage = stageOfAgent(agent);
      let allowed = null;
      if (stage === "reconstruction") {
        allowed = new Set([...reconstructionToolsFor(agent), WHALE_REPORT_TOOL]);
      } else if (stage === "classification") {
        allowed = new Set([WHALE_REPORT_TOOL]);
      }
      if (allowed !== null && typeof exec?.name === "string" && !allowed.has(exec.name)) {
        ctx.logger.info(
          `[ka-whale-workflow] ${stage} 阶段拒绝调用工具 "${exec.name}"（仅允许：${[...allowed].join(", ")}）`,
        );
        return {
          kind: "deny",
          reason:
            `工具 "${exec.name}" 在鲸鱼工作流「${stage}」阶段不可用，当前仅允许：` +
            `${[...allowed].join(", ")}。完成本阶段（调用 whale_report）后即可恢复白名单工具。`,
        };
      }
      return next();
    });

    ctx.effect(() => () => {
      uninstallTools();
      // 插件卸载前 flush lifecycle 内存脏数据（进程退出/热重载都尽量不丢埋点）。
      if (lifecycleMemory.dirty) persistLifecycleNow();
    });
  },
};
