// kaz-shared —— 全自动 Skill 生命周期：纯函数层（终案 E，纯 ESM，无 I/O）
// ===========================================================================
// 职责（只做纯数据归一化/校验/决策/投影，绝不读写文件）：
//   * kaz-skill-lifecycle.json 是“意图单一事实源”，registry 只是运行时投影；
//   * 本模块输出“建议动作数组”，实际落地由 ka-whale-workflow 内部执行器
//     （备份 → 原子写 → 审计）完成，不新增任何用户可见工具；
//   * 损坏/缺失 lifecycle → 本层返回 ok:false（feature off），不回写 registry。
//
// lifecycle v2 顶层形状：
//   { version: 2, updatedAt, defaults: {...}, skills: {
//       "<plugin>/<tool>": { plugin, tool, status, createdAt, firstSeenAt,
//                            lastUsedAt, ..., probe, retire, update,
//                            manifestRel, switchRel, audit, autoFixPolicy } } }
// skill key 由 skillKeyOf(plugin, tool) 生成，例如
//   "kaz-skill-safe-json/safe_json_write"
// ===========================================================================

import { normalizeAgentManagedRegistry } from "./agent-managed-tools.js";

/** lifecycle v2 版本号。 */
export const SKILL_LIFECYCLE_VERSION = 2;

/** 状态白名单。 */
export const SKILL_LIFECYCLE_STATUSES = Object.freeze([
  "active",
  "retire-pending",
  "retired",
  "update-needed",
  "update-staged",
]);

/** 默认阈值（与终案 E 一致；可被 lifecycle.defaults 覆盖）。 */
export const SKILL_LIFECYCLE_DEFAULT_UNUSED_DAYS_BEFORE_PENDING = 60;
export const SKILL_LIFECYCLE_DEFAULT_PENDING_GRACE_DAYS = 7;
export const SKILL_LIFECYCLE_DEFAULT_TOOL_FAIL_WINDOW_DAYS = 30;
export const SKILL_LIFECYCLE_DEFAULT_TOOL_FAIL_THRESHOLD = 3;
export const SKILL_LIFECYCLE_DEFAULT_TOOL_FAIL_RATE = 0.5;
export const SKILL_LIFECYCLE_DEFAULT_PROBE_FAIL_THRESHOLD = 2;
export const SKILL_LIFECYCLE_DEFAULT_AUDIT_INTERVAL_HOURS = 24;
export const SKILL_LIFECYCLE_DEFAULT_MAX_AUTO_ACTIONS = 1;

/** 一次调用即可取到完整默认阈值（独立副本，冻结）。 */
export const SKILL_LIFECYCLE_DEFAULTS = Object.freeze({
  unusedDaysBeforePending: SKILL_LIFECYCLE_DEFAULT_UNUSED_DAYS_BEFORE_PENDING,
  pendingGraceDays: SKILL_LIFECYCLE_DEFAULT_PENDING_GRACE_DAYS,
  toolFailWindowDays: SKILL_LIFECYCLE_DEFAULT_TOOL_FAIL_WINDOW_DAYS,
  toolFailThreshold: SKILL_LIFECYCLE_DEFAULT_TOOL_FAIL_THRESHOLD,
  toolFailRate: SKILL_LIFECYCLE_DEFAULT_TOOL_FAIL_RATE,
  probeFailThreshold: SKILL_LIFECYCLE_DEFAULT_PROBE_FAIL_THRESHOLD,
  auditIntervalHours: SKILL_LIFECYCLE_DEFAULT_AUDIT_INTERVAL_HOURS,
  maxAutoActionsPerRun: SKILL_LIFECYCLE_DEFAULT_MAX_AUTO_ACTIONS,
});

/** 归一化插件名（与 agent-managed registry 同一套：小写、非字母数字折叠为 “-”）。 */
function normalizeKey(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 清洗工具名：非空 trim 字符串。 */
function cleanTool(value) {
  if (typeof value !== "string") return "";
  const tool = value.trim();
  return tool.length > 0 ? tool : "";
}

/** 字符串或 null。 */
function stringOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" ? value : null;
}

