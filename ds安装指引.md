# Kaz 模式 · 安装指引（给 DeepSeek）

> **你的角色**：安装执行者。只按本文件步骤执行，不要做多余的事。
>
> **硬性规则（先读一遍，全程遵守）**：
> 1. 不要阅读 `README.md`，不要浏览仓库其它目录（`其它好用的工具`、`其它好用的预设`、`简易测式` 等一律不看），不要搜索网络。
> 2. 不要创建任何 `.ps1` / `.bat` 脚本文件。**运行仓库里已自带的 `install-kaz-preset.ps1` 是允许且必需的**——"不要创建脚本"不等于"不要运行脚本"；除本文件明确给出的命令外，不要新增任何脚本。
> 3. 本文件内容完整，每一步都给全了命令或文件内容，**不需要参考任何其它文件核对**。
> 4. 每一步做完再进下一步。命令报错就看该步的「出错处理」，不要自行研究；遇到本文件未覆盖的错误，原样报告给用户，不要自作主张。
> 5. 全程不要向用户提问，除非出现本文件未覆盖的错误。
> 6. 目标机器是 Windows + PowerShell。
>
> **版本要求**：Kaz 预设形态仅支持 dsh `0.1.5-rc.1`（第 0 步硬校验；不符合就停）。旧插件形态（dsh `0.1.1-rc.2`）见 **附录 A**。

---

## 第 0 步 版本闸门（硬性，必须先通过）

> 本版 Kaz 是 **DSH agent preset（预设形态）**，只支持 dsh `0.1.5-rc.1`。
> 版本号取自**运行时包** `@deepseek-ai/dsh/package.json` 的 `version` 字段（与安装程序同一口径），**不要**用 `dsh --version` 判断。
> 第 2 步的安装程序会按目标 home 再校验一次，那才是最终权威；这里先拦下明显不匹配的机器。

