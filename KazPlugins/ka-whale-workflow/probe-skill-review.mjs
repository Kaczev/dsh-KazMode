// ka-whale-workflow 技能自省探针：skill-review 与 [kaz-memory Review] 同一批安全边界，
// 独立 form / 独立 per-session per-kind 去重；受 skillAutonomyEnabled 与
// skillLifecycleCallable 守卫；验证设置默认值。
// 运行：node KazPlugins/ka-whale-workflow/probe-skill-review.mjs
import plugin, { DEFAULT_RECONSTRUCTION_TOOLS, DEFAULT_SECTION, createStageStore } from "./lib/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

check("DEFAULT_SECTION.skillAutonomyEnabled 默认 true", DEFAULT_SECTION?.skillAutonomyEnabled === true);
check("DEFAULT_SECTION.skillAutonomyMaxChangesPerBoundary 默认 1", DEFAULT_SECTION?.skillAutonomyMaxChangesPerBoundary === 1);

const TMP = mkdtempSync(join(tmpdir(), "whale-skill-review-"));
const STORE_FILE = join(TMP, "ka-whale-workflow-stage.json");
const store = createStageStore(STORE_FILE);
for (const id of ["s-normal", "s-plan", "s-goal", "s-nocall", "s-off", "s-dedup"]) {
  store.set(id, "done");
}

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

function sessionIdOfAgent(agent) {
  return agent?.session?.id || agent?.id || "";
}

const mockKazMode = {
  pluginConfig: (agent) => {
    const id = sessionIdOfAgent(agent);
    const baseCfg = { enabled: true, includeSubagents: false, reconstructionTools: [...DEFAULT_RECONSTRUCTION_TOOLS] };
    return id === "s-off" ? { ...baseCfg, skillAutonomyEnabled: false } : baseCfg;
  },
  toolVisible: (agent, _name) => {
    const id = sessionIdOfAgent(agent);
    return id !== "s-nocall";
  },
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

await plugin.apply(base, { stageStore: STORE_FILE });
await new Promise((resolve) => setTimeout(resolve, 20));

const turnStoppingHandlers = listeners.get("agent/turn-stopping") ?? [];

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

function skillMessages(agent) {
  return agent.messages.filter(
    (m) => m?.source?.kind === "plugin" && m?.source?.plugin === "ka-whale-workflow" && m?.source?.form === "skill-review",
  );
}

// Normal 完成：注入独立 skill-review；memory review 与 skill review 同时存在且互不混用。
const normalAgent = makeAgent("s-normal");
await runTurnStopping(normalAgent);
const normalSkills = skillMessages(normalAgent);
check("Normal 完成注入 skill-review", normalSkills.length === 1 && textOf(normalSkills[0]).includes("[skill Review]"));
check("skill-review 文本含 normal 语义", textOf(normalSkills[0]).includes("The task has completed."));
check("skill-review 注入真实私有路径 KazPrivatePlugins", textOf(normalSkills[0]).includes("KazPrivatePlugins"));
check("skill-review 文本不含 project process folder", !textOf(normalSkills[0]).includes("project process folder"));
check("skill-review Create 要求完整生命周期", textOf(normalSkills[0]).includes("one full skill lifecycle") && textOf(normalSkills[0]).includes("one Create = full lifecycle"));
check("skill-review justified 判定明确", textOf(normalSkills[0]).includes("Create is justified only when") && textOf(normalSkills[0]).includes("executable module + offline probe"));
check("skill-review runbook 只写 memory", textOf(normalSkills[0]).includes("Pure knowledge/runbook/config procedures") && textOf(normalSkills[0]).includes("write memory only"));
check("skill-review CANDIDATE-only 不完成/不消耗预算", textOf(normalSkills[0]).includes("CANDIDATE-only") && textOf(normalSkills[0]).includes("does NOT complete self-update") && textOf(normalSkills[0]).includes("does not consume"));
check("skill-review 与 [kaz-memory Review] 独立共存", normalAgent.messages.some((m) => m?.source?.form === "review" && textOf(m).includes("[kaz-memory Review]")) && normalSkills.every((m) => !textOf(m).includes("[kaz-memory Review]")));
await runTurnStopping(normalAgent);
check("同一 session 不重复注入 normal skill-review", skillMessages(normalAgent).length === 1);

// Plan 结束：注入 plan skill-review。
const planAgent = makeAgent("s-plan");
planAgent.session.events = [{ type: "plan/mode", data: { active: true } }];
await runTurnStopping(planAgent);
planAgent.session.events = [
  { type: "plan/mode", data: { active: true } },
  { type: "plan/mode", data: { active: false } },
];
await runTurnStopping(planAgent);
const planSkills = skillMessages(planAgent);
check("Plan 结束注入 plan skill-review", planSkills.length === 1 && textOf(planSkills[0]).includes("The Plan has ended."));

// Goal 结束：注入 goal skill-review。
const goalAgent = makeAgent("s-goal");
goalActiveFlag = true;
await runTurnStopping(goalAgent);
goalActiveFlag = false;
await runTurnStopping(goalAgent);
const goalSkills = skillMessages(goalAgent);
check("Goal 结束注入 goal skill-review", goalSkills.length === 1 && textOf(goalSkills[0]).includes("The Goal has ended."));

// task-run 去重：Plan 结束已注入 → 同一逻辑任务的 Normal 完成不得二次注入。
const dedupAgent = makeAgent("s-dedup");
dedupAgent.session.events = [{ type: "plan/mode", data: { active: true } }];
await runTurnStopping(dedupAgent); // 观察 plan 激活（新逻辑任务运行）
dedupAgent.session.events = [
  { type: "plan/mode", data: { active: true } },
  { type: "plan/mode", data: { active: false } },
];
await runTurnStopping(dedupAgent); // Plan 结束 → 注入 plan skill-review
check("Plan 结束注入一次 plan skill-review", skillMessages(dedupAgent).length === 1 && textOf(skillMessages(dedupAgent)[0]).includes("The Plan has ended."));
await runTurnStopping(dedupAgent); // 同任务再次到 done（Normal 完成）
const dedupSkills = skillMessages(dedupAgent);
check(
  "同任务 Normal 完成不再注入第二条 skill-review（task-run 去重）",
  dedupSkills.length === 1 && !textOf(dedupSkills[0]).includes("The task has completed."),
);

// 可用性守卫：技能闭环工具不可见 → 不注入 skill-review。
const noCallAgent = makeAgent("s-nocall");
await runTurnStopping(noCallAgent);
check("skillLifecycleCallable 为 false 时不注入 skill-review", skillMessages(noCallAgent).length === 0);

// 开关守卫：skillAutonomyEnabled=false → 不注入 skill-review。
const offAgent = makeAgent("s-off");
await runTurnStopping(offAgent);
check("skillAutonomyEnabled=false 时不注入 skill-review", skillMessages(offAgent).length === 0);

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nSKILL-REVIEW PROBE OK" : `\nSKILL-REVIEW PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
