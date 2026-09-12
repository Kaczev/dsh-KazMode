# Kaz 模式（dsh-KazMode）

> 为 DeepSeek Harness（dsh）设计的一套 **agent preset（预设）**：**主代理的工作流**——主代理跟用户对接、决定自己做完还是派出去，子代理干活，记忆统一由记忆管家管理。
>
> 当前版本 **Kaz 8.0**（从零重写，与旧 kaz 无代码关联）。预设源码（**发布源**）在仓库 `kaz/`，安装 / 更新由仓库根 `install-kaz-preset.ps1` 完成，**只支持 dsh `0.1.5-rc.2`**（主环境 `.dsh` 走全局 `0.1.5-rc.2`，测试环境 `.dsh-test` 用它自己的本地副本 `0.1.5-rc.2`；救援环境 `.dsh-clean` 固定 `0.1.1-rc.2`，按设计过不了闸门）。
>
> 旧的「插件形态」（≤ 7.4.x，dsh `0.1.1-rc.2`）自 7.6.0 起不再随仓库发布，见 §五。

## 一、核心特性（Kaz 8.0）

- **主代理的工作流**：主代理负责听清需求、安排谁来做、对结果负责；能自己干完的自己干，适合交出去的立刻派给子代理（能并行就并行、能复用就复用）。不是无约束多 agent，也不是原生 Plan 模式。
- **三方 persona（全英文）**：主代理（首句 `We are the user's point of contact and the work's arranger: ...`）、记忆管家 memoryMaintainer（固定 persona）、自定义子代理（角色与性格由主代理在派发时现写）。文本收口在 `kaz/functions/kaz-shared/lib/roles.js`。
- **三角色工具面黑名单**：只有黑名单、没有白名单——黑名单之外剩下什么就是什么，这样外接的工具也能自然进入工具面。
  - 主代理：看不到 `memory_save` / `memory_update` / `memory_forget`（写记忆只由记忆管家做）。
  - 记忆管家：一份点名黑名单（shell / 写文件 / todo / 提问 / 网络 / 派发与工作流工具等），记忆六件与 `read` / `grep` / `glob`、上下文三件照常可用。
  - 子代理：没有默认黑名单；每个子代理的黑名单由主代理派发时写进安排，缺省 = 不屏蔽。
- **记忆（`ka-whale-memory`）**：文件式、双作用域（global / local）、两类（`context` 内容记忆 / `paths` 路径记忆），**一个记忆一个 JSON**；BM25 检索（中英文分词）；六工具；`name` 就是文件名且全局唯一（跨种类、跨库都不允许重名）。
- **上下文（`kaz-context-policy`）**：`context_search`（在会话原始记录里检索，含已被压缩掉的部分；`companion` 可查别的 agent 的记录）、`context_read`（按 seq 读回原文）、`context_compress`（**框选**：`from_seq` / `to_seq` 两端必填，`keep_recent` 决定尾部保留带）；上下文占用达到 50% 时注入压缩提醒 `[ka-context-policy compression-hint]`。
- **工作流（`ka-whale-workflow`）**：轻量阶段机 `idle ⇄ arrange_agent` + 四工具 `write_arrangement` / `get_arrangement` / `ka_sub_whale` / `whale_report`；安排（arrangement）就是派发的账本（`persona` / `blacklist` / `task` / `fork`，外加程序回填的 `id` / `status` / `summary`）；自带 `kaz-fork` provider，支持"fork 主代理或某个存活子代理的历史"起步。
- **工具面与官方标准预设对齐**，只靠黑名单控制角色可见性（见 §三「刻意不挂」）。
- **无 UI、无模型采样参数覆盖**：没有面板、开关、提示音、轮次显示；开关就是「选不选这个预设」。
- **推荐思考强度 high 及以上**，low 容易冒出 "let me" 思维链。

---

## 二、快速开始

### 2.1 版本矩阵

