# Kaz 模式

Kaz 为 DeepSeek Harness（DSH）添加一套日常工作偏好：默认用中文，直接回答，在用户授权后把实施和验证做完；写文章或修改文稿时，再按需加载写作技能。

当前版本 9.2.2。支持 **DSH v0.2.1-rc.3 及以上版本**，npm 包名为 `dsh-kazmode`。

## Kaz 会改变什么

启用后，你仍然选择原来的标准、PTC 或自定义预设。Kaz 在这些预设之上叠加提示词和技能，不新增一套工具，也不替换原生预设。

[完整提示词](https://github.com/Kaczev/dsh-KazMode/blob/main/kaz/prompt.md)约定了具体的工作方式：

- **回答按问题的分量来写。** 简单问题简短回答，复杂问题再展开；省去寒暄、复述和空泛评价，不确定时直接说明。
- **按授权范围办事。** 只要分析或方案，就停在分析或方案；已经授权实施，就在同一条对话里完成改动和验证，不另设规划者到执行者的交接，也不自行切换模型或思考强度。
- **按需读取项目。** 优先沿已有索引定位，只展开相关分支；需要编辑或确认行为时仍要读原文件。用户明确要求完整阅读时，以用户要求为准。
- **让视觉设计有可用的原稿。** 界面、美术等任务默认交付可直接渲染的 HTML；后续实现以同一份设计为依据，不靠文字重新猜一套样式。
- **用真实检查验收。** 保留无关改动和既有约束，运行项目实际的检查命令，交付时说明改了什么、验证了什么、还有什么没确认。

这些是给模型的工作指令，实际执行仍受所选模型、预设、权限和可用工具约束。

### 写作技能

Kaz 随包提供 [write-like-a-person](https://github.com/Kaczev/dsh-KazMode/blob/main/kaz/skills/write-like-a-person/SKILL.md)，用于文章、演讲、文档等文稿创作和实质性修订。技能要求先明确读者和用途，再检查文章结构、句子的主语和指代、事实与推测的区分，以及结尾是否只是在重复正文。

普通聊天、代码排查、工作计划和完成摘要不会仅因包含自然语言就触发技能。进入写作阶段，或用户明确要求应用技能时，才加载全文；指令还在上下文中时不重复加载。

## 安装与使用

1. 在 DSH 桌面端的插件页添加 `dsh-kazmode` 并启用。需要固定当前版本时，输入 `dsh-kazmode@9.2.2`。
2. 新建会话，照常选择标准、PTC 或其他预设，无须寻找额外的 Kaz 预设。
3. 已绑定会话的新会话界面会显示「Kaz 已启用」，已有会话顶部会显示「· Kaz」。未绑定会话的空白首页可能不显示标记。

本地开发可安装 [kaz 包目录](https://github.com/Kaczev/dsh-KazMode/tree/main/kaz/)。更新或重新安装后，按插件管理器的返回结果操作：`restart-required` 表示需要重启；遇到 `ambiguous-install`，先卸载再安装。不要假定所有已有会话都会立即采用新版本。

**从 9.0.1 及更早版本迁移：** 先把默认预设及需要继续使用的旧会话切换到原生标准、PTC 或其他保留预设，再卸载旧 Kaz、安装新版。新版不再注册 `kaz`、`kaz-ptc`，也不自动迁移依赖这些 ID 的旧会话。

## 生效范围

Kaz 是当前 profile 的全局叠加插件。[宿主入口](https://github.com/Kaczev/dsh-KazMode/blob/main/kaz/index.js)将偏好放在原生 persona 之后、规划策略之前，并注册写作技能；[浏览器入口](https://github.com/Kaczev/dsh-KazMode/blob/main/kaz/client.js)添加启用标记。原生 persona、模式菜单和预设的工具组合保持不变。

- 使用完整系统提示词（`complete`）的预设按 DSH 自身的装配规则处理，Kaz 不强行插入偏好。
- 技能注册不等于增加技能工具：预设没有技能加载工具时，Kaz 不会代为补装。同名技能的优先级遵循 DSH 的作用域规则。
- 禁用后，Kaz 注册的提示词、技能和界面标记会撤销；若其他来源也提供同名技能，该技能仍可能可见。

检查是否正常生效时，除了看界面标记，还应确认系统提示词中只有一份 Kaz 正文、写作技能可以加载、切换预设后的工具组合没有变化。

## 维护

发布内容位于 [kaz 包目录](https://github.com/Kaczev/dsh-KazMode/tree/main/kaz/)，版本与资源清单以[包清单](https://github.com/Kaczev/dsh-KazMode/blob/main/kaz/package.json)为准，[装配补丁](https://github.com/Kaczev/dsh-KazMode/blob/main/kaz/cordis.patch.yml)只负责挂载一个叠加插件。

修改根 README 后，用同步脚本更新 npm 包内的文档；脚本会把仓库相对链接转为 GitHub 链接。在仓库根目录运行：

```sh
npm ci
node scripts/sync-readme.mjs
npm run check
npm pack ./kaz --dry-run
```

检查覆盖版本一致性、README 同步、提示词和技能的注册与撤销、浏览器标记及发布资源。单元测试使用模拟宿主，实际桌面端的显示和会话加载仍需在 DSH 中确认。

写作技能来自独立仓库 [Kaczev/write-like-a-person](https://github.com/Kaczev/write-like-a-person)。修改技能源后再同步，不直接编辑随包副本：

```sh
node scripts/sync-skill.mjs
node scripts/sync-skill.mjs --verify
```

[技能同步脚本](https://github.com/Kaczev/dsh-KazMode/blob/main/scripts/sync-skill.mjs)默认读取同级的技能仓库，也支持 `--from <路径>` 或 `WLAP_REPO`。[来源记录](https://github.com/Kaczev/dsh-KazMode/blob/main/kaz/skills/write-like-a-person/SOURCE.json)保存来源提交和内容哈希。

## 许可

本项目采用 [MIT 许可](https://github.com/Kaczev/dsh-KazMode/blob/main/LICENSE.md)。
