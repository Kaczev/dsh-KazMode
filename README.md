# Kaz 模式（dsh-KazMode）

> 为 DeepSeek Harness（dsh）设计的一套 **agent preset（预设）**：**极简 persona + 固定 Stable 工具面 + 跨会话记忆 + 受控子代理委派**，用于提升模型的推理效率与输出质量。
>
> **7.5.0 起 Kaz 从「插件全家桶」改为 DSH agent preset（预设形态）**：无面板、无插件开关、无客户端 UI，首轮即完整 Stable 工具面。预设代码在仓库 `test-kaz/`，安装/更新由仓库根 `install-kaz-preset.ps1` 完成，**只支持 dsh `0.1.5-rc.2`**（主环境 `.dsh` 走全局 `0.1.5-rc.2`，测试环境 `.dsh-test` 用它自己的本地副本 `0.1.5-rc.2`；救援环境 `.dsh-clean` 仍固定 `0.1.1-rc.2`，按设计过不了闸门）。
>
> 旧的「插件形态」（≤ 7.4.x，仅适用于 dsh `0.1.1-rc.2`）自 7.6.0 起**不再随仓库发布**：`KazPlugins/` 已从仓库移除，需要时取 7.5.1 及更早的 git 历史，见 §五。

## 一、核心特性（预设形态）

- **跨会话记忆**：`ka-whale-memory` 提供 `memory_save` / `memory_update` / `memory_list` / `memory_search` / `memory_detail` / `memory_forget` 六工具；模型把解决过的经验存成明文记忆，同类问题越用越快。**autoLoad 自动注入已移除**，记忆由模型主动检索。
- **agent 自优化·记忆**：记忆会被总结成类似 skill 的经验；模型自己管理记忆（清理无用、修订过时、补证据）。
- **受控子代理委派**：`ka-whale-workflow` 提供主流程阶段机与 `ka_sub_whale` 受控委派（worker / memoryMaintainer），不是无约束的多 agent / 原生 Plan 模式。
- **persona 按角色分句**：系统提示词的「用哪句话」收口在 `test-kaz/kaz-system-prompt.mjs`，正文取 kaz-shared 的 `KAZ_ROLE_PROMPTS`；主会话首句为 `We are the main agent of the ka-whale-workflow.`，并要求 "ALWAYS REASON AS 'WE'"。
- **首轮即完整工具面**：不再有「首轮极简 → Stable」两阶段；稳定主工具面是 kaz-shared 的 `KAZ_V09_MAIN_TOOLS`（21 项，见 §三）。
- **Kaz 压缩策略**：`kaz-context-policy` 提供 `context_search` / `context_read` / `context_compress` 与压缩 provider，在预设的 `compaction` 组按名挂载。
- **无 UI**：预设不挂任何客户端插件——**没有** Kaz 面板、没有开关联动、没有提示音、没有轮次显示、没有自更新入口。
- **无模型采样参数覆盖**：`temperature` 等采样参数使用官方默认。
- **开关就是「选不选预设」**：Kaz 与其它的区别就是新对话里选 **Kaz 模式**；不再有面板里逐插件开关。

- **注意：Kaz 没有原生 Plan 模式，`/plan` 与 `create_plan` 不适用；Goal mode / `tool-goal` 也已从 Kaz 移除（非 Kaz 预设仍可保留官方 Goal）。**
- **推荐思考强度在 high 及以上**，low 容易使用 let me 思维链。

> 有小概率出现 Let me 开始思考，但是无需担心，很快会变回 Let's、We 的表述。

---

## 二、快速开始

### 2.1 版本矩阵（先确认自己在哪一形态）

| 形态 | dsh 版本 | 安装 / 更新方式 | 源 |
| --- | --- | --- | --- |
| **预设形态（当前，7.5.0+）** | **`0.1.5-rc.2`（唯一受支持版本）** | 运行仓库根 `install-kaz-preset.ps1` | 仓库 `test-kaz/` |
| 旧插件形态（legacy，≤ 7.4.x） | `0.1.1-rc.2` | 手动复制 + `npm install` + `cordis.patch.yml`（见 §五） | git 历史（≤ 7.5.1）的 `KazPlugins/` |

