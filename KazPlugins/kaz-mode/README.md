# kaz-mode —— 「Kaz 模式」超级模式插件

> **作用**：Kaz 模式的总开关与中枢——预设联动 + 会话头部按钮 + 集中管理面板（Kaz 面板），统一管理全家桶插件的开关与参数，并按项目决定工具面（同一项目的所有对话共享）。

Kaz 模式同时具备两个入口，双向同步：

1. **agent preset**：`kaz` 预设已注册进 dsh 的预设体系（在预设选择器里与标准模式、极简模式等并列可选）；
2. **会话头部按钮**：侧边栏底部常驻一个 **「Kaz 模式：已开启 / 已关闭」** 按钮，点击展开 / 收起集中管理面板（Kaz 面板）。

| 插件 | 角色 |
| --- | --- |
| `thinking-anchor` | 思考锚点（**消息注入**）：新对话开始时把完整思考协议作为一条合成用户消息注入，此后每轮开头注入短提醒；不触碰系统提示词 |
| `round-minimal` | 首阶段极简：**首次工具调用前**按 kaz-memory 自动暴露（开=`memory_search`；关=`pwsh`/`read`/`edit`），首次工具调用后恢复全部工具 |
| `plugin-filter`（原 tool-filter） | 工具过滤：按名单移除 / 禁用指定工具 |
| `output-beep` | 输出完成提示音：模型输出完毕时响提示音（可配频率/时长/子代理） |
| `round-display` | 每轮注入显示：记录每轮 Kaz 联动/附属插件给模型发送的信息，「本轮注入」按钮+面板 |
| `deepseek-default-model` | DeepSeek 采样参数：面板调整 temperature / top_p / repetition_penalty，并把 temperature 应用到请求；默认模型与思考强度由 DSH 官方面板管理 |
| `kaz-memory` | 独立记忆组件：六工具（memory_save/update/list/search/detail/forget）+ 对话开始时自动载入已确认的 autoLoad 记忆 |
| `ka-whale-workflow` | 鲸鱼工作流：任务重构 → 任务分类 → 放行；重构工具清单在 ka-whale-workflow 配置面板的代码框中修改（与其它输入框同底色），`whale_report` 由「工具自动启用」临时放行，分类时由 `whale_report({mode})` 统一启动 plan/goal |
| `create-plan` | 挂在 Kaz 预设 `planning` isolate 组：`create_plan` 工具（支持 `active` 进入/退出），作为 `whale_report` 启动/退出 plan 模式的 realm 桥，也可手动直接使用 |

**Kaz 模式的核心语义（2026-08-21，纯方案 A；2026-08-23 系统提示词移到 kaz 预设）**：

1. **系统提示词由 `kaz` 预设的 `kaz-system-prompt.mjs` 控制**。默认是
   `You are a helpful software engineer assistant.`；当 `kaz-memory` 启用时自动切换为
   记忆优先提示词。组装层把提示段收敛为 persona 一句（+ 计划模式段，保证 plan mode
   仍工作），其余任何提示段（thinking-anchor / round-minimal 轮次提示 / kaz-memory
   指引 / tool:* 指导段 / 运行时上下文…）一律过滤。**kaz-mode 插件不再控制系统提示词。**
2. **工具面两阶段**：
   - 首次工具调用前（round-minimal 首阶段信号）：只保留 round-minimal 首轮工具集
     （为空时自动：kaz-memory 开 → `memory_search`；关 → `pwsh` + `read` + `edit`）；
   - 首次工具调用后：恢复 **Kaz 全部工具** = 工具控制面板 JSON（官方/外置统一：
     `factory → 用户默认 → 项目设置`；真正的新插件/新工具默认开启，
     已知但默认关闭的插件/工具保持关闭）。
3. **记忆工具按项目生效**：`kaz-memory` 关闭时，其六工具从该项目所有会话的工具面
   移出、调用被拒。
4. **skill 已整体移除**（2026-08，Kaczev）：`skill` 工具、技能发现行与技能目录已从
   kaz 预设删除，白名单里也没有 `skill`。
