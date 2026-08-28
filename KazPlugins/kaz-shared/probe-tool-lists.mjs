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
  TOOL_AUTO_ON_CONFIG,
  MODE_SCOPED_TOOL_PLUGIN_KEYS,
  PLAN_AUTO_ON_TOOLS,
  GOAL_AUTO_ON_TOOLS,
  PLAN_AUTO_ON_DEFAULT_ENABLED,
  GOAL_AUTO_ON_DEFAULT_ENABLED,
  defaultToolAutoOnState,
  normalizeToolList,
  normalizeToolAutoOnState,
  normalizeAutoOnLayer,
  mergeAutoOnLayers,
  autoOnSettingsEqual,
  hasAutoOnLayerFields,
} from "./lib/tool-lists.js";

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

check("① 常量齐全", Array.isArray(DEFAULT_FIRST_ROUND_TOOLS_MEMORY_ON) && Array.isArray(DEFAULT_FIRST_ROUND_TOOLS_MEMORY_OFF) && Array.isArray(DEFAULT_FIRST_ROUND_TOOLS) && Array.isArray(DEFAULT_DISABLED_TOOLS) && Array.isArray(MANAGED_PLUGINS) && typeof FIXED_PERSONA === "string");
check("① resolveFirstRoundTools kaz-memory 开", JSON.stringify(resolveFirstRoundTools({ kazMemoryEnabled: true })) === JSON.stringify(["memory_search"]));
check("① resolveFirstRoundTools kaz-memory 关", JSON.stringify(resolveFirstRoundTools({ kazMemoryEnabled: false })) === JSON.stringify(["pwsh", "read", "edit"]));
check("① TOOL_WHITELIST 含基础工具", ["pwsh", "read", "write", "edit", "glob", "grep", "web_search", "memory_search"].every((t) => TOOL_WHITELIST.includes(t)));
check("① ka-whale-workflow 是被管理插件但不是工具白名单插件", MANAGED_PLUGINS.some((p) => p.id === "ka-whale-workflow") && TOOL_PLUGIN_CATALOG["ka-whale-workflow"] === undefined && TOOL_PLUGINS["ka-whale-workflow"] === undefined);
check("① MANAGED_CARRIER_TOOLS 覆盖 whale_report/create_plan", MANAGED_CARRIER_TOOLS["ka-whale-workflow"]?.includes("whale_report") === true && MANAGED_CARRIER_TOOLS["create-plan"]?.includes("create_plan") === true);

check("② normalizeExternalKey", normalizeExternalKey("Dsh_Pixel Art") === "dsh-pixel-art");
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

