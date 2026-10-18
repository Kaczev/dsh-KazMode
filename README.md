# Kaz 模式

一个给 DeepSeek Harness（dsh）**桌面端**用的 agent preset（代理预设）。当前版本 9.0.0。

v9 的 Kaz 模式**就是标准模式**（preset id `standard`），只多两样东西：

1. **系统提示词里多一段话。** 位置固定在 `You are an AI agent powered by DeepSeek Harness.` 与 `You are a coding agent powered by the <模型> model.` 之后、`Tokens prefixed with @ ...` 之前。这段讲的是怎么说话、怎么安排计划、怎么验收，写法上要求先加载 `write-like-a-person` 技能。
2. **一个技能：`write-like-a-person`。** 讲怎么把文字写成像人写的。技能随预设发版，放在 `kaz\skills\`。

没有别的了：工具面一个不加一个不减，不派子代理、不做记忆、不自己压缩上下文。plan 组、compaction 组、delegation 组、工具开关、顺序，全部是标准模式的逐行副本。所以 Kaz 模式的行为 = 标准模式的行为 + 那段提示词 + 那个技能。

仓库里是预设本体，放在 `kaz\`：`kaz\cordis.patch.yml` 是**唯一事实源**（它同时就是 bundle 的补丁层），`kaz\package.json` 是 bundle 元数据，`kaz\skills\` 放技能。

装好之后，在桌面端新建对话时于模式列表里选 **Kaz 模式**（preset id 为 `kaz`，排在最后）。

## 装完你会得到什么

- **标准模式的全部能力**：同一套工具、同一个 plan 模式、同一套压缩与子代理。
- **一段统一的说话与办事提示词**：直接、按分量决定长度、不重述、不表演过程；计划与执行不搞两套身位；视觉设计要给能直接打开的 HTML；写完要按 `write-like-a-person` 自检。
- **一个写作技能**，在技能目录里按需加载，不常驻上下文。

## 怎么装、怎么升

**安装和更新是同一件事**：把仓库里的 `kaz\` 当作 bundle 装进当前 profile。一步一步的走法在 `桌面端安装与更新指引.md`，提示词见 `桌面端安装与更新的提示词.txt`。

一句话版：

1. 在桌面端会话里让代理调用 `plugin_manager`：`install_bundle`，`target` = 仓库里 `kaz\` 的绝对路径；
2. 更新已有安装时，先 `remove_bundle`（`target: "kaz-preset-bundle"`）再 `install_bundle`——`install_bundle` 对已经装着的同一个 bundle 不是幂等的。

**从 v8 升到 v9 要重启一次桌面端**：v8 里有按文件路径挂的插件（`kaz-system-prompt.mjs`、`functions\**`），这些行不在插件表里，插件管理器卸不掉，装完会返回 `application: restart-required`。v9 只剩纯 YAML 补丁层，以后改它就即时重载，不再需要重启。

装完**开一个新会话**才看得到新模式（已挂载的会话保留它启动时的插件修订）。

## 需要什么

- **dsh 桌面端**（0.2.1-rc.2 上验过；预设本身没有版本闸门）。
- **Windows**。和标准模式一样：预设里 bash 那一行在非 win32 上直接禁用，改用 pwsh。
- **仓库在本机**。桌面端 profile 里的 `node_modules\kaz-preset-bundle` 是指向仓库 `kaz\` 的符号链接——改仓库就是改生效的那份。
- **不需要依赖树**。v9 没有任何自带 JS 模块，`kaz\node_modules`、版本对齐的 `@deepseek-ai/*` 全都不需要了。

## 维护者

- `kaz\cordis.patch.yml` 是装配的唯一事实源，也是生效的补丁层；`kaz\package.json` 只放版本和 `dsh.bundle.patch`。
- 与标准模式的差集必须**只有两处**（`persona` 的 prefix、`skill-filesystem` 的 `customSkillDirs`）。多出第三处就说明它已经不是 v9 的 Kaz 模式了。
- 技能目录那行用的是 `createRequire(baseUrl).resolve('kaz-preset-bundle/package.json')`：预设行在挂载时的 `baseUrl` 是 profile 目录，不是补丁文件目录。**改包名要同步改这行表达式。**
- 发版、回滚、提交形状：`发布与回滚.md`（不入库，只在本机）。
- 版本守卫：仓库根目录 `check-version.mjs`（断言 README 那句「当前版本 X.Y.Z」与 `kaz\package.json` 的主版本一致）。

## 从 v8 删掉了什么

v8 的整套东西都不在了：`kaz\functions\`（记忆、工作流、上下文策略、技能可见性四个模块）、16 个技能、`kaz-system-prompt.mjs`、`agent.cordis.yml` / `preset.yml` / `VERSION`、`make-bundle-patch.mjs`、回归测试。需要旧的实现时从 git 历史取（`8.10.0` 那条提交是最后一个 v8 版本）。

## 授权

MIT，见 `LICENSE.md`（Copyright (c) 2026 Kaczev）。
