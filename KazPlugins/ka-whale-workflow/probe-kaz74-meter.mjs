// ka-whale-workflow 7.4 P0 cost meter 探针：
//   - meter 文件 schema/fields + aggregate-only（无正文键）；
//   - agent/pre-step 每 request +1；
//   - turns 从真实用户消息轮镜像（max）；
//   - stage 注入 injectedChars；
//   - terminal report 经 work-log 追加点计 reportChars；
//   - schema version / 旧文件缺字段按 0 / 失败只 warn。
// 运行：node KazPlugins/ka-whale-workflow/probe-kaz74-meter.mjs
import plugin, { createStageStore } from "./lib/index.js";
import { persistFinalPlanRun } from "./lib/task-plan-store.js";
import {
  defaultCostMeterDirectory,
  createCostMeterWriter,
  normalizeCostMeter,
  COST_METER_SCHEMA_VERSION,
} from "./lib/cost-meter.js";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

const TMP = mkdtempSync(join(tmpdir(), "whale-kaz74-meter-"));
const STORE_FILE = join(TMP, "stage.json");
const METER_DIR = join(TMP, "cost-meter");
const RUN_DIR = join(TMP, "run");

function makeBase() {
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
    get: () => ({ enabled: true, includeSubagents: false }),
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
    pluginConfig: () => ({ enabled: true, includeSubagents: false }),
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
  return { base, listeners, provided, roundReports };
}

const mainAgent = {
  id: "main",
  session: { id: "main", header: { cwd: RUN_DIR }, events: [] },
  options: {},
};

// ---------------------------------------------------------------------------
// ① Pure module: default path, old-file normalization, warn-only failure.
// ---------------------------------------------------------------------------
check(
  "default cost-meter path is under DSH_HOME/storages/ka-whale-workflow/cost-meter",
  defaultCostMeterDirectory().includes("storages") &&
    defaultCostMeterDirectory().includes("ka-whale-workflow") &&
    defaultCostMeterDirectory().endsWith("cost-meter"),
);
{
  const normalized = normalizeCostMeter(
    {
      version: 0,
      sessionId: "old",
      runId: 0,
      modelRequests: 3,
      turns: 2,
      injectedChars: 10,
      reportChars: 4,
      content: "SHOULD NOT SURVIVE",
      prompt: "SHOULD NOT SURVIVE",
    },
    "old-session",
    1,
  );
  check(
    "normalizeCostMeter keeps schema version, supplied counters, missing fields as 0, no content keys",
    normalized.version === COST_METER_SCHEMA_VERSION &&
      normalized.sessionId === "old" &&
      normalized.runId === 1 &&
      normalized.modelRequests === 3 &&
      normalized.turns === 2 &&
      normalized.injectedChars === 10 &&
      normalized.reportChars === 4 &&
      normalized.gatePassRate === 0 &&
      normalized.costPerDeliveredItem === 0 &&
      !("content" in normalized) &&
      !("prompt" in normalized) &&
      !("report" in normalized),
  );
}
{
  const warns = [];
  const badWriter = createCostMeterWriter({
    directory: join(TMP, "blocked", "sub"),
    logger: { warn: (message) => warns.push(String(message)), info: () => {}, debug: () => {} },
    debounceMs: 0,
  });
  writeFileSync(join(TMP, "blocked"), "not a directory", "utf8");
  let threw = false;
  try {
    badWriter.recordAdd("main", 1, { modelRequests: 1 });
    badWriter.flush();
  } catch {
    threw = true;
  }
  check(
    "cost-meter write failure is warn-only and never throws",
    !threw && warns.length > 0 && warns.some((text) => text.includes("cost-meter")),
  );
}

