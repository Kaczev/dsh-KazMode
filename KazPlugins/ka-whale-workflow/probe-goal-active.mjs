// ka-whale-workflow v0.9 Goal-active 探针（33 世）：
//   - decide-goal → whale_report({mode:'goal'}) 进入 goal-active 外部模式；
//   - goal-active 不在 MAIN_STAGE_IDS；
//   - goal-active 中 whale_report 普通推进被拒绝；
//   - goal-active/working-resumed §3.1 文案按边界注入；
//   - working-resumed 携带实际 taskPlanPath。
// 运行：node KazPlugins/ka-whale-workflow/probe-goal-active.mjs
import plugin, {
  createStageStore,
  GOAL_ACTIVE_STAGE,
  GOAL_ACTIVE_CONTEXT_TEXT,
  workingResumedContextText,
} from "./lib/index.js";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

const TMP = mkdtempSync(join(tmpdir(), "whale-goal-active-"));
const STORE_FILE = join(TMP, "ka-whale-workflow-stage.json");
const PLAN_FILE = join(TMP, "ka-whale-workflow-task-plan.json");

// Pre-populate stage store: agent starts at decide-goal.
const store = createStageStore(STORE_FILE);
store.set("s-ga", "decide-goal");

const listeners = new Map();
const registeredTools = new Map();
let goalView = null;
const goalsMock = {
  get: () => goalView,
  create(_agent, payload) {
    goalView = {
      id: "g-ga",
      revision: 1,
      phase: "active",
      activation: "armed",
      objective: payload.objective,
      maxGoalRounds: Number.isInteger(payload.maxGoalRounds) ? payload.maxGoalRounds : 256,
      roundsStarted: 0,
    };
    return goalView;
  },
  resume(_agent, ref) {
    goalView = { ...goalView, phase: "active", activation: "armed", revision: ref.revision + 1 };
    return goalView;
  },
};

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
const mockKazMode = {
  pluginConfig: () => ({ enabled: true, includeSubagents: false }),
  toolVisible: () => true,
};
const base = {
  fiber: { state: 0 },
  logger: { info: () => {}, warn: (...a) => console.log("[mock:warn]", ...a), debug: () => {} },
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
  provide() { return () => {}; },
  get(name) {
    if (name === "settings") return settings;
    if (name === "tools") return toolsMock;
    if (name === "kazMode") return mockKazMode;
    if (name === "goals") return goalsMock;
    if (name === "agents") return { roots: () => [], list: () => [], currentInitiator: () => undefined };
    if (name === "roundDisplay") return { report: () => {} };
    return undefined;
  },
  systemPrompt: { section() { return () => {}; } },
  tools: toolsMock,
};

await plugin.apply(base, { stageStore: STORE_FILE, taskPlanStore: PLAN_FILE });
await new Promise((resolve) => setTimeout(resolve, 20));

function stageFromFile(sessionId) {
  const raw = readFileSync(STORE_FILE, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw).sessions?.[sessionId] ?? null;
}
function pendingFromFile(sessionId) {
  const raw = readFileSync(STORE_FILE, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw).pendingStageInjection?.[sessionId] ?? null;
}
function messageText(messages) {
  return (messages ?? [])
    .map((message) => (message?.content ?? []).map((part) => part?.text ?? "").join("\n"))
    .join("\n");
}
const agent = { id: "s-ga", session: { id: "s-ga", events: [] }, steer() {} };
const preStepHandlers = listeners.get("agent/pre-step") ?? [];
const whaleReport = registeredTools.get("whale_report");

// 1) decide-goal → whale_report mode=goal → goal-active external marker.
{
  const result = await whaleReport.execute({ mode: "goal", objective: "Goal active patch", max_goal_rounds: 8 }, { agent });
  check("decide-goal mode=goal 返回 goal-active", result.ok === true && result.stage === GOAL_ACTIVE_STAGE);
  check("goal-active 已写入 stage state", stageFromFile("s-ga") === GOAL_ACTIVE_STAGE);
  check("goal-active pending 注入已挂起", pendingFromFile("s-ga") === GOAL_ACTIVE_STAGE);
}

// 2) goal-active 中普通 whale_report 推进被拒绝。
{
  let rejected = null;
  try {
    await whaleReport.execute({ nextStage: "communication" }, { agent });
  } catch (error) {
    rejected = error.message;
  }
  check("goal-active 拒绝普通推进（workflow-stage-deny）", rejected !== null && String(rejected).startsWith("workflow-stage-deny:"));
}

// 3) pre-step：goal-active 边界注入 §3.1 文案一次。
let goalActiveInjectedOnce = false;
for (const handler of preStepHandlers) {
  const decision = await handler(
    { agent, turn: 2, messages: [] },
    async () => ({ kind: "enter", messages: [] }),
  );
  if (decision === null || typeof decision !== "object" || decision.kind !== "enter") continue;
  const text = messageText(decision.messages ?? []);
  const count = text.split("[ka-whale-workflow goal-active]").length - 1;
  if (count === 1) goalActiveInjectedOnce = true;
  check("goal-active pre-step 返回 enter decision", true);
}
check("goal-active §3.1 文案已作为插件消息注入一次", goalActiveInjectedOnce);
check("goal-active 注入后 pending 已清除", pendingFromFile("s-ga") === null);

// 4) Goal 结束（无 active/paused goal）→ working-resumed 注入含实际 taskPlanPath。
goalView = { ...goalView, phase: "complete", activation: "disarmed" };
let workingResumedSeen = false;
for (const handler of preStepHandlers) {
  const decision = await handler(
    { agent, turn: 3, messages: [] },
    async () => ({ kind: "enter", messages: [] }),
  );
  if (decision === null || typeof decision !== "object" || decision.kind !== "enter") continue;
  const text = messageText(decision.messages ?? []);
  if (
    text.includes("[ka-whale-workflow working-resumed]") &&
    text.includes("taskPlanPath: " + PLAN_FILE) &&
    text.includes("workflow resumes as if working finished")
  ) {
    workingResumedSeen = true;
  }
}
check("Goal 结束后状态切到 working", stageFromFile("s-ga") === "working");
check("working-resumed §3.1 文案已注入且携带实际 taskPlanPath", workingResumedSeen);
check("working-resumed 注入后 pending 已清除", pendingFromFile("s-ga") === null);

// Pure text sanity for direct imports.
check("GOAL_ACTIVE_CONTEXT_TEXT 与 workingResumedContextText 可直接导入", GOAL_ACTIVE_CONTEXT_TEXT.includes("Mode: Goal is active") && workingResumedContextText(PLAN_FILE).includes("taskPlanPath: " + PLAN_FILE));

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nGOAL-ACTIVE PROBE OK" : `\nGOAL-ACTIVE PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
