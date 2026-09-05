// round-display + kaz-system-prompt 探针（2026-08-28；v0.8 Step B1 移除 Plan/tool:goal 段；
// v0.9 36.7 白名单扩展：system-prompt/tool-surface；36.9 round-minimal 已删除）
// 覆盖：
//   ① kaz-system-prompt.mjs：system-prompt/assemble 后上报“真实系统提示词”
//     （persona + ka-whale-workflow 段；plan:policy 与 tool:goal 一律丢弃；"\n\n" 连接，
//     空段过滤；category=system-prompt）；
//   ② kaz-system-prompt.mjs：agent/pre-step 上报 goal-round-driver <goal_round>、
//      tool-goal <goal_complete>/<goal_blocked>；plan-mode 通知不再上报；
//      reject 的 step 不上报；
//   ③ round-display：list / history 内条目按 at 降序（新消息排上）+ 同轮去重；
//   ④ round-display：36.7 白名单显式接受 system-prompt/tool-surface，仍滤除 stage 噪音；
//   ⑤ round-display：不带 category 的旧上报按来源回退分类（kaz-system-prompt → system-prompt，
//      round-minimal 历史记录 → tool-surface/stable-boundary），噪音仍被过滤；
//   ⑥ kaz-mode：极简阶段 assemble 的工具面变化实际上报 category=tool-surface（无 round-minimal）。
// 运行：node KazPlugins/round-display/probe-round-display.mjs
import { apply as kspApply } from "file:///C:/Users/Kaczev/Documents/GitHub/dsh-KazMode/kaz/kaz-system-prompt.mjs";
import rdPlugin from "file:///C:/Users/Kaczev/.dsh/profiles/web/KazPlugins/round-display/lib/index.js";
import kazModePlugin from "file:///C:/Users/Kaczev/.dsh/profiles/web/KazPlugins/kaz-mode/lib/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KAZ_ROLE_PROMPTS } from "../kaz-shared/lib/tool-lists.js";

/** Kaz 5.0 Step1：kaz-system-prompt 恒为 DeepSeek 基础提示词（不再有短 persona 变体）。 */
const BASE_PROMPT = `You are a helpful software engineer assistant. **ALWAYS REASON AS 'WE'**. Maintain a calm, declarative tone.

Keep gray reasoning concise — use short, clear **ENGLISH**(IMPORTANT) sentences. If stuck or circling, report to the user and stop the work immediately.

The final white response should be crisp and to the point, and only appear after reasoning and working.`;

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

const TMP = mkdtempSync(join(tmpdir(), "rd-probe-"));

// ---------------------------------------------------------------------------
// 通用 mock ctx（仿 probe-kaz-mode.mjs）：on / effect / provide / get / inject
// ---------------------------------------------------------------------------
function makeMockCtx(extra = {}) {
  const listeners = new Map();
  const provided = { ...(extra.provided ?? {}) };
  const rpcHandlers = new Map();
  const settings = extra.settings ?? null;
  const agents = extra.agents ?? null;
  const connection = {
    rpc: {
      handle(channel, handler, _options) {
        rpcHandlers.set(channel, handler);
        return () => {
          rpcHandlers.delete(channel);
        };
      },
    },
  };
  const ctx = {
    fiber: { state: 0 },
    logger: { info: () => {}, warn: (...a) => console.log("[mock:warn]", ...a), debug: () => {} },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return () => {};
    },
    effect(fn) {
      const dispose = fn();
      return () => {
        if (typeof dispose === "function") dispose();
      };
    },
    provide(name, value) {
      provided[name] = value;
      return () => {
        delete provided[name];
      };
    },
    get(name) {
      if (name in provided) return provided[name];
      if (name === "settings") return settings;
      if (name === "agents") return agents;
      if (name === "connection") return connection;
      return undefined;
    },
    inject(deps, cb) {
      if (Array.isArray(deps) && deps.includes("settings") && settings !== null) {
        cb({ ...ctx, settings });
      }
    },
  };
  return { ctx, listeners, provided, rpcHandlers };
}

