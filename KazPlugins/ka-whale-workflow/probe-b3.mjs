// ka-whale-workflow v0.9 B3 探针：受控委派投影 + 候选注册表 + role surface。
// 运行：node KazPlugins/ka-whale-workflow/probe-b3.mjs
import plugin from "./lib/index.js";
import { createTaskPlanStore, resolvePlanItemForDelegation } from "./lib/task-plan-store.js";
import {
  V09_SUBAGENT_ROLE_IDS,
  V09_SUBAGENT_ROLE_MINIMAL_TOOLS,
  V09_SUBAGENT_ROLE_STABLE_BASE,
  V09_SUBAGENT_ROLE_PERSONA_REFS,
  V09_SUBAGENT_ROLE_TOOL_FILTERS,
  V09_TOOL_JOBS,
  computeV09FinalSurface,
  resolveV09AssignedTools,
  normalizeAgentManagedCandidateRegistry,
  availablePrivatePluginCandidateToolNames,
  upsertPrivatePluginCandidate,
  removePrivatePluginCandidate,
} from "../kaz-shared/lib/subagent-policy.js";
import { KAZ_V09_MAIN_TOOLS, KAZ_V09_SUBAGENT_ROLE_TOOLS } from "../kaz-shared/lib/tool-lists.js";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

const TMP = mkdtempSync(join(tmpdir(), "whale-b3-"));
const STORE_FILE = join(TMP, "stage.json");
const PLAN_FILE = join(TMP, "plan.json");
const REG_FILE = join(TMP, "kaz-agent-managed-tools.json");

const CANDIDATE_NAMES = [
  "safe_json_write",
  "plugin_alpha",
  "plugin_beta",
  "plugin_gamma",
  "plugin_delta",
  "plugin_epsilon",
  "plugin_zeta",
  "plugin_eta",
  "plugin_theta",
];
const REGISTRY = {
  version: 2,
  plugins: {},
  candidates: CANDIDATE_NAMES.map((tool) => ({
    tool,
    description: `Private plugin candidate ${tool}`,
    source: `KazPrivatePlugins/${tool}`,
    available: true,
  })),
};
writeFileSync(REG_FILE, JSON.stringify(REGISTRY, null, 2), "utf8");

