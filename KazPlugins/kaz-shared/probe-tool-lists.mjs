// kaz-shared 探针：验证 tool-lists.js 的四文件模型。
import {
  TOOL_WHITELIST,
  DEFAULT_FIRST_ROUND_TOOLS,
  DEFAULT_FIRST_ROUND_TOOLS_MEMORY_ON,
  DEFAULT_FIRST_ROUND_TOOLS_MEMORY_OFF,
  DEFAULT_DISABLED_TOOLS,
  MANAGED_PLUGINS,
  MANAGED_CARRIER_TOOLS,
  FIXED_PERSONA,
  KAZ_FIRST_ROUND_TOOLS,
  KAZ_TOOL_UNIVERSE,
  KAZ_BASE_TOOLS,
  KAZ_GOAL_TOOLS,
  KAZ_SUBAGENT_CONTROL_TOOLS,
  KAZ_STABLE_MAIN_TOOLS,
  KAZ_SUBAGENT_BASE_TOOLS,
  stableMainSurface,
  stableSubagentSurface,
  KAZ_EXTERNAL_CANDIDATES,
  KAZ_ROLE_PROMPTS,
  KAZ_MAINTENANCE_ONLY_TOOLS,
  KAZ_MEMORY_COMPONENT_ID,
  KAZ_MEMORY_LEGACY_COMPONENT_ID,
  effectiveToolWhitelist,
  resolveFirstRoundTools,
  computeSurface,
  normalizeExternalKey,
  normalizePluginEnableDict,
  normalizeToolCatalog,
  mergePluginEnableDicts,
  mergeToolCatalogs,
  buildToolUniverse,
  computeEffectiveToolState,
  computeToolPluginSurfaceFromEffective,
  computeToolPluginSurface,
  TOOL_PLUGIN_CATALOG,
  TOOL_PLUGINS,
} from "./lib/tool-lists.js";

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

