# kaz-shared —— Kaz 模式工具清单的单一事实源（依赖包，非 cordis 插件）

`kaz-mode` / `kaz-memory` / `kaz-diag` / `round-minimal` / `plugin-filter` 的公共依赖。
**纯 ESM 模块**（`lib/tool-lists.js`），不注册任何服务、不注入任何提示段，只是常量 + 纯函数 + 模块级注册表。

## 职责

Kaz 模式的工具管理**全部集中在这里**，其它组件不再各自维护工具清单副本，只通过 API"发信"：

| API | 谁调用 | 作用 |
| --- | --- | --- |
| `registerGroup(id, {tools, label})` | kaz-memory / kaz-diag（apply 时） | 声明自己的工具组 |
| `setGroupEnabled(id, enabled)` | kaz-memory / kaz-diag（enabled 变化时） | 通知工具组开关 |
| `unregisterGroup(id)` | kaz-memory / kaz-diag（卸载时） | 注销工具组 |
| `computeSurface(inputs)` | kaz-mode 组装层 / kaz-diag 报告 | 计算某代理此刻的 Kaz 工具面 |
| `effectiveToolWhitelist(toolWhitelist)` | kaz-diag 报告等 | 有效白名单（白名单 ∪ 启用群组 − 停用群组） |
| 常量 | 各插件 | `DEFAULT_TOOL_WHITELIST` / `DEFAULT_MINIMAL_TOOLS` / `DEFAULT_FIRST_ROUND_TOOLS` / `DEFAULT_DISABLED_TOOLS` / `MANAGED_PLUGINS` / `FIXED_PERSONA` |

## 工具面语义（2026-08-21 统一）

- **Kaz 模式**（kaz-mode.enabled=true）：
  - 全量阶段 = `minimalTools` ∪ `effectiveToolWhitelist`；
  - 首阶段（round-minimal 信号 `minimalPhase=true`）**仅保留 firstRoundTools**（为空回退 minimalTools）——"首次工具调用仅保留 round-minimal 的工具"。
- **群组规则**：已启用群组的工具总是加入工具面（即使不在白名单里）；已停用群组的工具总是排除（即使写进了白名单）。kaz-memory 六工具与 kaz_mode_status 的加入/排除完全由各自 enabled 决定，无需任何插件硬编码工具名。
- **非 Kaz 模式**：本模块不干预工具面（由标准模式决定）；kaz-memory / kaz-diag 关闭时已自行注销工具。
- **用户配置优先**：settings.yaml 的 `toolWhitelist` / `minimalTools` / `firstRoundTools` / `disabledTools` 始终是实际生效值；本模块只提供默认值与计算，不读写设置。

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