```powershell
$supportedDsh = @("0.1.5-rc.1")
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
- 输出 `VERSION GATE: FAIL` → **立即停止**：不要执行本文件任何后续步骤，不要复制或修改任何文件。把下面这段话原样告诉用户：

> 本版 Kaz 是 DSH agent preset（预设形态），仅支持 dsh `0.1.5-rc.1`，检测到本机运行时版本不在支持列表内。请先把 dsh 升级或恢复到 `0.1.5-rc.1` 再安装。若你还在用旧插件形态（dsh `0.1.1-rc.2`），先按本文件「附录 A」清理旧形态，升级 dsh 后再回到第 0 步。

> 若你要安装到非默认 home（`-DshHome`），第 0 步仍按默认 `%USERPROFILE%\.dsh` 预检；目标 home 的真实闸门由第 2 步的安装程序执行。

## 第 1 步 确认仓库路径

```powershell
$repo = "本文件所在目录"   # 例如 C:\Users\xxx\Documents\GitHub\dsh-KazMode
Test-Path (Join-Path $repo "install-kaz-preset.ps1")
Test-Path (Join-Path $repo "test-kaz\preset.yml")
```

- 两条都返回 `True` → 继续第 2 步。
- 任一为 `False` → **停止**，告诉用户："仓库不完整：缺少 `install-kaz-preset.ps1` 或 `test-kaz\preset.yml`，请重新获取完整仓库。"

## 第 2 步 运行安装程序

安装程序 `install-kaz-preset.ps1` 会依次做：按目标 home 校验版本闸门 → 备份已有预设到 `<home>\tools\kaz-preset-backup-<时间戳>`（排除 `node_modules`）→ 用 `robocopy /MIR` 把仓库 `test-kaz\` 镜像到 `<home>\.agent-presets\kaz`（排除 `node_modules`）→ 幂等重建预设 `node_modules` 下的两个 junction（`@deepseek-ai`、`zod` → `<home>\profiles\<profile>\node_modules`）→ 打印 `KAZ-PRESET-INSTALL OK`。

**2.1 单 home（最常见：装到默认 `%USERPROFILE%\.dsh`）**

```powershell
powershell -ExecutionPolicy Bypass -File "$repo\install-kaz-preset.ps1"
```

- profile 自动探测：该 home 下**唯一**含 `node_modules` 的 profile 会自动选中；有多个时报错 `multiple profiles under ...; pass -ProfileName`，这时加 `-ProfileName`，见 2.2。

**2.2 指定 home 或 profile**

```powershell
powershell -ExecutionPolicy Bypass -File "$repo\install-kaz-preset.ps1" -DshHome "$env:USERPROFILE\.dsh-test" -ProfileName web
```

**2.3 预演（`-DryRun`，不写入）**

```powershell
powershell -ExecutionPolicy Bypass -File "$repo\install-kaz-preset.ps1" -DshHome "$env:USERPROFILE\.dsh-test" -DryRun
```

- `-DryRun` 只校验闸门 / profile / 源路径，并打印"会做什么"（`would refresh link` / `would link`），**不备份、不复制、不建 junction**。
- **注意**：脚本在 `-DryRun` 下**仍会打印 `KAZ-PRESET-INSTALL OK`**——那只是预演，**不代表已经写入**。判断是否真的安装成功，必须看一次**不带** `-DryRun` 的运行。

**2.4 多 home 一次装完（`-AllHomes`）**

```powershell
powershell -ExecutionPolicy Bypass -File "$repo\install-kaz-preset.ps1" -AllHomes
```

- 扫描 `%USERPROFILE%\.dsh*` 中**含 `profiles` 目录**的 home，逐个安装，最后打印 `--- summary ---` 与逐行 `OK` / `FAIL` 汇总。
- **预期结果**（本机示例）：
  - 预期 `.dsh`（主环境）与 `.dsh-test` 报 `OK`；`.dsh-clean`（救援环境，仍是 dsh `0.1.1-rc.2`）报 `FAIL` 属预期——它保留旧运行时当最后防线。
  - `.dsh-clean`、`.dsh-test`（dsh `0.1.5-rc.1`）→ 应 `OK`。
- 想让某个 home 跳过版本闸门（**仅调试，不要用**）：`-SkipVersionCheck`。指引要求你**不要**使用它。

**2.5 指定预设源（`-Source`，一般不需要）**

```powershell
powershell -ExecutionPolicy Bypass -File "$repo\install-kaz-preset.ps1" -Source "D:\下载\dsh-KazMode\test-kaz"
```

- 默认 `-Source` 就是脚本旁边的 `test-kaz`，正常安装**不要**传这个参数。

**成功标志**：输出 `KAZ-PRESET-INSTALL OK - <home> (<profile>)`，并打印 `linked: ...` 两行 junction。

**出错处理**：
- 报 `VERSION GATE: FAIL` → 该 home 的 dsh 不是 `0.1.5-rc.1`：**停下**，按第 0 步的说明转告用户；不要用 `-SkipVersionCheck` 绕过。
- 报 `multiple profiles under ...; pass -ProfileName` → 在命令里加 `-ProfileName web`（或该 home 里真正有 `node_modules` 的那个 profile 名）。
- 报 `no profiles directory under ...` → 该 home 没有 `profiles` 目录，或 profile 里还没有 `node_modules`：这个 home 还没装好 dsh 运行时，**不要**继续装预设。
- 报 `required runtime package missing: ...\node_modules\@deepseek-ai` → profile 的 `node_modules\@deepseek-ai` 不存在；先修好该 home 的 dsh 运行时（官方安装/修复），再重跑安装程序。
- 报 `cannot replace non-empty real directory: ...\node_modules\@deepseek-ai`（或 `zod`）→ 该位置是**真实目录**而不是 junction：先备份它，再删除该目录，然后重跑安装程序。
- 报 `preset robocopy failed (N)` / `backup robocopy failed (N)`（`N > 7` 才是错误）→ 目标目录被占用：让用户关闭正在运行的 dsh web，重跑同一条命令。
- 报权限 / `EPERM` / 文件占用 → 让用户关闭 dsh web 后重试；**不要**用管理员权限强改 ACL，也不要强行杀进程。
- 报 `WARN: optional runtime package missing: ...\node_modules\zod` → `zod` 是可选 junction，安装会继续；若之后运行报 `zod` 解析失败，再回该 profile 补装 `zod`。

> 补充：若某个 home 的 `.agent-presets\kaz` **本身就是**仓库 `test-kaz` 的 junction 目标，安装程序会打印 `source and target are the same directory; skip file copy`，只重建 junction——这是正常分支，无需处理。

## 第 3 步 交给用户收尾（重要）

预设改动**必须重启 dsh 才会加载**；而重启会中断你当前这个会话，所以由**用户手动操作**。请把下面的话原样告诉用户：

> 安装的文件部分已完成。请手动：
> 1. 重启 `dsh web`；
> 2. 强刷浏览器页面（Ctrl+F5 或 Cmd+Shift+R）；
> 3. 在**新对话**的预设选择器里选择 **Kaz 模式**（preset id `kaz`）。

## 第 4 步 自查（用户重启后，让用户按现象回报）

> 预设形态**没有面板、没有插件开关、没有提示音**；下面现象对不上就说明没装好或没选预设。

- 新对话已选中 **Kaz 模式**（`kaz`）。
- **工具面**：首轮即完整（不再是"首轮极简 → 再恢复"两阶段）。稳定主工具面是 kaz-shared 的 `KAZ_V09_MAIN_TOOLS`，共 **21 项**：
  `ask_user_question` / `edit` / `glob` / `grep` / `memory_detail` / `memory_list` / `memory_search` / `pwsh` / `read` / `context_read` / `context_search` / `context_compress` / `ka_sub_whale` / `list_agents` / `send_message` / `interrupt_agent` / `todo_write` / `web_search` / `whale_report` / `plan_read` / `write`。
- **记忆六工具**由 `ka-whale-memory` 提供：`memory_save` / `memory_update` / `memory_list` / `memory_search` / `memory_detail` / `memory_forget`（其中 `memory_search` / `memory_detail` / `memory_list` 在主面 21 项内）。
- **上下文三件**：`context_search` / `context_read` / `context_compress` 均可用。
- **没有** Kaz 面板、没有开关行、没有提示音、没有 round-display 轮次显示。
- **persona 首句**是 `We are the main agent of the ka-whale-workflow.`；思考/输出用 "We" / "Let's"，不再是 "Let me"。

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File "$repo\install-kaz-preset.ps1" -Uninstall
```

