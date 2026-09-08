// ka-whale-workflow 7.4 P1 tier fast lane 探针：
//   - S 分类契约（四个机器可判定条件 + 默认 M + 连续误判默认 M）；
//   - tier-aware canAdvance / advanceListFor / stageInjectionText 三种形态；
//   - static def.canAdvance 数组与 7.3.5 逐字节一致；
//   - stage-store tier 持久化 + legacy 无 tier 文件兼容；
//   - whale_report 同调用 tier:"S"+nextStage:"working" 的 ORDERING；
//   - requiresUserConfirmation 触发 S→M（带 upgradeHistory）且不可降级；
//   - ka_sub_whale 在 run tier=S 时结构化拒绝。
// 运行：node KazPlugins/ka-whale-workflow/probe-kaz74-tier.mjs
import plugin, { createStageStore, DEFAULT_SECTION } from "./lib/index.js";
import {
  MAIN_ROLE,
  canAdvance,
  advanceListFor,
  stageInjectionText,
  stageDefinitionFor,
} from "./lib/stage-defs.js";
import {
  classifyTier,
  recordSMisjudgment,
  sessionDefaultTierAfterMisjudgments,
  normalizeTierSignals,
  normalizeUpgradeHistory,
} from "./lib/tier.js";
import { persistFinalPlanRun } from "./lib/task-plan-store.js";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

const TMP = mkdtempSync(join(tmpdir(), "whale-kaz74-tier-"));
const LEGACY_STORE = join(TMP, "legacy.json");
const TIER_STORE = join(TMP, "tier.json");
const LIVE_STORE = join(TMP, "live.json");
const RUN_DIR = join(TMP, "run");
mkdirSync(RUN_DIR, { recursive: true });

function runRecordFromFile(file, sessionId) {
  const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw).workflowRuns?.[sessionId] ?? null;
}

function makeBase({ tierFastLane }) {
  const listeners = new Map();
  const registeredTools = new Map();
  const provided = {};
  const roundReports = [];
  const settings = {
    register(ns, _schema, opts = {}) {
      let current = { ...(opts.base ?? {}) };
      return {
        get: () => ({ ...current }),
        watch: () => () => {},
        update: (patch) => { current = { ...current, ...patch }; return Promise.resolve(); },
      };
    },
    get: () => ({ enabled: true, includeSubagents: false, tierFastLane: tierFastLane === true }),
    update: () => Promise.resolve(),
  };
  const toolsMock = {
    register(def) {
      registeredTools.set(def.name, def);
      return () => registeredTools.delete(def.name);
    },
    schemas() {
      return [...registeredTools.keys()].map((name) => ({ name, description: "", parameters: {} }));
    },
    get(name) {
      return registeredTools.get(name);
    },
  };
  const agentRegistry = new Map();
  const mockKazMode = {
    pluginConfig: () => ({
      enabled: true,
      includeSubagents: false,
      tierFastLane: tierFastLane === true,
    }),
    toolVisible: () => true,
  };
  const base = {
    fiber: { state: 0 },
    logger: { info: () => {}, warn: (...args) => console.log("[mock:warn]", ...args), debug: () => {} },
    async plugin() { return; },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return () => {};
    },
    inject(deps, cb) {
      if (deps.includes("settings")) setImmediate(() => cb({ ...base, settings }));
    },
    effect(fn) {
      const dispose = fn();
      return () => { if (typeof dispose === "function") dispose(); };
    },
    provide(name, value) {
      provided[name] = value;
      return () => { delete provided[name]; };
    },
    get(name) {
      if (name in provided) return provided[name];
      if (name === "settings") return settings;
      if (name === "tools") return toolsMock;
      if (name === "kazMode") return mockKazMode;
      if (name === "roundDisplay") return { report: (payload) => roundReports.push(payload) };
      if (name === "agents") return { get: (id) => agentRegistry.get(id) };
      if (name === "subagents") {
        return {
          listChildren: async () => [],
          followup: async () => "msg",
          startContinuable: async () => ({}),
        };
      }
      return undefined;
    },
    systemPrompt: { section() { return () => {}; } },
    tools: toolsMock,
  };
  return { base, listeners, registeredTools, provided, roundReports };
}

