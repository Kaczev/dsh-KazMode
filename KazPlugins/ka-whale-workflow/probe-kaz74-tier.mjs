// ka-whale-workflow 7.4 P1/P1b tier fast lane 探针：
//   - S 分类契约（四个机器可判定条件 + 默认 M + session-default 覆盖）；
//   - tier-aware canAdvance / advanceListFor / stageInjectionText 三种形态；
//   - static def.canAdvance 数组与 7.3.5 逐字节一致；
//   - stage-store tier 持久化 + legacy 无 tier 文件兼容；
//   - whale_report 同调用 tier:"S"+nextStage:"working" 的 ORDERING；
//   - requiresUserConfirmation / budget-exceeded / working-entry 自动 S→M；
//   - session 连续误判默认 M 持久化；flag off 全部不触发（7.3.5 parity）。
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
  normalizeSMisjudgmentHistory,
  tierBudgetExceeded,
  PROVISIONAL_S_TIER_BUDGET,
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
const MISJUDGE_STORE = join(TMP, "misjudge.json");
const BUDGET_STORE = join(TMP, "budget.json");
const LOCAL_TURN_STORE = join(TMP, "local-turn.json");
const ENTRY_STORE = join(TMP, "entry.json");
const OFF_STORE = join(TMP, "off.json");
const RESET_STORE = join(TMP, "reset.json");
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

const agentOf = (id) => ({
  id,
  session: { id, header: { cwd: RUN_DIR }, events: [] },
  options: {},
});
const mainAgentOf = () => agentOf("main");

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
  const forcedBySession = classifyTier(
    {
      changedFileCount: 1,
      riskWordHit: false,
      probeCovers: true,
      probePasses: true,
    },
    "M",
  );
  check(
    "classifyTier: session default M forces S facts down to M with session-default-m signal",
    forcedBySession.tier === "M" &&
      forcedBySession.tierSignals.includes("session-default-m") &&
      forcedBySession.tierSignals.includes("single-file"),
  );
  check(
    "provisional S budget is a named PM3-uncalibrated constant; exceed is threshold-based",
    PROVISIONAL_S_TIER_BUDGET?.modelRequests > 0 &&
      PROVISIONAL_S_TIER_BUDGET?.turns > 0 &&
      tierBudgetExceeded({ modelRequests: 2, turns: 1 }, { modelRequests: 2, turns: 9 }) === true &&
      tierBudgetExceeded({ modelRequests: 1, turns: 9 }, { modelRequests: 2, turns: 9 }) === true &&
      tierBudgetExceeded({ modelRequests: 1, turns: 8 }, { modelRequests: 2, turns: 9 }) === false,
  );
  check(
    "P8 regression: large cumulative turns must not trip the run-local turn budget",
    tierBudgetExceeded(
      { modelRequests: 1, turns: 2, turnsCumulative: 87, turnBaseline: 85 },
      { modelRequests: 100, turns: 12 },
    ) === false &&
      tierBudgetExceeded(
        { modelRequests: 1, turns: 12, turnsCumulative: 87, turnBaseline: 75 },
        { modelRequests: 100, turns: 12 },
      ) === true,
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
      normalizeUpgradeHistory([{ from: "S", to: "M", trigger: "ok", at: "now" }, { from: "X" }]).length === 1 &&
      JSON.stringify(normalizeSMisjudgmentHistory(["S", "X", "S"])) === JSON.stringify(["S", "S"]) &&
      JSON.stringify(normalizeSMisjudgmentHistory(["S", "S", "S"])) === JSON.stringify(["S", "S"]),
  );
}

