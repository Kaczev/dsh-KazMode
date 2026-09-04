// probe-b4-readonly.mjs —— B4 工具控制面板只读化（静态源码 + RPC 语义探针）
// 运行：node KazPlugins/kaz-mode/probe-b4-readonly.mjs
// 覆盖：
//   - ToolPluginsSection 无启用/停用、删除、恢复、设为默认控件；
//   - UI 仍保留三类候选的查看/添加入口；
//   - index.js 提供只读 RPC 语义与候选读取/添加实现；
//   - 不清理 B5 旧代码。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const clientText = readFileSync(join(here, "lib", "client.js"), "utf8");
const indexText = readFileSync(join(here, "lib", "index.js"), "utf8");

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

// 提取 ToolPluginsSection（到下一个顶层函数 KazPanel）。
const toolSectionStart = clientText.indexOf("function ToolPluginsSection");
const kazPanelStart = clientText.indexOf("function KazPanel", toolSectionStart);
check("client.js 中存在 ToolPluginsSection 且在其后存在 KazPanel", toolSectionStart >= 0 && kazPanelStart > toolSectionStart);
const toolSection = toolSectionStart >= 0 && kazPanelStart > toolSectionStart
  ? clientText.slice(toolSectionStart, kazPanelStart)
  : "";

// R-B4-1 / R-B4-3：UI 不出现编辑控件/开关/删除/恢复/设为默认
check("ToolPluginsSection 不包含 Toggle", toolSection.includes("Toggle") === false);
check("ToolPluginsSection 不包含插件启用开关文案", toolSection.includes("插件启用开关") === false);
check("ToolPluginsSection 不包含工具开关文案", toolSection.includes("工具开关") === false);
check("ToolPluginsSection 不包含移除按钮", toolSection.includes("kzm-danger-btn") === false && toolSection.includes("applyRemovePlugin") === false);
check("ToolPluginsSection 不包含删除按钮", toolSection.includes("applyDeleteTool") === false);
check("ToolPluginsSection 不包含恢复/设为默认写处理函数", toolSection.includes("applySetAsDefault") === false && toolSection.includes("resetLayer") === false);
check("ToolPluginsSection 不调用 resetExternalToolPlugins/setExternalToolPluginsAsDefault", toolSection.includes("resetExternalToolPlugins") === false && toolSection.includes("setExternalToolPluginsAsDefault") === false);

// R-B4-2：三类候选查看/添加
check("ToolPluginsSection 保留私有插件候选添加", toolSection.includes("addPrivatePluginCandidate") && toolSection.includes("私有插件候选"));
check("ToolPluginsSection 保留 tool-jobs 固定集合展示", toolSection.includes("tool-jobs"));
check("ToolPluginsSection 保留外置插件候选添加", toolSection.includes("addExternalPlugin") && toolSection.includes("外置插件候选"));

// R-B4-3/R-B4-5：server 只读拒绝 + 候选写入
check("index.js 提供只读错误语义", indexText.includes("function rpcReadOnly") && indexText.includes('code: "read-only"'));
check("index.js 写入口包含只读拒绝（reset/as-default）", indexText.includes("不再提供恢复/重置入口") && indexText.includes("不再提供设为默认设置入口"));
check("index.js 仍支持 addPrivatePluginCandidate", indexText.includes('endpoint === "addPrivatePluginCandidate"'));
check("index.js 读取 schema v2 私有插件候选", indexText.includes("normalizeAgentManagedCandidateRegistry") && indexText.includes("privatePluginCandidates"));
check("index.js 返回只读展示固定面/工具集", indexText.includes("stableMainTools") && indexText.includes("workflowTools") && indexText.includes("toolJobs"));
check("index.js 保留旧 four-file 兼容读取路径", indexText.includes("loadExternalToolPluginLayers") && indexText.includes("getExternalToolPlugins"));

// R-B4-6 不改变 Stable Main/Sub 计算：主面常量仍来自 kaz-shared 固定面
check("index.js 未移除 Stable Main 固定面引用", indexText.includes("KAZ_STABLE_MAIN_TOOLS") && indexText.includes("stableMainSurface"));

console.log(failures === 0 ? "\nKAZ-MODE B4 READONLY PROBE OK" : `\nKAZ-MODE B4 READONLY PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
