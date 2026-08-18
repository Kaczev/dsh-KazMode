# kaz-mode —— 「Kaz 模式」超级模式插件

Kaz 模式同时具备两个入口，双向同步：

1. **agent preset**：`kaz` 预设已注册进 dsh 的预设体系（在预设选择器里与标准模式、
   极简模式等并列可选）；
2. **会话头部按钮**：dsh Web UI 会话头部（session log 按钮左侧）常驻一个
   **「Kaz 模式：已开启 / 已关闭」** 按钮，一键联动管理本工作区八个插件，并带集中管理面板。

| 插件 | 角色 |
| --- | --- |
| `thinking-anchor`（插件1） | 思考锚点：新对话首次组装注入一次思考方式指令 |
| `round-minimal`（插件2） | 极简plus轮次模式：首轮只暴露 `pwsh` / `str_replace_editor`，次轮起开放其它工具 |
| `tool-grouping`（插件3） | 工具分组：文件工具 → tool-fs 组、工作流工具 → workflowEngine 组、记忆工具 → kaz-memory 组 |
| `tool-filter`（插件4） | 工具过滤：按名单移除 / 禁用指定工具 |
| `code-collapse`（插件5） | 工具塌缩：把工具面折叠为唯一入口 `run_code`，每次调用后追加 We need 提示 |
| `output-beep`（插件6） | 输出完成提示音：模型输出完毕时响提示音（可配频率/时长/子代理） |
| `task-master-whiteboard`（插件7） | 任务白板：Task Master 白板工具与角色提示段 |
| `round-display`（插件8） | 每轮注入显示：记录每轮 Kaz 联动/附属插件给模型发送的信息，「本轮注入」按钮+面板（开关在 Kaz 面板；关闭时完全隐藏） |

**Kaz 模式 = round-minimal（极简plus）基底 + kaz-mode 自身工具面（minimalTools 极简基底 + toolWhitelist 白名单）+ tool-grouping 分组叠加 + thinking-anchor / tool-filter / code-collapse 一同生效**。kaz 预设的 persona 与原生极简模式逐字一致（`You are a helpful software engineer assistant.`），kaz-mode 在此基础上叠加"首轮极简伪装 + 次轮基底恢复"：首轮系统提示保留 persona + thinking-anchor + round-minimal 轮次提示（首轮不执行任务，仅询问细节）+ code-collapse 首轮提醒（尽量一次 run_code 多用工具），次轮起 persona 替换为 `postFirstRoundMode` 对应的 shipped 预设 persona（standard / minimal / creative，默认 standard）；运行时上下文与极简模式同样被抑制。kaz-mode 自身不注册任何 systemPrompt 段，不覆盖用户已有配置。

### Kaz 工具面（minimalTools + toolWhitelist）

Kaz 模式开启（`enabled: true`）时，kaz-mode 把模型可见/可调用的工具收敛为：

- **极简基底 `minimalTools`**（默认 `pwsh`、`str_replace_editor`）——始终保留；
- **白名单 `toolWhitelist`**（默认 `kaz-memory`、`tool-fs`、`workflowEngine`、`tool_grouping_status`、`kaz_mode_status`）——条目可以是**组 id**（经 tool-grouping 的 `toolGrouping` 服务展开为组内工具）或**字面工具名**，全部可在 settings.yaml 热改。

两层生效：组装层（`system-prompt/assemble`）过滤工具与 `tool:*` 指导段；执行层（`tools/pre-execute`）拒绝白名单外的调用。**host 平面监听器对所有 agent 生效——子代理会话（subagent / workflow / ralph 派生）同样是 Kaz 工具面。**

### round-minimal 信号（首轮极简伪装）

round-minimal 发布 `roundMinimal` 服务并推送 `round-minimal/state` 事件。kaz-mode 据此在**首轮极简激活**时把工具面收敛为仅 `minimalTools`（不展开白名单），并把提示段滤到**只保留 persona + thinking-anchor + round-minimal:policy（轮次提示）+ code-collapse:first-round（首轮提醒）**（harness 身份段、tool:* 指导段、kaz-memory 记忆指引等全部不出现——首轮没有 `memory_search`，不提示模型"先搜索记忆"；round-minimal/code-collapse 的段各自按开关与轮次输出，关闭或非首轮时渲染为空）。次轮起：persona 替换为 `postFirstRoundMode` 对应的 shipped 预设 persona（standard / minimal / creative），工具面恢复为 `minimalTools + 白名单`，kaz-memory 记忆指引恢复。