指定 home：

```powershell
powershell -ExecutionPolicy Bypass -File "$repo\install-kaz-preset.ps1" -DshHome "$env:USERPROFILE\.dsh-test" -Uninstall
```

- 只删除 `<home>\.agent-presets\kaz` 这一个目录；**不碰** `<home>\profiles\<profile>\node_modules`（那两个 junction 指过去的目标保留）。
- **不还原**备份；备份留在 `<home>\tools\kaz-preset-backup-<时间戳>`，需要时手动取用，确认不需要后可手动删除（多次安装会累积）。
- 成功输出：`KAZ-PRESET-UNINSTALL OK - <home>`。

---

## 附录 A：旧插件形态（dsh 0.1.1-rc.2）迁移与清理

> 本附录只做**清理**，**不负责升级 dsh**。旧插件形态（≤ 7.4.x，dsh `0.1.1-rc.2`）与预设形态互斥；迁移顺序是：**先清理 → 再把 dsh 升级到 `0.1.5-rc.1` → 重启 → 回到第 0 步安装预设**。
> 7.5.0 之前的旧步骤全文不在此保留；需要时查 7.5.0 之前的 git 历史（GitHub 上对应 tag / 旧提交里的 `ds安装指引.md`、`ds更新指引.md`）。

在目标 home（下面以默认 `%USERPROFILE%\.dsh`、profile `web` 为例）里：

```powershell
$dshHome = Join-Path $env:USERPROFILE ".dsh"
$profileDir = Join-Path $dshHome "profiles\web"
```

1. **停止**：让用户关闭正在运行的 `dsh web`。
2. **删除旧插件目录**：

```powershell
Remove-Item (Join-Path $profileDir "KazPlugins") -Recurse -Force
```

3. **删除指向旧插件的 junction**（`rmdir` 只删链接本身，不删目标）：

```powershell
$mods = Join-Path $profileDir "node_modules"
foreach ($n in "kaz-mode","ka-whale-memory","ka-whale-workflow","kaz-shared","kaz-context-policy","plugin-filter","output-beep","round-display","deepseek-default-model","kaz-agent-preset-display") {
  cmd /c rmdir "$(Join-Path $mods $n)" 2>$null | Out-Null
}
```

4. **清理 `package.json` 依赖行**：打开 `profiles\web\package.json`，删除所有 `"<名字>": "file:KazPlugins/..."` 形式的依赖行。
   - **保留**以 `file:KazPrivatePlugins/...` 开头的用户私有依赖行（如 `"kaz-skill-safe-json": "file:KazPrivatePlugins/kaz-skill-safe-json"`），它们不是公共 Kaz 组件。
   - **保留**其它第三方依赖（`dsh-plugin-marketplace`、`dsh-deepseek-balance`、`dsh-portable-tavern` 等）。
   - 用 UTF-8 **无 BOM** 保存；若必须用 PowerShell 写，用下面写法（不要用 `Set-Content -Encoding UTF8`，它会写 BOM 破坏 JSON 解析）：

