// ka-whale-workflow 7.4 P2 Intent Map persistence 探针：
//   - §8.1/R-f 校验：结构错 intent-map-invalid；缺 discriminatingSignal →
//     confidence:low + requiresUserConfirmation:true + normalized marker；
//   - §8.4 prompt-defect pass：只在 defects 命中已知信号时动作，绝不无条件运行；
//   - task-plan-store schema v3：run 顶层 intentMap/evidenceChecklist +
//     item 级 tier/tierReason/tierSignals 保留；v2 磁盘文件可加载且不被重写；
//   - whale_report 顺序：persist intent → tier:S → requires-user-confirmation 自动升 M
//     → canAdvance 不再走 S-only 边；
//   - plan_read 从 stage-store canonical 读 intentMap；working 文本不注入 trueGoal。
// 运行：node KazPlugins/ka-whale-workflow/probe-kaz74-intent.mjs
import plugin, { createStageStore } from "./lib/index.js";
import { MAIN_ROLE, stageInjectionText } from "./lib/stage-defs.js";
import {
  validateIntentMapInput,
  normalizeIntentMap,
  runPromptDefectPass,
  normalizeEvidenceChecklist,
} from "./lib/intent-map.js";
import {
  TASK_PLAN_STORE_VERSION,
  createTaskPlanStore,
  validateFinalPlanPayload,
  validateFinalPayloadItems,
  readRunPlanRunMeta,
} from "./lib/task-plan-store.js";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

const TMP = mkdtempSync(join(tmpdir(), "whale-kaz74-intent-"));
const V2_FILE = join(TMP, "v2.json");
const V3_FILE = join(TMP, "v3.json");
const INVALID_FILE = join(TMP, "invalid.json");
const LIVE_LOW_STORE = join(TMP, "live-low.json");
const LIVE_OK_STORE = join(TMP, "live-ok.json");
const RUN_DIR = join(TMP, "run");
mkdirSync(RUN_DIR, { recursive: true });

function runRecordFromFile(file, sessionId) {
  const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw).workflowRuns?.[sessionId] ?? null;
}

function stageFromFile(file, sessionId) {
  const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw).sessions?.[sessionId] ?? null;
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
const signal = () => new AbortController().signal;

// ---------------------------------------------------------------------------
// ① Pure validation / normalization / prompt-defect pass.
// ---------------------------------------------------------------------------
{
  const valid = {
    goal: "literal goal",
    trueGoal: "real goal",
    inferredFrom: ["user said X"],
    confidence: "high",
    requiresUserConfirmation: false,
    discriminatingSignal: "a discriminating executable check",
    acceptanceSignals: ["signal one"],
  };
  const normalizedValid = normalizeIntentMap(valid);
  check(
    "valid intentMap normalizes with signal, confidence high, no confirmation, no marker",
    normalizedValid?.confidence === "high" &&
      normalizedValid?.requiresUserConfirmation === false &&
      normalizedValid?.discriminatingSignal === "a discriminating executable check" &&
      normalizedValid?.normalized?.length === 0,
  );
  const missingSignal = normalizeIntentMap({
    goal: "g",
    trueGoal: "t",
    confidence: "high",
  });
  check(
    "missing discriminatingSignal normalizes to low + requiresUserConfirmation + marker",
    missingSignal?.confidence === "low" &&
      missingSignal?.requiresUserConfirmation === true &&
      missingSignal?.normalized?.includes("discriminating-signal-missing"),
  );
  const nonStringSignal = normalizeIntentMap({
    goal: "g",
    discriminatingSignal: 42,
  });
  check(
    "non-string discriminatingSignal treated as undecidable (low + confirmation)",
    nonStringSignal?.confidence === "low" &&
      nonStringSignal?.requiresUserConfirmation === true &&
      nonStringSignal?.normalized?.includes("discriminating-signal-missing"),
  );
  check(
    "structurally invalid intentMap rejects with intent-map-invalid (unknown key / enum / types)",
    validateIntentMapInput({ goal: "g", surprise: 1 }).ok === false &&
      validateIntentMapInput({ goal: "g", confidence: "ultra" }).ok === false &&
      validateIntentMapInput({ inferredFrom: "not-array" }).ok === false &&
      validateIntentMapInput({ goal: "g", discriminatingSignal: "ok" }).ok === true,
  );
  const untouched = runPromptDefectPass({ goal: "g", discriminatingSignal: "ok", confidence: "high" });
  check(
    "prompt-defect pass does nothing when no defect signal is supplied",
    untouched.appliedSignals?.length === 0 &&
      untouched.value?.confidence === "high" &&
      untouched.value?.requiresUserConfirmation === false,
  );
  const contradictory = runPromptDefectPass({
    goal: "g",
    discriminatingSignal: "ok",
    confidence: "high",
    defects: [{ type: "contradictory", quote: "A vs B" }],
  });
  const missingAcceptance = runPromptDefectPass({
    goal: "g",
    discriminatingSignal: "ok",
    confidence: "high",
    defects: [{ type: "missing-acceptance" }],
  });
  check(
    "prompt-defect pass fires only on hit signals: contradictory→confirmation; missing-acceptance→low",
    contradictory.appliedSignals?.includes("contradictory") &&
      contradictory.value?.requiresUserConfirmation === true &&
      contradictory.value?.normalized?.includes("prompt-defect:contradictory") &&
      missingAcceptance.appliedSignals?.includes("missing-acceptance") &&
      missingAcceptance.value?.confidence === "low",
  );
}