// ---------------------------------------------------------------------------
// mock settings（round-display 的 settings 命名空间需要）
// ---------------------------------------------------------------------------
function makeSettings() {
  const userSections = new Map();
  const bases = new Map();
  const watches = new Map();
  const resolve = (ns) => ({ ...(bases.get(ns) ?? {}), ...(userSections.get(ns) ?? {}) });
  return {
    register(ns, _schema, opts = {}) {
      bases.set(ns, opts.base ?? {});
      return {
        get: () => resolve(ns),
        watch: (cb) => {
          if (!watches.has(ns)) watches.set(ns, []);
          watches.get(ns).push(cb);
          return () => {};
        },
        update: (patch) => {
          userSections.set(ns, { ...(userSections.get(ns) ?? {}), ...patch });
          return Promise.resolve();
        },
        replace: (section) => {
          userSections.set(ns, { ...section });
          return Promise.resolve();
        },
      };
    },
    get: (ns) => resolve(ns),
    update(ns, patch) {
      userSections.set(ns, { ...(userSections.get(ns) ?? {}), ...patch });
      return Promise.resolve();
    },
    describe: () => [],
  };
}

// ---------------------------------------------------------------------------
// ① kaz-system-prompt.mjs：真实系统提示词上报
// ---------------------------------------------------------------------------
{
  const AGENT = { id: "s-kaz", session: { events: [] } };
  const kspReports = [];
  const mock = makeMockCtx({
    provided: {
      kazMode: { kazEnabled: () => true, pluginEnabled: () => false, toolVisible: () => true },
      goals: { get: (agent) => (agent === AGENT ? { phase: "active", objective: "x", maxGoalRounds: 256 } : undefined) },
      roundDisplay: { report: (p) => kspReports.push(p) },
      agents: { get: (id) => (id === AGENT.id ? AGENT : undefined) },
    },
  });
  kspApply(mock.ctx, {});

  // ①.a v0.8 Step B1：plan:policy / tool:goal 与其它提示段一律丢弃，只报 persona
  {
    const assemble = mock.listeners.get("system-prompt/assemble")[0];
    const assembly = {
      sections: [
        { name: "tool:goal", text: "GOAL_SECTION" },
        { name: "plan:policy", text: "PLAN_SECTION" },
        { name: "other:policy", text: "OTHER_SECTION" },
        { name: "deployment:persona", text: "ignored-persona" },
      ],
      contexts: [],
      variables: {},
    };
    const before = kspReports.length;
    const result = await assemble(assembly, { agent: AGENT }, async () => assembly);
    const reports = kspReports.slice(before);
    const systemReport = reports.find((r) => r.plugin === "kaz-system-prompt");
    check(
      "①.a plan/tool:goal/其它段被丢弃，真实 system 只有 persona",
      systemReport !== undefined && systemReport.content === BASE_PROMPT,
    );
    check("①.a systemReport 携带 category=system-prompt", systemReport?.category === "system-prompt");
    check("①.a assemble 返回值原样透传", result === assembly);
    check("①.a 过滤后 sections 只剩 persona", assembly.sections.length === 1 && assembly.sections[0].name === "deployment:persona");
  }

  // ①.b whale section：persona + ka-whale-workflow:prompt 都被保留
  {
    const assemble = mock.listeners.get("system-prompt/assemble")[0];
    const assembly = {
      sections: [
        { name: "ka-whale-workflow:prompt", text: "WHALE_SECTION" },
        { name: "deployment:persona", text: "ignored" },
      ],
      contexts: [],
      variables: {},
    };
    const before = kspReports.length;
    await assemble(assembly, { agent: AGENT }, async () => assembly);
    const reports = kspReports.slice(before);
    const systemReport = reports.find((r) => r.plugin === "kaz-system-prompt");
    check(
      "①.b2 保留 ka-whale-workflow 段（persona 最前）",
      systemReport !== undefined &&
        systemReport.content === BASE_PROMPT + "\n\nWHALE_SECTION" &&
        assembly.sections.length === 2 &&
        assembly.sections[0].name === "deployment:persona" &&
        assembly.sections[1].name === "ka-whale-workflow:prompt",
    );
  }

  // ①.b3 37.5 persona-application: ka-whale-workflow:main section carrying
  // current KAZ_ROLE_PROMPTS.main is preserved after the DeepSeek base persona.
  {
    const assemble = mock.listeners.get("system-prompt/assemble")[0];
    const assembly = {
      sections: [
        { name: "ka-whale-workflow:main", text: KAZ_ROLE_PROMPTS.main },
        { name: "deployment:persona", text: "ignored" },
      ],
      contexts: [],
      variables: {},
    };
    const before = kspReports.length;
    await assemble(assembly, { agent: AGENT }, async () => assembly);
    const reports = kspReports.slice(before);
    const systemReport = reports.find((r) => r.plugin === "kaz-system-prompt");
    check(
      "①.b3 37.5 真实 system = base persona + 当前 KAZ_ROLE_PROMPTS.main",
      systemReport !== undefined &&
        systemReport.content === BASE_PROMPT + "\n\n" + KAZ_ROLE_PROMPTS.main &&
        assembly.sections.length === 2 &&
        assembly.sections[0].name === "deployment:persona" &&
        assembly.sections[1].name === "ka-whale-workflow:main",
    );
  }

  // ①.b4 37.5 controlled subagents: request.persona role text is preserved,
  // not overwritten by the DeepSeek base persona.
  {
    const assemble = mock.listeners.get("system-prompt/assemble")[0];
    const subAgent = {
      id: "s-kaz-sub",
      options: { subagentDepth: 1 },
      session: {
        events: [{ type: "subagent/descriptor", data: {} }],
        header: { origin: "subagent", parentSession: "s-kaz", agentPreset: "kaz" },
      },
    };
    const assembly = {
      sections: [{ name: "deployment:persona", text: KAZ_ROLE_PROMPTS.subagent.worker }],
      contexts: [],
      variables: {},
    };
    await assemble(assembly, { agent: subAgent }, async () => assembly);
    check(
      "①.b4 受控子代理 request.persona 保留 KAZ_ROLE_PROMPTS.subagent.worker",
      assembly.sections.length === 1 &&
        assembly.sections[0].text === KAZ_ROLE_PROMPTS.subagent.worker,
    );
  }

  // ②.a v0.8 Step B1：plan-mode 通知不再上报（原生 Plan 已移除）
  {
    const preStep = mock.listeners.get("agent/pre-step")[0];
    const notice = {
      role: "user",
      content: [{ type: "text", text: "The user switched this session to plan mode." }],
      source: { kind: "plugin", plugin: "plan-mode", form: "notice", summary: "The user switched this session to plan mode." },
    };
    const decision = { kind: "enter", messages: [notice] };
    const before = kspReports.length;
    const returned = await preStep({ agent: AGENT }, async () => decision);
    const reports = kspReports.slice(before);
    const noticeReport = reports.find((r) => r.plugin === "plan-mode");
    check("②.a pre-step 不再上报 plan-mode 通知", noticeReport === undefined);
    check("②.a pre-step 返回值原样透传", returned === decision);
  }

  // ②.b pre-step：reject 不上报（用 goal 消息验证兜底仍生效）
  {
    const preStep = mock.listeners.get("agent/pre-step")[0];
    const notice = {
      role: "user",
      content: [{ type: "text", text: "<goal_round>stale</goal_round>" }],
      source: { kind: "goal", goalId: "g1", revision: 1, round: 1 },
    };
    const before = kspReports.length;
    await preStep({ agent: AGENT }, async () => ({ kind: "reject", messages: [notice] }));
    check("②.b pre-step reject 不上报", kspReports.length === before);
  }

  // ②.c v0.8 Step B1：旧 plan/mode 状态事件不再合成 plan-mode 通知
  {
    const preStep = mock.listeners.get("agent/pre-step")[0];
    const resumeAgent = { id: "s-kaz-resume", session: { events: [{ type: "plan/mode", seq: 1, time: 1, data: { active: true } }] } };
    const before = kspReports.length;
    await preStep({ agent: resumeAgent }, async () => ({ kind: "enter", messages: [] }));
    const reports = kspReports.slice(before);
    check("②.c 旧 plan/mode 事件不再上报", reports.every((r) => r.plugin !== "plan-mode"));
  }

  // ①.c v0.8 Step B1：即使 goal 模式开启，tool:goal 段也不再保留/替换
  {
    const assemble = mock.listeners.get("system-prompt/assemble")[0];
    const assembly = {
      sections: [
        { name: "tool:goal", text: "GOAL_SECTION" },
        { name: "deployment:persona", text: "ignored" },
      ],
      contexts: [],
      variables: {},
    };
    const before = kspReports.length;
    await assemble(assembly, { agent: AGENT }, async () => assembly);
    const reports = kspReports.slice(before);
    const systemReport = reports.find((r) => r.plugin === "kaz-system-prompt");
    check("①.c goal 模式开启时 tool:goal 仍被丢弃", systemReport !== undefined && systemReport.content === BASE_PROMPT);
    check("①.c 过滤后 sections 只剩 persona", assembly.sections.length === 1 && assembly.sections[0].name === "deployment:persona");
  }

  // ①.d v0.8 Step B1：plan:policy 即使存在也不保留
  {
    const assemble = mock.listeners.get("system-prompt/assemble")[0];
    const assembly = {
      sections: [
        { name: "tool:goal", text: "GOAL_SECTION" },
        { name: "plan:policy", text: "PLAN_SECTION" },
        { name: "deployment:persona", text: "ignored" },
      ],
      contexts: [],
      variables: {},
    };
    const before = kspReports.length;
    await assemble(assembly, { agent: AGENT }, async () => assembly);
    const reports = kspReports.slice(before);
    const systemReport = reports.find((r) => r.plugin === "kaz-system-prompt");
    check("①.d plan + tool:goal 都被丢弃，真实 system 只有 persona", systemReport !== undefined && systemReport.content === BASE_PROMPT);
    check("①.d 过滤后 sections 只剩 persona", assembly.sections.length === 1 && assembly.sections[0].name === "deployment:persona");
  }

  // ②.d pre-step：goal-round-driver 的 <goal_round> 上报
  {
    const preStep = mock.listeners.get("agent/pre-step")[0];
    const roundMessage = {
      role: "user",
      content: [{ type: "text", text: "<goal_round>\nObjective: \"x\"\nRound: 1/3\n</goal_round>" }],
      source: { kind: "goal", goalId: "g1", revision: 1, round: 1 },
    };
    const decision = { kind: "enter", messages: [roundMessage] };
    const before = kspReports.length;
    const returned = await preStep({ agent: AGENT }, async () => decision);
    const reports = kspReports.slice(before);
    const goalReport = reports.find((r) => r.plugin === "goal-round-driver");
    check("②.d pre-step 上报 goal_round", goalReport !== undefined && goalReport.content.includes("<goal_round>"));
    check("②.d pre-step 返回值原样透传", returned === decision);
  }

  // ②.e pre-step：tool-goal 的 <goal_complete> wrapup 上报
  {
    const preStep = mock.listeners.get("agent/pre-step")[0];
    const wrapup = {
      role: "user",
      content: [{ type: "text", text: "<goal_complete>\nObjective: \"x\"\n</goal_complete>" }],
      source: { kind: "plugin", plugin: "tool-goal", form: "notice", summary: "complete: x" },
    };
    const decision = { kind: "enter", messages: [wrapup] };
    const before = kspReports.length;
    await preStep({ agent: AGENT }, async () => decision);
    const reports = kspReports.slice(before);
    const wrapReport = reports.find((r) => r.plugin === "tool-goal");
    check("②.e pre-step 上报 tool-goal wrapup", wrapReport !== undefined && wrapReport.content.includes("<goal_complete>"));
  }

  // ②.h pre-step：goal round 被 reject 的 step 不上报
  {
    const preStep = mock.listeners.get("agent/pre-step")[0];
    const roundMessage = {
      role: "user",
      content: [{ type: "text", text: "<goal_round>stale</goal_round>" }],
      source: { kind: "goal", goalId: "g1", revision: 1, round: 3 },
    };
    const before = kspReports.length;
    await preStep({ agent: AGENT }, async () => ({ kind: "reject", messages: [roundMessage] }));
    check("②.h pre-step reject 不上报 goal_round", kspReports.length === before);
  }
}

