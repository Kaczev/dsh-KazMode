# round-minimal

按对话轮次切换 dsh 的工具集与提示策略的宿主平面插件：

- **首轮（第 1 个用户请求）＝ 极简模式**：系统提示自动注入一段"首轮提示"，告知模型
  **"首轮对话仅了解任务详情，工具较少，第二轮对话才有更多工具。"**；同时模型可见、可调用的
  工具只保留白名单（默认 `pwsh` 与 `str_replace_editor`，其余工具一律不可见、不可调用；
  若安装了 `task-master-whiteboard` 插件且其启用，六个白板工具会自动加入首轮白名单，
  首轮即可用——Kaz 模式下同样生效）。
- **第二轮 ＝ 过渡提示**：系统提示注入"第二轮提示"，告知模型 **"第二轮对话，更多插件已加载，
  但是别分心，请专注主要任务。"**——防止模型在工具面突然扩大（从仅 2 个工具恢复到全量）时分心。
- **第三轮及以后 ＝ 全量模式**：提示段消失，所有已配置的工具完整恢复，且对话历史完全连续——
  首轮产生的文件、目录、状态在后续轮次都能被正常访问。

> Windows 说明：首轮极简工具集默认使用 `pwsh`（PowerShell 7+，Windows 自带，无需额外安装）
> 而非 bash，因此本插件开箱即用于 Windows 环境。

---

## 功能说明

| 维度 | 首轮（turn 1） | 第二轮（turn 2） | 第三轮起（turn >= 3） |
| --- | --- | --- | --- |
| 系统提示 | 注入"首轮提示"（We need 风格）：本轮不执行任务，仅询问任务细节或等待用户提供 | 注入"第二轮提示"（We need 风格）：更多工具开放，可开始执行任务 | 提示段输出空串，不进入提示词 |
| 可见工具 | 仅 `firstRoundTools`（默认 `pwsh`、`str_replace_editor`；存在并启用 task-master-whiteboard 时自动追加六个白板工具） | 全部已配置工具 | 全部已配置工具 |
| 工具调用 | 白名单之外的调用被 `tools/pre-execute` 拒绝并给出中文原因 | 无拦截 | 无拦截 |
| 子代理 | 默认不受影响（`includeSubagents: false`） | 不受影响 | 不受影响 |

> 设计说明：两段提示都是对**模型**（dsh）的指令，不是对用户的提醒——用户的第一句话此时已经发出，
> 向用户转达"请在第一句话中说明任务目标"已无意义；因此首轮只引导模型专注了解任务详情。
> 第二轮的过渡提示则防止模型在工具面突然扩大时分心——明确告知插件已加载完毕，但仍要专注主要任务。

### 轮次如何判定（无进程内状态，重启安全）

dsh 的 agent-loop 在每一轮请求的预置阶段（`preStep`，系统提示**组装之前**）先向会话日志落盘
`turn/start` 事件。因此插件在任意一次组装/执行时，直接读取会话日志中最近一个 `turn/start` 的
`data.turn` 即为当前轮次：`1` = 首轮。这个判定：

- 不依赖进程内记忆，插件热重载、dsh 重启后依然正确；
- 天然免疫"续接旧对话"：旧对话的 `turn >= 2`，直接进入全量模式，不会给老用户弹提示；
- 同一轮内的多步工具调用（step 2、3…）轮次不变，首轮极简模式全程保持；
- 子代理默认排除：`subagentDepth > 0` 或会话含 `subagent/descriptor` 事件的代理
  （`subagent` / `subagent_fork` / `workflow` / `ralph` 的子会话）始终走全量模式，
  避免首轮极简模式破坏委托任务。

### 三层实现机制

1. **轮次提示段**：`ctx.systemPrompt.section()` 注册 `round-minimal:policy`（order 200），
   首轮输出"首轮提示"、第二轮输出"第二轮提示"、第三轮起输出空串（空段渲染时丢弃）；
   子代理按配置排除。