---

## 功能说明

### 1. 会话头部「Kaz 模式」按钮（打开详细设置面板）

- 按钮常驻**会话头部工具区**（`conversation.session.header.utilities` slot），
  以 `order: -1` 排在 **session log 按钮左侧**——行内排版，不会遮挡任何按钮；
- 按钮只显示状态 + **点击展开 / 收起「Kaz 模式 · 详细设置」面板**，不再切换预设：
  开启 / 关闭 Kaz 模式一律用**预设选择器**（选 `kaz` 开、选其它关）；
- 状态清晰可辨：文字（`Kaz 模式：已开启 / 已关闭`）+ 圆点颜色变化（绿色=开启）；
  橙色圆点 = 预设已是 kaz 但联动未激活（面板里有「启用联动」恢复按钮）；
- **预设选择器里切换预设时，按钮状态实时同步**（读同一个 `agent-presets.default` 字段）。

### 1.5 预设联动（宿主半自动同步）

- 预设切到 `kaz` → 宿主自动把 `kaz-mode.enabled` 置 `true` → 触发下面的插件联动；
- 预设切走 → 置 `false` → 恢复五个插件原始状态；
- 最近一个非 kaz 预设自动记录到 `kaz-mode.previousPreset`，按钮"关闭"时切回它；
- 启动时若默认预设已是 `kaz`（重启前选着），自动开启联动。

### 2. 插件联动

- **开启 Kaz 模式**：先把五个插件在 `settings.yaml` 里的原始 `enabled` 状态快照到
  `kaz-mode.savedPluginStates`（持久化，重启后仍可恢复），再把它们全部自动启用
  （已启用的不动；未加载的插件跳过）。同时把 round-minimal 的 `showPolicy`（轮次
  提示段开关）**原值快照**到 `kaz-mode.roundMinimalPolicySnapshot` 并置为 `true`
  ——Kaz 模式下首轮/次轮轮次提示正常输出（首轮：不执行任务、仅询问细节；次轮：更多工具开放）。
- **关闭 Kaz 模式**：五个插件的 `enabled` 保持当前状态、不做改动（只有"进入 Kaz"
  才强制启用；用户在 Kaz 模式下手动关闭的保持关闭）。例外：round-minimal 的
  `showPolicy` 按快照**精确恢复**——原来用户显式写过的写回原值（原本是 `false`
  就恢复为 `false`，不无脑打开），原来没写过的 `unset` 掉联动写入、回到继承默认。
- 面板里的单个开关是独立的：Kaz 模式开启期间，你可以单独开/关某个插件，改动即时生效
  （该改动会在下次"开启 Kaz"时被快照为新的原始状态）。

### 3. Kaz 模式详细设置面板（头部按钮展开）

面板标题「Kaz 模式 · 详细设置」，自上而下：当前预设状态与切换提示、Kaz 模式组成说明
（极简基底 round-minimal + thinking-anchor + tool-filter + tool-grouping；kaz-no-context
为 kaz 预设内置前置；kaz-memory 为独立记忆组件，与以上插件不耦合，但有自己的
`enabled` 开关（关闭后记忆面板整体隐藏））、kaz-mode 自身配置行、插件1–8、
kaz-memory 配置行。每个插件显示：

- **插件名称 + 角色标注**（插件1 · 思考锚点 等）；
- **当前状态徽章**：启用 / 禁用 / 未安装；
- **独立切换开关**：单独启用/禁用该插件；
- **「配置」按钮**：展开该插件的配置表单，字段与该插件 `settings.yaml` 段一一对应
  （布尔、单选、字符串、多行文本、逗号分隔列表、JSON 数组编辑）；
- **自动同步**：面板里的任何改动都通过 dsh 的 settings 通道写入 `~/.dsh/settings.yaml`，
  保存即热重载，无需重启。

### 4. 对话首轮提示（仅 UI 显示，不注入模型）

Kaz 模式开启时，**每个对话的首轮**在输入框上方显示提示条：

> **请在第一句话中说明本次对话的总任务目标。**

- 显示位置：输入框上方（`conversation.input.dock` slot），与待办/队列条同区域；
- 出现条件：Kaz 模式开启 + 当前对话仍在首轮（尚无任何 `turn/start` 或最大轮次 ≤ 1）
  + `round-minimal` 启用 + 未手动关闭；
