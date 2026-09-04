// ka-whale-workflow Step 3 探针：Goal 恢复修复（C15/C17/v0.4 §9.3）。
// 覆盖：
//   - goalRecoveryNeededOf / nextStageOnUserMessage 纯函数；
//   - blocked/paused 新轮真实用户消息进入 goal-recovery（不直接任务重构）；
//   - whale_report 在 goal-recovery 中 mode=goal 恢复既有 goal；
//   - whale_report 在 goal-recovery 中不带 mode 进入新任务重构；
//   - whale_report 在 classification 中遇到既有非 complete goal 时 resume，
//     不静默 create；轮次耗尽/换 objective 结构化拒绝；
//   - 无 goal / complete 时才 create。
// 运行：node KazPlugins/ka-whale-workflow/probe-step3-goal-recovery.mjs
import plugin, {
  DEFAULT_RECONSTRUCTION_TOOLS,
  createStageStore,
  GOAL_RECOVERY_STAGE,
  GOAL_CONTINUATION_TEXT,
  goalRecoveryNeededOf,
  nextStageOnUserMessage,
  currentGoalOf,
  hasDirectHumanInOpenTurn,
  whaleReportReminderText,
} from "./lib/index.js";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

// ---------------------------------------------------------------------------
// ① 纯函数层
// ---------------------------------------------------------------------------
{
  const armed = { id: "g", phase: "active", roundsStarted: 1, maxGoalRounds: 5, activation: "armed" };
  const disarmed = { id: "g", phase: "active", roundsStarted: 1, maxGoalRounds: 5, activation: "disarmed" };
  const paused = { id: "g", phase: "paused", roundsStarted: 1, maxGoalRounds: 5, activation: "disarmed" };
  const blocked = { id: "g", phase: "blocked", roundsStarted: 1, maxGoalRounds: 5, activation: "disarmed", blockedReason: { code: "waiting", message: "need user direction" } };
  const complete = { id: "g", phase: "complete", roundsStarted: 5, maxGoalRounds: 5, activation: "disarmed" };
  const goalsFor = (goal) => ({ get: () => goal });

  check("goalRecoveryNeededOf: blocked → goal", goalRecoveryNeededOf({}, goalsFor(blocked))?.phase === "blocked");
  check("goalRecoveryNeededOf: paused → goal", goalRecoveryNeededOf({}, goalsFor(paused))?.phase === "paused");
  check("goalRecoveryNeededOf: disarmed active → goal", goalRecoveryNeededOf({}, goalsFor(disarmed))?.phase === "active");
  check("goalRecoveryNeededOf: armed active → null", goalRecoveryNeededOf({}, goalsFor(armed)) === null);
  check("goalRecoveryNeededOf: complete → null", goalRecoveryNeededOf({}, goalsFor(complete)) === null);
  check("goalRecoveryNeededOf: no goal → null", goalRecoveryNeededOf({}, goalsFor(null)) === null);

  check(
    "nextStageOnUserMessage: blocked → goal-recovery",
    nextStageOnUserMessage("done", 2, { goalActive: false, goalRecovery: blocked }) === GOAL_RECOVERY_STAGE,
  );
  check(
    "nextStageOnUserMessage: paused → goal-recovery",
    nextStageOnUserMessage("done", 2, { goalActive: true, goalRecovery: paused }) === GOAL_RECOVERY_STAGE,
  );
  check(
    "nextStageOnUserMessage: armed active → stay done",
    nextStageOnUserMessage("done", 2, { goalActive: true, goalRecovery: null }) === "done",
  );
  check(
    "nextStageOnUserMessage: no goal → reconstruction",
    nextStageOnUserMessage("done", 2, { goalActive: false, goalRecovery: null }) === "reconstruction",
  );
  check("GOAL_CONTINUATION_TEXT 含 ask_user_question 与继续/新任务/结束", GOAL_CONTINUATION_TEXT.includes("ask_user_question") && GOAL_CONTINUATION_TEXT.includes("Continue the original goal") && GOAL_CONTINUATION_TEXT.includes("Start a new task"));
  check("v0.8 Step A 提醒为空（不再有旧阶段提醒）", whaleReportReminderText(GOAL_RECOVERY_STAGE) === "");

  const humanAgent = { session: { events: [
    { type: "turn/start", data: { turn: 2 } },
    { type: "user/message", data: { source: { kind: "user" } } },
  ] } };
  const noHumanAgent = { session: { events: [
    { type: "turn/start", data: { turn: 2 } },
    { type: "user/message", data: { source: { kind: "goal" } } },
  ] } };
  check("hasDirectHumanInOpenTurn 识别直接人类消息", hasDirectHumanInOpenTurn(humanAgent) === true);
  check("hasDirectHumanInOpenTurn 拒绝 goal 注入消息", hasDirectHumanInOpenTurn(noHumanAgent) === false);
}