2. **组装层过滤**：监听 `system-prompt/assemble`（waterfall），首轮把 `assembly.tools`
   与 `tool:*` 指导段裁剪到白名单——模型在提示词里根本看不到其它工具。
3. **执行层闸门**：监听 `tools/pre-execute`，首轮对白名单之外的调用返回
   `{ kind: "deny", reason }`——纵深防御，拦截任何绕过组装层的调用。

### 对外信号（供 kaz-mode 等消费）

本插件把首轮极简状态发布为 Cordis 服务 **`roundMinimal`**，并在状态判定变化时推送
**`round-minimal/state`** 事件：

| 通道 | 内容 | 说明 |
| --- | --- | --- |
| `roundMinimal` 服务 | `enabled()` / `firstRoundTools()` / `isMinimal(agent)` / `turnOf(agent)` | 同步查询：某代理此刻是否处于首轮极简 |
| `round-minimal/state` 事件 | `{ agent, minimal, turn, firstRoundTools }` | 状态变化时推送一次（按代理去重） |

消费方（如 `kaz-mode`）用该信号在**首轮极简激活时**抑制"请先搜索记忆"之类的指引——
首轮没有 `memory_search` 等记忆工具，提示模型搜索记忆是误导；次轮起工具放行、指引恢复。

---

## 安装步骤

### 0. 目录结构

```
round-minimal/
├── package.json      # type: module；peerDependencies 指向运行时已装的 @deepseek-ai/* 包
├── lib/
│   └── index.js      # 插件本体（宿主平面）
└── README.md
```

### 1. 放入 profile 并接入 node_modules

**方式 A（推荐，npm 一条命令）**——在 profile 目录下执行：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\web"

# 把插件源码放进 profile 的 plugins 目录
Copy-Item ".\round-minimal" -Destination "$env:USERPROFILE\.dsh\profiles\web\plugins\round-minimal" -Recurse -Force

# 坑：dsh 环境会设置 npm_config_allow_scripts，npm 11 会因此拒绝项目内安装——
# 临时移除该环境变量（只影响这一次命令）
Remove-Item Env:npm_config_allow_scripts

# 把包装进 profile 的 node_modules（--legacy-peer-deps：跳过自动安装 peer 依赖）
npm install --legacy-peer-deps --no-audit --no-fund --save ./plugins/round-minimal
```

npm 装完后 `web/node_modules/round-minimal` 会自动成为指向 `web/plugins/round-minimal` 的
junction，后续改源码即时同步（但见"常见问题"：代码改动需要重启 dsh 才生效）。

**方式 B（无 npm）——复制 + 手动 junction：**

```powershell
$dst = Join-Path $env:USERPROFILE ".dsh\profiles\web\plugins\round-minimal"
Copy-Item ".\round-minimal" -Destination $dst -Recurse -Force
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\round-minimal" -Target $dst
```

### 2. 注册组合行（必改 `cordis.patch.yml`）

在 `~/.dsh/profiles/web/cordis.patch.yml` 末尾追加：

```yaml
# round-minimal: 按对话轮次切换工具集与提示策略。首轮极简（仅 pwsh / str_replace_editor
# + 首轮提示），第二轮过渡提示（更多插件已加载，专注主要任务），次轮起恢复全量工具。
# 实时配置见 settings.yaml 的 round-minimal: 段。
- insert:
    - id: round-minimal
      name: round-minimal
      config:
        enabled: true
```

想让插件对**所有** profile 生效，把 insert 放到 `~/.dsh/cordis.patch.yml`（机器级层）而非 profile 文件。

### 3. （可选但推荐）注册实时配置段

在 `~/.dsh/settings.yaml` 追加（保存即热重载，无需重启）：

```yaml
round-minimal:
  enabled: true
  firstRoundTools: [ pwsh, str_replace_editor ]
  roundOneInstruction: We need to treat this as the first round: do not execute the task yet — only ask about the task details or wait for the user to provide them.
  roundTwoInstruction: We need to note that more tools are now available from this round — we can start executing the task.
  includeSubagents: false
  showPolicy: true
