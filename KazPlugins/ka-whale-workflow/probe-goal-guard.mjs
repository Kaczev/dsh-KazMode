// ka-whale-workflow Goal 守卫探针：Goal 模式激活（active/paused）时，
// 真实用户消息（新轮/断线重连后）不进入任务重构；Goal 结束后恢复重构。
// 运行：node KazPlugins/ka-whale-workflow/probe-goal-guard.mjs
import plugin, { DEFAULT_RECONSTRUCTION_TOOLS, createStageStore } from "./lib/index.js";
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

// 1) active goal：done 阶段 + 新轮真实用户消息 → 保持 done，不进入任务重构。
goalPhase = "active";
const claimAgent = {
  id: "s-claim",
  session: { id: "s-claim", events: [] },
  steer() {},
};
for (const handler of claimedHandlers) {
  await handler({ agent: claimAgent, message: userMessage(), turn: 2 });
}
check("goal active 时新轮消息不进入任务重构（保持 done）", stageFromFile("s-claim") === "done");

// 2) goal 结束（无 goal）后，新轮消息恢复进入任务重构。
goalPhase = undefined;
for (const handler of claimedHandlers) {
  await handler({ agent: claimAgent, message: userMessage(), turn: 3 });
}
check("goal 结束后新轮消息恢复任务重构", stageFromFile("s-claim") === "reconstruction");

// 3) paused goal 同样视为激活（与 kaz-system-prompt 的 goalActive 一致）。
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
check("goal paused 时新轮消息同样保持 done", stageFromFile("s-paused") === "done");

// 4) agent/pre-step 兜底路径同样不进入任务重构（goal active）。
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
check("pre-step：goal active 时新轮消息不进入任务重构", stageFromFile("s-pre") === "done");

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nGOAL-GUARD PROBE OK" : `\nGOAL-GUARD PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
