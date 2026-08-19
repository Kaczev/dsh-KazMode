# kaz-mode —— 「Kaz 模式」超级模式插件

Kaz 模式同时具备两个入口，双向同步：

1. **agent preset**：`kaz` 预设已注册进 dsh 的预设体系（在预设选择器里与标准模式、
   极简模式等并列可选）；
2. **会话头部按钮**：dsh Web UI 会话头部常驻一个 **「Kaz 模式：已开启 / 已关闭」**
   按钮，一键联动管理本工作区八个插件，并带集中管理面板。

| 插件 | 角色 |
| --- | --- |
| `thinking-anchor` | 思考锚点（**消息注入**）：新对话开始时把完整思考协议作为一条合成用户消息注入，此后每轮开头注入短提醒；不触碰系统提示词 |
| `round-minimal` | 首阶段极简：**首次工具调用前**只暴露 `pwsh` / `str_replace_editor`，首次工具调用后恢复全部工具 |
| `plugin-filter`（原 tool-filter） | 工具过滤：按名单移除 / 禁用指定工具 |
| `output-beep` | 输出完成提示音：模型输出完毕时响提示音（可配频率/时长/子代理） |
| `round-display` | 每轮注入显示：记录每轮 Kaz 联动/附属插件给模型发送的信息，「本轮注入」按钮+面板 |
| `deepseek-default-model` | DeepSeek 默认参数：面板调整默认 provider / model / reasoningEffort / generation_kwargs，同步官方 agent-default-model 并把 temperature 应用到请求 |
| `kaz-memory` | 独立记忆组件：记忆工具（memory_save/list/search/forget）+ 对话开始时自动载入已确认的 autoLoad 记忆 |
| `kaz-diag` | 诊断：只注册只读状态工具 `kaz_mode_status`（开启本插件才加入 Kaz 工具面） |

**Kaz 模式的核心语义（2026-08 重构）**：

1. **系统提示词固定**为 `You are a helpful software engineer assistant.`。组装层把
   提示段收敛为 persona 一句（+ 计划模式段，保证 plan mode 仍工作），其余任何提示段
   （thinking-anchor / round-minimal 轮次提示 / kaz-memory 指引 / tool:* 指导段 /
   运行时上下文…）一律过滤。任何插件都不再向 Kaz 会话注入其它 system prompt 内容。
2. **工具面两阶段**：
   - 首次工具调用前（round-minimal 首阶段信号）：`minimalTools`（默认
     `pwsh`、`str_replace_editor`）∪ round-minimal 首轮工具集；
   - 首次工具调用后：恢复 **Kaz 全部工具** = `minimalTools` + `toolWhitelist` 白名单
     （= 标准模式全部工具除 bash + pwsh + str_replace_editor + kaz-memory 四工具）。
3. **动态调整**：`kaz-memory` 关闭 → 其四个记忆工具自动移出白名单；`kaz-diag` 开启
   → `kaz_mode_status` 自动加入白名单。
4. **skill 已整体移除**（2026-08，Kaczev）：`skill` 工具、技能发现行与技能目录已从
   kaz 预设删除，白名单里也没有 `skill`——Kaz 模式没有任何 skill 能力，自然也没有
   skill-catalog 合成消息（与 router-standard 的表现一致）。

### Kaz 全部工具列表（手动编辑点）

**`~/.dsh/settings.yaml` → `kaz-mode.toolWhitelist`**（热改生效，无需重启）。
Kaz 面板底部的 `toolWhitelist` 字段也是同一配置。以后要加新工具，就在这里加工具名。

```yaml
kaz-mode:
  toolWhitelist:
    [ pwsh, read, write, edit, read_image, glob, grep,
      job_list, job_output, job_kill,
      create_goal, get_goal, update_goal,
      subagent, subagent_fork, list_agents, send_message, interrupt_agent,
      workflow, ralph, ask_user_question, todo_write, web_search,
      str_replace_editor,
      memory_save, memory_list, memory_search, memory_forget ]
  minimalTools: [ pwsh, str_replace_editor ]   # 首阶段与全量阶段始终保留
```

两层生效：组装层（`system-prompt/assemble`）过滤工具；执行层（`tools/pre-execute`）
拒绝白名单外的调用。**host 平面监听器对所有 agent 生效——子代理会话（subagent /
workflow / ralph 派生）同样是 Kaz 工具面。**

---

## 功能说明

### 1. 会话头部「Kaz 模式」按钮（打开详细设置面板）

