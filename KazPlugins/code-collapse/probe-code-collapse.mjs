// code-collapse 宿主半探针：在 mock ctx 上运行插件，验证：
//   ① 现有 agent 在插件加载时即被 presentAs('code')（工具面折叠为 run_code）；
//   ② 新会话 agent/session-start → 同样折叠；
//   ③ 每次 run_code 调用后，post-execute 的 accept 决策追加 additionalContexts
//      （含默认 [code-collapse] We need 提示）；非 run_code 不加；
//   ④ appendCallHint=false 不加；callHint 自定义文本生效；
//   ⑤ enabled=false → 撤销已声明呈现、新会话不再折叠；
//   ⑥ 首轮提醒：注册 code-collapse:first-round 段，仅 turn 1 注入；
//      firstRoundHint=false / firstRoundText 自定义 / enabled=false 生效。
// 运行：node code-collapse/probe-code-collapse.mjs
import { apply } from "file:///C:/Users/Kaczev/.dsh/profiles/web/plugins/code-collapse/lib/index.js";

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

function makeSettings() {
  const userSections = new Map();
  const bases = new Map();
  const watches = new Map();
  const resolve = (ns) => ({ ...(bases.get(ns) ?? {}), ...(userSections.get(ns) ?? {}) });
  const commit = (ns) => {
    for (const cb of watches.get(ns) ?? []) {
      try {
        cb(resolve(ns), undefined);
      } catch (error) {
        console.log("[mock:watch-error]", error);
      }
    }
  };
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
          commit(ns);
          return Promise.resolve();
        },
        replace: (section) => {
          userSections.set(ns, { ...section });
          commit(ns);
          return Promise.resolve();
        },
      };
    },
    get: (ns) => resolve(ns),
    update(ns, patch) {
      userSections.set(ns, { ...(userSections.get(ns) ?? {}), ...patch });
      commit(ns);
      return Promise.resolve();
    },
  };
}

const settings = makeSettings();
const listeners = new Map();
const presentCalls = [];
const disposed = [];
const sections = [];

function makeAgent(id) {
  return {
    id,
    ctx: {
      tools: {
        presentAs(mode) {
          presentCalls.push({ id, mode });
          return () => disposed.push(id);
        },
      },
    },
  };
}

const existingAgents = [makeAgent("a1"), makeAgent("a2")];

const base = {
  fiber: { state: 0 },
  logger: { info: () => {}, warn: (...a) => console.log("[mock:warn]", ...a), debug: () => {} },
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(fn);
    return () => {};
  },
  systemPrompt: {
    section(def) {
      sections.push(def);
      return () => {};
    },
  },
  inject(deps, cb) {
    if (deps.includes("settings")) cb({ ...base, settings });
  },
  effect(fn) {
    fn();
    return () => {};
  },
  get(name) {
    if (name === "settings") return settings;
    if (name === "agents") return { list: () => existingAgents };
    return undefined;
  },
};

await apply(base, {});
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
await settle();

// ① 现有 agent 加载即折叠
check("① 现有 agent a1 被 presentAs('code')", presentCalls.some((c) => c.id === "a1" && c.mode === "code"));
check("① 现有 agent a2 被 presentAs('code')", presentCalls.some((c) => c.id === "a2" && c.mode === "code"));

// ② 新会话折叠
const a3 = makeAgent("a3");
for (const fn of listeners.get("agent/session-start") ?? []) fn({ agent: a3 });
await settle();
check("② 新会话 a3 被 presentAs('code')", presentCalls.some((c) => c.id === "a3" && c.mode === "code"));

// ③ post-execute：run_code → 追加提示；其它工具不加
const postExec = listeners.get("tools/post-execute") ?? [];
check("③ 已注册 tools/post-execute 监听", postExec.length > 0);
const accept = { kind: "accept", content: [{ type: "text", text: "ok" }] };
const d1 = await postExec[0]({ name: "run_code" }, {}, () => Promise.resolve(accept));
const added = (d1.additionalContexts ?? []).map((m) => m.content.map((b) => b.text).join(""));
check(
  "③ run_code 后追加含 [code-collapse] We need 提示的上下文",
  added.length >= 1 && added.some((t) => t.includes("[code-collapse]") && t.includes("Let's") && t.includes("Let me") && t.includes("We need")),
);
const d2 = await postExec[0]({ name: "read" }, {}, () => Promise.resolve(accept));
check("③ 非 run_code 不追加", !Array.isArray(d2.additionalContexts) || d2.additionalContexts.length === 0);
const d3 = await postExec[0]({ name: "run_code" }, {}, () => Promise.resolve({ kind: "block", feedback: [{ type: "text", text: "x" }] }));
check("③ block 决策不追加", !Array.isArray(d3.additionalContexts) || d3.additionalContexts.length === 0);