// ---------------------------------------------------------------------------
// ② 插件级：blocked/paused 新轮进入 goal-recovery + whale_report 恢复/新任务
// ---------------------------------------------------------------------------
const TMP = mkdtempSync(join(tmpdir(), "whale-step3-goal-recovery-"));
const STORE_FILE = join(TMP, "ka-whale-workflow-stage.json");
const store = createStageStore(STORE_FILE);
for (const id of ["s-blocked-claim", "s-paused-claim", "s-recover", "s-newtask", "s-classify-create", "s-classify-resume", "s-classify-exhausted", "s-classify-diffobj"]) {
  store.set(id, "done");
}

const listeners = new Map();
const registeredTools = new Map();
const calls = [];
let currentGoal = null;
const goalsMock = {
  get: () => currentGoal,
  create(agent, payload) {
    calls.push({ op: "create", agent: agent.id, payload });
    currentGoal = {
      id: `goal-${calls.length}`,
      revision: 1,
      phase: "active",
      objective: payload.objective,
      maxGoalRounds: Number.isInteger(payload.maxGoalRounds) ? payload.maxGoalRounds : 256,
      roundsStarted: 0,
      activation: "armed",
    };
    return currentGoal;
  },
  resume(agent, ref) {
    calls.push({ op: "resume", agent: agent.id, ref: { ...ref } });
    currentGoal = { ...currentGoal, phase: "active", revision: ref.revision + 1, activation: "armed" };
    return currentGoal;
  },
};

const settings = {
  register(ns, _schema, opts = {}) {
    let cfg = { ...(opts.base ?? {}) };
    return {
      get: () => ({ ...cfg }),
      watch: () => () => {},
      update: (patch) => { cfg = { ...cfg, ...patch }; return Promise.resolve(); },
    };
  },
  get: () => ({ enabled: true, includeSubagents: false, reconstructionTools: [...DEFAULT_RECONSTRUCTION_TOOLS], taskToolSelectionEnabled: false }),
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
  pluginConfig: (agent) => ({
    enabled: true,
    includeSubagents: false,
    reconstructionTools: [...DEFAULT_RECONSTRUCTION_TOOLS],
    taskToolSelectionEnabled: agent?.id === "s-classify-create" || agent?.id === "s-classify-resume" || agent?.id === "s-classify-exhausted" || agent?.id === "s-classify-diffobj" ? false : false,
  }),
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

await plugin.apply(base, { stageStore: STORE_FILE });
await new Promise((resolve) => setTimeout(resolve, 20));

function stageFromFile(sessionId) {
  const raw = readFileSync(STORE_FILE, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw).sessions?.[sessionId] ?? null;
}
function userMessage() {
  return { content: [{ type: "text", text: "继续" }], source: { kind: "user" } };
}
function makeAgent(id, events = []) {
  return { id, session: { id, events }, steer() {} };
}
function openHumanEvents(turn = 2) {
  return [
    { type: "turn/start", data: { turn } },
    { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "继续" }] } },
  ];
}
const claimedHandlers = listeners.get("agent/inbox/claimed") ?? [];
const claimedHandler = claimedHandlers[0];
const whaleReport = () => registeredTools.get("whale_report");
const execute = async (def, args, agent) => def.execute(args, { agent });
const toClassification = async (agent) => {
  // v0.8 Step A：whale_report 从稳定状态直接处理 mode；不再需要 reconstruction/classification。
  store.set(agent.id, "done");
  return stageFromFile(agent.id);
};

// 2.1 blocked → goal-recovery
{
  store.set("s-blocked-claim", "done");
  currentGoal = { id: "g-blocked", revision: 2, phase: "blocked", objective: "old", maxGoalRounds: 5, roundsStarted: 2, activation: "disarmed", blockedReason: { code: "waiting", message: "need direction" } };
  const agent = makeAgent("s-blocked-claim");
  await claimedHandler({ agent, message: userMessage(), turn: 2 });
  check("blocked 新轮进入 goal-recovery（不直接任务重构）", stageFromFile("s-blocked-claim") === GOAL_RECOVERY_STAGE);
}

// 2.2 paused → goal-recovery
{
  store.set("s-paused-claim", "done");
  currentGoal = { id: "g-paused", revision: 2, phase: "paused", objective: "old", maxGoalRounds: 5, roundsStarted: 2, activation: "disarmed" };
  const agent = makeAgent("s-paused-claim");
  await claimedHandler({ agent, message: userMessage(), turn: 2 });
  check("paused 新轮进入 goal-recovery", stageFromFile("s-paused-claim") === GOAL_RECOVERY_STAGE);
}

