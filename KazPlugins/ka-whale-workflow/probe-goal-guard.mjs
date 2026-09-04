// ka-whale-workflow Goal 守卫探针（Step 3 修订）：Goal 模式激活（active+armed）时，
// 真实用户消息（新轮/断线重连后）不进入任务重构；blocked/paused/disarmed-active 的
// 非 complete goal 进入 Goal 恢复确认；Goal 结束后恢复任务重构。
// 运行：node KazPlugins/ka-whale-workflow/probe-goal-guard.mjs
import plugin, { DEFAULT_RECONSTRUCTION_TOOLS, createStageStore, GOAL_RECOVERY_STAGE, GOAL_ACTIVE_STAGE } from "./lib/index.js";
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
store.set("s-claim", "done");
store.set("s-paused", "done");
store.set("s-blocked", "done");
store.set("s-pre", "done");

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
  get: () => ({ enabled: true, includeSubagents: false, reconstructionTools: [...DEFAULT_RECONSTRUCTION_TOOLS] }),
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
  pluginConfig: () => ({ enabled: true, includeSubagents: false, reconstructionTools: [...DEFAULT_RECONSTRUCTION_TOOLS] }),
  toolVisible: () => true,
};

let goalPhase = undefined; // undefined | "active" | "paused" | "complete"
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
    if (deps.includes("settings")) {
      setImmediate(() => cb({ ...base, settings }));
    }
  },
  effect(fn) {
    fn();
    return () => {};
  },
  provide() {
    return () => {};
  },
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
const preStepHandlers = listeners.get("agent/pre-step") ?? [];

// 1) active goal：done 阶段 + 新轮真实用户消息 → 直接进入 goal-active，不重复 assess。
goalPhase = "active";
const claimAgent = {
  id: "s-claim",
  session: { id: "s-claim", events: [] },
  steer() {},
};
for (const handler of claimedHandlers) {
  await handler({ agent: claimAgent, message: userMessage(), turn: 2 });
}
check("goal active 时新轮消息直接进入 goal-active（不重复 assess）", stageFromFile("s-claim") === GOAL_ACTIVE_STAGE);

// 2) goal 结束（无 goal）后，新轮消息恢复进入 assess-complexity。
goalPhase = undefined;
for (const handler of claimedHandlers) {
  await handler({ agent: claimAgent, message: userMessage(), turn: 3 });
}
check("goal 结束后新轮消息恢复 assess-complexity", stageFromFile("s-claim") === "assess-complexity");

// 3) paused goal：非 complete goal 需要恢复确认，进入 goal-recovery，不直接任务重构。
store.set("s-paused", "done");
goalPhase = "paused";
const pausedAgent = {
  id: "s-paused",
  session: { id: "s-paused", events: [] },
  steer() {},
};
for (const handler of claimedHandlers) {
  await handler({ agent: pausedAgent, message: userMessage(), turn: 2 });
}
check("goal paused 时新轮消息进入 Goal 恢复确认", stageFromFile("s-paused") === GOAL_RECOVERY_STAGE);

// 3b) blocked goal：Step 3 核心场景，同样进入 goal-recovery，而不是任务重构。
store.set("s-blocked", "done");
goalPhase = "blocked";
const blockedAgent = {
  id: "s-blocked",
  session: { id: "s-blocked", events: [] },
  steer() {},
};
for (const handler of claimedHandlers) {
  await handler({ agent: blockedAgent, message: userMessage(), turn: 2 });
}
check("goal blocked 时新轮消息进入 Goal 恢复确认", stageFromFile("s-blocked") === GOAL_RECOVERY_STAGE);

// 4) agent/pre-step 兜底路径同样不进入任务重构（goal active+armed）。
goalPhase = "active";
const preAgent = {
  id: "s-pre",
  session: { id: "s-pre", events: [] },
  steer() {},
};
for (const handler of preStepHandlers) {
  const decision = await handler(
    { agent: preAgent, turn: 2, messages: [userMessage()] },
    async () => ({ kind: "enter", messages: [] }),
  );
  if (decision === null || typeof decision !== "object" || decision.kind !== "enter") {
    check("pre-step handler 正常返回 decision", false);
  }
}
check("pre-step：goal active 时新轮消息进入 goal-active（不重复 assess）", stageFromFile("s-pre") === GOAL_ACTIVE_STAGE);

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nGOAL-GUARD PROBE OK" : `\nGOAL-GUARD PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