```

### 4. 生效

- `cordis.patch.yml` 的改动会被 dsh 的补丁监视器（`watchUserPatches`）**当场热挂载**，无需重启；
- 若之前已加载过旧版本代码，**代码改动需要重启 dsh** 才会生效（Node ESM 模块缓存，见常见问题）；
- `settings.yaml` 的配置改动实时生效（热重载）。

---

## 配置选项

| 键 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关。`false` 时提示、工具过滤、执行闸门全部停用 |
| `firstRoundTools` | string[] | `["pwsh", "str_replace_editor"]` | 首轮可见/可调用的工具白名单。存在且启用 task-master-whiteboard 插件时，自动追加其六个白板工具（无需手工配置） |
| `roundOneInstruction` | string | `We need to treat this as the first round: do not execute the task yet — only ask about the task details or wait for the user to provide them.` + 附「run_code / pwsh quick rules」段（简明英文要点：stdout/stderr 取 `.text`、UTF-8 文件用 read 工具、ConvertTo-Json 单元素数组与 BOM 坑、run_code 字符串用单引号；2026-08-19 起） | 首轮注入系统提示、告知模型的首轮策略文本（We need 风格） |
| `roundTwoInstruction` | string | `We need to note that more tools are now available from this round — we can start executing the task.` | 第二轮注入系统提示的过渡文本（We need 风格，仅第二轮出现一次） |
| `includeSubagents` | boolean | `false` | 是否对子代理（含 workflow / ralph 子会话）也施加首轮极简模式 |
| `showPolicy` | boolean | `true` | 是否输出轮次提示段（round-minimal:policy）。置 `false` 后首轮/第二轮提示都不注入；Kaz 模式联动期间默认由 kaz-mode 置 `true`（首轮/次轮提醒输出）并快照原值，退出 Kaz 时按快照精确恢复（用户原本关着就恢复为关） |

优先级：`settings.yaml` 用户层 > 组合行 `config`（base 层）> schema 默认值。`firstRoundTools`
列出了首轮白名单（默认 `pwsh` + `str_replace_editor`，二者都是真实存在的工具）；若某个
工具因组合未挂载而暂不可见，白名单会按"已注册"过滤、只展示实际可用的部分，不会报错。
"首轮有效工具集" = 配置的 firstRoundTools ∪（存在且启用 task-master-whiteboard 时的六个白板工具），
由 roundMinimal 服务的 firstRoundTools() 对外暴露；kaz-mode 首轮极简的工具面跟随该服务。

---

## 使用示例

**场景：用户开启一个新对话。**

1. 用户输入第一句话（例如直接输入任务，或先打声招呼）；
2. 首轮组装时系统提示注入 `round-minimal:policy` 段（统一消息格式 `[round-minimal First Round Mode] / > / 内容 / <`，
   We need 风格），告知模型：**本轮不执行任务，仅询问任务细节或等待用户提供**；
   此时模型只看得见 `pwsh` 与 `str_replace_editor` 两个工具（侧栏工具列表同样只显示这两个），
   模型专注了解任务详情，不会尝试调用其它工具；
3. 用户说出总任务目标（例如"把项目 A 的测试全部跑通并修复失败用例"）；
4. 从用户的第二句话起（第二轮），全部工具恢复：`read` / `write` / `edit` / `glob` / `grep` /
   后台任务 / `web_search` / `skill` / `todo_write` / `goal` / `ask_user_question` /
   `subagent` 全家桶 / `workflow` / `ralph` 等，且首轮 `pwsh` 里产生的文件、目录、状态照常可访问；
   同时第二轮组装还会注入 `[round-minimal 第二轮提示] / > / <` 格式的"第二轮提示"：
   **更多插件已加载，但是别分心，请专注主要任务**，避免模型因工具突然变多而分心；
   第三轮起不再出现任何轮次提示。

**禁用插件（临时）：**

```yaml
# ~/.dsh/settings.yaml
round-minimal:
  enabled: false
