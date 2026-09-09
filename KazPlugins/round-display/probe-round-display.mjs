// round-display + kaz-system-prompt 探针（v0.9：真实 main system 必须逐字等于
// KAZ_ROLE_PROMPTS.main，部署 deployment:persona 单段；受控子代理保留
// KAZ_ROLE_PROMPTS.subagent.*；36.9 round-minimal 已删除；2026-09 Goal
// 上报与 goal-context 白名单已随 Goal 模式整体移除）
// 覆盖：
//   ① kaz-system-prompt.mjs：system-prompt/assemble 后上报“真实系统提示词”
//     （Kaz 主会话 = deployment:persona 单段，逐字 KAZ_ROLE_PROMPTS.main；
//     ka-whale-workflow:* / plan:policy / tool:goal 一律丢弃；"\n\n" 连接，
//     空段过滤；category=system-prompt）；
//   ② kaz-system-prompt.mjs：Goal 上报已移除——apply 后不再注册 agent/pre-step
//     监听器，也不再有 goal-round-driver / tool-goal / goal-context 上报；
//   ③ round-display：list / history 内条目按 at 降序（新消息排上）+ 同轮去重；
//   ④ round-display：六类白名单显式接受并去重排序；goal-context / stage 噪音滤除；
//   ⑤ round-display：不带 category 的旧上报按来源回退分类（kaz-system-prompt → system-prompt，
//      round-minimal 历史记录 → tool-surface/stable-boundary）；goal-context 不回退；
//   ⑥ kaz-mode：极简阶段 assemble 的工具面变化实际上报 category=tool-surface（无 round-minimal）。
// 运行：node KazPlugins/round-display/probe-round-display.mjs
import { apply as kspApply } from "file:///C:/Users/Kaczev/Documents/GitHub/dsh-KazMode/kaz/kaz-system-prompt.mjs";
import rdPlugin from "file:///C:/Users/Kaczev/.dsh/profiles/web/KazPlugins/round-display/lib/index.js";
import kazModePlugin from "file:///C:/Users/Kaczev/.dsh/profiles/web/KazPlugins/kaz-mode/lib/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KAZ_ROLE_PROMPTS, KAZ_PROMPT_PHRASES, KAZ_SUBAGENT_FALLBACK_PROMPT } from "../kaz-shared/lib/tool-lists.js";