check("① 常量齐全", Array.isArray(DEFAULT_FIRST_ROUND_TOOLS_MEMORY_ON) && Array.isArray(DEFAULT_FIRST_ROUND_TOOLS_MEMORY_OFF) && Array.isArray(DEFAULT_FIRST_ROUND_TOOLS) && Array.isArray(DEFAULT_DISABLED_TOOLS) && Array.isArray(MANAGED_PLUGINS) && typeof FIXED_PERSONA === "string");
check("① Kaz5.0 常量齐全", KAZ_FIRST_ROUND_TOOLS !== undefined && KAZ_TOOL_UNIVERSE !== undefined && KAZ_BASE_TOOLS !== undefined && KAZ_EXTERNAL_CANDIDATES !== undefined && KAZ_ROLE_PROMPTS !== undefined && KAZ_MAINTENANCE_ONLY_TOOLS !== undefined && KAZ_MEMORY_COMPONENT_ID === "ka-whale-memory" && KAZ_MEMORY_LEGACY_COMPONENT_ID === "kaz-memory");
check("① KAZ_FIRST_ROUND_TOOLS 所有状态 ≤2", KAZ_FIRST_ROUND_TOOLS["ka-whale-memory"].length <= 2 && KAZ_FIRST_ROUND_TOOLS["kaz-memory"].length <= 2 && KAZ_FIRST_ROUND_TOOLS.default.length <= 2);
check("① KAZ_TOOL_UNIVERSE 冻结且不被用户层扩写", Object.isFrozen(KAZ_TOOL_UNIVERSE) && KAZ_TOOL_UNIVERSE["tool-fs"]?.read === true && KAZ_TOOL_UNIVERSE["ka-whale-workflow"]?.whale_report === true && KAZ_TOOL_UNIVERSE["ka-whale-memory"]?.memory_search === true && KAZ_TOOL_UNIVERSE["kaz-memory"] === undefined && KAZ_TOOL_UNIVERSE["dsh-pixel-art"] === undefined);
check("① v0.8 Step B1 原生 Plan 工具已移出固定全集", TOOL_PLUGIN_CATALOG["plan-mode"] === undefined && TOOL_PLUGIN_CATALOG["create_plan"] === undefined && KAZ_TOOL_UNIVERSE["plan-mode"] === undefined && KAZ_TOOL_UNIVERSE["create-plan"] === undefined);
check("① 改名矩阵目录/catalog 新键生效且旧键不再作为白名单插件", TOOL_PLUGIN_CATALOG["ka-whale-memory"]?.memory_search === true && TOOL_PLUGIN_CATALOG["kaz-memory"] === undefined && TOOL_PLUGINS["ka-whale-memory"] === true && TOOL_PLUGINS["kaz-memory"] === undefined && MANAGED_PLUGINS.some((p) => p.id === "ka-whale-memory") && !MANAGED_PLUGINS.some((p) => p.id === "kaz-memory"));
check("① KAZ_BASE_TOOLS 12 项初稿", Array.isArray(KAZ_BASE_TOOLS) && KAZ_BASE_TOOLS.length === 12 && ["ask_user_question","edit","glob","grep","memory_detail","memory_list","memory_search","pwsh","read","todo_write","web_search","write"].every((t) => KAZ_BASE_TOOLS.includes(t)));
check("① KAZ_GOAL_TOOLS Goal 三件套", Array.isArray(KAZ_GOAL_TOOLS) && KAZ_GOAL_TOOLS.length === 3 && ["create_goal","get_goal","update_goal"].every((t) => KAZ_GOAL_TOOLS.includes(t)));
check("① KAZ_SUBAGENT_CONTROL_TOOLS 旧兼容仍含 subagent", JSON.stringify(KAZ_SUBAGENT_CONTROL_TOOLS) === JSON.stringify(["subagent"]));
check("① v0.9 Stable Main Surface = 19（§1.1，无 create_goal/subagent）", KAZ_STABLE_MAIN_TOOLS.length === 19 && KAZ_STABLE_MAIN_TOOLS.every((t) => typeof t === "string") && KAZ_STABLE_MAIN_TOOLS.includes("whale_report") && KAZ_STABLE_MAIN_TOOLS.includes("ka_sub_whale") && KAZ_STABLE_MAIN_TOOLS.includes("list_agents") && KAZ_STABLE_MAIN_TOOLS.includes("send_message") && KAZ_STABLE_MAIN_TOOLS.includes("interrupt_agent") && !KAZ_STABLE_MAIN_TOOLS.includes("create_goal") && !KAZ_STABLE_MAIN_TOOLS.includes("subagent"));
check("① stableMainSurface = v0.9 固定集 19", stableMainSurface().size === 19 && stableMainSurface().has("ka_sub_whale") && stableMainSurface().has("get_goal") && stableMainSurface().has("update_goal") && !stableMainSurface().has("exit_plan_mode") && !stableMainSurface().has("subagent") && !stableMainSurface().has("create_goal"));
check("① KAZ_SUBAGENT_BASE_TOOLS 不含 safe_json_write / memory 写工具", !KAZ_SUBAGENT_BASE_TOOLS.includes("safe_json_write") && !KAZ_SUBAGENT_BASE_TOOLS.includes("memory_save") && !KAZ_SUBAGENT_BASE_TOOLS.includes("memory_update") && !KAZ_SUBAGENT_BASE_TOOLS.includes("memory_forget"));
check("① stableSubagentSurface 支持 assignedTools 并入", stableSubagentSurface({ assignedTools: ["tool_jobs"] }).has("tool_jobs") && stableSubagentSurface({ baseTools: ["read"], assignedTools: ["write"] }).size === 2);
check("① KAZ_EXTERNAL_CANDIDATES / KAZ_ROLE_PROMPTS 冻结", Object.isFrozen(KAZ_EXTERNAL_CANDIDATES) && Object.isFrozen(KAZ_ROLE_PROMPTS) && Object.isFrozen(KAZ_MAINTENANCE_ONLY_TOOLS));
check("① resolveFirstRoundTools kaz-memory 开", JSON.stringify(resolveFirstRoundTools({ kazMemoryEnabled: true })) === JSON.stringify(["memory_search"]));
check("① resolveFirstRoundTools ka-whale-memory 开", JSON.stringify(resolveFirstRoundTools({ kaWhaleMemoryEnabled: true })) === JSON.stringify(["memory_search"]));
check("① resolveFirstRoundTools kaz-memory 关", JSON.stringify(resolveFirstRoundTools({ kazMemoryEnabled: false })) === JSON.stringify(["read", "pwsh"]));
check("① TOOL_WHITELIST 含基础工具", ["pwsh", "read", "write", "edit", "glob", "grep", "web_search", "memory_search"].every((t) => TOOL_WHITELIST.includes(t)));
check("① ka-whale-workflow 是被管理插件但不是工具白名单插件", MANAGED_PLUGINS.some((p) => p.id === "ka-whale-workflow") && TOOL_PLUGIN_CATALOG["ka-whale-workflow"] === undefined && TOOL_PLUGINS["ka-whale-workflow"] === undefined);
check("① MANAGED_CARRIER_TOOLS 仅覆盖 whale_report，MANAGED_PLUGINS 无 create-plan", MANAGED_CARRIER_TOOLS["ka-whale-workflow"]?.includes("whale_report") === true && MANAGED_CARRIER_TOOLS["create-plan"] === undefined && !MANAGED_PLUGINS.some((p) => p.id === "create-plan"));