```

保存即热重载：提示段停止输出、工具过滤与执行闸门全部解除。

---

## 如何验证插件生效

### 1. 组合正确（免启动）

```powershell
dsh --profile web --dump-config
```

输出中应能看到 `round-minimal` 行（`id: round-minimal, name: round-minimal, enabled: true`）。
> 若 `dsh.ps1` 被 PowerShell 执行策略拦截，改用 `dsh.cmd`。

### 2. 包可加载

```powershell
node --input-type=module -e "import('file:///C:/Users/Kaczev/.dsh/profiles/web/plugins/round-minimal/lib/index.js').then(m => console.log(m.default.name))"
```

应输出 `round-minimal`。

### 3. 逻辑探针（本仓库自带）

```powershell
node probe-round-minimal.mjs
```

全部断言 `PASS` / 最终输出 `PROBE OK`，覆盖：首轮提示、第二轮过渡提示、第三轮为空、
子代理排除、组装层过滤、执行层拒绝、`enabled=false` 完全停用、`roundMinimal` 服务与
`round-minimal/state` 信号。

### 4. 端到端（真实新对话）

1. 确保插件已启用（见安装步骤）；
2. 在 dsh 中**新建一个对话**（新对话 = 新会话 = turn 1）；
3. 发送任意第一条消息，观察：
   - 首轮组装注入了 `round-minimal:policy` 提示段（模型按"首轮仅了解任务详情、工具较少"行事）；
   - 本轮模型可见/可调用的工具只有 `pwsh` 与 `str_replace_editor`；
   - 尝试让模型调用其它工具（如 `read`），应被拒绝并返回中文原因
     （提示：首轮极简模式仅允许 pwsh、str_replace_editor）。
4. 回复第二条消息，确认：
   - 第二轮组装注入了"第二轮提示"段（更多插件已加载，别分心，专注主要任务）；
   - 工具列表恢复全部工具，且可以正常访问首轮产生的内容；
   - 第三条消息起，不再出现任何轮次提示。

### 5. 开关验证

把 `settings.yaml` 的 `round-minimal.enabled` 改为 `false` 保存 → 新建对话：不再出现首轮提示、
工具不再受限；改回 `true` → 恢复。

---

## 常见问题

| 问题 | 原因 / 处理 |
| --- | --- |
| 改 `settings.yaml` 后配置没变 | 老版本代码存在 `setSource` 取值缺陷（把 thunk 直接传给归一化函数，配置回退默认值）。已修复：`source = () => normalizeConfig(current())`。请重启 dsh 让修复生效 |
| 改插件代码后运行中的进程不生效 | Node ESM 模块按 URL 缓存，Loader 重挂载同一包名命中缓存。**代码改动必须重启 dsh**；数据类改动（roundOneInstruction / roundTwoInstruction 文本等）放 `settings.yaml` 走热重载，免重启 |
| 首轮只有一个工具 `pwsh` | `str_replace_editor` 未在当前组合挂载（工具本身存在，见 tool-grouping 组配置）。白名单按"已注册工具"过滤，缺的工具自动跳过；想启用请挂载 `tool-str-replace-editor` 组合行 |
| 与 tool-filter 冲突？ | 不冲突。tool-filter 按"名单"过滤，round-minimal 按"轮次"过滤；两者叠加时各自的条件都满足才会隐藏/拒绝 |
| 子代理任务受影响？ | 默认不会。`includeSubagents: false` 时子代理始终全量模式 |
| 想临时关闭 | `settings.yaml` 设 `enabled: false` 热重载即可，无需删组合行 |

## 兼容性

- 宿主平面（host）插件，兼容 `profiles/web` 的 `cordis.patch.yml` 配置结构；
- 依赖运行时已安装的 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-system-prompt`、
  `@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-settings`、`@deepseek-ai/schemastery`；
- 纯 JavaScript（ESM），无需编译。
