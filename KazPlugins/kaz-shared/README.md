# kaz-shared —— Kaz 模式工具清单的单一事实源（依赖包，非 cordis 插件）

> **作用**：Kaz 全家桶的公共依赖包——Kaz 工具清单（白名单/首轮工具/默认禁用/被管理插件目录/默认 persona）和工具面计算的唯一来源，其它插件不再各自维护副本。

`kaz-mode` / `kaz-memory` / `kaz-diag` / `round-minimal` / `plugin-filter` 的公共依赖。
**纯 ESM 模块**（`lib/tool-lists.js`），不注册任何服务、不注入任何提示段，只是常量 + 纯函数。

## 职责

Kaz 模式的工具清单**全部集中在这里**，其它组件不再各自维护工具清单副本：

| 导出 | 谁用 | 作用 |
| --- | --- | --- |
| `TOOL_WHITELIST` | kaz-mode（schema/自愈默认）、kaz-diag（报告兜底）、kaz-memory（可用性兜底） | Kaz 模式下允许出现的**全部**工具默认清单（含记忆六工具与 `kaz_mode_status`） |
| `effectiveToolWhitelist(whitelist)` | kaz-mode / kaz-diag / kaz-memory | 有效白名单 = 用户 settings.toolWhitelist 原样去重（白名单是**唯一闸门**） |
| `computeSurface(inputs)` | kaz-mode 组装层 / kaz-diag 报告 | 计算某代理此刻的 Kaz 工具面 |
| `DEFAULT_FIRST_ROUND_TOOLS_MEMORY_ON` / `_MEMORY_OFF` / `DEFAULT_FIRST_ROUND_TOOLS` | round-minimal / kaz-mode / kaz-diag | 首阶段工具白名单：kaz-memory 开 = `memory_search`；关 = `pwsh`/`read`/`edit`；兜底 = MEMORY_OFF |
| `resolveFirstRoundTools({ kazMemoryEnabled })` | round-minimal / kaz-mode / kaz-diag / computeSurface | 按 kaz-memory 启用状态解析首轮工具白名单（统一管理点） |
| `DEFAULT_DISABLED_TOOLS` | plugin-filter / kaz-mode | 默认禁用清单默认值 |
| `MANAGED_PLUGINS` / `FIXED_PERSONA` | kaz-diag（展示默认 persona） | 被管理插件目录 / 默认 persona（实际提示词由 kaz 预设脚本控制） |

## 工具面语义（2026-08-21 统一）

- **白名单是唯一闸门**：`TOOL_WHITELIST`（及用户 settings 里的 `kaz-mode.toolWhitelist`，Kaz 面板可编辑、热重载）列出 Kaz 模式下允许出现的**全部**工具——包括 kaz-memory 六工具与 kaz-diag 的 `kaz_mode_status`。**不在清单里的工具即使被注册也不会进入工具列表**。
- **Kaz 模式**（kaz-mode.enabled=true）：
  - 全量阶段 = `effectiveToolWhitelist`（= 用户 settings.toolWhitelist 原样去重）；
  - 首阶段（round-minimal 信号 `minimalPhase=true`）只保留 `firstRoundTools`；为空时按 `resolveFirstRoundTools({ kazMemoryEnabled })` 自动解析——kaz-memory 开 → `memory_search`；关 → `pwsh` + `read` + `edit`。无交集演算、无 minimalTools。
- **记忆/诊断工具出现 ⇔ 插件 enabled 时注册到 harness（关闭时完全注销，由各插件自身负责）且名字在白名单里**。两者缺一不可。
- **非 Kaz 模式**：本模块不干预工具面（由标准模式决定）。
- **用户配置优先**：`kaz-mode.toolWhitelist` 仍在 settings.yaml 的 `kaz-mode` 段
  （Kaz 面板可编辑、热重载）；`firstRoundTools` / `disabledTools` 的**生效值**在
  Kaz 会话下由 kazMode 服务按会话读取（kaz-defaults.json + kaz-session-states.json），
  settings.yaml 插件段仅作 standalone 兜底。本模块只提供默认值与计算，不读写设置。

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
