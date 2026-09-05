# kaz-mode —— 「Kaz 模式」超级模式插件

> **作用**：Kaz 模式的总开关与中枢——预设联动 + 会话头部按钮 + 集中管理面板（Kaz 面板），统一管理全家桶插件的开关与参数，并按项目决定工具面（同一项目的所有对话共享）。

Kaz 模式同时具备两个入口，双向同步：

1. **agent preset**：`kaz` 预设已注册进 dsh 的预设体系（在预设选择器里与标准模式、极简模式等并列可选）；
2. **会话头部按钮**：侧边栏底部常驻一个 **「Kaz 模式：已开启 / 已关闭」** 按钮，点击展开 / 收起集中管理面板（Kaz 面板）。

| 插件 | 角色 |
| --- | --- |
| `thinking-anchor` | 思考锚点（**消息注入**）：新对话开始时把完整思考协议作为一条合成用户消息注入，此后每轮开头注入短提醒；不触碰系统提示词 |
| 首阶段极简（核心能力，36.9 起无独立插件） | **首次工具调用前**由 kaz-mode 直接暴露 `memory_search`（Kaz 恒开 ka-whale-memory），首次工具调用后恢复 Stable Main Surface（固定集） |
| `plugin-filter`（原 tool-filter） | 工具过滤：按名单移除 / 禁用指定工具 |
| `output-beep` | 用户介入 / Kaz 收尾提示音：主模型 `communication`/`done` 收尾完成、`ask_user_question`、`exit_plan_mode` 时响；无 idleBeep |
| `round-display` | 每轮注入显示：记录每轮 Kaz 联动/附属插件给模型发送的信息，「本轮注入」按钮+面板 |
| `deepseek-default-model` | DeepSeek 采样参数：面板调整 temperature / top_p / repetition_penalty，并把 temperature 应用到请求；默认模型与思考强度由 DSH 官方面板管理 |
| `kaz-memory` | 独立记忆组件：六工具（memory_save/update/list/search/detail/forget）+ 对话开始时自动载入已确认的 autoLoad 记忆 |
| `ka-whale-workflow` | 鲸鱼工作流（v0.9）：主/子阶段机 + `whale_report` 常驻 bookkeeping；B5 后无旧 reconstruction/classification/goal-recovery 阶段 |

**Kaz 模式的核心语义（2026-08-21，纯方案 A；2026-08-23 系统提示词移到 kaz 预设）**：

1. **系统提示词由 `kaz` 预设的 `kaz-system-prompt.mjs` 控制**。主会话的
   `deployment:persona` 被整段设为 kaz-shared `KAZ_ROLE_PROMPTS.main`
   （v0.9 §9.1 完整 Persona，含基础首句/末句）；受控子代理的
   `KAZ_ROLE_PROMPTS.subagent.*` 原样保留。组装层把提示段收敛为
   persona 单段；v0.8 Step B1 起不再保留 plan:policy / tool:goal 段，
   其余任何提示段（thinking-anchor / 首阶段 guidance / kaz-memory 指引 /
   tool:* 指导段 / 运行时上下文…）一律过滤。**kaz-mode 插件不再控制系统提示词。**
2. **工具面两阶段（v0.8 Step A/B1 固定集；36.9 起无 round-minimal 插件）**：
   - 首次工具调用前：kaz-mode 核心 Minimal 直接保留首轮工具集
     （Kaz 下 `ka-whale-memory` 恒开 → `memory_search`；≤2）；
   - 首次工具调用后：恢复 **Stable Main Surface**（v0.9 §1.1 固定 20 项，M6 版本边界
     新增只读树检索工具 `whale_expand`；含
     `get_goal/update_goal/whale_report/ka_sub_whale/list_agents/send_message/
     interrupt_agent`，不含旧 `create_goal/subagent`）。
     代码级固定集不受旧 tool-plugin JSON 的 false 开关影响；外部/自创建工具不进主面。
   - 纯 `minimal → Stable Main` 一次变化；原生 Plan 已实际移除，不再有 Plan 例外。
