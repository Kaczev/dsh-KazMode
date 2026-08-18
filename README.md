# dsh-KazMode

Kaczev 的 DeepSeek Harness（dsh）**Kaz 模式**全家桶：11 个本地插件 + 1 个 agent preset。
给朋友的部署只需两步：下载本仓库 → 运行 install-kaz.ps1。

## 这是什么

Kaz 模式是一套"超级模式"：右上角一个开关，联动管理 11 个插件（思考锚点、轮次极简、
工具分组/过滤、工具塌缩、记忆、白板、提示音、每轮注入显示等），并附带专用 agent preset。

### 插件清单（plugins/）

| 插件 | 作用 |
|---|---|
| kaz-mode | 超级模式本体：右上角开关 + 集中管理面板，联动下面所有插件 |
| thinking-anchor | 思考锚点：每轮注入 We need 推理协议提示 |
| round-minimal | 首轮极简工具面，第 2 轮过渡，第 3 轮起恢复 |
| tool-grouping | 运行时工具分组（tool-fs / workflowEngine / kaz-memory） |
| tool-filter | 过滤指定工具（tool-cordis / codex / claude-code 等） |
| code-collapse | 工具塌缩：工具面折叠为唯一入口 run_code |
| kaz-memory | 跨会话记忆（明文 JSON 存储，人工确认闸门） |
| task-master-whiteboard | Task Master 角色 + 6 个白板工具 |
| output-beep | 模型输出完毕播放提示音 |
| round-display | 每轮注入显示（对话区「本轮注入」按钮） |
| kaz-no-context | Kaz 预设降噪：抑制运行时上下文快照与技能目录注入 |

### agent preset（kaz/）

kaz/ 是 Kaz 预设（agent.cordis.yml + preset.yml + 技能目录），安装时复制到
<DSH_HOME>\.agent-presets\kaz，安装脚本会自动设为默认预设（若当前没有默认值）。

## 目录结构

```text
dsh-KazMode/
├── plugins/               # 11 个插件源码（各自独立 npm 包）
├── kaz/                   # Kaz agent preset（可改名 .agent-presets/kaz 放分发包）
├── install-kaz.ps1        # 一键安装（幂等，可重复运行）
└── uninstall-kaz.ps1      # 一键卸载（幂等）
```
## 安装（给朋友）

要求：Windows + 已安装 dsh（dsh web 能跑起来）。

```powershell
# 1) 下载本仓库并解压（或 git clone）

# 2) 在仓库目录里运行：
Set-ExecutionPolicy -Scope Process Bypass -Force
.\install-kaz.ps1

# 3) 启动 dsh web（或重启正在运行的 dsh）
```

脚本会做四件事（全部幂等，不会覆盖已有配置）：

1. 复制 plugins/ → <DSH_HOME>\profiles\web\plugins；
2. 复制预设（kaz/ 或 .agent-presets/kaz）→ <DSH_HOME>\.agent-presets\kaz；
3. 为每个插件创建 node_modules junction（loader 解析需要）；
4. 把缺失的注册行追加到 cordis.patch.yml。

**不需要手动写 settings.yaml**：插件加载时会自动补齐缺失的配置段
（只补缺失键，保留已有配置；文件不存在时自动创建）。
首次启动后 agent-presets.default 会被设为 kaz，Kaz 模式默认开启。

## 卸载

```powershell
.\uninstall-kaz.ps1                  # 停用：删 junction + 注册行 + 配置段 + 预设
.\uninstall-kaz.ps1 -RemoveFiles     # 连 plugins 源码目录一起删
.\uninstall-kaz.ps1 -KeepSettings    # 保留 settings.yaml 不动
.\uninstall-kaz.ps1 -KeepPreset      # 保留 .agent-presets/kaz
.\uninstall-kaz.ps1 -DryRun          # 只预览将要执行的动作
```

卸载后重启 dsh web 生效；想重新启用，再跑一次 install-kaz.ps1 即可。

## 验证

- 右上角出现 **Kaz 模式**开关；
- 设置页可看到各插件的配置段（热重载）；
- 新建对话输入 kaz_mode_status 查看联动状态与工具面；
- dsh --profile web --dump-config 能看到 11 个插件的注册行。

## 常见问题

| 问题 | 说明 |
|---|---|
| PowerShell 禁止运行脚本 | 先执行 Set-ExecutionPolicy -Scope Process Bypass -Force，或用 pwsh -ExecutionPolicy Bypass -File install-kaz.ps1 |
| 改插件代码后不生效 | Node ESM 模块缓存，改 lib/*.js 后需重启 dsh |
| junction 怎么手动删 | cmd /c rmdir "<路径>"（勿用 Remove-Item） |
| 想对所有 profile 生效 | 把注册行放到 <DSH_HOME>\cordis.patch.yml（机器级层） |
| 自定义配置 | 直接编辑 <DSH_HOME>\settings.yaml 里对应段，热重载 |

## 说明

- 插件源码在 plugins/ 各自独立，可单独取出使用；
- 插件均声明 MIT（见各自 LICENSE / package.json）；
- 本仓库的 install-kaz.ps1 / uninstall-kaz.ps1 为部署辅助脚本，不进入 dsh 组合。
