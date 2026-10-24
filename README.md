# Kaz 模式

给 DeepSeek Harness（DSH）用的独立叠加插件，当前版本 9.2.2。npm 包名 `dsh-kazmode`。

启用 Kaz 后，仍然选择原来的标准、PTC 或其他预设。模式列表保持原名；新会话在模式选择器同一行右侧显示「Kaz 已启用」，已有会话在顶部模式名旁显示「· Kaz」。两处标记统一使用 14px 常规字重；顶部标记使用主题三级文字色，右侧标记使用正文色并另留 12px 内边距，避开输入框圆角。关闭插件后标记消失。Kaz 不再注册 `kaz`、`kaz-ptc` 两份预设，也不复制任何原生工具组合。

## 内容与边界

- [提示词](./kaz/prompt.md)只有一份，作为独立系统提示词段落，位于原生 persona 后、规划等策略段落前，不覆盖原生 persona。
- [写作技能](./kaz/skills/write-like-a-person/SKILL.md)注册到全局技能层，所有预设可用；同名预设层技能仍按 DSH 的规则优先。
- [浏览器入口](./kaz/client.js)只添加状态标记，不改预设 ID、菜单选项或会话状态。
- 完整替换系统提示词（`complete`）的预设遵从 DSH 的完整提示词策略，不强行插入 Kaz。Kaz 不会给没有技能工具的预设补装工具。

## 注入的提示词

[prompt.md](./kaz/prompt.md) 是一套能直接照着做的工作方式：六个板块，首尾各有一句话定回答尺度和约束的优先级。开头压住啰嗦，问题有多重回答就多长，不寒暄、不复述已经说过的话；结尾让用户的明确要求压过前面的少读偏好。

- **规划与执行**：分析和实施由同一个模型在同一条对话里完成，不另派执行者。用户只要方案就停在方案，授权了就直接做完并验证。
- **上下文与索引**：先走项目已有的导航入口，按需展开，不重复读手上已有的内容。
- **语义导航**：约定用 INDEX.md 作为导航入口，索引只写自己的范围并指向更深一层；摘要只是指针，要改文件还是得读原文。
- **视觉设计**：美术、界面、插图、游戏画面默认交付能直接打开的 HTML，写在文档里的描述不算交付；已有设计用小块补丁改，不另起一套。
- **语言与写作**：只有文稿创作、实质性文稿修订或明确要求应用技能时，才在写作阶段加载 [write-like-a-person](https://github.com/Kaczev/write-like-a-person)；普通聊天、代码排查、工作计划与完成摘要不单独触发，已有指令仍在上下文中时不重复加载。技能加载不到时有简短的备用规则，并要求说明没加载成功。
- **执行与验证**：改动限制在授权范围内，跑真实命令验收，确认不了就直说，不把「文件改完了」当成验证过。

这是全局插件：启用时覆盖当前 profile 内的预设，不是另一个可选预设。禁用时撤销提示词、技能和标签注册。已有会话的生效边界仍取决于 DSH 的作用域与模块重载策略。

## DSH 兼容要求

**标记使用原版 DSH 0.2.1-rc.2 已有的 `conversation.hero.options` 与 `conversation.session.header.actions` 插槽，无需修改或重打包 DSH。** 新会话标记位于模式选择器同一行右侧，不紧贴下拉箭头；已有会话标记排在原生模式名之后。未绑定会话的空白首页不提供这些插槽，因此不显示标记。

9.2.2 已发布到 npm。单元测试与运行时插槽检查不能替代实际界面的视觉验收。

## 安装与迁移

使用支持上述接口的 DSH，在插件页安装并启用 `dsh-kazmode`。本地开发安装 [kaz 包目录](./kaz/)，发布后可使用 `dsh-kazmode@9.2.2`。

从 9.0.1 及更早的双预设版本升级前，将默认预设和需要继续使用的旧会话切换到原生标准、PTC 或其他保留的预设，再移除旧 Kaz bundle，安装新版。旧 `kaz`、`kaz-ptc` ID 不保留兼容壳；依赖旧 ID 的会话不要直接假定可恢复。若管理器返回 `restart-required`，按提示重启；返回 `ambiguous-install` 时先卸载再装。

验收：列表无重复 Kaz 预设；新会话同一行右侧显示 `Kaz 已启用`，已有会话的顶部模式名旁显示 `· Kaz`；系统提示词包含一次 Kaz 正文；技能可加载；工具组合、设置同步与 Creator 引导保持原样；禁用后所有 Kaz 贡献消失。详见[安装与更新指引](./桌面端安装与更新指引.md)。

## 维护与验证

npm 的 README 由本文件生成，仅将相对链接改为 GitHub 链接；修改后运行 `node scripts/sync-readme.mjs`，`npm run check` 会检查两份内容是否同步。

[装配补丁](./kaz/cordis.patch.yml)只挂载一个插件。[宿主入口](./kaz/index.js)负责提示词、技能及生命周期；[包清单](./kaz/package.json)维护版本和发布资源。原创[鲸鱼图标](./kaz/icon.svg)继续复用。

技能源在 [Kaczev/write-like-a-person](https://github.com/Kaczev/write-like-a-person)，不要直接修改随包副本：

```sh
node scripts/sync-skill.mjs
node scripts/sync-skill.mjs --verify
```

同步脚本默认读取同级仓库，支持 `--from <路径>` 或 `WLAP_REPO`。[来源记录](./kaz/skills/write-like-a-person/SOURCE.json)保留来源和哈希。

```sh
npm ci
npm run check
node scripts/sync-skill.mjs --verify
npm pack ./kaz --dry-run
```

单元测试覆盖单插件装配、提示词和技能注册/撤销、标签后缀与发布资源；不把模拟测试冒充实际桌面端验证。包无新增运行时依赖，不安装另一套 DSH 或 React。

MIT，见 [LICENSE.md](./LICENSE.md)。
