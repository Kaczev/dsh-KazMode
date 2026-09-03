// ka-whale-workflow 复盘去重探针：同一逻辑任务运行最多一次 [ka-whale-memory Review]，
// 先到边界获胜；新任务运行（进入 reconstruction）后可再次注入；
// session 级“每 kind 一次”上限仍然成立。
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

store.set("s-run", "done");
store.set("s-plan-cap", "done");
store.set("s-act", "done");

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

/** 用 whale_report 把内部阶段推进到 done（reconstruction → classification → done）。 */
async function classifyToDone(agent) {
  const def = registeredTools.get("whale_report");
  if (def === undefined || def === null || typeof def.execute !== "function") return false;
  await def.execute({}, { agent });
  // 契约确认闸门：模拟 ask_user_question 返回「确认」，由 tools/result 监听写入 stage store。
  for (const handler of listeners.get("tools/result") ?? []) {
    await handler({ name: "ask_user_question", agent }, { answers: [{ answer: "确认" }] });
  }
  await def.execute({ mode: "normal" }, { agent });
  return true;
}

function memoryReviewMessages(agent) {
  return agent.messages.filter(
    (m) => m?.source?.kind === "plugin" && m?.source?.plugin === "ka-whale-workflow" && m?.source?.form === "review",
  );
}

// ---------------------------------------------------------------------------
// 场景 1：Plan 结束已注入 → 同一逻辑任务的 Normal 完成不得二次注入。
// ---------------------------------------------------------------------------
const runAgent = makeAgent("s-run");
runAgent.session.events = [{ type: "plan/mode", data: { active: true } }];
await runTurnStopping(runAgent); // 观察 plan active，不注入
runAgent.session.events = [
  { type: "plan/mode", data: { active: true } },
  { type: "plan/mode", data: { active: false } },
];
await runTurnStopping(runAgent); // Plan 结束 → 注入 plan 复盘
check("Plan 结束注入一次 [ka-whale-memory Review]", memoryReviewMessages(runAgent).length === 1 && textOf(memoryReviewMessages(runAgent)[0]).includes("[ka-whale-memory Review]"));
await runTurnStopping(runAgent); // 同任务再次到 done（Normal 完成）
check("同任务 Normal 完成不再注入第二条 [ka-whale-memory Review]", memoryReviewMessages(runAgent).length === 1);

// ---------------------------------------------------------------------------
// 场景 2：新逻辑任务进入 reconstruction 后，Normal 完成允许再次注入。
// ---------------------------------------------------------------------------
await runInbox(runAgent, 2); // done → reconstruction（递增 taskRunId）
check("新任务可进入重构并推进到 done（场景2）", await classifyToDone(runAgent) === true);
await runTurnStopping(runAgent);
const afterNewRun = memoryReviewMessages(runAgent);
check("新任务运行后可再次注入 normal 复盘", afterNewRun.length === 2 && afterNewRun.some((m) => textOf(m).includes("The task has completed.")));

// ---------------------------------------------------------------------------
// 场景 3：session 每 kind 一次的上限仍成立（normal 已注入 → 再新任务也不重复）。
// ---------------------------------------------------------------------------
await runInbox(runAgent, 3);
check("whale_report 可推进到 done（场景3）", await classifyToDone(runAgent) === true);
await runTurnStopping(runAgent);
check("session normal 复盘每 session 一次仍成立", memoryReviewMessages(runAgent).length === 2);

// ---------------------------------------------------------------------------
// 场景 4：session plan 复盘每 session 一次仍成立（跨新任务运行也不重复）。
// ---------------------------------------------------------------------------
const planCapAgent = makeAgent("s-plan-cap");
planCapAgent.session.events = [{ type: "plan/mode", data: { active: true } }];
await runTurnStopping(planCapAgent);
planCapAgent.session.events = [
  { type: "plan/mode", data: { active: true } },
  { type: "plan/mode", data: { active: false } },
];
await runTurnStopping(planCapAgent);
check("首轮 Plan 结束注入 plan 复盘", memoryReviewMessages(planCapAgent).length === 1);
// 新任务运行 + 再次 Plan 激活/结束 → plan kind 已注入，仍不重复。
await runInbox(planCapAgent, 2);
check("whale_report 可推进到 done（场景4）", await classifyToDone(planCapAgent) === true);
planCapAgent.session.events = [{ type: "plan/mode", data: { active: true } }];
await runTurnStopping(planCapAgent);
planCapAgent.session.events = [
  { type: "plan/mode", data: { active: true } },
  { type: "plan/mode", data: { active: false } },
];
await runTurnStopping(planCapAgent);
check("session plan 复盘跨新任务仍不重复", memoryReviewMessages(planCapAgent).length === 1);

// ---------------------------------------------------------------------------
// 场景 5：新 plan/goal 激活本身即新任务运行 → 重置 per-run 标记。
// （先注入 normal；随后 /plan 激活→结束，plan 复盘仍允许注入。）
// ---------------------------------------------------------------------------
const actAgent = makeAgent("s-act");
await runTurnStopping(actAgent); // Normal 完成 → normal 复盘
check("激活前 normal 复盘已注入一次", memoryReviewMessages(actAgent).length === 1);
actAgent.session.events = [{ type: "plan/mode", data: { active: true } }];
await runTurnStopping(actAgent); // 观察 plan 激活（false→true → 新任务运行）
actAgent.session.events = [
  { type: "plan/mode", data: { active: true } },
  { type: "plan/mode", data: { active: false } },
];
await runTurnStopping(actAgent); // Plan 结束
check("新 plan 激活重置 per-run 标记后允许注入 plan 复盘", memoryReviewMessages(actAgent).length === 2);

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nREVIEW-DEDUP PROBE OK" : `\nREVIEW-DEDUP PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
