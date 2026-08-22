# plugin-filter（原 tool-filter，中文说明）

> **作用**：从 dsh 的工具列表中过滤指定工具，阻止它们被加载或使用——默认屏蔽 `tool-cordis`、`tool-subagent-report`、`codex`、`claude-code`，可随时追加。

一个 dsh（DeepSeek Harness）插件：从 dsh 的工具列表中**过滤指定工具**，阻止它们
被加载或使用。默认屏蔽 `tool-cordis`、`tool-subagent-report`、`codex`、
`claude-code` 四个工具/插件，并允许你随时追加更多。

## 功能说明

插件提供两种模式（可在配置中切换，**默认模式 A**）：

| 模式 | 配置值 | 行为 |
|---|---|---|
| A（不添加） | `mode: remove` | 分两层生效：**插件级**——直接禁用命中"插件名"的 loader 条目（如 `tool-subagent-report`），该插件本体不再加载（工具、提示段、提供者全部消失），dsh 插件列表显示"已停用"；**工具级**——工具定义在注册时被直接丢弃，即使目标工具先于本插件被注册（例如来自 bundle 层的工具插件），组装与查询层的兜底也会让它们**不可见、不可调用**（调用返回 `unknown tool`）。 |
| B（禁用） | `mode: disable` | 被禁用的工具**保留在列表中**（模型可见、UI 可见），插件本身也不停用，但 dsh **不会真正调用它们**：所有调用在 `tools/pre-execute` 阶段被拒绝，模型收到明确的拒绝原因。 |

另有一个总开关 `enabled`（默认 `true`），设为 `false` 即整体停用过滤。

> 说明：插件列表里的"已启用/已停用"标签是**插件（组合条目）级**状态。模式 A
> 会把命中的插件条目（如 `tool-subagent-report`）标记为停用并卸载，UI 里对应
> 卡片会变为"已停用"；而名单中的纯工具名（如 `codex`、`claude-code`）没有对应
> 的插件条目，只走工具级过滤（插件列表里不出现，也无需出现）。

### 匹配规则

对 `disabledTools` 列表中的每个条目（大小写不敏感），满足任意一条即命中：

1. **工具名完全一致** —— 如条目 `codex` 命中工具 `codex`；
2. **注册该工具的插件名完全一致** —— 如条目 `tool-cordis` 命中插件
   `tool-cordis`（`dsh-tool-cordis` 的所有 `cordis_*` 工具都会被丢弃）；
   插件名取自 Cordis 运行时 `fiber.name`（工具插件模块导出的 `name` 字段）；
3. **归一化后一致** —— 忽略所有非字母数字字符，如 `claude_code` 也会命中
   `claude-code`；
4. **`tool-` 前缀条目的最后分段与工具名一致** —— 如条目
   `tool-subagent-report` 也会禁用字面名为 `report` 的工具（该工具是在子代理
   作用域异步注册的，无法用插件名归属，靠这条规则命中）。

> 插件级禁用（模式 A）额外按 loader 条目的 `id`/`name` 做精确、归一化或包含
> 匹配（例如 `dsh-tool-cordis` 也能命中 `@deepseek-ai/dsh-tool-cordis` 条目），
> 但**不使用**规则 4 的末段匹配，避免误伤 `cordis-host-runner` 这类名字里带
> `cordis` 的 dsh 基础设施插件。

### 多层防线（为什么不存在"先加载后禁用"的竞态）

插件同时在多条链路上生效，**任意一层兜底都足以保证目标工具不可见/不可调用**：

1. **插件层（模式 A）**：禁用命中的 loader 条目（如 `tool-subagent-report`），
   该插件本体不再加载。启动时条目并发初始化，插件会在 apply 时立即扫描一遍，
   并在微任务/宏任务各补扫一次；对之后新出现的条目（配置热更新）监听
   `loader/entry-init`；若禁用标志落定前插件 fiber 已被创建（并发竞态），
   `internal/plugin` 兜底会直接销毁该 fiber；
2. **注册层**：补丁 `ToolRuntime.register` —— `remove` 模式下被命中的注册请求
   直接返回空 disposer，工具从未进入注册表；
