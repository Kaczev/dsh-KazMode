// kaz-shared 探针：终案 E Skill 生命周期纯函数层（skill-lifecycle.js）。
// 覆盖：v2 lifecycle 归一化/损坏 feature off；skill key；默认阈值；audit 建议动作
// （bootstrap/retire-pending/retire/reactivate/update-needed/commit-update/
// reconcile-registry）；registry 投影；状态机白名单。
// 运行：node KazPlugins/kaz-shared/probe-skill-lifecycle.mjs
import {
  SKILL_LIFECYCLE_VERSION,
  SKILL_LIFECYCLE_STATUSES,
  SKILL_LIFECYCLE_DEFAULT_UNUSED_DAYS_BEFORE_PENDING,
  SKILL_LIFECYCLE_DEFAULT_PENDING_GRACE_DAYS,
  SKILL_LIFECYCLE_DEFAULT_TOOL_FAIL_WINDOW_DAYS,
  SKILL_LIFECYCLE_DEFAULT_TOOL_FAIL_THRESHOLD,
  SKILL_LIFECYCLE_DEFAULT_TOOL_FAIL_RATE,
  SKILL_LIFECYCLE_DEFAULT_PROBE_FAIL_THRESHOLD,
  SKILL_LIFECYCLE_DEFAULT_AUDIT_INTERVAL_HOURS,
  SKILL_LIFECYCLE_DEFAULT_MAX_AUTO_ACTIONS,
  SKILL_LIFECYCLE_DEFAULTS,
  normalizeSkillLifecycle,
  normalizeSkillLifecycleDefaults,
  skillKeyOf,
  auditSkillLifecycle,
  projectRegistryFromLifecycle,
  transitionAllowed,
} from "./lib/tool-lists.js";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

const NOW = "2026-09-02T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const isoAgo = (days) => new Date(NOW_MS - days * 86400000).toISOString();

const PLUGIN = "kaz-skill-safe-json";
const TOOL = "safe_json_write";
const KEY = skillKeyOf(PLUGIN, TOOL);

function baseRecord(overrides = {}) {
  return {
    plugin: PLUGIN,
    tool: TOOL,
    version: "0.1.0",
    status: "active",
    statusChangedAt: isoAgo(200),
    createdAt: isoAgo(200),
    firstSeenAt: isoAgo(200),
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
    ...overrides,
  };
}

const registry = {
  version: 1,
  plugins: { [PLUGIN]: { agentManaged: true, tools: [TOOL] } },
};

// ---------- 常量 / 默认阈值 ----------
check("SKILL_LIFECYCLE_VERSION = 2", SKILL_LIFECYCLE_VERSION === 2);
check(
  "SKILL_LIFECYCLE_STATUSES 含五个状态",
  JSON.stringify(SKILL_LIFECYCLE_STATUSES) ===
    JSON.stringify(["active", "retire-pending", "retired", "update-needed", "update-staged"]),
);
check(
  "默认阈值 60/7/30/3/0.5/2/24/1",
  SKILL_LIFECYCLE_DEFAULT_UNUSED_DAYS_BEFORE_PENDING === 60 &&
    SKILL_LIFECYCLE_DEFAULT_PENDING_GRACE_DAYS === 7 &&
    SKILL_LIFECYCLE_DEFAULT_TOOL_FAIL_WINDOW_DAYS === 30 &&
    SKILL_LIFECYCLE_DEFAULT_TOOL_FAIL_THRESHOLD === 3 &&
    SKILL_LIFECYCLE_DEFAULT_TOOL_FAIL_RATE === 0.5 &&
    SKILL_LIFECYCLE_DEFAULT_PROBE_FAIL_THRESHOLD === 2 &&
    SKILL_LIFECYCLE_DEFAULT_AUDIT_INTERVAL_HOURS === 24 &&
    SKILL_LIFECYCLE_DEFAULT_MAX_AUTO_ACTIONS === 1,
);
check(
  "SKILL_LIFECYCLE_DEFAULTS 与常量一致",
  SKILL_LIFECYCLE_DEFAULTS.unusedDaysBeforePending === 60 &&
    SKILL_LIFECYCLE_DEFAULTS.maxAutoActionsPerRun === 1,
);

// ---------- skillKeyOf / normalize ----------
check("skillKeyOf 返回 <plugin>/<tool>", skillKeyOf("Kaz_Skill_Safe_JSON", " safe_json_write ") === KEY);
check("skillKeyOf 空输入 → 空串", skillKeyOf("", "x") === "" && skillKeyOf("x", "") === "");