5. **配置不写 settings.yaml（纯方案 A）**：被管理插件的生效配置 =
   工厂默认 + `~/.dsh/storages/kaz-defaults.json`（Kaz/非Kaz 模式默认）+
   `<项目>/.dsh/storages/kaz-project-states.json`（项目专属覆盖，同一项目所有对话共享），
   经 `kazMode` 服务在使用时刻按 agent 项目读取；**kaz-mode 不再把任何插件状态写进
   settings.yaml**。旧的 `kaz-session-states.json` 已不再读取，可直接删除。

### 工具控制面板（官方 / 外置统一管理）

**不再使用 settings.yaml 的 `kaz-mode.toolWhitelist`。** 官方工具与外置插件统一走同一套四文件模型：

- **原设置（factory）**：`kaz-shared/lib/tool-plugin-catalog.js`
  （`TOOL_PLUGIN_CATALOG` = 工具目录，`TOOL_PLUGINS` = 插件能力开关）
  + 用户 `~/.dsh/storages/other-tool-plugin.json` / `other-tool-plugin-catalog.json`
  （用户手动添加，共享到所有项目）；
- **用户默认**：`~/.dsh/storages/tool-plugin.json` + `tool-plugin-catalog.json`
  + `other-tool-plugin.json` + `other-tool-plugin-catalog.json`；
- **项目专属**：`<项目>/.dsh/storages/` 下四个同名文件，覆盖用户默认。
  - 官方/Kaz 插件/工具的开关 → 项目 `tool-plugin.json` / `tool-plugin-catalog.json`
  - 外置插件/工具的开关 → 项目 `other-tool-plugin.json` / `other-tool-plugin-catalog.json`

Kaz 面板的「工具控制面板」区块是唯一白名单管理器：插件能力开关（大开关）、工具开关
（小开关）、手动添加插件/工具、删除用户添加的外置插件/工具。**手动添加插件/工具写入
用户目录的 `other-*` 文件**（共享到所有项目）；**开关调整写入项目目录**（官方/Kaz 写
`tool-plugin` 两个文件，外置写 `other-*` 两个文件，均为专属、不跨项目）；「设为默认设置」
用项目四个文件替换用户四个对应文件；「恢复原设置」把用户默认两个文件替换为代码出厂
数据，并把用户 `other-*` 全部置为 true。不做自动检测、不写“未知插件”、没有忽略/隐藏。“已知但默认关闭”的插件/工具保持关闭。

```jsonc
// 插件启用字典（tool-plugin.json / other-tool-plugin.json）
{ "tool-fs": true, "dsh-pixel-art": true }

// 工具开关字典（tool-plugin-catalog.json / other-tool-plugin-catalog.json）
{ "tool-fs": { "read": true, "write": true, "edit": true } }
```

两层生效：组装层（`system-prompt/assemble`）过滤工具；执行层（`tools/pre-execute`）
拒绝工具面外的调用。**host 平面监听器对所有 agent 生效——子代理会话（subagent /
workflow / ralph 派生）同样是 Kaz 工具面。**

### Kaz 模式工具自动启用

kaz-mode 配置区内的临时工具放行区块，位于「工具控制面板」下方、与之同级，
常驻展开（不做收起），用于解决“进入 plan / goal 模式时，对应控制工具
（`exit_plan_mode` / `get_goal`、`update_goal`）默认不在工具面里”的问题。

- **三层设置（与工具控制面板同款体系，但一层只用一个 JSON 文件，不做插件封装）**：
  - 原设置：`kaz-shared/lib/tool-auto-on.js`（`TOOL_AUTO_ON_CONFIG`，只读）
  - 默认设置：`~/.dsh/storages/ka_tool_auto_on_setting.json`
  - 专属设置：`<项目>/.dsh/storages/ka_tool_auto_on_setting.json`
  - 形状：`{ "plan": { "enabled": true, "tools": ["exit_plan_mode"] }, "goal": { "enabled": true, "tools": ["get_goal", "update_goal"] }, "whale": { "enabled": true, "tools": ["whale_report"] } }`
  - 生效值 = 专属覆盖默认、默认覆盖原设置（enabled / tools 逐项继承）。
