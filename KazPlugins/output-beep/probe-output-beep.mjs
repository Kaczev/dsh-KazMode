// output-beep 宿主半探针：在 mock ctx 上运行插件，验证：
//   ① 插件可加载、导出 apply；
//   ② apply 注册 agent/status 与 session/event 监听；
//   ③ 主会话 idle（非子代理）触发播放提示音（会真响一次 880Hz/250ms）；
//   ④ 子代理 idle（默认 includeSubagents=false）不触发播放（不抛错）；
//   ⑤ ask_user_question / exit_plan_mode 事件触发不抛错（防抖合并，最多再响一次）。
// 运行：node output-beep/probe-output-beep.mjs
import { apply, name } from "file:///C:/Users/Kaczev/.dsh/profiles/web/KazPlugins/output-beep/lib/index.js";

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
      try { cb(resolve(ns), undefined); } catch (error) { console.log("[mock:watch-error]", error); }
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

const base = {
  logger: { info: () => {}, warn: (...a) => console.log("[mock:warn]", ...a), debug: () => {} },
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(fn);
    return () => {};
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
    return undefined;
  },
};

check("插件名 = output-beep", name === "output-beep");
check("导出 apply", typeof apply === "function");

try {
  apply(base, { enabled: true, includeSubagents: false, frequency: 880, duration: 250 });
} catch (error) {
  console.log("[probe] apply 失败:", error);
  process.exit(1);
}
check("已注册 agent/status 监听", (listeners.get("agent/status") ?? []).length > 0);
check("已注册 session/event 监听", (listeners.get("session/event") ?? []).length > 0);

const statusListeners = listeners.get("agent/status") ?? [];

console.log("  → 触发主会话 idle（播放一次 880Hz/250ms 提示音）…");
for (const fn of statusListeners) {
  try {
    fn({ status: "idle", agent: { id: "main-1", session: { header: {} } } });
  } catch (error) {
    check("主会话 idle 触发不抛错", false);
    console.log("    error:", error);
  }
}
check("主会话 idle 触发不抛错", true);

for (const fn of statusListeners) {
  try {
    fn({ status: "idle", agent: { id: "sub-1", session: { header: { origin: "subagent" } } } });
  } catch (error) {
    check("子代理 idle 触发不抛错", false);
    console.log("    error:", error);
  }
}
check("子代理 idle 触发不抛错", true);

const eventListeners = listeners.get("session/event") ?? [];

console.log("  → 触发 ask_user_question 与 exit_plan_mode 事件（防抖合并，最多再响一次）…");
for (const toolName of ["ask_user_question", "exit_plan_mode"]) {
  for (const fn of eventListeners) {
    try {
      fn({ id: "main-1", header: {} }, { type: "tool/call", data: { name: toolName } });
    } catch (error) {
      check(`${toolName} 事件触发不抛错`, false);
      console.log("    error:", error);
    }
  }
}
check("ask_user_question / exit_plan_mode 事件触发不抛错", true);

// settings 联动：enabled=false 后主会话 idle 应静默（不抛错即可）。
try {
  await settings.update("output-beep", { enabled: false });
  for (const fn of statusListeners) fn({ status: "idle", agent: { id: "main-2", session: { header: {} } } });
  check("enabled=false 后 idle 触发不抛错", true);
} catch (error) {
  check("enabled=false 后 idle 触发不抛错", false);
  console.log("    error:", error);
}

console.log(failures === 0 ? "\n全部通过 ✔" : `\n${failures} 项失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