check("② normalizeExternalKey", normalizeExternalKey("Dsh_Pixel Art") === "dsh-pixel-art");
check("② normalizeExternalKey 旧键 kaz-memory 归一化到 ka-whale-memory", normalizeExternalKey("kaz-memory") === "ka-whale-memory" && normalizeExternalKey("Kaz_Memory") === "ka-whale-memory");
check("② normalizePluginEnableDict 旧键兼容读", normalizePluginEnableDict({ "kaz-memory": true })["ka-whale-memory"] === true && normalizePluginEnableDict({ "kaz-memory": true })["kaz-memory"] === undefined);
check("② normalizePluginEnableDict", JSON.stringify(normalizePluginEnableDict({ "Tool_FS": true, "dsh-pixel-art": false })) === JSON.stringify({ "tool-fs": true, "dsh-pixel-art": false }));
check("② normalizePluginEnableDict 兼容旧数组", JSON.stringify(normalizePluginEnableDict(["Tool_FS", "dsh-pixel-art"])) === JSON.stringify({ "tool-fs": true, "dsh-pixel-art": true }));
check("② normalizeToolCatalog", normalizeToolCatalog({ "Tool-FS": { read: true, write: false } })["tool-fs"].read === true && normalizeToolCatalog({ "Tool-FS": { read: true, write: false } })["tool-fs"].write === false);
check("② mergePluginEnableDicts 后层覆盖", JSON.stringify(mergePluginEnableDicts({ a: true }, { a: false, b: true })) === JSON.stringify({ a: false, b: true }));
check("② mergeToolCatalogs 后层覆盖", mergeToolCatalogs({ a: { x: true } }, { a: { x: false, y: true } }).a.x === false && mergeToolCatalogs({ a: { x: true } }, { a: { x: false, y: true } }).a.y === true);

const universe = buildToolUniverse(TOOL_PLUGIN_CATALOG, { "dsh-pixel-art": { render_pixel_art: true } });
check("③ T0 含官方工具和用户添加插件", universe["tool-fs"]?.read === true && universe["dsh-pixel-art"]?.render_pixel_art === true);
const universeProject = buildToolUniverse(TOOL_PLUGIN_CATALOG, {}, { "dsh-pixel-art": { render_pixel_art: true } });
check("③ T0 含项目 other 添加的插件", universeProject["dsh-pixel-art"]?.render_pixel_art === true);

const eff = computeEffectiveToolState({
  codeCatalog: TOOL_PLUGIN_CATALOG,
  codeEnabled: TOOL_PLUGINS,
  userOtherEnable: { "dsh-pixel-art": true },
  userOtherCatalog: { "dsh-pixel-art": { render_pixel_art: true } },
});
const surface = computeToolPluginSurfaceFromEffective(eff);
check("④ 用户添加插件默认进入工具面", surface.has("render_pixel_art"));
const effProj = computeEffectiveToolState({
  codeCatalog: TOOL_PLUGIN_CATALOG,
  codeEnabled: TOOL_PLUGINS,
  projectOtherEnable: { "dsh-pixel-art": true },
  projectOtherCatalog: { "dsh-pixel-art": { render_pixel_art: true } },
});
check("④ 项目 other 的外置插件/工具进入工具面", computeToolPluginSurfaceFromEffective(effProj).has("render_pixel_art"));
check("④ 未启用插件工具不进入", !surface.has("subagent"));
check("④ computeToolPluginSurface 一步到位", computeToolPluginSurface({
  codeCatalog: TOOL_PLUGIN_CATALOG,
  codeEnabled: TOOL_PLUGINS,
  userOtherEnable: { "dsh-pixel-art": true },
  userOtherCatalog: { "dsh-pixel-art": { render_pixel_art: true } },
}).has("render_pixel_art"));

const layered1 = computeEffectiveToolState({
  codeCatalog: TOOL_PLUGIN_CATALOG,
  codeEnabled: TOOL_PLUGINS,
  userEnable: { "tool-ralph": true },
  userCatalog: { "tool-ralph": { ralph: true } },
});
check("⑤ 用户默认开启的插件在无项目覆盖时保持开启", layered1.P["tool-ralph"] === true && layered1.T["tool-ralph"]?.ralph === true && computeToolPluginSurfaceFromEffective(layered1).has("ralph"));
const layered2 = computeEffectiveToolState({
  codeCatalog: TOOL_PLUGIN_CATALOG,
  codeEnabled: TOOL_PLUGINS,
  userEnable: { "tool-ralph": true },
  userCatalog: { "tool-ralph": { ralph: true } },
  projectEnable: { "tool-ralph": false },
  projectCatalog: { "tool-ralph": { ralph: false } },
});
check("⑤ 项目专属关闭覆盖用户默认", layered2.P["tool-ralph"] === false && layered2.T["tool-ralph"]?.ralph === false && !computeToolPluginSurfaceFromEffective(layered2).has("ralph"));

console.log(failures === 0 ? "\nKAZ-SHARED PROBE OK" : `\nKAZ-SHARED PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
