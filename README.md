# dsh-KazMode

Kaczev 的 dsh「Kaz 模式」插件全家桶 + agent preset。

包含 11 个本地插件（`plugins/`）与 Kaz 预设（`plugins/kaz-mode/kaz-preset/`）。`install.bat` 一键安装脚本可帮朋友自动部署到 dsh Web profile。

## 仓库结构

- `plugins/` — 11 个插件包（code-collapse / kaz-memory / kaz-mode / kaz-no-context / output-beep / round-display / round-minimal / task-master-whiteboard / thinking-anchor / tool-filter / tool-grouping）
- `config/cordis.patch.yml` — 手动安装用的组合行模板（来自 Kaczev 的 profile）
- `package.json.example` — 想用 npm 管理依赖时的 profile package.json 模板
- `settings.kaz.example.yaml` — Kaz 相关设置段示例（不含个人配置 / 凭据）
- `install.bat` + `install.ps1` — 一键安装脚本（带自检，幂等可重复运行）
- `diagnose.bat` — 只读诊断：按钮不出现时跑它，把输出发给作者

## 快速安装（推荐给朋友）

1. 安装并启动过一次 dsh（Web GUI 版本）
2. 双击 `install.bat`（或在仓库目录运行 `powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1`）
3. 重启 dsh，浏览器强刷页面（Ctrl+F5）
4. 新建会话 → 预设选择器选「Kaz 模式」；或在会话头部点「Kaz 模式」按钮

> 要求：dsh ≥ **0.1.0-rc.6**（客户端 UI 依赖该版本的新 API；版本过旧会没有按钮）。

安装脚本会自动完成：

- 把 `plugins/` 全部 11 个插件复制到 `~/.dsh/profiles/web/plugins/`
- 在 `~/.dsh/profiles/web/node_modules/` 为每个插件创建 junction（不需要 npm）
- 向 `~/.dsh/profiles/web/cordis.patch.yml` 追加插件组合行（幂等：重复运行不会重复追加）
- 把 kaz-preset 复制到 `~/.dsh/.agent-presets/kaz/`
- 把缺少的设置段合并进 `~/.dsh/settings.yaml`（已有配置不会被覆盖）
- 给全局 dsh-host-apiproxy 打 `WEB_SETTINGS_NAMESPACES` 补丁（Kaz 面板读写插件设置需要；升级 dsh 后需重跑一次）
- 把 11 个插件依赖合并进 profile 的 `package.json`（与作者机器一致）
- 最后自检：junction、客户端 bundle、补丁、dsh 版本全部核对，有问题会红字列出并返回非 0 退出码

## 手动安装

如果不想用脚本，按以下步骤：

1. 复制 `plugins/` 全部目录到 `~/.dsh/profiles/web/plugins/`
2. 在 `~/.dsh/profiles/web/` 执行（二选一）：
   - npm 方式：把 `package.json.example` 里的 11 个 `file:plugins/...` 依赖合并进你的 `package.json`，然后 `npm install --legacy-peer-deps --no-audit --no-fund`
   - junction 方式：`New-Item -ItemType Junction -Path node_modules\<插件名> -Target plugins\<插件名>`
3. 把 `config/cordis.patch.yml` 的内容追加到你的 `~/.dsh/profiles/web/cordis.patch.yml`
4. 复制 `plugins/kaz-mode/kaz-preset` 到 `~/.dsh/.agent-presets/kaz/`
5. 把 `settings.kaz.example.yaml` 中缺少的设置段合并进 `~/.dsh/settings.yaml`
6. 给 `@deepseek-ai/dsh-host-apiproxy/lib/index.js` 的 `WEB_SETTINGS_NAMESPACES` 数组加上：`kaz-mode`、`kaz-memory`、`thinking-anchor`、`round-minimal`、`tool-grouping`、`tool-filter`、`code-collapse`、`output-beep`、`task-master-whiteboard`、`round-display`
7. 重启 dsh，Ctrl+F5 强刷页面

## 验证

- `dsh --profile web --dump-config` 输出中能看到 `kaz-mode`、`round-minimal` 等组合行
- 预设选择器里有「Kaz 模式」
- 会话头部出现「Kaz 模式：已开启 / 已关闭」按钮

## 注意事项

- 升级 dsh 会覆盖 apiproxy 补丁 → 重跑一次 `install.bat` 即可
- 卸载：删除 cordis.patch.yml 里对应的组合行、node_modules 里的 junction、`~/.dsh/.agent-presets/kaz/`、settings.yaml 里对应段
- 这些插件包含 cordis 组合能力（模型可读写运行环境），只分享给信任的人
- 首轮只见 `pwsh` / `str_replace_editor` 是预期行为（round-minimal 首轮极简）

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 头部没有按钮（朋友机器） | 先重跑 `install.bat` 看自检结果，再跑 `diagnose.bat` 把输出发给作者；同时确认：dsh ≥ 0.1.0-rc.6、完全重启 dsh 后 Ctrl+F5 强刷 |
| 头部没有按钮（本机） | 重启 dsh（ESM 缓存）+ Ctrl+F5 强刷；确认 cordis.patch.yml 有 kaz-mode 行 |
| 面板显示「未安装」/设置写不进去 | 检查 dsh-host-apiproxy 补丁是否还在（升级 dsh 会被覆盖） |
| 预设选择器没有「Kaz 模式」 | 确认 `~/.dsh/.agent-presets/kaz/` 存在，然后重启 dsh |
| 首轮只有两个工具 | 正常：round-minimal 首轮极简，第二轮起恢复全量 |
| 安装脚本中文乱码 | install.ps1 已内置 UTF-8 控制台设置；请勿用「另存为 ANSI/GBK」覆盖它（保持 UTF-8 with BOM） |
| 装了但插件 UI 全没（连按钮都没有） | 八成是 dsh 版本过旧 / 没重启 / 或某个客户端包组合失败（会连累全部插件 UI）。跑 `diagnose.bat`，把输出发作者 |
