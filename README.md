# Kaz模式说明

本模式的基本思路是维持极简模式的提示词，同时首轮工具被调用之前与极简模式几乎相同
拥有记忆组件，模型在相同话题下越用越好用（因为有些过去得到的经验模型会存下来）

各插件目录下都有README.md，写明了它们的作用

默认不开启（不需要开启）：
kaz-diag // 给模型加入一个可以汇报Kaz模式状态的工具，调试的时候用
thinking-anchor // 使用提示词提醒模型要遵循We need思维，用英语思考（无需开启，因为我发现不开启也是这样）

# dsh-KazMode —— Kaz 模式全家桶

本仓库保存 **Kaz 模式全家桶**：Kaczev 在 dsh（DeepSeek Harness）里使用的全部插件和 `kaz` 预设。  
本文档既是仓库说明，也是**写给 DeepSeek 的安装指引**。

> 安装时最需要注意两件事：
> 1. **插件必须装到 `KazPlugins` 文件夹**（不是 `plugins`）；
> 2. **预设必须装成 `.agent-presets/kaz`**（小写 `kaz`，文件直接放在该目录根部）。

---

## 1. 仓库内容

仓库根目录已经包含全家桶的主要源文件夹（另有两个可选工具/预设目录）：

```
dsh-KazMode/
├── KazPlugins/                     # 插件全家桶（11 个插件）
│   ├── deepseek-default-model/
│   ├── first-round-hints/
│   ├── kaz-agent-preset-display/
│   ├── kaz-diag/
│   ├── kaz-memory/
│   ├── kaz-mode/
│   ├── output-beep/
│   ├── plugin-filter/
│   ├── round-display/
│   ├── round-minimal/
│   └── thinking-anchor/
├── kaz/                            # kaz 预设（不是 KazPlugins/kaz-mode/kaz-preset）
│   ├── preset.yml
│   └── agent.cordis.yml
├── 其它好用的工具/                   # 可选：DSH 实用插件
│   └── dsh-deepseek-balance/
└── 其它好用的预设/                   # 可选：实验性 Router 预设
    ├── router-spec/
    └── router-standard/
```

插件清单与作用：

| 插件目录 | 插件 id / name | 作用 |
| --- | --- | --- |
| `kaz-mode` | `kaz-mode` | Kaz 模式超级模式：预设联动 + 会话头部按钮 + 集中管理面板 |
| `round-minimal` | `round-minimal` | 首阶段极简：首次工具调用前只暴露 `pwsh` / `str_replace_editor` |
| `plugin-filter` | `plugin-filter` | 工具过滤：移除或禁用指定工具 |
| `thinking-anchor` | `thinking-anchor` | 思考锚点：新对话注入完整思考协议，之后每轮短提醒 |
| `first-round-hints` | `first-round-hints` | 首轮注入 pwsh 使用要点等提示 |
| `kaz-agent-preset-display` | `kaz-agent-preset-display` | 修正新对话 hero 上 agent preset 按钮显示；默认常驻开启，不受 Kaz 模式开关影响 |
| `output-beep` | `output-beep` | 模型输出完毕 / 提问时播放提示音 |
| `round-display` | `round-display` | 显示每轮 Kaz 联动/附属插件给模型注入的信息 |
| `deepseek-default-model` | `deepseek-default-model` | DeepSeek 默认模型参数：provider / model / reasoningEffort / generation_kwargs |
| `kaz-memory` | `kaz-memory` | 跨会话明文记忆：`memory_save/list/search/forget` + 自动载入 |
| `kaz-diag` | `kaz-diag` | 诊断工具 `kaz_mode_status`（只读状态报告） |

---

## 2. 安装前提

- 已安装 dsh，并存在 `~/.dsh/profiles/web`（`$env:USERPROFILE\.dsh\profiles\web`）。
- 本说明以 Windows + PowerShell 为例；DeepSeek 在安装时请按实际环境调整。
- 若目标机就是当前机器，源路径是：
  - 插件源：`C:\Users\Kaczev\Documents\GitHub\dsh-KazMode\KazPlugins`
  - 预设源：`C:\Users\Kaczev\Documents\GitHub\dsh-KazMode\kaz`