- 纯 UI 提示，**不是**给模型的提示词——文本不会进入 system prompt；
- 第二轮起自动消失，也可以点 × 手动关闭（每会话独立）。

### 5. 只读状态工具 `kaz_mode_status`

`registerStatusTool: true` 时注册（无论开关状态——诊断工具不随开关隐藏），输出：Kaz 开关状态、五个插件的
启停与原始状态快照、tool-grouping 的**运行时分组视图**、round-minimal 的首轮工具基底。

> **特别重要——工具分组不硬编码**：kaz-mode 不含任何工具列表。分组事实全部来自
> tool-grouping 插件发布的 `toolGrouping` 运行时服务（`enabled/groups/groupOf/isRegistered`），
> 首轮工具集全部来自 round-minimal 的 `firstRoundTools` 配置。改动 tool-grouping 的分组
> 或 round-minimal 的白名单，kaz-mode 的报告与行为自动跟随。

---

## 架构

kaz-mode 是**双平台（host + client）**插件包：

```
kaz-mode/
├── package.json            # type: module；dsh.client 声明（web 平台客户端半）
├── lib/
│   ├── index.js            # 宿主半：配置管理 + 插件联动 + 预设联动 + kaz_mode_status 工具
│   └── client.js           # 客户端半：头部按钮 + 管理面板 + 首轮提示条
├── probe-kaz-mode.mjs      # 宿主逻辑探针（联动/恢复/预设联动/报告）
├── probe-kaz-mode-client.mjs  # 客户端冒烟探针（slot 注册 / 渲染 / 预设写入）
└── README.md               # 本文档
```

另外配套一个 agent preset（位于 `~/.dsh/.agent-presets/kaz/`，工作区参考副本在 `kaz-preset/`）：

```
kaz-preset/
├── agent.cordis.yml        # 组合 = shipped cordis 预设的完整副本（persona 非 complete，
│                           #   完整工具面 + 上下文注入正常；Kaz 的"极简"由 round-minimal 动态施加）
├── preset.yml              # name: Kaz 模式 / description
└── skills/                 # 随 cordis 副本带入的技能目录（组合里 skill-filesystem 行引用）
```

- **宿主半**（`lib/index.js`）：`installSettingsSection` 注册 `kaz-mode:` 命名空间；
  监听自身 `enabled` 变化执行"快照 → 联动启用 / 恢复 → 清空快照"；监听
  `settings/updated`（`agent-presets` 命名空间）执行预设联动（切到 kaz → enabled 置
  true，切走 → 置 false，并维护 `previousPreset`）；读取 `ctx.get("toolGrouping")`
  生成分组报告；注册只读工具 `kaz_mode_status`。
- **客户端半**（`lib/client.js`）：浏览器模块（`window.__ModuleLoader__.load` 格式），
  `ctx.settingsScope.bind()` 绑定 `kaz-mode`、`agent-presets` 与八个插件共 9 个设置
  命名空间；注册 `conversation.session.header.utilities`（头部按钮+面板）与
  `conversation.input.dock`（首轮提示条）两个 slot。
  所有状态与写入都走 settings 通道，无自定义 RPC。

**依赖关系**：kaz-mode 依赖 tool-grouping ≥ 当前工作区版本（该版本对外发布
`toolGrouping` 服务，见 tool-grouping README 的「对外服务」一节）。

---

## 安装步骤

### 0. 前置条件

- 插件1–4 已按各自 README 安装（本工作区已装：`~/.dsh/profiles/web/plugins/` 下有
  `thinking-anchor`、`round-minimal`、`tool-grouping`、`tool-filter`）；
- tool-grouping 需为**发布 `toolGrouping` 服务**的版本（本工作区版本已含；如用旧版，
  kaz-mode 分组报告会降级提示，但联动功能不受影响）。

### 1. 把包放进 profile 的 plugins 目录

```powershell
Copy-Item ".\kaz-mode" "$env:USERPROFILE\.dsh\profiles\web\plugins\kaz-mode" -Recurse -Force
```

### 2. 建 junction 让 Loader 解析（二选一）