/** v0.9 §9.1 main Persona 是主会话真实系统的唯一期望文本。 */
const MAIN_PROMPT = KAZ_ROLE_PROMPTS.main;

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
      "①.a plan/tool:goal/其它段被丢弃，真实 system 只有完整 main Persona",
      systemReport !== undefined && systemReport.content === MAIN_PROMPT,
    );
    check("①.a systemReport 携带 category=system-prompt", systemReport?.category === "system-prompt");
    check("①.a assemble 返回值原样透传", result === assembly);
    check("①.a 过滤后 sections 只剩 persona", assembly.sections.length === 1 && assembly.sections[0].name === "deployment:persona");
  }

  // ①.b 旧 ka-whale-workflow:* system 段（含历史 ka-whale-workflow:main）
  // 必须被丢弃：主 Persona 已完整在 deployment:persona，不能出现第二段重复。
  {
    const assemble = mock.listeners.get("system-prompt/assemble")[0];
    const assembly = {
      sections: [
        { name: "ka-whale-workflow:prompt", text: "WHALE_SECTION" },
        { name: "ka-whale-workflow:main", text: "LEGACY_MAIN_DUPLICATE" },
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
      "①.b 旧 ka-whale-workflow:* 段被丢弃，真实 system = KAZ_ROLE_PROMPTS.main",
      systemReport !== undefined &&
        systemReport.content === MAIN_PROMPT &&
        assembly.sections.length === 1 &&
        assembly.sections[0].name === "deployment:persona",
    );
  }

  // ①.b3 真实 main system 与 KAZ_ROLE_PROMPTS.main 逐字相等；header/footer/
  // Keep-gray/role guidance 都只出现一次（不再由 BASE_PROMPT 重复 keep-gray）。
  {
    const assemble = mock.listeners.get("system-prompt/assemble")[0];
    const assembly = {
      sections: [{ name: "deployment:persona", text: "ignored" }],
      contexts: [],
      variables: {},
    };
    const before = kspReports.length;
    await assemble(assembly, { agent: AGENT }, async () => assembly);
    const reports = kspReports.slice(before);
    const systemReport = reports.find((r) => r.plugin === "kaz-system-prompt");
    const assembledSystem = systemReport?.content ?? "";
    const headerPhrase = KAZ_PROMPT_PHRASES.header;
    const headerCount = assembledSystem.split(headerPhrase).length - 1;
    const footerPhrase = KAZ_PROMPT_PHRASES.footer;
    const footerCount = assembledSystem.split(footerPhrase).length - 1;
    const keepGrayPhrase = KAZ_PROMPT_PHRASES.keepGray;
    const keepGrayCount = assembledSystem.split(keepGrayPhrase).length - 1;
    const roleGuidancePhrase = KAZ_PROMPT_PHRASES.mainRoleGuidance;
    const roleGuidanceCount = assembledSystem.split(roleGuidancePhrase).length - 1;
    check(
      "①.b3 真实 main system 逐字等于 KAZ_ROLE_PROMPTS.main",
      systemReport !== undefined &&
        systemReport.content === KAZ_ROLE_PROMPTS.main &&
        assembly.sections.length === 1 &&
        assembly.sections[0].name === "deployment:persona",
    );
    check("①.b3 组装后 header 恰好一次", headerCount === 1);
    check("①.b3 组装后 final white response 结尾恰好一次", footerCount === 1);
    check("①.b3 组装后 Keep-gray 指引恰好一次（无 BASE_PROMPT 重复）", keepGrayCount === 1);
    check("①.b3 组装后 main role guidance 恰好一次", roleGuidanceCount === 1);
  }

  // ①.b4 controlled subagents: request.persona carries KAZ_ROLE_PROMPTS.subagent.<role>
  // exactly and kaz-system-prompt preserves it; reported real system must equal it.
  {
    const assemble = mock.listeners.get("system-prompt/assemble")[0];
    const roles = Object.keys(KAZ_ROLE_PROMPTS.subagent);
    let allPassed = true;
    let allSystemEqual = true;
    for (const role of roles) {
      const subAgent = {
        id: "s-kaz-sub-" + role,
        options: { subagentDepth: 1 },
        session: {
          events: [{ type: "subagent/descriptor", data: {} }],
          header: { origin: "subagent", parentSession: "s-kaz", agentPreset: "kaz" },
        },
      };
      const assembly = {
        sections: [{ name: "deployment:persona", text: KAZ_ROLE_PROMPTS.subagent[role] }],
        contexts: [],
        variables: {},
      };
      const before = kspReports.length;
      await assemble(assembly, { agent: subAgent }, async () => assembly);
      const reports = kspReports.slice(before);
      const systemReport = reports.find((r) => r.plugin === "kaz-system-prompt");
      const preserved =
        assembly.sections.length === 1 &&
        assembly.sections[0].text === KAZ_ROLE_PROMPTS.subagent[role];
      const systemEqual =
        systemReport !== undefined &&
        systemReport.content === KAZ_ROLE_PROMPTS.subagent[role];
      if (!preserved) allPassed = false;
      if (!systemEqual) allSystemEqual = false;
    }
    check(
      "①.b4 四个受控子代理 request.persona 原样保留 KAZ_ROLE_PROMPTS.subagent.<role>",
      allPassed,
    );
    check(
      "①.b4 四个受控子代理真实 system 逐字等于 KAZ_ROLE_PROMPTS.subagent.<role>",
      allSystemEqual,
    );
  }

  // ①.b5 default/preset subagent persona is replaced with the shared fallback;
  // assembled system must carry the shared header/footer so drift is caught.
  {
    const assemble = mock.listeners.get("system-prompt/assemble")[0];
    const defaultSubAgent = {
      id: "s-kaz-sub-default",
      options: { subagentDepth: 1 },
      session: {
        events: [{ type: "subagent/descriptor", data: {} }],
        header: { origin: "subagent", parentSession: "s-kaz", agentPreset: "kaz" },
      },
    };
    const assembly = {
      sections: [{ name: "deployment:persona", text: "You are a helpful software engineer assistant." }],
      contexts: [],
      variables: {},
    };
    const before = kspReports.length;
    await assemble(assembly, { agent: defaultSubAgent }, async () => assembly);
    const reports = kspReports.slice(before);
    const systemReport = reports.find((r) => r.plugin === "kaz-system-prompt");
    const content = systemReport?.content ?? "";
    check(
      "①.b5 默认短 persona 子代理真实 system = KAZ_SUBAGENT_FALLBACK_PROMPT（含 header/footer）",
      assembly.sections[0].text === KAZ_SUBAGENT_FALLBACK_PROMPT &&
        content === KAZ_SUBAGENT_FALLBACK_PROMPT &&
        content.includes(KAZ_PROMPT_PHRASES.header) &&
        content.includes(KAZ_PROMPT_PHRASES.footer),
    );
  }

  // ② Goal 上报移除：apply 后不应再注册 agent/pre-step 监听器（原 goal-round-driver /
  // tool-goal / goal-context 上报随 Goal 模式整体移除）。
  {
    check(
      "② kaz-system-prompt 不再注册 agent/pre-step（Goal 上报已移除）",
      !mock.listeners.has("agent/pre-step"),
    );
    check(
      "② kaz-system-prompt 仍保留 system-prompt/assemble 上报监听器",
      mock.listeners.has("system-prompt/assemble"),
    );
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
// ③.d child records persist across dispose + simulated dsh restart; even when
// agents/sessions no longer resolve the ended child, history falls back to the
// persisted record map by requested sessionId.
// ---------------------------------------------------------------------------
{
  const CHILD_RESTART_ID = "s-rd-child-restart";
  const childAgentForRestart = {
    id: CHILD_RESTART_ID,
    options: { subagentDepth: 1 },
    session: {
      id: CHILD_RESTART_ID,
      events: [{ type: "turn/start", data: { turn: 1 } }],
      header: { origin: "subagent", parentSession: "s-parent-restart" },
    },
  };
  const settings = makeSettings();
  const recordsStore = join(TMP, "round-display-records-child-restart.json");
  const firstMock = makeMockCtx({
    settings,
    agents: null,
    provided: {
      sessions: { get: (id) => (id === CHILD_RESTART_ID ? childAgentForRestart : undefined) },
    },
  });
  rdPlugin.apply(firstMock.ctx, { enabled: true, recordsStore });
  const firstRd = firstMock.provided["roundDisplay"];
  const firstRpc = firstMock.rpcHandlers.get("/round-display");
  const realNow = Date.now;
  let nowTick = 2500000;
  Date.now = () => nowTick++;
  try {
    firstRd.report({ agent: childAgentForRestart, plugin: "kaz-system-prompt", category: "system-prompt", title: "system prompt", content: "child full system prompt record" });
    firstRd.report({ agent: childAgentForRestart, plugin: "kaz-mode", category: "tool-surface", title: "本轮工具变化", content: "child tool surface record" });
    firstRd.report({ agent: childAgentForRestart, plugin: "ka-whale-workflow", category: "subagent-report", title: "子代理汇报", content: "child report record" });
  } finally {
    Date.now = realNow;
  }
  const disposeListener = firstMock.listeners.get("agent/disposed")?.[0];
  disposeListener?.({ agent: childAgentForRestart });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  // Simulate restart: no live agents/sessions registry contains the ended child.
  const secondMock = makeMockCtx({ settings: makeSettings(), agents: null, provided: {} });
  rdPlugin.apply(secondMock.ctx, { enabled: true, recordsStore });
  const secondRpc = secondMock.rpcHandlers.get("/round-display");
  const historyRes = await secondRpc("history", { sessionId: CHILD_RESTART_ID });
  const turns = Array.isArray(historyRes?.value?.turns) ? historyRes.value.turns : [];
  const contents = turns.flatMap((turn) =>
    Array.isArray(turn.entries) ? turn.entries.map((entry) => entry.content) : [],
  );
  check(
    "③.d child system-prompt/report/tool-surface 记录在 dispose+重启后可由 history 按 sessionId 读取",
    historyRes?.ok === true &&
      contents.includes("child full system prompt record") &&
      contents.includes("child tool surface record") &&
      contents.includes("child report record"),
  );
}

// ---------------------------------------------------------------------------
// ④ round-display：六类白名单（v0.9 B6 + 36.7，2026-09 收敛）——显式接受
//    system-prompt / tool-surface / stable-boundary / task-contract /
//    subagent-report / memory-snapshot；同轮不同内容保留 + 重复去重；
//    goal-context（显式 category）与 stage 噪音仍滤除。
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
    // 六类白名单：每类至少一条实际展示。
    rd.report({ agent: AGENT_SYS, plugin: "kaz-system-prompt", title: "system prompt", category: "system-prompt", content: "working prompt" });
    rd.report({ agent: AGENT_SYS, plugin: "kaz-mode", title: "本轮工具变化", category: "tool-surface", content: toolSurfaceContent });
    rd.report({ agent: AGENT_SYS, plugin: "kaz-mode", title: "稳定边界", category: "stable-boundary", content: "stable boundary prompt" });
    rd.report({ agent: AGENT_SYS, plugin: "ka-whale-workflow", title: "任务契约", category: "task-contract", content: "task contract 1" });
    rd.report({ agent: AGENT_SYS, plugin: "ka-whale-workflow", title: "子代理汇报", category: "subagent-report", content: "subagent report 1" });
    rd.report({ agent: AGENT_SYS, plugin: "ka-whale-memory", title: "记忆快照", category: "memory-snapshot", content: "memory snapshot 1" });
    // 同轮去重：与“memory snapshot 1”完全相同（同类别同内容）的上报应被忽略。
    rd.report({ agent: AGENT_SYS, plugin: "ka-whale-memory", title: "记忆快照", category: "memory-snapshot", content: "memory snapshot 1" });
    // 非白名单：显式 goal-context 与 stage/whale_report 噪音仍被过滤。
    rd.report({ agent: AGENT_SYS, plugin: "goal-round-driver", title: "goal round", category: "goal-context", content: "goal explicit rejected" });
    rd.report({ agent: AGENT_SYS, plugin: "ka-whale-workflow", title: "stage-switch", category: "stage-switch", content: "whale_report: working -> communication" });
  } finally {
    Date.now = realNow;
  }

  const listRes = await rpc("list", { sessionId: AGENT_SYS.id });
  const listEntries = Array.isArray(listRes?.value?.entries) ? listRes.value.entries : [];
  const listContents = listEntries.map((e) => e.content);
  const listCategories = listEntries.map((e) => e.category);
  check(
    "④ 六类白名单全部接受且同轮去重（新在上）",
    listEntries.length === 6 &&
      JSON.stringify(listContents) ===
        JSON.stringify([
          "memory snapshot 1",
          "subagent report 1",
          "task contract 1",
          "stable boundary prompt",
          toolSurfaceContent,
          "working prompt",
        ]),
  );
  check(
    "④ 类别覆盖六类且无 goal-context/stage 噪音",
    ["system-prompt", "tool-surface", "stable-boundary", "task-contract", "subagent-report", "memory-snapshot"].every((c) =>
      listCategories.includes(c),
    ) &&
      !listCategories.includes("goal-context") &&
      !listContents.some((c) => c.includes("whale_report") || c.includes("goal explicit rejected")),
  );
}