3. **组装/查询层**：`system-prompt/assemble` 瀑布从**模型可见的工具列表**与
   `tool:*` 指导段中移除被禁用的工具；`tools.get` / `tools.schemas` 兜底，让
   任何查询都返回"不存在"（执行器因此以 `UNKNOWN_TOOL` 拒绝，Code Mode 的
   `run_code` SDK 绑定同样拿不到它们）；
4. **执行层**：`tools/pre-execute` 瀑布 —— `disable` 模式下所有对被禁用工具的
   调用在此被拒绝，返回明确的拒绝原因。

> 插件来自 `cordis.patch.yml`（用户补丁层），而内置工具插件来自 bundle 层
> （如 `@deepseek-ai/dsh-base`），bundle 会先于补丁层挂载。即使某个工具在
> plugin-filter 补丁生效**之前**就已注册，第 2、3 层兜底仍会保证它既不出现在
> 模型可见的工具列表里、也不会被执行 —— 因此不存在可观察到的竞态。

## 文件结构

```
plugin-filter/
├── package.json      # 包元数据 + peer 依赖
├── lib/index.js      # 插件本体（纯 ESM，Cordis 插件）
└── README.md         # 本文件
```

## 安装

> 插件已安装到本机 `~/.dsh/profiles/web`（复制 + junction + 组合行 + settings
> 均已就绪），如果你拿到的就是这份环境，直接跳到「使用」。以下为通用安装步骤。

dsh 的插件 = 一个 npm 包 + 组合（`cordis.yml` 补丁）里的一行。共三步：

**① 把包放进 profile**（目录位置：`~/.dsh/profiles/web/KazPlugins/plugin-filter`）。
任选其一：

- 方式 A（npm，推荐）：

  ```powershell
  cd "$env:USERPROFILE\.dsh\profiles\web"
  # 本机 dsh 环境会设置 npm_config_allow_scripts，npm 11 会因此拒绝项目内安装，
  # 临时移除即可（只影响这一次命令）
  Remove-Item Env:npm_config_allow_scripts
  npm install --legacy-peer-deps --no-audit --no-fund --save ./KazPlugins/plugin-filter
  ```

  npm 会把 `web/node_modules/plugin-filter` 建成指向
  `web/KazPlugins/plugin-filter` 的目录联接（junction），改源码即时生效、无需重装。

- 方式 B（无 npm / 不想用 npm）：

  ```powershell
  $dst = Join-Path $env:USERPROFILE ".dsh\profiles\web\KazPlugins\plugin-filter"
  Copy-Item "C:\Users\Kaczev\.dsh\profiles\web\KazPlugins\plugin-filter" -Destination $dst -Recurse -Force
  New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\plugin-filter" -Target $dst
  ```

**② 修改 `cordis.patch.yml`（必须）**：在
`~/.dsh/profiles/web/cordis.patch.yml` 末尾追加组合行：

```yaml
- insert:
    - id: plugin-filter
      name: plugin-filter
      config:
        enabled: true
        mode: remove
        disabledTools:
          - tool-cordis
          - tool-subagent-report
          - codex
          - claude-code
```

想让插件对**所有** profile 生效：把这段放到 `~/.dsh/cordis.patch.yml`（机器级层）
而不是 profile 文件。

**③ 修改 `~/.dsh/settings.yaml`（可选但推荐）**：追加 `plugin-filter:` 段，保存即
**热重载**，之后无需重启即可开关、切模式、改列表：

```yaml
plugin-filter:
  enabled: true
  mode: remove
  disabledTools:
    - tool-cordis
    - tool-subagent-report
    - codex
    - claude-code
```

> 纯方案 A：Kaz 会话下生效 enabled / mode / disabledTools 由 kazMode 服务按会话
> 读取（Kaz 面板可调），settings.yaml 段仅作 standalone 兜底（注册期全局行为仍由
> 它驱动；组装/执行层按会话判定）。

**④ 重启 dsh**（或等待热重载）。运行中的 dsh 会热重载用户补丁，改完
`cordis.patch.yml` 可能当场挂载插件；重启可确保挂载状态干净。

## 配置选项

| 选项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关。`false` 时不过滤任何工具。 |
| `mode` | `"remove"` \| `"disable"` | `"remove"` | 过滤模式，见上表。 |
| `disabledTools` | string[] | `["tool-cordis", "tool-subagent-report", "codex", "claude-code"]` | 要禁用的工具/插件名，可自由增删。 |