**方式 A（npm）**——在 profile 目录执行：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\web"
Remove-Item Env:npm_config_allow_scripts   # 本机 npm 11 兼容坑，见《创建dsh插件指南.md》
npm install --legacy-peer-deps --no-audit --no-fund --save ./plugins/kaz-mode
```

**方式 B（不用 npm：手动 junction）**：

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\kaz-mode" -Target "$env:USERPROFILE\.dsh\profiles\web\plugins\kaz-mode"
```

### 3. 注册组合行（必改 `cordis.patch.yml`）

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，末尾追加：

```yaml
# kaz-mode: 超级模式插件。右上角「Kaz 模式」开关 + 管理面板，联动管理
# thinking-anchor / round-minimal / tool-grouping / tool-filter 五个插件，
# 并在对话首轮于输入框上方显示任务目标提示（仅 UI，不注入模型提示词）。
# 实时配置见 settings.yaml 的 kaz-mode: 段。
- insert:
    - id: kaz-mode
      name: kaz-mode
      config:
        enabled: false
```

想让插件对**所有** profile 生效，把 insert 放到 `~/.dsh/cordis.patch.yml`（机器级层）。

### 4. 注册实时配置段（推荐，可选）

在 `~/.dsh/settings.yaml` 追加（不写则走内置默认值）：

```yaml
kaz-mode:
  enabled: false
  registerStatusTool: true
  showFirstRoundHint: true
  firstRoundHint: 请在第一句话中说明本次对话的总任务目标。
```

> `enabled` 由预设联动自动维护（预设 = kaz 时为 true），手动改它只在下一次
> 切换预设前生效——日常请用预设选择器或头部按钮开关 Kaz 模式。

### 5. 注册 Kaz agent preset（必做，按钮与预设双向同步依赖它）

把工作区的 `kaz-preset/` 目录复制到用户预设根（组合内容 = shipped `cordis`
的完整副本，`preset.yml` 提供显示名与描述，skills 目录一并带入）：

```powershell
Copy-Item ".\kaz-preset" "$env:USERPROFILE\.dsh\.agent-presets\kaz" -Recurse -Force
```

装好后，预设选择器（新会话页 / 设置 → 智能体预设）里会出现「Kaz 模式」，
与标准模式、极简模式等并列可选。

### 6. 生效

- `cordis.patch.yml` 的改动会被补丁监视器热挂载；**代码改动需要重启 dsh**
  （Node ESM 模块缓存）。稳妥起见：装完 → 重启 dsh → 强刷 Web 页面
  （Ctrl+F5）——会话头部（session log 按钮左侧）出现「Kaz 模式：已关闭」按钮。

---

## 配置选项

全部字段在 `settings.yaml` 的 `kaz-mode:` 段，**热重载免重启**；组合行 `config`
为 base 层，用户设置优先。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Kaz 模式总开关（**由预设联动自动维护**：预设 = kaz 时置 true，切走时置 false）。`true` 时执行插件联动、显示首轮提示并启用首轮极简伪装；`false` 时五个插件 enabled 保持现状、仅按快照恢复 round-minimal.showPolicy |
| `postFirstRoundMode` | string | `standard` | 首轮极简伪装之后（第 2 轮起）恢复的基底模式：`standard`（标准）/ `minimal`（极简）/ `creative`（创造，= shipped `cordis` 预设）。persona 分别替换为对应 shipped 预设的 persona 文本。曾有的 `ptc` 选项（= shipped `code` 预设）已于 2026-08-17 删除——它只换 persona 不切 Code Mode 工具呈现，与 standard 效果相同，属误导选项；settings 里残留的 `ptc` 值会自动回退 standard |
| `registerStatusTool` | boolean | `true` | 是否注册只读状态工具 `kaz_mode_status`（用于验证） |
| `showFirstRoundHint` | boolean | `true` | 是否在对话首轮显示输入框上方的提示条 |
| `firstRoundHint` | string | `请在第一句话中说明本次对话的总任务目标。` | 首轮提示条文案（只显示给用户看，不进入模型提示词） |
| `previousPreset` | string | `cordis` | **自动维护**：最近一个非 kaz 预设 id，头部按钮"关闭 Kaz"时切回它（预设选择器切换时同步更新） |
| `managedPlugins` | string[] | 五个插件 id | 联动管理的插件命名空间清单（一般不需要改） |
| `savedPluginStates` | object | `{}` | **内部字段**：开启 Kaz 前五个插件的原始状态快照（自动维护，请勿手改） |
| `roundMinimalPolicySnapshot` | object | `{active:false,...}` | **内部字段**：round-minimal.showPolicy 的联动快照（进入 Kaz 时记录、退出 Kaz 时按此恢复并清空；重启续联不覆盖最早快照），请勿手改 |
| `minimalTools` | string[] | `[pwsh, str_replace_editor]` | Kaz 工具面·极简基底：始终保留的最小工具集 |
| `toolWhitelist` | string[] | `[kaz-memory, tool-fs, workflowEngine, tool_grouping_status, kaz_mode_status]` | Kaz 工具面·白名单：组 id（经 tool-grouping 展开）或字面工具名；想放行额外工具（如 `web_search`、`subagent`、`skill`）直接加名字 |