3. **记忆工具按项目生效（仅非 Kaz）**：v0.9 B5 起 `ka-whale-memory` 在 Kaz 恒开，
   旧项目状态把它关掉也不影响 Kaz 固定面；非 Kaz 模式关闭时，其六工具从该项目所有
   会话的工具面移出、调用被拒。
4. **skill 已整体移除**（2026-08，Kaczev）：`skill` 工具、技能发现行与技能目录已从
   kaz 预设删除，白名单里也没有 `skill`。
5. **配置不写 settings.yaml（纯方案 A）**：被管理插件的生效配置 =
   工厂默认 + `~/.dsh/storages/kaz-defaults.json`（Kaz/非Kaz 模式默认）+
   `<项目>/.dsh/storages/kaz-project-states.json`（项目专属覆盖，同一项目所有对话共享），
   经 `kazMode` 服务在使用时刻按 agent 项目读取；**kaz-mode 不再把任何插件状态写进
   settings.yaml**。旧的 `kaz-session-states.json` 已不再读取，可直接删除。

### 工具控制面板（B4 · 只读 + 三类候选）

**v0.9 B4 起，工具控制面板不再提供启用/停用、删除、恢复或“设为默认设置”写入口。**
Kaz 工具面由代码级固定面（`KAZ_STABLE_MAIN_TOOLS` / workflow 面）与 stage 机决定；
旧 four-file JSON（`tool-plugin*.json` / `other-tool-plugin*.json`）继续兼容读取，
只作为只读状态来源，UI 不写启用状态。

- **只读展示**：Stable Main Surface、Workflow Carrier Tools、`tool-jobs` 固定集合，
  以及当前四文件模型生效状态；
- **用户可操作范围**：
  1. 私有插件候选：**只读查看**（`kaz-agent-managed-tools.json` 的 `candidates`
     schema v2；用户不可添加，写入只由 pluginCreator / pluginMaintainer 生命周期完成）；
  2. `tool-jobs`：只读查看官方固定集合 `job_list / job_output / job_kill`；
  3. 外置插件候选：查看 / 添加（沿用用户 `other-*` 四文件作为候选层；
     不直接进主面）。
- 旧写 RPC（`setExternalToolPlugin` 的开关/删除、`resetExternalToolPlugins`、
  `setExternalToolPluginsAsDefault`、`addPrivatePluginCandidate`）保留入口但返回
  `read-only` 拒绝语义。

```jsonc
// 插件启用字典（tool-plugin.json / other-tool-plugin.json）——兼容读
{ "tool-fs": true, "dsh-pixel-art": true }

// 工具开关字典（tool-plugin-catalog.json / other-tool-plugin-catalog.json）——兼容读
{ "tool-fs": { "read": true, "write": true, "edit": true } }
```

两层生效：组装层（`system-prompt/assemble`）过滤工具；执行层（`tools/pre-execute`）
拒绝工具面外的调用。**host 平面监听器对所有 agent 生效——子代理会话（subagent /
workflow / ralph 派生）同样是 Kaz 工具面。**

### kaz_tool_auto_on（已退役）

> v0.8 Step B2 状态：`kaz_tool_auto_on` 已整体退役。
> - UI/RPC/JSON 运行时读写已删除；`kaz-shared/lib/tool-auto-on.js` 已删除；
> - `ka_tool_auto_on_setting.json` 不再被 Kaz 读取或写入。旧文件如需保留只作历史
>   归档（备份区 `.dsh/backups/` 内已有完整改动前副本）；
> - Goal 三件套与 `whale_report` 固定常驻 Stable Main Surface；原生 Plan 已移除。

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

### 4. Kaz 工具面（代码级固定 + 只读面板 + 三类候选）

- **Stable Main Surface 由 `KAZ_STABLE_MAIN_TOOLS` 代码级固定**，不由工具控制面板 JSON
  或用户开关决定；workflow 面由代码常量与 stage 机决定；
- 旧 four-file JSON（`tool-plugin*.json` / `other-tool-plugin*.json`）继续兼容读取，
  只作为面板只读状态来源；
- 面板可操作范围仅剩：
  - 私有插件候选（**只读查看**；用户不可添加，写入只由 pluginCreator/pluginMaintainer 生命周期完成）；
  - `tool-jobs` 固定集合查看；
  - 外置插件候选（查看/添加，仍写用户 `other-*` 候选层）；
