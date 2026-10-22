# dsh-kazmode

当前版本 10.0.0。Kaz 是独立叠加插件，不再提供标准/PTC 两份复制预设。

启用后，原来的预设列表保持原名，新会话在模式选择器同一行右侧显示「Kaz 已启用」，已有会话在顶部模式名旁显示 `· Kaz`；同时为所有预设提供一份 Kaz 提示词和 `write-like-a-person` 技能。不修改原生工具组合、预设 ID 或选择器状态。关闭插件可撤销贡献。

标记使用原版 DSH 0.2.1-rc.2 已有的 `conversation.hero.options` 和 `conversation.session.header.actions` 插槽，无需修改或重打包 DSH，不操作 DOM 或替换原生选择器。未绑定会话的空白首页不显示标记。本版尚未发布到 npm；实际位置与窄屏效果仍需视觉验收。

安装：桌面端插件页安装并启用 `dsh-kazmode`；发布后可指定 `dsh-kazmode@10.0.0`。本地开发可直接安装此目录。

从 v9 升级前，请先把默认预设和要继续使用的旧会话切换到原生预设，再卸载旧 bundle、安装新版；不再保留 `kaz` 和 `kaz-ptc` ID。按管理器返回值处理重启或卸载重装，不能假定旧会话会自动迁移。

维护入口：[装配补丁](./cordis.patch.yml)、[宿主入口](./index.js)、[浏览器入口](./client.js)、[提示词](./prompt.md)、[技能副本](./skills/write-like-a-person/SKILL.md)。技能在独立仓库维护，使用主仓库同步脚本更新。

完整提示词（`complete`）预设仍遵循 DSH 自身规则，Kaz 不强行修改。预设层的同名技能优先；没有技能工具的预设不会因此自动获得工具。

完整维护、测试与迁移说明：<https://github.com/Kaczev/dsh-KazMode>。

MIT，Copyright (c) 2026 Kaczev。