五个插件各自的配置项（enabled、mode、groups、firstRoundTools、instruction 等）
直接在面板里编辑，或照旧在各自 `settings.yaml` 段修改。

---

## 使用示例

**场景：开启 Kaz 模式开始一个新任务。**

1. 刷新页面，会话头部（session log 按钮左侧）出现「Kaz 模式：已关闭」按钮（灰色圆点）；
2. 在**预设选择器**选「Kaz 模式」→ 按钮变绿「已开启」，五个插件被联动启用
   （未启用的自动开启），`settings.yaml` 的 `kaz-mode.savedPluginStates` 记录下它们原先
   的状态，`agent-presets.default` 写入 `kaz`；
3. 点击头部按钮（▼）展开「详细设置」面板：查看五个插件的状态徽章，按需单独开关、
   点「配置」调整参数（改动自动写回 `settings.yaml`，即时生效）；
4. 新建对话（或直接续用当前会话），输入框上方出现提示条
   「请在第一句话中说明本次对话的总任务目标。」；第一句话直接说任务目标；
   首轮模型只看得见 `pwsh` / `str_replace_editor`（round-minimal 生效），系统提示
   保留 persona（极简原句）+ thinking-anchor + round-minimal 首轮提示（We need 风格：
   本轮不执行任务，仅询问任务细节）+ code-collapse 首轮提醒（尽量一次 run_code 多用工具），
   且不提示搜索记忆；工具分组报告可随时用
   `kaz_mode_status` / `tool_grouping_status` 查看；
5. 第二句话起 round-minimal 开放其它工具，Kaz 工具面生效：模型只见 `minimalTools`
   （默认 pwsh / str_replace_editor）+ `toolWhitelist` 逐个列出的工具名（read/write/edit/
   glob/grep、job_*、web_search、skill、todo_write、goal 三件套、subagent 全家桶、
   workflow/ralph、memory 四工具、tool_grouping_status/kaz_mode_status），白名单外工具
   不可见、调用被拒；提示条消失。想用更多工具就把工具名加进 `kaz-mode.toolWhitelist`
   （不用组 id——分组归属交给 tool-grouping，用户可关闭它）。

**关闭 Kaz 模式：**

在预设选择器选其它预设（如 `cordis`）→ 圆点变灰、按钮显示「已关闭」→ 五个插件
保持当前状态、不做任何改动（只有「进入 Kaz」会强制启用五个插件；用户在 Kaz 模式
下手动关闭的插件保持关闭）→ 首轮提示条不再出现。

**通过预设选择器切换（与按钮等效）：**

在预设选择器里选「Kaz 模式」→ 头部按钮同步变「已开启」、五个插件联动启用；
选其它预设（标准模式 / 极简模式…）→ 按钮变「已关闭」、插件保持现状不被改动。

---

## 如何验证插件已生效

### 1. 组合正确（免启动）

```powershell
dsh --profile web --dump-config
# 或（dsh.ps1 被执行策略拦截时）：
node "C:\Users\Kaczev\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile web --dump-config
```

输出中应能看到 `kaz-mode` 行且 exit 0。

### 2. 包可加载

```powershell
node --input-type=module -e "import('file:///C:/Users/Kaczev/.dsh/profiles/web/plugins/kaz-mode/lib/index.js').then(m=>console.log(m.default.name))"
# 期望输出：kaz-mode

node --check "C:\Users\Kaczev\.dsh\profiles\web\plugins\kaz-mode\lib\client.js"
# 语法检查通过（无输出即成功）
```

### 3. 逻辑探针（本仓库自带）

```powershell
node kaz-mode\probe-kaz-mode.mjs
node kaz-mode\probe-kaz-mode-client.mjs   # 客户端 bundle 冒烟（mock React / slots）
node tool-grouping\probe-tool-grouping.mjs   # 含 toolGrouping 服务断言
```