// ---------------------------------------------------------------------------
// ③ round-display：新消息排上（at 降序）+ 同轮去重
// ---------------------------------------------------------------------------
{
  const AGENT_RD = { id: "s-rd", session: { events: [{ type: "turn/start", data: { turn: 1 } }] } };
  const settings = makeSettings();
  const recordsStore = join(TMP, "round-display-records.json");
  const mock = makeMockCtx({
    settings,
    agents: { get: (id) => (id === AGENT_RD.id ? AGENT_RD : undefined) },
    provided: {},
  });
  rdPlugin.apply(mock.ctx, { enabled: true, recordsStore });

  const rd = mock.provided["roundDisplay"];
  check("③ roundDisplay 上报服务已提供", rd !== undefined && typeof rd.report === "function");
  const rpc = mock.rpcHandlers.get("/round-display");
  check("③ /round-display RPC 通道已注册", typeof rpc === "function");

  // 用递增 Date.now 保证 at 严格有序（first < second < third）。
  // v0.9 B6：generic 排序/去重测试使用白名单类别 subagent-report。
  const realNow = Date.now;
  let nowTick = 1000000;
  Date.now = () => nowTick++;
  try {
    rd.report({ agent: AGENT_RD, plugin: "a", category: "subagent-report", title: "", content: "first" });
    rd.report({ agent: AGENT_RD, plugin: "b", category: "subagent-report", title: "", content: "second" });
    rd.report({ agent: AGENT_RD, plugin: "a", category: "subagent-report", title: "", content: "third" });
    // 同轮去重：与 "a|third" 相同（同类别同内容）的上报应被忽略。
    rd.report({ agent: AGENT_RD, plugin: "a", category: "subagent-report", title: "", content: "third" });
    // 非白名单类别应被过滤，不进列表。
    rd.report({ agent: AGENT_RD, plugin: "noise", category: "stage-switch", title: "", content: "noise" });
  } finally {
    Date.now = realNow;
  }

  const listRes = await rpc("list", { sessionId: AGENT_RD.id });
  check("③ list 返回 ok 且轮次为 1", listRes !== null && listRes.ok === true && listRes.value.turn === 1);
  const listContents = Array.isArray(listRes?.value?.entries) ? listRes.value.entries.map((e) => e.content) : [];
  check("③ list 条目新消息排上（third, second, first）", JSON.stringify(listContents) === JSON.stringify(["third", "second", "first"]));
  check("③ list 同轮去重（仅 3 条）", listContents.length === 3);

  const historyRes = await rpc("history", { sessionId: AGENT_RD.id });
  const turns = Array.isArray(historyRes?.value?.turns) ? historyRes.value.turns : [];
  const turnContents = turns.length > 0 && Array.isArray(turns[0].entries) ? turns[0].entries.map((e) => e.content) : [];
  check("③ history 轮内条目新消息排上", JSON.stringify(turnContents) === JSON.stringify(["third", "second", "first"]));
}

