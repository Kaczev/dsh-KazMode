// ka-whale-workflow 探针：终案 E runLifecycleAudit 执行器。
// 覆盖：dryRun 不改文件；真实执行只取 maxAutoActions=1；每动作写审计 JSONL；
// retire 同步 registry 投影（B removed / A retained）；总开关关闭 → disabled；
// 生命周期损坏 → featureOff（无动作）。
// 运行：node KazPlugins/ka-whale-workflow/probe-skill-audit-runner.mjs
import plugin, {
  DEFAULT_RECONSTRUCTION_TOOLS,
  createLifecycleRecord,
} from "./lib/index.js";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

const TMP = mkdtempSync(join(tmpdir(), "whale-skill-audit-"));
const STORE_FILE = join(TMP, "stage.json");
const LIFECYCLE_FILE = join(TMP, "lifecycle.json");
const REGISTRY_FILE = join(TMP, "registry.json");
const AUDIT_FILE = join(TMP, "audit.jsonl");
const BACKUP_DIR = join(TMP, "backups");

const NOW = "2026-09-02T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const isoAgo = (days) => new Date(NOW_MS - days * 86400000).toISOString();

const PLUGIN_A = "kaz-skill-safe-json";
const TOOL_A = "safe_json_write";
const KEY_A = `${PLUGIN_A}/${TOOL_A}`;
const PLUGIN_B = "kaz-skill-other";
const TOOL_B = "other_tool";
const KEY_B = `${PLUGIN_B}/${TOOL_B}`;

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

const recordA = createLifecycleRecord(PLUGIN_A, TOOL_A, isoAgo(100));
const recordB = createLifecycleRecord(PLUGIN_B, TOOL_B, isoAgo(200));
recordB.status = "retire-pending";
recordB.statusChangedAt = isoAgo(10);
recordB.retire = { reason: "idle", pendingAt: isoAgo(10), confirmedAt: null };

const lifecycle = {
  version: 2,
  updatedAt: NOW,
  defaults: { unusedDaysBeforePending: 60, pendingGraceDays: 7 },
  skills: { [KEY_A]: recordA, [KEY_B]: recordB },
};
writeFileSync(LIFECYCLE_FILE, JSON.stringify(lifecycle, null, 2) + "\n", "utf8");
writeFileSync(
  REGISTRY_FILE,
  JSON.stringify(
    {
      version: 1,
      plugins: {
        [PLUGIN_A]: { agentManaged: true, tools: [TOOL_A] },
        [PLUGIN_B]: { agentManaged: true, tools: [TOOL_B] },
      },
    },
    null,
    2,
  ) + "\n",
  "utf8",
);

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
  pluginConfig: (agent) => {
    const off = agent?.id === "s-off";
    return {
      enabled: true,
      includeSubagents: false,
      reconstructionTools: [...DEFAULT_RECONSTRUCTION_TOOLS],
      skillAutoLifecycleEnabled: off ? false : true,
      skillLifecycleUnusedDays: 60,
      skillLifecyclePendingDays: 7,
      skillLifecycleAuditIntervalHours: 24,
      skillLifecycleMaxAutoActions: off ? 1 : 99, // 运行时必须钳制回 1
    };
  },
  toolVisible: () => true,
  taskToolPoolOf: () => [TOOL_A, TOOL_B],
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

await plugin.apply(base, {
  stageStore: STORE_FILE,
  lifecycleFile: LIFECYCLE_FILE,
  lifecycleAuditFile: AUDIT_FILE,
  agentManagedRegistryFile: REGISTRY_FILE,
  lifecycleBackupDir: BACKUP_DIR,
});
await new Promise((resolve) => setTimeout(resolve, 20));
const service = provided["kaWhaleWorkflow"];
check("kaWhaleWorkflow.runLifecycleAudit 可用", typeof service?.runLifecycleAudit === "function");

const agent = { id: "s-normal", session: { id: "s-normal", events: [] } };