kaz-mode 探针覆盖：关闭态零写入、开启联动快照与启用、关闭恢复与快照清空、
状态工具报告（分组来自 toolGrouping 服务、基底来自 round-minimal 配置）、
服务缺失降级、状态工具注销、**预设联动（切到 kaz 开启 / 切走恢复 / previousPreset
记录 / 启动即 kaz）**——全部 `PASS` 且输出 `PROBE OK`；客户端冒烟验证
bundle 注册格式、slot 注册（头部工具区 + 输入 dock）、组件渲染与按钮写预设。

### 4. 端到端（重启 dsh 后）

1. 强刷 Web 页面：会话头部（session log 按钮左侧）出现「Kaz 模式：已关闭」按钮，
   且不再遮挡任何其它按钮；
2. 在预设选择器选「Kaz 模式」：按钮变绿、显示「已开启」；日志出现
   `[kaz-mode] 预设已切换为 kaz → 开启 Kaz 模式。` 与
   `[kaz-mode] Kaz 模式已开启：联动启用 N 个插件…`；
   打开 `settings.yaml` 确认 `agent-presets.default: kaz`、五个插件的
   `enabled: true` 与 `kaz-mode.savedPluginStates` 快照；
3. 预设选择器：打开预设选择器能看到「Kaz 模式」并已选中；选「标准模式」→
   按钮立即变「已关闭」、`settings.yaml` 里五个插件恢复原状；
4. 面板：展开管理面板，五个插件显示「启用」徽章；单独关掉某个再打开，观察
   `settings.yaml` 对应段即时变化；面板顶部显示当前预设与关闭时切回的预设；
5. 新建对话：输入框上方出现「请在第一句话中说明本次对话的总任务目标。」；
   说第二句话后提示消失；用工具 `kaz_mode_status` 查看分组报告（分组数据与
   `tool_grouping_status` 一致）；
6. 关闭 Kaz 模式：预设切回 `previousPreset` 记录的预设，五个插件恢复原状
   （`settings.yaml` 的 enabled 写回 / 字段被移除），快照清空。

### 5. 开关验证

- 预设选择器 / 头部按钮切到 Kaz → `settings.yaml` 的 `kaz-mode.enabled` 自动变 `true`
  （热重载）；切走 → 自动变 `false`；
- 重启 dsh 后若默认预设仍是 `kaz`，插件加载时自动重新联动，状态跨重启保持。

---

## 常见问题