// ---------- pure layer: roles ----------
check("v0.9 角色固定集合只含四值", JSON.stringify(V09_SUBAGENT_ROLE_IDS) === JSON.stringify(["worker", "memoryMaintainer", "pluginMaintainer", "pluginCreator"]));
check("四个角色均有 Minimal / Stable Base / personaRef / toolFilter", V09_SUBAGENT_ROLE_IDS.every((role) =>
  Array.isArray(V09_SUBAGENT_ROLE_MINIMAL_TOOLS[role]) &&
  Array.isArray(V09_SUBAGENT_ROLE_STABLE_BASE[role]) &&
  typeof V09_SUBAGENT_ROLE_PERSONA_REFS[role] === "string" &&
  V09_SUBAGENT_ROLE_TOOL_FILTERS[role]?.allow !== undefined,
));
check("worker Minimal 含 report", JSON.stringify(V09_SUBAGENT_ROLE_MINIMAL_TOOLS.worker) === JSON.stringify(["memory_search", "work_sub_whale_report"]));
check("memoryMaintainer Minimal 含 memory_sub_whale_report", V09_SUBAGENT_ROLE_MINIMAL_TOOLS.memoryMaintainer.includes("memory_sub_whale_report"));
check("pluginMaintainer Minimal 从 read + report 开始", JSON.stringify(V09_SUBAGENT_ROLE_MINIMAL_TOOLS.pluginMaintainer) === JSON.stringify(["read", "plugin_maintainer_sub_whale_report"]));
check("pluginCreator Minimal 从 read + report 开始", JSON.stringify(V09_SUBAGENT_ROLE_MINIMAL_TOOLS.pluginCreator) === JSON.stringify(["read", "plugin_creator_sub_whale_report"]));
check("worker Stable Base 不含 memory_save/update/forget", ["memory_save", "memory_update", "memory_forget"].every((tool) => !V09_SUBAGENT_ROLE_STABLE_BASE.worker.includes(tool)));
check("worker Stable Base 含 work_sub_whale_report", V09_SUBAGENT_ROLE_STABLE_BASE.worker.includes("work_sub_whale_report"));
check("memoryMaintainer Stable Base 含全部记忆写工具", ["memory_save", "memory_update", "memory_forget"].every((tool) => V09_SUBAGENT_ROLE_STABLE_BASE.memoryMaintainer.includes(tool)));
check("v0.9 四角色 Stable Base 均常驻 whale_expand（worker 13 / memoryMaintainer 11 / plugin* 9）", V09_SUBAGENT_ROLE_IDS.every((role) => V09_SUBAGENT_ROLE_STABLE_BASE[role].includes("whale_expand")) && V09_SUBAGENT_ROLE_STABLE_BASE.worker.length === 13 && V09_SUBAGENT_ROLE_STABLE_BASE.memoryMaintainer.length === 11 && V09_SUBAGENT_ROLE_STABLE_BASE.pluginMaintainer.length === 9 && V09_SUBAGENT_ROLE_STABLE_BASE.pluginCreator.length === 9);
check("tool-lists KAZ_V09_SUBAGENT_ROLE_TOOLS 与 v09 Stable Base 一致", JSON.stringify(KAZ_V09_SUBAGENT_ROLE_TOOLS) === JSON.stringify(V09_SUBAGENT_ROLE_STABLE_BASE));
check("tool-jobs 固定集合", JSON.stringify(V09_TOOL_JOBS) === JSON.stringify(["job_list", "job_output", "job_kill"]));

// ---------- pure layer: candidate registry v2 ----------
{
  const normalized = normalizeAgentManagedCandidateRegistry(REGISTRY);
  check("候选 registry 保留 version 2 + plugins + candidates", normalized.version === 2 && Object.keys(normalized.plugins).length === 0 && normalized.candidates.length === CANDIDATE_NAMES.length);
  check("availablePrivatePluginCandidateToolNames 返回全部 available", JSON.stringify(availablePrivatePluginCandidateToolNames(normalized)) === JSON.stringify(CANDIDATE_NAMES));
  const upserted = upsertPrivatePluginCandidate(normalized, { tool: "safe_json_write", description: "Updated", source: "KazPrivatePlugins/x", available: true });
  check("upsert 更新已有候选", upserted.candidates.find((c) => c.tool === "safe_json_write")?.description === "Updated");
  const removed = removePrivatePluginCandidate(upserted, "safe_json_write");
  check("remove 删除候选", !removed.candidates.some((c) => c.tool === "safe_json_write"));
}

// ---------- pure layer: assignedTools validation ----------
{
  const ok = resolveV09AssignedTools({ role: "worker", assignedTools: ["job_list", "safe_json_write"], candidateRegistry: REGISTRY });
  check("assignedTools 接受 tool-jobs + 私有插件候选", ok.ok === true && ok.tools.length === 2);
  const bad = resolveV09AssignedTools({ role: "worker", assignedTools: ["unknown_tool"], candidateRegistry: REGISTRY });
  check("assignedTools 拒绝非来源工具", bad.ok === false && bad.code === "assigned-tools-source-denied");
  const over = resolveV09AssignedTools({ role: "worker", assignedTools: [...CANDIDATE_NAMES, "job_list"], candidateRegistry: REGISTRY });
  check("assignedTools >8 拒绝", over.ok === false && over.code === "assigned-tools-over-limit");
  const seven = CANDIDATE_NAMES.slice(0, 7);
  const warn = resolveV09AssignedTools({ role: "worker", assignedTools: seven, candidateRegistry: REGISTRY });
  check("assignedTools >6 返回提醒但接受", warn.ok === true && typeof warn.warning === "string" && warn.warning.length > 0);
}

