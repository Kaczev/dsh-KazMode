// kaz-shared 探针：Agent 管理「自写工具」层（第14次更新）。
// 覆盖：识别规则（kaz-skill-* + agentManaged 两个条件缺一不可）；
// registry 归一化；全局合并语义（用户/项目 other-* 删除不能移除）；
// registry 缺失/损坏 = feature off（行为与旧版一致）；与四文件模型分离。
// 运行：node KazPlugins/kaz-shared/probe-agent-managed-tools.mjs
import {
  AGENT_MANAGED_PLUGIN_PREFIX,
  AGENT_MANAGED_CATALOG_GROUP_ID,
  AGENT_MANAGED_STORAGE_FILE,
  normalizeAgentManagedRegistry,
  agentManagedPluginKeys,
  agentManagedToolNames,
  agentManagedCatalogEntries,
  agentManagedRegistryHasPlugin,
  mergeAgentManagedToolsIntoSurface,
  computeToolPluginSurface,
  TOOL_PLUGIN_CATALOG,
  TOOL_PLUGINS,
} from "./lib/tool-lists.js";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

const VALID_REGISTRY = {
  version: 1,
  plugins: {
    "kaz-skill-safe-json": {
      agentManaged: true,
      tools: ["safe_json_write"],
    },
  },
};

// ① 常量与识别规则
check("AGENT_MANAGED_PLUGIN_PREFIX = kaz-skill-", AGENT_MANAGED_PLUGIN_PREFIX === "kaz-skill-");
check("AGENT_MANAGED_CATALOG_GROUP_ID = agent", AGENT_MANAGED_CATALOG_GROUP_ID === "agent");
check("AGENT_MANAGED_STORAGE_FILE 是全局 registry 文件名", typeof AGENT_MANAGED_STORAGE_FILE === "string" && AGENT_MANAGED_STORAGE_FILE.length > 0);

{
  const normalized = normalizeAgentManagedRegistry(VALID_REGISTRY);
  check(
    "合法条目：kaz-skill-* + agentManaged=true 被接受",
    Object.keys(normalized.plugins).includes("kaz-skill-safe-json") &&
      normalized.plugins["kaz-skill-safe-json"].agentManaged === true &&
      JSON.stringify(normalized.plugins["kaz-skill-safe-json"].tools) === JSON.stringify(["safe_json_write"]),
  );
}

{
  const badMarker = normalizeAgentManagedRegistry({
    plugins: {
      "kaz-skill-safe-json": { tools: ["safe_json_write"] }, // 缺 agentManaged
    },
  });
  check("识别规则条件二：缺 agentManaged 标记被拒绝", Object.keys(badMarker.plugins).length === 0);
}

{
  const badPrefix = normalizeAgentManagedRegistry({
    plugins: {
      "safe-json-write": { agentManaged: true, tools: ["safe_json_write"] }, // 缺 kaz-skill-*
    },
  });
  check("识别规则条件一：非 kaz-skill-* 前缀被拒绝", Object.keys(badPrefix.plugins).length === 0);
}

{
  const bothBad = normalizeAgentManagedRegistry({
    plugins: {
      "kaz-skill-safe-json": { agentManaged: false, tools: ["safe_json_write"] },
      "other-plugin": { agentManaged: true, tools: ["x"] },
    },
  });
  check("两个条件缺一即不算 Agent 管理工具", Object.keys(bothBad.plugins).length === 0);
}

{
  const messy = normalizeAgentManagedRegistry({
    plugins: {
      "Kaz_Skill_Safe_JSON": {
        agentManaged: true,
        tools: [" safe_json_write ", "safe_json_write", "", 42],
      },
    },
  });
  const entry = messy.plugins["kaz-skill-safe-json"];
  check(
    "归一化：plugin key 与工具名 trim/去重/过滤",
    entry !== undefined &&
      entry.agentManaged === true &&
      JSON.stringify(entry.tools) === JSON.stringify(["safe_json_write"]),
  );
}