{
  const empty = normalizeSkillLifecycle({ skills: {} });
  check(
    "空 lifecycle 归一化 ok 且带默认值",
    empty.ok === true &&
      empty.lifecycle.version === 2 &&
      empty.lifecycle.defaults.unusedDaysBeforePending === 60,
  );
  const filled = normalizeSkillLifecycle({ skills: { [KEY]: baseRecord() } });
  check(
    "单条记录归一化：plugin/tool/status/统计/嵌套对象齐全",
    filled.ok === true &&
      filled.lifecycle.skills[KEY] !== undefined &&
      filled.lifecycle.skills[KEY].usageCount === 0 &&
      filled.lifecycle.skills[KEY].probe.lastResult === "not-run" &&
      filled.lifecycle.skills[KEY].update.state === "none" &&
      filled.lifecycle.skills[KEY].autoFixPolicy === "never",
  );
  check("损坏：null/数组/skills 非对象 → ok:false", normalizeSkillLifecycle(null).ok === false && normalizeSkillLifecycle([]).ok === false && normalizeSkillLifecycle({ skills: [] }).ok === false);
  check("损坏：记录非对象 → ok:false", normalizeSkillLifecycle({ skills: { [KEY]: "bad" } }).ok === false);
  check("损坏：未知 status → ok:false", normalizeSkillLifecycle({ skills: { [KEY]: baseRecord({ status: "unknown" }) } }).ok === false);
  check("损坏：缺 plugin/tool 且 key 不可推导 → ok:false", normalizeSkillLifecycle({ skills: { "no-slash": { status: "active" } } }).ok === false);
  const customDefaults = normalizeSkillLifecycleDefaults({ unusedDaysBeforePending: 10, toolFailRate: 0.3, maxAutoActionsPerRun: 99 });
  check(
    "normalizeSkillLifecycleDefaults 补默认/钳制",
    customDefaults.unusedDaysBeforePending === 10 &&
      customDefaults.toolFailRate === 0.3 &&
      customDefaults.maxAutoActionsPerRun === 1 &&
      customDefaults.pendingGraceDays === 7,
  );
}

// ---------- audit：bootstrap / idle / pending→retire ----------
{
  const actions = auditSkillLifecycle({ skills: {} }, registry, NOW);
  check(
    "未登记工具 → bootstrap-active",
    actions.some((a) => a.type === "bootstrap-active" && a.key === KEY && a.to === "active"),
  );
}
{
  const lc = { skills: { [KEY]: baseRecord({ createdAt: isoAgo(70), firstSeenAt: isoAgo(70) }) } };
  const actions = auditSkillLifecycle(lc, registry, NOW, { defaults: { unusedDaysBeforePending: 60 } });
  check("active 闲置 ≥60 天 → retire-pending", actions.some((a) => a.type === "retire-pending" && a.key === KEY && a.to === "retire-pending"));
}
{
  const lc = { skills: { [KEY]: baseRecord({ createdAt: isoAgo(10) }) } };
  const actions = auditSkillLifecycle(lc, registry, NOW);
  check("active 未达闲置阈值 → 无动作", actions.length === 0);
}
{
  const lc = {
    skills: {
      [KEY]: baseRecord({
        status: "retire-pending",
        retire: { reason: "idle", pendingAt: isoAgo(8), confirmedAt: null },
      }),
    },
  };
  const actions = auditSkillLifecycle(lc, registry, NOW);
  check("retire-pending 宽限 ≥7 天 → retired", actions.some((a) => a.type === "retire" && a.key === KEY && a.to === "retired"));
}
{
  const lc = {
    skills: {
      [KEY]: baseRecord({
        status: "retire-pending",
        retire: { reason: "idle", pendingAt: isoAgo(1), confirmedAt: null },
      }),
    },
  };
  const actions = auditSkillLifecycle(lc, registry, NOW);
  check("retire-pending 宽限未到 → 无动作", actions.length === 0);
}

