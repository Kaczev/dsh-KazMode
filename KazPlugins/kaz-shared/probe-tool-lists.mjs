// kaz-shared 探针：验证 tool-lists.js 的工具清单单一事实源。
// 运行：node kaz-shared/probe-tool-lists.mjs
import {
  TOOL_WHITELIST,
  DEFAULT_FIRST_ROUND_TOOLS,
  DEFAULT_DISABLED_TOOLS,
  MANAGED_PLUGINS,
  FIXED_PERSONA,
  effectiveToolWhitelist,
  computeSurface,
} from "./lib/tool-lists.js";

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

// ① 常量齐全（单一事实源：各处副本都已删除）
check("① DEFAULT_FIRST_ROUND_TOOLS = [memory_search]（首轮先查记忆）", Array.isArray(DEFAULT_FIRST_ROUND_TOOLS) && DEFAULT_FIRST_ROUND_TOOLS.length === 1 && DEFAULT_FIRST_ROUND_TOOLS[0] === "memory_search");
check("① DEFAULT_DISABLED_TOOLS 存在", Array.isArray(DEFAULT_DISABLED_TOOLS) && DEFAULT_DISABLED_TOOLS.includes("tool-cordis"));
check("① MANAGED_PLUGINS / FIXED_PERSONA 存在", Array.isArray(MANAGED_PLUGINS) && typeof FIXED_PERSONA === "string");
const exports0 = await import("./lib/tool-lists.js");
check("① 已移除群组 API / DEFAULT_ 前缀常量", !("registerGroup" in exports0) && !("DEFAULT_TOOL_WHITELIST" in exports0) && !("DEFAULT_MINIMAL_TOOLS" in exports0));

// ② TOOL_WHITELIST：Kaz 模式下允许出现的全部工具（含记忆六工具与诊断工具）
const SIX_MEMORY = ["memory_save", "memory_list", "memory_search", "memory_detail", "memory_update", "memory_forget"];
check("② TOOL_WHITELIST 含基础工具", ["pwsh", "read", "write", "edit", "glob", "grep", "web_search"].every((t) => TOOL_WHITELIST.includes(t)));
check("② TOOL_WHITELIST 含记忆六工具", SIX_MEMORY.every((t) => TOOL_WHITELIST.includes(t)));
check("② TOOL_WHITELIST 含诊断工具 kaz_mode_status", TOOL_WHITELIST.includes("kaz_mode_status"));
const REMOVED_2026_08_21 = ["read_image", "ralph", "workflow", "create_goal", "get_goal", "update_goal", "str_replace_editor"];
check("② 已按 2026-08-21 决定移除 read_image/ralph/workflow/goal/str_replace_editor", REMOVED_2026_08_21.every((t) => !TOOL_WHITELIST.includes(t)));
check("② web_search 保留（复用 DeepSeek key，实测可用）", TOOL_WHITELIST.includes("web_search"));
check("② TOOL_WHITELIST 去重且有序", new Set(TOOL_WHITELIST).size === TOOL_WHITELIST.length);

// ③ effectiveToolWhitelist：白名单是唯一闸门（原样去重，不做任何加减）
const userList = ["pwsh", "edit", "web_search", "pwsh"];
const eff = effectiveToolWhitelist(userList);
check("③ 用户白名单原样生效（去重）", eff.length === 3 && eff.includes("pwsh") && eff.includes("edit") && eff.includes("web_search"));
check("③ 不在白名单的工具不进入（哪怕被注册也无所谓——闸门只认清单）", !eff.includes("memory_save"));
const withMemory = effectiveToolWhitelist([...userList, "memory_search", "kaz_mode_status"]);
check("③ 白名单含记忆/诊断工具时它们进入有效白名单", withMemory.includes("memory_search") && withMemory.includes("kaz_mode_status"));
const fallback = effectiveToolWhitelist([]);
check("③ 白名单缺失/为空时回退 TOOL_WHITELIST", fallback.length === TOOL_WHITELIST.length && fallback.every((t) => TOOL_WHITELIST.includes(t)));

// ④ computeSurface：首阶段仅 firstRoundTools（无交集、无 minimalTools）；
//    全量 = effectiveToolWhitelist
const full = computeSurface({
  toolWhitelist: [...TOOL_WHITELIST],
  minimalPhase: false,
  firstRoundTools: ["memory_search"],
});
check("④ 全量阶段 = 有效白名单（含记忆/诊断工具）", full.has("pwsh") && full.has("read") && full.has("memory_search") && full.has("kaz_mode_status"));
const restricted = computeSurface({ toolWhitelist: ["pwsh", "edit"], minimalPhase: false });
check("④ 用户收窄白名单后全量阶段只含清单内工具", restricted.size === 2 && restricted.has("pwsh") && restricted.has("edit") && !restricted.has("memory_search"));
const first = computeSurface({
  toolWhitelist: TOOL_WHITELIST,
  minimalPhase: true,
  firstRoundTools: ["memory_search"],
});
check("④ 首阶段仅保留 firstRoundTools（白名单再全也不进首阶段）", first.size === 1 && first.has("memory_search") && !first.has("pwsh") && !first.has("read") && !first.has("edit"));
const firstFallback = computeSurface({ toolWhitelist: TOOL_WHITELIST, minimalPhase: true, firstRoundTools: [] });
check("④ 首阶段 firstRoundTools 为空时回退 DEFAULT_FIRST_ROUND_TOOLS", firstFallback.size === DEFAULT_FIRST_ROUND_TOOLS.length && firstFallback.has("memory_search") && !firstFallback.has("pwsh"));

console.log(failures === 0 ? "\nKAZ-SHARED PROBE OK" : `\nKAZ-SHARED PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
