# Kaz 模式

给 DeepSeek Harness（dsh）桌面端用的 agent preset（代理预设），当前版本 9.0.0。

v9 的 Kaz 模式就是标准模式的逐行副本，只多了两样东西。

第一样是系统提示词里的一段话。它讲怎么说话、怎么排计划、怎么验收，并要求写作之前先加载 `write-like-a-person` 这个技能。位置在 `You are an AI agent powered by DeepSeek Harness.` 和 `You are a coding agent powered by the <模型> model.` 之后、`Tokens prefixed with @ ...` 那段之前。

第二样是一个技能 `write-like-a-person`，源码在 `kaz\skills\`，跟着预设一起发版。

工具面没动过：没有加工具，也没有关掉任何一个。plan 组、compaction 组、delegation 组里的每一项，连同顺序和 `disabled` 标记，都是从标准模式逐行抄过来的。所以装好之后，Kaz 模式的行为等于标准模式的行为，再加上那段提示词和那个技能。

仓库里放的是预设本体，在 `kaz\` 目录下：`kaz\cordis.patch.yml` 是唯一的事实源，它同时就是 bundle 的补丁层；`kaz\package.json` 放 bundle 元数据；技能在 `kaz\skills\`。

装好之后，在桌面端新建对话，模式列表里会多一个 **Kaz 模式**（preset id 是 `kaz`，`order` 为 5）。

## 装完是什么样

- 说话方式跟着变：直接，按问题的分量决定回答长度，不复述你的问题，也不表演过程。
- 做视觉设计时先给一份能直接打开的 HTML，而不是一段文字描述。
- 写完之后按 `write-like-a-person` 自检一遍再交。

## 怎么装、怎么升

安装和更新是同一件事：把仓库里的 `kaz\` 当作 bundle 装进当前 profile。逐步操作写在 `桌面端安装与更新指引.md`，可以直接粘给代理的提示词在 `桌面端安装与更新的提示词.txt`。

几句话说完：

1. 在桌面端会话里让代理调用 `plugin_manager` 的 `install_bundle`，`target` 填仓库里 `kaz\` 的绝对路径。
2. 更新已经装着的版本时，先 `remove_bundle`（`target: "kaz-preset-bundle"`），再 `install_bundle`。`install_bundle` 对已经装着的同一个 bundle 不是幂等的。

从 v8 升到 v9 要重启一次桌面端。v8 里有些插件是按文件路径挂上去的（`kaz-system-prompt.mjs`、`functions\**`），这些插件行不在插件表里，插件管理器卸不掉，装完会返回 `application: restart-required`。v9 只剩纯 YAML 补丁层，以后改 `kaz\cordis.patch.yml` 就即时重载，不用再重启。

装完还要开一个新会话才看得见新模式：已经挂载的会话保留它启动时的那份插件。

## 需要什么

- **dsh 桌面端**。预设本身不设版本闸门，我在 0.2.1-rc.2 上验过。
- **Windows**。和标准模式一样，预设里 bash 那一行在非 win32 上禁用，改用 pwsh。
- **仓库在本机**。桌面端 profile 里的 `node_modules\kaz-preset-bundle` 是指向仓库 `kaz\` 的符号链接，改仓库就是改正在生效的那份。
- **不需要依赖树**。v9 没有自带 JS 模块，`kaz\node_modules` 和版本对齐的 `@deepseek-ai/*` 都不需要装。

## 给维护者

- `kaz\cordis.patch.yml` 是装配的唯一事实源，也是生效的那层补丁。`kaz\package.json` 只管版本号和 `dsh.bundle.patch`。
- 和标准模式的差集必须只有两处：`persona` 的 `prefix`，以及 `skill-filesystem` 的 `customSkillDirs`。出现第三处，它就不再是 v9 的 Kaz 模式。
- 技能目录那一行用的是 `createRequire(baseUrl).resolve('kaz-preset-bundle/package.json')`。预设行挂载时的 `baseUrl` 是 profile 目录，不是补丁文件所在的目录，所以不能拿它直接拼 `skills/`。改包名的时候要同步改这行表达式。
- 发版、回滚和提交形状写在 `发布与回滚.md` 里。它在 `.gitignore` 里，只留在本机。
- 版本守卫是仓库根目录的 `check-version.mjs`，它断言 README 里「当前版本 X.Y.Z」那句和 `kaz\package.json` 的主版本一致。

## 从 v8 删掉了什么

v8 那一套都不在了：`kaz\functions\` 里的四个模块（记忆、工作流、上下文策略、技能可见性）、16 个技能、`kaz-system-prompt.mjs`、`agent.cordis.yml` / `preset.yml` / `VERSION`、`make-bundle-patch.mjs`，还有回归测试。要用旧的实现，从 git 历史里取，`8.10.0` 那条提交是最后一个 v8 版本。

## 授权

MIT，见 `LICENSE.md`（Copyright (c) 2026 Kaczev）。