// ① dryRun：建议动作正确且不改文件
{
  const before = readFileSync(LIFECYCLE_FILE, "utf8");
  const beforeRegistry = readFileSync(REGISTRY_FILE, "utf8");
  const result = service.runLifecycleAudit({ source: "manual", agent, dryRun: true });
  check(
    "dryRun 返回两条建议（retire-pending A / retired B）",
    result.ok === true &&
      result.dryRun === true &&
      result.actions.some((a) => a.type === "retire-pending" && a.key === KEY_A) &&
      result.actions.some((a) => a.type === "retire" && a.key === KEY_B),
  );
  check(
    "dryRun 不改 lifecycle/registry/audit",
    readFileSync(LIFECYCLE_FILE, "utf8") === before &&
      readFileSync(REGISTRY_FILE, "utf8") === beforeRegistry &&
      !existsSync(AUDIT_FILE),
  );
}

// ② 真实执行：即使配置给 max=99 也只执行 1 个动作
{
  const result = service.runLifecycleAudit({ source: "manual", agent, dryRun: false });
  check(
    "真实执行 executed.length=1（maxAutoActions 钳制 1）且先处理 A",
    result.ok === true &&
      result.dryRun === false &&
      result.executed.length === 1 &&
      result.executed[0].type === "retire-pending" &&
      result.executed[0].key === KEY_A,
  );
  const data = readJson(LIFECYCLE_FILE);
  check(
    "真实执行后 A=retire-pending、B 仍 retire-pending",
    data.skills[KEY_A].status === "retire-pending" &&
      data.skills[KEY_B].status === "retire-pending",
  );
  check("audit JSONL 已追加 1 行", existsSync(AUDIT_FILE) && readFileSync(AUDIT_FILE, "utf8").trim().split(/\r?\n/).filter(Boolean).length === 1);
}

// ③ 第二轮：执行 B retire，并同步 registry 投影
{
  const result = service.runLifecycleAudit({ source: "manual", agent, dryRun: false });
  check(
    "第二轮执行 B retire",
    result.ok === true &&
      result.executed.length === 1 &&
      result.executed[0].type === "retire" &&
      result.executed[0].key === KEY_B,
  );
  const data = readJson(LIFECYCLE_FILE);
  const registry = readJson(REGISTRY_FILE);
  check(
    "B retired 从 registry 移除，A 保留（plugin 条目保留）",
    data.skills[KEY_B].status === "retired" &&
      registry.plugins[PLUGIN_B]?.agentManaged === true &&
      (registry.plugins[PLUGIN_B]?.tools ?? []).length === 0 &&
      registry.plugins[PLUGIN_A]?.tools.includes(TOOL_A) === true,
  );
  const auditLines = readFileSync(AUDIT_FILE, "utf8").trim().split(/\r?\n/).filter(Boolean);
  check(
    "audit 累计 2 行且含 backups/rollback 字段",
    auditLines.length === 2 &&
      auditLines.every((line) => {
        const entry = JSON.parse(line);
        return entry.ok === true && Array.isArray(entry.backups) && typeof entry.rollback === "string";
      }),
  );
}

// ④ 总开关关闭 / 生命周期损坏 → feature off
{
  const offAgent = { id: "s-off", session: { id: "s-off", events: [] } };
  const disabled = service.runLifecycleAudit({ source: "manual", agent: offAgent, dryRun: false });
  check("skillAutoLifecycleEnabled=false → disabled", disabled.ok === false && disabled.disabled === true && disabled.actions.length === 0);
  writeFileSync(LIFECYCLE_FILE, "{ broken", "utf8");
  const broken = service.runLifecycleAudit({ source: "manual", agent, dryRun: false });
  check("lifecycle 损坏 → featureOff 无动作", broken.ok === false && broken.featureOff === true && broken.actions.length === 0);
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nSKILL-AUDIT-RUNNER PROBE OK" : `\nSKILL-AUDIT-RUNNER PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
