# Kaz 模式 · 安装指引（给 DeepSeek）

> **你的角色**：安装执行者。只按本文件步骤执行，不要做多余的事。
>
> **硬性规则（先读一遍，全程遵守）**：
> 1. 不要阅读 `README.md`，不要浏览仓库其它目录（`其它好用的工具`、`其它好用的预设`、`简易测式` 等一律不看），不要搜索网络。
> 2. 不要创建任何 `.ps1` / `.bat` 脚本文件；直接按下面步骤执行 PowerShell 命令。
> 3. 本文件内容完整，每一步都给全了命令或文件内容，**不需要参考任何其它文件核对**。
> 4. 每一步做完再进下一步。命令报错就看该步的「出错处理」，不要自行研究；遇到本文件未覆盖的错误，原样报告给用户，不要自作主张。
> 5. 全程不要向用户提问，除非出现本文件未覆盖的错误。
> 6. 目标机器是 Windows + PowerShell。

---

## 第 0 步 前置检查（约 10 秒）

```powershell
node -v; npm -v; dsh.cmd --version
```

> 用 `dsh.cmd` 而不是 `dsh`：某些机器上 PowerShell 执行策略会拦截 `dsh.ps1`（报 "running scripts is disabled"），`dsh.cmd` 不受影响。若 `dsh.cmd` 也提示找不到命令，再试 `dsh --version`；仍失败则按下面"停止"处理。

- 三条命令都能输出版本号 → 继续。
- 任何一条提示"不是内部或外部命令 / not recognized" → **停止**，告诉用户："请先安装 Node.js 20+ 与 dsh，再重试本指引。" 不要自行安装。
- 若目标机已存在旧版 Kaz 模式（`%USERPROFILE%\.dsh\profiles\web\KazPlugins` 或 `%USERPROFILE%\.dsh\.agent-presets\kaz`）→ 不要继续本文件，改用 `ds更新指引.md`。

## 第 1 步 确认仓库路径

本文件位于仓库根目录。记：

```powershell
$repo = "本文件所在目录"   # 例如 C:\Users\xxx\Documents\GitHub\dsh-KazMode
```

后续命令里的 `$repo` 都指这里。若你当前工作目录就是仓库根目录，也可直接用 `.`，但建议写完整路径，避免换目录后失效。

## 第 2 步 复制插件（约 1 秒）

```powershell
$pluginDst = Join-Path $env:USERPROFILE ".dsh\profiles\web\KazPlugins"
New-Item -ItemType Directory -Force -Path $pluginDst | Out-Null
Copy-Item -Path "$repo\KazPlugins\*" -Destination $pluginDst -Recurse -Force
```

要点：
- 目录名必须严格是 `KazPlugins`（大写 K、大写 P），不要复制进 `profiles\web\plugins`。
- 复制的是 `KazPlugins\*` 的**内容**，不要把 `KazPlugins` 文件夹本身套进去（避免出现 `KazPlugins\KazPlugins`）。

出错处理：
- 报 `ReplaceFileW EIO (Win32 1175)` → Windows 偶发文件系统错误，**重试同一条命令一次**即可，不要换工具。
- 报"目录名无效 / 找不到路径" → 先确认 `$repo` 路径正确，再重试。

## 第 3 步 复制预设（约 1 秒）

```powershell
$presetDst = Join-Path $env:USERPROFILE ".dsh\.agent-presets\kaz"
New-Item -ItemType Directory -Force -Path $presetDst | Out-Null
Copy-Item -Path "$repo\kaz\*" -Destination $presetDst -Recurse -Force
```

