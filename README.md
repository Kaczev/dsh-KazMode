# Kaz 模式

一个给 DeepSeek Harness（dsh）用的 agent preset（代理预设）。仓库里是预设本体，放在 `kaz\` 目录：`kaz\preset.yml` 定名称与描述，`kaz\agent.cordis.yml` 定怎么装配，`kaz\skills\` 放技能，`kaz\functions\` 放各功能模块。当前版本 8.9.0，写在 `kaz\VERSION`。

装好之后，在 dsh 新建对话时于模式列表里选 **Kaz 模式**（preset id 为 `kaz`）。

## 装完你会得到什么

- **一个主代理，是你唯一的联系人。** 它把你的需求听清、拆开，决定哪些自己做、哪些交出去，交出去之后仍然对结果负责。它的身份文本只有一处来源：`kaz\functions\kaz-shared\lib\roles.js`。
- **按需派遣的子代理。** 主代理为某件事临时定义角色并派出去，同时最多五个子代理在跑（只数 running 状态的）；再多就排队，等跑着的收工再派。上限是在派发那一刻数出来的，不是硬锁。
- **收紧过的工具面。** 官方的 `subagent` / `subagent_fork` 由 `ka_sub_whale` 取代，官方 bash 由 PowerShell 工具取代；goal（`create_goal` / `get_goal` / `update_goal`）、plan（`/plan`）、workflow、ralph 都没有挂载，所以模型不会以为自己有这些工具。
- **三阶段的工作流。** `idle`、`arrange_agent`（写下本轮的派工计划）、`self-check`（自检）。模型面的四个工具是 `write_arrangement`、`get_arrangement`、`ka_sub_whale`、`whale_report`。每 4 条真人消息自动进入一次 `self-check`，该阶段工具面只剩 `whale_report`。
- **记忆由专职的记忆管家写。** 模型自己不能写记忆，只能读，读的三个工具是 `memory_search`、`memory_detail`、`memory_list`；要记下的东西由主代理按保留角色把记忆管家派出去记录，这个角色是派工计划里必须包含的一项。记忆分两层作用域：全局（机器与环境级事实）和项目（项目级事实，落在会话目录）；本身又分 `context` 与 `paths` 两类，各存成一个 JSON 文件。检索是自己实现的 BM25，按正文、summary、keywords 打分。
- **可以手选的上下文压缩。** 用 `context_compress` 把中间一段折成摘要，最近的对话原样留着；折掉的原文仍在会话记录里，能用 `context_read` 按位置整段读回，也能用 `context_search` 检索回来。`context_hotspots` 列出当前最占上下文的节点，并给出可折的区间。占用过半（50%）是提醒压缩的阈值；平台自带的自动压缩和工具结果裁剪（超过 8192 字符的结果会裁短）同时保留。
- **代理之间可以互查记录。** `context_search` 和 `context_read` 能指定另一个代理（`companion`），读它自己的记录，而不是只看它交回来的结论。
- **16 个技能随预设一起发版。** 技能在 `kaz\skills\`，一个技能一个目录，各含一份 SKILL.md；模型按需自己取用，不常驻上下文。其中 9 个只给主代理（`building-something-new`、`working-from-a-plan`、`repairing-something-broken`、`reviewing-someone-elses-work`、`moving-or-upgrading-a-thing`、`getting-unstuck`、`orienting-in-a-codebase`、`cleaning-up-slop`、`kaz-dispatch`），讲的是怎么安排和验收多个代理；另外 7 个（`auditing-words`、`authoring-dsh-extensions`、`diagnosing-agent-extensions`、`design-quality`、`office-documents`、`planning-with-files`、`powershell-scripting`）主代理和子代理都能用，讲的是这类活本身怎么干。
- **系统提示面动过两处。** 主代理的身份由 `kaz\kaz-system-prompt.mjs` 在装配时写入，是唯一来源；子代理不被改写，保留派发时给它的身份。平台自带的 `harness:identity` 段从系统提示里摘掉（子代理也摘），其余平台段落保留。

## 怎么装、怎么升

安装和更新不在本文展开，交给写死了每一步的指引，把提示词发给 DeepSeek 让它照着做即可：

- **全新安装**：读 `ds安装指引.md`，提示词见 `ds安装法的提示词.txt`。
- **已有安装的更新**：读 `ds更新指引.md`，提示词见 `ds更新法的提示词.txt`。

实际执行的是仓库根目录的 `install-kaz-preset.ps1`：安装和更新用同一个脚本，更新就是重跑它。常用参数有 `-DryRun`（预演，预演会打印 OK，但没有写入）、`-DshHome`、`-ProfileName`、`-AllHomes`、`-Uninstall`、`-SkipVersionCheck`。脚本先备份再镜像：已有预设备份到 `<home>\tools\kaz-preset-backup-<时间戳>`，然后用 robocopy 把 `kaz\` 镜像到 `<home>\.agent-presets\kaz`（不含 node_modules）。

生效要三步：重启 dsh、强刷浏览器页面、在**新对话**里选 Kaz 模式。

## 需要什么

- **dsh `0.1.5-rc.2`**，只支持这一个版本。版本号读的是运行时包 `@deepseek-ai/dsh` 的 `version` 字段，不是 `dsh --version`；对不上时安装程序报错并停止。`-SkipVersionCheck` 是唯一的绕过开关，只在用户明确要求回退到 `0.1.5-rc.1` 时用，而且回退时必须把该 home 启动器的 `EXPECTED_CLI` 一起改回去，否则启动器拒绝启动——回退不是受支持的状态。
- **Windows + PowerShell**。这不只是文档口径：预设本体就按 Windows 写，非 win32 平台上 PowerShell 工具直接禁用；安装脚本也声明只支持 Windows。

## 授权

MIT，见 `LICENSE.md`（Copyright (c) 2026 Kaczev）。