---

## 3. 写给 DeepSeek 的安装步骤

### 3.1 三条铁律（先读）

1. **插件目录名必须是 `KazPlugins`**。  
   目标位置：`%USERPROFILE%\.dsh\profiles\web\KazPlugins`  
   不要把 Kaz 插件复制进 `%USERPROFILE%\.dsh\profiles\web\plugins`。

2. **预设目录名必须是 `kaz`（小写）**。  
   目标位置：`%USERPROFILE%\.dsh\.agent-presets\kaz`  
   不要把预设装成 `Kaz`，也不要从 `KazPlugins\kaz-mode\kaz-preset` 安装预设。

3. **`agent.cordis.yml` 和 `preset.yml` 必须直接位于 `.agent-presets\kaz\` 根部**。  
   dsh 的预设发现规则不递归扫描，嵌套会装不上。

### 3.2 复制插件和预设

在 PowerShell 中执行：

```powershell
$repo = "C:\Users\Kaczev\Documents\GitHub\dsh-KazMode"

# 1) 插件 -> profiles/web/KazPlugins（目录名严格保持 KazPlugins）
$pluginDst = Join-Path $env:USERPROFILE ".dsh\profiles\web\KazPlugins"
New-Item -ItemType Directory -Force -Path $pluginDst | Out-Null
Copy-Item -Path "$repo\KazPlugins\*" -Destination $pluginDst -Recurse -Force

# 2) 预设 -> .agent-presets/kaz（目录名严格保持小写 kaz）
$presetDst = Join-Path $env:USERPROFILE ".dsh\.agent-presets\kaz"
New-Item -ItemType Directory -Force -Path $presetDst | Out-Null
Copy-Item -Path "$repo\kaz\*" -Destination $presetDst -Recurse -Force
```

> 注意：复制的是 `KazPlugins\*` 和 `kaz\*` 的**内容**，避免把源文件夹套进目标文件夹里形成 `KazPlugins\KazPlugins` 或 `kaz\kaz`。

### 3.3 在 `profiles/web/package.json` 注册插件依赖

打开 `%USERPROFILE%\.dsh\profiles\web\package.json`，在 `dependencies` 中加入：

```json
"deepseek-default-model": "file:KazPlugins/deepseek-default-model",
"first-round-hints": "file:KazPlugins/first-round-hints",
"kaz-agent-preset-display": "file:KazPlugins/kaz-agent-preset-display",
"kaz-diag": "file:KazPlugins/kaz-diag",
"kaz-memory": "file:KazPlugins/kaz-memory",
"kaz-mode": "file:KazPlugins/kaz-mode",
"output-beep": "file:KazPlugins/output-beep",
"plugin-filter": "file:KazPlugins/plugin-filter",
"round-display": "file:KazPlugins/round-display",
"round-minimal": "file:KazPlugins/round-minimal",
"thinking-anchor": "file:KazPlugins/thinking-anchor"
```

完整示例：

```json
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "deepseek-default-model": "file:KazPlugins/deepseek-default-model",
    "first-round-hints": "file:KazPlugins/first-round-hints",
    "kaz-agent-preset-display": "file:KazPlugins/kaz-agent-preset-display",
    "kaz-diag": "file:KazPlugins/kaz-diag",
    "kaz-memory": "file:KazPlugins/kaz-memory",
    "kaz-mode": "file:KazPlugins/kaz-mode",
    "output-beep": "file:KazPlugins/output-beep",
    "plugin-filter": "file:KazPlugins/plugin-filter",
    "round-display": "file:KazPlugins/round-display",
    "round-minimal": "file:KazPlugins/round-minimal",
    "thinking-anchor": "file:KazPlugins/thinking-anchor"
  }
}
```

### 3.4 安装依赖 / 建立 junction

在 `%USERPROFILE%\.dsh\profiles\web` 下执行：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\web"
Remove-Item Env:npm_config_allow_scripts   # 本机 npm 11 兼容坑
npm.cmd install --legacy-peer-deps --no-audit --no-fund
```