| 形态 | dsh 版本 | 安装 / 更新方式 | 源 |
| --- | --- | --- | --- |
| **预设形态（当前，Kaz 8.0）** | **`0.1.5-rc.2`（唯一受支持版本）** | 运行仓库根 `install-kaz-preset.ps1` | 仓库 `kaz/`（发布源） |
| 旧插件形态（legacy，≤ 7.4.x） | `0.1.1-rc.2` | 手动复制 + `npm install` + `cordis.patch.yml`（见 §五） | git 历史（≤ 7.5.1）的 `KazPlugins/` |

- 三台 home、三种角色（**单版本 rc.2 世界**）：**主环境 `.dsh`** 的运行时是全局 dsh `0.1.5-rc.2`（`%APPDATA%\npm`）；**测试环境 `.dsh-test`** 用 home 本地副本 `0.1.5-rc.2`（`tools\dsh-cli`）；**救援环境 `.dsh-clean`** 固定 `0.1.1-rc.2`（按设计 `FAIL`）。
- 版本闸门按**运行时包** `@deepseek-ai/dsh/package.json` 的 `version` 判定，**只放行 `0.1.5-rc.2`**；不匹配时安装程序输出 `VERSION GATE: FAIL` 并以退出码 1 结束。把运行时回退到 `0.1.5-rc.1` 后必须显式加 `-SkipVersionCheck`（正常安装 / 更新**不要**用它，见 §8.2）。
- **闸门取版本的顺序**是 `<home>\tools\dsh-cli` → `<home>\profiles\<profile>\node_modules\@deepseek-ai\dsh` → 全局 `%APPDATA%\npm`，**取到第一个存在者即停**；**看打印路径判断闸门读的是哪一份**。

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
| `-Source <path>` | 指定预设源目录（**默认 = 脚本旁的 `kaz`，即发布源**；只有把测试区成果推广到主区时才显式传 `test-kaz`，见 §8.3） |
| `-SkipVersionCheck` | 绕过唯一的版本闸门。正常安装 / 更新**禁止使用**；唯一被认可的场景是用户主动把运行时回退到 `0.1.5-rc.1`（见 §8.2） |

行为要点：安装前把已有预设备份到 `<home>\tools\kaz-preset-backup-<时间戳>`（排除 `node_modules`）；用 `robocopy /MIR` 把预设源**镜像**到 `<home>\.agent-presets\kaz`（排除 `node_modules`）；幂等重建预设 `node_modules` 下的两个 junction：`@deepseek-ai`（必需）、`zod`（可选）。成功输出 `KAZ-PRESET-INSTALL OK - <home> (<profile>)`。

**`@deepseek-ai` junction 指向哪个包集（关系到插件行能不能解析）**：优先 `<home>\profiles\node_modules\@deepseek-ai`（同 home 全部 profile 共享的那一层），只有当它没有运行时包（`dsh\package.json`）时才回退到 `<home>\profiles\<profile>\node_modules\@deepseek-ai`。原因：预设解析插件名时**先看自己的 `node_modules`**，一个指向父目录的链接会截断向上的查找——若指向 profile 自己那一份（只含该 profile 装过的子集），只在共享层存在的行（`dsh-persona`、`dsh-tool-ask-user` 等 30 个）就会解析失败，预设直接挂不起来。安装日志里 `linked: ... -> ...` 会打印实际选中的那一层。

安装程序改动的是文件，**必须重启 dsh** 才会加载；重启后在新对话的预设选择器里选 **Kaz 模式**（preset id `kaz`）。

### 2.3 `kaz/` 与 `test-kaz/`（重要）

