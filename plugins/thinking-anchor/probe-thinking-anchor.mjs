// thinking-anchor 宿主半探针：在 mock ctx 上运行插件，验证：
//   ① section 注册：name=thinking-anchor:policy、order=10000（排在所有系统提示之后）；
//   ② 组装层兜底：无论 sections 数组里本段排在哪，system-prompt/assemble
//      后都被移到数组末尾（其它段的相对顺序不变）；
//   ③ 首轮注入完整指令、turn >= 2 起注入每轮提醒（settings 字段留空用内置默认）；
//   ④ kaz-mode 首轮极简（只保留 persona + thinking-anchor）后，本段仍在末尾。
// 运行：node thinking-anchor/probe-thinking-anchor.mjs
import plugin from "file:///C:/Users/Kaczev/.dsh/profiles/web/plugins/thinking-anchor/lib/index.js";

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

// ---- mock settings（与 kaz-memory 探针同构） ----
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
let registeredSection = null;

const base = {
  fiber: { state: 0 },
  logger: { info: () => {}, warn: (...a) => console.log("[mock:warn]", ...a), debug: () => {} },
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(fn);
    return () => {};
  },
  effect(fn) {
    fn();
    return () => {};
  },
  inject(deps, cb) {
    if (deps.includes("settings")) cb({ ...base, settings });
  },
  get(name) {
    if (name === "settings") return settings;
    if (name === "agents") return { list: () => [] }; // 没有任何旧 agent → 新 agent 都算新对话
    return undefined;
  },
  systemPrompt: {
    section(section) {
      registeredSection = section;
      return () => {};
    },
  },
};

function makeAgent(id, events = []) {
  return { id, session: { events } };
}

await plugin.apply(base, {});
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
await settle();

// ① 注册的 section 元数据
check("① section 已注册", registeredSection !== undefined && typeof registeredSection === "object");
check("① section 名称 = thinking-anchor:policy", registeredSection.name === "thinking-anchor:policy");
check("① section order = 10000（排在所有系统提示之后）", registeredSection.order === 10000);

// ② 组装层兜底：把本段移到 sections 末尾
const assembleListeners = listeners.get("system-prompt/assemble") ?? [];
check("② 已注册 system-prompt/assemble 监听", assembleListeners.length > 0);
const runAssemble = async (sections) => {
  let assembly = { sections, tools: [], variables: {} };
  for (const fn of assembleListeners) assembly = await fn(assembly, {}, () => assembly);
  return assembly;
};
const sectionsMixed = [
  { name: "harness:identity", order: -100, text: "You are an AI agent." },
  { name: "deployment:persona", order: 0, text: "persona" },
  { name: "thinking-anchor:policy", order: 10000, text: "[anchor]" },
  { name: "tool:memory:kaz-memory", order: 115, text: "[memory]" },
  { name: "round-minimal:policy", order: 200, text: "[round]" },
];
const after1 = await runAssemble([...sectionsMixed]);
check("② 本段被移到数组末尾", after1.sections[after1.sections.length - 1].name === "thinking-anchor:policy");
check("② 其它段相对顺序不变", JSON.stringify(after1.sections.map((s) => s.name).slice(0, -1)) === JSON.stringify(["harness:identity", "deployment:persona", "tool:memory:kaz-memory", "round-minimal:policy"]));

// ③ kaz-mode 首轮极简：只保留 persona + thinking-anchor → 本段仍在末尾
const minimal = await runAssemble([
  { name: "harness:identity", order: -100, text: "You are an AI agent." },
  { name: "deployment:persona", order: 0, text: "persona" },
  { name: "thinking-anchor:policy", order: 10000, text: "[anchor]" },
  { name: "tool:memory:kaz-memory", order: 115, text: "[memory]" },
].filter((s) => s.name === "deployment:persona" || s.name === "thinking-anchor:policy"));
check("③ 首轮极简后本段仍在末尾", minimal.sections.length === 2 && minimal.sections[1].name === "thinking-anchor:policy");

// ④ 首轮注入完整指令；turn >= 2 注入每轮提醒
const fresh = makeAgent("agent-new");
const first = registeredSection.text({ agent: fresh });
check("④ 新对话首轮注入完整指令", typeof first === "string" && first.includes("[thinking-anchor") && first.includes("All thinking and intermediate reasoning MUST be in English"));
const again = registeredSection.text({ agent: fresh });
check("④ 同一 agent 第二次组装不再注入完整指令", again === "");
const turnTwo = makeAgent("agent-two", [
  { type: "turn/start", data: { turn: 1 } },
  { type: "user/message", data: {} },
  { type: "turn/start", data: { turn: 2 } },
]);
const firstTurnTwo = registeredSection.text({ agent: turnTwo });
const reminder = registeredSection.text({ agent: turnTwo });
check(
  "④ 续接对话（有历史 user/message）首轮组装即注入提醒、而非完整指令",
  typeof firstTurnTwo === "string" && firstTurnTwo.length > 0 && firstTurnTwo.includes("[thinking-anchor") && firstTurnTwo.includes("All thinking and intermediate reasoning MUST be in English"),
);
check("④ turn >= 2 注入每轮提醒", typeof reminder === "string" && reminder.length > 0 && reminder.includes("[thinking-anchor") && reminder.includes("All thinking and intermediate reasoning MUST be in English"));

// ⑤ enabled: false → 不输出
settings.update("thinking-anchor", { enabled: false });
await settle();
check("⑤ enabled=false 时输出空串", registeredSection.text({ agent: makeAgent("agent-new2") }) === "");
settings.update("thinking-anchor", { enabled: true });
await settle();

console.log(failures === 0 ? "\nPROBE OK" : `\nPROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