// ---------------------------------------------------------------------------
// ③.b 37.5：round-display 接受 session-shaped child（live agent 已释放时，
//  通过 sessions 服务回退）；child 页面 list 能显示自己的 subagent-report 摘要。
// ---------------------------------------------------------------------------
{
  const AGENT_CHILD_SESSION = {
    id: "s-rd-child-session",
    events: [{ type: "turn/start", data: { turn: 1 } }],
  };
  const settings = makeSettings();
  const recordsStore = join(TMP, "round-display-records-child-session.json");
  const mock = makeMockCtx({
    settings,
    agents: null,
    provided: {
      sessions: { get: (id) => (id === AGENT_CHILD_SESSION.id ? AGENT_CHILD_SESSION : undefined) },
    },
  });
  rdPlugin.apply(mock.ctx, { enabled: true, recordsStore });
  const rd = mock.provided["roundDisplay"];
  const rpc = mock.rpcHandlers.get("/round-display");
  rd.report({
    agent: AGENT_CHILD_SESSION,
    plugin: "ka-whale-workflow",
    category: "subagent-report",
    title: "子代理汇报",
    content: "child session own report summary",
  });
  const listRes = await rpc("list", { sessionId: AGENT_CHILD_SESSION.id });
  const listEntries = Array.isArray(listRes?.value?.entries) ? listRes.value.entries : [];
  check(
    "③.b session-shaped child 记录可由 child 页面 list 读取",
    listRes?.ok === true &&
      listRes?.value?.turn === 1 &&
      listEntries.length === 1 &&
      listEntries[0].content === "child session own report summary" &&
      listEntries[0].category === "subagent-report",
  );
}