安装成功后，`profiles/web/node_modules/` 下会为每个 Kaz 插件生成指向 `KazPlugins/<插件名>` 的 junction。

### 3.5 编辑 `profiles/web/cordis.patch.yml`

在 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` 中加入以下组合行（如果已存在相同行则不要重复添加）：

```yaml
- insert:
    - id: memory
      name: kaz-memory

- insert:
    - id: thinking-anchor
      name: thinking-anchor
      config:
        enabled: true

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

- insert:
    - id: kaz-agent-preset-display
      name: kaz-agent-preset-display
      config:
        enabled: true

- insert:
    - id: round-minimal
      name: round-minimal
      config:
        enabled: true

- insert:
    - id: kaz-mode
      name: kaz-mode
      config:
        enabled: false

- insert:
    - id: output-beep
      name: output-beep
      config:
        enabled: true

- insert:
    - id: round-display
      name: round-display
      config:
        enabled: true

- insert:
    - id: deepseek-default-model
      name: deepseek-default-model
      config:
        enabled: true

- insert:
    - id: kaz-diag
      name: kaz-diag
      config:
        enabled: true

- insert:
    - id: first-round-hints
      name: first-round-hints
      config:
        enabled: true
```

> `kaz-mode` 的组合行默认 `enabled: false` 是正常的：它由“选择 `kaz` 预设”这一动作联动开启。

### 3.6 编辑 `%USERPROFILE%\.dsh\settings.yaml`

按需加入或合并以下 Kaz 相关配置（这些段保存后大多可热重载；`cordis.patch.yml` 的改动仍需重启）：

```yaml
# 可选：把默认预设直接设为 kaz；也可在 UI 的预设选择器里手动选
# agent-presets:
#   default: kaz

agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-flash
  reasoningEffort: high

thinking-anchor:
  enabled: true
  instruction: ""
  turnReminder: ""

plugin-filter:
  enabled: true
  mode: remove
  disabledTools:
    - tool-cordis
    - tool-subagent-report
    - codex
    - claude-code

round-minimal:
  enabled: true
  firstRoundTools:
    - pwsh
    - str_replace_editor
  includeSubagents: false
  showPolicy: false

kaz-mode:
  enabled: true
  toolWhitelist:
    [
      pwsh,
      read,
      write,
      edit,
      read_image,
      glob,
      grep,
      job_list,
      job_output,
      job_kill,
      create_goal,
      get_goal,
      update_goal,
      subagent,
      subagent_fork,
      list_agents,
      send_message,
      interrupt_agent,
      workflow,
      ralph,
      ask_user_question,
      todo_write,
      web_search,
      str_replace_editor,
      memory_save,
      memory_list,
      memory_search,
      memory_forget
    ]
  minimalTools:
    - pwsh
    - str_replace_editor
  defaultDisabledPlugins: []
  previousPreset: router-standard
  # savedPluginStates 由 kaz-mode 自动维护，新装可省略

deepseek-default-model:
  enabled: true
  provider: deepseek-official
  model: deepseek-v4-flash
  reasoningEffort: high
  generation_kwargs:
    temperature: 0.2
    top_p: 0.9
    repetition_penalty: 1.2

kaz-memory:
  guidance: ""
  enabled: true
  guidanceHead: ""

kaz-diag:
  enabled: false

kaz-agent-preset-display:
  enabled: true

first-round-hints:
  enabled: true
  message: ""

output-beep:
  enabled: true
  includeSubagents: false
  frequency: 1000
  duration: 300

round-display:
  enabled: true
