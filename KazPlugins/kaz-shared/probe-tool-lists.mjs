// kaz-shared 探针：验证 tool-lists.js 的工具清单单一事实源。
// 运行：node kaz-shared/probe-tool-lists.mjs
import {
  DEFAULT_TOOL_WHITELIST,
  DEFAULT_FIRST_ROUND_TOOLS,
  DEFAULT_DISABLED_TOOLS,
  MANAGED_PLUGINS,
  FIXED_PERSONA,
  registerGroup,
  setGroupEnabled,
  unregisterGroup,
  hasGroup,
  listGroups,
  enabledGroupTools,
  disabledGroupTools,
  effectiveToolWhitelist,
  computeSurface,
} from "./lib/tool-lists.js";

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

// ① 常量齐全（单一事实源：各处副本都已删除；无 DEFAULT_MINIMAL_TOOLS）
check("① DEFAULT_FIRST_ROUND_TOOLS 存在", Array.isArray(DEFAULT_FIRST_ROUND_TOOLS) && DEFAULT_FIRST_ROUND_TOOLS.length === 2);
check("① DEFAULT_DISABLED_TOOLS 存在", Array.isArray(DEFAULT_DISABLED_TOOLS) && DEFAULT_DISABLED_TOOLS.includes("tool-cordis"));
check("① DEFAULT_TOOL_WHITELIST 存在（不含记忆工具——它们由群组管理）", Array.isArray(DEFAULT_TOOL_WHITELIST) && DEFAULT_TOOL_WHITELIST.includes("pwsh") && !DEFAULT_TOOL_WHITELIST.some((t) => t.startsWith("memory_")) && !DEFAULT_TOOL_WHITELIST.includes("kaz_mode_status"));
check("① MANAGED_PLUGINS / FIXED_PERSONA 存在", Array.isArray(MANAGED_PLUGINS) && typeof FIXED_PERSONA === "string");
check("① 已移除 DEFAULT_MINIMAL_TOOLS", !("DEFAULT_MINIMAL_TOOLS" in (await import("./lib/tool-lists.js"))));

// ② 群组注册 API（"发信"）
check("② 初始无群组", listGroups().length === 0 && hasGroup("p-memory") === false);
registerGroup("p-memory", { tools: ["memory_save", "memory_search"], label: "test-memory" });
check("② registerGroup 后已声明", hasGroup("p-memory") && listGroups().length === 1);
check("② 声明时 enabled 默认 false", listGroups().find((g) => g.id === "p-memory").enabled === false);
check("② 声明时 enabled=false → 工具不算启用集", enabledGroupTools().length === 0 && disabledGroupTools().includes("memory_save"));
setGroupEnabled("p-memory", true);
check("② setGroupEnabled(true) 后进入启用集", enabledGroupTools().includes("memory_save") && disabledGroupTools().length === 0);
setGroupEnabled("p-memory", false);
check("② setGroupEnabled(false) 后回到停用集", !enabledGroupTools().includes("memory_save") && disabledGroupTools().includes("memory_search"));
registerGroup("p-diag", { tools: ["kaz_mode_status"], enabled: true });
check("② registerGroup 可直接带 enabled: true", enabledGroupTools().includes("kaz_mode_status"));
unregisterGroup("p-memory");
unregisterGroup("p-diag");
check("② unregisterGroup 后清空", listGroups().length === 0 && enabledGroupTools().length === 0);

// ③ effectiveToolWhitelist：用户白名单 ∪ 已启用群组 − 已停用群组
registerGroup("p-memory", { tools: ["memory_save", "memory_list", "memory_search", "memory_update", "memory_detail", "memory_forget"], label: "test-memory" });
setGroupEnabled("p-memory", true);
registerGroup("p-diag", { tools: ["kaz_mode_status"] }); // 保持停用
const userWhitelist = [...DEFAULT_TOOL_WHITELIST, "memory_save", "memory_update"];
const eff = effectiveToolWhitelist(userWhitelist);
check("③ 已启用群组的工具被加入（即使不在白名单）", eff.includes("memory_search") && eff.includes("memory_forget"));
check("③ 已停用群组的工具被排除（即使在白名单里）", !eff.includes("kaz_mode_status") && eff.includes("memory_save"));
check("③ 白名单其余条目保留", eff.includes("pwsh") && eff.includes("read") && eff.includes("memory_update"));
check("③ 去重且有序", new Set(eff).size === eff.length);
setGroupEnabled("p-memory", false);
const eff2 = effectiveToolWhitelist(userWhitelist);
check("③ 停用后群组工具全部排除（白名单也救不回来）", !eff2.some((t) => t.startsWith("memory_")));
unregisterGroup("p-memory");
unregisterGroup("p-diag");

// ④ computeSurface：首阶段仅 firstRoundTools（无 minimalTools、无交集）；
//    全量 = effectiveToolWhitelist
registerGroup("p-memory", { tools: ["memory_save", "memory_search"] });
setGroupEnabled("p-memory", true);
const full = computeSurface({
  toolWhitelist: [...DEFAULT_TOOL_WHITELIST, "memory_save"],
  minimalPhase: false,
  firstRoundTools: ["pwsh", "str_replace_editor"],
});
check("④ 全量阶段 = 有效白名单（含启用群组）", full.has("pwsh") && full.has("edit") && full.has("read") && full.has("memory_search") && full.has("memory_save"));
const first = computeSurface({
  toolWhitelist: DEFAULT_TOOL_WHITELIST,
  minimalPhase: true,
  firstRoundTools: ["pwsh", "str_replace_editor"],
});
check("④ 首阶段仅保留 firstRoundTools（无交集、无 minimal 掺入）", first.size === 2 && first.has("pwsh") && first.has("str_replace_editor") && !first.has("read"));
const firstFallback = computeSurface({
  toolWhitelist: DEFAULT_TOOL_WHITELIST,
  minimalPhase: true,
  firstRoundTools: [],
});
check("④ 首阶段 firstRoundTools 为空时回退 DEFAULT_FIRST_ROUND_TOOLS", firstFallback.has("pwsh") && firstFallback.has("str_replace_editor") && firstFallback.size === DEFAULT_FIRST_ROUND_TOOLS.length);
unregisterGroup("p-memory");
const noMinimal = computeSurface({ minimalPhase: false, toolWhitelist: ["read"] });
check("④ 全量阶段 = 有效白名单（无多余工具）", noMinimal.has("read") && noMinimal.size === 1);

console.log(failures === 0 ? "\nKAZ-SHARED PROBE OK" : `\nKAZ-SHARED PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
