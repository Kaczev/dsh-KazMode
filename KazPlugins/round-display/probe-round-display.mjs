// round-display + kaz-system-prompt 探针（2026-08-28，Kaz 适配 Plan 模式；追加 Goal）
// 覆盖：
//   ① kaz-system-prompt.mjs：system-prompt/assemble 后上报“真实系统提示词”
//     （persona + plan:policy，goal 模式开启时再加自定义 tool:goal，"\n\n" 连接，空段过滤）；
//   ② kaz-system-prompt.mjs：agent/pre-step 上报 plan-mode 通知、goal-round-driver
//      <goal_round>、tool-goal <goal_complete>/<goal_blocked>；reject 的 step 不上报；
//      plan/mode 状态事件由 pre-step 扫描 agent.session.events 合成通知
//      （session/event 在 agent scope 收不到，故不走该通道）；
//   ③ round-display：list / history 内条目按 at 降序（新消息排上）+ 同轮去重。
// 运行：node KazPlugins/round-display/probe-round-display.mjs
import { apply as kspApply } from "file:///C:/Users/Kaczev/Documents/GitHub/dsh-KazMode/kaz/kaz-system-prompt.mjs";
import rdPlugin from "file:///C:/Users/Kaczev/Documents/GitHub/dsh-KazMode/KazPlugins/round-display/lib/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  // ①.a plan 激活：persona + plan:policy → 真实 system = persona 在最前，plan 段随后
  {
    const assemble = mock.listeners.get("system-prompt/assemble")[0];
    const assembly = {
      sections: [
        { name: "plan:policy", text: "PLAN_SECTION" },
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
      "①.a assemble 上报真实系统提示词（persona 在最前，plan 段随后，\\n\\n 连接）",
      systemReport !== undefined &&
        systemReport.content === "You are a helpful software engineer assistant.\n\nPLAN_SECTION",
    );
    check("①.a assemble 返回值原样透传", result === assembly);
    check("①.a 过滤后 sections 只剩 persona + plan", assembly.sections.length === 2 && assembly.sections[0].name === "deployment:persona" && assembly.sections[1].name === "plan:policy");
  }

  // ①.b plan 未激活（plan 段为空）：只报 persona
  {
    const assemble = mock.listeners.get("system-prompt/assemble")[0];
    const assembly = {
      sections: [
        { name: "plan:policy", text: "" },
        { name: "deployment:persona", text: "ignored" },
      ],
      contexts: [],
      variables: {},
    };
    const before = kspReports.length;
    await assemble(assembly, { agent: AGENT }, async () => assembly);
    const reports = kspReports.slice(before);
    const systemReport = reports.find((r) => r.plugin === "kaz-system-prompt");
    check("①.b plan 空段被过滤，只报 persona", systemReport !== undefined && systemReport.content === "You are a helpful software engineer assistant.");
  }

  // ①.b2 whale section：persona + ka-whale-workflow:prompt 都被保留
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
        systemReport.content === "You are a helpful software engineer assistant.\n\nWHALE_SECTION" &&
        assembly.sections.length === 2 &&
        assembly.sections[0].name === "deployment:persona" &&
        assembly.sections[1].name === "ka-whale-workflow:prompt",
    );
  }

  // ②.a pre-step：plan-mode 进入通知上报
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
    check("②.a pre-step 上报 plan-mode 进入通知", noticeReport !== undefined && noticeReport.content === "The user switched this session to plan mode.");
    check("②.a pre-step 返回值原样透传", returned === decision);
  }

  // ②.b pre-step：reject 不上报
  {
    const preStep = mock.listeners.get("agent/pre-step")[0];
    const notice = {
      role: "user",
      content: [{ type: "text", text: "The user switched this session to plan mode." }],
      source: { kind: "plugin", plugin: "plan-mode", form: "notice" },
    };
    const before = kspReports.length;
    await preStep({ agent: AGENT }, async () => ({ kind: "reject", messages: [notice] }));
    check("②.b pre-step reject 不上报", kspReports.length === before);
  }

  // ②.c pre-step 扫描 plan/mode 状态事件：本轮新增进入 → 合成通知
  //   （dsh-plan-mode 在“首条消息前进入”和 exit_plan_mode 退出时都不产生
  //    source.plugin === "plan-mode" 的消息，必须由状态事件兜底）
  {
    const preStep = mock.listeners.get("agent/pre-step")[0];
    const events = AGENT.session.events;
    events.push({ type: "plan/mode", seq: 1, time: Date.now(), data: { active: true } });
    const decision = { kind: "enter", messages: [] };
    const before = kspReports.length;
    await preStep({ agent: AGENT }, async () => decision);
    const reports = kspReports.slice(before);
    const noticeReport = reports.find((r) => r.plugin === "plan-mode");
    check("②.c pre-step 扫描 plan/mode 进入事件合成通知", noticeReport !== undefined && noticeReport.content === "The user switched this session to plan mode.");
  }

  // ②.c2 pre-step：同一 plan/mode 不重复上报；新退出事件再上报
  {
    const preStep = mock.listeners.get("agent/pre-step")[0];
    const events = AGENT.session.events;
    const before = kspReports.length;
    await preStep({ agent: AGENT }, async () => ({ kind: "enter", messages: [] }));
    check("②.c2 同一 plan/mode 不重复上报", kspReports.length === before);

    events.push({ type: "plan/mode", seq: 2, time: Date.now(), data: { active: false } });
    const before2 = kspReports.length;
    await preStep({ agent: AGENT }, async () => ({ kind: "enter", messages: [] }));
    const reports = kspReports.slice(before2);
    const noticeReport = reports.find((r) => r.plugin === "plan-mode");
    check("②.c2 pre-step 扫描 plan/mode 退出事件合成通知", noticeReport !== undefined && noticeReport.content === "The user switched this session back to the default mode.");
  }

  // ②.c3 pre-step：插件加载前已存在的旧 plan/mode 事件不补报（resume 基线）
  //   用全新 agent id，确保 lastPlanModeSeq 从 -1 开始，真正走 time < startedAt 分支。
  {
    const preStep = mock.listeners.get("agent/pre-step")[0];
    const resumeAgent = { id: "s-kaz-resume", session: { events: [] } };
    resumeAgent.session.events.push({ type: "plan/mode", seq: 1, time: 1, data: { active: true } });
    const before = kspReports.length;
    await preStep({ agent: resumeAgent }, async () => ({ kind: "enter", messages: [] }));
    check("②.c3 插件加载前的旧 plan/mode 不补报", kspReports.length === before);
    // 基线已推进：即使再来一次也不补报。
    const before2 = kspReports.length;
    await preStep({ agent: resumeAgent }, async () => ({ kind: "enter", messages: [] }));
    check("②.c3 旧事件基线已推进，不重复补报", kspReports.length === before2);
  }

  // ①.c goal 模式开启（目标 active + update_goal 可见）时保留 tool:goal 段，
  //     并替换为 Kaz 自定义文本：persona + tool:goal
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
    check(
      "①.c goal 模式开启时保留自定义 tool:goal 段（persona 在最前）",
      systemReport !== undefined &&
        systemReport.content.startsWith("You are a helpful software engineer assistant.\n\n") &&
        systemReport.content.includes("We are in goal mode.") &&
        systemReport.content.includes("at least 3 consecutive goal rounds") &&
        systemReport.content.includes("If the goal is blocked, stay in goal mode"),
    );
    check(
      "①.c 过滤后 sections 只剩 persona + tool:goal",
      assembly.sections.length === 2 &&
        assembly.sections[0].name === "deployment:persona" &&
        assembly.sections[1].name === "tool:goal",
    );
    check("①.c tool:goal 文本已替换为 Kaz 自定义版", assembly.sections[1].text.includes("We are in goal mode."));
  }

  // ①.d goal 模式开启 + plan + tool:goal 同时存在：persona → plan:policy → tool:goal
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
    check(
      "①.d goal 模式开启时 plan + tool:goal 真实 system = persona + plan + 自定义 tool:goal",
      systemReport !== undefined &&
        systemReport.content.startsWith("You are a helpful software engineer assistant.\n\nPLAN_SECTION\n\n") &&
        systemReport.content.includes("We are in goal mode."),
    );
    check(
      "①.d 过滤后 sections 顺序 persona → plan:policy → tool:goal",
      assembly.sections.length === 3 &&
        assembly.sections[0].name === "deployment:persona" &&
        assembly.sections[1].name === "plan:policy" &&
        assembly.sections[2].name === "tool:goal",
    );
  }

  // ①.e goal 模式未开启（update_goal 不可见 / 无目标）：tool:goal 段被丢弃（即使官方 section 存在）
  {
    const OFF_AGENT = { id: "s-kaz-goal-off", session: { events: [] } };
    const offReports = [];
    const offMock = makeMockCtx({
      provided: {
        kazMode: { kazEnabled: () => true, pluginEnabled: () => false, toolVisible: () => false },
        roundDisplay: { report: (p) => offReports.push(p) },
        agents: { get: (id) => (id === OFF_AGENT.id ? OFF_AGENT : undefined) },
      },
    });
    kspApply(offMock.ctx, {});
    const assemble = offMock.listeners.get("system-prompt/assemble")[0];
    const assembly = {
      sections: [
        { name: "tool:goal", text: "GOAL_SECTION" },
        { name: "deployment:persona", text: "ignored" },
      ],
      contexts: [],
      variables: {},
    };
    await assemble(assembly, { agent: OFF_AGENT }, async () => assembly);
    const systemReport = offReports.find((r) => r.plugin === "kaz-system-prompt");
    check(
      "①.e goal 模式未开启时 tool:goal 被丢弃，真实 system 只有 persona",
      systemReport !== undefined && systemReport.content === "You are a helpful software engineer assistant.",
    );
    check(
      "①.e 过滤后 sections 只剩 persona",
      assembly.sections.length === 1 && assembly.sections[0].name === "deployment:persona",
    );
  }

  // ①.f goal 模式未开启 + plan 激活：persona → plan:policy（不带 tool:goal）
  {
    const OFF_AGENT = { id: "s-kaz-goal-off-plan", session: { events: [] } };
    const offReports = [];
    const offMock = makeMockCtx({
      provided: {
        kazMode: { kazEnabled: () => true, pluginEnabled: () => false, toolVisible: () => false },
        roundDisplay: { report: (p) => offReports.push(p) },
        agents: { get: (id) => (id === OFF_AGENT.id ? OFF_AGENT : undefined) },
      },
    });
    kspApply(offMock.ctx, {});
    const assemble = offMock.listeners.get("system-prompt/assemble")[0];
    const assembly = {
      sections: [
        { name: "tool:goal", text: "GOAL_SECTION" },
        { name: "plan:policy", text: "PLAN_SECTION" },
        { name: "deployment:persona", text: "ignored" },
      ],
      contexts: [],
      variables: {},
    };
    await assemble(assembly, { agent: OFF_AGENT }, async () => assembly);
    const systemReport = offReports.find((r) => r.plugin === "kaz-system-prompt");
    check(
      "①.f goal 模式未开启时 plan + tool:goal 只剩 persona + plan",
      systemReport !== undefined && systemReport.content === "You are a helpful software engineer assistant.\n\nPLAN_SECTION",
    );
    check(
      "①.f 过滤后 sections 只剩 persona + plan:policy",
      assembly.sections.length === 2 &&
        assembly.sections[0].name === "deployment:persona" &&
        assembly.sections[1].name === "plan:policy",
    );
  }

  // ①.g update_goal 可见但无目标：goal 模式未开启 → tool:goal 被丢弃
  {
    const NO_GOAL_AGENT = { id: "s-kaz-no-goal", session: { events: [] } };
    const noGoalReports = [];
    const noGoalMock = makeMockCtx({
      provided: {
        kazMode: { kazEnabled: () => true, pluginEnabled: () => false, toolVisible: () => true },
        goals: { get: () => undefined },
        roundDisplay: { report: (p) => noGoalReports.push(p) },
        agents: { get: (id) => (id === NO_GOAL_AGENT.id ? NO_GOAL_AGENT : undefined) },
      },
    });
    kspApply(noGoalMock.ctx, {});
    const assemble = noGoalMock.listeners.get("system-prompt/assemble")[0];
    const assembly = {
      sections: [
        { name: "tool:goal", text: "GOAL_SECTION" },
        { name: "deployment:persona", text: "ignored" },
      ],
      contexts: [],
      variables: {},
    };
    await assemble(assembly, { agent: NO_GOAL_AGENT }, async () => assembly);
    const systemReport = noGoalReports.find((r) => r.plugin === "kaz-system-prompt");
    check(
      "①.g update_goal 可见但无目标时 tool:goal 被丢弃",
      systemReport !== undefined && systemReport.content === "You are a helpful software engineer assistant.",
    );
    check("①.g 过滤后 sections 只剩 persona", assembly.sections.length === 1 && assembly.sections[0].name === "deployment:persona");
  }

  // ①.h 目标存在但 update_goal 不可见：goal 模式未开启 → tool:goal 被丢弃
  {
    const HIDDEN_AGENT = { id: "s-kaz-hidden-update", session: { events: [] } };
    const hiddenReports = [];
    const hiddenMock = makeMockCtx({
      provided: {
        kazMode: { kazEnabled: () => true, pluginEnabled: () => false, toolVisible: (_agent, name) => name !== "update_goal" },
        goals: { get: (agent) => (agent === HIDDEN_AGENT ? { phase: "active", objective: "x", maxGoalRounds: 256 } : undefined) },
        roundDisplay: { report: (p) => hiddenReports.push(p) },
        agents: { get: (id) => (id === HIDDEN_AGENT.id ? HIDDEN_AGENT : undefined) },
      },
    });
    kspApply(hiddenMock.ctx, {});
    const assemble = hiddenMock.listeners.get("system-prompt/assemble")[0];
    const assembly = {
      sections: [
        { name: "tool:goal", text: "GOAL_SECTION" },
        { name: "deployment:persona", text: "ignored" },
      ],
      contexts: [],
      variables: {},
    };
    await assemble(assembly, { agent: HIDDEN_AGENT }, async () => assembly);
    const systemReport = hiddenReports.find((r) => r.plugin === "kaz-system-prompt");
    check(
      "①.h 目标存在但 update_goal 不可见时 tool:goal 被丢弃",
      systemReport !== undefined && systemReport.content === "You are a helpful software engineer assistant.",
    );
    check("①.h 过滤后 sections 只剩 persona", assembly.sections.length === 1 && assembly.sections[0].name === "deployment:persona");
  }

  // ①.i 目标 paused + update_goal 可见：goal 模式开启 → 保留自定义 tool:goal
  {
    const PAUSED_AGENT = { id: "s-kaz-paused", session: { events: [] } };
    const pausedReports = [];
    const pausedMock = makeMockCtx({
      provided: {
        kazMode: { kazEnabled: () => true, pluginEnabled: () => false, toolVisible: () => true },
        goals: { get: (agent) => (agent === PAUSED_AGENT ? { phase: "paused", objective: "x", maxGoalRounds: 256 } : undefined) },
        roundDisplay: { report: (p) => pausedReports.push(p) },
        agents: { get: (id) => (id === PAUSED_AGENT.id ? PAUSED_AGENT : undefined) },
      },
    });
    kspApply(pausedMock.ctx, {});
    const assemble = pausedMock.listeners.get("system-prompt/assemble")[0];
    const assembly = {
      sections: [
        { name: "tool:goal", text: "GOAL_SECTION" },
        { name: "deployment:persona", text: "ignored" },
      ],
      contexts: [],
      variables: {},
    };
    await assemble(assembly, { agent: PAUSED_AGENT }, async () => assembly);
    const systemReport = pausedReports.find((r) => r.plugin === "kaz-system-prompt");
    check(
      "①.i 目标 paused + update_goal 可见时保留自定义 tool:goal",
      systemReport !== undefined &&
        systemReport.content.includes("We are in goal mode.") &&
        assembly.sections.length === 2 &&
        assembly.sections[1].name === "tool:goal",
    );
  }

  // ①.j 目标 complete + update_goal 可见：goal 模式未开启 → tool:goal 被丢弃
  {
    const COMPLETE_AGENT = { id: "s-kaz-complete", session: { events: [] } };
    const completeReports = [];
    const completeMock = makeMockCtx({
      provided: {
        kazMode: { kazEnabled: () => true, pluginEnabled: () => false, toolVisible: () => true },
        goals: { get: (agent) => (agent === COMPLETE_AGENT ? { phase: "complete", objective: "x", maxGoalRounds: 256 } : undefined) },
        roundDisplay: { report: (p) => completeReports.push(p) },
        agents: { get: (id) => (id === COMPLETE_AGENT.id ? COMPLETE_AGENT : undefined) },
      },
    });
    kspApply(completeMock.ctx, {});
    const assemble = completeMock.listeners.get("system-prompt/assemble")[0];
    const assembly = {
      sections: [
        { name: "tool:goal", text: "GOAL_SECTION" },
        { name: "deployment:persona", text: "ignored" },
      ],
      contexts: [],
      variables: {},
    };
    await assemble(assembly, { agent: COMPLETE_AGENT }, async () => assembly);
    const systemReport = completeReports.find((r) => r.plugin === "kaz-system-prompt");
    check(
      "①.j 目标 complete 时 tool:goal 被丢弃",
      systemReport !== undefined && systemReport.content === "You are a helpful software engineer assistant.",
    );
    check("①.j 过滤后 sections 只剩 persona", assembly.sections.length === 1 && assembly.sections[0].name === "deployment:persona");
  }

  // ①.k 自定义 tool:goal 的 blocked 阈值从官方文本提取（官方 5 → 自定义 5）
  {
    const assemble = mock.listeners.get("system-prompt/assemble")[0];
    const assembly = {
      sections: [
        { name: "tool:goal", text: "official ... at least 5 consecutive goal rounds ..." },
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
      "①.k blocked 阈值跟随官方配置（5）",
      systemReport !== undefined &&
        systemReport.content.includes("at least 5 consecutive goal rounds") &&
        !systemReport.content.includes("at least 3 consecutive goal rounds"),
    );
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
  const realNow = Date.now;
  let nowTick = 1000000;
  Date.now = () => nowTick++;
  try {
    rd.report({ agent: AGENT_RD, plugin: "a", title: "", content: "first" });
    rd.report({ agent: AGENT_RD, plugin: "b", title: "", content: "second" });
    rd.report({ agent: AGENT_RD, plugin: "a", title: "", content: "third" });
    // 同轮去重：与 "a|first" 完全相同的上报应被忽略。
    rd.report({ agent: AGENT_RD, plugin: "a", title: "", content: "first" });
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
// ④ round-display：同一轮保留所有不同内容的系统提示词快照（重复去重）
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
  try {
    // 同一轮内系统提示词发生变化（例如 ka-whale-workflow 重构 → 分类）：
    // 两个不同内容的快照都应保留；完全相同的重复上报只保留一条。
    rd.report({ agent: AGENT_SYS, plugin: "kaz-system-prompt", title: "system prompt", content: "reconstruction prompt" });
    rd.report({ agent: AGENT_SYS, plugin: "kaz-system-prompt", title: "system prompt", content: "classification prompt" });
    rd.report({ agent: AGENT_SYS, plugin: "kaz-system-prompt", title: "system prompt", content: "classification prompt" });
  } finally {
    Date.now = realNow;
  }

  const listRes = await rpc("list", { sessionId: AGENT_SYS.id });
  const listEntries = Array.isArray(listRes?.value?.entries) ? listRes.value.entries : [];
  const listContents = listEntries.map((e) => e.content);
  check(
    "④ 同轮保留所有不同系统提示词快照（新在上、重复去重）",
    listEntries.length === 2 &&
      JSON.stringify(listContents) === JSON.stringify(["classification prompt", "reconstruction prompt"]),
  );
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nROUND-DISPLAY PROBE OK" : `\nROUND-DISPLAY PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