// ② 缺失 / 损坏 → feature off
{
  const empty = normalizeAgentManagedRegistry(null);
  const corrupt = normalizeAgentManagedRegistry({ plugins: "broken" });
  const noMarker = normalizeAgentManagedRegistry({ plugins: { "kaz-skill-safe-json": { tools: ["safe_json_write"] } } });
  check("registry null → 空", Object.keys(empty.plugins).length === 0 && agentManagedToolNames(empty).length === 0);
  check("registry 损坏 → 空（feature off）", Object.keys(corrupt.plugins).length === 0 && Object.keys(noMarker.plugins).length === 0);
}

{
  const base = new Set(["read", "pwsh", "edit"]);
  const unchanged = mergeAgentManagedToolsIntoSurface(base, null);
  check(
    "registry 缺失时 merge 原样返回（旧行为）",
    unchanged.size === 3 &&
      unchanged.has("read") &&
      unchanged.has("pwsh") &&
      unchanged.has("edit") &&
      !unchanged.has("safe_json_write"),
  );
  check("merge 返回新 Set，不改入参", base.size === 3 && unchanged !== base);
}

// ③ 全局合并：即使项目/用户 other-* 显式关闭或删除，Agent 管理工具仍进入表面
{
  const userDeleted = computeToolPluginSurface({
    codeCatalog: TOOL_PLUGIN_CATALOG,
    codeEnabled: TOOL_PLUGINS,
    userOtherEnable: { "kaz-skill-safe-json": false },
    userOtherCatalog: { "kaz-skill-safe-json": { safe_json_write: false } },
    projectOtherEnable: { "kaz-skill-safe-json": false },
    projectOtherCatalog: { "kaz-skill-safe-json": { safe_json_write: false } },
  });
  check("四文件模型本身不含被 other-* 关闭的 kaz-skill-* 工具", !userDeleted.has("safe_json_write"));

  const merged = mergeAgentManagedToolsIntoSurface(userDeleted, VALID_REGISTRY);
  check(
    "agent registry 并入后 safe_json_write 全局可见（用户/项目关闭无效）",
    merged.has("safe_json_write"),
  );

  const surface2 = computeToolPluginSurface({
    codeCatalog: TOOL_PLUGIN_CATALOG,
    codeEnabled: TOOL_PLUGINS,
  });
  const merged2 = mergeAgentManagedToolsIntoSurface(surface2, VALID_REGISTRY);
  check("agent 工具不依赖 any other-*/four-file 条目即可进入表面", merged2.has("safe_json_write"));
}

// ④ registry 查询 / catalog 组
{
  const keys = agentManagedPluginKeys(VALID_REGISTRY);
  const tools = agentManagedToolNames(VALID_REGISTRY);
  const entries = agentManagedCatalogEntries(VALID_REGISTRY);
  check(
    "agentManagedPluginKeys / ToolNames / HasPlugin",
    JSON.stringify(keys) === JSON.stringify(["kaz-skill-safe-json"]) &&
      JSON.stringify(tools) === JSON.stringify(["safe_json_write"]) &&
      agentManagedRegistryHasPlugin(VALID_REGISTRY, "Kaz_Skill_Safe_JSON") === true &&
      agentManagedRegistryHasPlugin(VALID_REGISTRY, "other-plugin") === false,
  );
  check(
    "agentManagedCatalogEntries 返回只读组条目",
    entries.length === 1 &&
      entries[0].plugin === "kaz-skill-safe-json" &&
      entries[0].agentManaged === true &&
      JSON.stringify(entries[0].tools) === JSON.stringify(["safe_json_write"]),
  );
}

{
  const multi = normalizeAgentManagedRegistry({
    plugins: {
      "kaz-skill-safe-json": { agentManaged: true, tools: ["safe_json_write", "b"] },
      "kaz-skill-other": { agentManaged: true, tools: ["safe_json_write", "a"] },
      "kaz-skill-bad": { agentManaged: false, tools: ["x"] },
    },
  });
  check(
    "多插件合并：工具去重排序、非法条目忽略",
    JSON.stringify(agentManagedToolNames(multi)) === JSON.stringify(["a", "b", "safe_json_write"]) &&
      JSON.stringify(agentManagedPluginKeys(multi)) === JSON.stringify(["kaz-skill-other", "kaz-skill-safe-json"]),
  );
}

console.log(failures === 0 ? "\nAGENT-MANAGED-TOOLS PROBE OK" : `\nAGENT-MANAGED-TOOLS PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
