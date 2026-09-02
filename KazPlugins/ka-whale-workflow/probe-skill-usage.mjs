// ka-whale-workflow 探针：终案 E tools/result 埋点。
// 覆盖：skillToolUseEvent 纯过滤（parent 排除 / 非对象拒绝）；applySkillToolUse
// 计数与复活；runtime recordToolUse 只统计 agent-managed/lifecycle 登记工具，
// debounce 缺省时立即落盘；未登记/嵌套调用不写文件。
// 运行：node KazPlugins/ka-whale-workflow/probe-skill-usage.mjs
import plugin, {
  DEFAULT_RECONSTRUCTION_TOOLS,
  skillToolUseEvent,
  applySkillToolUse,
  createLifecycleRecord,
} from "./lib/index.js";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

const TMP = mkdtempSync(join(tmpdir(), "whale-skill-usage-"));
const STORE_FILE = join(TMP, "stage.json");
const LIFECYCLE_FILE = join(TMP, "lifecycle.json");
const REGISTRY_FILE = join(TMP, "registry.json");
const AUDIT_FILE = join(TMP, "audit.jsonl");

const PLUGIN = "kaz-skill-safe-json";
const TOOL = "safe_json_write";
const KEY = `${PLUGIN}/${TOOL}`;

function readLifecycle() {
  return JSON.parse(readFileSync(LIFECYCLE_FILE, "utf8").replace(/^\uFEFF/, ""));
}

// ---------- 纯函数：事件过滤 ----------
check(
  "skillToolUseEvent: 顶层调用被接受",
  skillToolUseEvent({ name: TOOL, parent: undefined, agent: { id: "a" } }, { isError: false })?.name === TOOL,
);
check("skillToolUseEvent: parent 存在 → null", skillToolUseEvent({ name: TOOL, parent: Symbol("p") }, { isError: false }) === null);
check("skillToolUseEvent: 缺 name / 非对象结果 → null", skillToolUseEvent({ parent: undefined }, { isError: false }) === null && skillToolUseEvent({ name: TOOL }, null) === null);
check("skillToolUseEvent: 记录 isError 与 agentId", skillToolUseEvent({ name: TOOL, parent: undefined, agent: { session: { id: "s1" } } }, { isError: true })?.isError === true && skillToolUseEvent({ name: TOOL, parent: undefined, agent: { session: { id: "s1" } } }, { isError: true })?.agentId === "s1");

// ---------- 纯函数：记录更新 / 复活 ----------
{
  const record = createLifecycleRecord(PLUGIN, TOOL, "2026-09-01T00:00:00.000Z");
  const ok = applySkillToolUse(record, { isError: false }, "2026-09-02T00:00:00.000Z");
  check(
    "applySkillToolUse 成功计数",
    ok.usageCount === 1 && ok.failureCount === 0 && ok.consecutiveFailures === 0 && ok.lastSuccessfulAt === "2026-09-02T00:00:00.000Z" && ok.lastUsedAt === "2026-09-02T00:00:00.000Z",
  );
  const err = applySkillToolUse(ok, { isError: true }, "2026-09-02T01:00:00.000Z");
  check(
    "applySkillToolUse 失败计数",
    err.usageCount === 2 && err.failureCount === 1 && err.consecutiveFailures === 1 && err.lastErrorAt === "2026-09-02T01:00:00.000Z",
  );
  const pending = createLifecycleRecord(PLUGIN, TOOL, "2026-07-01T00:00:00.000Z");
  pending.status = "retire-pending";
  pending.statusChangedAt = "2026-08-01T00:00:00.000Z";
  pending.retire = { reason: "idle", pendingAt: "2026-08-01T00:00:00.000Z", confirmedAt: null };
  const revived = applySkillToolUse(pending, { isError: false }, "2026-09-02T00:00:00.000Z");
  check(
    "applySkillToolUse retire-pending 真实使用 → active 并清 pending",
    revived.status === "active" && revived.retire.pendingAt === null && revived.retire.reason === null && revived.statusChangedAt === "2026-09-02T00:00:00.000Z",
  );
}