组合行 `config` 是 **base 层**；`settings.yaml` 是**用户层**，用户层优先。
设置页（设置 → 插件配置）中也会出现 `plugin-filter` 命名空间，可直接编辑。

## 使用示例

**切换成"禁用"模式（工具保留在列表中，但调用被拒绝）**：

```yaml
# ~/.dsh/settings.yaml
plugin-filter:
  enabled: true
  mode: disable
  disabledTools:
    - tool-cordis
    - tool-subagent-report
    - codex
    - claude-code
```

**追加一个自定义禁用项（例如再禁用 `web_search`）**：

```yaml
plugin-filter:
  enabled: true
  mode: remove
  disabledTools:
    - tool-cordis
    - tool-subagent-report
    - codex
    - claude-code
    - web_search
```

**临时整体关闭**：

```yaml
plugin-filter:
  enabled: false
```

## 如何验证生效

1. **组合正确**（免启动）：

   ```powershell
   dsh --profile web --dump-config | Select-String "plugin-filter"
   ```

   输出中应能看到 `plugin-filter` 行及其 `config`（enabled / mode / disabledTools）。

2. **插件列表（UI 设置 → 插件 → 插件列表）**：
   - `mode: remove`：`tool-subagent-report` 卡片应显示 **"已停用"**（无状态圆点）；
     `plugin-filter` 显示"已启用"。
   - 顺带说明：`tool-cordis` 这个工具插件**并未**挂载在 web profile 的组合里，
     插件列表不会出现它；列表里那些名字带 `cordis` 的条目（如
     `cordis-host-runner`、`cordis-client-runner`、`ui-cordis`）是 dsh 自身的
     基础设施插件，不在禁用名单中，应保持"已启用"。

3. **工具列表**：在 dsh 界面查看工具列表 / 模型可见的工具：
   - `mode: remove`：`cordis_inspect_*`、`report`、`codex`、`claude-code`
     不应出现在列表中；
   - `mode: disable`：它们仍在列表中，但调用会被拒绝。

4. **尝试调用**：新开一段对话，要求模型调用被禁用的工具：
   - `mode: remove`：模型看不到该工具；即使强行构造调用也返回
     `unknown tool`；
   - `mode: disable`：模型能看到该工具，但调用返回
     `工具 "X" 已被 plugin-filter 禁用（mode: disable…）`。

5. **开关**：把 `enabled` 改成 `false` 保存（热重载），再重复第 2、3 步 ——
   工具应恢复可见/可用；验证完改回 `true`。

6. **其他工具不受影响**：`pwsh`、`subagent`、`web_search` 等未列入
   `disabledTools` 的工具应始终正常工作。

## 注意事项

- **插件级禁用需要重启生效一次**：模式 A 对插件条目的禁用发生在插件加载时，
  因此**新增/修改 `disabledTools` 里的插件名条目后需要重启 dsh**；纯工具名
  条目（如 `codex`）改动则热重载即生效。
- **模式切换**：`remove → disable` 后，之前已被禁用/丢弃的插件与工具要
  **重启 dsh** 才会恢复；`disable → remove` 即时生效（插件层禁用 + 组装与查询
  兜底层立刻隐藏并拒绝它们）。
- **禁用 `tool-subagent-report` 的影响**：模式 A 下该插件本体被停用，子代理的
  `report` 工具不会注册；模式 B 下它仍注册但调用被拒绝。无论哪种模式，子代理
  都无法用 `report` 主动向父代理推送中间结果，但仍可通过**最终回复**正常汇报。
- 匹配规则按"工具名 + 注册插件名"双维度进行，与工具的来源无关（内置工具、
  MCP 工具、动态插件注册的工具一视同仁）。
- 插件只处理 `disabledTools` 命中的条目，**不触碰任何其他工具**的定义与调用。
- 卸载时所有补丁（插件条目禁用、注册/查询/组装/执行）都会随插件纤维一并恢复
  （插件条目恢复为"已启用"）。


## 卸载

```powershell
cd "$env:USERPROFILE\.dsh\profiles\web"
Remove-Item Env:npm_config_allow_scripts
npm uninstall --legacy-peer-deps plugin-filter
# 再删掉 cordis.patch.yml 里的 plugin-filter insert 行、
# settings.yaml 里的 plugin-filter: 段，重启 dsh。
```
