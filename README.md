# Kaz 模式

给 DeepSeek Harness（dsh）桌面端用的 agent presets（代理预设），当前版本 9.1.0。npm 包名 `dsh-kazmode`。

一个包提供两个预设：

- **Kaz 模式**（`kaz`，order 5）：基于标准模式，保留原有 ID。
- **Kaz PTC 模式**（`kaz-ptc`，order 6）：基于 PTC 模式。

两者各自在原生系统提示词中插入同一段话，并挂载同一个 `write-like-a-person` 技能。除此之外，保留各自原生预设的插件、顺序、配置与禁用标记。PTC 版保留原生的 `mode: ptc` 工具呈现插件，并禁用 delegation 组中的 `workflow-ptc` 与 `tool-workflow`。

## 共享内容放在哪

[cordis.patch.yml](./kaz/cordis.patch.yml) 是装配源文件，也是直接生效的 bundle 补丁层，没有生成步骤。

- **提示词**：标准版 `persona` 的 `config: &kaz-persona` 下定义完整 prefix，PTC 版用 `config: *kaz-persona` 引用。只改锚点中的正文，两个预设一起变。
- **技能目录配置**：标准版 `skill-filesystem` 的 `config: &kaz-skills` 定义一次目录，PTC 版用 `config: *kaz-skills` 引用。
- **技能正文**：两版都指向同一份 [SKILL.md](./kaz/skills/write-like-a-person/SKILL.md)，不按预设复制目录。

YAML 锚点只共享这两项配置；其余插件列表分别跟随标准和 PTC 基底。不要把 PTC 版改成标准版工具组合，也不要在 PTC 版复制提示词或技能配置。

提示词正文沿用 9.0.2：直接回答、按任务分量决定长度、统一规划与执行、渐进式语义导航、HTML 视觉设计交付、实际验证，以及写作前加载 `write-like-a-person`。插入位置仍在模型身份句之后、`Tokens prefixed with @ ...` 之前。

## 安装与更新

在桌面端打开 **添加插件**，输入：

```
dsh-kazmode
```

要钉版本就写 `dsh-kazmode@9.1.0`。命令行等价物是 `dsh plugin add dsh-kazmode`。本版须发布到 npm 后才能按版本号安装；本地验证可安装 [kaz](./kaz/) 包目录。

装完启用，再开一个新会话，模式列表应同时出现 **Kaz 模式** 和 **Kaz PTC 模式**。已有会话保留启动时的插件版本。更新按插件管理器的提示操作；若返回 `ambiguous-install`，先卸载再安装。

从 v8 升级如果返回 `application: restart-required`，需重启桌面端。v8 的文件路径插件不能全部就地卸载。

插件列表的卡片标题与说明由各自入口的展示资源提供：[标准版中文元数据](./kaz/presets/standard/locale/zh.json)、[PTC 版中文元数据](./kaz/presets/ptc/locale/zh.json)，英文资源放在相邻目录。两版共享原创[鲸鱼图标](./kaz/icon.svg)。仅改预设的 `config.name` 不会改变插件列表中的标题。

两个轻量入口通过[共享注册函数](./kaz/presets/shared.js)调用宿主的 `agentPresets.register`，返回注销函数，并保留延迟求值子插件配置所需的 Cordis group 标记。它们不复制 DSH 实现、不安装第二套宿主依赖；提示词与技能仍各只有一个来源。

包没有运行时依赖，不 import 任何 `@deepseek-ai/*`。所需 DSH 插件由宿主提供；宿主升级后仍需对照其标准与 PTC 预设验证兼容性，不能只凭没有依赖树判断兼容。

## 技能怎么维护

技能的编辑源在独立仓库 [Kaczev/write-like-a-person](https://github.com/Kaczev/write-like-a-person)，包内仅存一份随包副本。修改源仓库后，在此仓库根目录执行：

```sh
node scripts/sync-skill.mjs
node scripts/sync-skill.mjs --verify
```

[sync-skill.mjs](./scripts/sync-skill.mjs) 默认读取同级 `../write-like-a-person`，可用 `--from <路径>` 或 `WLAP_REPO` 指定。它同步正文及可选的资源目录，并在 [SOURCE.json](./kaz/skills/write-like-a-person/SOURCE.json) 记录来源和哈希。不要直接编辑包内技能副本。

技能目录的 Loader 表达式使用 `createRequire(baseUrl).resolve('dsh-kazmode/package.json')` 定位已安装包。挂载时 `baseUrl` 是 profile 目录，不能直接拿它拼 `skills/`；改包名时必须同步修改 resolve 参数。

## 验证与发布

在仓库根目录安装开发依赖，再运行：

```sh
npm ci
npm run check
node scripts/sync-skill.mjs --verify
npm pack ./kaz --dry-run
```

[check-version.mjs](./check-version.mjs) 检查本页版本与 [包清单](./kaz/package.json) 一致，并检查发布必需字段。[presets.test.mjs](./tests/presets.test.mjs) 使用 YAML 解析器验证两个 ID、共享对象身份、单处修改同时作用于两版、PTC 原生差异、技能路径和包资源配置。

若有可供 Node 读取的 DSH 源码或解包目录，可设置 `DSH_WEB_APP_DIR` 指向 `@deepseek-ai/dsh-web-app` 包目录，再运行 `npm test`。这会额外逐项比较原生标准与 PTC 插件列表，允许的差异仅为 `persona` 和 `skill-filesystem` 配置。未设置时这两项明确标为跳过；Desktop 的 `app.asar` 不能直接由普通 Node 读取。

仓库根的 [package.json](./package.json) 与锁文件仅供开发测试；实际发布的仍是 [kaz/package.json](./kaz/package.json)，包本身没有新增依赖。发布前还应在 DSH 中安装并分别开新会话，确认两个预设均可挂载、提示词位置正确、技能可加载。详细操作见 [桌面端安装与更新指引](./桌面端安装与更新指引.md)。

## 语义导航约定

沿用项目已有入口；没有约定时使用 `INDEX.md`。索引只写本层职责和相对链接，按任务需要展开。只有用户要求导航工作或任务授权包含文档维护时才创建索引，不为小修改通读全仓库。摘要仅帮助定位，实际文件仍是事实依据；提示词不提供后台索引、过期检测或 token 节省保证。

## 授权

MIT，见 [LICENSE.md](./LICENSE.md)（Copyright (c) 2026 Kaczev）。