// ---------- pure layer: final surface subset ----------
{
  const finalSurface = computeV09FinalSurface({ role: "worker", assignedTools: ["job_list", "safe_json_write"] });
  check("final surface = worker Stable Base + assignedTools", finalSurface.includes("work_sub_whale_report") && finalSurface.includes("job_list") && finalSurface.includes("safe_json_write"));
  const extra = finalSurface.filter(
    (tool) =>
      ![
        ...KAZ_V09_MAIN_TOOLS,
        "work_sub_whale_report",
        "memory_sub_whale_report",
        "plugin_maintainer_sub_whale_report",
        "plugin_creator_sub_whale_report",
        ...V09_TOOL_JOBS,
        ...CANDIDATE_NAMES,
      ].includes(tool),
  );
  check("final surface 是主面 ∪ role report ∪ assigned 来源的子集", extra.length === 0);
}

// ---------- plugin-level: ka_sub_whale actual continuable creation ----------
const listeners = new Map();
const registeredTools = new Map();
const capturedStarts = [];
const capturedReports = [];
const settings = {
  register(ns, _schema, opts = {}) {
    let current = { ...(opts.base ?? {}) };
    return {
      get: () => ({ ...current }),
      watch: () => () => {},
      update: (patch) => { current = { ...current, ...patch }; return Promise.resolve(); },
    };
  },
  get: () => ({ enabled: true, includeSubagents: false }),
  update: () => Promise.resolve(),
};
const toolsMock = {
  register(def) {
    registeredTools.set(def.name, def);
    return () => registeredTools.delete(def.name);
  },
  schemas() {
    return [...registeredTools.keys()].map((name) => ({ name, description: "", parameters: {} }));
  },
  get(name) {
    return registeredTools.get(name);
  },
};
const mockKazMode = {
  pluginConfig: () => ({ enabled: true, includeSubagents: false }),
  toolVisible: () => true,
};
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
  provide() { return () => {}; },
  get(name) {
    if (name === "settings") return settings;
    if (name === "tools") return toolsMock;
    if (name === "kazMode") return mockKazMode;
    if (name === "goals") return { get: () => undefined };
    if (name === "roundDisplay") return { report: () => {} };
    if (name === "subagents") {
      return {
        startContinuable: async (spec) => {
          let roleAtStart = null;
          try {
            const raw = readFileSync(STORE_FILE, "utf8").replace(/^\uFEFF/, "");
            roleAtStart = JSON.parse(raw).subagentRoles?.[spec?.childId] ?? null;
          } catch {
            roleAtStart = null;
          }
          capturedStarts.push({ spec, roleAtStart });
          // The real continuable-subagent service honors the caller-reserved id;
          // the mock echoes it so the probe mirrors the production contract.
          return { childId: spec.childId };
        },
        reportFrom: async (child, content, options) => {
          capturedReports.push({ child, content, options });
          return "report-1";
        },
      };
    }
    return undefined;
  },
  systemPrompt: { section() { return () => {}; } },
  tools: toolsMock,
};

// Pre-populate a finalized task plan.
const planStore = createTaskPlanStore(PLAN_FILE);
planStore.persistDraftItems([
  { planItemId: "p1", persona: "worker", task: "Worker task with candidate tool", assignedTools: ["safe_json_write"] },
  { planItemId: "p2", persona: "worker", task: "Invalid assigned source", assignedTools: ["not_allowed"] },
  { planItemId: "p3", persona: "worker", task: "Over limit", assignedTools: [...CANDIDATE_NAMES, "job_list"] },
  { planItemId: "p4", persona: "worker", task: "Warn count", assignedTools: CANDIDATE_NAMES.slice(0, 7) },
]);
planStore.persistFinalPayload({
  status: "finalized",
  items: [
    { planItemId: "p1", persona: "worker", task: "Worker task with candidate tool", assignedTools: ["safe_json_write"] },
    { planItemId: "p2", persona: "worker", task: "Invalid assigned source", assignedTools: ["not_allowed"] },
    { planItemId: "p3", persona: "worker", task: "Over limit", assignedTools: [...CANDIDATE_NAMES, "job_list"] },
    { planItemId: "p4", persona: "worker", task: "Warn count", assignedTools: CANDIDATE_NAMES.slice(0, 7) },
  ],
});

