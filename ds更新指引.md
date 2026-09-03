# Kaz 模式 · 更新指引（给 DeepSeek）

> **你的角色**：更新执行者。只按本文件步骤执行，不要做多余的事。
>
> **硬性规则（先读一遍，全程遵守）**：
> 1. 不要阅读 `README.md`，不要浏览仓库其它目录（`其它好用的工具`、`其它好用的预设`、`简易测式` 等一律不看），不要搜索网络。
> 2. 不要创建任何 `.ps1` / `.bat` 脚本文件；直接按下面步骤执行 PowerShell 命令。
> 3. 本文件内容完整，每一步都给全了命令或文件内容，**不需要参考任何其它文件核对**。
> 4. 每一步做完再进下一步。命令报错就看该步的「出错处理」，不要自行研究；遇到本文件未覆盖的错误，原样报告给用户，不要自作主张。
> 5. 全程不要向用户提问，除非出现本文件未覆盖的错误。
> 6. 目标机器是 Windows + PowerShell。
>
> **适用前提**：本机已装旧版 Kaz 模式。若 `%USERPROFILE%\.dsh\profiles\web\KazPlugins` 和 `%USERPROFILE%\.dsh\.agent-presets\kaz` 都不存在 → 改用 `ds安装指引.md`，不要继续本文件。

---

## 第 0 步 前置检查（约 10 秒）

```powershell
node -v; npm -v; dsh.cmd --version
Test-Path "$env:USERPROFILE\.dsh\profiles\web\KazPlugins"
Test-Path "$env:USERPROFILE\.dsh\.agent-presets\kaz"
```

> 用 `dsh.cmd` 而不是 `dsh`：某些机器上 PowerShell 执行策略会拦截 `dsh.ps1`（报 "running scripts is disabled"），`dsh.cmd` 不受影响。若 `dsh.cmd` 也提示找不到命令，再试 `dsh --version`；仍失败则按下面"停止"处理。

- 版本命令都能输出版本号 → 继续。
- 任何一条提示"不是内部或外部命令 / not recognized" → **停止**，告诉用户："请先安装 Node.js 20+ 与 dsh，再重试本指引。"
- 两个 `Test-Path` 至少有一个为 `True` → 确认是旧版环境，继续；都为 `False` → 改用 `ds安装指引.md`。

## 第 1 步 确认仓库路径

本文件位于仓库根目录。记：

```powershell
$repo = "本文件所在目录"   # 例如 C:\Users\xxx\Documents\GitHub\dsh-KazMode
```

## 第 2 步 备份旧版（推荐，约 1 秒）

```powershell
$backup = Join-Path $env:USERPROFILE (".dsh\kaz-backup-" + (Get-Date -Format "yyyyMMddHHmmss"))
New-Item -ItemType Directory -Force -Path $backup | Out-Null
Copy-Item "$env:USERPROFILE\.dsh\profiles\web\KazPlugins" $backup -Recurse -Force
Copy-Item "$env:USERPROFILE\.dsh\profiles\web\package.json" $backup -Force
Copy-Item "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml" $backup -Force
```

出错处理：若 `cordis.patch.yml` 不存在，最后一条报"找不到路径"没关系，前两条已备份；继续下一步。

## 第 3 步 整体删除旧 Kaz 插件与预设目录（约 1 秒）

```powershell
Remove-Item "$env:USERPROFILE\.dsh\profiles\web\KazPlugins" -Recurse -Force
Remove-Item "$env:USERPROFILE\.dsh\.agent-presets\kaz" -Recurse -Force
```

要点：
- 整体删除比覆盖更干净：旧版残留（如 `kaz-diag`、不在新清单里的插件目录）会一并清掉。
- 只删这两个 Kaz 相关目录，**不要动** `profiles\web\plugins`、`node_modules`、`package.json` 等其它文件（后面几步会逐个处理）。
- 出错处理：报"找不到路径"说明旧版本来就不存在对应目录，跳过即可。