```

> `agent-presets.default` 是否改为 `kaz` 取决于你是否希望新会话默认进入 Kaz 模式；也可以保持其它预设，之后在会话的预设选择器里手动选“Kaz 模式”。

### 3.7 重启 dsh 并验证

1. **重启 `dsh web`**（插件代码 / cordis 组合改动必须重启才加载）。
2. **强刷浏览器页面**（Ctrl+F5 或 Cmd+Shift+R），让客户端插件生效。
3. 在预设选择器中选择 **Kaz 模式**（`kaz`）。
4. 验证：
   - `dsh --profile web --dump-config` 能看到 `kaz-mode`、`round-minimal`、`plugin-filter`、`kaz-memory`、`kaz-agent-preset-display`、`deepseek-default-model` 等组合行；
   - 新对话系统提示词固定为 `You are a helpful software engineer assistant.`；
   - 首次工具调用前工具面只有 `pwsh` + `str_replace_editor`；
   - 第一次工具调用后恢复 `toolWhitelist` 里的全部工具；
   - 若开启 `kaz-diag`，工具列表里出现 `kaz_mode_status`；
   - Kaz 面板出现各被管理插件的开关行。

---

## 4. 其它好用的工具/预设（可选）

以下内容不是 Kaz 模式的必需部分，按需使用：

| 路径 | 说明 | 安装提示 |
| --- | --- | --- |
| `其它好用的工具/dsh-deepseek-balance/` | DeepSeek 账户余额悬浮挂件（独立 DSH Web 插件） | 安装方式见该目录内 `README.md` |
| `其它好用的预设/router-spec/` | 实验性 Router Spec 预设 | 复制到 `%USERPROFILE%\.dsh\.agent-presets\router-spec\` |
| `其它好用的预设/router-standard/` | 实验性 Router Standard 预设 | 复制到 `%USERPROFILE%\.dsh\.agent-presets\router-standard\` |

---

## 5. DeepSeek 安装时最容易踩的坑

- **把插件复制到 `plugins` 而不是 `KazPlugins`**：`package.json` 里写的是 `file:KazPlugins/...`，目录不对会找不到包或装成两份。
- **把预设复制成 `KazPlugins/kaz-mode/kaz-preset`**：那是插件内置的预设副本，不是仓库根目录的 `kaz/` 预设源；预设发现不会递归扫描。
- **预设目录名写成 `Kaz` / `KazMode`**：preset id 必须匹配 `^[a-z0-9][a-z0-9-]*$`，所以用 `kaz`。
- **改完 `cordis.patch.yml` 不重启**：设置段（settings.yaml）可热重载，但插件装配和代码改动必须重启 dsh web。
- **`npm install` 报 scripts 相关错误**：先执行 `Remove-Item Env:npm_config_allow_scripts`。
- **用 `Set-Content -Encoding UTF8` 写 YAML/JSON 产生 BOM**：BOM 可能破坏 JSON.parse；建议用支持 UTF-8 无 BOM 的编辑器/工具。
- **遇到 `write/edit` 报 `ReplaceFileW EIO (Win32 1175)`**：这是 Windows 偶发文件系统错误，重试同一次编辑即可，不要换工具或放弃。

---

## 6. 相关文件说明

| 路径 | 说明 |
| --- | --- |
| `KazPlugins/<插件名>/package.json` | 每个插件的 npm 包入口 |
| `KazPlugins/<插件名>/lib/index.js` | 插件宿主逻辑（ESM） |
| `KazPlugins/<插件名>/lib/client.js` | 部分插件的 Web 客户端逻辑 |
| `KazPlugins/<插件名>/README.md` | 部分插件的独立说明 |
| `KazPlugins/kaz-mode/kaz-preset/` | kaz-mode 内置的预设副本（安装预设时不从这里取） |
| `kaz/preset.yml` | `kaz` 预设的显示名称与描述 |
| `kaz/agent.cordis.yml` | `kaz` 预设的完整 Cordis 组合定义 |
| `其它好用的工具/` | 可选独立 DSH 工具/插件 |
| `其它好用的预设/` | 可选实验性 Router 预设 |

---

*本文件由 Kaz 模式全家桶维护；安装时请始终以仓库根目录的 `KazPlugins/` 和 `kaz/` 为源。*
