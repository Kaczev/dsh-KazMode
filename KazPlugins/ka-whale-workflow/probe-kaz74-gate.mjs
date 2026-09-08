// ka-whale-workflow 7.4 P3 evidence / delivery gate 探针：
//   - §3.2 evidenceChecklist schema（kind/必填/mainRerun）校验；
//   - §3.4/§9.1 delivery gate：unmet 阻断、mainRerun.matches=true 必需；
//   - main 复跑：pass / 非零 fail / timeout→unmet / 单次无自动重试；
//   - §9.3 notVerified：必填（missing marker）、≤200 chars、永不 gate-block；
//   - live flag off 不阻断（7.3.5 parity）、flag on communication 前执行 gate。
// 运行：node KazPlugins/ka-whale-workflow/probe-kaz74-gate.mjs
import plugin, { createStageStore, DEFAULT_SECTION } from "./lib/index.js";
import {
  EVIDENCE_KINDS,
  normalizeEvidenceChecklist,
  validateEvidenceChecklistInput,
} from "./lib/intent-map.js";
import {
  evaluateEvidenceGate,
  normalizeNotVerifiedList,
  runMainRerunOnce,
  NOT_VERIFIED_MAX_CHARS,
} from "./lib/evidence-gate.js";
import {
  appendWorkLogEntry,
  readWorkLogEntries,
  workLogFileFor,
} from "./lib/task-plan-store.js";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

const TMP = mkdtempSync(join(tmpdir(), "whale-kaz74-gate-"));
const RUN_DIR = join(TMP, "run");
const STORE_OFF = join(TMP, "off.json");
const STORE_EMPTY = join(TMP, "empty.json");
const STORE_UNMET = join(TMP, "unmet.json");
const STORE_PASS = join(TMP, "pass.json");
const STORE_CHILD = join(TMP, "child.json");
mkdirSync(RUN_DIR, { recursive: true });

const VALID_ENTRY = {
  id: "e1",
  kind: "probe",
  command: "node -e \"process.exit(0)\"",
  expected: "exit 0",
  actualTail: "ok",
  mainRerun: null,
  status: "met",
  at: "2026-01-01T00:00:00.000Z",
};
const PASS_ENTRY = {
  ...VALID_ENTRY,
  mainRerun: { command: VALID_ENTRY.command, actualTail: "ok", matches: true },
};

// ---------------------------------------------------------------------------
// ① Pure schema + delivery gate.
// ---------------------------------------------------------------------------
{
  const badKind = {
    ...VALID_ENTRY,
    kind: "magic",
  };
  const badRerun = {
    ...VALID_ENTRY,
    mainRerun: { command: "x", actualTail: "x", matches: "yes" },
  };
  check(
    "evidenceChecklist schema validates kind/status/mainRerun and accepts §3.2 entry",
    validateEvidenceChecklistInput([VALID_ENTRY]).ok === true &&
      validateEvidenceChecklistInput([badKind]).ok === false &&
      validateEvidenceChecklistInput([badRerun]).ok === false &&
      validateEvidenceChecklistInput("not-array").ok === false &&
      normalizeEvidenceChecklist([VALID_ENTRY])[0].mainRerun === null,
  );
  check(
    "evidence kinds cover §3.1 machine kinds and every kind validates as an entry",
    JSON.stringify(EVIDENCE_KINDS) ===
      JSON.stringify(["probe", "test", "build-lint", "command", "rendered", "diff", "audit"]) &&
      EVIDENCE_KINDS.every((kind) =>
        validateEvidenceChecklistInput([{ ...VALID_ENTRY, id: `e-${kind}`, kind }]).ok === true,
      ),
  );
  const unmet = evaluateEvidenceGate([{ ...VALID_ENTRY, status: "unmet" }]);
  const selfOnly = evaluateEvidenceGate([VALID_ENTRY]);
  const passed = evaluateEvidenceGate([PASS_ENTRY]);
  const withUnmetPass = evaluateEvidenceGate([
    { ...PASS_ENTRY, status: "unmet" },
  ]);
  check(
    "delivery gate: unmet blocks; self-attested alone cannot pass; mainRerun.matches=true passes",
    unmet.ok === false &&
      unmet.code === "evidence-unmet" &&
      selfOnly.ok === false &&
      selfOnly.code === "evidence-main-rerun-missing" &&
      passed.ok === true &&
      passed.mainRerunPassCount === 1 &&
      withUnmetPass.ok === false &&
      withUnmetPass.code === "evidence-unmet",
  );
}