## 第 4 步 复制新版插件与预设（约 2 秒）

```powershell
$pluginDst = Join-Path $env:USERPROFILE ".dsh\profiles\web\KazPlugins"
New-Item -ItemType Directory -Force -Path $pluginDst | Out-Null
Copy-Item -Path "$repo\KazPlugins\*" -Destination $pluginDst -Recurse -Force

$presetDst = Join-Path $env:USERPROFILE ".dsh\.agent-presets\kaz"
New-Item -ItemType Directory -Force -Path $presetDst | Out-Null
Copy-Item -Path "$repo\kaz\*" -Destination $presetDst -Recurse -Force
```

要点：
- 插件目录名必须严格是 `KazPlugins`；预设目录名必须严格是小写 `kaz`；`agent.cordis.yml` / `preset.yml` / `kaz-system-prompt.mjs` 直接放 `.agent-presets\kaz\` 根部。
- 复制的是**内容**，不要套出 `KazPlugins\KazPlugins` 或 `kaz\kaz`。
- 出错处理：报 `ReplaceFileW EIO (Win32 1175)` → 重试同一条命令一次。

## 第 5 步 清理旧版残留存储

```powershell
Remove-Item "$env:USERPROFILE\.dsh\storages\kaz-session-states.json" -Force -ErrorAction SilentlyContinue
```

- `kaz-session-states.json` 是旧版按对话隔离的残留，新版不再读取，直接删除。
- **保留** `~/.dsh/storages/kaz-defaults.json`（你的 Kaz 面板默认设置）和 `tool-plugin*.json` / `other-tool-plugin*.json`（工具控制面板数据）。

## 第 6 步 更新 package.json 依赖

打开 `%USERPROFILE%\.dsh\profiles\web\package.json`，在 `dependencies` 中：

1. **删除**所有旧的 Kaz 依赖行（包括 `kaz-diag`、旧版 `kaz-*` 行）。
   - **保留**以 `file:KazPrivatePlugins/...` 开头的用户私有依赖行（如 `"kaz-skill-safe-json": "file:KazPrivatePlugins/kaz-skill-safe-json"`），它们不在公共 repo 里，整目录删除 `KazPlugins` 不会碰到。
2. **合并**下面 13 行（保留 `dsh-plugin-marketplace`、`dsh-deepseek-balance`、`dsh-portable-tavern` 等其它依赖，只加不删其它项）：

```json
"deepseek-default-model": "file:KazPlugins/deepseek-default-model",
"ka-whale-workflow": "file:KazPlugins/ka-whale-workflow",
"create-plan": "file:KazPlugins/create-plan",
"kaz-agent-preset-display": "file:KazPlugins/kaz-agent-preset-display",
"ka-whale-memory": "file:KazPlugins/ka-whale-memory",
"kaz-mode": "file:KazPlugins/kaz-mode",
"kaz-shared": "file:KazPlugins/kaz-shared",
"output-beep": "file:KazPlugins/output-beep",
"plugin-filter": "file:KazPlugins/plugin-filter",
"round-display": "file:KazPlugins/round-display",
"round-minimal": "file:KazPlugins/round-minimal",
```

注意：`kaz-shared` 是必需依赖，漏装会导致 kaz-mode / ka-whale-memory / round-minimal / plugin-filter 加载失败。

文件用 UTF-8 **无 BOM** 保存。用 edit 工具改即可；若必须用 PowerShell 写文件，用（不要用 `Set-Content -Encoding UTF8`）：

```powershell
[System.IO.File]::WriteAllText("$env:USERPROFILE\.dsh\profiles\web\package.json", $jsonText, (New-Object System.Text.UTF8Encoding $false))
```

## 第 7 步 安装依赖 + 清理 stale 锁条目（热装约 1 秒）

```powershell
cd "$env:USERPROFILE\.dsh\profiles\web"
Remove-Item Env:npm_config_allow_scripts   # npm 11 兼容坑，先清掉
npm.cmd install --legacy-peer-deps --no-audit --no-fund --prefer-offline
```

> 用 `npm.cmd` 而不是 `npm`：`npm` 在 PowerShell 里是 `npm.ps1`，同样可能被执行策略拦截。

然后检查锁文件是否残留旧包（`npm prune` 不会自动清掉 `package-lock.json` / `pnpm-lock.yaml` 里的 stale 条目）：

```powershell
Get-ChildItem package-lock.json,pnpm-lock.yaml -ErrorAction SilentlyContinue | Select-String -Pattern 'kaz-diag'
```

- 没有输出 → 跳过，进入第 8 步。
- 有输出 → 用 edit 工具删除 lock 文件中对应的 `kaz-diag` 条目（及其依赖块），再执行一次：

```powershell
npm.cmd prune --legacy-peer-deps --no-audit --no-fund
```

出错处理：
- 报 scripts / npm 11 相关错误 → 上面的 `Remove-Item Env:npm_config_allow_scripts` 已处理；若仍报，再执行一次后重试。
- 网络超时 / 下载很慢（超过 60 秒）→ `npm config set registry https://registry.npmmirror.com` 后重试同一条 install 命令。
- 报 `npm ERR! code EPERM` / 文件占用 → 让用户关闭正在运行的 dsh web 窗口后重试，不要强行杀进程。