// 2.3 goal-recovery → 继续（whale_report mode=goal resume）
{
  store.set("s-recover", "done");
  currentGoal = { id: "g-recover", revision: 2, phase: "blocked", objective: "old objective", maxGoalRounds: 10, roundsStarted: 3, activation: "disarmed", blockedReason: { code: "waiting", message: "need user direction" } };
  calls.length = 0;
  const agent = makeAgent("s-recover", openHumanEvents(2));
  await claimedHandler({ agent, message: userMessage(), turn: 2 });
  const before = stageFromFile("s-recover");
  const result = await execute(whaleReport(), { mode: "goal" }, agent);
  check("goal-recovery mode=goal → done", before === GOAL_RECOVERY_STAGE && result.stage === "done" && stageFromFile("s-recover") === "done");
  check("goal-recovery resume 调用 goals.resume 且不 create", calls.some((c) => c.op === "resume" && c.agent === "s-recover") && !calls.some((c) => c.op === "create"));
}

// 2.4 goal-recovery → 新任务（whale_report 无 mode → reconstruction）
{
  store.set("s-newtask", "done");
  currentGoal = { id: "g-new", revision: 2, phase: "paused", objective: "old objective", maxGoalRounds: 10, roundsStarted: 1, activation: "disarmed" };
  const agent = makeAgent("s-newtask");
  await claimedHandler({ agent, message: userMessage(), turn: 2 });
  const result = await execute(whaleReport(), {}, agent);
  check("goal-recovery 无 mode → reconstruction（新任务）", result.stage === "reconstruction" && stageFromFile("s-newtask") === "reconstruction");
}

// ---------------------------------------------------------------------------
// ③ whale_report 分类阶段：既有 goal resume / exhausted / different objective / create
// ---------------------------------------------------------------------------
// 3.1 无既有 goal → create
{
  currentGoal = null;
  calls.length = 0;
  const agent = makeAgent("s-classify-create", openHumanEvents(2));
  await toClassification(agent);
  const result = await execute(whaleReport(), { mode: "goal", objective: "brand new", max_goal_rounds: 12 }, agent);
  check("无既有 goal：mode=goal create 成功且 done", result.stage === "done" && calls.some((c) => c.op === "create" && c.agent === "s-classify-create" && c.payload.objective === "brand new"));
}

// 3.2 既有 blocked、轮次未耗尽 → resume（不带 objective）
{
  currentGoal = { id: "g-resume", revision: 3, phase: "blocked", objective: "old objective", maxGoalRounds: 10, roundsStarted: 2, activation: "disarmed", blockedReason: { code: "waiting", message: "need direction" } };
  calls.length = 0;
  const agent = makeAgent("s-classify-resume", openHumanEvents(2));
  await toClassification(agent);
  const result = await execute(whaleReport(), { mode: "goal" }, agent);
  check("既有 blocked：分类 mode=goal resume 成功且 done", result.stage === "done" && calls.some((c) => c.op === "resume" && c.agent === "s-classify-resume"));
  check("既有 blocked：不 create", !calls.some((c) => c.op === "create"));
}

// 3.3 既有 goal 轮次耗尽 → 结构化拒绝，stage 保持 classification
{
  currentGoal = { id: "g-exhausted", revision: 4, phase: "blocked", objective: "old objective", maxGoalRounds: 5, roundsStarted: 5, activation: "disarmed", blockedReason: { code: "waiting", message: "need direction" } };
  calls.length = 0;
  const agent = makeAgent("s-classify-exhausted", openHumanEvents(2));
  await toClassification(agent);
  let rejected = null;
  try {
    await execute(whaleReport(), { mode: "goal" }, agent);
  } catch (error) {
    rejected = error.message;
  }
  check("轮次耗尽：拒绝且给出 maxGoalRounds 指引", rejected !== null && /exhausted/.test(rejected) && /maxGoalRounds/.test(rejected));
  check("轮次耗尽：不 resume/create，stage 保持 done", calls.length === 0 && stageFromFile("s-classify-exhausted") === "done");
}

// 3.4 既有 goal + 不同 objective → 拒绝，不静默 create
{
  currentGoal = { id: "g-diffobj", revision: 2, phase: "blocked", objective: "old objective", maxGoalRounds: 10, roundsStarted: 1, activation: "disarmed", blockedReason: { code: "waiting", message: "need direction" } };
  calls.length = 0;
  const agent = makeAgent("s-classify-diffobj", openHumanEvents(2));
  await toClassification(agent);
  let rejected = null;
  try {
    await execute(whaleReport(), { mode: "goal", objective: "a different objective" }, agent);
  } catch (error) {
    rejected = error.message;
  }
  check("不同 objective：拒绝且提示先 complete/clear", rejected !== null && /non-complete goal/.test(rejected));
  check("不同 objective：不 create/resume", calls.length === 0);
}

// currentGoalOf 在 plugin goals 服务上的基本读（避免纯层与运行层脱节）
{
  currentGoal = { id: "g-current", revision: 1, phase: "active", objective: "x", maxGoalRounds: 5, roundsStarted: 0, activation: "armed" };
  const view = currentGoalOf({ id: "s-x" }, goalsMock);
  check("currentGoalOf 经 plugin goals 服务读取当前 goal", view?.id === "g-current");
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nSTEP3-GOAL-RECOVERY PROBE OK" : `\nSTEP3-GOAL-RECOVERY PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
