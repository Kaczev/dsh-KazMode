# Kaz 模式 · 更新指引（给 DeepSeek）

> **你的角色**：更新执行者。只按本文件步骤执行，不要做多余的事。
>
> **硬性规则（先读一遍，全程遵守）**：
> 1. 不要阅读 `README.md`，不要浏览仓库其它目录（`其它好用的工具`、`其它好用的预设`、`简易测式` 等一律不看），不要搜索网络。
> 2. 不要创建任何 `.ps1` / `.bat` 脚本文件。**运行仓库里已自带的 `install-kaz-preset.ps1` 是允许且必需的**——"不要创建脚本"不等于"不要运行脚本"；除本文件明确给出的命令外，不要新增任何脚本。
> 3. 本文件内容完整，每一步都给全了命令或文件内容，**不需要参考任何其它文件核对**。
> 4. 每一步做完再进下一步。命令报错就看该步的「出错处理」，不要自行研究；遇到本文件未覆盖的错误，原样报告给用户，不要自作主张。
> 5. 全程不要向用户提问，除非出现本文件未覆盖的错误。
> 6. 目标机器是 Windows + PowerShell。
>
> **版本要求**：Kaz 预设形态**只支持 dsh `0.1.5-rc.2`**（第 0 步硬校验；不符合就停）。主环境 `.dsh` 的运行时是全局 `0.1.5-rc.2`，测试环境 `.dsh-test` 是它自己的本地副本 `0.1.5-rc.2`，救援环境 `.dsh-clean` 固定 `0.1.1-rc.2`（按设计过不了闸门）。
> **旧插件形态用户**（dsh `0.1.1-rc.2`，还装着 `KazPlugins` + `cordis.patch.yml` 插件的）：先看 `ds安装指引.md` 的**附录 A** 做迁移清理，升级 dsh 后再按本文件更新。

---

## 第 0 步 版本闸门（硬性，必须先通过）

> Kaz 预设形态**只支持 dsh `0.1.5-rc.2`**。
> 版本号取自**运行时包** `@deepseek-ai/dsh/package.json` 的 `version` 字段（与安装程序同一口径），**不要**用 `dsh --version` 判断。
> 第 3 步的安装程序会按目标 home 再校验一次，那才是最终权威；这里先拦下明显不匹配的机器。

```powershell
$supportedDsh = @("0.1.5-rc.2")
$candidates = @(
  (Join-Path $env:USERPROFILE ".dsh\tools\dsh-cli\node_modules\@deepseek-ai\dsh\package.json"),
  (Join-Path $env:USERPROFILE ".dsh\profiles\web\node_modules\@deepseek-ai\dsh\package.json"),
  (Join-Path $env:APPDATA "npm\node_modules\@deepseek-ai\dsh\package.json")
)
$dshVer = ""
foreach ($c in $candidates) {
  if (Test-Path $c) {
    try {
      $v = (Get-Content $c -Raw | ConvertFrom-Json).version
      if (-not [string]::IsNullOrWhiteSpace($v)) { $dshVer = $v; break }
    } catch { }
  }
}
if ($supportedDsh -notcontains $dshVer) {
  Write-Host ("VERSION GATE: FAIL - runtime dsh '" + $dshVer + "' is not supported (supported: " + ($supportedDsh -join ', ') + "). Use -SkipVersionCheck to override.")
} else {
  Write-Host "VERSION GATE: PASS - dsh $dshVer"
}
```

- 输出 `VERSION GATE: PASS` → 继续第 1 步。
- 输出 `VERSION GATE: FAIL` → **立即停止**：不要执行本文件任何后续步骤。把下面这段话原样告诉用户：

> 本版 Kaz 是 DSH agent preset（预设形态），**只支持 dsh `0.1.5-rc.2`**，检测到本机运行时版本不在支持列表内。请先把 dsh 升级到 `0.1.5-rc.2` 再更新；旧插件形态请先按 `ds安装指引.md` 附录 A 迁移。若用户明确要求把运行时**回退到 `0.1.5-rc.1`**：安装 / 更新必须显式加 `-SkipVersionCheck`，并且要把该 home 启动器的 `EXPECTED_CLI` 一起改回 `0.1.5-rc.1`，否则启动器开屏就拒绝启动——回退不是受支持状态，只能由用户决定。

> **三台 home 的闸门读到的都是自己的真实版本（已无「残留副本遮蔽」现象）**：第 0 步 / 第 3 步的候选顺序先读 `<home>\tools\dsh-cli\...`，再读 `<home>\profiles\<profile>\node_modules\@deepseek-ai\dsh\...`，最后读全局 `%APPDATA%\npm`，取第一个存在者即停。主环境 `.dsh` 前两个候选都不存在（那份 rc.1 残留副本已删除），读到**全局 `0.1.5-rc.2`**；`.dsh-test` 读到自己的本地副本 `0.1.5-rc.2`；`.dsh-clean` 读到自己保留的 `0.1.1-rc.2`，按预期 `FAIL`。**看打印出来的路径判断闸门读的是哪一份**。