// ---------------------------------------------------------------------------
// ③.c 37.5：child agent 销毁后 round-display 仍保留 child 自己的汇报记录。
// ---------------------------------------------------------------------------
{
  const childAgentForDispose = {
    id: "s-rd-child-disposed",
    options: { subagentDepth: 1 },
    session: {
      id: "s-rd-child-disposed",
      events: [{ type: "turn/start", data: { turn: 1 } }],
      header: { origin: "subagent", parentSession: "s-parent" },
    },
  };
  const settings = makeSettings();
  const recordsStore = join(TMP, "round-display-records-child-disposed.json");
  const mock = makeMockCtx({
    settings,
    agents: null,
    provided: {
      sessions: { get: (id) => (id === childAgentForDispose.id ? childAgentForDispose : undefined) },
    },
  });
  rdPlugin.apply(mock.ctx, { enabled: true, recordsStore });
  const rd = mock.provided["roundDisplay"];
  const rpc = mock.rpcHandlers.get("/round-display");
  rd.report({
    agent: childAgentForDispose,
    plugin: "ka-whale-workflow",
    category: "subagent-report",
    title: "子代理汇报",
    content: "child report after disposal still visible",
  });
  const disposeListener = mock.listeners.get("agent/disposed")?.[0];
  check("③.c round-display 注册了 agent/disposed 清理", typeof disposeListener === "function");
  disposeListener?.({ agent: childAgentForDispose });
  const listRes = await rpc("list", { sessionId: childAgentForDispose.id });
  const listEntries = Array.isArray(listRes?.value?.entries) ? listRes.value.entries : [];
  check(
    "③.c child agent 销毁不删除自身 subagent-report 记录",
    listRes?.ok === true &&
      listEntries.length === 1 &&
      listEntries[0].content === "child report after disposal still visible",
  );
}

