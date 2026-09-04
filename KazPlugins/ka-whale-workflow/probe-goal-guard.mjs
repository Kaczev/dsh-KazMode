// ka-whale-workflow Goal 守卫探针（v0.9 B5 口径）：
//   - active/paused goal 的新轮真实用户消息保持 goal-active，不进入 assess；
//   - blocked/complete/无 goal 时新轮真实用户消息进入 assess-complexity；
//   - 不写 / 不读旧 goal-recovery / reconstruction / classification 阶段。
// 运行：node KazPlugins/ka-whale-workflow/probe-goal-guard.mjs
import plugin, { createStageStore, GOAL_ACTIVE_STAGE } from "./lib/index.js";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

const TMP = mkdtempSync(join(tmpdir(), "whale-goal-guard-"));
const STORE_FILE = join(TMP, "ka-whale-workflow-stage.json");
const store = createStageStore(STORE_FILE);
store.set("s-active", "done");
store.set("s-paused", "done");
store.set("s-blocked", "done");
store.set("s-none", "done");

const listeners = new Map();
const registeredTools = new Map();
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

let goalPhase = undefined;
const goalsMock = { get: () => (goalPhase ? { phase: goalPhase } : undefined) };

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
    fn();
    return () => {};
  },
  provide() { return () => {}; },
  get(name) {
    if (name === "settings") return settings;
    if (name === "tools") return toolsMock;
    if (name === "kazMode") return mockKazMode;
    if (name === "goals") return goalsMock;
    if (name === "agents") return { roots: () => [], list: () => [], currentInitiator: () => undefined };
    if (name === "roundDisplay") return { report: () => {} };
    if (name === "roundMinimal") return undefined;
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
const claimedHandlers = listeners.get("agent/inbox/claimed") ?? [];
const claimedHandler = claimedHandlers[0];

// 1) active goal: done + new real user turn -> goal-active.
goalPhase = "active";
const activeAgent = { id: "s-active", session: { id: "s-active", events: [] }, steer() {} };
await claimedHandler({ agent: activeAgent, message: userMessage(), turn: 2 });
check("active goal 时新轮消息进入 goal-active", stageFromFile("s-active") === GOAL_ACTIVE_STAGE);

// 2) paused goal is also active for workflow purposes -> goal-active.
goalPhase = "paused";
const pausedAgent = { id: "s-paused", session: { id: "s-paused", events: [] }, steer() {} };
await claimedHandler({ agent: pausedAgent, message: userMessage(), turn: 2 });
check("paused goal 时新轮消息保持 goal-active", stageFromFile("s-paused") === GOAL_ACTIVE_STAGE);

// 3) blocked goal no longer routes to goal-recovery; B5 sends it to assess-complexity.
goalPhase = "blocked";
const blockedAgent = { id: "s-blocked", session: { id: "s-blocked", events: [] }, steer() {} };
await claimedHandler({ agent: blockedAgent, message: userMessage(), turn: 2 });
check("blocked goal 时新轮消息进入 assess-complexity（无旧 goal-recovery）", stageFromFile("s-blocked") === "assess-complexity");

// 4) no goal -> assess-complexity.
goalPhase = undefined;
const noneAgent = { id: "s-none", session: { id: "s-none", events: [] }, steer() {} };
await claimedHandler({ agent: noneAgent, message: userMessage(), turn: 2 });
check("无 goal 时新轮消息进入 assess-complexity", stageFromFile("s-none") === "assess-complexity");

// Stage store rejects old strings.
check("旧 reconstruction 不再可写入", store.set("s-x", "reconstruction") === false && store.set("s-x", "goal-recovery") === false && store.set("s-x", "classification") === false);

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nGOAL-GUARD PROBE OK" : `\nGOAL-GUARD PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