- 添加候选**不会直接进入 Stable Main/Sub Surface**，后续经受控委派/任务计划选择；
- 旧写 RPC 返回 `read-only` 拒绝语义；
- `ka-whale-memory`/`ka-whale-workflow` 在 Kaz 恒开，旧项目关闭状态不再从固定面剔除；
  非 Kaz 仍按项目状态过滤。
- v0.8 Step B2：`kaz_tool_auto_on` 已退役，工具自动启用区块/RPC/JSON 读写已删除。

### 5. 首阶段 Minimal（36.9 起由 kaz-mode 核心直接拥有）

kaz-mode 在**首阶段（首次工具调用前）**把工具面收敛为首轮工具集：Kaz 下
`ka-whale-memory` 恒开 → `memory_search`；受控子代理按 v0.9 role Minimal；
首次工具调用后恢复 Stable Main Surface（v0.8 Step A 固定集，不由工具控制面板 JSON 决定）。
每次 assemble 后的真实工具面增删由本插件以 `category=tool-surface` 上报 round-display。

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

kaz-mode 存在时，`plugin-filter` / `ka-whale-memory` 等被管理插件按需存在；
36.9 起 `round-minimal` 不再是前置或独立插件。

## 安装（与其它插件一致）

KazPlugins 目录随 profile 以 `file:` 依赖 + junction 装配；`cordis.patch.yml` 插入
`kaz-mode` 行（config: `enabled: false`）。改完**重启 dsh + 强刷页面**。

## 探针

```powershell
node "$env:USERPROFILE\.dsh\profiles\web\KazPlugins\kaz-mode\probe-kaz-mode.mjs"
node "$env:USERPROFILE\.dsh\profiles\web\KazPlugins\kaz-mode\probe-b4-readonly.mjs"
```
（探针已随 v0.9 B4 同步。）

## 验收要点

1. 选择 `kaz` 预设后：新建对话的系统提示词由 `kaz/kaz-system-prompt.mjs` 收敛；
   真实 system = `deployment:persona` 单段，主会话逐字 `KAZ_ROLE_PROMPTS.main`，
   受控子代理逐字 `KAZ_ROLE_PROMPTS.subagent.<role>`（v0.8 Step B1 后不再含
   plan:policy / tool:goal）；
2. 首次工具调用前工具面：Kaz = `memory_search`（ka-whale-memory 恒开）；
   第一次工具调用后恢复 Stable Main Surface（v0.9 §1.1 固定 20 项，M6 版本边界
   新增只读树检索工具 `whale_expand`，
   不含旧 `create_goal/subagent`；Kaz 恒开，旧记忆关状态不再从固定面剔除）；
   受控子代理（v0.9 B3）按 kaWhaleWorkflow 持久化的 role Minimal/Stable Base +
   assignedTools 显示（四角色 Stable Base 均常驻只读 `whale_expand`：worker 13 /
   memoryMaintainer 11 / pluginMaintainer 9 / pluginCreator 9），旧/未知子代理回落到
   保守 Base 12（含 `whale_expand`）；
3. 对话里不出现 skill 工具、技能目录与 skill-catalog 合成消息；
4. `thinking-anchor` 的思考协议以一条合成用户消息出现在对话开头（而非系统提示词）；
5. Kaz 面板「工具控制面板」只读展示 Stable Main/workflow 面；私有插件候选只读、
   `tool-jobs` 只读、外置插件候选可添加；无启用/停用/删除/恢复/设为默认控件；
6. 旧 four-file JSON 兼容读取仍通过；UI 不写启用状态。工具控制面板之外的插件设置
   （output-beep / round-display / deepseek-default-model 等项目状态）仍可正常调整，
   不新增/改写被管理插件的 settings.yaml 段，改动只落在 `kaz-defaults.json`、
   `kaz-project-states.json` 与工具候选 JSON。
7. v0.9：纯 `minimal → Stable Main` 一次变化；`exit_plan_mode` / 旧
   `create_goal/subagent` 永不出现在 Kaz v0.9 主面；Goal 读工具与 `whale_report`
   常驻，不再因 plan/goal/工作流阶段出现工具面抖动。