// ---------------------------------------------------------------------------
// ⑤ round-display：旧/未带 category 的上报按“注入源分类”兼容进白名单；
//    36.7：kaz-system-prompt → system-prompt，round-minimal 工具变化 →
//    tool-surface（旧“恢复全量”仍归 stable-boundary）；
//    记忆指引、阶段切换、first-round guidance 等非白名单内容被过滤；
//    旧 goal-context 上报（goal-round-driver / tool-goal / goal-active /
//    working-resumed 内容）不再回退进白名单。
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
    rd.report({ agent: AGENT_LEGACY, plugin: "ka-whale-memory", title: "guidance", content: "[ka-whale-memory Auto-Load]\n>\nWe know (memory snapshot, context + paths, 1/1):\n---- memory 1/1 ----\ncontext:\nctx\npaths:\n- path: /tmp/sample | purpose: sample\n<" });
    rd.report({ agent: AGENT_LEGACY, plugin: "round-minimal", title: "本轮工具变化", content: "工具面变化\n恢复全量（首次工具调用后）\n- 当前工具（19）…" });
    rd.report({ agent: AGENT_LEGACY, plugin: "round-minimal", title: "本轮工具变化", content: "工具面变化\n工具面变化\n- 当前工具（1）：memory_search\n- 移除（19）：…\n+ 新增（1）：memory_search" });
    rd.report({ agent: AGENT_LEGACY, plugin: "kaz-system-prompt", title: "system prompt", content: "real prompt" });
    // 旧 goal-context 上报（不带 category）不再回退进白名单：
    rd.report({ agent: AGENT_LEGACY, plugin: "goal-round-driver", title: "goal round", content: "<goal_round>round-1</goal_round>" });
    rd.report({ agent: AGENT_LEGACY, plugin: "tool-goal", title: "goal wrapup", content: "<goal_complete>done</goal_complete>" });
    rd.report({ agent: AGENT_LEGACY, plugin: "ka-whale-workflow", title: "阶段 goal-active", content: "[ka-whale-workflow goal-active]\n>\nMode: Goal is active\n<" });
    rd.report({ agent: AGENT_LEGACY, plugin: "ka-whale-workflow", title: "阶段 working-resumed", content: "[ka-whale-workflow working-resumed]\n>\nMode: Working resumed\n<" });
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
    "⑤ 旧上报按来源分类进白名单（system-prompt/tool-surface/stable-boundary/memory-snapshot），噪音被过滤",
    listEntries.length === 4 &&
      categories.includes("memory-snapshot") &&
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
  check(
    "⑤ 旧 goal-context 上报不再被回退/显示",
    !categories.includes("goal-context") &&
      !contents.some(
        (c) =>
          c.includes("<goal_round>") ||
          c.includes("<goal_complete>") ||
          c.includes("[ka-whale-workflow goal-active]") ||
          c.includes("[ka-whale-workflow working-resumed]"),
      ),
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