// ---------------------------------------------------------------------------
// ②b Session S-misjudgment counter: durable, two-consecutive default M, reset.
// ---------------------------------------------------------------------------
{
  const misjudge = createStageStore(MISJUDGE_STORE);
  const first = misjudge.recordSessionSMisjudgment("main", true);
  const reloaded = createStageStore(MISJUDGE_STORE);
  const reloadedHistory = reloaded.getSessionTierMisjudgmentHistory("main");
  const second = reloaded.recordSessionSMisjudgment("main", true);
  const afterTwo = createStageStore(MISJUDGE_STORE);
  check(
    "session S-misjudgment counter is durable; two consecutive yield session default M",
    first?.ok === true &&
      first?.history?.length === 1 &&
      first?.defaultTier === null &&
      reloadedHistory?.length === 1 &&
      second?.ok === true &&
      second?.history?.length === 2 &&
      second?.defaultTier === "M" &&
      afterTwo.sessionTierDefaultOf("main") === "M",
  );
  const reset = afterTwo.recordSessionSMisjudgment("main", false);
  const afterReset = createStageStore(MISJUDGE_STORE);
  check(
    "successful non-misjudged outcome resets consecutive counter (history empty, default null)",
    reset?.ok === true &&
      reset?.history?.length === 0 &&
      reset?.defaultTier === null &&
      afterReset.getSessionTierMisjudgmentHistory("main")?.length === 0 &&
      afterReset.sessionTierDefaultOf("main") === null,
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

// ---------------------------------------------------------------------------
// ④ P1b runtime budget-exceeded auto-upgrade (S→M + counter, in-memory meter).
// ---------------------------------------------------------------------------
{
  const sessionId = "budget-main";
  const seedStore = createStageStore(BUDGET_STORE);
  seedStore.set(sessionId, "assess-complexity");
  seedStore.beginWorkflowRun(sessionId);
  const { base, listeners, registeredTools, provided } = makeBase({ tierFastLane: true });
  await plugin.apply(base, {
    stageStore: BUDGET_STORE,
    projectRoot: RUN_DIR,
    tierFastLane: true,
    sTierBudget: { modelRequests: 3, turns: 99 },
    costMeterDirectory: join(TMP, "meter-budget"),
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const whale = registeredTools.get("whale_report");
  const workflow = provided["kaWhaleWorkflow"];
  const agent = agentOf(sessionId);
  const signal = () => new AbortController().signal;
  const advanceS = await whale.execute(
    {
      tier: "S",
      tierReason: "single file; probe passes",
      tierSignals: ["single-file", "no-risk-word", "existing-probe", "probe-pass"],
      nextStage: "working",
    },
    { agent, signal: signal() },
  );
  const preStep = listeners.get("agent/pre-step")?.[0];
  const runPre = async () =>
    preStep(
      { agent, messages: [], turn: 1 },
      async () => ({ kind: "enter", messages: [] }),
    );
  await runPre();
  await runPre();
  await runPre(); // 第 3 次 request 达到 sTierBudget.modelRequests=3 → 自动升 M
  const afterDisk = createStageStore(BUDGET_STORE);
  const afterTier = afterDisk.getWorkflowRunTier(sessionId);
  const history = afterDisk.getSessionTierMisjudgmentHistory(sessionId);
  check(
    "budget-exceeded: S run past provisional budget auto-upgrades S→M with trigger and counts one misjudgment",
    advanceS?.ok === true &&
      advanceS?.stage === "working" &&
      afterTier?.tier === "M" &&
      afterTier?.upgradeHistory?.length === 1 &&
      afterTier.upgradeHistory[0].trigger === "budget-exceeded" &&
      JSON.stringify(history) === JSON.stringify(["S"]) &&
      workflow.sessionTierDefaultOf(sessionId) === null,
  );
  const downgradeDenied = await workflow.upgradeRunTier(agent, {
    to: "S",
    trigger: "manual-downgrade",
  });
  check(
    "budget-exceeded upgrade is irreversible within the run",
    downgradeDenied?.ok === false && downgradeDenied?.code === "tier-downgrade-denied",
  );
}

// ---------------------------------------------------------------------------
// ④b P8 regression: session cumulative turns far above budget must not
// auto-upgrade an S run while the run-local turn count is under budget.
// ---------------------------------------------------------------------------
{
  const sessionId = "local-turn-main";
  const seedStore = createStageStore(LOCAL_TURN_STORE);
  seedStore.set(sessionId, "assess-complexity");
  seedStore.beginWorkflowRun(sessionId);
  const { base, listeners, registeredTools, provided } = makeBase({ tierFastLane: true });
  await plugin.apply(base, {
    stageStore: LOCAL_TURN_STORE,
    projectRoot: RUN_DIR,
    tierFastLane: true,
    sTierBudget: { modelRequests: 100, turns: 12 },
    costMeterDirectory: join(TMP, "meter-local-turn"),
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const whale = registeredTools.get("whale_report");
  const workflow = provided["kaWhaleWorkflow"];
  const agent = agentOf(sessionId);
  const signal = () => new AbortController().signal;
  const advanceS = await whale.execute(
    {
      tier: "S",
      tierReason: "single file; probe passes",
      tierSignals: ["single-file", "no-risk-word", "existing-probe", "probe-pass"],
      nextStage: "working",
    },
    { agent, signal: signal() },
  );
  const preStep = listeners.get("agent/pre-step")?.[0];
  // One real user message at cumulative turn 87: run-local turn 1, cumulative 87.
  await preStep(
    { agent, messages: [{ content: [{ type: "text", text: "run-local first turn" }] }], turn: 87 },
    async () => ({ kind: "enter", messages: [] }),
  );
  workflow.costMeter.flush();
  const meter = workflow.costMeter.read(sessionId, 1);
  const afterDisk = createStageStore(LOCAL_TURN_STORE);
  const afterTier = afterDisk.getWorkflowRunTier(sessionId);
  check(
    "P8 regression: cumulative turn 87 with run-local turn 1 does NOT auto-upgrade S by turn budget",
    advanceS?.ok === true &&
      advanceS?.stage === "working" &&
      meter.turns === 1 &&
      meter.turnsCumulative === 87 &&
      afterTier?.tier === "S" &&
      afterTier?.upgradeHistory?.length === 0,
  );
}

// ---------------------------------------------------------------------------
// ⑤ P1b working-entry re-evaluation fires BEFORE stage text is injected.
// ---------------------------------------------------------------------------
{
  const sessionId = "entry-main";
  const seedStore = createStageStore(ENTRY_STORE);
  seedStore.set(sessionId, "assess-complexity");
  seedStore.beginWorkflowRun(sessionId);
  persistFinalPlanRun({
    projectRoot: RUN_DIR,
    sessionId,
    runId: 1,
    payload: {
      status: "finalized",
      items: [
        {
          planItemId: "p-memory",
          persona: "memoryMaintainer",
          task: "Memory work found at working entry",
          assignedTools: [],
        },
      ],
    },
  });
  const { base, listeners, registeredTools, provided } = makeBase({ tierFastLane: true });
  await plugin.apply(base, {
    stageStore: ENTRY_STORE,
    projectRoot: RUN_DIR,
    tierFastLane: true,
    costMeterDirectory: join(TMP, "meter-entry"),
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const whale = registeredTools.get("whale_report");
  const workflow = provided["kaWhaleWorkflow"];
  const agent = agentOf(sessionId);
  const signal = () => new AbortController().signal;
  const advanceS = await whale.execute(
    {
      tier: "S",
      tierReason: "single file; probe passes",
      tierSignals: ["single-file", "no-risk-word", "existing-probe", "probe-pass"],
      nextStage: "working",
    },
    { agent, signal: signal() },
  );
  const preStep = listeners.get("agent/pre-step")?.[0];
  const injected = await preStep(
    { agent, messages: [], turn: 1 },
    async () => ({ kind: "enter", messages: [] }),
  );
  const injectedText = String(
    injected?.messages?.[0]?.content?.[0]?.text ?? "",
  );
  const afterDisk = createStageStore(ENTRY_STORE);
  const afterTier = afterDisk.getWorkflowRunTier(sessionId);
  check(
    "working-entry: S run with plan item upgrades before working stage text is injected",
    advanceS?.ok === true &&
      afterTier?.tier === "M" &&
      afterTier?.upgradeHistory?.length === 1 &&
      afterTier.upgradeHistory[0].trigger === "working-entry" &&
      injectedText.includes("Can advance to: [decide-tools-before-writing-plan, write-plan, memory-maintenance]") &&
      !injectedText.includes("Can advance to: [communication]") &&
      workflow.sessionTierDefaultOf(sessionId) === null,
  );
}

// ---------------------------------------------------------------------------
// ⑥ Flag OFF: no budget/working-entry anti-gaming fires (7.3.5 parity).
// ---------------------------------------------------------------------------
{
  const sessionId = "off-main";
  const seedStore = createStageStore(OFF_STORE);
  seedStore.set(sessionId, "working");
  seedStore.beginWorkflowRun(sessionId);
  seedStore.setWorkflowRunTier(sessionId, {
    tier: "S",
    tierReason: "seeded S (flag off must ignore it)",
    tierSignals: ["single-file"],
  });
  seedStore.setPendingStageInjection(sessionId, "working");
  persistFinalPlanRun({
    projectRoot: RUN_DIR,
    sessionId,
    runId: 1,
    payload: {
      status: "finalized",
      items: [{ planItemId: "p-worker", persona: "worker", task: "Worker task", assignedTools: [] }],
    },
  });
  const { base, listeners } = makeBase({ tierFastLane: false });
  await plugin.apply(base, {
    stageStore: OFF_STORE,
    projectRoot: RUN_DIR,
    tierFastLane: false,
    sTierBudget: { modelRequests: 1, turns: 1 },
    costMeterDirectory: join(TMP, "meter-off"),
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const agent = agentOf(sessionId);
  const preStep = listeners.get("agent/pre-step")?.[0];
  const runPre = async () =>
    preStep(
      { agent, messages: [], turn: 1 },
      async () => ({ kind: "enter", messages: [] }),
    );
  await runPre();
  await runPre();
  await runPre();
  const afterDisk = createStageStore(OFF_STORE);
  const afterTier = afterDisk.getWorkflowRunTier(sessionId);
  const history = afterDisk.getSessionTierMisjudgmentHistory(sessionId);
  check(
    "flag OFF: stored S + plan item + tiny budget still inject static M edges; no upgrade/no misjudgment",
    afterTier?.tier === "S" &&
      afterTier?.upgradeHistory?.length === 0 &&
      history?.length === 0 &&
      afterDisk.sessionTierDefaultOf(sessionId) === null,
  );
}

// ---------------------------------------------------------------------------
// ⑦ Successful S run reaching communication resets the session counter.
// ---------------------------------------------------------------------------
{
  const sessionId = "reset-main";
  const seedStore = createStageStore(RESET_STORE);
  seedStore.set(sessionId, "assess-complexity");
  seedStore.beginWorkflowRun(sessionId);
  seedStore.recordSessionSMisjudgment(sessionId, true);
  const { base, registeredTools } = makeBase({ tierFastLane: true });
  await plugin.apply(base, {
    stageStore: RESET_STORE,
    projectRoot: RUN_DIR,
    tierFastLane: true,
    costMeterDirectory: join(TMP, "meter-reset"),
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const whale = registeredTools.get("whale_report");
  const agent = agentOf(sessionId);
  const signal = () => new AbortController().signal;
  const toWorking = await whale.execute(
    {
      tier: "S",
      tierReason: "single file; probe passes",
      tierSignals: ["single-file", "no-risk-word", "existing-probe", "probe-pass"],
      nextStage: "working",
    },
    { agent, signal: signal() },
  );
  const toCommunication = await whale.execute(
    { nextStage: "communication" },
    { agent, signal: signal() },
  );
  const afterDisk = createStageStore(RESET_STORE);
  const history = afterDisk.getSessionTierMisjudgmentHistory(sessionId);
  check(
    "successful S run reaching communication without auto-upgrade resets consecutive misjudgments",
    toWorking?.ok === true &&
      toCommunication?.ok === true &&
      toCommunication?.stage === "communication" &&
      history?.length === 0 &&
      afterDisk.sessionTierDefaultOf(sessionId) === null,
  );
}

if (failures === 0) rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nKAZ74-TIER PROBE OK" : `\nKAZ74-TIER PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
