// kaz-mode 探针（v0.9 B5 口径）：
//   - Kaz Stable Main Surface 固定 19 项，无 enable_tool / old subagent / create_goal；
//   - ka-whale-memory/workflow 在 Kaz 恒开：旧“记忆关”项目状态不再从固定面剔除记忆读；
//   - 非 Kaz 模式仍按项目状态移除记忆工具；
//   - 受控 v0.9 worker 子代理面 = role Stable Base + assignedTools；
//   - assemble / pre-execute 与 kazSurfaceFor 一致。
// 运行：node KazPlugins/kaz-mode/probe-task-surface-filter.mjs
import plugin from "file:///C:/Users/Kaczev/.dsh/profiles/web/KazPlugins/kaz-mode/lib/index.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

const TMP = mkdtempSync(join(tmpdir(), "kaz-surface-filter-"));
const PROJECT_A = join(TMP, "proj-a"); // memory on in legacy state
const PROJECT_B = join(TMP, "proj-b"); // memory off in legacy state (ignored in Kaz)
for (const dir of [PROJECT_A, PROJECT_B]) {
  mkdirSync(join(dir, ".dsh", "storages"), { recursive: true });
}
function writeProjectStates(dir, states) {
  writeFileSync(join(dir, ".dsh", "storages", "kaz-project-states.json"), JSON.stringify({ version: 1, states }, null, 2), "utf8");
}
writeProjectStates(PROJECT_A, { "ka-whale-workflow": { enabled: true } });
writeProjectStates(PROJECT_B, { "ka-whale-memory": { enabled: false }, "ka-whale-workflow": { enabled: true } });

const STORAGE_DIR = join(TMP, "dsh-storages");
mkdirSync(STORAGE_DIR, { recursive: true });
writeFileSync(join(STORAGE_DIR, "tool-plugin.json"), JSON.stringify({ "tool-fs": true, "tool-jobs": true, "tool-subagent": true }, null, 2), "utf8");
writeFileSync(join(STORAGE_DIR, "tool-plugin-catalog.json"), JSON.stringify({
  "tool-fs": { read_image: true },
  "tool-jobs": { job_list: true },
  "tool-subagent": { subagent: true },
}, null, 2), "utf8");

const SESSIONS = {
  "s-kaz": { cwd: PROJECT_A, agentPreset: "kaz" },
  "s-kaz-nomem": { cwd: PROJECT_B, agentPreset: "kaz" },
  "s-plain-nomem": { cwd: PROJECT_B, agentPreset: "cordis" },
  "s-ctrl": { cwd: PROJECT_A, agentPreset: "kaz" },
};
const eventsOf = () => [{ type: "tool/call", seq: 0, time: Date.now(), data: { name: "pwsh" } }];
const agentOf = (id) => ({
  id,
  session: { header: { id, cwd: SESSIONS[id].cwd, agentPreset: SESSIONS[id].agentPreset }, events: eventsOf() },
});
const agentOfSubagent = (id) => ({
  id,
  options: { subagentDepth: 1 },
  session: { header: { id, cwd: SESSIONS[id].cwd, agentPreset: SESSIONS[id].agentPreset }, events: eventsOf() },
});
const CONTROLLED_WORKER_SURFACE = [
  "edit", "glob", "grep", "memory_detail", "memory_list", "memory_search",
  "pwsh", "read", "todo_write", "web_search", "write", "work_sub_whale_report", "job_list",
];
const kaWhaleMock = {
  stageOf: () => "working",
  subagentRoleOf: (agent) =>
    agent?.id === "s-ctrl" ? { persona: "worker", assignedTools: ["job_list"], finalTools: [...CONTROLLED_WORKER_SURFACE] } : null,
  subagentSurfaceOf: (agent) => (agent?.id === "s-ctrl" ? [...CONTROLLED_WORKER_SURFACE] : null),
};

