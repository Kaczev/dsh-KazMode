# Kaz 模式

给 DeepSeek Harness（dsh）桌面端用的 agent preset（代理预设），当前版本 9.0.1。npm 包名 `dsh-kazmode`。

v9 的 Kaz 模式就是标准模式的逐行副本，只多了两样东西。

第一样是系统提示词里的一段话。它讲怎么说话、怎么排计划、怎么验收，并要求写作之前先加载 `write-like-a-person` 这个技能。位置在 `You are an AI agent powered by DeepSeek Harness.` 和 `You are a coding agent powered by the <模型> model.` 之后、`Tokens prefixed with @ ...` 那段之前。

第二样是一个技能 `write-like-a-person`。它有自己的仓库（`Kaczev/write-like-a-person`），`kaz\skills\write-like-a-person\` 里是同步过来的副本，跟着预设一起发版。改技能去那个仓库，改完在仓库根跑 `node scripts\sync-skill.mjs`。

工具面没动过：没有加工具，也没有关掉任何一个。plan 组、compaction 组、delegation 组里的每一项，连同顺序和 `disabled` 标记，都是从标准模式逐行抄过来的。所以装好之后，Kaz 模式的行为等于标准模式的行为，再加上那段提示词和那个技能。

仓库里放的是预设本体，在 `kaz\` 目录下，也就是发布到 npm 的那个包：`kaz\cordis.patch.yml` 是唯一的事实源，它同时就是 bundle 的补丁层；`kaz\package.json` 放 bundle 元数据与 npm 元数据；技能副本在 `kaz\skills\`，同步脚本在 `scripts\`。

装好之后，在桌面端新建对话，模式列表里会多一个 **Kaz 模式**（preset id 是 `kaz`，`order` 为 5）。

## 装完是什么样

- 说话方式跟着变：直接，按问题的分量决定回答长度，不复述你的问题，也不表演过程。
- 做视觉设计时先给一份能直接打开的 HTML，而不是一段文字描述。
- 写完之后按 `write-like-a-person` 自检一遍再交。

## 怎么装、怎么升

在桌面端打开 **添加插件**，输入包名：

```
dsh-kazmode
```

要钉版本就写 `dsh-kazmode@9.0.1`。命令行等价物是 `dsh plugin add dsh-kazmode`。装完在插件页启用它，再开一个新会话，模式列表里就有 **Kaz 模式**。

更新走「先卸载、再装」：社区插件没有单独的更新按钮，先 `remove_bundle`（`target: "dsh-kazmode"`），再按上面装一次。装完开新会话。

从 v8 升级要重启一次桌面端。v8 里有些插件是按文件路径挂上去的（`kaz-system-prompt.mjs`、`functions\**`），这些插件行不在插件表里，插件管理器卸不掉，装完会返回 `application: restart-required`。v9 只剩纯 YAML 补丁层，以后改 `kaz\cordis.patch.yml` 就即时重载，不用再重启。

装完还要开一个新会话才看得见新模式：已经挂载的会话保留它启动时的那份插件。

## 需要什么

- **dsh 桌面端**。预设本身不设版本闸门，我在 0.2.1-rc.2 上验过。
- **Windows**。和标准模式一样，预设里 bash 那一行在非 win32 上禁用，改用 pwsh。
- **能连上 npm**（或配好镜像源）。插件从注册表下载，不依赖本机有没有仓库副本。
- **不需要依赖树**。v9 没有自带 JS 模块，`kaz\node_modules` 和版本对齐的 `@deepseek-ai/*` 都不需要装。

## 给维护者

- `kaz\cordis.patch.yml` 是装配的唯一事实源，也是生效的那层补丁。`kaz\package.json` 管版本号、`dsh.bundle.patch` 和 npm 发布元数据（包名、`files`、`license`、`repository`）。
- 和标准模式的差集必须只有两处：`persona` 的 `prefix`，以及 `skill-filesystem` 的 `customSkillDirs`。出现第三处，它就不再是 v9 的 Kaz 模式。
- 技能目录那一行用的是 `createRequire(baseUrl).resolve('dsh-kazmode/package.json')`。预设行挂载时的 `baseUrl` 是 profile 目录，不是补丁文件所在的目录，所以不能拿它直接拼 `skills/`。包名改了要同步改这行表达式，否则技能静默消失。
- 技能副本由 `scripts\sync-skill.mjs` 从 `..\write-like-a-person` 拷进来，源路径可用 `--from` 或环境变量 `WLAP_REPO` 覆盖。拷过去的是 `SKILL.md`（以及将来的 `references\`、`examples\`），`SOURCE.json` 记来源仓库、分支、commit 和内容哈希。`node scripts\sync-skill.mjs --verify` 退出码非 0 就说明两边对不上；发布前先跑它。不要直接编辑 `kaz\skills\` 里的副本，下次同步会覆盖。
- 发版、回滚和提交形状写在 `发布与回滚.md` 里（含 `npm publish` 与本地 `link:` 安装两条路）。它在 `.gitignore` 里，只留在本机。
- 版本守卫是仓库根目录的 `check-version.mjs`，它断言 README 里「当前版本 X.Y.Z」那句和 `kaz\package.json` 的主版本一致，并顺手检查这个包还发得出去（包名、`private`、`files`）。

## 从 v8 删掉了什么

v8 那一套都不在了：`kaz\functions\` 里的四个模块（记忆、工作流、上下文策略、技能可见性）、16 个技能、`kaz-system-prompt.mjs`、`agent.cordis.yml` / `preset.yml` / `VERSION`、`make-bundle-patch.mjs`，还有回归测试。要用旧的实现，从 git 历史里取，`8.10.0` 那条提交是最后一个 v8 版本。

## 授权

MIT，见 `LICENSE.md`（Copyright (c) 2026 Kaczev）。