要点：
- 目录名必须严格是小写 `kaz`，不要写成 `Kaz` / `KazMode`（preset id 只允许小写开头）。
- `agent.cordis.yml`、`preset.yml`、`kaz-system-prompt.mjs` 必须直接位于 `.agent-presets\kaz\` 根部，不要嵌套。
- 复制的是 `kaz\*` 的**内容**，不要套出 `kaz\kaz`。

## 第 4 步 在 package.json 注册依赖

打开 `%USERPROFILE%\.dsh\profiles\web\package.json`，在 `dependencies` 中**合并**下面 11 行：

```json
"deepseek-default-model": "file:KazPlugins/deepseek-default-model",
"first-round-hints": "file:KazPlugins/first-round-hints",
"kaz-agent-preset-display": "file:KazPlugins/kaz-agent-preset-display",
"kaz-memory": "file:KazPlugins/kaz-memory",
"kaz-mode": "file:KazPlugins/kaz-mode",
"kaz-shared": "file:KazPlugins/kaz-shared",
"output-beep": "file:KazPlugins/output-beep",
"plugin-filter": "file:KazPlugins/plugin-filter",
"round-display": "file:KazPlugins/round-display",
"round-minimal": "file:KazPlugins/round-minimal",
"thinking-anchor": "file:KazPlugins/thinking-anchor"
```

规则：
- **保留** `dependencies` 里已有的其它依赖（如 `dsh-plugin-marketplace`、`dsh-deepseek-balance`、`dsh-portable-tavern` 等），只加不删其它项。
- 若已存在旧的 Kaz 依赖行（例如 `kaz-diag`，或上面 11 行里的旧版本写法），用上面 11 行**替换**旧行，不要重复。
- `kaz-shared` 是必需依赖：kaz-mode / kaz-memory / round-minimal / plugin-filter 都 import 它，漏装会导致插件加载失败。
- 文件用 UTF-8 **无 BOM** 保存。用你的 edit 工具改即可；若必须用 PowerShell 写文件，用下面的写法（不要用 `Set-Content -Encoding UTF8`，它会写 BOM 破坏 JSON 解析）：

```powershell
[System.IO.File]::WriteAllText("$env:USERPROFILE\.dsh\profiles\web\package.json", $jsonText, (New-Object System.Text.UTF8Encoding $false))
```

## 第 5 步 安装依赖（热装约 1 秒，冷装约 20 秒）

```powershell
cd "$env:USERPROFILE\.dsh\profiles\web"
Remove-Item Env:npm_config_allow_scripts   # npm 11 兼容坑，先清掉
npm.cmd install --legacy-peer-deps --no-audit --no-fund --prefer-offline
```

> 用 `npm.cmd` 而不是 `npm`：`npm` 在 PowerShell 里是 `npm.ps1`，同样可能被执行策略拦截。

预期：
- 热装（node_modules 已存在）约 1 秒；冷装约 20 秒左右，其中大部分是 `dsh-plugin-marketplace` 从 GitHub 下载 tarball，属正常，不要中断。
- 成功标志：`node_modules` 下为每个 Kaz 插件生成指向 `KazPlugins/<插件名>` 的 junction（`cmd /c dir node_modules` 可看到 `<JUNCTION>`）。

出错处理：
- 报 scripts / npm 11 相关错误 → 上面的 `Remove-Item Env:npm_config_allow_scripts` 已处理；若仍报，再执行一次该命令后重试。
- 网络超时 / 下载很慢（超过 60 秒）→ 执行 `npm config set registry https://registry.npmmirror.com`，然后重试同一条 `npm.cmd install` 命令。
- 报 `npm ERR! code EPERM` / 文件占用 → 让用户关闭正在运行的 dsh web 窗口后重试，不要强行杀进程。

## 第 6 步 编辑 cordis.patch.yml

打开 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`：

1. **删除**文件中已有的 Kaz 相关 insert 块。按块内 `id` 判断，以下 10 个 id 都是 Kaz 的块，全部删掉（文件不存在则跳过本小步）：
   - `memory`
   - `thinking-anchor`
   - `plugin-filter`
   - `kaz-agent-preset-display`
   - `round-minimal`
   - `kaz-mode`
   - `output-beep`
   - `round-display`
   - `deepseek-default-model`
   - `first-round-hints`
2. 文件中**非 Kaz 的自定义块保留**，不要动。
3. 把下面**完整内容**追加到文件末尾（文件不存在则新建，直接写入）：

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
    - id: first-round-hints
      name: first-round-hints
      config:
        enabled: true
```

