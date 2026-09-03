// kaz-shared 探针：Kaz 6.0 Step 2 子代理 toolFilter 白名单投影。
// 运行：node KazPlugins/kaz-shared/probe-subagent-policy.mjs
// 验证：
//   - toolFilter 来自角色固定白名单（工具实例/provider request 层）；
//   - 主线全量面 vs 子代理受限子集：子代理面 ⊆ 主线全量面；
//   - 记忆写工具只进入 memoryMaintainer，不进 retriever / toolCreator；
//   - 模型不可通过 toolFilterForRole 传入任意允许清单。
import {
  SUBAGENT_ROLE_IDS,
  SUBAGENT_ROLE_INSTANCES,
  SUBAGENT_ROLE_TOOL_FILTERS,
  SUBAGENT_ROLE_MEMORY_READ_TOOLS,
  SUBAGENT_MAINTENANCE_MEMORY_WRITE_TOOLS,
  normalizeToolNameList,
  normalizeSubagentRole,
  toolFilterForRole,
  projectTaskWhitelist,
  assertSubsetOf,
} from "./lib/subagent-policy.js";

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

const MAINTENANCE_WRITES = SUBAGENT_MAINTENANCE_MEMORY_WRITE_TOOLS;
const MEMORY_READS = SUBAGENT_ROLE_MEMORY_READ_TOOLS;

// ---------- 角色常量 ----------
check("角色常量齐全且冻结", Array.isArray(SUBAGENT_ROLE_IDS) && Object.isFrozen(SUBAGENT_ROLE_IDS) && SUBAGENT_ROLE_INSTANCES !== undefined && Object.isFrozen(SUBAGENT_ROLE_INSTANCES));
check("三个角色均有独立 toolName", SUBAGENT_ROLE_IDS.every((role) => typeof SUBAGENT_ROLE_INSTANCES[role]?.toolName === "string" && SUBAGENT_ROLE_INSTANCES[role].toolName.length > 0));
check("memoryMaintainer toolName = maintenance_subagent", SUBAGENT_ROLE_INSTANCES.memoryMaintainer.toolName === "maintenance_subagent");
check("toolFilter 映射冻结且 allow 均为数组", SUBAGENT_ROLE_IDS.every((role) => Object.isFrozen(SUBAGENT_ROLE_TOOL_FILTERS[role]) && Array.isArray(SUBAGENT_ROLE_TOOL_FILTERS[role].allow) && Object.isFrozen(SUBAGENT_ROLE_TOOL_FILTERS[role].allow)));
check("模型不可扩展角色", normalizeSubagentRole("attackerRole") === null);

// ---------- 主线全量面 vs 子代理受限子集 ----------
const MAIN_FULL_SURFACE = normalizeToolNameList([
  "ask_user_question",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "pwsh",
  "todo_write",
  "web_search",
  "safe_json_write",
  ...MEMORY_READS,
  ...MAINTENANCE_WRITES,
]);
const RETRIEVER_FILTER = toolFilterForRole("retriever");
const subset = assertSubsetOf(MAIN_FULL_SURFACE, RETRIEVER_FILTER.allow);
check("retriever 子代理面是主线全量面子集", subset.ok === true);
check("retriever 白名单只含记忆读工具", RETRIEVER_FILTER.allow.length === 3 && MEMORY_READS.every((tool) => RETRIEVER_FILTER.allow.includes(tool)));
check("retriever 不含任何记忆写工具", !MAINTENANCE_WRITES.some((tool) => RETRIEVER_FILTER.allow.includes(tool)));
check("toolCreator 不含任何记忆工具", !toolFilterForRole("toolCreator").allow.some((tool) => [...MEMORY_READS, ...MAINTENANCE_WRITES].includes(tool)));
check("memoryMaintainer 含全部记忆写工具", MAINTENANCE_WRITES.every((tool) => toolFilterForRole("memoryMaintainer").allow.includes(tool)));
check("memoryMaintainer 含 safe_json_write 等维护能力", ["safe_json_write", "read", "pwsh"].every((tool) => toolFilterForRole("memoryMaintainer").allow.includes(tool)));

// ---------- 固定 toolFilter 不是模型可随意填写的参数 ----------
let rejectedUnknownRole = false;
try {
  toolFilterForRole("modelSuppliedRole");
} catch {
  rejectedUnknownRole = true;
}
check("未知角色抛错（配置层错误，不是模型输入通道）", rejectedUnknownRole === true);
const first = toolFilterForRole("memoryMaintainer");
const second = toolFilterForRole("memoryMaintainer");
check("toolFilterForRole 返回深拷贝（防调用方改共享冻结面）", first !== second && first.allow !== second.allow);
first.allow.push("__hack__");
check("改返回副本不影响下一次读取", !toolFilterForRole("memoryMaintainer").allow.includes("__hack__"));

// ---------- 任务允许子集投影 ----------
const projected = projectTaskWhitelist({
  role: "memoryMaintainer",
  taskAllowedTools: ["memory_search", "memory_save", "read", "pwsh", "unknown_tool"],
});
check("projectTaskWhitelist 只保留任务允许 ∩ 角色白名单", projected.allow.length === 4 && ["memory_search", "memory_save", "read", "pwsh"].every((tool) => projected.allow.includes(tool)));
check("projectTaskWhitelist 不含任务外/未知工具", !projected.allow.includes("unknown_tool") && !projected.allow.includes("memory_update"));
const unprojected = projectTaskWhitelist({ role: "retriever" });
check("未给 taskAllowedTools 时返回角色全量（受控编排层专用）", unprojected.allow.length === 3 && unprojected.allow.includes("memory_search"));
let rejectedBadProjection = false;
try {
  projectTaskWhitelist({ role: "bad", taskAllowedTools: ["memory_search"] });
} catch {
  rejectedBadProjection = true;
}
check("非法角色投影抛错", rejectedBadProjection === true);

if (failures === 0) {
  console.log("\nSUBAGENT-POLICY PROBE OK");
  process.exit(0);
} else {
  console.error(`\nSUBAGENT-POLICY PROBE FAILED: ${failures}`);
  process.exit(1);
}
