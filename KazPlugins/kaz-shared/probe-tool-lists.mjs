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
  KAZ_STABLE_MAIN_TOOLS,
  KAZ_SUBAGENT_BASE_TOOLS,
  stableMainSurface,
  stableSubagentSurface,
  KAZ_EXTERNAL_CANDIDATES,
  KAZ_ROLE_PROMPTS,
  KAZ_PROMPT_PHRASES,
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
  OFFICIAL_TOOL_PLUGIN_KEYS,
} from "./lib/tool-lists.js";

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

check("① 常量齐全", Array.isArray(DEFAULT_FIRST_ROUND_TOOLS_MEMORY_ON) && Array.isArray(DEFAULT_FIRST_ROUND_TOOLS_MEMORY_OFF) && Array.isArray(DEFAULT_FIRST_ROUND_TOOLS) && Array.isArray(DEFAULT_DISABLED_TOOLS) && Array.isArray(MANAGED_PLUGINS) && typeof FIXED_PERSONA === "string");
check("① Kaz5.0 常量齐全", KAZ_FIRST_ROUND_TOOLS !== undefined && KAZ_TOOL_UNIVERSE !== undefined && KAZ_BASE_TOOLS !== undefined && KAZ_EXTERNAL_CANDIDATES !== undefined && KAZ_ROLE_PROMPTS !== undefined && KAZ_MAINTENANCE_ONLY_TOOLS !== undefined && KAZ_MEMORY_COMPONENT_ID === "ka-whale-memory" && KAZ_MEMORY_LEGACY_COMPONENT_ID === "kaz-memory");
check("① KAZ_FIRST_ROUND_TOOLS 所有状态 ≤2", KAZ_FIRST_ROUND_TOOLS["ka-whale-memory"].length <= 2 && KAZ_FIRST_ROUND_TOOLS["kaz-memory"].length <= 2 && KAZ_FIRST_ROUND_TOOLS.default.length <= 2);
check("① KAZ_TOOL_UNIVERSE 冻结且不被用户层扩写", Object.isFrozen(KAZ_TOOL_UNIVERSE) && KAZ_TOOL_UNIVERSE["tool-fs"]?.read === true && KAZ_TOOL_UNIVERSE["ka-whale-workflow"]?.whale_report === true && KAZ_TOOL_UNIVERSE["ka-whale-memory"]?.memory_search === true && KAZ_TOOL_UNIVERSE["kaz-context-policy"]?.context_search === true && KAZ_TOOL_UNIVERSE["kaz-context-policy"]?.context_read === true && KAZ_TOOL_UNIVERSE["kaz-context-policy"]?.context_compress === true && KAZ_TOOL_UNIVERSE["kaz-memory"] === undefined && KAZ_TOOL_UNIVERSE["dsh-pixel-art"] === undefined);
check("① v0.8 Step B1 原生 Plan/Goal 工具已移出固定全集", TOOL_PLUGIN_CATALOG["plan-mode"] === undefined && TOOL_PLUGIN_CATALOG["create_plan"] === undefined && TOOL_PLUGIN_CATALOG["goal"] === undefined && TOOL_PLUGINS["goal"] === undefined && !OFFICIAL_TOOL_PLUGIN_KEYS.includes("tool-goal") && !OFFICIAL_TOOL_PLUGIN_KEYS.includes("goal") && KAZ_TOOL_UNIVERSE["plan-mode"] === undefined && KAZ_TOOL_UNIVERSE["create-plan"] === undefined && KAZ_TOOL_UNIVERSE["goal"] === undefined);
check("① 改名矩阵目录/catalog 新键生效且旧键不再作为白名单插件", TOOL_PLUGIN_CATALOG["ka-whale-memory"]?.memory_search === true && TOOL_PLUGIN_CATALOG["kaz-memory"] === undefined && TOOL_PLUGINS["ka-whale-memory"] === true && TOOL_PLUGINS["kaz-memory"] === undefined && MANAGED_PLUGINS.some((p) => p.id === "ka-whale-memory") && !MANAGED_PLUGINS.some((p) => p.id === "kaz-memory"));
check("① KAZ_BASE_TOOLS 12 项初稿", Array.isArray(KAZ_BASE_TOOLS) && KAZ_BASE_TOOLS.length === 12 && ["ask_user_question","edit","glob","grep","memory_detail","memory_list","memory_search","pwsh","read","todo_write","web_search","write"].every((t) => KAZ_BASE_TOOLS.includes(t)));
check("① B5 不再保留旧 KAZ_GOAL_TOOLS / KAZ_SUBAGENT_CONTROL_TOOLS", !Object.prototype.hasOwnProperty.call(await import("./lib/tool-lists.js"), "KAZ_GOAL_TOOLS") && !Object.prototype.hasOwnProperty.call(await import("./lib/tool-lists.js"), "KAZ_SUBAGENT_CONTROL_TOOLS"));
check("① v0.9 Stable Main Surface = 21（k10 加 plan_read；无 goal/create_goal/subagent）", KAZ_STABLE_MAIN_TOOLS.length === 21 && KAZ_STABLE_MAIN_TOOLS.every((t) => typeof t === "string") && KAZ_STABLE_MAIN_TOOLS.includes("context_compress") && KAZ_STABLE_MAIN_TOOLS.includes("context_read") && KAZ_STABLE_MAIN_TOOLS.includes("context_search") && KAZ_STABLE_MAIN_TOOLS.includes("whale_report") && KAZ_STABLE_MAIN_TOOLS.includes("plan_read") && KAZ_STABLE_MAIN_TOOLS.includes("ka_sub_whale") && KAZ_STABLE_MAIN_TOOLS.includes("list_agents") && KAZ_STABLE_MAIN_TOOLS.includes("send_message") && KAZ_STABLE_MAIN_TOOLS.includes("interrupt_agent") && !KAZ_STABLE_MAIN_TOOLS.includes("get_goal") && !KAZ_STABLE_MAIN_TOOLS.includes("update_goal") && !KAZ_STABLE_MAIN_TOOLS.includes("create_goal") && !KAZ_STABLE_MAIN_TOOLS.includes("subagent"));
check("① stableMainSurface = v0.9 固定集 21", stableMainSurface().size === 21 && stableMainSurface().has("context_compress") && stableMainSurface().has("context_read") && stableMainSurface().has("context_search") && stableMainSurface().has("plan_read") && stableMainSurface().has("ka_sub_whale") && !stableMainSurface().has("get_goal") && !stableMainSurface().has("update_goal") && !stableMainSurface().has("exit_plan_mode") && !stableMainSurface().has("subagent") && !stableMainSurface().has("create_goal"));
check("① KAZ_SUBAGENT_BASE_TOOLS 不含 safe_json_write / memory 写工具", !KAZ_SUBAGENT_BASE_TOOLS.includes("safe_json_write") && !KAZ_SUBAGENT_BASE_TOOLS.includes("memory_save") && !KAZ_SUBAGENT_BASE_TOOLS.includes("memory_update") && !KAZ_SUBAGENT_BASE_TOOLS.includes("memory_forget"));
check("① stableSubagentSurface 支持 assignedTools 并入", stableSubagentSurface({ assignedTools: ["tool_jobs"] }).has("tool_jobs") && stableSubagentSurface({ baseTools: ["read"], assignedTools: ["write"] }).size === 2);
check("① KAZ_EXTERNAL_CANDIDATES / KAZ_ROLE_PROMPTS 冻结", Object.isFrozen(KAZ_EXTERNAL_CANDIDATES) && Object.isFrozen(KAZ_ROLE_PROMPTS) && Object.isFrozen(KAZ_MAINTENANCE_ONLY_TOOLS));
check("① Persona 骨架逐字：四角色首句一致", [KAZ_ROLE_PROMPTS.main, ...Object.values(KAZ_ROLE_PROMPTS.subagent)].every((text) => text.startsWith(KAZ_PROMPT_PHRASES.header)));
check("① Persona 骨架逐字：四角色末句一致", [KAZ_ROLE_PROMPTS.main, ...Object.values(KAZ_ROLE_PROMPTS.subagent)].every((text) => text.endsWith(KAZ_PROMPT_PHRASES.footer)));
check("① main 含角色流程一句 + relay/复用口径", KAZ_ROLE_PROMPTS.main.includes(KAZ_PROMPT_PHRASES.mainRoleGuidance) && KAZ_ROLE_PROMPTS.main.includes("Main flow: assess-complexity → challenge-plan → decide-tools → write-plan → working → memory-maintenance → plugin-maintenance → compass_context → communication.") && KAZ_ROLE_PROMPTS.main.includes("Advance with whale_report and follow the injected [ka-whale-workflow <stage>] body each turn.") && KAZ_ROLE_PROMPTS.main.includes("reuse idle children by default") && KAZ_ROLE_PROMPTS.main.includes("planItemId: <id>"));
check("① main 含 context 纪律 + keep-gray/stop（新口径）", KAZ_ROLE_PROMPTS.main.includes("Before long sessions close, context_compress suggest → fold.") && KAZ_ROLE_PROMPTS.main.includes(KAZ_PROMPT_PHRASES.keepGray) && KAZ_ROLE_PROMPTS.main.includes("If stuck or circling, report and stop."));
check("① worker 含角色流程一句 + report 语义", KAZ_ROLE_PROMPTS.subagent.worker.includes("We execute one delegated plan item with care and precision") && KAZ_ROLE_PROMPTS.subagent.worker.includes("Worker flow: challenge-plan → working-then-compress-context-then-report; optional context_compress") && KAZ_ROLE_PROMPTS.subagent.worker.includes("happen inside that execution stage") && !KAZ_ROLE_PROMPTS.subagent.worker.includes("compress_context_then_communication") && !KAZ_ROLE_PROMPTS.subagent.worker.includes("compass_context") && KAZ_ROLE_PROMPTS.subagent.worker.includes("call work_sub_whale_report({ final: true }) with NO nextStage") && KAZ_ROLE_PROMPTS.subagent.worker.includes("fresh delegation starts at challenge-plan") && KAZ_ROLE_PROMPTS.subagent.worker.includes("We do not write memories or private plugins ourselves."));
check("① worker 含 context 纪律（新口径）", KAZ_ROLE_PROMPTS.subagent.worker.includes("Worker flow: challenge-plan → working-then-compress-context-then-report; optional context_compress and the FULL final report happen inside that execution stage.") && KAZ_ROLE_PROMPTS.subagent.worker.includes("preview context_compress suggest first, then fold when large"));
check("① memoryMaintainer 含角色流程一句 + report/reuse 语义", KAZ_ROLE_PROMPTS.subagent.memoryMaintainer.includes("We maintain project memories with evidence; keep new entries as CANDIDATE") && KAZ_ROLE_PROMPTS.subagent.memoryMaintainer.includes("Flow: plan-memory → save-update-then-compress-context-then-report or delete-memory-then-compress-context-then-report; optional context_compress") && !KAZ_ROLE_PROMPTS.subagent.memoryMaintainer.includes("compress_context_then_communication") && !KAZ_ROLE_PROMPTS.subagent.memoryMaintainer.includes("assess-delegation") && !KAZ_ROLE_PROMPTS.subagent.memoryMaintainer.includes("compass_context") && KAZ_ROLE_PROMPTS.subagent.memoryMaintainer.includes("call memory_sub_whale_report({ final: true }) with NO nextStage") && KAZ_ROLE_PROMPTS.subagent.memoryMaintainer.includes("the parent receives it as subagent-settled") && KAZ_ROLE_PROMPTS.subagent.memoryMaintainer.includes("fresh delegation starts at plan-memory") && KAZ_ROLE_PROMPTS.subagent.memoryMaintainer.includes("MemoryMaintainer can be reused; each round starts at plan-memory"));
check("① memoryMaintainer 含 context 纪律（新口径）", KAZ_ROLE_PROMPTS.subagent.memoryMaintainer.includes("Flow: plan-memory → save-update-then-compress-context-then-report or delete-memory-then-compress-context-then-report; optional context_compress and the FULL final report happen inside the action stage.") && KAZ_ROLE_PROMPTS.subagent.memoryMaintainer.includes("preview context_compress suggest first, then fold when large"));
check("① pluginMaintainer 含角色流程一句 + report/reuse 语义", KAZ_ROLE_PROMPTS.subagent.pluginMaintainer.includes("Private plugins: CANDIDATE → implementation → probe → registration/versioning.") && KAZ_ROLE_PROMPTS.subagent.pluginMaintainer.includes("Flow: plan-plugin → create-plugin-then-compress-context-then-report or update-plugin-then-compress-context-then-report or retire-plugin-then-compress-context-then-report; optional context_compress") && !KAZ_ROLE_PROMPTS.subagent.pluginMaintainer.includes("compress_context_then_communication") && !KAZ_ROLE_PROMPTS.subagent.pluginMaintainer.includes("assess-delegation") && !KAZ_ROLE_PROMPTS.subagent.pluginMaintainer.includes("compass_context") && KAZ_ROLE_PROMPTS.subagent.pluginMaintainer.includes("call plugin_maintainer_sub_whale_report({ final: true }) with NO nextStage") && KAZ_ROLE_PROMPTS.subagent.pluginMaintainer.includes("the parent receives it as subagent-settled") && KAZ_ROLE_PROMPTS.subagent.pluginMaintainer.includes("fresh delegation starts at plan-plugin") && KAZ_ROLE_PROMPTS.subagent.pluginMaintainer.includes("Reuse is parent-decided"));
check("① pluginMaintainer 含 context 纪律（新口径）", KAZ_ROLE_PROMPTS.subagent.pluginMaintainer.includes("Flow: plan-plugin → create-plugin-then-compress-context-then-report or update-plugin-then-compress-context-then-report or retire-plugin-then-compress-context-then-report; optional context_compress and the FULL final report happen inside the action stage.") && KAZ_ROLE_PROMPTS.subagent.pluginMaintainer.includes("preview context_compress suggest first, then fold when large"));
check("① 黄金锚：KAZ_PROMPT_PHRASES.header 字面量", KAZ_PROMPT_PHRASES.header === "You are a helpful software engineer assistant. **ALWAYS REASON AS 'WE'**. Maintain a calm, declarative tone.");
check("① 黄金锚：KAZ_PROMPT_PHRASES.footer 字面量", KAZ_PROMPT_PHRASES.footer === "The final white response should be crisp and to the point, and only appear after reasoning and working.");
check("① 黄金锚：KAZ_PROMPT_PHRASES.keepGray 字面量", KAZ_PROMPT_PHRASES.keepGray === "Keep gray reasoning concise — short English sentences.");
check("① 黄金锚：KAZ_PROMPT_PHRASES.mainRoleGuidance 字面量", KAZ_PROMPT_PHRASES.mainRoleGuidance === "We drive the ka-whale-workflow run and verify delegated reports.");
check("① Persona 预算：每角色 ≤1000，main ≤1100，合计 ≤4000", Object.values(KAZ_ROLE_PROMPTS.subagent).every((text) => text.length <= 1000) && KAZ_ROLE_PROMPTS.main.length <= 1100 && KAZ_ROLE_PROMPTS.main.length + Object.values(KAZ_ROLE_PROMPTS.subagent).reduce((s, t) => s + t.length, 0) <= 4000);
// 7.4 P3 (2b)：main persona 必须含精确分类句；并显式断言实测预算数字。
check("① Persona main 含 7.4 分类句（精确匹配）", KAZ_ROLE_PROMPTS.main.includes("Classify S/M/L at assess-complexity; default M."));
const personaLens = {
  main: KAZ_ROLE_PROMPTS.main.length,
  ...Object.fromEntries(
    Object.entries(KAZ_ROLE_PROMPTS.subagent).map(([role, text]) => [role, text.length]),
  ),
};
const personaTotal = Object.values(personaLens).reduce((sum, n) => sum + n, 0);
console.log(`PERSONA-LENGTHS ${JSON.stringify(personaLens)} TOTAL=${personaTotal}`);
check(
  "① Persona 预算实测数字：main ≤1100，每子代理 ≤1000，合计 ≤4000",
  personaLens.main <= 1100 &&
    personaLens.worker <= 1000 &&
    personaLens.memoryMaintainer <= 1000 &&
    personaLens.pluginMaintainer <= 1000 &&
    personaTotal <= 4000,
);
check(
  "① Persona 值不含版本标记（7.x / v0.x / P<digit>）",
  [KAZ_ROLE_PROMPTS.main, ...Object.values(KAZ_ROLE_PROMPTS.subagent)].every(
    (text) => !/(?:^|[^A-Za-z0-9])(7\.[0-9]+|v0\.[0-9]+|P[0-9]+)(?![A-Za-z0-9])/.test(text),
  ),
);
check("① Persona 不含旧大段机制块", !KAZ_ROLE_PROMPTS.main.includes("Follow the ka-whale-workflow in order") && !KAZ_ROLE_PROMPTS.main.includes("Start or resume Goal via whale_report") && !KAZ_ROLE_PROMPTS.main.includes("During working, execute persona=main plan items") && !Object.values(KAZ_ROLE_PROMPTS.subagent).some((text) => text.includes("The full working file-tool set") || text.includes("After calling your *_sub_whale_report, STOP")));
check("① KAZ_ROLE_PROMPTS 无旧 toolCreator/retriever/pluginCreator 角色且三角色齐备", KAZ_ROLE_PROMPTS.subagent?.toolCreator === undefined && KAZ_ROLE_PROMPTS.subagent?.retriever === undefined && KAZ_ROLE_PROMPTS.subagent?.pluginCreator === undefined && KAZ_ROLE_PROMPTS.subagent?.worker !== undefined && KAZ_ROLE_PROMPTS.subagent?.memoryMaintainer !== undefined && KAZ_ROLE_PROMPTS.subagent?.pluginMaintainer !== undefined && Object.keys(KAZ_ROLE_PROMPTS.subagent).length === 3 && Object.values(KAZ_ROLE_PROMPTS.subagent).every((text) => typeof text === "string"));
check("① resolveFirstRoundTools kaz-memory 开", JSON.stringify(resolveFirstRoundTools({ kazMemoryEnabled: true })) === JSON.stringify(["memory_search", "context_search"]));
check("① resolveFirstRoundTools ka-whale-memory 开", JSON.stringify(resolveFirstRoundTools({ kaWhaleMemoryEnabled: true })) === JSON.stringify(["memory_search", "context_search"]));
check("① resolveFirstRoundTools kaz-memory 关", JSON.stringify(resolveFirstRoundTools({ kazMemoryEnabled: false })) === JSON.stringify(["read", "pwsh"]));
check("① TOOL_WHITELIST 含基础工具", ["pwsh", "read", "write", "edit", "glob", "grep", "web_search", "memory_search"].every((t) => TOOL_WHITELIST.includes(t)));
check("① ka-whale-workflow 是被管理插件但不是工具白名单插件", MANAGED_PLUGINS.some((p) => p.id === "ka-whale-workflow") && TOOL_PLUGIN_CATALOG["ka-whale-workflow"] === undefined && TOOL_PLUGINS["ka-whale-workflow"] === undefined);
check("① 36.9 MANAGED_PLUGINS 不含 round-minimal", !MANAGED_PLUGINS.some((p) => p.id === "round-minimal"));
check("① MANAGED_CARRIER_TOOLS 覆盖 v0.9 workflow 与 kaz-context-policy 工具，MANAGED_PLUGINS 无 create-plan 且无 plugin_creator_sub_whale_report", MANAGED_CARRIER_TOOLS["ka-whale-workflow"]?.includes("whale_report") === true && MANAGED_CARRIER_TOOLS["ka-whale-workflow"]?.includes("plan_read") === true && MANAGED_CARRIER_TOOLS["ka-whale-workflow"]?.includes("ka_sub_whale") === true && MANAGED_CARRIER_TOOLS["ka-whale-workflow"]?.includes("plugin_maintainer_sub_whale_report") === true && MANAGED_CARRIER_TOOLS["ka-whale-workflow"]?.includes("plugin_creator_sub_whale_report") !== true && JSON.stringify(MANAGED_CARRIER_TOOLS["kaz-context-policy"]) === JSON.stringify(["context_search", "context_read", "context_compress"]) && MANAGED_CARRIER_TOOLS["create-plan"] === undefined && !MANAGED_PLUGINS.some((p) => p.id === "create-plan"));

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
