// kaz-shared 探针：验证 tool-lists.js 的四文件模型。
import {
  TOOL_WHITELIST,
  DEFAULT_FIRST_ROUND_TOOLS,
  DEFAULT_FIRST_ROUND_TOOLS_MEMORY_ON,
  DEFAULT_FIRST_ROUND_TOOLS_MEMORY_OFF,
  DEFAULT_DISABLED_TOOLS,
  MANAGED_PLUGINS,
  FIXED_PERSONA,
  effectiveToolWhitelist,
  resolveFirstRoundTools,
  computeSurface,
  normalizeExternalKey,
  normalizeEnableList,
  normalizeToolCatalog,
  unionEnableLists,
  mergeToolCatalogs,
  buildToolUniverse,
  computeEffectiveToolState,
  computeToolPluginSurfaceFromEffective,
  computeToolPluginSurface,
  TOOL_PLUGIN_CATALOG,
  DEFAULT_ENABLED_TOOL_PLUGINS,
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

check("② normalizeExternalKey", normalizeExternalKey("Dsh_Pixel Art") === "dsh-pixel-art");
check("② normalizeEnableList 去重", JSON.stringify(normalizeEnableList(["tool-fs", "Tool_FS", "dsh-pixel-art"])) === JSON.stringify(["tool-fs", "dsh-pixel-art"]));
check("② normalizeToolCatalog", normalizeToolCatalog({ "Tool-FS": { read: true, write: false } })["tool-fs"].read === true && normalizeToolCatalog({ "Tool-FS": { read: true, write: false } })["tool-fs"].write === false);
check("② unionEnableLists", JSON.stringify(unionEnableLists(["a"], ["b", "a"])) === JSON.stringify(["a", "b"]));
check("② mergeToolCatalogs 后层覆盖", mergeToolCatalogs({ a: { x: true } }, { a: { x: false, y: true } }).a.x === false && mergeToolCatalogs({ a: { x: true } }, { a: { x: false, y: true } }).a.y === true);

const universe = buildToolUniverse(TOOL_PLUGIN_CATALOG, { "dsh-pixel-art": { render_pixel_art: true } });
check("③ T0 含官方工具和用户添加插件", universe["tool-fs"]?.read === true && universe["dsh-pixel-art"]?.render_pixel_art === true);

const eff = computeEffectiveToolState({
  codeCatalog: TOOL_PLUGIN_CATALOG,
  codeEnabled: DEFAULT_ENABLED_TOOL_PLUGINS,
  userOtherEnable: ["dsh-pixel-art"],
  userOtherCatalog: { "dsh-pixel-art": { render_pixel_art: true } },
});
const surface = computeToolPluginSurfaceFromEffective(eff);
check("④ 用户添加插件默认进入工具面", surface.has("render_pixel_art"));
check("④ 未启用插件工具不进入", !surface.has("subagent"));
check("④ computeToolPluginSurface 一步到位", computeToolPluginSurface({
  codeCatalog: TOOL_PLUGIN_CATALOG,
  codeEnabled: DEFAULT_ENABLED_TOOL_PLUGINS,
  userOtherEnable: ["dsh-pixel-art"],
  userOtherCatalog: { "dsh-pixel-art": { render_pixel_art: true } },
}).has("render_pixel_art"));

console.log(failures === 0 ? "\nKAZ-SHARED PROBE OK" : `\nKAZ-SHARED PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