- 三台 home、三种角色（现在是**单版本 rc.2 世界**）：**主环境 `.dsh` 的运行时是全局 dsh `0.1.5-rc.2`**（`%APPDATA%\npm`，由 `dsh启动.bat` 按 `EXPECTED_CLI=0.1.5-rc.2` 门禁；该 home 内已没有本地 CLI 副本）；**测试环境 `.dsh-test` 用 home 本地副本 `0.1.5-rc.2`**（`tools\dsh-cli`，由测试启动器按 `EXPECTED_CLI=0.1.5-rc.2` 门禁）；**救援环境 `.dsh-clean` 固定 `0.1.1-rc.2`**（保留旧运行时当最后防线，按设计 `FAIL`）。
- 版本闸门按**运行时包** `@deepseek-ai/dsh/package.json` 的 `version` 判定，**只放行 `0.1.5-rc.2`**；不匹配时安装程序输出 `VERSION GATE: FAIL` 并以退出码 1 结束。把运行时回退到 `0.1.5-rc.1` 后必须显式加 `-SkipVersionCheck` 才能装预设（见 §8.2）；正常安装 / 更新**不要**用它。
- **闸门取版本的顺序**是 `<home>\tools\dsh-cli` → `<home>\profiles\<profile>\node_modules\@deepseek-ai\dsh` → 全局 `%APPDATA%\npm`，**取到第一个存在者即停**。因此：`.dsh` 前两个候选都不存在，命中**全局 `0.1.5-rc.2`**（`-AllHomes -DryRun` 打印的就是全局那条路径）；`.dsh-test` 命中自己的本地副本 `0.1.5-rc.2`；`.dsh-clean` 命中自己保留的 `0.1.1-rc.2`，所以仍 `FAIL`——这正是**候选顺序不要动**的原因。注意闸门只代表「第一个存在的运行时包」，不等于目标 home 真正在用的版本：**看打印路径判断闸门读的是哪一份**。
- 两形态互斥：预设形态不安装 `KazPlugins/`，旧形态不安装预设。

### 2.2 安装 / 更新（让 DeepSeek 读专用指引，不要让它读本 README）

> **给 DeepSeek 用（ds 安装法）**：
> - 全新安装 → `ds安装指引.md`（提示词见 `ds安装法的提示词.txt`）
> - 已有安装的更新 → `ds更新指引.md`（提示词见 `ds更新法的提示词.txt`）
>
> 两份指引是决策完备的：每步只有一种做法，包含完整命令与就地出错处理。

> 提示词里的「不要创建任何 `.ps1` / `.bat` 脚本文件」指的是**不要新写脚本**；运行仓库自带的 `install-kaz-preset.ps1` 是允许且必需的。

安装程序参数一览（完整用法见 `ds安装指引.md` 第 2 步）：

| 参数 | 作用 |
| --- | --- |
| （不带参数） | 装到默认 `%USERPROFILE%\.dsh`；profile 自动探测（唯一含 `node_modules` 的 profile） |
| `-DshHome <path>` | 指定 DSH home（如 `$env:USERPROFILE\.dsh-test`） |
| `-ProfileName <name>` | 指定 profile（home 下有多个 profile 时必须传） |
| `-AllHomes` | 扫描 `%USERPROFILE%\.dsh*` 中含 `profiles` 的 home，逐个安装并汇总 `OK` / `FAIL` |
| `-DryRun` | 只预演不写入；**注意预演也会打印 `KAZ-PRESET-INSTALL OK`，不代表已写入** |
| `-Uninstall` | 只删除 `<home>\.agent-presets\kaz`；不碰 profile 的 `node_modules`，也不还原备份 |
| `-Source <path>` | 指定预设源目录（默认脚本旁的 `test-kaz`，正常不用） |
| `-SkipVersionCheck` | 绕过唯一的版本闸门。**三级口径**：正常安装 / 更新**禁止使用**；调试**不推荐**；**唯一被认可的场景**是用户主动把运行时回退到 `0.1.5-rc.1`（见 §8.2），由用户决定，执行者不得自行使用 |

行为要点：安装前会把已有预设备份到 `<home>\tools\kaz-preset-backup-<时间戳>`（排除 `node_modules`）；用 `robocopy /MIR` 把预设源**镜像**到 `<home>\.agent-presets\kaz`（排除 `node_modules`）；幂等重建预设 `node_modules` 下的两个 junction：`@deepseek-ai`（必需）、`zod`（可选）。成功输出 `KAZ-PRESET-INSTALL OK - <home> (<profile>)`。

