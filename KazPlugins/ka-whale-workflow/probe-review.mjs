// 方向1 Stage2 小探针：验证任务完成（stage=done、无 plan/goal）时注入复盘指引。
import plugin, { DEFAULT_RECONSTRUCTION_TOOLS, createStageStore } from "./lib/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

const TMP = mkdtempSync(join(tmpdir(), "whale-review-"));
const STORE_FILE = join(TMP, "ka-whale-workflow-stage.json");
const store = createStageStore(STORE_FILE);
store.set("s-review", "done");
store.set("s-review-plan", "done");
store.set("s-review-goal", "done");

const listeners = new Map();
const registeredTools = new Map();
const steered = [];

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

let goalActiveFlag = false;
const goalsMock = { get: () => (goalActiveFlag ? { phase: "active" } : undefined) };

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
      // 真实 cordis 的 inject 回调是异步的；mock 也延迟到 apply 同步段执行完之后。
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

const agent = {
  id: "s-review",
  session: { id: "s-review", events: [] },
  steer(message) { steered.push(message); },
};

const turnStoppingHandlers = listeners.get("agent/turn-stopping") ?? [];
for (const handler of turnStoppingHandlers) {
  await handler({ agent, turn: 1, signal: undefined });
}

const reviewText = steered.map((m) => {
  const blocks = m !== null && typeof m === "object" ? m.content : undefined;
  const text = Array.isArray(blocks)
    ? blocks.map((b) => (b !== null && typeof b === "object" && b.type === "text" ? b.text : "")).join("\n")
    : "";
  return text;
}).join("\n");

check("任务完成时注入复盘指引", reviewText.includes("[kaz-memory Review]"));
check("复盘指引包含 memory_save", reviewText.includes("memory_save"));
check("复盘指引包含 lifecycle_status=CANDIDATE", reviewText.includes("lifecycle_status=CANDIDATE"));

// 第二次触发不重复注入（normal 每 session 一次）。
const before = steered.length;
for (const handler of turnStoppingHandlers) {
  await handler({ agent, turn: 2, signal: undefined });
}
check("同一 session 不重复注入 normal 复盘", steered.length === before);

function messageText(m) {
  const blocks = m !== null && typeof m === "object" ? m.content : undefined;
  return Array.isArray(blocks)
    ? blocks.map((b) => (b !== null && typeof b === "object" && b.type === "text" ? b.text : "")).join("\n")
    : "";
}

// Plan 结束：先 active=true，再 active=false → 注入 plan 复盘。
const planSteered = [];
const planAgent = {
  id: "s-review-plan",
  session: { id: "s-review-plan", events: [{ type: "plan/mode", data: { active: true } }] },
  steer(message) { planSteered.push(message); },
};
for (const handler of turnStoppingHandlers) {
  await handler({ agent: planAgent, turn: 1, signal: undefined });
}
planAgent.session.events = [{ type: "plan/mode", data: { active: false } }];
for (const handler of turnStoppingHandlers) {
  await handler({ agent: planAgent, turn: 2, signal: undefined });
}
check("plan 结束注入 plan 复盘", planSteered.some((m) => messageText(m).includes("[kaz-memory Review]") && messageText(m).includes("Plan 模式已结束")));

// Goal 结束：先 active，再 inactive → 注入 goal 复盘。
const goalSteered = [];
const goalAgent = {
  id: "s-review-goal",
  session: { id: "s-review-goal", events: [] },
  steer(message) { goalSteered.push(message); },
};
goalActiveFlag = true;
for (const handler of turnStoppingHandlers) {
  await handler({ agent: goalAgent, turn: 1, signal: undefined });
}
goalActiveFlag = false;
for (const handler of turnStoppingHandlers) {
  await handler({ agent: goalAgent, turn: 2, signal: undefined });
}
check("goal 结束注入 goal 复盘", goalSteered.some((m) => messageText(m).includes("[kaz-memory Review]") && messageText(m).includes("Goal 已结束")));

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nREVIEW PROBE OK" : `\nREVIEW PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