await plugin.apply(base, {
  stageStore: STORE_FILE,
  taskPlanStore: PLAN_FILE,
  agentManagedRegistryFile: REG_FILE,
  lifecyclePath: join(TMP, "PLUGIN_LIFECYCLE.md"),
});
await new Promise((resolve) => setTimeout(resolve, 20));

const agent = { id: "s-b3-main", session: { id: "s-b3-main", events: [] } };
const signal = new AbortController().signal;
const kaSubWhale = registeredTools.get("ka_sub_whale");

{
  const result = await kaSubWhale.execute({ planItemId: "p1" }, { agent, signal });
  const start = capturedStarts[0];
  const childId = start?.spec?.childId;
  check("ka_sub_whale 创建 continuable child", result.ok === true && result.code === "subagent-created" && result.subagentId === childId);
  check("返回 persona/task/finalSurface 来自 plan", result.persona === "worker" && result.finalSurface.includes("work_sub_whale_report") && result.finalSurface.includes("safe_json_write"));
  check("startContinuable 使用 caller-reserved childId", typeof childId === "string" && childId.length > 0 && start?.spec?.childId === result.subagentId);
  check("stage store 在 startContinuable 前已有 child 角色记录", start?.roleAtStart?.persona === "worker" && start?.roleAtStart?.finalTools?.includes("safe_json_write") && start?.roleAtStart?.planItemId === "p1");
  check("startContinuable 使用 provider spawn + maxDepth 1 + persona + toolFilter", start?.spec?.provider === "spawn" && start?.spec?.request?.maxDepth === 1 && typeof start?.spec?.request?.persona === "string" && Array.isArray(start?.spec?.request?.toolFilter?.allow));
  const stored = JSON.parse(readFileSync(STORE_FILE, "utf8")).subagentRoles?.[childId];
  check("stage store 记录 child 角色面", stored?.persona === "worker" && stored?.finalTools?.includes("safe_json_write"));
}
{
  const bad = await kaSubWhale.execute({ planItemId: "p2" }, { agent, signal });
  check("非来源 assignedTools 结构化拒绝", bad.ok === false && bad.code === "assigned-tools-source-denied");
}
{
  const over = await kaSubWhale.execute({ planItemId: "p3" }, { agent, signal });
  check(">8 assignedTools 结构化拒绝", over.ok === false && over.code === "assigned-tools-over-limit");
}
{
  const warn = await kaSubWhale.execute({ planItemId: "p4" }, { agent, signal });
  check(">6 assignedTools 创建并返回 warning", warn.ok === true && typeof warn.warning === "string" && warn.warning.length > 0);
}
{
  const missing = await kaSubWhale.execute({ planItemId: "missing" }, { agent, signal });
  check("无效 planItemId 继续结构化拒绝", missing.ok === false && missing.code === "plan-item-not-found");
}
{
  const childId = capturedStarts[0]?.spec?.childId;
  const childAgent = { id: childId, session: { id: childId, events: [] } };
  const reportDef = registeredTools.get("work_sub_whale_report");
  const reportResult = await reportDef.execute({ output: "Work complete." }, { agent: childAgent, signal });
  check("*_sub_whale_report 真实调用 reportFrom（非空壳）", reportResult?.messageId === "report-1" && capturedReports.length === 1);
  check("*_sub_whale_report 传 delivery=next-step", capturedReports[0]?.options?.delivery === "next-step");
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nB3 PROBE OK" : `\nB3 PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