安装程序改动的是文件，**必须重启 dsh** 才会加载；重启后在新对话的预设选择器里选 **Kaz 模式**（preset id `kaz`）。

### 2.3 `test-kaz/` 与 junction（重要）

- 本仓库的 `test-kaz\` 是**仓库 ↔ live 预设目录之间的 junction**（开发机上它直通 live 预设目录）；`test-kaz\node_modules\` 被 `.gitignore` 排除，不入库。
- 安装程序把 `test-kaz\` 镜像到 `<home>\.agent-presets\kaz`，再在预设的 `node_modules\` 下建两个 junction（`@deepseek-ai`、`zod`）指回 `<home>\profiles\<profile>\node_modules`。预设自带的 `functions/*` 之间用相对路径互相引用，因此不需要 `npm install`。
- **绝不要**在仓库里运行 `git clean -fdx` 或 `git checkout -f`：本仓库与 live 预设通过 junction 相连，这类命令会顺着 junction 写坏 live 预设。仓库脏了用 `git status` / `git diff` 查看，只手动改需要的文件。

---

## 三、预设结构（`test-kaz/`）

```
test-kaz/
├── preset.yml                 # 预设名与描述（Kaz 模式）
├── agent.cordis.yml           # 预设的 Cordis 组合定义（挂哪些行、哪些 disabled）
├── kaz-system-prompt.mjs      # persona 控制器：deployment:persona ← kaz-shared KAZ_ROLE_PROMPTS.main
└── functions/                 # 预设自带的 Kaz 组件（按相对路径挂载）
    ├── ka-whale-workflow/     # 主流程阶段机 + ka_sub_whale 受控委派 + whale_report/plan_read
    ├── ka-whale-memory/       # 记忆六工具（BM25 检索 + 摘要 + RPC 通道）
    ├── kaz-context-policy/    # context_search / context_read / context_compress + 压缩 provider
    └── kaz-shared/            # 纯模块（非 cordis 插件）：工具清单单一事实源 KAZ_ROLE_PROMPTS / KAZ_V09_MAIN_TOOLS
```

`agent.cordis.yml` 主要结构：

- `persona` + `agent-instructions` + `kaz-system-prompt`（提示词控制）。
- 工具行：`tool-pwsh` / `tool-fs` / `tool-fs-search` / `tool-ask-user` / `tool-todo` / `tool-web` 启用；不在 Stable 面内的行（`tool-str-replace-editor` / `tool-jobs` / `tool-cordis` / `tool-subagent` / `tool-subagent-fork` / `tool-workflow` / `tool-ralph`）以 `disabled: true` 保留声明（不加载、零成本）。
- `delegation` 组：子代理控制（`list_agents` / `send_message` / `interrupt_agent`）+ worker 线程。
- `kaz-components` 组（带 `isolate`）：`ka-whale-workflow`、`ka-whale-memory`。
- `compaction` 组：`compaction-kaz`（kaz-context-policy）+ 官方 `command-compact` / `tool-result-pruner`。

**稳定主工具面（21 项，`KAZ_V09_MAIN_TOOLS`）**：
`ask_user_question` / `edit` / `glob` / `grep` / `memory_detail` / `memory_list` / `memory_search` / `pwsh` / `read` / `context_read` / `context_search` / `context_compress` / `ka_sub_whale` / `list_agents` / `send_message` / `interrupt_agent` / `todo_write` / `web_search` / `whale_report` / `plan_read` / `write`。

---

## 四、仓库内容

```
dsh-KazMode/
├── install-kaz-preset.ps1     # 预设安装 / 更新 / 卸载程序（Windows）
├── test-kaz/                  # 预设形态源（安装程序镜像到 .agent-presets/kaz）
├── ds安装指引.md / ds更新指引.md           # 给 DeepSeek 的安装/更新步骤（决策完备，勿让 DS 读 README）
├── ds安装法的提示词.txt / ds更新法的提示词.txt  # 发给 DeepSeek 的提示词，指向对应指引
├── 一些指引/                  # 旧面板入口截图（legacy 面板章节用）
├── 其它好用的工具/             # 可选：DSH 实用插件
│   └── dsh-deepseek-balance/
└── 其它好用的预设/             # 可选：实验性 Router 预设
    ├── router-spec/
    └── router-standard/
```

| 路径 | 说明 |
| --- | --- |
| `install-kaz-preset.ps1` | 预设安装程序：版本闸门 → 备份 → `robocopy /MIR` 镜像 → 重建两个 junction → `KAZ-PRESET-INSTALL OK` |
| `test-kaz/preset.yml` | `kaz` 预设的显示名称与描述 |
| `test-kaz/agent.cordis.yml` | `kaz` 预设的完整 Cordis 组合定义 |
| `test-kaz/kaz-system-prompt.mjs` | persona / 系统提示词控制器 |
| `test-kaz/functions/kaz-shared/` | 工具清单单一事实源（纯模块，随预设镜像，不需要单独安装） |
| `ds安装指引.md` / `ds更新指引.md` | 给 DeepSeek 的安装 / 更新步骤 |

---

## 五、旧插件形态（legacy，≤ 7.4.x，仅 dsh 0.1.1-rc.2）

> 这一节只为**仍停留在旧形态**的用户保留。新装或迁移用户请走 §二 的预设形态；旧形态与预设形态**互斥**。

旧形态由三部分组成：插件目录 `profiles\<profile>\KazPlugins`（源在仓库 `KazPlugins/`）、`cordis.patch.yml` 里的 **8 个 Kaz insert 块**（`memory` / `plugin-filter` / `kaz-agent-preset-display` / `kaz-mode` / `output-beep` / `round-display` / `deepseek-default-model` / `ka-whale-workflow`）、以及 profile `package.json` 里 `file:KazPlugins/...` 依赖行（含必需依赖 `kaz-shared`，共 10 行）。

它比预设形态多出来的东西（预设形态**都没有**）：

- **Kaz 面板**：集中管理 `output-beep` / `deepseek-default-model` / `round-display` 的开关，并可设为 Kaz / 非 Kaz 默认；`kaz-agent-preset-display` 作为常驻补丁展示。截图见 `一些指引/记忆面板和Kaz面板在哪打开.png`。
- **工具控制面板**：只读展示固定工具面，并维护外置 / 私有插件候选。截图见 `一些指引/工具面板在哪打开.png`。
- **两阶段工具面**：首轮收敛为 `memory_search` + `context_search`，首次工具调用后恢复 Stable 面。
- **提示音 / 轮次显示 / 默认模型采样参数覆盖 / 自动载入记忆（autoLoad）**。

**迁移到预设形态**：见 `ds安装指引.md` 的**附录 A**（删 `KazPlugins`、清指向旧插件的 junction、清 `package.json` 的 `file:KazPlugins/...` 行、清 `cordis.patch.yml` 的 8 个 insert；保留 `file:KazPrivatePlugins/...` 私有行与 `kaz-skill-*` 私有块），然后升级 dsh 到 `0.1.5-rc.2`（当前唯一受支持版本）并按预设形态安装。

**旧步骤全文**（旧的 `cordis.patch.yml` 完整示例、`settings.yaml` 说明、逐条安装步骤）不再在本 README 维护，需要时查 7.5.0 之前的 git 历史（对应 tag / 旧提交里的 `README.md`、`ds安装指引.md`、`ds更新指引.md`）。

`KazPlugins/` 自 7.6.0 起已从仓库移除（旧形态源请取 7.5.1 及更早的 git 历史）；**预设形态不安装它**。

---

## 六、可选工具 / 预设（通常无需理会）

以下内容不是 Kaz 模式的必需部分，按需使用：

| 路径 | 说明 | 安装提示 |
| --- | --- | --- |
| `其它好用的工具/dsh-deepseek-balance/` | DeepSeek 账户余额悬浮挂件（独立 DSH Web 插件） | 安装方式见该目录内 `README.md` |
| `其它好用的预设/router-spec/` | 实验性 Router Spec 预设 | 复制到 `%USERPROFILE%\.dsh\.agent-presets\router-spec\` |
| `其它好用的预设/router-standard/` | 实验性 Router Standard 预设 | 复制到 `%USERPROFILE%\.dsh\.agent-presets\router-standard\` |

---

## 七、常见问题 / 踩坑

- **`VERSION GATE: FAIL`**：目标 home 的运行时 dsh 不是 `0.1.5-rc.2`。若那是旧形态 / 救援环境（`0.1.1-rc.2`，如 `.dsh-clean`），属预期；**不要**用 `-SkipVersionCheck` 绕过——**唯一例外**是用户主动把运行时回退到 `0.1.5-rc.1`（见 §8.2），那时才必须加它。
- **`multiple profiles under ...; pass -ProfileName`**：该 home 下有多个 profile；加 `-ProfileName web`。
- **`no profiles directory under ...`** / **`required runtime package missing: ...\node_modules\@deepseek-ai`**：该 home / profile 还没装好 dsh 运行时，先把 dsh 装好再装预设。
- **`cannot replace non-empty real directory`**：预设 `node_modules\@deepseek-ai`（或 `zod`）是真实目录而不是 junction；备份后删除该目录，再重跑安装程序。
- **看到 `KAZ-PRESET-INSTALL OK` 但好像没生效**：如果那次带了 `-DryRun`，OK 只是预演；去掉 `-DryRun` 重跑一次。
- **`-AllHomes` 里某个 home 报 `FAIL`**：该 home 的运行时 dsh 不是 `0.1.5-rc.2`。主环境 `.dsh`（全局 `0.1.5-rc.2`，闸门落到全局包，见 §8.1）与测试环境 `.dsh-test`（本地副本 `0.1.5-rc.2`）都应 `OK`；`.dsh-clean`（救援环境，`0.1.1-rc.2`）报 `FAIL` 属设计如此。
- **`robocopy` 镜像把目标里多出的文件删了**：`/MIR` 是镜像语义，`node_modules` 除外；不要往 `.agent-presets\kaz` 里放自定义文件，备份在 `<home>\tools\kaz-preset-backup-*`（会累积，可手动清理）。
- **绝对不要**对仓库运行 `git clean -fdx` / `git checkout -f`：`test-kaz` 是仓库 ↔ live 的 junction，会顺着写坏 live 预设。
- **用 `Set-Content -Encoding UTF8` 写 YAML/JSON 产生 BOM**：BOM 可能破坏 JSON.parse；用支持 UTF-8 无 BOM 的编辑器/工具。
- **遇到 `write/edit` 报 `ReplaceFileW EIO (Win32 1175)`**：这是 Windows 偶发文件系统错误，重试同一次编辑/命令即可，不要换工具或放弃。
- **改动不生效**：预设是文件镜像，必须重启 `dsh web` + 强刷浏览器。

---

## 八、文件与版本说明

### 8.1 相关文件

| 路径 | 说明 |
| --- | --- |
| `install-kaz-preset.ps1` | 唯一安装 / 更新 / 卸载入口（Windows，ASCII，PowerShell 5.1 安全） |
| `test-kaz/preset.yml` | `kaz` 预设的显示名称与描述 |
| `test-kaz/agent.cordis.yml` | `kaz` 预设的完整 Cordis 组合定义 |
| `test-kaz/kaz-system-prompt.mjs` | 系统提示词 / persona 控制器 |
| `test-kaz/functions/<组件>/` | 预设自带的 Kaz 组件（workflow / memory / context-policy / shared） |
| `<home>\.agent-presets\kaz\` | 安装后的 live 预设目录（由 `test-kaz/` 镜像而来） |
| `<home>\tools\kaz-preset-backup-<时间戳>\` | 每次安装前的自动备份（排除 `node_modules`） |
| `<home>\tools\dsh-cli\` | **home 本地 CLI 副本**（`@deepseek-ai/dsh` + `dsh-base` + `dsh-web-app` 三件套同版本）。`test` / `clean` 两个 home 的启动器用它并在开屏按 `EXPECTED_CLI` 做版本门（`.dsh-test` 的副本与启动器均为 `0.1.5-rc.2`；`.dsh-clean` 均为 `0.1.1-rc.2`）。**主环境 `.dsh` 没有也不使用它**：主环境锚定在机器的全局 `dsh`（`%APPDATA%\npm`，`0.1.5-rc.2`），启动器 `dsh启动.bat` 按 `EXPECTED_CLI=0.1.5-rc.2` 门禁。因此 `install-kaz-preset.ps1` 的闸门（候选顺序见 §2.1）在 `.dsh` 上前两个候选全部落空、读到**全局 `0.1.5-rc.2`**（`-DryRun` 打印的路径就是全局那条）；`.dsh-test` 读到自己的副本 `0.1.5-rc.2`；`.dsh-clean` 读到自己的 `0.1.1-rc.2`，按预期 `FAIL`；**看打印路径判断闸门读的是哪一份** |
| `ds安装指引.md` / `ds更新指引.md` | 给 DeepSeek 的安装 / 更新步骤（决策完备，唯一做法） |
| `ds安装法的提示词.txt` / `ds更新法的提示词.txt` | 发给 DeepSeek 的简短提示词，指向对应指引 |
| `一些指引/` | 旧面板入口截图（legacy 章节用） |
| `其它好用的工具/` | 可选独立 DSH 工具/插件 |
| `其它好用的预设/` | 可选实验性 Router 预设 |

### 8.2 发版说明（给未来的我和 agent）

- **7.6.0**：旧插件形态从仓库移除（`KazPlugins/` 与仓库根指向主预设的冗余 `kaz` junction），旧形态源只从 7.5.1 及更早的 git 历史取用；主环境 `.dsh` 迁移到预设形态并加装本地 CLI 副本与启动器版本门（见 8.1）；修复 `install-kaz-preset.ps1` 的一个真 bug——`Clear-LinkPath` 在**全新 home**（`<preset>\node_modules` 下尚无 junction）时会执行 `cmd /c rmdir` 到一个不存在的路径，该 stderr 在 `$ErrorActionPreference = 'Stop'` 下变成终止性错误，导致**文件已镜像、两个 junction 未建、退出码 1**的半成品状态；现在该调用被 `try { } catch { }` 包住。
- **7.6.1**：
  - `ka-whale-memory` **不再做任何上下文注入**：guidance / 遗忘指引 / autoLoad 快照注入（以及 settings 里的 `guidance*` 字段、首轮定位缓存、`autoLoad` RPC）全部删除，插件只剩六个记忆工具与存储引擎。
  - `ka-whale-workflow` 删掉首轮 `startup-tool-hint` 注入（它是为「首轮只留两个工具」的 Minimal 机制准备的，预设形态已无该机制）。
  - 其余注入记录改用 **schema 合规**的写法：`source: { kind: "plugin", plugin: "ka-whale-workflow", form: "notice", summary: "stage:<阶段>" }`；读侧 `injectedTagOf()` 对旧写法（`form: "stage:*"` / `startup-tool-hint`）与新写法等效识别。原因：dsh 0.1.5 的 v0→v1 会话迁移**只放行** `instructions` / `catalog` / `snapshot` / `notice` / `relay` / `recall` 六个 form，我们自造的值会让**整份历史会话**读不出来（`refuses this format v0 Session`）。
  - 旧日志修复脚本：`不入库文件\kaz-form-fix-20260911\fix-session-form.mjs` 逐帧解压 → 把非法 `form` 改写成 `notice` + `summary`（原标签保留）→ 逐帧重编码写回，并用 `dsh-session-format-v0-to-v1.assertReleasedEventPayload` 做改前/改后判定。
  - 主环境运行时锚点回到**全局 dsh**：`dsh启动.bat` 改为调用 `%APPDATA%\npm\dsh.cmd` 并按 `EXPECTED_CLI` 门禁；`.dsh\tools\dsh-cli` 不再被主环境使用（`clean` / `test` 仍各自固定副本）。

- **7.6.1 之后（2026-09-11，未发版；已被下一条取代）**：主环境 `.dsh` 的运行时 / 全局 CLI 升到 `0.1.5-rc.2`（`profiles\web` 的 205 个 `@deepseek-ai` 包全为 rc.2），测试环境 `.dsh-test` 当时仍是 `0.1.5-rc.1`；`install-kaz-preset.ps1` 的 `$SupportedVersions` 当时同时接受 rc.1 与 rc.2，`-AllHomes` 下 `.dsh` / `.dsh-test` 均 `OK`、`.dsh-clean`（`0.1.1-rc.2`）仍 `FAIL`。**已知遮蔽（已作废）**：`.dsh\tools\dsh-cli` 当时留着一份未使用的 rc.1 旧副本，闸门按候选顺序先读到它，因此 `.dsh` 当时是用 rc.1 副本通过闸门的、`-DryRun` 打印的版本也是 rc.1（不是全局 rc.2）。`Get-RuntimeVersion` 的候选顺序**刻意不改**——改顺序会让 `.dsh-clean` 读到全局 rc.2 而变成 `PASS`，破坏救援环境的预期 `FAIL`。详见 §8.1。

- **7.6.1 之后 · 单版本收窄（2026-09-11 晚，未发版）**：三台 home 的运行时全部回到真实口径——`.dsh` 全局 `0.1.5-rc.2`（**home 内那份 rc.1 残留副本已删除**，闸门因此落到全局包，打印路径也变成全局那条）、`.dsh-test` 本地副本升到 `0.1.5-rc.2`（启动器 `EXPECTED_CLI=0.1.5-rc.2`）、`.dsh-clean` 固定 `0.1.1-rc.2` 按设计 `FAIL`；上面那句「已知遮蔽」随之作废，§2.1 / §7 / §8.1 里的残留副本说法已全部移除。`install-kaz-preset.ps1` 的 `$SupportedVersions` 收窄为 `@('0.1.5-rc.2')`，两份指引的 `$supportedDsh` 同步收窄——**rc.1 不再受支持**（回退路径见本节末尾的「回退到 `0.1.5-rc.1` 的路径」）。候选顺序与 `VERSION GATE: FAIL` 文案未动；`-AllHomes -DryRun` 现在为 `.dsh` / `.dsh-test` 打印 `0.1.5-rc.2`、为 `.dsh-clean` 打印 `FAIL`。

- **预设形态没有「面板本地版本」**：旧插件形态那个读 `KazPlugins/kaz-mode/package.json` 的 `version` 字段、并与 GitHub tag 比较的机制，随面板一起退役。预设形态的版本就是仓库的 **git tag / 提交**；改预设请改 `test-kaz/`。
- 支持版本是**硬编码在 `install-kaz-preset.ps1` 里的 `$SupportedVersions`**（当前 `@('0.1.5-rc.2')`；`VERSION GATE: FAIL` 文案里的支持列表由该数组自动拼出）。升级适配 dsh 版本时按这份清单同步，别只改数组：
  1. `install-kaz-preset.ps1` 的 `$SupportedVersions`（**`Get-RuntimeVersion` 的候选顺序不要动**：它决定 `.dsh-clean` 读到自己的 `0.1.1-rc.2` 副本、按预期 `FAIL`）；
  2. 同一文件头部注释里的 supported 列表；
  3. `README.md`：§2.1 矩阵与闸门顺序说明、§五迁移步骤、§七 FAQ、§8.1 与本节；
  4. `ds安装指引.md` / `ds更新指引.md`：**第 0 步的 `$supportedDsh` 数组**、第 0 步给用户的 `VERSION GATE: FAIL` 说明原文、附录 A 的升级目标，以及两份「出错速查表」里的版本说法。
- **回退到 `0.1.5-rc.1` 的路径（诚实说明：可行，但不是受支持状态）**：闸门现在只接受 `0.1.5-rc.2`，所以回退要**两步一起做**——① 把运行时换回 `0.1.5-rc.1`（主环境：全局 `npm install -g @deepseek-ai/dsh@0.1.5-rc.1`，并把 `dsh启动.bat` 的 `EXPECTED_CLI` 改回 `0.1.5-rc.1`，否则启动器开屏就拒绝启动；`.dsh-test` / `.dsh-clean`：换它们 `tools\dsh-cli` 的本地副本，并同步各自启动器的 `EXPECTED_CLI`）；② 安装 / 更新预设时显式加 `-SkipVersionCheck`，否则 `VERSION GATE: FAIL`。回退后的 rc.1 不在 `$SupportedVersions` 内，属于用户主动选择、不再被保证的配置——**执行者不得自行决定回退**，只有用户明确要求时才做。
- 旧的 `KazPlugins/kaz-mode/check-version.mjs` 与 `KazPlugins/kaz-mode/package.json` 的 `version` **只对 legacy 形态有意义**，预设形态的发版流程不再依赖它们。
- 发布前建议跑一次 `powershell -ExecutionPolicy Bypass -File .\install-kaz-preset.ps1 -AllHomes -DryRun`，确认各 home 的闸门与 profile 解析结果符合预期（**记得 `-DryRun` 的 OK 只是预演**）。

---

*本文件由 Kaz 模式维护；安装 / 更新请始终以 `ds安装指引.md` / `ds更新指引.md` 与仓库根 `install-kaz-preset.ps1` 为准。*