- **plan 模式**：当前会话激活 plan 模式时，自动临时放行生效清单里的 plan 工具；
  plan 模式结束自动移除。
- **goal 模式**：当前会话存在 active/paused 目标时，自动临时放行生效清单里的 goal 工具；
  goal 模式结束自动移除。
- **鲸鱼工作流**：任务重构/分类时临时放行 `whale_report`；任务分类的模式启动由
  `whale_report({mode})` 统一完成，不再单独放行 `create_goal` / `create_plan`。
- 三个功能在面板里都有独立开关，并可编辑各自临时放行工具清单；面板中模式/阶段激活且
  开关打开时显示紫色「启用中」，模式/阶段结束自动恢复灰色。
- **编辑即写项目专属 JSON**（同一项目所有对话共享）；「设为默认设置」把当前项目
  生效设置复制到用户默认 JSON；「恢复原设置 / 恢复默认设置」分别重置用户 / 项目层。
- **模式限定**：`plan-mode` / `goal` 插件即使被工具控制面板 JSON 启用，也不进基础
  工具面，只由自动启用按会话模式临时放行。
- 参数修改点：`kaz-shared/lib/tool-auto-on.js`（原设置）。

---

## 功能说明

### 1. 会话头部「Kaz 模式」按钮（打开详细设置面板）

- 按钮只显示状态 + **点击展开 / 收起「Kaz 模式 · 详细设置」面板**：开启 / 关闭
  Kaz 模式一律用**预设选择器**（选 `kaz` 开、选其它关）；
- 状态清晰可辨：文字（`Kaz 模式：已开启 / 已关闭`）+ 圆点颜色变化（绿色=开启）；
- **预设选择器里切换预设时，按钮状态实时同步**。

### 2. 预设联动

- 预设切到 `kaz` → 会话联动把 `kaz-mode.enabled` 置 `true`；切走置 `false`；
- 会话预设判定**事件优先**（与官方 `resolveSessionPreset` 同语义：读会话事件日志里
  最后一次 `agent-preset/selected`，回退 header）——新对话切换预设即时生效；
- 最近一个非 kaz 预设自动记录到 `kaz-mode.previousPreset`。

### 3. 插件联动（纯方案 A）

- **进入 Kaz**：只把被管理插件在 settings.yaml 里的原始 `enabled` 状态快照到
  `kaz-mode.savedPluginStates`（**仅供面板/诊断展示**，不再驱动任何恢复）；
- **各插件在使用时刻**经 `kazMode.pluginConfig(agent, pluginId)` 读取项目生效配置
  （模式默认 + 项目覆盖），settings.yaml 只作 standalone 兜底；
- Kaz 面板里可单独开/关每个插件（改项目覆盖或模式默认），改动即时生效。

### 4. Kaz 工具面（工具控制面板 JSON 唯一闸门）

- **工具控制面板 JSON** = Kaz 模式的「全部工具来源」——官方/外置统一，按插件分组；
  - 原设置：`kaz-shared/lib/tool-plugin-catalog.js`（`TOOL_PLUGIN_CATALOG` + `TOOL_PLUGINS`）；
  - 用户默认：`~/.dsh/storages/tool-plugin.json` + `tool-plugin-catalog.json`
    + `other-tool-plugin.json` + `other-tool-plugin-catalog.json`；
  - 项目专属：`<项目>/.dsh/storages/` 下四个文件（官方/Kaz 写 `tool-plugin` 两个，外置写 `other-*` 两个）；
  - 官方/Kaz 分类修改点：`kaz-shared/lib/tool-plugin-catalog.js`；
  - 不做自动检测；新插件/新工具只能手动添加，写入用户 `other-*` 文件（共享所有项目）；
    开关调整写项目对应文件，可经「设为默认设置」把项目四个文件复制为用户默认。
- `kaz-memory` 关闭 → 六工具自动移出。
- 「Kaz 模式工具自动启用」属于“临时放行叠加层”：不写工具控制面板四文件 JSON，
  只写自己的单 JSON（用户默认 / 项目专属）；当前会话 plan/goal 模式激活时按三层
  生效清单临时放行对应工具，模式结束自动移除。