// ④ appendCallHint=false → 不加；callHint 自定义生效
await settings.update("code-collapse", { appendCallHint: false });
await settle();
const d4 = await postExec[0]({ name: "run_code" }, {}, () => Promise.resolve(accept));
check("④ appendCallHint=false 不追加", !Array.isArray(d4.additionalContexts) || d4.additionalContexts.length === 0);
await settings.update("code-collapse", { appendCallHint: true, callHint: "自定义的 We need 提示" });
await settle();
const d5 = await postExec[0]({ name: "run_code" }, {}, () => Promise.resolve(accept));
const t5 = (d5.additionalContexts ?? []).map((m) => m.content.map((b) => b.text).join(""));
check("④ callHint 自定义文本生效", t5.length >= 1 && t5.some((t) => t.includes("自定义的 We need 提示")));
await settings.update("code-collapse", { callHint: "" });
await settle();
const d6 = await postExec[0]({ name: "run_code" }, {}, () => Promise.resolve(accept));
const t6 = (d6.additionalContexts ?? []).map((m) => m.content.map((b) => b.text).join(""));
check("④ callHint 清空后回退内置默认", t6.length >= 1 && t6.some((t) => t.includes("[code-collapse]") && t.includes("Let's")));

// ⑥ 首轮提醒：仅 turn 1 注入；开关/文案/总开关生效
const roundSection = sections.find((s) => s.name === "code-collapse:first-round");
check("⑥ 首轮提醒段已注册", roundSection !== undefined && typeof roundSection.text === "function");
const turn1Agent = { id: "t1", session: { events: [{ type: "turn/start", data: { turn: 1 } }] }, ctx: { tools: {} } };
const turn2Agent = { id: "t2", session: { events: [{ type: "turn/start", data: { turn: 2 } }] }, ctx: { tools: {} } };
const plainAgent = { id: "t3", ctx: { tools: {} } };
const r1 = roundSection.text({ agent: turn1Agent });
check("⑥ turn 1 注入首轮提醒（We need 风格）", typeof r1 === "string" && r1.includes("[code-collapse First Round]") && r1.includes("We need to make the most of run_code"));
check("⑥ turn 2 不注入", roundSection.text({ agent: turn2Agent }) === "");
check("⑥ 无会话事件不注入", roundSection.text({ agent: plainAgent }) === "");
await settings.update("code-collapse", { firstRoundText: "自定义首轮提醒" });
await settle();
check("⑥ firstRoundText 自定义生效", roundSection.text({ agent: turn1Agent }).includes("自定义首轮提醒"));
await settings.update("code-collapse", { firstRoundText: "", firstRoundHint: false });
await settle();
check("⑥ firstRoundHint=false 不注入", roundSection.text({ agent: turn1Agent }) === "");
await settings.update("code-collapse", { firstRoundHint: true });
await settle();
check("⑥ 恢复后 turn 1 再次注入", roundSection.text({ agent: turn1Agent }).includes("[code-collapse First Round]"));

// ⑤ enabled=false → 撤销已声明呈现、新会话不再折叠
await settings.update("code-collapse", { enabled: false });
await settle();
check("⑤ 关闭后撤销已声明的呈现", disposed.length >= 3 && disposed.includes("a1") && disposed.includes("a3"));
const before = presentCalls.length;
const a4 = makeAgent("a4");
for (const fn of listeners.get("agent/session-start") ?? []) fn({ agent: a4 });
await settle();
check("⑤ 关闭后新会话不再折叠", presentCalls.length === before);

console.log(failures === 0 ? "\nPROBE OK" : `\nPROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
