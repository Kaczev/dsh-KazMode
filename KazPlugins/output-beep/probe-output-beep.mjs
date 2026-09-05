// output-beep 宿主半探针：在 mock ctx 上运行插件（execFile 已 mock，不真响），验证：
//   ① 插件可加载、导出 apply；
//   ② apply 注册 agent/status 与 session/event 监听；
//   ③ 默认（idleBeep=false）主会话 idle 不播放提示音；
//   ④ 默认子代理 idle 也不播放；
//   ⑤ ask_user_question / exit_plan_mode 事件仍触发播放；
//   ⑥ idleBeep=true 后主会话 idle 恢复播放（旧版输出完毕行为）；
//   ⑦ enabled=false 后 idleBeep=true 也不播放。
// 运行：node output-beep/probe-output-beep.mjs
import childProcess from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

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

// 在动态导入插件前替换 execFile：只计数、不真响。
const beepCalls = [];
const originalExecFile = childProcess.execFile;
childProcess.execFile = (...args) => {
  beepCalls.push(args);
  const cb = args.find((arg) => typeof arg === "function");
  if (cb) queueMicrotask(() => cb(null, "MOCK", ""));
};

const { apply, name } = await import(new URL("./lib/index.js", import.meta.url).href);

const settings = makeSettings();
const listeners = new Map();

const base = {
  fiber: { state: 0 }, // 模拟未卸载，避免 installSettingsWithDefaults 的 watch 报 mock:watch-error
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
  apply(base, { enabled: true, idleBeep: false, includeSubagents: false, frequency: 880, duration: 250 });
} catch (error) {
  console.log("[probe] apply 失败:", error);
  process.exit(1);
}
check("已注册 agent/status 监听", (listeners.get("agent/status") ?? []).length > 0);
check("已注册 session/event 监听", (listeners.get("session/event") ?? []).length > 0);

const statusListeners = listeners.get("agent/status") ?? [];
const eventListeners = listeners.get("session/event") ?? [];

console.log("  → 默认主会话 idle（idleBeep=false）不播放…");
beepCalls.length = 0;
for (const fn of statusListeners) {
  try {
    fn({ status: "idle", agent: { id: "main-1", session: { header: {} } } });
  } catch (error) {
    check("默认主会话 idle 触发不抛错", false);
    console.log("    error:", error);
  }
}
check("默认主会话 idle 不播放提示音", beepCalls.length === 0);
check("默认主会话 idle 触发不抛错", true);

console.log("  → 默认子代理 idle 不播放…");
beepCalls.length = 0;
for (const fn of statusListeners) {
  try {
    fn({ status: "idle", agent: { id: "sub-1", session: { header: { origin: "subagent" } } } });
  } catch (error) {
    check("子代理 idle 触发不抛错", false);
    console.log("    error:", error);
  }
}
check("默认子代理 idle 不播放提示音", beepCalls.length === 0);
check("子代理 idle 触发不抛错", true);

console.log("  → ask_user_question 事件仍触发播放…");
beepCalls.length = 0;
for (const fn of eventListeners) {
  try {
    fn({ id: "main-1", header: {} }, { type: "tool/call", data: { name: "ask_user_question" } });
  } catch (error) {
    check("ask_user_question 事件触发不抛错", false);
    console.log("    error:", error);
  }
}
check("ask_user_question 仍触发提示音", beepCalls.length === 1);
check("ask_user_question 事件触发不抛错", true);

await delay(250); // 清防抖窗口

console.log("  → exit_plan_mode 事件仍触发播放…");
beepCalls.length = 0;
for (const fn of eventListeners) {
  try {
    fn({ id: "main-1", header: {} }, { type: "tool/call", data: { name: "exit_plan_mode" } });
  } catch (error) {
    check("exit_plan_mode 事件触发不抛错", false);
    console.log("    error:", error);
  }
}
check("exit_plan_mode 仍触发提示音", beepCalls.length === 1);
check("exit_plan_mode 事件触发不抛错", true);

await delay(250); // 清防抖窗口

console.log("  → idleBeep=true 后主会话 idle 恢复播放…");
try {
  await settings.update("output-beep", { idleBeep: true });
} catch (error) {
  check("启用 idleBeep 不抛错", false);
  console.log("    error:", error);
}
beepCalls.length = 0;
for (const fn of statusListeners) {
  try {
    fn({ status: "idle", agent: { id: "main-2", session: { header: {} } } });
  } catch (error) {
    check("idleBeep=true idle 触发不抛错", false);
    console.log("    error:", error);
  }
}
check("idleBeep=true 恢复输出完毕提示音", beepCalls.length === 1);
check("idleBeep=true idle 触发不抛错", true);

console.log("  → idleBeep=true 时子代理仍默认静音…");
beepCalls.length = 0;
for (const fn of statusListeners) {
  try {
    fn({ status: "idle", agent: { id: "sub-2", session: { header: { origin: "subagent" } } } });
  } catch (error) {
    check("idleBeep=true 子代理触发不抛错", false);
    console.log("    error:", error);
  }
}
check("idleBeep=true 子代理仍不播放提示音", beepCalls.length === 0);
check("idleBeep=true 子代理触发不抛错", true);

await delay(250); // 清防抖窗口

console.log("  → enabled=false 后 idleBeep=true 也不播放…");
try {
  await settings.update("output-beep", { enabled: false, idleBeep: true });
} catch (error) {
  check("禁用 enabled 不抛错", false);
  console.log("    error:", error);
}
beepCalls.length = 0;
for (const fn of statusListeners) {
  try {
    fn({ status: "idle", agent: { id: "main-3", session: { header: {} } } });
  } catch (error) {
    check("enabled=false 后 idle 触发不抛错", false);
    console.log("    error:", error);
  }
}
check("enabled=false 后 idle 不播放提示音", beepCalls.length === 0);
check("enabled=false 后 idle 触发不抛错", true);

// 还原 execFile（进程即将退出，仅作卫生处理）。
childProcess.execFile = originalExecFile;

console.log(failures === 0 ? "\n全部通过 ✔" : `\n${failures} 项失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