// ---------------------------------------------------------------------------
// ② Live plugin harness: seed run + child, apply, drive pre-step.
// ---------------------------------------------------------------------------
{
  const store = createStageStore(STORE_FILE);
  store.set("main", "working");
  store.beginWorkflowRun("main");
  store.setPendingStageInjection("main", "working");
  store.setSubagentRole("child", {
    planItemId: "p1",
    persona: "worker",
    parentId: "main",
    stage: "working-then-compress-context-then-report",
    assignedTools: [],
    finalTools: [],
    awaitingParent: true,
    terminalFinal: true,
  });
  persistFinalPlanRun({
    projectRoot: RUN_DIR,
    sessionId: "main",
    runId: 1,
    payload: {
      status: "finalized",
      items: [{ planItemId: "p1", persona: "worker", task: "Do task", assignedTools: [] }],
    },
  });

  const { base, listeners, provided } = makeBase();
  await plugin.apply(base, {
    stageStore: STORE_FILE,
    projectRoot: RUN_DIR,
    costMeterDirectory: METER_DIR,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const preStep = listeners.get("agent/pre-step")?.[0];
  const workflow = provided["kaWhaleWorkflow"];
  check(
    "plugin exposes agent/pre-step listener and kaWhaleWorkflow.costMeter side-channel",
    typeof preStep === "function" &&
      workflow !== undefined &&
      workflow !== null &&
      typeof workflow.costMeter?.recordInjectedChars === "function" &&
      typeof workflow.costMeter?.flush === "function",
  );

  const enter = async (messages, turn) => ({ kind: "enter", messages });
  // Stage injection happens on the first pre-step because pending working stage
  // was seeded before apply; this call also counts as one model request.
  await preStep({ agent: mainAgent, messages: [], turn: 1 }, () => enter([], 1));
  // Per-request increments: three more pre-step calls without user messages.
  for (let index = 0; index < 3; index += 1) {
    await preStep({ agent: mainAgent, messages: [], turn: 1 }, () => enter([], 1));
  }
  // Turns mirror: one real user message in user turn 7.
  await preStep(
    { agent: mainAgent, messages: [{ content: [{ type: "text", text: "continue task" }] }], turn: 7 },
    () => enter([], 7),
  );
  // Terminal report: subagent-settled with child role record → work-log append site.
  const settledMessage = {
    content: [{ type: "text", text: "child full terminal report body" }],
    source: {
      kind: "subagent-settled",
      form: "notice",
      senderSessionId: "child",
      summary: "child summary",
    },
  };
  await preStep({ agent: mainAgent, messages: [settledMessage], turn: 7 }, () => enter([settledMessage], 7));

  workflow.costMeter.flush();
  const meterFile = workflow.costMeter.fileFor("main", 1);
  check("meter file exists at <sessionId>-<runId>.json", existsSync(meterFile));
  const raw = JSON.parse(readFileSync(meterFile, "utf8"));
  const meter = workflow.costMeter.read("main", 1);
  check(
    "meter file schema fields present with run aggregation",
    raw.version === COST_METER_SCHEMA_VERSION &&
      raw.sessionId === "main" &&
      raw.runId === 1 &&
      typeof raw.modelRequests === "number" &&
      typeof raw.turns === "number" &&
      typeof raw.injectedChars === "number" &&
      typeof raw.reportChars === "number" &&
      typeof raw.gatePassRate === "number" &&
      typeof raw.costPerDeliveredItem === "number",
  );
  check(
    "aggregate-only: meter file contains no content/prompt/report/memory text keys",
    !("content" in raw) &&
      !("prompt" in raw) &&
      !("report" in raw) &&
      !("memory" in raw) &&
      !("task" in raw) &&
      !("message" in raw),
  );
  check(
    "per-request increment: modelRequests >= 6 pre-step calls",
    meter.modelRequests >= 6,
  );
  check(
    "turns mirrored from real user message (max 7)",
    meter.turns === 7,
  );
  check(
    "stage injection counts injectedChars (stage text length)",
    meter.injectedChars > 0 && Number.isInteger(meter.injectedChars),
  );
  check(
    "terminal report work-log append counts reportChars (full report body length)",
    meter.reportChars === "child full terminal report body".length,
  );
  check(
    "derived fields are computed-only zeros until gate/delivery data exists",
    meter.gatePassRate === 0 && meter.costPerDeliveredItem === 0,
  );
  check(
    "old-file readable: missing fields normalize to zero",
    normalizeCostMeter({ version: COST_METER_SCHEMA_VERSION }, "old", 0).modelRequests === 0 &&
      normalizeCostMeter({ version: COST_METER_SCHEMA_VERSION }, "old", 0).reportChars === 0,
  );
}

if (failures === 0) rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nKAZ74-METER PROBE OK" : `\nKAZ74-METER PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