const mainAgentOf = () => ({
  id: "main",
  session: { id: "main", header: { cwd: RUN_DIR }, events: [] },
  options: {},
});

// ---------------------------------------------------------------------------
// ① Pure contract: classification / graph / injection text / static arrays.
// ---------------------------------------------------------------------------
{
  check(
    "7.4 tier fast-lane behavior flag defaults off (D25)",
    DEFAULT_SECTION?.tierFastLane === false,
  );
  const s = classifyTier({
    changedFileCount: 1,
    riskWordHit: false,
    probeCovers: true,
    probePasses: true,
  });
  const m = classifyTier({
    changedFileCount: 2,
    riskWordHit: false,
    probeCovers: true,
    probePasses: true,
  });
  const undecidable = classifyTier({ changedFileCount: null });
  check(
    "classifyTier: S only when all four machine-decidable conditions hold; otherwise default M",
    s.tier === "S" &&
      s.tierSignals.includes("single-file") &&
      s.tierSignals.includes("probe-pass") &&
      m.tier === "M" &&
      m.tierSignals.includes("not-single-file") &&
      undecidable.tier === "M" &&
      undecidable.tierSignals.includes("undecidable-default-m"),
  );
  const history = recordSMisjudgment(recordSMisjudgment([], true), true);
  check(
    "two consecutive S misjudgments make the session default M; non-S resets",
    sessionDefaultTierAfterMisjudgments(history) === "M" &&
      sessionDefaultTierAfterMisjudgments(recordSMisjudgment([], false)) === null,
  );
  const assessStatic = stageDefinitionFor(MAIN_ROLE, "assess-complexity")?.canAdvance;
  const workingStatic = stageDefinitionFor(MAIN_ROLE, "working")?.canAdvance;
  check(
    "static def.canAdvance arrays stay byte-identical to 7.3.5",
    JSON.stringify(assessStatic) ===
      JSON.stringify(["challenge-plan", "communication", "compass_context_before_communication"]) &&
      JSON.stringify(workingStatic) ===
        JSON.stringify(["decide-tools-before-writing-plan", "write-plan", "memory-maintenance"]),
  );
  check(
    "advanceListFor: default returns static list; S returns only gated edge; M static",
    JSON.stringify(advanceListFor(MAIN_ROLE, "assess-complexity")) === JSON.stringify(assessStatic) &&
      JSON.stringify(advanceListFor(MAIN_ROLE, "assess-complexity", { tier: "S" })) === JSON.stringify(["working"]) &&
      JSON.stringify(advanceListFor(MAIN_ROLE, "assess-complexity", { tier: "M" })) === JSON.stringify(assessStatic) &&
      JSON.stringify(advanceListFor(MAIN_ROLE, "working", { tier: "S" })) === JSON.stringify(["communication"]),
  );
  check(
    "canAdvance: gated edges true only for main+S; M-only main edges closed under S",
    canAdvance(MAIN_ROLE, "assess-complexity", "working", { tier: "S" }) === true &&
      canAdvance(MAIN_ROLE, "assess-complexity", "challenge-plan", { tier: "S" }) === false &&
      canAdvance(MAIN_ROLE, "working", "communication", { tier: "S" }) === true &&
      canAdvance(MAIN_ROLE, "working", "write-plan", { tier: "S" }) === false &&
      canAdvance(MAIN_ROLE, "assess-complexity", "working") === false &&
      canAdvance(MAIN_ROLE, "working", "communication") === false,
  );
  check(
    "subagents ignore tier ctx (worker static edge unchanged)",
    canAdvance("worker", "challenge-plan", "working-then-compress-context-then-report", { tier: "S" }) === true,
  );
  const sAssessText = stageInjectionText(MAIN_ROLE, "assess-complexity", { tier: "S" });
  const sWorkingText = stageInjectionText(MAIN_ROLE, "working", { tier: "S" });
  const defaultAssessText = stageInjectionText(MAIN_ROLE, "assess-complexity");
  const advanceLineOf = (text) =>
    String(text)
      .split("\n")
      .find((line) => line.startsWith("Can advance to:"));
  check(
    "stageInjectionText: S text has only gated line; default/M text stays static",
    advanceLineOf(sAssessText) === "Can advance to: [working]" &&
      advanceLineOf(sWorkingText) === "Can advance to: [communication]" &&
      advanceLineOf(defaultAssessText) ===
        "Can advance to: [challenge-plan, communication, compass_context_before_communication]" &&
      !defaultAssessText.includes("Can advance to: [working]") &&
      stageInjectionText(MAIN_ROLE, "assess-complexity", { tier: "M" }) === defaultAssessText,
  );
}