### 第 7.1 步 若 npm 把 `@deepseek-ai` 运行时依赖剪掉了（修复）

`npm.cmd install --legacy-peer-deps` 不会自动安装 peer；如果本机 `package.json`
缺少 dsh 运行时依赖，npm 可能输出 `removed N packages` 并把
`node_modules\@deepseek-ai` 清掉/改成悬空 junction。修复步骤：

1. 把 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\package.json` 的
   `dependencies` **合并**进 `%USERPROFILE%\.dsh\profiles\web\package.json`
   （只加不删）。
2. 再补这些 peer（若上面合并后仍缺）：
   `@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`、
   `@deepseek-ai/dsh-invariants`、`@deepseek-ai/dsh-shell-env`、
   `@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/cordis-plugin-loader`
   （版本取本机已安装包的 `peerDependencies` 范围）。
3. 重新执行第 7 步的 `npm.cmd install`（**不要**再跑 `npm prune`）。
4. 验证：
   `Test-Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\@deepseek-ai\cordis"`
   为 `True`，且
   `node --input-type=module -e "import('@deepseek-ai/dsh-tools').then(m=>console.log(typeof m.defineTool))"`
   能输出 `function`。

## 第 8 步 更新 cordis.patch.yml

打开 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`：

1. **删除**文件中已有的 Kaz 相关 insert 块。按块内 `id` 判断，以下 11 个 id 都是 Kaz 的块，全部删掉（文件不存在则跳过本小步）：
   - `memory`
   - `plugin-filter`
   - `kaz-agent-preset-display`
   - `round-minimal`
   - `kaz-mode`
   - `output-beep`
   - `round-display`
   - `deepseek-default-model`
   - `ka-whale-workflow`
   - 私有 `kaz-skill-*` 的 insert 块（例如 `kaz-skill-safe-json`）**不是** Kaz 框架块，属于“非 Kaz 自定义块”，**保留**，不要删除。
2. 文件中**非 Kaz 的自定义块保留**，不要动。
3. 把下面**完整内容**追加到文件末尾（文件不存在则新建，直接写入）：

```yaml
- insert:
    - id: memory
      name: ka-whale-memory

- insert:
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
      config:
        enabled: true

- insert:
    - id: ka-whale-workflow
      name: ka-whale-workflow
      config:
        enabled: true
