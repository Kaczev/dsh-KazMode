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
  buildEvidenceShellRequest,
  evaluateEvidenceGate,
  normalizeNotVerifiedList,
  runMainRerunOnce,
  resolveEvidenceShellPath,
  isWindowsPowerShell51,
  usesPipelineChainOperator,
  NOT_VERIFIED_MAX_CHARS,
  MAIN_RERUN_TAIL_CHAR_LIMIT,
} from "./lib/evidence-gate.js";
import {
  appendWorkLogEntry,
  readWorkLogEntries,
  workLogFileFor,
} from "./lib/task-plan-store.js";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
const STORE_OVR = join(TMP, "ovr.json");
const STORE_OVR_FALSE = join(TMP, "ovr-false.json");
const STORE_OVR_COMBINED = join(TMP, "ovr-combined.json");
const STORE_WRONG_STAGE = join(TMP, "wrong-stage.json");
const STORE_ROLE = join(TMP, "role.json");
const STORE_NEWRUN = join(TMP, "newrun.json");
const STORE_NOKAZ = join(TMP, "nokaz.json");
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
    timeoutMs: 1000,
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
// ②.b shell parity: Windows PowerShell 5.1 rejects && / ||; evidence reruns
// must detect this before spawning and keep the injected ctx.shell result.
// ---------------------------------------------------------------------------
{
  const pwsh7Path = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  check(
    "shell parity: isWindowsPowerShell51 distinguishes powershell.exe from pwsh.exe",
    isWindowsPowerShell51("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe") === true &&
      isWindowsPowerShell51(pwsh7Path) === false &&
      isWindowsPowerShell51("") === false,
  );
  check(
    "shell parity: usesPipelineChainOperator catches && / || outside quoted regions",
    usesPipelineChainOperator("a && b") === true &&
      usesPipelineChainOperator("a || b") === true &&
      usesPipelineChainOperator("echo 'a && b'") === false &&
      usesPipelineChainOperator('echo "a || b"') === false &&
      usesPipelineChainOperator("echo hi") === false,
  );

  const pwshDir = join(TMP, "fake-pwsh");
  mkdirSync(pwshDir, { recursive: true });
  const fakePwsh = join(pwshDir, "pwsh.exe");
  writeFileSync(fakePwsh, "");
  const ps51Root = join(TMP, "fake-winps51");
  const ps51Path = join(ps51Root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  mkdirSync(dirname(ps51Path), { recursive: true });
  writeFileSync(ps51Path, "");
  const withPwshEnv = {
    ProgramFiles: join(TMP, "missing-program-files"),
    PATH: pwshDir,
    SystemRoot: ps51Root,
  };
  const withoutPwshEnv = {
    ProgramFiles: join(TMP, "missing-program-files"),
    PATH: "",
    SystemRoot: ps51Root,
  };
  check(
    "shell parity: win32 resolver picks existing PATH pwsh.exe before Windows PowerShell fallback",
    resolveEvidenceShellPath({ env: withPwshEnv, platform: "win32" }) === fakePwsh,
  );
  const fallback = resolveEvidenceShellPath({ env: withoutPwshEnv, platform: "win32" });
  check(
    "shell parity: without pwsh the win32 resolver falls back to Windows PowerShell",
    fallback === ps51Path && isWindowsPowerShell51(fallback),
  );

  const fullRequest = buildEvidenceShellRequest({
    command: "echo hi",
    workdir: "C:\\work",
    timeoutMs: 5000,
    dshEnv: { DSH_SESSION_ID: "s-1" },
    sandboxPolicy: { mode: "read-only" },
  });
  check(
    "shell parity: buildEvidenceShellRequest keeps command/workdir/timeoutMs/dshEnv/sandboxPolicy when provided",
    JSON.stringify(Object.keys(fullRequest).sort()) ===
      JSON.stringify(["command", "dshEnv", "sandboxPolicy", "timeoutMs", "workdir"].sort()) &&
      fullRequest.command === "echo hi" &&
      fullRequest.workdir === "C:\\work" &&
      fullRequest.timeoutMs === 5000 &&
      fullRequest.dshEnv.DSH_SESSION_ID === "s-1" &&
      fullRequest.sandboxPolicy.mode === "read-only",
  );
  const minimalRequest = buildEvidenceShellRequest({ command: "echo hi" });
  check(
    "shell parity: buildEvidenceShellRequest omits absent dshEnv/sandboxPolicy/workdir/timeoutMs",
    JSON.stringify(Object.keys(minimalRequest).sort()) === JSON.stringify(["command"]) &&
      minimalRequest.dshEnv === undefined &&
      minimalRequest.sandboxPolicy === undefined,
  );
  const indexSource = readFileSync(new URL("./lib/index.js", import.meta.url), "utf8");
  check(
    "shell parity: index adapter source forwards ctx shellEnv/sandboxPolicy via buildEvidenceShellRequest",
    indexSource.includes('ctx.get("shellEnv")') &&
      indexSource.includes('ctx.get("sandboxPolicy")') &&
      indexSource.includes("buildEvidenceShellRequest({"),
  );

  const mismatch = await runMainRerunOnce({
    command: "echo one && echo two",
    expected: "two",
    shellPath: ps51Path,
    platform: "win32",
    timeoutMs: 1000,
  });
  check(
    "shell parity: PS powershell.exe + && returns evidence-command-shell-mismatch before spawn",
    mismatch.ok === false &&
      mismatch.code === "evidence-command-shell-mismatch" &&
      mismatch.matches === false &&
      typeof mismatch.reason === "string" &&
      mismatch.reason.includes("';' separators"),
  );

  const pwshPathOk = await runMainRerunOnce({
    command: "node -e \"process.exit(0)\" && node -e \"process.exit(0)\"",
    expected: "",
    shellPath: fakePwsh,
    platform: "win32",
    runShell: async () => ({
      exitCode: 0,
      stdout: { text: "" },
      stderr: { text: "" },
      timedOut: false,
    }),
    timeoutMs: 1000,
  });
  check(
    "shell parity: injected pwsh path with && does not pre-flight mismatch",
    pwshPathOk.matches === true && pwshPathOk.code === undefined,
  );

  const merged = await runMainRerunOnce({
    command: "placeholder",
    expected: "NEEDLE-MERGED",
    shellPath: fakePwsh,
    platform: "win32",
    runShell: async () => ({
      exitCode: 0,
      stdout: { text: "alpha\nNEEDLE-MERGED" },
      stderr: { text: "beta" },
      timedOut: false,
    }),
    timeoutMs: 1000,
  });
  check(
    "shell parity: injected runShell merges stdout+stderr into actualTail and matches expected",
    merged.ok === true &&
      merged.matches === true &&
      merged.actualTail.includes("NEEDLE-MERGED") &&
      merged.actualTail.includes("beta") &&
      merged.actualTail.length <= MAIN_RERUN_TAIL_CHAR_LIMIT,
  );

  const parseBackstop = await runMainRerunOnce({
    command: "node -e \"x\" && node -e \"y\"",
    expected: "",
    shellPath: fakePwsh,
    platform: "win32",
    runShell: async () => ({
      exitCode: 1,
      stdout: { text: "" },
      stderr: { text: "ParserError: not a valid statement separator" },
      timedOut: false,
    }),
    timeoutMs: 1000,
  });
  check(
    "shell parity: ParserError backstop maps to evidence-command-shell-mismatch",
    parseBackstop.ok === false && parseBackstop.code === "evidence-command-shell-mismatch",
  );

  const nonChainParse = await runMainRerunOnce({
    command: "node -e \"x\"",
    expected: "",
    shellPath: fakePwsh,
    platform: "win32",
    runShell: async () => ({
      exitCode: 1,
      stdout: { text: "" },
      stderr: { text: "ParserError: (1:1) unexpected token" },
      timedOut: false,
    }),
    timeoutMs: 1000,
  });
  check(
    "shell parity: non-chain ParserError stays evidence-command-failed with parse tail visible",
    nonChainParse.ok === false &&
      nonChainParse.code === "evidence-command-failed" &&
      nonChainParse.actualTail.includes("ParserError") &&
      typeof nonChainParse.reason === "string",
  );

  const defaultRunner = await runMainRerunOnce({
    command: 'node -e "process.exit(0)"; node -e "console.log(\'NEEDLE-OK\')"',
    expected: "NEEDLE-OK",
    timeoutMs: 5000,
  });
  check(
    "shell parity: real default runner executes ;-chained evidence and matches expected",
    defaultRunner.matches === true,
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
function makeBase({ evidenceGate, includeSubagents = false, noKazMode = false }) {
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
      if (name === "kazMode") return noKazMode ? undefined : mockKazMode;
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

async function installHarness(storeFile, evidenceGate, { stage = "plugin-maintenance", noKazMode = false } = {}) {
  const seed = createStageStore(storeFile);
  seed.set("main", stage);
  seed.beginWorkflowRun("main");
  const { base, registeredTools } = makeBase({ evidenceGate, noKazMode });
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

{
  // B1: a failing main rerun must surface the tail (and runner metadata) in the
  // model-visible rejection, not only on the internal gate result.
  const STORE_DENY = join(TMP, "deny-tail.json");
  const denyHarness = await installHarness(STORE_DENY, true);
  const whaleDeny = denyHarness.registeredTools.get("whale_report");
  const denyCommand = "node -e \"console.error('DENY-NEEDLE'); process.exit(3)\"";
  const denyEntry = { ...VALID_ENTRY, id: "e-deny", command: denyCommand, expected: "DENY-NEEDLE" };
  let denyError = null;
  try {
    await whaleDeny.execute(
      { evidenceChecklist: [denyEntry], nextStage: "communication" },
      { agent: denyHarness.agent, signal: new AbortController().signal },
    );
  } catch (error) {
    denyError = error;
  }
  check(
    "deny transparency: failing main rerun surfaces actualTail marker + content in the model-visible message",
    denyError?.code === "evidence-main-rerun-failed" &&
      typeof denyError?.message === "string" &&
      denyError.message.includes("actualTail:") &&
      denyError.message.includes("DENY-NEEDLE") &&
      typeof denyError?.actualTail === "string" &&
      denyError.actualTail.includes("DENY-NEEDLE") &&
      denyError?.command === denyCommand &&
      typeof denyError?.exitCode === "number" &&
      typeof denyError?.runnerCode === "string",
  );
}

// ---------------------------------------------------------------------------
// ④b 7.4 run-level evidenceGate override (D2/D3/D4/D5): standalone set,
//     immutability, override beats config both ways, stage/role gate, new-run clear.
// ---------------------------------------------------------------------------
{
  // D4: standalone set at assess-complexity persists true without advancing.
  const h = await installHarness(STORE_OVR, false, { stage: "assess-complexity" });
  const whale = h.registeredTools.get("whale_report");
  const signal = new AbortController().signal;
  const setResult = await whale.execute({ evidenceGate: true }, { agent: h.agent, signal });
  const afterSet = createStageStore(STORE_OVR);
  const record = afterSet.getWorkflowRunEvidenceGate("main");
  check(
    "override: standalone set at assess-complexity persists true/model without advancing",
    setResult?.ok === true &&
      setResult?.stage === "assess-complexity" &&
      setResult?.advanced === false &&
      setResult?.evidenceGate === true &&
      afterSet.get("main") === "assess-complexity" &&
      record.evidenceGateOverride === true &&
      record.evidenceGateSource === "model",
  );
  // D3: same value accepted no-op.
  const sameResult = await whale.execute({ evidenceGate: true }, { agent: h.agent, signal });
  check(
    "override: same value accepted no-op (still true, still assess-complexity)",
    sameResult?.ok === true &&
      sameResult?.advanced === false &&
      sameResult?.evidenceGate === true &&
      createStageStore(STORE_OVR).get("main") === "assess-complexity",
  );
  // D3: different value rejected immutable, state untouched.
  let immutableError = null;
  try {
    await whale.execute({ evidenceGate: false }, { agent: h.agent, signal });
  } catch (error) {
    immutableError = error;
  }
  check(
    "override: different value later rejected evidence-gate-immutable and state unchanged",
    immutableError?.code === "evidence-gate-immutable" &&
      createStageStore(STORE_OVR).getWorkflowRunEvidenceGate("main").evidenceGateOverride === true &&
      createStageStore(STORE_OVR).get("main") === "assess-complexity",
  );
  // D3: override true beats config false at the live communication gate.
  let gateError = null;
  try {
    await whale.execute({ nextStage: "communication" }, { agent: h.agent, signal });
  } catch (error) {
    gateError = error;
  }
  check(
    "override true beats config false: empty checklist denied evidence-no-evidence",
    gateError?.code === "evidence-no-evidence" &&
      createStageStore(STORE_OVR).get("main") === "assess-complexity",
  );
}

{
  // D3: override false beats config true.
  const h = await installHarness(STORE_OVR_FALSE, true, { stage: "assess-complexity" });
  const whale = h.registeredTools.get("whale_report");
  const signal = new AbortController().signal;
  const setFalse = await whale.execute({ evidenceGate: false }, { agent: h.agent, signal });
  check(
    "override false persists against config true",
    setFalse?.ok === true &&
      setFalse?.evidenceGate === false &&
      createStageStore(STORE_OVR_FALSE).getWorkflowRunEvidenceGate("main").evidenceGateOverride === false,
  );
  const advanced = await whale.execute({ nextStage: "communication" }, { agent: h.agent, signal });
  check(
    "override false beats config true: empty checklist advances to communication",
    advanced?.ok === true &&
      advanced?.stage === "communication" &&
      createStageStore(STORE_OVR_FALSE).get("main") === "communication",
  );
}

{
  // D4: evidenceGate together with nextStage in one call.
  const h = await installHarness(STORE_OVR_COMBINED, false, { stage: "assess-complexity" });
  const whale = h.registeredTools.get("whale_report");
  const signal = new AbortController().signal;
  const combined = await whale.execute(
    { evidenceGate: true, nextStage: "challenge-plan" },
    { agent: h.agent, signal },
  );
  check(
    "override: evidenceGate + nextStage in one call sets gate and advances",
    combined?.ok === true &&
      combined?.advanced === true &&
      combined?.stage === "challenge-plan" &&
      combined?.evidenceGate === true &&
      createStageStore(STORE_OVR_COMBINED).get("main") === "challenge-plan" &&
      createStageStore(STORE_OVR_COMBINED).getWorkflowRunEvidenceGate("main").evidenceGateOverride === true,
  );
}

{
  // D2: wrong main stage rejected before the stage machine, no state change.
  const h = await installHarness(STORE_WRONG_STAGE, false, { stage: "working" });
  const whale = h.registeredTools.get("whale_report");
  let stageError = null;
  try {
    await whale.execute({ evidenceGate: true }, { agent: h.agent, signal: new AbortController().signal });
  } catch (error) {
    stageError = error;
  }
  check(
    "override: working stage rejected evidence-gate-stage-invalid, stage and run unchanged",
    stageError?.code === "evidence-gate-stage-invalid" &&
      createStageStore(STORE_WRONG_STAGE).get("main") === "working" &&
      createStageStore(STORE_WRONG_STAGE).getWorkflowRunEvidenceGate("main").evidenceGateOverride === null,
  );
}

{
  // D2: controlled subagent role rejected with evidence-gate-stage-invalid;
  // a subagent call WITHOUT evidenceGate keeps today's workflow-stage-deny.
  const seed = createStageStore(STORE_ROLE);
  seed.set("child-gate", "working-then-compress-context-then-report");
  seed.setSubagentRole("child-gate", {
    planItemId: "p1",
    persona: "worker",
    parentId: "main",
    stage: "working-then-compress-context-then-report",
    assignedTools: [],
    finalTools: [],
  });
  const h = await installHarness(STORE_ROLE, false, { stage: "assess-complexity" });
  const whale = h.registeredTools.get("whale_report");
  const childAgent = {
    id: "child-gate",
    session: { id: "child-gate", header: { cwd: RUN_DIR }, events: [] },
    options: { subagentDepth: 1 },
  };
  let roleError = null;
  try {
    await whale.execute({ evidenceGate: true }, { agent: childAgent, signal: new AbortController().signal });
  } catch (error) {
    roleError = error;
  }
  check(
    "override: controlled subagent rejected evidence-gate-stage-invalid",
    roleError?.code === "evidence-gate-stage-invalid",
  );
  let noArgError = null;
  try {
    await whale.execute({ nextStage: "challenge-plan" }, { agent: childAgent, signal: new AbortController().signal });
  } catch (error) {
    noArgError = error;
  }
  check(
    "override: subagent without evidenceGate keeps workflow-stage-deny",
    noArgError !== null && String(noArgError.message).includes("workflow-stage-deny"),
  );
}

{
  // D5: a new run clears the override.
  const h = await installHarness(STORE_NEWRUN, false, { stage: "assess-complexity" });
  const whale = h.registeredTools.get("whale_report");
  const signal = new AbortController().signal;
  await whale.execute({ evidenceGate: true }, { agent: h.agent, signal });
  const before = createStageStore(STORE_NEWRUN).getWorkflowRunEvidenceGate("main");
  createStageStore(STORE_NEWRUN).beginWorkflowRun("main");
  const after = createStageStore(STORE_NEWRUN).getWorkflowRunEvidenceGate("main");
  check(
    "override: beginWorkflowRun clears evidenceGateOverride/source",
    before.evidenceGateOverride === true &&
      before.evidenceGateSource === "model" &&
      after.evidenceGateOverride === null &&
      after.evidenceGateSource === null,
  );
}

{
  // normalizeConfig fix: with NO kazMode service, settings evidenceGate=true must
  // still reach the live gate (before the fix normalizeConfig dropped the field).
  const h = await installHarness(STORE_NOKAZ, true, { stage: "plugin-maintenance", noKazMode: true });
  const whale = h.registeredTools.get("whale_report");
  let noKazError = null;
  try {
    await whale.execute({ nextStage: "communication" }, { agent: h.agent, signal: new AbortController().signal });
  } catch (error) {
    noKazError = error;
  }
  check(
    "normalizeConfig: no-kazMode settings evidenceGate=true enforces gate (evidence-no-evidence)",
    noKazError?.code === "evidence-no-evidence" &&
      createStageStore(STORE_NOKAZ).get("main") === "plugin-maintenance",
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