// ---------------------------------------------------------------------------
// ② runMainRerunOnce: pass / fail / timeout / no automatic retry.
// ---------------------------------------------------------------------------
{
  const pass = await runMainRerunOnce({
    command: "node -e \"process.exit(0)\"",
    expected: "",
    timeoutMs: 5000,
  });
  const fail = await runMainRerunOnce({
    command: "node -e \"process.exit(2)\"",
    expected: "",
    timeoutMs: 5000,
  });
  check(
    "main rerun: exit 0 → matches=true with actualTail; non-zero → matches=false",
    pass.ok === true && pass.matches === true && pass.exitCode === 0 &&
      typeof pass.actualTail === "string" &&
      fail.ok === false && fail.matches === false && fail.code === "evidence-command-failed",
  );

  const expectedPass = await runMainRerunOnce({
    command: "node -e \"console.log('NEEDLE-OK')\"",
    expected: "NEEDLE-OK",
    timeoutMs: 5000,
  });
  const expectedMiss = await runMainRerunOnce({
    command: "node -e \"console.log('OTHER')\"",
    expected: "NEEDLE-OK",
    timeoutMs: 5000,
  });
  check(
    "main rerun: expected substring must appear in output for matches=true",
    expectedPass.matches === true && expectedMiss.matches === false,
  );

  const countFile = join(TMP, "retry-count.txt");
  const noRetry = await runMainRerunOnce({
    command: `node -e "require('node:fs').appendFileSync('${countFile.replace(/\\/g, "/")}', 'x'); process.exit(1)"`,
    expected: "",
    timeoutMs: 5000,
  });
  const countAfterFail = existsSync(countFile) ? readFileSync(countFile, "utf8").length : 0;
  const timeoutFile = join(TMP, "timeout-count.txt");
  const timeoutRun = await runMainRerunOnce({
    command: `node -e "require('node:fs').appendFileSync('${timeoutFile.replace(/\\/g, "/")}', 'x'); setTimeout(()=>{}, 5000)"`,
    expected: "",
    timeoutMs: 100,
  });
  const countAfterTimeout = existsSync(timeoutFile) ? readFileSync(timeoutFile, "utf8").length : 0;
  check(
    "main rerun: non-zero and timeout do not automatically retry; timeout → matches=false code evidence-timeout",
    noRetry.matches === false &&
      noRetry.code === "evidence-command-failed" &&
      countAfterFail === 1 &&
      timeoutRun.matches === false &&
      timeoutRun.code === "evidence-timeout" &&
      countAfterTimeout === 1,
  );
}

// ---------------------------------------------------------------------------
// ③ notVerified: missing marker + length cap + work-log persistence.
// ---------------------------------------------------------------------------
{
  const missing = normalizeNotVerifiedList(undefined);
  const tooLong = "x".repeat(NOT_VERIFIED_MAX_CHARS + 1);
  const capped = normalizeNotVerifiedList(["valid", tooLong, ""]);
  check(
    "notVerified: missing → [] + notVerifiedMissing; overlong/empty dropped with markers; valid kept",
    missing.notVerified.length === 0 &&
      missing.markers.includes("notVerifiedMissing") &&
      capped.notVerified.length === 1 &&
      capped.notVerified[0] === "valid" &&
      capped.markers.includes("notVerifiedTooLong") &&
      capped.markers.includes("notVerifiedInvalid"),
  );
  const workLogFile = workLogFileFor(RUN_DIR, "main-log", 1);
  const appendOk = appendWorkLogEntry({
    projectRoot: RUN_DIR,
    sessionId: "main-log",
    runId: 1,
    role: "worker",
    planItemId: "p1",
    summary: "child terminal",
    report: "full report text",
    at: "2026-01-01T00:00:00.000Z",
    notVerified: ["UI not checked"],
    notVerifiedMissing: false,
  });
  const logEntry = readWorkLogEntries(RUN_DIR, "main-log", 1)[0];
  check(
    "work-log entry persists notVerified list and optional missing marker",
    appendOk.ok === true &&
      Array.isArray(logEntry?.notVerified) &&
      logEntry.notVerified[0] === "UI not checked" &&
      logEntry.notVerifiedMissing === false,
  );
}