- **`kaz/` ＝ 发布源**：开发机上它是 junction，直通**主区** live 预设目录 `.dsh\.agent-presets\kaz`。用户从仓库装到的就是这一份；安装程序的默认 `-Source` 也是它。
- **`test-kaz/` ＝ 测试区副本**：junction 直通测试区 `.dsh-test\.agent-presets\kaz`。它是开发/试验用的（**不稳定**），放进仓库只为**回退**（git 历史能回滚），**不是安装源**。
- 两个目录的 `node_modules\` 都被 `.gitignore` 排除，不入库。
- 安装程序把源镜像到 `<home>\.agent-presets\kaz`，再在预设的 `node_modules\` 下建两个 junction：`zod` 指回 `<home>\profiles\<profile>\node_modules`，`@deepseek-ai` 指回**同一 home 内的共享运行时包集**（`<home>\profiles\node_modules\@deepseek-ai`；该层没有运行时包时才回退 profile 那一层，见 §2.2）。预设自带的 `functions/*` 之间用相对路径互相引用，因此不需要 `npm install`。
- 预设根目录的 `VERSION` 文件（一行 `8.0.0`）就是**预设自己的版本号**，随镜像一起进 live 预设目录；它由人手工维护，见 §8.2。
- ⚠️ **别对测试区跑默认安装**：默认源是发布源（`kaz/`），对 `-DshHome .dsh-test` 跑默认安装会把发布源盖到测试区、冲掉开发副本。要装测试区就用 `-Source test-kaz`。
- **绝不要**在仓库里运行 `git clean -fdx` 或 `git checkout -f`：`kaz\`、`test-kaz\`、`其它好用的插件\dsh-balance\` 都是仓库 ↔ live 的 junction，这类命令会顺着 junction 写坏 live 预设/插件源。仓库脏了用 `git status` / `git diff` 查看，只手动改需要的文件。

---

## 三、预设结构（`kaz/`）

```
kaz/                              # 发布源（开发机上 =junction→ 主区 live 预设目录）
├── VERSION                    # 预设版本号（一行 8.0.0；手工维护，随镜像进 live 预设）
├── preset.yml                 # 预设名与描述（Kaz 模式）
├── agent.cordis.yml           # 预设的 Cordis 组合定义（挂哪些行；哪些刻意不挂）
├── kaz-system-prompt.mjs      # 系统提示控制器：主代理 persona ← kaz-shared MAIN_PERSONA；摘掉 harness:identity
└── functions/                 # 预设自带的 Kaz 组件（按相对路径挂载）
    ├── kaz-shared/            # 纯模块：三方 persona 文本、三角色黑名单、角色判定、工具面门（黑名单落地）
    ├── ka-whale-memory/       # 记忆六工具 + 存储引擎（BM25 + 文件式记忆库）
    ├── kaz-context-policy/    # context_search / context_read / context_compress + 50% 压缩提醒
    └── ka-whale-workflow/     # 阶段机 + 四工具 + 安排文件 + kaz-fork provider
```

> 测试区的开发副本在 `test-kaz/`（结构相同；**不稳定**，放进仓库只为回退，不作安装源，见 §2.3）。

**角色工具面（黑名单之外剩下什么就是什么）**：

- **主代理**看不到：`memory_save` / `memory_update` / `memory_forget`。
- **记忆管家**看不到：`pwsh`、`write`、`edit`、`todo_write`、`ask_user_question`、`web_search`、`web_fetch`、`job_output` / `job_list` / `job_kill`、`skill`、`present`、`send_message`、`interrupt_agent`、`ka_sub_whale`、`whale_report`、`write_arrangement`。
  - `bash` 不在这份名单里：Windows 上它**根本没挂**（组合里刻意不挂 `tool-bash`），所以谈不上屏蔽——`MEMORY_MAINTAINER_BLACKLIST` 里没有它，别照抄成"管家看不到 bash"。
  - 注意**保留集挡不住黑名单也挡不掉**：`list_agents` 与 `get_arrangement` 属于保留集（`RESERVED_TOOLS`），即使写进黑名单也照样可见——管家 persona 的「工具速览」里就明确写了怎么用 `get_arrangement`。管家的**写**工具面则是保留集加了记忆写三件（`MEMORY_MAINTAINER_RESERVED`）。
- **子代理**：无默认黑名单，由主代理派发时写。

**刻意不挂的行**（不是故障）：`tool-bash`（Windows 用 pwsh）、`command-goal` + `tool-goal`、官方 `tool-subagent` / `tool-subagent-fork`（由 `ka_sub_whale` + `kaz-fork` 取代）、`plan-mode`（`/plan`）、`tool-workflow` + `workflow-worker-thread`、`tool-ralph`。

**注入**（都是上下文注入，不是系统提示段）：阶段文本 `[ka-whale-workflow <stage>]`（用户每发一条消息、或阶段切换时注入）；压缩提醒 `[ka-context-policy compression-hint]`（上下文占用 ≥50% 时，按每 +5% 复现）。

---

## 四、仓库内容

```
dsh-KazMode/
├── install-kaz-preset.ps1     # 预设安装 / 更新 / 卸载程序（Windows）
├── kaz/                       # 预设源（发布源；安装程序镜像到 .agent-presets/kaz）
├── test-kaz/                  # 测试区开发副本（不稳定，仅回退用；默认安装不用它）
├── ds安装指引.md / ds更新指引.md           # 给 DeepSeek 的安装/更新步骤（决策完备，勿让 DS 读 README）
├── ds安装法的提示词.txt / ds更新法的提示词.txt  # 发给 DeepSeek 的提示词，指向对应指引
├── 一些指引/                  # 旧面板入口截图（legacy 面板章节用）
├── 其它好用的插件/             # 可选：DSH 实用插件
│   └── dsh-deepseek-balance/
└── 其它好用的预设/             # 可选：实验性 Router 预设
    ├── router-spec/
    └── router-standard/
```

| 路径 | 说明 |
| --- | --- |
| `install-kaz-preset.ps1` | 预设安装程序：版本闸门 → 备份 → `robocopy /MIR` 镜像 → 重建两个 junction → `KAZ-PRESET-INSTALL OK` |
| `kaz/VERSION` | 预设版本号（一行 `8.0.0`；手工维护） |
| `kaz/preset.yml` | `kaz` 预设的显示名称与描述 |
| `kaz/agent.cordis.yml` | `kaz` 预设的完整 Cordis 组合定义 |
| `kaz/kaz-system-prompt.mjs` | 系统提示词 / persona 控制器 |
| `kaz/functions/kaz-shared/` | persona 文本、黑名单、工具面门（纯模块 + 门插件） |
| `kaz/functions/ka-whale-memory/` | 记忆六工具与存储引擎 |
| `kaz/functions/kaz-context-policy/` | 上下文三工具与压缩提醒 |
| `kaz/functions/ka-whale-workflow/` | 阶段机、安排、派发与 fork |
| `test-kaz/` | 测试区开发副本（junction → `.dsh-test\.agent-presets\kaz`；仅回退用） |
| `ds安装指引.md` / `ds更新指引.md` | 给 DeepSeek 的安装 / 更新步骤 |

**数据落盘**：

| 内容 | 位置 |
| --- | --- |
| 全局记忆 | `<home>\storages\ka-whale-memory\{context,paths}\<name>.json` |
| 项目记忆 | `<项目>\.dsh\storages\ka-whale-memory\{context,paths}\<name>.json` |
| 安排（一个对话一份） | `<项目>\.dsh\storages\arrangements\<sessionId>.json` |
| 阶段（内存态 + 持久化） | `<项目>\.dsh\storages\workflow_stages.json` |

---

## 五、旧插件形态（legacy，≤ 7.4.x，仅 dsh 0.1.1-rc.2）

> 这一节只为**仍停留在旧形态**的用户保留。新装或迁移用户请走 §二 的预设形态；旧形态与预设形态**互斥**。

旧形态由三部分组成：插件目录 `profiles\<profile>\KazPlugins`（源在仓库 `KazPlugins/`）、`cordis.patch.yml` 里的 **8 个 Kaz insert 块**（`memory` / `plugin-filter` / `kaz-agent-preset-display` / `kaz-mode` / `output-beep` / `round-display` / `deepseek-default-model` / `ka-whale-workflow`）、以及 profile `package.json` 里 `file:KazPlugins/...` 依赖行（含必需依赖 `kaz-shared`，共 10 行）。

它比预设形态多出来的东西（预设形态**都没有**）：

- **Kaz 面板**：集中管理 `output-beep` / `deepseek-default-model` / `round-display` 的开关，并可设为 Kaz / 非 Kaz 默认；`kaz-agent-preset-display` 作为常驻补丁展示。截图见 `一些指引/记忆面板和Kaz面板在哪打开.png`。
- **工具控制面板**：只读展示固定工具面，并维护外置 / 私有插件候选。截图见 `一些指引/工具面板在哪打开.png`。
- **两阶段工具面**：首轮收敛为 `memory_search` + `context_search`，首次工具调用后恢复 Stable 面。
- **提示音 / 轮次显示 / 默认模型采样参数覆盖 / 自动载入记忆（autoLoad）**。

**迁移到预设形态**：见 `ds安装指引.md` 的**附录 A**（删 `KazPlugins`、清指向旧插件的 junction、清 `package.json` 的 `file:KazPlugins/...` 行、清 `cordis.patch.yml` 的 8 个 insert；保留 `file:KazPrivatePlugins/...` 私有行与 `kaz-skill-*` 私有块），然后升级 dsh 到 `0.1.5-rc.2` 并按预设形态安装。

**旧步骤全文**不再在本 README 维护，需要时查 7.5.0 之前的 git 历史（对应 tag / 旧提交里的 `README.md`、`ds安装指引.md`、`ds更新指引.md`）。

`KazPlugins/` 自 7.6.0 起已从仓库移除（旧形态源请取 7.5.1 及更早的 git 历史）；**预设形态不安装它**。

---

## 六、可选工具 / 预设（通常无需理会）

| 路径 | 说明 | 安装提示 |
| --- | --- | --- |
| `其它好用的插件/dsh-balance/` | 余额悬浮挂件：实时余额、折线虚影与强度配色、老虎机数字、暴跌抖动、边缘吸附（独立 DSH Web 插件） | 安装方式见该目录内 `README.md` |
| `其它好用的预设/router-spec/` | 实验性 Router Spec 预设 | 复制到 `%USERPROFILE%\.dsh\.agent-presets\router-spec\` |
| `其它好用的预设/router-standard/` | 实验性 Router Standard 预设 | 复制到 `%USERPROFILE%\.dsh\.agent-presets\router-standard\` |

---

## 七、常见问题 / 踩坑

- **`VERSION GATE: FAIL`**：目标 home 的运行时 dsh 不是 `0.1.5-rc.2`。若那是旧形态 / 救援环境（`0.1.1-rc.2`，如 `.dsh-clean`），属预期；**不要**用 `-SkipVersionCheck` 绕过（唯一例外：用户主动回退到 `0.1.5-rc.1`，见 §8.2）。
- **`multiple profiles under ...; pass -ProfileName`**：该 home 下有多个 profile；加 `-ProfileName web`。
- **`no profiles directory under ...`** / **`required runtime package missing: ...\node_modules\@deepseek-ai`**：该 home / profile 还没装好 dsh 运行时，先把 dsh 装好再装预设。
- **`cannot replace non-empty real directory`**：预设 `node_modules\@deepseek-ai`（或 `zod`）是真实目录而不是 junction；备份后删除该目录，再重跑安装程序。
- **预设挂不起来 / 组合里某一行解析失败（`names a plugin that cannot be resolved`）**：预设解析插件名先看自己的 `node_modules`，`@deepseek-ai` 那个链接指向哪一层就决定了看得到哪些包。检查安装日志的 `linked: <preset>\node_modules\@deepseek-ai -> ...`：**应指向同 home 的共享层** `<home>\profiles\node_modules\@deepseek-ai`（老版本安装程序会指向 `<home>\profiles\<profile>\node_modules\@deepseek-ai`，那一层可能缺 `dsh-persona`、`dsh-tool-ask-user` 等只在共享层存在的包）。指错了就重跑当前仓库的安装程序，或手工 `rmdir` 旧链接后重建。
- **看到 `KAZ-PRESET-INSTALL OK` 但好像没生效**：如果那次带了 `-DryRun`，OK 只是预演；去掉 `-DryRun` 重跑一次。
- **`-AllHomes` 里某个 home 报 `FAIL`**：该 home 的运行时 dsh 不是 `0.1.5-rc.2`（`.dsh-clean` 报 `FAIL` 属设计如此）。
- **`robocopy` 镜像把目标里多出的文件删了**：`/MIR` 是镜像语义，`node_modules` 除外；不要往 `.agent-presets\kaz` 里放自定义文件，备份在 `<home>\tools\kaz-preset-backup-*`（会累积，可手动清理）。
- **绝对不要**对仓库运行 `git clean -fdx` / `git checkout -f`：`kaz`、`test-kaz`、`其它好用的插件\dsh-balance` 都是仓库 ↔ live 的 junction，会顺着写坏 live 预设/插件源。
- **用 `Set-Content -Encoding UTF8` 写 YAML/JSON 产生 BOM**：BOM 可能破坏 JSON.parse；用支持 UTF-8 无 BOM 的编辑器/工具。
- **遇到 `write/edit` 报 `ReplaceFileW EIO (Win32 1175)`**：Windows 偶发文件系统错误，重试即可。
- **改动不生效**：预设是文件镜像，必须重启 `dsh web` + 强刷浏览器。
- **工具面少了几件**：先看 §三 的「刻意不挂」和黑名单——`memory_save` / `memory_update` / `memory_forget` 对主代理不可见是设计如此（写记忆交给记忆管家）。

---

## 八、文件与版本说明

### 8.1 相关文件

| 路径 | 说明 |
| --- | --- |
| `install-kaz-preset.ps1` | 唯一安装 / 更新 / 卸载入口（Windows，ASCII，PowerShell 5.1 安全） |
| `kaz/VERSION` | 预设版本号（一行 `8.0.0`；手工维护，来源即仓库这一份） |
| `kaz/preset.yml` | `kaz` 预设的显示名称与描述 |
| `kaz/agent.cordis.yml` | `kaz` 预设的完整 Cordis 组合定义 |
| `kaz/kaz-system-prompt.mjs` | 系统提示词 / persona 控制器 |
| `kaz/functions/kaz-shared/` | persona 文本、三角色黑名单、角色判定、工具面门 |
| `kaz/functions/ka-whale-memory/` | 记忆六工具与存储引擎 |
| `kaz/functions/kaz-context-policy/` | 上下文三工具与压缩提醒 |
| `kaz/functions/ka-whale-workflow/` | 阶段机、安排、派发与 fork |
| `test-kaz/` | 测试区开发副本（junction → `.dsh-test\.agent-presets\kaz`；不稳定，仅回退用） |
| `<home>\.agent-presets\kaz\` | 安装后的 live 预设目录（由发布源 `kaz/` 镜像而来） |
| `<home>\tools\kaz-preset-backup-<时间戳>\` | 每次安装前的自动备份（排除 `node_modules`） |
| `ds安装指引.md` / `ds更新指引.md` | 给 DeepSeek 的安装 / 更新步骤（决策完备，唯一做法） |

### 8.2 发版说明（给未来的我和 agent）

- **Kaz 8.0.0（2026-09-12，预设重写，未发 tag）**：从零重写，与旧 kaz 无代码关联。
  - 三方 persona 全英文；主代理首句 `We are the user's point of contact and the work's arranger: ...`。
  - 工具面与官方 `standard` 预设对齐，只靠黑名单控制角色可见性：主代理看不到记忆写三件；记忆管家有一份点名黑名单；子代理黑名单由主代理派发时写。
  - 记忆改为文件式双作用域（global / local × context / paths），一个记忆一个 JSON，`name` 全局唯一且即文件名；BM25 检索（Intl.Segmenter 中英文分词）。
  - 上下文三件：`context_search`（含 `companion` 跨 agent）、`context_read`、`context_compress`（只做框选：`from_seq` / `to_seq` 两端必填，`keep_recent` 管尾部保留带）；≥50% 注入压缩提醒。
  - 工作流：`idle` / `arrange_agent` 阶段机 + `write_arrangement` / `get_arrangement` / `ka_sub_whale` / `whale_report`；安排文件在 `<项目>\.dsh\storages\arrangements\`；自带 `kaz-fork` provider（可 fork 主代理或某个存活子代理的历史）。
  - **工具名统一用下划线**（2026-09-12）：`write-arrangement` / `get-arrangement` 改名为 `write_arrangement` / `get_arrangement`，与官方口径一致——**模型要调用的工具名用下划线**（如 `list_agents`、`ask_user_question`），**包名 / 插件行 id / 文件名 / 模块子路径用连字符**（如 `@deepseek-ai/dsh-tool-subagent-control`、行 id `tool-subagent-list-agents`、`lib/types/list-agents.js`）。改名要跟重启同步做：跑着的会话系统提示里记的是旧名，改名而不重启会让那一轮调用失败。
  - 刻意不挂：`tool-bash`、goal 两行、官方 `tool-subagent` / `tool-subagent-fork`、`plan-mode`、`tool-workflow` / `workflow-worker-thread`、`tool-ralph`。
  - **新增 `VERSION` 文件**（一行 `8.0.0`）：预设自己的版本号，即 `kaz/VERSION`，随镜像进 live 预设目录（`<home>\.agent-presets\kaz\VERSION`）。**手工维护**——发版时改这一行；安装程序只镜像、不生成、不校验。`preset.yml` 只认 `name` / `description` / `order` 三个字段，所以版本号不写进去。
  - **安装程序的 `@deepseek-ai` junction 目标改为优先共享包集**（真 bug 修复）：原先指向 `<home>\profiles\<profile>\node_modules\@deepseek-ai`，那里只有该 profile 装过的 214 个包；而 Kaz 8.0 的组合需要 `@deepseek-ai/dsh-persona`（`kaz-system-prompt.mjs` 直接 import）与 `@deepseek-ai/dsh-tool-ask-user`（组合里的一行），两者只存在于共享层 `<home>\profiles\node_modules\@deepseek-ai`（244 个包）。预设先查自己的 `node_modules`，链接会截断向上查找，于是这两行解析失败、预设挂不起来。现在优先共享层、找不到运行时包才回退 profile 层。
- **7.6.0**：旧插件形态从仓库移除（`KazPlugins/` 与仓库根指向主预设的冗余 `kaz` junction），旧形态源只从 7.5.1 及更早的 git 历史取用；修复 `install-kaz-preset.ps1` 的一个真 bug——`Clear-LinkPath` 在**全新 home**（`<preset>\node_modules` 下尚无 junction）时会执行 `cmd /c rmdir` 到一个不存在的路径，该 stderr 在 `$ErrorActionPreference = 'Stop'` 下变成终止性错误，导致**文件已镜像、两个 junction 未建、退出码 1**的半成品状态；现在该调用被 `try { } catch { }` 包住。
- **7.6.1**：
  - `ka-whale-memory` 不再做任何上下文注入：guidance / 遗忘指引 / autoLoad 快照注入全部删除，插件只剩六个记忆工具与存储引擎。
  - `ka-whale-workflow` 删掉首轮 `startup-tool-hint` 注入。
  - 其余注入记录改用 **schema 合规**的写法（`form: "notice"` + `summary`）：dsh 0.1.5 的 v0→v1 会话迁移只放行 `instructions` / `catalog` / `snapshot` / `notice` / `relay` / `recall` 六个 form，自造值会让整份历史会话读不出来。旧日志修复脚本在 `不入库文件\kaz-form-fix-20260911\fix-session-form.mjs`。
  - 主环境运行时锚点回到**全局 dsh**（`dsh启动.bat` 调用 `%APPDATA%\npm\dsh.cmd` 并按 `EXPECTED_CLI` 门禁）。
- **7.6.1 之后 · 单版本收窄（2026-09-11 晚）**：三台 home 的运行时回到真实口径（`.dsh` 全局 `0.1.5-rc.2`；`.dsh-test` 本地副本 `0.1.5-rc.2`；`.dsh-clean` 固定 `0.1.1-rc.2` 按设计 `FAIL`）；`$SupportedVersions` 收窄为 `@('0.1.5-rc.2')`，两份指引的 `$supportedDsh` 同步收窄——**rc.1 不再受支持**（回退路径见本节末尾）。
- **版本号在哪看**：预设形态没有旧形态那种「面板本地版本」——那个读 `KazPlugins/kaz-mode/package.json` 的 `version` 并与 GitHub tag 比较的机制随面板退役。现在有两处，彼此独立：① 预设自己的 `kaz/VERSION`（一行 `8.0.0`，随镜像进 `<home>\.agent-presets\kaz\VERSION`）是**手工维护的发布版本号**，发版时改这一行；② 仓库的 **git tag / 提交**仍是可追溯的代码身份。改预设请改 `kaz/`（发布源）；测试区的开发副本在 `test-kaz/`。
- 支持版本**硬编码在 `install-kaz-preset.ps1` 的 `$SupportedVersions`**（当前 `@('0.1.5-rc.2')`）。升级适配 dsh 版本时按这份清单同步，别只改数组：
  1. `install-kaz-preset.ps1` 的 `$SupportedVersions`（**`Get-RuntimeVersion` 的候选顺序不要动**：它决定 `.dsh-clean` 读到自己的 `0.1.1-rc.2` 副本、按预期 `FAIL`）；
  2. 同一文件头部注释里的 supported 列表；
  3. `README.md`：§2.1 矩阵与闸门顺序说明、§五迁移步骤、§七 FAQ、§8.1 与本节；
  4. `ds安装指引.md` / `ds更新指引.md`：**第 0 步的 `$supportedDsh` 数组**、第 0 步给用户的 `VERSION GATE: FAIL` 说明原文、附录 A 的升级目标，以及两份「出错速查表」里的版本说法。
- **回退到 `0.1.5-rc.1` 的路径（可行，但不是受支持状态）**：① 把运行时换回 `0.1.5-rc.1`（主环境：全局 `npm install -g @deepseek-ai/dsh@0.1.5-rc.1`，并把 `dsh启动.bat` 的 `EXPECTED_CLI` 改回 `0.1.5-rc.1`；`.dsh-test` / `.dsh-clean`：换 `tools\dsh-cli` 的本地副本并同步启动器）；② 安装 / 更新时显式加 `-SkipVersionCheck`。**执行者不得自行决定回退**。
- 发布前建议跑一次 `powershell -ExecutionPolicy Bypass -File .\install-kaz-preset.ps1 -AllHomes -DryRun`，确认各 home 的闸门与 profile 解析结果符合预期（**记得 `-DryRun` 的 OK 只是预演**）。

### 8.3 维护者：把测试区的成果推广到主区

开发在测试区做（`test-kaz/` → `.dsh-test\.agent-presets\kaz`），验证通过后推广到主区（`.dsh\.agent-presets\kaz`）。推广＝**显式指定源为测试区副本**：

```powershell
powershell -ExecutionPolicy Bypass -File .\install-kaz-preset.ps1 -Source "$PWD\test-kaz" -DshHome "$env:USERPROFILE\.dsh"
```

- 推广后**重启主区 dsh** 才会加载；主区里跑着的会话仍用启动时加载的那份代码。
- 推广完把改动提交：`kaz/`、`test-kaz/` 都是 junction，提交即对两份 live 目录做快照（回退也靠它）。
- 本机对主区跑**默认**安装（源 = `kaz/`、目标 = 主区 `.dsh`）会打印 `source and target are the same directory; skip file copy`——源和目标本来就是同一个目录，正常，它只重建 junction。
- 反过来**不要**对测试区跑默认安装：那会把发布源盖到测试区、冲掉开发副本（见 §2.3）。

---

*本文件由 Kaz 模式维护；安装 / 更新请始终以 `ds安装指引.md` / `ds更新指引.md` 与仓库根 `install-kaz-preset.ps1` 为准。*