// ---------------------------------------------------------------------------
// ④ round-display：v0.9 36.7 白名单（R-B6-2）——显式接受 system-prompt /
//    tool-surface / goal-context；同轮不同内容保留 + 重复去重；stage 噪音仍滤除。
// ---------------------------------------------------------------------------
{
  const AGENT_SYS = { id: "s-rd-sys", session: { events: [{ type: "turn/start", data: { turn: 1 } }] } };
  const settings = makeSettings();
  const recordsStore = join(TMP, "round-display-records-system.json");
  const mock = makeMockCtx({
    settings,
    agents: { get: (id) => (id === AGENT_SYS.id ? AGENT_SYS : undefined) },
    provided: {},
  });
  rdPlugin.apply(mock.ctx, { enabled: true, recordsStore });

  const rd = mock.provided["roundDisplay"];
  const rpc = mock.rpcHandlers.get("/round-display");
  const realNow = Date.now;
  let nowTick = 2000000;
  Date.now = () => nowTick++;
  const toolSurfaceContent = "工具面变化（来自 system-prompt/assemble）\n极简阶段（首次工具调用前）\n- 当前工具（1）：memory_search\n- 移除（19）：...\n+ 新增（1）：memory_search";
  try {
    // 36.7 白名单：真实 system 提示词快照、工具面变化都展示。
    rd.report({ agent: AGENT_SYS, plugin: "kaz-system-prompt", title: "system prompt", category: "system-prompt", content: "assess-complexity prompt" });
    rd.report({ agent: AGENT_SYS, plugin: "kaz-system-prompt", title: "system prompt", category: "system-prompt", content: "working prompt" });
    rd.report({ agent: AGENT_SYS, plugin: "round-minimal", title: "本轮工具变化", category: "tool-surface", content: toolSurfaceContent });
    // 白名单：Goal 上下文通知（同一轮不同内容应都保留；重复只留一条）。
    rd.report({ agent: AGENT_SYS, plugin: "goal-round-driver", title: "goal round", content: "<goal_round>round-1</goal_round>" });
    rd.report({ agent: AGENT_SYS, plugin: "tool-goal", title: "goal wrapup", content: "<goal_complete>done</goal_complete>" });
    rd.report({ agent: AGENT_SYS, plugin: "tool-goal", title: "goal wrapup", content: "<goal_complete>done</goal_complete>" });
    // 非白名单：stage/whale_report 噪音仍被过滤。
    rd.report({ agent: AGENT_SYS, plugin: "ka-whale-workflow", title: "stage-switch", category: "stage-switch", content: "whale_report: working -> communication" });
  } finally {
    Date.now = realNow;
  }

  const listRes = await rpc("list", { sessionId: AGENT_SYS.id });
  const listEntries = Array.isArray(listRes?.value?.entries) ? listRes.value.entries : [];
  const listContents = listEntries.map((e) => e.content);
  const listCategories = listEntries.map((e) => e.category);
  check(
    "④ 36.7 白名单接受 system-prompt/tool-surface + Goal，且同轮去重（新在上）",
    listEntries.length === 5 &&
      JSON.stringify(listContents) ===
        JSON.stringify([
          "<goal_complete>done</goal_complete>",
          "<goal_round>round-1</goal_round>",
          toolSurfaceContent,
          "working prompt",
          "assess-complexity prompt",
        ]),
  );
  check(
    "④ 类别为 system-prompt/tool-surface/goal-context，无 stage 噪音",
    listCategories.includes("system-prompt") &&
      listCategories.includes("tool-surface") &&
      listCategories.filter((c) => c === "goal-context").length === 2 &&
      !listContents.some((c) => c.includes("whale_report")),
  );
}