注意：`kaz-mode` 默认 `enabled: false` 是**正常**的，它由"选择 kaz 预设"这一动作联动开启，**不要改成 true**。

出错处理：YAML 解析失败 / 报 BOM 错误 → 用 UTF-8 无 BOM 保存（同第 4 步的写法）。

## 第 7 步 settings.yaml：无需修改

**跳过本步骤，不要动 `%USERPROFILE%\.dsh\settings.yaml`。**

原因（纯方案 A）：被管理插件（thinking-anchor / round-minimal / plugin-filter / output-beep / round-display / deepseek-default-model / kaz-memory / first-round-hints）的生效配置由 kazMode 服务自动从下面两个 JSON 读取，自动创建：
- `~/.dsh/storages/kaz-defaults.json`
- `<项目>/.dsh/storages/kaz-project-states.json`

工具白名单走"工具控制面板"的四文件 JSON（`tool-plugin.json` 等，按项目隔离）。settings.yaml 只保留 kaz-mode / agent-default-model / agent-presets 等少量段，都有自愈写入，不需要你编辑。

若你在 settings.yaml 里看到旧版残留的 `toolWhitelist` / `minimalTools` / 被管理插件段，可以顺手删除这些字段；不删也不影响（新代码不读）。

## 第 8 步 验证（不重启也能做的部分，约 1 秒）

```powershell
dsh.cmd --profile web --dump-config
```

> 用 `dsh.cmd` 而不是 `dsh`：某些机器上 PowerShell 执行策略会拦截 `dsh.ps1`（报 "running scripts is disabled"），`dsh.cmd` 不受影响。若 `dsh.cmd` 也提示找不到命令，把报错原样告诉用户。

检查输出里能看到这些组合行（插件 id）：`memory`（即 kaz-memory 插件）、`thinking-anchor`、`plugin-filter`、`round-minimal`、`kaz-mode`、`kaz-agent-preset-display`、`output-beep`、`round-display`、`deepseek-default-model`、`first-round-hints`。

- 全部能看到 → 安装的文件部分完成，进入第 9 步。
- 缺少某个 id → 检查第 4 步依赖是否漏行、第 6 步是否少了对应 insert 块，修正后重新执行第 5 步和第 8 步。

## 第 9 步 交给用户收尾（重要）

插件代码 / cordis 组合改动**必须重启 dsh web 才会加载**；而重启会中断你当前这个会话，所以由**用户手动操作**。请把下面的话原样告诉用户：

> 安装的文件部分已完成。请手动：
> 1. 重启 `dsh web`；
> 2. 强刷浏览器页面（Ctrl+F5 或 Cmd+Shift+R）；
> 3. 在新对话的预设选择器中选择 **Kaz 模式**（`kaz`）。
>
> 重启后自查：
> - 新对话的思考内出现 "We need" / "Let's"，不再出现 "Let me"；
> - 首次工具调用前工具面是极简状态（开 kaz-memory 时只有 `memory_search`；关闭时只有 `pwsh` + `read` + `edit`）；
> - 第一次工具调用后恢复白名单里的全部工具；
> - Kaz 面板出现各被管理插件的开关行。

---

## 附：出错速查表

| 现象 | 处理 |
| --- | --- |
| `npm install` 报 scripts 相关错误 | 命令里已含 `Remove-Item Env:npm_config_allow_scripts`；仍报就再执行一次再重试 |
| 下载很慢 / 网络超时 | `npm config set registry https://registry.npmmirror.com` 后重试 install |
| 写 YAML/JSON 报 BOM 解析错误 | 用 UTF-8 无 BOM 保存（见第 4 步的 PowerShell 写法） |
| 报 `ReplaceFileW EIO (Win32 1175)` | Windows 偶发错误，重试同一次编辑/复制一次即可 |
| 改完不生效 | 必须重启 dsh web + 强刷浏览器（第 9 步），文件操作本身已完成 |
| 遇到本表未覆盖的错误 | 原样把错误文本报告给用户，不要自行研究 |
