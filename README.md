# Kaz 模式（dsh-KazMode 全家桶）

> 为 DeepSeek Harness（dsh）设计的一套工作模式与插件合集：**极简提示词 + 两阶段工具面 + 跨会话记忆**，用于提升模型的推理效率与输出质量。

## Kaz 模式是什么

- **跨会话记忆**：模型会把经验存为明文记忆，同一话题下越用越好用。以往每次重开新对话，要么重新向模型说明项目，要么模型每次都需要自己重新探索项目，有了kaz-memory插件，模型可以从记忆中搜索，快速找到方向；
- **提示词极简**：Kaz 会话的系统提示词为极简模式的 `You are a helpful software engineer assistant.`，保障deepseek-v4的性能；
- **工具面两阶段**：首次工具调用前只暴露 `pwsh` / `read` / `edit`，第一次工具调用后恢复白名单里的全部工具；
- **配置按对话隔离**：每个对话、每种模式（Kaz / 非 Kaz）都有独立的插件开关与参数，在 **Kaz 面板**里调整，互不干扰；
- **功能按插件分离**：Kaz模式的功能是按插件分离的。如果仅想要Kaz模式的部分功能，也可以在 **Kaz面板** 里面单独开启；

## 插件说明

完整清单见下文「仓库内容」表格；几个值得知道的：

- **默认关闭、按需开启**：
  - `kaz-diag`：给模型一个 `kaz_mode_status` 状态工具，调试 Kaz 模式时用；
  - `thinking-anchor`：用提示词提醒模型遵循 "We need…" 思维链、用英语思考（多数情况下不开效果也一样）。
  - `round-display`：显示每轮 Kaz 联动/附属插件给模型注入了什么信息。
- **`kaz-agent-preset-display`**：显示补丁。官方新对话预设按钮在「先选模式 A、设置里默认 B、刷新页面」后会错显成 B；本插件让按钮优先显示该对话自己的预设。
- **`output-beep`**：模型输出完毕 / 提问时“滴”一声，提醒你可以继续打字（作者摸鱼专用 🐳）。
- **不喜欢某个插件？** 在 Kaz 面板直接关掉；还能把当前状态“设为 Kaz / 非 Kaz 模式的默认设置”，非常灵活。

---

## 仓库说明与安装指引

本仓库保存 **Kaz 模式全家桶**：Kaczev 在 dsh（DeepSeek Harness）里使用的全部插件和 `kaz` 预设；既是仓库说明，也是写给 DeepSeek 的安装指引。

> 安装时最需要注意两件事：
> 1. **插件必须装到 `KazPlugins` 文件夹**（不是 `plugins`）；
> 2. **预设必须装成 `.agent-presets/kaz`**（小写 `kaz`，文件直接放在该目录根部）。

> 写安装程序老是出错，我决定使用最先进的 ds 安装法，根本无需考虑那么多（推荐在梁文谷的时候安装）

---

## 1. 仓库内容

仓库根目录已经包含全家桶的主要源文件夹（另有两个可选工具/预设目录）：