// ---------------------------------------------------------------------------
// ② Stage-store run-tier persistence: round-trip + legacy no-tier + no downgrade.
// ---------------------------------------------------------------------------
{
  writeFileSync(
    LEGACY_STORE,
    JSON.stringify({
      version: 6,
      sessions: { main: "working" },
      workflowRuns: { main: { runId: 1, enteredStages: ["assess-complexity", "working"] } },
    }),
    "utf8",
  );
  const legacy = createStageStore(LEGACY_STORE);
  check(
    "legacy workflowRuns without tier load as no-tier (null) and keep old fields",
    legacy.getWorkflowRun("main")?.runId === 1 &&
      legacy.getWorkflowRunTier("main") === null,
  );

  const store = createStageStore(TIER_STORE);
  store.set("main", "assess-complexity");
  store.beginWorkflowRun("main");
  store.setWorkflowRunTier("main", {
    tier: "S",
    tierReason: "single-file; no risk; probe passes",
    tierSignals: ["single-file", "no-risk-word", "existing-probe", "probe-pass"],
  });
  const tierAfterInitial = store.getWorkflowRunTier("main");
  const upgraded = store.upgradeWorkflowRunTier("main", {
    to: "M",
    trigger: "requires-user-confirmation",
    reason: "user confirmation required",
    at: "2026-01-01T00:00:00.000Z",
  });
  const downgradeAttempt = store.upgradeWorkflowRunTier("main", {
    to: "S",
    trigger: "manual-downgrade",
  });
  const reloaded = createStageStore(TIER_STORE);
  const reloadedTier = reloaded.getWorkflowRunTier("main");
  check(
    "stage-store tier round-trips after reload with upgradeHistory; downgrade denied",
    tierAfterInitial?.tier === "S" &&
      upgraded?.ok === true &&
      upgraded?.entry?.from === "S" &&
      upgraded?.entry?.to === "M" &&
      downgradeAttempt?.ok === false &&
      downgradeAttempt?.code === "tier-downgrade-denied" &&
      reloadedTier?.tier === "M" &&
      reloadedTier?.upgradeHistory?.length === 1 &&
      reloadedTier.upgradeHistory[0].trigger === "requires-user-confirmation",
  );
  const storeAfterBegin = createStageStore(TIER_STORE);
  storeAfterBegin.set("main", "assess-complexity");
  storeAfterBegin.beginWorkflowRun("main");
  check(
    "new workflow run clears previous tier/history",
    storeAfterBegin.getWorkflowRunTier("main") === null,
  );
  check(
    "normalizers drop malformed signals/history entries",
    JSON.stringify(normalizeTierSignals(["single-file", 1, "", "single-file"])) === JSON.stringify(["single-file"]) &&
      normalizeUpgradeHistory([{ from: "S", to: "M", trigger: "ok", at: "now" }, { from: "X" }]).length === 1,
  );
}