// ---------- 运行时 recordToolUse（fake ctx，temp 文件） ----------
const listeners = new Map();
const registeredTools = new Map();
const provided = {};
const settings = {
  register(ns, _schema, opts = {}) {
    let current = { ...(opts.base ?? {}) };
    return {
      get: () => ({ ...current }),
      watch: () => () => {},
      update: (patch) => { current = { ...current, ...patch }; return Promise.resolve(); },
    };
  },
  get: () => ({ enabled: true }),
  update: () => Promise.resolve(),
};
const toolsMock = {
  register(def) { registeredTools.set(def.name, def); return () => registeredTools.delete(def.name); },
  schemas() { return [...registeredTools.keys()].map((name) => ({ name, description: "", parameters: {} })); },
  get(name) { return registeredTools.get(name); },
};
registeredTools.set("create_plan", { name: "create_plan", execute: async () => ({ ok: true }) });
const mockKazMode = {
  pluginConfig: () => ({
    enabled: true,
    includeSubagents: false,
    reconstructionTools: [...DEFAULT_RECONSTRUCTION_TOOLS],
    skillAutoLifecycleEnabled: true,
    skillLifecycleUnusedDays: 60,
    skillLifecyclePendingDays: 7,
    skillLifecycleAuditIntervalHours: 24,
    skillLifecycleMaxAutoActions: 1,
  }),
  toolVisible: () => true,
  taskToolPoolOf: () => [TOOL],
};
const goalsMock = { get: () => undefined, create: () => undefined };
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
    if (deps.includes("settings")) setImmediate(() => cb({ ...base, settings }));
  },
  effect(fn) {
    const dispose = fn();
    return () => { if (typeof dispose === "function") dispose(); };
  },
  provide(name, value) { provided[name] = value; return () => { delete provided[name]; }; },
  get(name) {
    if (name in provided) return provided[name];
    if (name === "settings") return settings;
    if (name === "tools") return toolsMock;
    if (name === "kazMode") return mockKazMode;
    if (name === "goals") return goalsMock;
    if (name === "agents") return { roots: () => [], list: () => [], currentInitiator: () => undefined };
    if (name === "roundDisplay") return { report: () => {} };
    return undefined;
  },
  systemPrompt: { section() { return () => {}; } },
  tools: toolsMock,
};

const nowIso = "2026-09-02T00:00:00.000Z";
const initialLifecycle = {
  version: 2,
  updatedAt: nowIso,
  defaults: {},
  skills: {
    [KEY]: createLifecycleRecord(PLUGIN, TOOL, "2026-07-01T00:00:00.000Z"),
  },
};
writeFileSync(LIFECYCLE_FILE, JSON.stringify(initialLifecycle, null, 2) + "\n", "utf8");
writeFileSync(REGISTRY_FILE, JSON.stringify({ version: 1, plugins: { [PLUGIN]: { agentManaged: true, tools: [TOOL] } } }, null, 2) + "\n", "utf8");

await plugin.apply(base, {
  stageStore: STORE_FILE,
  lifecycleFile: LIFECYCLE_FILE,
  lifecycleAuditFile: AUDIT_FILE,
  agentManagedRegistryFile: REGISTRY_FILE,
  lifecycleBackupDir: join(TMP, "backups"),
});
await new Promise((resolve) => setTimeout(resolve, 20));
const service = provided["kaWhaleWorkflow"];
check("kaWhaleWorkflow.recordToolUse 可用", typeof service?.recordToolUse === "function");

const agent = { id: "s-usage", session: { id: "s-usage", events: [] } };
const parentToken = Symbol("parent");
check("运行时顶层成功调用返回 true 并落盘", service.recordToolUse({ name: TOOL, parent: undefined, agent }, { isError: false }) === true);
{
  const data = readLifecycle();
  const record = data.skills[KEY];
  check(
    "lifecycle 文件 usageCount=1 / lastUsedAt 已写",
    record.usageCount === 1 && typeof record.lastUsedAt === "string" && record.lastUsedAt.length > 0 && record.failureCount === 0,
  );
}
check("嵌套调用（parent）返回 false 不计数", service.recordToolUse({ name: TOOL, parent: parentToken, agent }, { isError: false }) === false);
{
  const data = readLifecycle();
  check("嵌套后 usageCount 仍为 1", data.skills[KEY].usageCount === 1);
}
check("未登记工具返回 false", service.recordToolUse({ name: "not_registered", parent: undefined, agent }, { isError: false }) === false);
check("失败调用返回 true 并累计失败", service.recordToolUse({ name: TOOL, parent: undefined, agent }, { isError: true }) === true);
{
  const data = readLifecycle();
  const record = data.skills[KEY];
  check(
    "失败调用 usageCount=2 failureCount=1 consecutiveFailures=1",
    record.usageCount === 2 && record.failureCount === 1 && record.consecutiveFailures === 1 && typeof record.lastErrorAt === "string",
  );
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nSKILL-USAGE PROBE OK" : `\nSKILL-USAGE PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