```
dsh-KazMode/
├── KazPlugins/                     # 插件全家桶（11 个插件 + kaz-shared 依赖包）
│   ├── deepseek-default-model/
│   ├── first-round-hints/
│   ├── kaz-agent-preset-display/
│   ├── kaz-diag/
│   ├── kaz-memory/
│   ├── kaz-mode/
│   ├── kaz-shared/                  # 依赖包（非插件）：Kaz 工具清单单一事实源
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
| `round-minimal` | `round-minimal` | 首阶段极简：首次工具调用前只暴露 `pwsh` / `read` / `edit` |
| `plugin-filter` | `plugin-filter` | 工具过滤：移除或禁用指定工具 |
| `thinking-anchor` | `thinking-anchor` | 思考锚点：新对话注入完整思考协议，之后每轮短提醒 |
| `first-round-hints` | `first-round-hints` | 首轮注入 pwsh 使用要点等提示 |
| `kaz-agent-preset-display` | `kaz-agent-preset-display` | 修正新对话 hero 上 agent preset 按钮显示；默认常驻开启，不受 Kaz 模式开关影响 |
| `output-beep` | `output-beep` | 模型输出完毕 / 提问时播放提示音 |
| `round-display` | `round-display` | 显示每轮 Kaz 联动/附属插件给模型注入的信息 |
| `deepseek-default-model` | `deepseek-default-model` | DeepSeek 采样参数：generation_kwargs（temperature / top_p / repetition_penalty）；默认模型由官方面板管理 |
| `kaz-memory` | `kaz-memory` | 跨会话明文记忆：`memory_save/update/list/search/detail/forget` 六工具 + 自动载入 |
| `kaz-diag` | `kaz-diag` | 诊断工具 `kaz_mode_status`（只读状态报告） |

---

## 2. 安装前提

- 已安装 dsh，并存在 `~/.dsh/profiles/web`（`$env:USERPROFILE\.dsh\profiles\web`）。
- 本说明以 Windows + PowerShell 为例；DeepSeek 在安装时请按实际环境调整。
- 若目标机就是当前机器，源路径是：
  - 插件源：`存仓库的文件夹\dsh-KazMode\KazPlugins`
  - 预设源：`存仓库的文件夹\dsh-KazMode\kaz`

---

## 3. 写给 DeepSeek 的安装步骤

**请仅安装用tag标注了的最新版本，未使用tag标注的是超级不稳定的版本，或者测试版**

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
$repo = "存仓库的文件夹\dsh-KazMode"

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
"kaz-shared": "file:KazPlugins/kaz-shared",
"output-beep": "file:KazPlugins/output-beep",
"plugin-filter": "file:KazPlugins/plugin-filter",
"round-display": "file:KazPlugins/round-display",
"round-minimal": "file:KazPlugins/round-minimal",
"thinking-anchor": "file:KazPlugins/thinking-anchor"
```

> **kaz-shared 是必需依赖**（Kaz 模式工具清单单一事实源，见 `KazPlugins/kaz-shared/`）：kaz-mode / kaz-memory / kaz-diag / round-minimal / plugin-filter 都 import 它，漏装会导致这些插件无法加载。它不是 cordis 插件，只是纯模块包。

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
    "kaz-shared": "file:KazPlugins/kaz-shared",
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

纯方案 A（2026-08-21）：被管理插件（thinking-anchor / round-minimal / plugin-filter /
output-beep / round-display / deepseek-default-model / kaz-memory / kaz-diag /
first-round-hints）的生效配置由 kazMode 服务读取：
- `~/.dsh/storages/kaz-defaults.json`（Kaz / 非Kaz 模式默认）（会自动创建）
- `<项目>/.dsh/storages/kaz-session-states.json`（会话专属覆盖）（在会话的时候自动创建）

settings.yaml **不再承载这些插件的段**，仅有kaz-mode和补丁插件的设置（这两个都有自愈写入）

> 被管理插件在 **Kaz 面板**（专属设置 / 默认设置）里改，改动落到上面两个 json，

### 3.7 重启 dsh 并验证

1. **重启 `dsh web`**（插件代码 / cordis 组合改动必须重启才加载）。
2. **强刷浏览器页面**（Ctrl+F5 或 Cmd+Shift+R），让客户端插件生效。
3. 在预设选择器中选择 **Kaz 模式**（`kaz`）。
4. 验证：
   - `dsh --profile web --dump-config` 能看到 `kaz-mode`、`round-minimal`、`plugin-filter`、`kaz-memory`、`kaz-agent-preset-display`、`deepseek-default-model` 等组合行；
   - 新对话系统的思考内不再出现"Let me"，而有很多的"We need"、"Let's"之类的；
   - 首次工具调用前工具面只有 `pwsh` + `read` + `edit`；
   - 第一次工具调用后恢复 `toolWhitelist` 里的全部工具；
   - 若开启 `kaz-diag`，工具列表里出现 `kaz_mode_status`；
   - Kaz 面板出现各被管理插件的开关行。
---

## 4. 其它好用的工具/预设（可选）（通常无需理会）

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

## 7. 发版提醒（给未来的我和 agent）

Kaz 面板的“本地版本”读的是 `KazPlugins/kaz-mode/package.json` 里的 `version` 字段。

**发新版本时，务必同步修改 `KazPlugins/kaz-mode/package.json` 里的 `version`，否则面板会用旧版本号和 GitHub tag 比较，产生错误的新版本提醒。**

发布前建议运行：

```powershell
node KazPlugins/kaz-mode/check-version.mjs
```

该脚本会在“最新 tag 之后有新提交、但 package.json 的 version 没升版本”时主动报错提醒。

---

*本文件由 Kaz 模式全家桶维护；安装时请始终以仓库根目录的 `KazPlugins/` 和 `kaz/` 为源。*
