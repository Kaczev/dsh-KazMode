// round-display + kaz-system-prompt 探针（2026-08-28，Kaz 适配 Plan 模式）
// 覆盖：
//   ① kaz-system-prompt.mjs：system-prompt/assemble 后上报“真实系统提示词”
//     （plan:policy 段 + persona 段，"\n\n" 连接，空段过滤）；
//   ② kaz-system-prompt.mjs：agent/pre-step 上报 plan-mode 进入/退出通知，
//      reject 的 step 不上报；session/event 兜底同样上报；
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
  const AGENT = { id: "s-kaz" };
  const kspReports = [];
  const mock = makeMockCtx({
    provided: {
      kazMode: { kazEnabled: () => true, pluginEnabled: () => false },
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

  // ②.c session/event：plan-mode 通知落盘时兜底上报
  {
    const sessionEvent = mock.listeners.get("session/event")[0];
    const notice = {
      role: "user",
      content: [{ type: "text", text: "The user switched this session back to the default mode." }],
      source: { kind: "plugin", plugin: "plan-mode", form: "notice", summary: "The user switched this session back to the default mode." },
    };
    const before = kspReports.length;
    sessionEvent({ id: AGENT.id }, { type: "user/message", data: notice });
    const reports = kspReports.slice(before);
    const noticeReport = reports.find((r) => r.plugin === "plan-mode");
    check("②.c session/event 兜底上报 plan-mode 退出通知", noticeReport !== undefined && noticeReport.content === "The user switched this session back to the default mode.");
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

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nROUND-DISPLAY PROBE OK" : `\nROUND-DISPLAY PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