// ---------------------------------------------------------------------------
// ④ Live flag off parity + flag-on delivery gate at communication.
// ---------------------------------------------------------------------------
function makeBase({ evidenceGate, includeSubagents = false }) {
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
    get: () => ({ enabled: true, includeSubagents, evidenceGate }),
    update: () => Promise.resolve(),
  };
  const toolsMock = {
    register(def) { registeredTools.set(def.name, def); return () => registeredTools.delete(def.name); },
    schemas() { return [...registeredTools.keys()].map((name) => ({ name, description: "", parameters: {} })); },
    get(name) { return registeredTools.get(name); },
  };
  const agentRegistry = new Map();
  const mockKazMode = {
    pluginConfig: () => ({ enabled: true, includeSubagents, evidenceGate }),
    toolVisible: () => true,
  };
  const base = {
    fiber: { state: 0 },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    async plugin() { return; },
    on(event, fn) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); return () => {}; },
    inject(deps, cb) { if (deps.includes("settings")) setImmediate(() => cb({ ...base, settings })); },
    effect(fn) { const dispose = fn(); return () => { if (typeof dispose === "function") dispose(); }; },
    provide(name, value) { provided[name] = value; return () => { delete provided[name]; }; },
    get(name) {
      if (name in provided) return provided[name];
      if (name === "settings") return settings;
      if (name === "tools") return toolsMock;
      if (name === "kazMode") return mockKazMode;
      if (name === "agents") return { get: (id) => agentRegistry.get(id) };
      if (name === "roundDisplay") return { report: (payload) => roundReports.push(payload) };
      if (name === "subagents") return { listChildren: async () => [], followup: async () => "msg", startContinuable: async () => ({}) };
      return undefined;
    },
    systemPrompt: { section() { return () => {}; } },
    tools: toolsMock,
  };
  return { listeners, registeredTools, provided, roundReports, base };
}