// ---------------------------------------------------------------------------
// ③ Live whale_report ordering + S→M upgrade + S delegation guard.
// ---------------------------------------------------------------------------
{
  const seedStore = createStageStore(LIVE_STORE);
  seedStore.set("main", "assess-complexity");
  seedStore.beginWorkflowRun("main");
  persistFinalPlanRun({
    projectRoot: RUN_DIR,
    sessionId: "main",
    runId: 1,
    payload: {
      status: "finalized",
      items: [{ planItemId: "p1", persona: "worker", task: "Worker task", assignedTools: [] }],
    },
  });

  const { base, registeredTools, provided } = makeBase({ tierFastLane: true });
  await plugin.apply(base, {
    stageStore: LIVE_STORE,
    projectRoot: RUN_DIR,
    tierFastLane: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 25));

  const whale = registeredTools.get("whale_report");
  const kaSub = registeredTools.get("ka_sub_whale");
  const workflow = provided["kaWhaleWorkflow"];
  const mainAgent = mainAgentOf();
  const signal = () => new AbortController().signal;
  const liveRunFromDisk = () => createStageStore(LIVE_STORE);
  check(
    "plugin exposes whale_report/ka_sub_whale and tier service under flag on",
    typeof whale?.execute === "function" &&
      typeof kaSub?.execute === "function" &&
      typeof workflow?.upgradeRunTier === "function" &&
      typeof workflow?.tierRecordOf === "function",
  );

  let invalidTierError = null;
  try {
    await whale.execute(
      { tier: "X", nextStage: "working" },
      { agent: mainAgent, signal: signal() },
    );
  } catch (error) {
    invalidTierError = error;
  }
  check(
    "whale_report rejects unknown tier with structured tier-invalid and no stage change",
    invalidTierError?.code === "tier-invalid" &&
      liveRunFromDisk().get("main") === "assess-complexity",
  );

  // CRITICAL ORDERING: single whale_report call records S then evaluates edge as S.
  const firstAdvance = await whale.execute(
    {
      tier: "S",
      tierReason: "single file; existing probe passes",
      tierSignals: ["single-file", "no-risk-word", "existing-probe", "probe-pass"],
      nextStage: "working",
    },
    { agent: mainAgent, signal: signal() },
  );
  const liveRun = liveRunFromDisk();
  const liveTier = liveRun.getWorkflowRunTier("main");
  check(
    "whale_report tier:S + nextStage:working from assess is accepted in the same call (ordering fix)",
    firstAdvance?.ok === true &&
      firstAdvance?.stage === "working" &&
      liveTier?.tier === "S" &&
      liveRun.get("main") === "working",
  );

  const deniedDelegation = await kaSub.execute(
    { planItemId: "p1" },
    { agent: mainAgent, signal: signal() },
  );
  check(
    "ka_sub_whale rejects delegation while run tier=S with structured code",
    deniedDelegation?.ok === false &&
      deniedDelegation?.code === "tier-s-delegation-denied",
  );

  let deniedMOnly = null;
  try {
    await whale.execute(
      { nextStage: "write-plan" },
      { agent: mainAgent, signal: signal() },
    );
  } catch (error) {
    deniedMOnly = error;
  }
  check(
    "whale_report rejects M-only working→write-plan while tier=S",
    deniedMOnly !== null &&
      deniedMOnly.message.includes("workflow-stage-deny"),
  );

  const upgraded = await workflow.upgradeRunTier(mainAgent, {
    to: "M",
    trigger: "requires-user-confirmation",
    reason: "intent map requires user confirmation",
    at: "2026-01-01T00:00:00.000Z",
  });
  const downgradeAgain = await workflow.upgradeRunTier(mainAgent, {
    to: "S",
    trigger: "manual-downgrade",
  });
  const postUpgradeTier = workflow.tierRecordOf(mainAgent);
  check(
    "requiresUserConfirmation upgrades S→M with history; S edges closed; downgrade denied",
    upgraded?.ok === true &&
      upgraded?.entry?.from === "S" &&
      upgraded?.entry?.to === "M" &&
      downgradeAgain?.ok === false &&
      downgradeAgain?.code === "tier-downgrade-denied" &&
      postUpgradeTier?.tier === "M" &&
      postUpgradeTier?.upgradeHistory?.length === 1 &&
      canAdvance(MAIN_ROLE, "working", "communication", { tier: "M" }) === false &&
      canAdvance(MAIN_ROLE, "working", "write-plan", { tier: "M" }) === true,
  );

  const secondAdvance = await whale.execute(
    { nextStage: "write-plan" },
    { agent: mainAgent, signal: signal() },
  );
  check(
    "after S→M upgrade, M-only edge reopens and whale_report accepts it",
    secondAdvance?.ok === true && secondAdvance?.stage === "write-plan",
  );
}

if (failures === 0) rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nKAZ74-TIER PROBE OK" : `\nKAZ74-TIER PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