> 若你要更新的是非默认 home，第 0 步仍按默认 `%USERPROFILE%\.dsh` 预检；目标 home 的真实闸门由第 3 步的安装程序执行。

## 第 1 步 获取仓库最新版

```powershell
$repo = "本文件所在目录"   # 例如 C:\Users\xxx\Documents\GitHub\dsh-KazMode
Test-Path (Join-Path $repo "install-kaz-preset.ps1")
Set-Location $repo
git pull
```

- `Test-Path` 为 `False` → **停止**，告诉用户："仓库不完整：缺少 `install-kaz-preset.ps1`，请重新获取完整仓库。"
- `git pull` 成功（或输出 `Already up to date.`）→ 继续第 2 步。
- `git pull` 报网络错误 / 冲突 → **停止**，把报错原文报告给用户，不要自行 `git reset` / `git checkout -f` / `git clean`。
- 若你的仓库是从 zip/tar 解压来的（目录里没有 `.git`）→ 跳过 `git pull`，重新下载最新包并覆盖仓库目录即可，然后继续第 2 步。

> **禁令（重要）**：**绝不**在仓库里运行 `git clean -fdx` 或 `git checkout -f`。本仓库的 `test-kaz\` 是仓库 ↔ live 预设目录之间的 junction，这类命令会**顺着 junction 把 live 预设写坏**。仓库脏了用 `git status` / `git diff` 看，只手动改需要改的那几个文件。

## 第 2 步 预演（`-DryRun`，先看清要改什么）

```powershell
powershell -ExecutionPolicy Bypass -File "$repo\install-kaz-preset.ps1" -DryRun
```

- 预演会：按默认 home 解析 profile → 校验版本闸门 → 打印将要执行的镜像与 junction 计划（`would refresh link` / `would link`）。
- **注意**：脚本在 `-DryRun` 下**仍会打印 `KAZ-PRESET-INSTALL OK`**——那只是预演，**不代表已经写入**。不要据此认为更新完成。
- 要预演别的 home / 多个 home / 指定 profile：

```powershell
powershell -ExecutionPolicy Bypass -File "$repo\install-kaz-preset.ps1" -DshHome "$env:USERPROFILE\.dsh-test" -DryRun
powershell -ExecutionPolicy Bypass -File "$repo\install-kaz-preset.ps1" -AllHomes -DryRun
powershell -ExecutionPolicy Bypass -File "$repo\install-kaz-preset.ps1" -DshHome "$env:USERPROFILE\.dsh-test" -ProfileName web -DryRun
```

- 预演就报 `VERSION GATE: FAIL` → 该 home 的运行时 dsh 不是 `0.1.5-rc.2`：**停止**，按第 0 步的说明转告用户；**不要**自行用 `-SkipVersionCheck` 绕过（唯一例外：用户明确要求回退到 `0.1.5-rc.1`，那时按第 0 步的说明加它）。
- 预演报 `multiple profiles under ...; pass -ProfileName` → 在命令里加 `-ProfileName web`（或该 home 里真正有 `node_modules` 的那个 profile 名）。

## 第 3 步 正式重跑安装程序

```powershell
powershell -ExecutionPolicy Bypass -File "$repo\install-kaz-preset.ps1"
```

更新就是**重跑同一个安装程序**，它会自动：

1. 把现有预设备份到 `<home>\tools\kaz-preset-backup-<时间戳>`（排除 `node_modules`）；
2. 用 `robocopy /MIR` 把仓库 `test-kaz\` **镜像**到 `<home>\.agent-presets\kaz`（排除 `node_modules`）；
3. **原地重建**预设 `node_modules` 下的两个 junction：`zod`（可选）→ `<home>\profiles\<profile>\node_modules`；`@deepseek-ai`（必需）→ **同 home 的共享层** `<home>\profiles\node_modules\@deepseek-ai`（仅当该层没有运行时包时才回退 profile 那一层）。先 `rmdir` 旧链接再新建，幂等；
4. 打印 `KAZ-PRESET-INSTALL OK - <home> (<profile>)`。

- **不需要** `npm install`：预设只用那两个 junction 解析运行时；`<home>\profiles\<profile>\node_modules` 里的其它内容不会被改。
- **更新后的两项核对**：`Get-Content "<home>\.agent-presets\kaz\VERSION"` 应打印 `8.0.0`；`(Get-Item "<home>\.agent-presets\kaz\node_modules\@deepseek-ai").Target` 应指向 `<home>\profiles\node_modules\@deepseek-ai`（不是 profile 那一层）。后者指错会让新对话里的预设**挂不起来**——那不是可以忽略的警告，重跑当前仓库的安装程序即可。
- 更新别的 home / 多个 home（去掉 `-DryRun` 即可）：

```powershell
powershell -ExecutionPolicy Bypass -File "$repo\install-kaz-preset.ps1" -DshHome "$env:USERPROFILE\.dsh-test" -ProfileName web
powershell -ExecutionPolicy Bypass -File "$repo\install-kaz-preset.ps1" -AllHomes
```

- `-AllHomes` 会扫描 `%USERPROFILE%\.dsh*` 中含 `profiles` 的 home，逐 home 安装并打印 `--- summary ---` 与逐行 `OK` / `FAIL`。**预期**：`.dsh`（主环境，闸门读到全局 `0.1.5-rc.2`）与 `.dsh-test`（本地副本 `0.1.5-rc.2`）报 `OK`；`.dsh-clean`（救援环境，仍是 dsh `0.1.1-rc.2`）报 `FAIL` 属预期——它保留旧运行时当最后防线。
- 若某个 home 的 `.agent-presets\kaz` 本身就是仓库 `test-kaz` 的 junction 目标，安装程序会打印 `source and target are the same directory; skip file copy`，只重建 junction——正常分支。

**出错处理**：
- `cannot replace real directory` / `cannot replace non-empty real directory` → `node_modules\@deepseek-ai`（或 `zod`）是真实目录而不是 junction：先备份，再删除该目录，然后重跑本步。
- `required runtime package missing: ...\node_modules\@deepseek-ai` → 该 profile 的运行时 `@deepseek-ai` 不存在：先修好该 home 的 dsh 运行时，再重跑本步。
- `robocopy failed (N)`（`N > 7` 才是错误）/ 目标被占用 / `EPERM` → 让用户关闭正在运行的 `dsh web`，重跑本步；不要管理员强改 ACL，不要强杀进程。
- `WARN: optional runtime package missing: ...\zod` → 可选 junction 缺失，更新会继续；若运行报 zod 解析失败再补装。

## 第 4 步 交给用户收尾（重要）

预设改动**必须重启 dsh 才会加载**；而重启会中断你当前这个会话，所以由**用户手动操作**。请把下面的话原样告诉用户：

> 更新的文件部分已完成。请手动：
> 1. 重启 `dsh web`；
> 2. 强刷浏览器页面（Ctrl+F5 或 Cmd+Shift+R）；
> 3. 在**新对话**的预设选择器里选择 **Kaz 模式**（preset id `kaz`）。

## 第 5 步 自查（用户重启后，让用户按现象回报）

> Kaz 8.0 是**主代理的工作流预设**：没有面板、没有插件开关、没有提示音。下面现象对不上，就说明没更新到位或没选预设。

- 新对话已选中 **Kaz 模式**（`kaz`）。
- **persona 首句**：`We are the user's point of contact and the work's arranger: hear clearly what is wanted, arrange who does it, and answer for the result.`；用 "We" 思考（ALWAYS REASON AS 'WE'），模型输出全英文。
- **主代理工具面**（与官方标准预设对齐；完整清单以 `test-kaz/agent.cordis.yml` 与 `kaz-shared` 的黑名单为准）：
  - 基础：`pwsh` / `read` / `read_image` / `write` / `edit` / `glob` / `grep` / `todo_write` / `ask_user_question` / `web_search` / `web_fetch` / `present` / `skill` / `job_list` / `job_output` / `job_kill`
  - 记忆只读三件：`memory_search` / `memory_detail` / `memory_list`
  - 上下文三件：`context_search` / `context_read` / `context_compress`
  - 工作流四件：`write-arrangement` / `get-arrangement` / `ka_sub_whale` / `whale_report`
  - 子代理控制三件：`list_agents` / `send_message` / `interrupt_agent`
- **主代理看不到记忆写三件**（`memory_save` / `memory_update` / `memory_forget`）——这是设计（写记忆交给记忆管家）；**也看不到** `bash`、`get_goal` / `create_goal` / `update_goal`、官方 `subagent` / `subagent_fork`、`plan_mode`、`workflow`、`ralph`（刻意不挂，不是故障）。
- **注入**：用户每发一条消息会看到 `[ka-whale-workflow idle]` 阶段注入（上下文注入，不是系统提示段）；上下文占用 ≥50% 时会出现 `[ka-context-policy compression-hint]` 提醒。
- **数据落盘**：记忆在 `<home>\storages\ka-whale-memory\{context,paths}\`（全局）与 `<项目>\.dsh\storages\ka-whale-memory\{context,paths}\`（项目），一个记忆一个 JSON；安排在 `<项目>\.dsh\storages\arrangements\<sessionId>.json`。
- **没有** Kaz 面板、没有开关行、没有提示音、没有 round-display 轮次显示。

## 旧版用户迁移（旧插件形态 → 预设形态）

若本机还停留在旧插件形态（dsh `0.1.1-rc.2`，装着 `KazPlugins` 与 `cordis.patch.yml` 里的 Kaz insert 块）：本文件的更新流程**不适用**。请改用 `ds安装指引.md` 的**附录 A**：

- 删 `<profile>\KazPlugins`、清掉指向旧插件的 junction；
- 清 `package.json` 里 `file:KazPlugins/...` 依赖行（保留 `file:KazPrivatePlugins/...` 私有行）；
- 清 `cordis.patch.yml` 里 8 个 Kaz insert 块（保留 `kaz-skill-*` 私有块）；
- 把 dsh 升级到 `0.1.5-rc.2`（当前唯一受支持版本），重启后再按本文件走第 0–5 步。

7.5.0 之前的旧更新步骤不再保留；需要时查 7.5.0 之前的 git 历史。

---

## 附：出错速查表

| 现象 | 处理 |
| --- | --- |
| 第 0 步 / 预演 / 正式运行报 `VERSION GATE: FAIL` | 目标 home 的运行时不是 `0.1.5-rc.2`：**停止**，按第 0 步的说明转告用户；旧形态先走 `ds安装指引.md` 附录 A。**不要**自行用 `-SkipVersionCheck`；唯一例外是用户明确要求回退到 `0.1.5-rc.1`（那时按第 0 步的说明加它，并提醒用户同步启动器的 `EXPECTED_CLI`） |
| `-AllHomes` 里某个 home 报 `FAIL` | 该 home 的运行时 dsh 不是 `0.1.5-rc.2`：主环境 `.dsh`（全局 `0.1.5-rc.2`）与测试环境 `.dsh-test`（本地副本 `0.1.5-rc.2`）应 `OK`；`.dsh-clean`（`0.1.1-rc.2` 救援环境）报 `FAIL` 属设计如此。**不要**自行用 `-SkipVersionCheck`（唯一例外：用户明确要求回退到 `0.1.5-rc.1`，见第 0 步） |
| `multiple profiles under ...; pass -ProfileName` | 该 home 有多个 profile：加 `-ProfileName web` |
| `no profiles directory under ...` | 该 home 没有可用的 profile（没装好 dsh 运行时）：不要继续 |
| `required runtime package missing: ...\@deepseek-ai` | 该 profile 的 `node_modules\@deepseek-ai` 不存在：先修好 dsh 运行时再重跑 |
| `cannot replace non-empty real directory` | `node_modules\@deepseek-ai`（或 `zod`）是真实目录不是 junction：备份后删除该目录再重跑 |
| `WARN: optional runtime package missing: ...\zod` | 可选 junction 缺失，更新继续；若运行报 zod 解析失败再补装 |
| robocopy 报错（退出码 > 7）/ 目标目录多出的文件被删 | `/MIR` 是镜像语义：会删掉 `.agent-presets\kaz` 里多出的文件（`node_modules` 除外）；每次更新前的备份在 `tools\kaz-preset-backup-*`（会累积，可手动清理）；**不要**往预设目录放自定义文件 |
| junction 建不上 / 权限不足 / `EPERM` | 让用户关闭 `dsh web` 后重跑；用普通权限即可，不要管理员强改 ACL，不要强杀进程 |
| 看到 `KAZ-PRESET-INSTALL OK` 但好像没生效 | 若那次带了 `-DryRun`，OK 只是预演；去掉 `-DryRun` 重跑一次 |
| 仓库里有奇怪的改动 / 想"清干净" | **绝不**运行 `git clean -fdx` 或 `git checkout -f`：`test-kaz` 是仓库 ↔ live 的 junction，会顺着写坏 live 预设；用 `git status` / `git diff` 查看，只手动改需要的文件 |
| 更新后还想要旧插件形态的行为 | 预设形态**不含**面板 / 开关 / 提示音 / 轮次显示，这是设计如此；要回旧形态请用 7.5.0 之前的 git 历史 |
| 报 `ReplaceFileW EIO (Win32 1175)` | Windows 偶发文件系统错误，重试同一条命令/编辑一次 |
| 写 JSON/YAML 报 BOM 解析错误 | 用 UTF-8 无 BOM 保存 |
| 遇到本表未覆盖的错误 | 原样把错误文本报告给用户，不要自行研究 |