// ---------------------------------------------------------------------------
// ⑤ round-display：旧/未带 category 的上报按“注入源分类”兼容进白名单；
//    36.7：kaz-system-prompt → system-prompt，round-minimal 工具变化 →
//    tool-surface（旧“恢复全量”仍归 stable-boundary）；
//    记忆指引、阶段切换、first-round guidance 等非白名单内容被过滤。
// ---------------------------------------------------------------------------
{
  const AGENT_LEGACY = { id: "s-rd-legacy", session: { events: [{ type: "turn/start", data: { turn: 1 } }] } };
  const settings = makeSettings();
  const recordsStore = join(TMP, "round-display-records-legacy.json");
  const mock = makeMockCtx({
    settings,
    agents: { get: (id) => (id === AGENT_LEGACY.id ? AGENT_LEGACY : undefined) },
    provided: {},
  });
  rdPlugin.apply(mock.ctx, { enabled: true, recordsStore });

  const rd = mock.provided["roundDisplay"];
  const rpc = mock.rpcHandlers.get("/round-display");
  const realNow = Date.now;
  let nowTick = 3000000;
  Date.now = () => nowTick++;
  try {
    // 白名单兼容识别（不带 category）：
    rd.report({ agent: AGENT_LEGACY, plugin: "ka-whale-memory", title: "guidance", content: "[ka-whale-memory Auto-Load]\n>\n- id: 1 | summary: s\n<" });
    rd.report({ agent: AGENT_LEGACY, plugin: "ka-whale-workflow", title: "阶段 goal-active", content: "[ka-whale-workflow goal-active]\n>\nMode: Goal is active\n<" });
    rd.report({ agent: AGENT_LEGACY, plugin: "round-minimal", title: "本轮工具变化", content: "工具面变化\n恢复全量（首次工具调用后）\n- 当前工具（19）…" });
    rd.report({ agent: AGENT_LEGACY, plugin: "round-minimal", title: "本轮工具变化", content: "工具面变化\n工具面变化\n- 当前工具（1）：memory_search\n- 移除（19）：…\n+ 新增（1）：memory_search" });
    rd.report({ agent: AGENT_LEGACY, plugin: "kaz-system-prompt", title: "system prompt", content: "real prompt" });
    // 非白名单噪音（不带 category）应被过滤：
    rd.report({ agent: AGENT_LEGACY, plugin: "ka-whale-memory", title: "guidance", content: "[ka-whale-memory guidance]\n>\nWe need to search memory\n<" });
    rd.report({ agent: AGENT_LEGACY, plugin: "ka-whale-workflow", title: "阶段切换", content: "whale_report：working → communication" });
    rd.report({ agent: AGENT_LEGACY, plugin: "round-minimal", title: "guidance", content: "[round-minimal guidance]\n>\nfirst round\n<" });
  } finally {
    Date.now = realNow;
  }

  const listRes = await rpc("list", { sessionId: AGENT_LEGACY.id });
  const listEntries = Array.isArray(listRes?.value?.entries) ? listRes.value.entries : [];
  const categories = listEntries.map((e) => e.category);
  const contents = listEntries.map((e) => e.content);
  check(
    "⑤ 旧上报按来源分类进白名单（system-prompt/tool-surface/stable-boundary/memory-snapshot/goal-context），噪音被过滤",
    listEntries.length === 5 &&
      categories.includes("memory-snapshot") &&
      categories.includes("goal-context") &&
      categories.includes("stable-boundary") &&
      categories.includes("tool-surface") &&
      categories.includes("system-prompt") &&
      !contents.some((c) => c.includes("memory guidance")) &&
      !contents.some((c) => c.includes("whale_report")),
  );
  check("⑤ kaz-system-prompt 旧上报回退为 system-prompt", contents.includes("real prompt"));
  check(
    "⑤ round-minimal 非恢复工具变化回退为 tool-surface",
    categories.includes("tool-surface"),
  );
}