const listeners = new Map();
const provided = {};
const agentsBySession = new Map();
for (const id of Object.keys(SESSIONS)) agentsBySession.set(id, agentOf(id));
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
        update: (patch) => { userSections.set(ns, { ...(userSections.get(ns) ?? {}), ...patch }); return Promise.resolve(); },
        replace: (section) => { userSections.set(ns, { ...section }); return Promise.resolve(); },
      };
    },
    get: (ns) => resolve(ns),
    update: () => Promise.resolve(),
    describe: () => [],
  };
}
const settings = makeSettings();
const ctx = {
  fiber: { state: 0 },
  tools: { register: () => () => {}, schemas: () => [], ctx: null },
  logger: { info: () => {}, warn: () => {}, debug: () => {} },
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(fn);
    return () => {};
  },
  effect(fn) {
    const dispose = fn();
    return () => { if (typeof dispose === "function") dispose(); };
  },
  provide(name, value) { provided[name] = value; return () => { delete provided[name]; }; },
  get(name) {
    if (name in provided) return provided[name];
    if (name === "settings") return settings;
    if (name === "agents") return { get: (sid) => agentsBySession.get(sid) ?? undefined };
    if (name === "kaWhaleWorkflow") return kaWhaleMock;
    return undefined;
  },
  inject(deps, cb) {
    if (deps.includes("settings")) cb({ ...ctx, settings });
  },
};
plugin.apply(ctx, { enabled: true, storageDir: STORAGE_DIR });
await new Promise((resolve) => setTimeout(resolve, 20));
const kazMode = provided["kazMode"];

const sKaz = agentOf("s-kaz");
const sKazNomem = agentOf("s-kaz-nomem");
const sPlainNomem = agentOf("s-plain-nomem");

// ① Kaz fixed surface: no optional/task-tool machinery.
{
  const surface = kazMode.surfaceOf(sKaz);
  check("Kaz surface = 19 fixed tools", surface !== null && surface.size === 19);
  check("Kaz surface contains v0.9 controls and Goal reads", surface.has("read") && surface.has("ka_sub_whale") && surface.has("list_agents") && surface.has("send_message") && surface.has("interrupt_agent") && surface.has("whale_report") && surface.has("get_goal") && surface.has("update_goal"));
  check("Kaz surface has no enable_tool / old subagent / create_goal / external optional", !surface.has("enable_tool") && !surface.has("subagent") && !surface.has("create_goal") && !surface.has("read_image") && !surface.has("job_list"));
  check("Kaz surface contains memory reads but not writes", surface.has("memory_search") && surface.has("memory_list") && surface.has("memory_detail") && !surface.has("memory_save") && !surface.has("memory_forget"));
}

// ② Kaz 恒开：old memory-off state ignored.
{
  const nomemSurface = kazMode.surfaceOf(sKazNomem);
  check("Kaz memory-off legacy state still yields memory reads (B5 fixed)", nomemSurface !== null && nomemSurface.has("memory_search") && nomemSurface.has("memory_list") && nomemSurface.has("memory_detail") && nomemSurface.size === 19);
}

// ③ Non-Kaz still honors plugin state.
{
  check("non-Kaz memory-off removes memory tools", kazMode.toolVisible(sPlainNomem, "memory_search") === false && kazMode.toolVisible(sPlainNomem, "memory_save") === false);
}

// ④ Controlled worker subagent surface.
{
  const ctrl = agentOfSubagent("s-ctrl");
  const ctrlSurface = kazMode.surfaceOf(ctrl);
  check("controlled worker surface = role base + assigned tool-jobs", ctrlSurface.has("work_sub_whale_report") && ctrlSurface.has("job_list") && ctrlSurface.has("write") && !ctrlSurface.has("memory_save"));
}

// ⑤ assemble/pre-execute use same stable surface.
const ALL_TOOLS = ["read", "pwsh", "web_search", "read_image", "job_list", "subagent", "enable_tool", "exit_plan_mode", "create_goal", "get_goal", "update_goal", "whale_report", "ka_sub_whale", "list_agents", "send_message", "interrupt_agent", "memory_search", "memory_save"];
const runAssemble = async (agent) => {
  const listener = listeners.get("system-prompt/assemble")[0];
  const assembly = { tools: ALL_TOOLS.map((name) => ({ name })), sections: [], contexts: [], variables: {} };
  await listener(assembly, { agent }, () => assembly);
  return new Set(assembly.tools.map((t) => t.name));
};
const gate = listeners.get("tools/pre-execute")[0];
const runGate = async (agent, name) => gate({ name, agent }, async () => ({ kind: "allow" }));
const assembled = await runAssemble(sKaz);
check("assemble keeps v0.9 fixed surface only", assembled.has("ka_sub_whale") && assembled.has("whale_report") && !assembled.has("enable_tool") && !assembled.has("subagent") && !assembled.has("create_goal") && !assembled.has("read_image") && !assembled.has("job_list"));
check("pre-execute allows fixed tools and denies enable_tool/old subagent/writes", (await runGate(sKaz, "whale_report")).kind === "allow" && (await runGate(sKaz, "enable_tool")).kind === "deny" && (await runGate(sKaz, "subagent")).kind === "deny" && (await runGate(sKaz, "memory_save")).kind === "deny");

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nTASK-SURFACE-FILTER PROBE OK" : `\nTASK-SURFACE-FILTER PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