// ---------- audit：真实使用复活 / 失败 / 补丁 / reconcile ----------
{
  const lc = {
    skills: {
      [KEY]: baseRecord({
        status: "retire-pending",
        lastUsedAt: isoAgo(0),
        retire: { reason: "idle", pendingAt: isoAgo(10), confirmedAt: null },
      }),
    },
  };
  const actions = auditSkillLifecycle(lc, registry, NOW);
  check("retire-pending 真实使用 → reactivate active", actions.some((a) => a.type === "reactivate" && a.to === "active" && a.key === KEY));
}
{
  const lc = {
    skills: {
      [KEY]: baseRecord({
        status: "retired",
        lastUsedAt: isoAgo(0),
        retire: { reason: "idle", pendingAt: isoAgo(20), confirmedAt: isoAgo(7) },
      }),
    },
  };
  const actions = auditSkillLifecycle(lc, registry, NOW);
  check("retired 后真实使用 → reactivate active", actions.some((a) => a.type === "reactivate" && a.to === "active"));
}
{
  const lc = {
    skills: {
      [KEY]: baseRecord({
        lastUsedAt: isoAgo(1),
        usageCount: 6,
        failureCount: 4,
        consecutiveFailures: 2,
        lastErrorAt: isoAgo(0),
      }),
    },
  };
  const actions = auditSkillLifecycle(lc, registry, NOW);
  check("真实调用失败（近期 ≥3 且失败率 ≥50%）→ update-needed", actions.some((a) => a.type === "update-needed" && a.to === "update-needed"));
}
{
  const lc = {
    skills: {
      [KEY]: baseRecord({
        probe: { lastRunAt: NOW, lastResult: "fail", failCount: 2, passCount: 0 },
      }),
    },
  };
  const actions = auditSkillLifecycle(lc, registry, NOW);
  check("探针连续失败 ≥2 → update-needed", actions.some((a) => a.type === "update-needed"));
}
{
  const lc = {
    skills: {
      [KEY]: baseRecord({
        status: "update-staged",
        update: { state: "staged", evidence: ["fix"], patchRef: "process/safe-json-write/staged", stagedVersion: "0.2.0" },
      }),
    },
  };
  const actions = auditSkillLifecycle(lc, registry, NOW, { patchExists: () => true });
  check("update-staged 且补丁存在 → commit-update", actions.some((a) => a.type === "commit-update" && a.to === "active"));
  const noPatch = auditSkillLifecycle(lc, registry, NOW, { patchExists: () => false });
  check("update-staged 但补丁缺失 → 无 commit", noPatch.some((a) => a.type === "commit-update") === false);
}
{
  const activeMissing = auditSkillLifecycle(
    { skills: { [KEY]: baseRecord() } },
    { version: 1, plugins: {} },
    NOW,
  );
  check("active 但 registry 缺失工具 → reconcile-registry", activeMissing.some((a) => a.type === "reconcile-registry" && a.reason.includes("expects")));
  const retiredPresent = auditSkillLifecycle(
    {
      skills: {
        [KEY]: baseRecord({
          status: "retired",
          retire: { reason: "idle", pendingAt: isoAgo(20), confirmedAt: isoAgo(10) },
        }),
      },
    },
    registry,
    NOW,
  );
  check("retired 但 registry 仍含工具 → reconcile-registry", retiredPresent.some((a) => a.type === "reconcile-registry" && a.reason.includes("removed")));
}
{
  check("lifecycle 损坏 → audit 返回 []（feature off）", auditSkillLifecycle(null, registry, NOW).length === 0 && auditSkillLifecycle({ skills: { [KEY]: "bad" } }, registry, NOW).length === 0);
}

// ---------- registry 投影 / 状态机 ----------
{
  const retiredLc = {
    skills: {
      [KEY]: baseRecord({
        status: "retired",
        retire: { reason: "idle", pendingAt: isoAgo(20), confirmedAt: isoAgo(10) },
      }),
    },
  };
  const projected = projectRegistryFromLifecycle(retiredLc, registry);
  check(
    "retired 工具从 registry tools[] 移除且保留 plugin 条目 agentManaged:true",
    projected.plugins[PLUGIN] !== undefined &&
      projected.plugins[PLUGIN].agentManaged === true &&
      projected.plugins[PLUGIN].tools.length === 0,
  );
  const activeLc = { skills: { [KEY]: baseRecord() } };
  const projectedActive = projectRegistryFromLifecycle(activeLc, { version: 1, plugins: {} });
  check(
    "active 工具在旧 registry 缺失时补登记",
    projectedActive.plugins[PLUGIN]?.agentManaged === true &&
      projectedActive.plugins[PLUGIN]?.tools.includes(TOOL) === true,
  );
  const mixedProject = projectRegistryFromLifecycle(activeLc, registry);
  check(
    "投影不改旧 registry 入参、保留既有顺序",
    registry.plugins[PLUGIN].tools.length === 1 &&
      JSON.stringify(mixedProject.plugins[PLUGIN].tools) === JSON.stringify([TOOL]),
  );
  const brokenProject = projectRegistryFromLifecycle(null, registry);
  check(
    "lifecycle 损坏时投影保守保留旧 registry（feature off）",
    brokenProject.plugins[PLUGIN]?.tools.includes(TOOL) === true &&
      brokenProject.plugins[PLUGIN]?.agentManaged === true,
  );
}
{
  check(
    "transitionAllowed 白名单通过",
    transitionAllowed("active", "retire-pending") === true &&
      transitionAllowed("retire-pending", "retired") === true &&
      transitionAllowed("retire-pending", "active") === true &&
      transitionAllowed("retired", "active") === true &&
      transitionAllowed("update-needed", "update-staged") === true &&
      transitionAllowed("update-staged", "active") === true &&
      transitionAllowed("active", "update-needed") === true,
  );
  check(
    "transitionAllowed 非法跳转被禁",
    transitionAllowed("active", "retired") === false &&
      transitionAllowed("retired", "retire-pending") === false &&
      transitionAllowed("update-staged", "retired") === false &&
      transitionAllowed("unknown", "active") === false,
  );
}

console.log(failures === 0 ? "\nSKILL-LIFECYCLE PROBE OK" : `\nSKILL-LIFECYCLE PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
