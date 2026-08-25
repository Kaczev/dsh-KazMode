# kaz-shared —— Kaz 模式工具清单 / 工具插件的单一事实源（依赖包，非 cordis 插件）

> **作用**：Kaz 全家桶的公共依赖包——Kaz 工具清单（出厂默认/首轮工具/默认禁用/被管理插件目录/默认 persona）、工具插件状态模型和工具面计算的唯一来源，其它插件不再各自维护副本。

`kaz-mode` / `kaz-memory` / `round-minimal` / `plugin-filter` 的公共依赖。
**纯 ESM 模块**（`lib/tool-lists.js`），不注册任何服务、不注入任何提示段，只是常量 + 纯函数。

## 职责

Kaz 模式的工具清单 / 工具插件模型**全部集中在这里**，其它组件不再各自维护副本：

| 导出 | 谁用 | 作用 |
| --- | --- | --- |
| `TOOL_WHITELIST` | 旧版兼容 / kaz-memory（可用性兜底） | 旧的官方工具默认清单（新代码优先用 `TOOL_PLUGIN_CATALOG` + `TOOL_PLUGINS`） |
| `TOOL_PLUGIN_CATALOG` / `TOOL_PLUGINS` | kaz-mode（统一工具面 factory） | 官方工具按插件分组的出厂目录 + 插件能力开关（tool-fs / tool-pwsh / ...） |
| `normalizePluginEnableDict` / `normalizeToolCatalog` / `mergePluginEnableDicts` / `mergeToolCatalogs` / `buildToolUniverse` / `computeEffectiveToolState` / `computeToolPluginSurfaceFromEffective` | kaz-mode 服务端/面板 | 官方+外置统一的四文件模型归一化、合并与工具面展开 |
| `effectiveToolWhitelist(whitelist)` | kaz-memory / 旧版兜底 | 旧数组白名单去重 |
| `computeSurface(inputs)` | kaz-mode 组装层 | 计算某代理此刻的 Kaz 工具面 |
| `DEFAULT_FIRST_ROUND_TOOLS_MEMORY_ON` / `_MEMORY_OFF` / `DEFAULT_FIRST_ROUND_TOOLS` | round-minimal / kaz-mode | 首阶段工具白名单：kaz-memory 开 = `memory_search`；关 = `pwsh`/`read`/`edit`；兜底 = MEMORY_OFF |
| `resolveFirstRoundTools({ kazMemoryEnabled })` | round-minimal / kaz-mode / computeSurface | 按 kaz-memory 启用状态解析首轮工具白名单（统一管理点） |
| `DEFAULT_DISABLED_TOOLS` | plugin-filter / kaz-mode | 默认禁用清单默认值 |
| `MANAGED_PLUGINS` / `FIXED_PERSONA` | kaz-mode 面板 | 被管理插件目录 / 默认 persona（实际提示词由 kaz 预设脚本控制） |

> **官方/Kaz 分类修改点**：`lib/tool-plugin-catalog.js`。外置插件数据（手动添加）保存在用户目录 storages 的 `other-*.json`；项目专属开关调整：官方/Kaz 写项目 `tool-plugin.json` / `tool-plugin-catalog.json`，外置写项目 `other-*.json`，**不写在源码里**。

## 工具面语义（2026-08 统一）

- **官方/外置统一为“工具插件”**：Kaz 工具面 = `原设置(代码 + 用户 other-*) → 用户默认 → 项目设置(项目 other-* + 项目 tool-plugin 文件)`
  四文件合并后的 enabled 工具；新插件/新工具不会自动写入，需要手动添加（写入用户 `other-*`，共享所有项目）；开关调整写项目对应文件（专属）。
- **官方出厂**：`TOOL_PLUGIN_CATALOG` + `TOOL_PLUGINS`（tool-fs / tool-pwsh / ... / kaz-memory）。
- **旧 `kaz-mode.toolWhitelist` 已弃用**：kaz-mode 不再读取/写入 settings.yaml 的该字段；
  `TOOL_WHITELIST` / `effectiveToolWhitelist` 仅保留给 kaz-memory 可用性兜底等旧路径。
- **Kaz 模式**（kaz-mode.enabled=true）：
  - 全量阶段 = `computeToolPluginSurfaceFromEffective(computeEffectiveToolState(...))`；
  - 首阶段（round-minimal 信号 `minimalPhase=true`）只保留 `firstRoundTools`；为空时按 `resolveFirstRoundTools({ kazMemoryEnabled })` 自动解析——kaz-memory 开 → `memory_search`；关 → `pwsh` + `read` + `edit`。
- **记忆工具**：仍由 kaz-mode 按 agent 会话开关从工具面剔除（不依赖 JSON 开关）。
- **非 Kaz 模式**：本模块不干预工具面（由标准模式决定）。

## 安装

```powershell
# profiles/web/package.json 的 dependencies 加入：
#   "kaz-shared": "file:KazPlugins/kaz-shared"
cd "$env:USERPROFILE\.dsh\profiles\web"
Remove-Item Env:npm_config_allow_scripts
npm install --legacy-peer-deps --no-audit --no-fund --save ./KazPlugins/kaz-shared
# 或手工建 junction：
# New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\kaz-shared" -Target "$env:USERPROFILE\.dsh\profiles\web\KazPlugins\kaz-shared"
```

## 探针

```powershell
node "$env:USERPROFILE\.dsh\profiles\web\KazPlugins\kaz-shared\probe-tool-lists.mjs"
# 期望输出：KAZ-SHARED PROBE OK
```