// ⑥ kaz_tool_auto_on 参数文件
check("⑥ TOOL_AUTO_ON_CONFIG 含 plan/goal", TOOL_AUTO_ON_CONFIG?.plan?.tools?.includes("exit_plan_mode") === true && TOOL_AUTO_ON_CONFIG?.goal?.tools?.includes("get_goal") === true && TOOL_AUTO_ON_CONFIG?.goal?.tools?.includes("update_goal") === true);
check("⑥ PLAN_AUTO_ON_TOOLS / GOAL_AUTO_ON_TOOLS 默认值", JSON.stringify(PLAN_AUTO_ON_TOOLS) === JSON.stringify(["exit_plan_mode"]) && JSON.stringify(GOAL_AUTO_ON_TOOLS) === JSON.stringify(["get_goal", "update_goal"]));
check("⑥ whale auto-on 默认含 whale_report 与 launch 工具", TOOL_AUTO_ON_CONFIG?.whale?.tools?.includes("whale_report") === true && TOOL_AUTO_ON_CONFIG?.whale?.launch?.tools?.includes("create_goal") === true && TOOL_AUTO_ON_CONFIG?.whale?.launch?.tools?.includes("create_plan") === true);
check("⑥ 默认开关为开", PLAN_AUTO_ON_DEFAULT_ENABLED === true && GOAL_AUTO_ON_DEFAULT_ENABLED === true);
const autoDefault = defaultToolAutoOnState();
check("⑥ defaultToolAutoOnState 返回独立副本", autoDefault.plan.tools !== PLAN_AUTO_ON_TOOLS && autoDefault.plan.enabled === true && JSON.stringify(autoDefault.goal.tools) === JSON.stringify(GOAL_AUTO_ON_TOOLS) && JSON.stringify(autoDefault.whale.tools) === JSON.stringify(["whale_report"]) && JSON.stringify(autoDefault.whale.launch.tools) === JSON.stringify(["create_goal", "create_plan"]));
check("⑥ normalizeToolList trim/去重/过滤", JSON.stringify(normalizeToolList([" exit_plan_mode ", "", "get_goal", "get_goal"])) === JSON.stringify(["exit_plan_mode", "get_goal"]));
const normalizedAuto = normalizeToolAutoOnState({ plan: { enabled: true, tools: ["a", "a", " b "] }, goal: { enabled: false, tools: ["c"] } });
check("⑥ normalizeToolAutoOnState 归一化", normalizedAuto.plan.enabled === true && JSON.stringify(normalizedAuto.plan.tools) === JSON.stringify(["a", "b"]) && normalizedAuto.goal.enabled === false && JSON.stringify(normalizedAuto.goal.tools) === JSON.stringify(["c"]));
const normalizedWhale = normalizeToolAutoOnState({ whale: { enabled: true, tools: ["whale_report"], launch: { enabled: false, tools: ["create_goal", " create_plan "] } } });
check("⑥ normalizeToolAutoOnState 支持 whale/launch", normalizedWhale.whale.enabled === true && JSON.stringify(normalizedWhale.whale.tools) === JSON.stringify(["whale_report"]) && normalizedWhale.whale.launch.enabled === false && JSON.stringify(normalizedWhale.whale.launch.tools) === JSON.stringify(["create_goal", "create_plan"]));
check("⑥ MODE_SCOPED_TOOL_PLUGIN_KEYS 含 plan-mode/goal", MODE_SCOPED_TOOL_PLUGIN_KEYS.includes("plan-mode") && MODE_SCOPED_TOOL_PLUGIN_KEYS.includes("goal") && MODE_SCOPED_TOOL_PLUGIN_KEYS.length === 2);
const layer = normalizeAutoOnLayer({ plan: { enabled: false, tools: [" a ", "a", ""] }, goal: {}, whale: { launch: { enabled: false, tools: ["create_goal", " create_plan "] } } });
check("⑥ normalizeAutoOnLayer 只保留显式字段并去重", layer.plan?.enabled === false && JSON.stringify(layer.plan?.tools) === JSON.stringify(["a"]) && layer.goal === undefined);
check("⑥ normalizeAutoOnLayer 支持 whale.launch", layer.whale?.launch?.enabled === false && JSON.stringify(layer.whale?.launch?.tools) === JSON.stringify(["create_goal", "create_plan"]) && layer.whale?.enabled === undefined);
const emptyTools = normalizeAutoOnLayer({ plan: { tools: [] } });
check("⑥ normalizeAutoOnLayer 保留空数组覆盖", Array.isArray(emptyTools.plan?.tools) && emptyTools.plan.tools.length === 0 && emptyTools.plan.enabled === undefined);
const merged = mergeAutoOnLayers(defaultToolAutoOnState(), { plan: { enabled: false } }, { plan: { tools: ["get_goal"] } });
check("⑥ mergeAutoOnLayers 专属覆盖默认/原设置", merged.plan.enabled === false && JSON.stringify(merged.plan.tools) === JSON.stringify(["get_goal"]) && JSON.stringify(merged.goal.tools) === JSON.stringify(GOAL_AUTO_ON_TOOLS));
const mergedDefault = mergeAutoOnLayers(defaultToolAutoOnState(), { goal: { tools: ["get_goal"] } }, {});
check("⑥ mergeAutoOnLayers 默认覆盖原设置", mergedDefault.goal.tools.includes("get_goal") && mergedDefault.goal.enabled === true);
const mergedWhale = mergeAutoOnLayers(defaultToolAutoOnState(), { whale: { tools: [] } }, { whale: { launch: { tools: ["create_goal"] } } });
check("⑥ mergeAutoOnLayers 支持 whale/launch 逐项覆盖", mergedWhale.whale.tools.length === 0 && JSON.stringify(mergedWhale.whale.launch.tools) === JSON.stringify(["create_goal"]) && mergedWhale.whale.launch.enabled === true);
check("⑥ autoOnSettingsEqual / hasAutoOnLayerFields", autoOnSettingsEqual({ a: 1 }, { a: 1 }) === true && hasAutoOnLayerFields({ plan: { enabled: true } }, "plan") === true && hasAutoOnLayerFields({ plan: {} }, "plan") === false);

console.log(failures === 0 ? "\nKAZ-SHARED PROBE OK" : `\nKAZ-SHARED PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