| 问题 | 原因 / 处理 |
| --- | --- |
| 重启后看不到按钮 | ① 代码改动需要重启 dsh（ESM 缓存）；② 确认 `cordis.patch.yml` 有 kaz-mode 行且 `--dump-config` 能看到；③ 强刷页面（Ctrl+F5）拉取新的客户端 bundle |
| 按钮不出现 / 被遮挡 | 按钮在**会话头部工具区**（session log 按钮左侧），行内排版不会遮挡。若完全看不到：确认已打开一个会话（空白首页 hero 状态没有头部工具区）；其它同上一行 |
| 面板里的开关 / 输入框不可点 | 页面处于远程内存模式（非 127.0.0.1 访问）时 settings 不可写。请在本机访问页面（按钮本身始终可展开面板） |
| **面板里五个插件显示「未安装」/ kaz-mode 显示「禁用」/ 记忆面板显示「无待确认」** | 部署的 api 网关白名单（`dsh-host-apiproxy` 的 `WEB_SETTINGS_NAMESPACES`）默认不暴露插件自有命名空间。本工作区已本地打补丁：把 `kaz-mode` / `kaz-memory` / `thinking-anchor` / `round-minimal` / `tool-grouping` / `tool-filter` / `code-collapse` / `output-beep` / `task-master-whiteboard` / `round-display` 加入该数组。**升级 dsh 会覆盖此补丁**，需重新加回（数组内有 `LOCAL PATCH (Kaczev Kaz 工作区)` 注释标记） |
| 预设选择器里没有「Kaz 模式」 | 未装 kaz 预设：把 `kaz-preset/` 复制到 `~/.dsh/.agent-presets/kaz/`（见安装步骤 5）后重启 dsh |
| 选完预设但按钮状态没马上变 | 预设选择器写的是 `agent-presets.default`，由宿主预设联动再写 `kaz-mode.enabled`（差一个 settings 往返）。最终状态一致即可 |
| 面板里某插件显示「未安装」 | 该插件行未挂载或未在 settings 注册（settings 命名空间只在插件加载后存在）。检查对应插件的 `cordis.patch.yml` 行 |
| 状态报告说「tool-grouping 未发布 toolGrouping 服务」 | tool-grouping 是旧版本。更新为工作区当前版本（对外发布 `toolGrouping` 服务）后重启 |
| 联动没把某个插件打开 | 该插件行未加载（settings 未注册）时跳过。先安装该插件再重开一次 Kaz 模式 |
| Kaz 关闭后某个插件状态和预期不一致 | 恢复规则：开启 Kaz 前**有用户覆盖** → 写回原值；**无覆盖** → unset 回继承。手动在 `settings.yaml` 改过插件状态后再开 Kaz，就会按改动后的状态恢复 |
| 和 round-minimal / tool-grouping 冲突吗 | 不冲突。kaz-mode 只联动它们的 `enabled`，并消费它们发布的运行时事实：白名单按 tool-grouping 的组 id 展开、首轮极简信号来自 round-minimal 服务/事件；三个插件叠加时各自的条件都满足才隐藏/拒绝 |
| Kaz 模式下某个工具消失了 | Kaz 工具面只放行 `minimalTools + toolWhitelist`，白名单外的工具（如 `web_search`、`subagent`、`skill`、`todo_write`）不可见且调用被拒。需要时把工具名或组 id 加进 `kaz-mode.toolWhitelist`（热重载） |
| 首轮模型不再搜索记忆 | 预期行为：首轮极简（round-minimal）只有 pwsh / str_replace_editor，kaz-mode 收到信号后同时移除 tool:memory 指引；从第二轮起记忆工具与指引恢复 |
| **Kaz 会话里没有上下文注入 / memory 不起作用 / 五个插件像没生效** | 0.2.x 及以前的 kaz 预设直接照抄 `minimal` 组合（persona `complete: true`）或 `cordis` 组合（persona 非 complete 但首轮提示不含伪装）。**当前版本**：kaz 预设 = cordis 完整副本 + persona 改为与 minimal 逐字一致（`complete: false`、`includeRuntimeContext: false`），首轮极简伪装与次轮基底恢复全部由 kaz-mode 在组装层实现。更新 `~/.dsh/.agent-presets/kaz/` 与 kaz-mode / round-minimal / code-collapse 代码后**重启 dsh**，**新建**一个 Kaz 会话生效（系统提示首轮 = persona + thinking-anchor + round-minimal 轮次提示 + code-collapse 首轮提醒，次轮起 persona 恢复为 standard 文本） |
| 首轮提示不出现 | 需同时满足：Kaz 开启、`showFirstRoundHint: true`、round-minimal 启用、当前对话仍在首轮（≤1 轮）。注意：无会话的空白首页（hero）没有输入 dock，先新建/打开会话即可看到 |
| 想临时停用整个插件 | `settings.yaml` 设 `kaz-mode.enabled: false`（注意：下一次切换预设时会被预设联动覆盖）；或删除组合行后重启 |
| **重启后右上角仍没有按钮**、`/plugins/kaz-mode/client.js` 返回 404 | 0.1.0 初版 `package.json` 的 `exports` 缺少 `"./package.json"` 导出，导致 dsh 客户端包扫描（`require.resolve("kaz-mode/package.json")`）失败、包被**静默跳过**（宿主半正常、客户端半缺失）。0.1.1 已修复：确认 `exports` 含 `"./package.json": "./package.json"` 后**重启 dsh** 并强刷页面。自检：`node -e "const{createRequire}=require('module');console.log(createRequire('file:///C:/Users/Kaczev/.dsh/profiles/web/').resolve('kaz-mode/package.json'))"` 应能解析出路径。今后给任何插件加客户端半，`exports` 都要带上 `"./package.json"` |

## 兼容性

- 宿主平面（host）+ 客户端（web 平台 `dsh.client`）双半插件，兼容 `profiles/web`；
- 依赖运行时已安装的 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-settings`、
  `@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`；
- 客户端半为纯 JavaScript 浏览器 bundle（React 18），随 dsh 主题明暗切换；
- 安装方式与工作区其余五个插件完全一致（见《创建dsh插件指南.md》）。