/** 非负整数；非法回退 fallback。 */
function intOr(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** 正数；非法回退 fallback。 */
function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * skill key：plugin（归一化）+ "/" + tool。
 * 一个 agent-managed 工具（plugin, tool）唯一对应一条 lifecycle 记录。
 */
export function skillKeyOf(plugin, tool) {
  const p = normalizeKey(plugin);
  const t = cleanTool(tool);
  if (p.length === 0 || t.length === 0) return "";
  return `${p}/${t}`;
}

/** 归一化 defaults（缺失补默认；非法数值回退默认）。 */
export function normalizeSkillLifecycleDefaults(raw) {
  const value = isPlainObject(raw) ? raw : {};
  return {
    unusedDaysBeforePending: intOr(
      value.unusedDaysBeforePending,
      SKILL_LIFECYCLE_DEFAULT_UNUSED_DAYS_BEFORE_PENDING,
    ),
    pendingGraceDays: intOr(value.pendingGraceDays, SKILL_LIFECYCLE_DEFAULT_PENDING_GRACE_DAYS),
    toolFailWindowDays: intOr(
      value.toolFailWindowDays,
      SKILL_LIFECYCLE_DEFAULT_TOOL_FAIL_WINDOW_DAYS,
    ),
    toolFailThreshold: intOr(value.toolFailThreshold, SKILL_LIFECYCLE_DEFAULT_TOOL_FAIL_THRESHOLD),
    toolFailRate:
      typeof value.toolFailRate === "number" &&
      Number.isFinite(value.toolFailRate) &&
      value.toolFailRate >= 0 &&
      value.toolFailRate <= 1
        ? value.toolFailRate
        : SKILL_LIFECYCLE_DEFAULT_TOOL_FAIL_RATE,
    probeFailThreshold: intOr(value.probeFailThreshold, SKILL_LIFECYCLE_DEFAULT_PROBE_FAIL_THRESHOLD),
    auditIntervalHours: intOr(
      value.auditIntervalHours,
      SKILL_LIFECYCLE_DEFAULT_AUDIT_INTERVAL_HOURS,
    ),
    // 硬性护栏：每周期最多 1 个自动动作（终案 E 要求钳制到 1）。
    maxAutoActionsPerRun: SKILL_LIFECYCLE_DEFAULT_MAX_AUTO_ACTIONS,
  };
}

/** 归一化单条 skill 记录；形状损坏返回 null（整份 lifecycle 视为损坏）。 */
function normalizeSkillRecord(keyHint, raw) {
  if (!isPlainObject(raw)) return null;
  const rawPlugin = stringOrNull(raw.plugin);
  const rawTool = cleanTool(raw.tool);
  const keyParts =
    typeof keyHint === "string" && keyHint.includes("/")
      ? keyHint.split("/")
      : [];
  const plugin =
    typeof rawPlugin === "string" && rawPlugin.length > 0
      ? normalizeKey(rawPlugin)
      : keyParts.length === 2
        ? normalizeKey(keyParts[0])
        : "";
  const tool =
    rawTool.length > 0
      ? rawTool
      : keyParts.length === 2
        ? cleanTool(keyParts[1])
        : "";
  if (plugin.length === 0 || tool.length === 0) return null;
  const status = SKILL_LIFECYCLE_STATUSES.includes(raw.status) ? raw.status : null;
  if (status === null) return null;

  const createdAt = stringOrNull(raw.createdAt) ?? stringOrNull(raw.updatedAt);
  const firstSeenAt = stringOrNull(raw.firstSeenAt) ?? createdAt;
  const statusChangedAt = stringOrNull(raw.statusChangedAt) ?? createdAt;
  const version = typeof raw.version === "string" && raw.version.trim().length > 0 ? raw.version.trim() : "0.0.0";

  return {
    plugin,
    tool,
    version,
    status,
    statusChangedAt,
    createdAt,
    firstSeenAt,
    lastUsedAt: stringOrNull(raw.lastUsedAt),
    lastSuccessfulAt: stringOrNull(raw.lastSuccessfulAt),
    lastErrorAt: stringOrNull(raw.lastErrorAt),
    usageCount: intOr(raw.usageCount, 0),
    failureCount: intOr(raw.failureCount, 0),
    consecutiveFailures: intOr(raw.consecutiveFailures, 0),
    probe: {
      lastRunAt: stringOrNull(raw.probe?.lastRunAt),
      lastResult: ["not-run", "pass", "fail"].includes(raw.probe?.lastResult)
        ? raw.probe.lastResult
        : "not-run",
      failCount: intOr(raw.probe?.failCount, 0),
      passCount: intOr(raw.probe?.passCount, 0),
    },
    retire: {
      reason: stringOrNull(raw.retire?.reason),
      pendingAt: stringOrNull(raw.retire?.pendingAt),
      confirmedAt: stringOrNull(raw.retire?.confirmedAt),
    },
    update: {
      state: ["none", "needed", "staged"].includes(raw.update?.state)
        ? raw.update.state
        : "none",
      evidence: Array.isArray(raw.update?.evidence)
        ? raw.update.evidence.filter((item) => typeof item === "string" && item.trim().length > 0)
        : [],
      patchRef: stringOrNull(raw.update?.patchRef),
      stagedVersion: stringOrNull(raw.update?.stagedVersion),
    },
    manifestRel: stringOrNull(raw.manifestRel) ?? "",
    switchRel: stringOrNull(raw.switchRel) ?? "",
    audit: {
      lastAction: stringOrNull(raw.audit?.lastAction),
      lastActionAt: stringOrNull(raw.audit?.lastActionAt),
      actionCount: intOr(raw.audit?.actionCount, 0),
    },
    autoFixPolicy: raw.autoFixPolicy === "probe-only" ? "probe-only" : "never",
  };
}

/**
 * 归一化/校验 v2 lifecycle。
 * 缺失字段补默认；整份文件损坏（根/技能表/任意单条记录形状非法）返回
 * { ok:false, reason }——调用方按 feature off 处理，不自动动作。
 */
export function normalizeSkillLifecycle(raw) {
  if (!isPlainObject(raw)) return { ok: false, reason: "invalid-shape" };
  if (!isPlainObject(raw.skills)) return { ok: false, reason: "invalid-skills" };
  const skills = {};
  for (const [keyHint, record] of Object.entries(raw.skills)) {
    const normalized = normalizeSkillRecord(keyHint, record);
    if (normalized === null) {
      return { ok: false, reason: "invalid-skill-record", key: keyHint };
    }
    const key = skillKeyOf(normalized.plugin, normalized.tool);
    if (key.length === 0) return { ok: false, reason: "invalid-skill-key", key: keyHint };
    skills[key] = normalized;
  }
  const updatedAt = stringOrNull(raw.updatedAt);
  return {
    ok: true,
    lifecycle: {
      version: SKILL_LIFECYCLE_VERSION,
      updatedAt,
      defaults: normalizeSkillLifecycleDefaults(raw.defaults),
      skills,
    },
  };
}

function toMs(value, fallbackMs) {
  if (typeof value !== "string" || value.length === 0) return fallbackMs;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : fallbackMs;
}

function daysBetween(nowMs, value) {
  const ms = toMs(value, null);
  if (ms === null) return null;
  return (nowMs - ms) / 86400000;
}

/** 建议动作的稳定构造。 */
function action(type, record, extra = {}) {
  return {
    type,
    key: record.key,
    plugin: record.plugin,
    tool: record.tool,
    ...extra,
  };
}

/**
 * 纯审计：读 lifecycle + agent-managed registry，返回“建议动作数组”（不写文件）。
 * registry 缺失/损坏 → 视为空 registry；lifecycle 损坏 → 返回 []（feature off）。
 * options.patchExists(skillKey) 可选回调，返回 true 表示 update-staged 的补丁目录/文件存在。
 */
export function auditSkillLifecycle(lifecycle, registry, now, options = {}) {
  const normalizedResult = normalizeSkillLifecycle(lifecycle);
  if (normalizedResult.ok !== true) return [];
  const lc = normalizedResult.lifecycle;
  const reg = normalizeAgentManagedRegistry(registry);
  const nowMs = typeof now === "string" && now.length > 0 ? toMs(now, Date.now()) : Date.now();
  const patchExists =
    typeof options.patchExists === "function" ? options.patchExists : () => false;
  const actions = [];

  const registered = (plugin, tool) => {
    const entry = reg.plugins[plugin];
    return entry !== undefined && entry !== null && entry.tools.includes(tool);
  };

  // 1) registry 中已有、lifecycle 尚无 → bootstrap active。
  for (const [plugin, entry] of Object.entries(reg.plugins)) {
    for (const tool of entry.tools) {
      const key = skillKeyOf(plugin, tool);
      if (key.length === 0 || Object.prototype.hasOwnProperty.call(lc.skills, key)) continue;
      actions.push({
        type: "bootstrap-active",
        key,
        plugin,
        tool,
        from: null,
        to: "active",
        reason: "registered tool missing in lifecycle",
      });
    }
  }

  // 2) lifecycle 记录逐条判定（每条最多给一个最高优先建议，防止同轮重复动作）。
  for (const [keyHint, rawRecord] of Object.entries(lc.skills)) {
    const key = keyHint;
    const record = rawRecord;
    const plugin = record.plugin;
    const tool = record.tool;
    const isRegistered = registered(plugin, tool);
    const base = { key, plugin, tool, from: record.status };

    // 2.1 真实使用复活：retire-pending/retired 且 lastUsedAt 晚于进入该状态。
    if (record.status === "retire-pending" || record.status === "retired") {
      const boundaryMs =
        record.status === "retire-pending"
          ? toMs(record.retire?.pendingAt, toMs(record.statusChangedAt, null))
          : toMs(record.retire?.confirmedAt, toMs(record.statusChangedAt, null));
      const usedMs = toMs(record.lastUsedAt, null);
      if (
        usedMs !== null &&
        (boundaryMs === null || usedMs > boundaryMs) &&
        transitionAllowed(record.status, "active")
      ) {
        actions.push(
          action("reactivate", base, {
            to: "active",
            reason: "real top-level tool use observed after retire-pending/retired",
            evidence: { lastUsedAt: record.lastUsedAt },
          }),
        );
        continue;
      }
    }

    // 2.2 registry 投影不一致 → reconcile。
    const wantsRegistered = record.status !== "retired";
    if (wantsRegistered !== isRegistered) {
      actions.push(
        action("reconcile-registry", base, {
          to: record.status,
          reason: wantsRegistered
            ? "lifecycle expects tool visible in agent-managed registry"
            : "lifecycle retired; tool must be removed from agent-managed registry",
          evidence: { registered: isRegistered, status: record.status },
        }),
      );
      continue;
    }

    // 2.3 调用/探针失败 → update-needed（retired 不再打扰）。
    if (record.status !== "retired") {
      const probeFail =
        record.probe.failCount >= lc.defaults.probeFailThreshold &&
        record.probe.lastResult === "fail";
      const lastErrorMs = toMs(record.lastErrorAt, null);
      const recentFail =
        lastErrorMs !== null &&
        nowMs - lastErrorMs <= lc.defaults.toolFailWindowDays * 86400000 &&
        record.failureCount >= lc.defaults.toolFailThreshold &&
        record.failureCount / Math.max(1, record.usageCount) >= lc.defaults.toolFailRate;
      if (
        (probeFail || recentFail) &&
        transitionAllowed(record.status, "update-needed")
      ) {
        actions.push(
          action("update-needed", base, {
            to: "update-needed",
            reason: probeFail ? "probe failed repeatedly" : "tool call failed repeatedly",
            evidence: {
              probeFail,
              recentFail,
              failureCount: record.failureCount,
              consecutiveFailures: record.consecutiveFailures,
            },
          }),
        );
        continue;
      }
    }

    // 2.4 update-staged 且补丁存在 → commit-update。
    if (
      record.status === "update-staged" &&
      patchExists(key) === true &&
      transitionAllowed(record.status, "active")
    ) {
      actions.push(
        action("commit-update", base, {
          to: "active",
          reason: "staged update patch exists and passed gate",
          evidence: { stagedVersion: record.update?.stagedVersion, patchRef: record.update?.patchRef },
        }),
      );
      continue;
    }

    // 2.5 闲置 → retire-pending / retire。
    if (record.status === "active") {
      const reference = record.lastUsedAt ?? record.createdAt ?? record.firstSeenAt;
      const idleDays = daysBetween(nowMs, reference);
      if (
        idleDays !== null &&
        idleDays >= lc.defaults.unusedDaysBeforePending &&
        transitionAllowed("active", "retire-pending")
      ) {
        actions.push(
          action("retire-pending", base, {
            to: "retire-pending",
            reason: `no real use for ${lc.defaults.unusedDaysBeforePending} days`,
            evidence: { idleDays: Math.floor(idleDays), reference },
          }),
        );
        continue;
      }
    }
    if (record.status === "retire-pending") {
      const pendingDays = daysBetween(nowMs, record.retire?.pendingAt);
      if (
        pendingDays !== null &&
        pendingDays >= lc.defaults.pendingGraceDays &&
        transitionAllowed("retire-pending", "retired")
      ) {
        actions.push(
          action("retire", base, {
            to: "retired",
            reason: `pending grace of ${lc.defaults.pendingGraceDays} days elapsed without use`,
            evidence: { pendingDays: Math.floor(pendingDays), pendingAt: record.retire?.pendingAt },
          }),
        );
        continue;
      }
    }
  }

  return actions;
}

/**
 * 由 lifecycle 计算 agent-managed registry 的“工具列表投影”：
 *   - retired 的工具从 plugins[plugin].tools[] 移除（保留 plugin 条目与 agentManaged:true）；
 *   - active/retire-pending/update-needed/update-staged 的工具保留/补登记；
 *   - 旧 registry 中没有 lifecycle 记录的既有工具保持不动（保守，不误删）；
 *   - 不改 registry schema（version + plugins.agentManaged/tools）。
 */
export function projectRegistryFromLifecycle(lifecycle, oldRegistry) {
  const normalizedResult = normalizeSkillLifecycle(lifecycle);
  const old = normalizeAgentManagedRegistry(oldRegistry);
  const plugins = {};
  for (const [plugin, entry] of Object.entries(old.plugins)) {
    plugins[plugin] = {
      agentManaged: true,
      tools: [...entry.tools],
    };
  }
  if (normalizedResult.ok !== true) {
    // lifecycle 损坏时保守返回旧 registry 的归一化副本（feature off，不改动）。
    return { version: old.version ?? 1, plugins };
  }
  const lc = normalizedResult.lifecycle;
  for (const record of Object.values(lc.skills)) {
    const plugin = record.plugin;
    const tool = record.tool;
    const keep = record.status !== "retired";
    const entry = plugins[plugin];
    if (entry === undefined) {
      if (keep) plugins[plugin] = { agentManaged: true, tools: [tool] };
      continue;
    }
    const index = entry.tools.indexOf(tool);
    if (keep && index === -1) entry.tools.push(tool);
    if (!keep && index !== -1) entry.tools.splice(index, 1);
  }
  return { version: old.version ?? 1, plugins };
}

/** 状态机白名单：只有允许的跳转才被 audit/执行器接受。 */
const TRANSITIONS = new Set([
  "active>retire-pending",
  "active>update-needed",
  "active>update-staged",
  "retire-pending>retired",
  "retire-pending>active",
  "retire-pending>update-needed",
  "retired>active",
  "update-needed>active",
  "update-needed>update-staged",
  "update-staged>active",
  "update-staged>update-needed",
]);

export function transitionAllowed(from, to) {
  return typeof from === "string" && typeof to === "string" && TRANSITIONS.has(`${from}>${to}`);
}