// ---------------------------------------------------------------------------
// ② task-plan-store v2/v3 compatibility + field preservation.
// ---------------------------------------------------------------------------
{
  const v2Content = JSON.stringify(
    {
      version: 2,
      plans: {
        p1: {
          planItemId: "p1",
          status: "finalized",
          persona: "worker",
          task: "old task",
          summary: "old",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          finalizedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    },
    null,
    2,
  ) + "\n";
  writeFileSync(V2_FILE, v2Content, "utf8");
  const v2Store = createTaskPlanStore(V2_FILE);
  const afterLoad = readFileSync(V2_FILE, "utf8");
  check(
    "v2 on-disk plan file loads; no intent/tier; file is not rewritten by load",
    v2Store.list()[0]?.planItemId === "p1" &&
      v2Store.list()[0]?.tier === undefined &&
      v2Store.runMeta()?.intentMap === null &&
      v2Store.runMeta()?.evidenceChecklist?.length === 0 &&
      afterLoad === v2Content,
  );

  const intentMap = {
    goal: "literal",
    trueGoal: "true goal",
    inferredFrom: ["quote"],
    confidence: "high",
    requiresUserConfirmation: false,
    discriminatingSignal: "executable discriminator",
    acceptanceSignals: ["accept one"],
  };
  const evidenceChecklist = [
    {
      id: "e1",
      kind: "probe",
      command: "node probe.mjs",
      expected: "OK",
      actualTail: "PROBE OK",
      mainRerun: { command: "node probe.mjs", actualTail: "PROBE OK", matches: true },
      status: "met",
      at: "2026-01-01T00:00:00.000Z",
    },
  ];
  const v3Store = createTaskPlanStore(V3_FILE);
  const v3Result = v3Store.persistFinalPayload({
    status: "finalized",
    intentMap,
    evidenceChecklist,
    items: [
      {
        planItemId: "p1",
        persona: "worker",
        task: "v3 task",
        tier: "S",
        tierReason: "single file",
        tierSignals: ["single-file", "probe-pass"],
      },
    ],
  });
  const rawV3 = JSON.parse(readFileSync(V3_FILE, "utf8"));
  const reloaded = createTaskPlanStore(V3_FILE);
  const meta = reloaded.runMeta();
  const item = reloaded.list()[0];
  check(
    "v3 file round-trips run intentMap/evidenceChecklist and item tier/tierReason/tierSignals",
    TASK_PLAN_STORE_VERSION === 3 &&
      v3Result?.ok === true &&
      rawV3.version === 3 &&
      rawV3.intentMap?.trueGoal === "true goal" &&
      rawV3.evidenceChecklist?.length === 1 &&
      rawV3.plans.p1?.tier === "S" &&
      meta?.intentMap?.discriminatingSignal === "executable discriminator" &&
      meta?.evidenceChecklist?.[0]?.id === "e1" &&
      item?.tier === "S" &&
      item?.tierReason === "single file" &&
      item?.tierSignals?.includes("probe-pass"),
  );
  const readMeta = readRunPlanRunMeta(V3_FILE);
  check(
    "readRunPlanRunMeta returns v3 file meta for plan_read fallback",
    readMeta?.intentMap?.goal === "literal" &&
      readMeta?.evidenceChecklist?.length === 1,
  );
  const invalidStore = createTaskPlanStore(INVALID_FILE);
  const invalidTier = invalidStore.persistFinalPayload({
    status: "finalized",
    items: [{ planItemId: "p1", persona: "worker", task: "bad", tier: "X" }],
  });
  check(
    "invalid item tier rejected with tier-invalid and nothing persisted",
    invalidTier?.ok === false &&
      invalidTier?.rejected?.[0]?.code === "tier-invalid" &&
      existsSync(INVALID_FILE) === false,
  );
  const shape = validateFinalPlanPayload({
    status: "finalized",
    intentMap: { goal: "g", surprise: 1 },
    items: [{ planItemId: "p1", persona: "worker", task: "ok" }],
  });
  check(
    "final payload top-level intentMap unknown key rejected via intent-map-invalid",
    shape?.ok === false && shape?.rejected?.[0]?.code === "intent-map-invalid",
  );
  check(
    "validateFinalPayloadItems accepts valid item tier and missing tier (legacy)",
    validateFinalPayloadItems([
      { planItemId: "p1", persona: "worker", task: "ok", tier: "M" },
      { planItemId: "p2", persona: "main", task: "ok" },
    ])?.ok === true,
  );
}

// ---------------------------------------------------------------------------
// ③ Live whale_report: missing signal S → auto M via requires-user-confirmation.
// ---------------------------------------------------------------------------
{
  const seedLow = createStageStore(LIVE_LOW_STORE);
  seedLow.set("main", "assess-complexity");
  seedLow.beginWorkflowRun("main");
  const { base, registeredTools } = makeBase({ tierFastLane: true });
  await plugin.apply(base, {
    stageStore: LIVE_LOW_STORE,
    projectRoot: RUN_DIR,
    tierFastLane: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const whale = registeredTools.get("whale_report");
  const agent = mainAgentOf();
  const raw = {
    goal: "literal goal",
    trueGoal: "inferred goal",
    inferredFrom: ["user wording"],
    confidence: "high",
  };
  let invalidError = null;
  try {
    await whale.execute(
      { intentMap: { goal: "g", surprise: 1 }, tier: "S", nextStage: "working" },
      { agent, signal: signal() },
    );
  } catch (error) {
    invalidError = error;
  }
  check(
    "structurally invalid intentMap rejects before tier persistence (no partial write)",
    invalidError?.code === "intent-map-invalid" &&
      stageFromFile(LIVE_LOW_STORE, "main") === "assess-complexity" &&
      runRecordFromFile(LIVE_LOW_STORE, "main")?.tier === undefined,
  );

  let lowError = null;
  try {
    await whale.execute(
      { intentMap: raw, tier: "S", nextStage: "working" },
      { agent, signal: signal() },
    );
  } catch (error) {
    lowError = error;
  }
  const lowRun = runRecordFromFile(LIVE_LOW_STORE, "main");
  const lowHistory = JSON.parse(readFileSync(LIVE_LOW_STORE, "utf8")).sessionTierMisjudgments?.main ?? [];
  check(
    "whale_report missing signal: intent persisted, S auto-upgraded to M (requires-user-confirmation), S edge NOT taken",
    lowError?.message?.includes("workflow-stage-deny") &&
      lowRun?.tier === "M" &&
      lowRun?.upgradeHistory?.[0]?.trigger === "requires-user-confirmation" &&
      lowRun?.upgradeHistory?.[0]?.from === "S" &&
      lowRun?.upgradeHistory?.[0]?.to === "M" &&
      lowRun?.intentMap?.confidence === "low" &&
      lowRun?.intentMap?.requiresUserConfirmation === true &&
      lowRun?.intentMap?.normalized?.includes("discriminating-signal-missing") &&
      lowHistory?.length === 1 &&
      stageFromFile(LIVE_LOW_STORE, "main") === "assess-complexity",
  );
}

// ---------------------------------------------------------------------------
// ④ Live valid S intent + plan_read + no trueGoal injection.
// ---------------------------------------------------------------------------
{
  const seedOk = createStageStore(LIVE_OK_STORE);
  seedOk.set("main", "assess-complexity");
  seedOk.beginWorkflowRun("main");
  const { base, registeredTools } = makeBase({ tierFastLane: true });
  await plugin.apply(base, {
    stageStore: LIVE_OK_STORE,
    projectRoot: RUN_DIR,
    tierFastLane: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const whale = registeredTools.get("whale_report");
  const planRead = registeredTools.get("plan_read");
  const agent = mainAgentOf();
  const okIntent = {
    goal: "literal goal value",
    trueGoal: "true goal value must not be injected",
    inferredFrom: ["basis"],
    confidence: "high",
    requiresUserConfirmation: false,
    discriminatingSignal: "literal implementation would fail this check",
    acceptanceSignals: ["check passes"],
  };
  const okAdvance = await whale.execute(
    { intentMap: okIntent, tier: "S", nextStage: "working" },
    { agent, signal: signal() },
  );
  const okRecord = runRecordFromFile(LIVE_OK_STORE, "main");
  check(
    "whale_report valid S intentMap + nextStage working succeeds and persists S + intent",
    okAdvance?.ok === true &&
      okAdvance?.stage === "working" &&
      okRecord?.tier === "S" &&
      okRecord?.intentMap?.discriminatingSignal === "literal implementation would fail this check" &&
      okRecord?.intentMap?.normalized?.length === 0 &&
      okRecord?.upgradeHistory === undefined,
  );
  const readResult = await planRead.execute({}, { agent, signal: signal() });
  check(
    "plan_read returns run-level intentMap from stage-store canonical (S, no plan file)",
    readResult?.ok === true &&
      readResult?.intentMap?.trueGoal === "true goal value must not be injected" &&
      readResult?.intentMap?.requiresUserConfirmation === false &&
      Array.isArray(readResult?.evidenceChecklist) &&
      readResult?.items?.length === 0,
  );
  const workingText = stageInjectionText(MAIN_ROLE, "working", { tier: "S" });
  check(
    "working stage text never injects trueGoal or goal body (D26)",
    !workingText.includes("true goal value must not be injected") &&
      !workingText.includes("literal goal value") &&
      !workingText.includes("trueGoal"),
  );
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nKAZ74-INTENT PROBE OK" : `\nKAZ74-INTENT PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