```powershell
[System.IO.File]::WriteAllText((Join-Path $profileDir "package.json"), $jsonText, (New-Object System.Text.UTF8Encoding $false))
```

5. **清理 `cordis.patch.yml`**：打开 `profiles\web\cordis.patch.yml`，删除以下 **8 个 Kaz insert 块**（按块内 `id` 判断）：

   `memory`（ka-whale-memory）/ `plugin-filter` / `kaz-agent-preset-display` / `kaz-mode` / `output-beep` / `round-display` / `deepseek-default-model` / `ka-whale-workflow`

   - 非 Kaz 的自定义块保留；特别是 `kaz-skill-*` 私有块（如 `kaz-skill-safe-json`）**不是** Kaz 框架块，**保留原样**。
   - 若还有 `id: kaz-context-policy` 的 insert 块，也删掉（预设形态由 `agent.cordis.yml` 的 compaction 组按名挂载，不走 `cordis.patch.yml`）。
   - YAML 用 UTF-8 无 BOM 保存。

6. **（可选）清理旧存储残留**：

```powershell
Remove-Item (Join-Path $dshHome "storages\kaz-session-states.json") -Force -ErrorAction SilentlyContinue
```

7. **把 dsh 升级到 `0.1.5-rc.1`**，重启 `dsh web`，然后从本文件**第 0 步**开始安装预设。

---

## 附：出错速查表

| 现象 | 处理 |
| --- | --- |
| 第 0 步 `VERSION GATE: FAIL` | runtime dsh 不是 `0.1.5-rc.1`：**停止**，把第 0 步给用户的说明原样转达；旧形态先走附录 A |
| 第 2 步又报 `VERSION GATE: FAIL` | 目标 home 的运行时不受支持（如 `.dsh` 是 `0.1.1-rc.2`）：属预期，改用支持 `0.1.5-rc.1` 的 home；**不要**用 `-SkipVersionCheck` |
| `-AllHomes` 里某个 home 报 `FAIL` | 该 home 的运行时 dsh 不是 `0.1.5-rc.1`：主环境 `.dsh` 与 `.dsh-test` 应 `OK`；`.dsh-clean`（0.1.1-rc.2 救援环境）报 `FAIL` 属预期。**不要**用 `-SkipVersionCheck` |
| `multiple profiles under ...; pass -ProfileName` | 该 home 有多个 profile：命令里加 `-ProfileName web` |
| `no profiles directory under ...` | 该 home 没有可用的 profile（没装好 dsh 运行时）：不要继续装 |
| `required runtime package missing: ...\@deepseek-ai` | 该 profile 的 `node_modules\@deepseek-ai` 不存在：先修好 dsh 运行时再重跑 |
| `cannot replace non-empty real directory` | `node_modules\@deepseek-ai`（或 `zod`）是真实目录不是 junction：备份后删除该目录再重跑 |
| `WARN: optional runtime package missing: ...\zod` | 可选 junction 缺失，安装继续；若运行报 zod 解析失败再补装 |
| robocopy 报错（退出码 > 7）/ 目标目录多出的文件被删 | `/MIR` 是镜像语义：会删掉 `.agent-presets\kaz` 里多出的文件（`node_modules` 除外）；备份在 `tools\kaz-preset-backup-*`，不要往预设目录放自定义文件 |
| 目标目录被占用 / `EPERM` | 让用户关闭 `dsh web` 后重跑；不要管理员强改 ACL，不要强杀进程 |
| 看到 `KAZ-PRESET-INSTALL OK` 但好像没生效 | 若那次带了 `-DryRun`，OK 只是预演；去掉 `-DryRun` 重跑一次 |
| 卸载后还想回到旧插件形态 | `-Uninstall` 只删预设目录；旧形态请用 7.5.0 之前的 git 历史按旧指引重装 |
| 报 `ReplaceFileW EIO (Win32 1175)` | Windows 偶发文件系统错误，重试同一条命令/编辑一次 |
| 写 JSON/YAML 报 BOM 解析错误 | 用 UTF-8 无 BOM 保存（见附录 A 第 4 步的写法） |
| 遇到本表未覆盖的错误 | 原样把错误文本报告给用户，不要自行研究 |