```

注意：
- `create-plan` **不**进 `cordis.patch.yml`，它由 `kaz/agent.cordis.yml` 的 `planning` isolate 组挂载（随 kaz 预设复制）。
- `kaz-mode` 默认 `enabled: false` 是**正常**的，它由"选择 kaz 预设"这一动作联动开启，**不要改成 true**。

出错处理：YAML 解析失败 / 报 BOM 错误 → 用 UTF-8 无 BOM 保存（同第 6 步的写法）。

## 第 9 步 settings.yaml：无需修改

**跳过本步骤，不要动 `%USERPROFILE%\.dsh\settings.yaml`。**

原因（纯方案 A）：被管理插件（含 ka-whale-workflow / create-plan）配置由 kazMode 服务自动从 `~/.dsh/storages/kaz-defaults.json` + `<项目>/.dsh/storages/kaz-project-states.json` 读取（自动创建）；工具白名单走"工具控制面板"四文件 JSON，whale_report/create_goal/create_plan 走 `ka_tool_auto_on_setting.json`。settings.yaml 只保留 kaz-mode / agent-default-model / agent-presets 等少量段，都有自愈写入。

若你在 settings.yaml 里看到旧版残留的 `toolWhitelist` / `minimalTools` / 被管理插件段，可以顺手删除这些字段；不删也不影响（新代码不读）。

> 给用户的一句话（原样转达）：如果你在旧版里自定义过工具白名单，更新后需要在新版「工具控制面板」里重新配置；Kaz 面板的开关设置会保留在 `kaz-defaults.json`，不会丢。

## 第 10 步 验证（不重启也能做的部分，约 1 秒）

```powershell
dsh.cmd --profile web --dump-config
```

> 用 `dsh.cmd` 而不是 `dsh`：某些机器上 PowerShell 执行策略会拦截 `dsh.ps1`（报 "running scripts is disabled"），`dsh.cmd` 不受影响。若 `dsh.cmd` 也提示找不到命令，把报错原样告诉用户。


- 全部能看到 → 文件部分更新完成，进入第 11 步。
- 缺少某个 id → 检查第 6 步依赖是否漏行、第 8 步是否少了对应 insert 块，修正后重新执行第 7 步和第 10 步。

## 第 11 步 交给用户收尾（重要）

插件代码 / cordis 组合改动**必须重启 dsh web 才会加载**；而重启会中断你当前这个会话，所以由**用户手动操作**。请把下面的话原样告诉用户：

> 更新的文件部分已完成。请手动：
> 1. 重启 `dsh web`；
> 2. 强刷浏览器页面（Ctrl+F5 或 Cmd+Shift+R）；
> 3. 在新对话的预设选择器中选择 **Kaz 模式**（`kaz`）。
>
> 重启后自查：
> - 新对话的思考内出现 "We need" / "Let's"，不再出现 "Let me"；
> - 首次工具调用前工具面是极简状态（开 ka-whale-memory 时只有 `memory_search`；关闭时只有 `pwsh` + `read` + `edit`）；
> - 第一次工具调用后恢复白名单里的全部工具；
> - Kaz 面板出现各被管理插件的开关行。

---

## 附：出错速查表

| 现象 | 处理 |
| --- | --- |
| `npm install` 报 scripts 相关错误 | 命令里已含 `Remove-Item Env:npm_config_allow_scripts`；仍报就再执行一次再重试 |
| 下载很慢 / 网络超时 | `npm config set registry https://registry.npmmirror.com` 后重试 install |
| 更新后仍见旧 `kaz-diag` | 已用整体删除 + lock 检查覆盖；若还残留，再跑一次 `npm.cmd prune` |
| 写 YAML/JSON 报 BOM 解析错误 | 用 UTF-8 无 BOM 保存（见第 6 步的 PowerShell 写法） |
| 报 `ReplaceFileW EIO (Win32 1175)` | Windows 偶发错误，重试同一次编辑/复制一次即可 |
| 改完不生效 | 必须重启 dsh web + 强刷浏览器（第 11 步），文件操作本身已完成 |
| 遇到本表未覆盖的错误 | 原样把错误文本报告给用户，不要自行研究 |
