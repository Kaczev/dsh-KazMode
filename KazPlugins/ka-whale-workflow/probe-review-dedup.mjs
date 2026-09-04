// ka-whale-workflow 复盘去重探针：同一逻辑任务运行最多一次 [ka-whale-memory Review]，
// 先到边界获胜；新任务运行（进入 reconstruction）后可再次注入；
// session 级“每 kind 一次”上限仍然成立。
// v0.8 Step B1：原生 Plan 已移除，去重边界只测 normal / goal。
// 运行：node KazPlugins/ka-whale-workflow/probe-review-dedup.mjs
import plugin, { DEFAULT_RECONSTRUCTION_TOOLS, createStageStore } from "./lib/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

const TMP = mkdtempSync(join(tmpdir(), "whale-review-dedup-"));
const STORE_FILE = join(TMP, "ka-whale-workflow-stage.json");
const store = createStageStore(STORE_FILE);

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

for (const id of ["s-run", "s-goal-cap", "s-act"]) store.set(id, "done");

await plugin.apply(base, { stageStore: STORE_FILE });
await new Promise((resolve) => setTimeout(resolve, 20));

const turnStoppingHandlers = listeners.get("agent/turn-stopping") ?? [];
const inboxClaimedHandlers = listeners.get("agent/inbox/claimed") ?? [];

function textOf(m) {
  const blocks = m !== null && typeof m === "object" ? m.content : undefined;
  return Array.isArray(blocks)
    ? blocks.map((b) => (b !== null && typeof b === "object" && b.type === "text" ? b.text : "")).join("\n")
    : "";
}

function makeAgent(id) {
  const messages = [];
  return {
    id,
    session: { id, events: [] },
    steer(message) { messages.push(message); },
    get messages() { return messages; },
  };
}

async function runTurnStopping(agent) {
  for (const handler of turnStoppingHandlers) {
    await handler({ agent, turn: 1, signal: undefined });
  }
}

async function runInbox(agent, turn) {
  const message = { content: [{ type: "text", text: "新任务" }], source: { kind: "user" } };
  for (const handler of inboxClaimedHandlers) {
    await handler({ agent, message, turn });
  }
}

/** 用 whale_report 把内部阶段推进到 communication（v0.9 终态，触发复盘边界）。 */
async function classifyToDone(agent) {
  const def = registeredTools.get("whale_report");
  if (def === undefined || def === null || typeof def.execute !== "function") return false;
  await def.execute({ nextStage: "communication" }, { agent });
  return true;
}

function memoryReviewMessages(agent) {
  return agent.messages.filter(
    (m) => m?.source?.kind === "plugin" && m?.source?.plugin === "ka-whale-workflow" && m?.source?.form === "review",
  );
}

// ---------------------------------------------------------------------------
// 场景 1：Normal 完成已注入 → 同一逻辑任务再次到 done 不得二次注入；
//        新逻辑任务进入 reconstruction 后允许再次注入。
// ---------------------------------------------------------------------------
const runAgent = makeAgent("s-run");
await runTurnStopping(runAgent); // Normal 完成
check("首轮 Normal 完成注入一次 [ka-whale-memory Review]", memoryReviewMessages(runAgent).length === 1 && textOf(memoryReviewMessages(runAgent)[0]).includes("[ka-whale-memory Review]"));
await runTurnStopping(runAgent); // 同任务再次到 done（Normal 完成）
check("同任务 Normal 完成不再注入第二条 [ka-whale-memory Review]", memoryReviewMessages(runAgent).length === 1);

await runInbox(runAgent, 2); // done → reconstruction（递增 taskRunId）
check("新任务可进入重构并推进到 done（场景1）", await classifyToDone(runAgent) === true);
await runTurnStopping(runAgent);
const afterNewRun = memoryReviewMessages(runAgent);
check("新任务运行后可再次注入 normal 复盘", afterNewRun.length === 2 && afterNewRun.some((m) => textOf(m).includes("The task has completed.")));

// ---------------------------------------------------------------------------
// 场景 2：session goal 复盘每 session 一次仍成立（跨新任务运行也不重复）。
// ---------------------------------------------------------------------------
const goalCapAgent = makeAgent("s-goal-cap");
goalActiveFlag = true;
await runTurnStopping(goalCapAgent); // 观察 goal active，不注入
goalActiveFlag = false;
await runTurnStopping(goalCapAgent); // Goal 结束 → 注入 goal 复盘
check("首轮 Goal 结束注入 goal 复盘", memoryReviewMessages(goalCapAgent).length === 1 && textOf(memoryReviewMessages(goalCapAgent)[0]).includes("The Goal has ended."));
// 新任务运行 + 再次 Goal 激活/结束 → goal kind 已注入，仍不重复。
await runInbox(goalCapAgent, 2);
check("whale_report 可推进到 done（场景2）", await classifyToDone(goalCapAgent) === true);
goalActiveFlag = true;
await runTurnStopping(goalCapAgent);
goalActiveFlag = false;
await runTurnStopping(goalCapAgent);
check("session goal 复盘跨新任务仍不重复", memoryReviewMessages(goalCapAgent).length === 1);

// ---------------------------------------------------------------------------
// 场景 3：新 goal 激活本身即新任务运行 → 重置 per-run 标记。
// （先注入 normal；随后 goal 激活→结束，goal 复盘仍允许注入。）
// ---------------------------------------------------------------------------
const actAgent = makeAgent("s-act");
await runTurnStopping(actAgent); // Normal 完成 → normal 复盘
check("激活前 normal 复盘已注入一次", memoryReviewMessages(actAgent).length === 1);
goalActiveFlag = true;
await runTurnStopping(actAgent); // 观察 goal 激活（false→true → 新任务运行）
goalActiveFlag = false;
await runTurnStopping(actAgent); // Goal 结束
check("新 goal 激活重置 per-run 标记后允许注入 goal 复盘", memoryReviewMessages(actAgent).length === 2 && memoryReviewMessages(actAgent).some((m) => textOf(m).includes("The Goal has ended.")));

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nREVIEW-DEDUP PROBE OK" : `\nREVIEW-DEDUP PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