### 5. round-minimal 信号（首阶段极简）

round-minimal 发布 `roundMinimal` 服务并推送 `round-minimal/state` 事件。kaz-mode
据此在**首阶段（首次工具调用前）**把工具面收敛为首轮工具集（为空时自动：
kaz-memory 开 → `memory_search`；关 → `pwsh` + `read` + `edit`）；首次工具调用后
恢复工具控制面板 JSON 定义的全部工具。Kaz 模式下 round-minimal 的 `guidanceHeadEnabled` 默认开，
会在第一轮开始时注入一条「先使用首轮工具，之后才能用其它工具」的精简提示。

### 6. 设置（`~/.dsh/settings.yaml`，热重载）

```yaml
kaz-mode:
  enabled: false                      # 总开关（由预设联动驱动，勿手改）
  previousPreset: router-standard     # 最近一个非 kaz 预设（自动维护）
  savedPluginStates: {}               # 信息快照（自动维护，勿手改）
```
> 工具面不再由 `kaz-mode.toolWhitelist` 控制；官方/外置工具请用 Kaz 面板「工具控制面板」或上面的四文件模型。

## 发新版必做（给未来的我和 agent）

Kaz 面板的“本地版本”读的是 `KazPlugins/kaz-mode/package.json` 里的 `version` 字段。**发新版本时如果不改这里，面板会一直拿旧版本号和 GitHub 比较，导致错误提示。**

每次发布新版本前，按这个顺序做：

1. 更新 `KazPlugins/kaz-mode/package.json` 里的 `version` 为新 tag 号；
2. 运行版本检查：
   ```powershell
   node KazPlugins/kaz-mode/check-version.mjs
   ```
   如果最新 tag 之后有提交但 `package.json` 的 `version` 没升版本，脚本会报错提醒；
3. 确认无误后再打 tag、推送到 GitHub。

## 依赖契约

kaz-mode 存在时，`round-minimal` / `plugin-filter` / `kaz-memory` 三个前置插件必须
存在。

## 安装（与其它插件一致）

KazPlugins 目录随 profile 以 `file:` 依赖 + junction 装配；`cordis.patch.yml` 插入
`kaz-mode` 行（config: `enabled: false`）。改完**重启 dsh + 强刷页面**。

## 探针

```powershell
node "$env:USERPROFILE\.dsh\profiles\web\KazPlugins\kaz-mode\probe-kaz-mode.mjs"
```
（探针已随 2026-08-25 重构同步。）

## 验收要点

1. 选择 `kaz` 预设后：新建对话的系统提示词由 `kaz/kaz-system-prompt.mjs` 收敛；
   默认是 `You are a helpful software engineer assistant.`，`kaz-memory` 启用时是
   记忆优先提示词（+ 计划模式段）；
2. 首次工具调用前工具面：kaz-memory 开 = `memory_search`；关 = `pwsh` + `read` + `edit`；
   第一次工具调用后恢复工具控制面板 JSON 定义的全部工具（kaz-memory 关闭时无记忆工具）；
3. 对话里不出现 skill 工具、技能目录与 skill-catalog 合成消息；
4. `thinking-anchor` 的思考协议以一条合成用户消息出现在对话开头（而非系统提示词）；
5. Kaz 面板「工具控制面板」区块可管理官方/外置插件（开关、手动添加、删除外置），改完即生效；
6. 来回切换 Kaz / 非 Kaz 会话、在 Kaz 面板改「项目专属设置/默认设置」——settings.yaml
   里除 `kaz-mode:` 等保留段外**不新增/改写任何被管理插件的段**，改动只落在
   `kaz-defaults.json`、`kaz-project-states.json` 与工具控制面板 JSON。
7. 进入 plan / goal 模式、鲸鱼工作流阶段命中时，kaz-mode 配置区「Kaz 模式工具自动启用」
   显示紫色「启用中」，对应工具临时放行；模式/阶段结束自动移除。面板编辑只写
   `ka_tool_auto_on_setting.json`（用户默认 / 项目专属），不写工具控制面板 JSON 与 settings.yaml。