async function installHarness(storeFile, evidenceGate) {
  const seed = createStageStore(storeFile);
  seed.set("main", "plugin-maintenance");
  seed.beginWorkflowRun("main");
  const { base, registeredTools } = makeBase({ evidenceGate });
  await plugin.apply(base, {
    stageStore: storeFile,
    projectRoot: RUN_DIR,
    evidenceGate,
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const agent = {
    id: "main",
    session: { id: "main", header: { cwd: RUN_DIR }, events: [] },
  };
  return { seed, registeredTools, agent };
}

{
  // Flag off: empty checklist must not block 7.3.5 communication advance.
  const off = await installHarness(STORE_OFF, false);
  const whaleOff = off.registeredTools.get("whale_report");
  const offResult = await whaleOff.execute(
    { nextStage: "communication" },
    { agent: off.agent, signal: new AbortController().signal },
  );
  const offStore = createStageStore(STORE_OFF);
  check(
    "flag off: whale_report advances to communication without evidence gate denial (7.3.5 parity)",
    offResult?.ok === true &&
      offResult?.stage === "communication" &&
      offStore.get("main") === "communication",
  );
}

{
  // Flag on: empty checklist blocks communication with evidence-no-evidence.
  const empty = await installHarness(STORE_EMPTY, true);
  const whaleEmpty = empty.registeredTools.get("whale_report");
  let emptyError = null;
  try {
    await whaleEmpty.execute(
      { nextStage: "communication" },
      { agent: empty.agent, signal: new AbortController().signal },
    );
  } catch (error) {
    emptyError = error;
  }
  check(
    "flag on: empty evidence blocks communication (evidence-no-evidence) and stage stays put",
    emptyError?.code === "evidence-no-evidence" &&
      createStageStore(STORE_EMPTY).get("main") === "plugin-maintenance",
  );
}

{
  // Flag on: any unmet evidence blocks before main rerun.
  const unmet = await installHarness(STORE_UNMET, true);
  const whaleUnmet = unmet.registeredTools.get("whale_report");
  const unmetEntry = { ...VALID_ENTRY, id: "e-unmet", status: "unmet" };
  let unmetError = null;
  try {
    await whaleUnmet.execute(
      { evidenceChecklist: [unmetEntry], nextStage: "communication" },
      { agent: unmet.agent, signal: new AbortController().signal },
    );
  } catch (error) {
    unmetError = error;
  }
  check(
    "flag on: evidence status=unmet blocks communication with evidence-unmet",
    unmetError?.code === "evidence-unmet" &&
      unmetError?.message.includes("e-unmet") &&
      createStageStore(STORE_UNMET).get("main") === "plugin-maintenance",
  );
}

{
  // Flag on: plugin itself reruns one met evidence command; pass allows communication.
  const passHarness = await installHarness(STORE_PASS, true);
  const whalePass = passHarness.registeredTools.get("whale_report");
  const passEntry = { ...VALID_ENTRY, command: "node -e \"console.log('exit 0'); process.exit(0)\"" };
  const passResult = await whalePass.execute(
    { evidenceChecklist: [passEntry], nextStage: "communication" },
    { agent: passHarness.agent, signal: new AbortController().signal },
  );
  const passStore = createStageStore(STORE_PASS);
  const storedChecklist = passStore.getWorkflowRunIntent("main").evidenceChecklist;
  check(
    "flag on: main rerun of met evidence passes and whale_report advances to communication",
    passResult?.ok === true &&
      passResult?.stage === "communication" &&
      passStore.get("main") === "communication" &&
      storedChecklist?.[0]?.mainRerun?.matches === true &&
      storedChecklist?.[0]?.mainRerun?.command.includes("process.exit(0)"),
  );
}

// ---------------------------------------------------------------------------
// ⑤ Subagent terminal report optional notVerified is persisted on role record.
// ---------------------------------------------------------------------------
{
  const childSeed = createStageStore(STORE_CHILD);
  childSeed.set("main", "working");
  childSeed.beginWorkflowRun("main");
  childSeed.set("child-nv", "working-then-compress-context-then-report");
  childSeed.setSubagentRole("child-nv", {
    planItemId: "p1",
    persona: "worker",
    parentId: "main",
    stage: "working-then-compress-context-then-report",
    assignedTools: [],
    finalTools: [],
    minimalDone: true,
    terminalFinal: false,
    awaitingParent: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const { base, registeredTools } = makeBase({ evidenceGate: false, includeSubagents: true });
  await plugin.apply(base, {
    stageStore: STORE_CHILD,
    projectRoot: RUN_DIR,
    evidenceGate: false,
    includeSubagents: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const reportTool = registeredTools.get("work_sub_whale_report");
  const childAgent = {
    id: "child-nv",
    session: { id: "child-nv", header: { cwd: RUN_DIR }, events: [] },
    options: { subagentDepth: 1 },
  };
  const reportResult = await reportTool.execute(
    { final: true, notVerified: ["visual not checked"] },
    { agent: childAgent, signal: new AbortController().signal },
  );
  const childRecord = JSON.parse(readFileSync(STORE_CHILD, "utf8")).subagentRoles?.["child-nv"];
  check(
    "subagent terminal report optional notVerified is stored on role record for work-log append",
    reportResult?.terminalFinal === true &&
      Array.isArray(childRecord?.notVerified) &&
      childRecord?.notVerified?.[0] === "visual not checked" &&
      childRecord?.notVerifiedMissing === false,
  );
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nKAZ74-GATE PROBE OK" : `\nKAZ74-GATE PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
