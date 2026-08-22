# kaz-mode —— 「Kaz 模式」超级模式插件

> **作用**：Kaz 模式的总开关与中枢——预设联动 + 会话头部按钮 + 集中管理面板（Kaz 面板），统一管理全家桶插件的开关与参数，并按会话决定工具面。

Kaz 模式同时具备两个入口，双向同步：

1. **agent preset**：`kaz` 预设已注册进 dsh 的预设体系（在预设选择器里与标准模式、极简模式等并列可选）；
2. **会话头部按钮**：侧边栏底部常驻一个 **「Kaz 模式：已开启 / 已关闭」** 按钮，点击展开 / 收起集中管理面板（Kaz 面板）。

| 插件 | 角色 |
| --- | --- |
| `thinking-anchor` | 思考锚点（**消息注入**）：新对话开始时把完整思考协议作为一条合成用户消息注入，此后每轮开头注入短提醒；不触碰系统提示词 |
| `round-minimal` | 首阶段极简：**首次工具调用前**只暴露 `pwsh` / `read` / `edit`，首次工具调用后恢复全部工具 |
| `plugin-filter`（原 tool-filter） | 工具过滤：按名单移除 / 禁用指定工具 |
| `output-beep` | 输出完成提示音：模型输出完毕时响提示音（可配频率/时长/子代理） |
| `round-display` | 每轮注入显示：记录每轮 Kaz 联动/附属插件给模型发送的信息，「本轮注入」按钮+面板 |
| `deepseek-default-model` | DeepSeek 采样参数：面板调整 temperature / top_p / repetition_penalty，并把 temperature 应用到请求；默认模型与思考强度由 DSH 官方面板管理 |
| `kaz-memory` | 独立记忆组件：六工具（memory_save/update/list/search/detail/forget）+ 对话开始时自动载入已确认的 autoLoad 记忆 |
| `kaz-diag` | 诊断：只注册只读状态工具 `kaz_mode_status`（开启本插件才加入 Kaz 工具面） |

**Kaz 模式的核心语义（2026-08-21，纯方案 A）**：

1. **系统提示词固定**为 `You are a helpful software engineer assistant.`。组装层把
   提示段收敛为 persona 一句（+ 计划模式段，保证 plan mode 仍工作），其余任何提示段
   （thinking-anchor / round-minimal 轮次提示 / kaz-memory 指引 / tool:* 指导段 /
   运行时上下文…）一律过滤。
2. **工具面两阶段**：
   - 首次工具调用前（round-minimal 首阶段信号）：只保留 round-minimal 首轮工具集
     （默认 `pwsh` / `read` / `edit`）；
   - 首次工具调用后：恢复 **Kaz 全部工具** = `toolWhitelist` 白名单（唯一闸门）。
3. **记忆/诊断工具按会话生效**：`kaz-memory` / `kaz-diag` 关闭时，其六工具 /
   `kaz_mode_status` 从该会话的工具面移出、调用被拒。
4. **skill 已整体移除**（2026-08，Kaczev）：`skill` 工具、技能发现行与技能目录已从
   kaz 预设删除，白名单里也没有 `skill`。
5. **配置不写 settings.yaml（纯方案 A）**：被管理插件的生效配置 =
   工厂默认 + `~/.dsh/storages/kaz-defaults.json`（Kaz/非Kaz 模式默认）+
   `<项目>/.dsh/storages/kaz-session-states.json`（会话覆盖），经 `kazMode` 服务在
   使用时刻按 agent 会话读取；**kaz-mode 不再把任何插件状态写进 settings.yaml**。

### Kaz 全部工具列表（手动编辑点）

**`~/.dsh/settings.yaml` → `kaz-mode.toolWhitelist`**（热改生效，无需重启）。
Kaz 面板底部的 `toolWhitelist` 字段也是同一配置。以后要加新工具，就在这里加工具名。

```yaml
kaz-mode:
  toolWhitelist:
    [ pwsh, read, write, edit, glob, grep,
      job_list, job_output, job_kill,
      ask_user_question, todo_write, web_search,
      memory_save, memory_update, memory_list, memory_search, memory_detail, memory_forget,
      kaz_mode_status ]
```

两层生效：组装层（`system-prompt/assemble`）过滤工具；执行层（`tools/pre-execute`）
拒绝工具面外的调用。**host 平面监听器对所有 agent 生效——子代理会话（subagent /
workflow / ralph 派生）同样是 Kaz 工具面。**

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
- **各插件在使用时刻**经 `kazMode.pluginConfig(agent, pluginId)` 读取会话生效配置
  （模式默认 + 会话覆盖），settings.yaml 只作 standalone 兜底；
- Kaz 面板里可单独开/关每个插件（改会话覆盖或模式默认），改动即时生效。

### 4. Kaz 工具面（toolWhitelist 唯一闸门）

- **`toolWhitelist`** = Kaz 模式的「全部工具列表」——纯工具名列表，可在
  settings.yaml 热改 / Kaz 面板编辑；
- `kaz-memory` 关闭 → 六工具自动移出；`kaz-diag` 关闭 → `kaz_mode_status` 移出。

### 5. round-minimal 信号（首阶段极简）

round-minimal 发布 `roundMinimal` 服务并推送 `round-minimal/state` 事件。kaz-mode
据此在**首阶段（首次工具调用前）**把工具面收敛为首轮工具集（默认
`pwsh` / `read` / `edit`）；首次工具调用后恢复 `toolWhitelist`。

### 6. 设置（`~/.dsh/settings.yaml`，热重载）

```yaml
kaz-mode:
  enabled: false                      # 总开关（由预设联动驱动，勿手改）
  toolWhitelist: [ ... ]              # ★ Kaz 全部工具列表（手动编辑点）
  previousPreset: router-standard     # 最近一个非 kaz 预设（自动维护）
  savedPluginStates: {}               # 信息快照（自动维护，勿手改）
```

## 发新版必做（给未来的我和 agent）

Kaz 面板的“本地版本”读的是 `KazPlugins/kaz-mode/version.json`。**发新版本时如果不改这里，面板会一直拿旧版本号和 GitHub 比较，导致错误提示。**

每次发布新版本前，按这个顺序做：

1. 更新 `KazPlugins/kaz-mode/version.json` 里的 `version` 为新 tag 号；
2. 运行版本检查：
   ```powershell
   node KazPlugins/kaz-mode/check-version.mjs
   ```
   如果最新 tag 之后有提交但 `version.json` 没升版本，脚本会报错提醒；
3. 确认无误后再打 tag、推送到 GitHub。

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
2. 首次工具调用前工具面只有 `pwsh` + `read` + `edit`；第一次工具调用后恢复
   `toolWhitelist` 全部工具（kaz-memory 关闭时无记忆工具；kaz-diag 开启时有
   `kaz_mode_status`）；
3. 对话里不出现 skill 工具、技能目录与 skill-catalog 合成消息；
4. `thinking-anchor` 的思考协议以一条合成用户消息出现在对话开头（而非系统提示词）；
5. Kaz 面板的 `toolWhitelist` 字段可改（改完即生效）；
6. 来回切换 Kaz / 非 Kaz 会话、在 Kaz 面板改「专属设置/默认设置」——settings.yaml
   里除 `kaz-mode:` 等保留段外**不新增/改写任何被管理插件的段**，改动只落在
   `kaz-defaults.json` 与 `kaz-session-states.json`。
