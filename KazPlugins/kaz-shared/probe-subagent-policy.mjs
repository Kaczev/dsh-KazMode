// kaz-shared 探针：v0.9 B3 子代理四角色层。
// 运行：node KazPlugins/kaz-shared/probe-subagent-policy.mjs
// 验证：
//   - 角色常量只含 worker / memoryMaintainer / pluginMaintainer / pluginCreator；
//   - 每个角色有 Minimal、Stable Base、personaRef、toolFilter；
//   - 旧 toolCreator / retriever 不再被接受；
//   - assignedTools 来源 = tool-jobs + 可用私有插件候选，>6 提醒、>8 拒绝；
//   - 最终面 = role Stable Base + assignedTools；记忆写工具只进 memoryMaintainer。
import {
  V09_SUBAGENT_ROLE_IDS,
  V09_SUBAGENT_ROLE_MINIMAL_TOOLS,
  V09_SUBAGENT_ROLE_STABLE_BASE,
  V09_SUBAGENT_ROLE_PERSONA_REFS,
  V09_SUBAGENT_ROLE_TOOL_FILTERS,
  V09_TOOL_JOBS,
  normalizeV09Role,
  v09MinimalToolsForRole,
  v09StableBaseForRole,
  v09ToolFilterForRole,
  computeV09FinalSurface,
  resolveV09AssignedTools,
  v09AssignedToolsSubsetOfMain,
  assertV09RoleWriteToolRestrictions,
  SUBAGENT_MAINTENANCE_MEMORY_WRITE_TOOLS,
} from "./lib/subagent-policy.js";

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

const V09_ROLES = ["worker", "memoryMaintainer", "pluginMaintainer", "pluginCreator"];

// ---------- v0.9 角色常量 ----------
check("角色常量只含 v0.9 四值且冻结", Array.isArray(V09_SUBAGENT_ROLE_IDS) && Object.isFrozen(V09_SUBAGENT_ROLE_IDS) && JSON.stringify(V09_SUBAGENT_ROLE_IDS) === JSON.stringify(V09_ROLES));
check("每个角色均有 Minimal / Stable Base / personaRef / toolFilter", V09_ROLES.every((role) => Array.isArray(V09_SUBAGENT_ROLE_MINIMAL_TOOLS[role]) && Array.isArray(V09_SUBAGENT_ROLE_STABLE_BASE[role]) && typeof V09_SUBAGENT_ROLE_PERSONA_REFS[role] === "string" && Array.isArray(V09_SUBAGENT_ROLE_TOOL_FILTERS[role].allow)));
check("旧 toolCreator/retriever 被拒绝", normalizeV09Role("toolCreator") === null && normalizeV09Role("retriever") === null);
check("未知角色被拒绝", normalizeV09Role("attackerRole") === null);

// ---------- 深拷贝与投影 ----------
const stableWorker = v09StableBaseForRole("worker");
check("v09StableBaseForRole 返回深拷贝", stableWorker !== V09_SUBAGENT_ROLE_STABLE_BASE.worker);
const filter = v09ToolFilterForRole("memoryMaintainer");
check("v09ToolFilterForRole 返回深拷贝", filter.allow !== V09_SUBAGENT_ROLE_TOOL_FILTERS.memoryMaintainer.allow);

const final = computeV09FinalSurface({ role: "worker", assignedTools: ["job_list", "job_output", "job_list"] });
check("computeV09FinalSurface = Base + assignedTools（去重保留顺序）", final.includes("work_sub_whale_report") && final.includes("job_list") && final.includes("job_output") && final.filter((x) => x === "job_list").length === 1);

// ---------- assignedTools 来源 / 数量 / 角色限制 ----------
const candidateRegistry = {
  version: 2,
  candidates: [
    { tool: "safe_json_write", description: "safe write", source: "KazPrivatePlugins", available: true },
    { tool: "old_plugin_tool", description: "unavailable", source: "KazPrivatePlugins", available: false },
  ],
};
const okResolve = resolveV09AssignedTools({ role: "worker", assignedTools: ["safe_json_write", "job_list"], candidateRegistry });
check("assignedTools 接受 tool-jobs + 可用私有候选", okResolve.ok === true && okResolve.tools.includes("safe_json_write") && okResolve.tools.includes("job_list"));
const badSource = resolveV09AssignedTools({ role: "worker", assignedTools: ["old_plugin_tool"], candidateRegistry });
check("assignedTools 拒绝不可用/未知来源", badSource.ok === false && badSource.code === "assigned-tools-source-denied");
const over = resolveV09AssignedTools({ role: "worker", assignedTools: Array.from({ length: 9 }, (_, i) => `job_${i}`), candidateRegistry });
check("assignedTools >8 拒绝", over.ok === false && over.code === "assigned-tools-over-limit");
const manyTools = Array.from({ length: 7 }, (_, i) => (i === 0 ? "safe_json_write" : `cand_${i}`));
const warn = resolveV09AssignedTools({ role: "worker", assignedTools: manyTools, candidateRegistry, candidateTools: manyTools });
check("assignedTools >6 提醒、≤8 接受", warn.ok === true && warn.tools.length === 7 && typeof warn.warning === "string" && warn.warning.length > 0);

const subset = v09AssignedToolsSubsetOfMain(["read", "job_list", "safe_json_write"], ["job_list"]);
check("assignedTools 是主模型面子集", subset.ok === true && subset.extra.length === 0);
const writeDenied = assertV09RoleWriteToolRestrictions("worker", ["memory_search", "memory_save"]);
check("worker 不能持有记忆写工具", writeDenied.ok === false && writeDenied.denied.includes("memory_save"));
const writeAllowed = assertV09RoleWriteToolRestrictions("memoryMaintainer", [...V09_TOOL_JOBS, ...SUBAGENT_MAINTENANCE_MEMORY_WRITE_TOOLS]);
check("memoryMaintainer 可持有全部记忆写工具", writeAllowed.ok === true && writeAllowed.denied.length === 0);

if (failures === 0) {
  console.log("\nSUBAGENT-POLICY PROBE OK");
  process.exit(0);
} else {
  console.error(`\nSUBAGENT-POLICY PROBE FAILED: ${failures}`);
  process.exit(1);
}