// ---------------------------------------------------------------------------
// ⑥ kaz-mode 运行时（36.9）：首次极简阶段 assemble 产生工具面变化时，
//    上报 payload 必须携带 category=tool-surface（不依赖 round-minimal 插件）。
// ---------------------------------------------------------------------------
{
  const AGENT_KZM = {
    id: "s-rd-kzm",
    session: {
      header: { id: "s-rd-kzm", cwd: join(TMP, "kzm-project"), agentPreset: "kaz" },
      events: [],
    },
  };
  const settings = makeSettings();
  const kzmReports = [];
  const kzmMock = makeMockCtx({
    settings,
    agents: { get: (id) => (id === AGENT_KZM.id ? AGENT_KZM : undefined) },
    provided: {
      roundDisplay: { report: (payload) => kzmReports.push(payload) },
    },
  });
  kazModePlugin.apply(kzmMock.ctx, { enabled: true, storageDir: join(TMP, "kaz-storage") });

  const assemble = kzmMock.listeners.get("system-prompt/assemble")[0];
  const assembly = {
    tools: [{ name: "read" }, { name: "write" }, { name: "memory_search" }],
    sections: [],
  };
  const beforeCount = kzmReports.length;
  await assemble(assembly, { agent: AGENT_KZM }, async () => assembly);
  const toolSurfaceReports = kzmReports
    .slice(beforeCount)
    .filter((payload) => payload?.plugin === "kaz-mode" && payload?.title === "本轮工具变化");
  check(
    "⑥ kaz-mode 极简工具面变化上报 category=tool-surface（无 round-minimal）",
    toolSurfaceReports.length > 0 && toolSurfaceReports.every((payload) => payload.category === "tool-surface"),
  );
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nROUND-DISPLAY PROBE OK" : `\nROUND-DISPLAY PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