- 按钮只显示状态 + **点击展开 / 收起「Kaz 模式 · 详细设置」面板**：开启 / 关闭
  Kaz 模式一律用**预设选择器**（选 `kaz` 开、选其它关）；
- 状态清晰可辨：文字（`Kaz 模式：已开启 / 已关闭`）+ 圆点颜色变化（绿色=开启）；
- **预设选择器里切换预设时，按钮状态实时同步**（读同一个 `agent-presets.default` 字段）。

### 2. 预设联动（宿主半自动同步）

- 预设切到 `kaz` → 宿主自动把 `kaz-mode.enabled` 置 `true` → 触发插件联动；
- 预设切走 → 置 `false` → 恢复各插件原始状态；
- 最近一个非 kaz 预设自动记录到 `kaz-mode.previousPreset`，按钮"关闭"时切回它；
- 启动时若默认预设已是 `kaz`，自动开启联动。

### 3. 插件联动

- **开启 Kaz 模式**：先把被管理插件在 `settings.yaml` 里的原始 `enabled` 状态快照到
  `kaz-mode.savedPluginStates`（持久化），再把它们全部自动启用（已启用的不动；
  未加载的插件跳过）。
- **默认关闭清单（`defaultDisabledPlugins`）**：当前为空（全部默认启用）。需要时把
  插件 id 加进数组，进入 Kaz 的瞬间会把这些插件置为 `enabled: false`。
- **关闭 Kaz 模式**：各插件的 `enabled` 保持当前状态、不做改动（只有"进入 Kaz"才
  强制启用；用户在 Kaz 模式下手动关闭的保持关闭）。
- 面板里的单个开关是独立的：Kaz 模式开启期间，你可以单独开/关某个插件，改动即时生效。

### 4. Kaz 工具面（minimalTools + toolWhitelist）

- **极简基底 `minimalTools`**（默认 `pwsh`、`str_replace_editor`）——首阶段与全量
  阶段始终保留；
- **白名单 `toolWhitelist`** = Kaz 模式的「全部工具列表」——纯工具名列表（不用组 id），
  全部可在 settings.yaml 热改。`kaz-memory` 关闭时其四工具自动移出；`kaz-diag` 开启
  时自动加入 `kaz_mode_status`。

### 5. round-minimal 信号（首阶段极简）

round-minimal 发布 `roundMinimal` 服务并推送 `round-minimal/state` 事件。kaz-mode
据此在**首阶段（首次工具调用前）**把工具面收敛为 `minimalTools ∪ round-minimal 首轮
工具集`；首次工具调用后恢复 `minimalTools + 有效白名单`。

### 6. 设置（`~/.dsh/settings.yaml`，热重载）

```yaml
kaz-mode:
  enabled: false                      # 总开关（由预设联动驱动，勿手改）
  minimalTools: [ pwsh, str_replace_editor ]
  toolWhitelist: [ ... ]              # ★ Kaz 全部工具列表（手动编辑点）
  defaultDisabledPlugins: []          # 进入 Kaz 时默认关闭的插件 id
  previousPreset: router-standard     # 按钮"关闭 Kaz"时切回的目标（自动维护）
  savedPluginStates: {}               # 联动快照（自动维护，勿手改）
```

## 依赖契约

kaz-mode 存在时，`round-minimal` / `plugin-filter` / `kaz-memory` 三个前置插件必须
存在（`kaz_mode_status` 工具会报告，由 `kaz-diag` 插件注册）。

## 安装（与其它插件一致）

KazPlugins 目录随 profile 以 `file:` 依赖 + junction 装配；`cordis.patch.yml` 插入
`kaz-mode` 行（config: `enabled: false`）。改完**重启 dsh + 强刷页面**。

## 探针

```powershell
node "$env:USERPROFILE\.dsh\profiles\web\KazPlugins\kaz-mode\probe-kaz-mode.mjs"
```
（探针为旧版行为编写，重构后仅作参考，可能过时。）

## 验收要点

1. 选择 `kaz` 预设后：新建对话的系统提示词只含
   `You are a helpful software engineer assistant.`（+ 计划模式段）；
2. 首次工具调用前工具面只有 `pwsh` + `str_replace_editor`；第一次工具调用后恢复
   `toolWhitelist` 全部工具（kaz-memory 关闭时无记忆工具；kaz-diag 开启时有
   `kaz_mode_status`）；
3. 对话里不出现 skill 工具、技能目录与 skill-catalog 合成消息；
4. `thinking-anchor` 的思考协议以一条合成用户消息出现在对话开头（而非系统提示词）；
5. Kaz 面板的 `toolWhitelist` 字段可改（改完即生效）。
