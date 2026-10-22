# dsh-kazmode

给 **DeepSeek Harness（dsh）桌面端**用的双预设包，当前版本 9.1.0：

- **Kaz 模式**（`kaz`）：标准模式，加上一段说话与办事的提示词，以及 `write-like-a-person` 写作技能。
- **Kaz PTC 模式**（`kaz-ptc`）：PTC 模式，加上同一段提示词和同一个技能。

两个预设保留各自原生的工具组合。PTC 版保留 `mode: ptc` 的工具呈现插件，并按原生 PTC 配置禁用 workflow 两项。

## 安装

在桌面端打开 **添加插件**，输入：

```
dsh-kazmode
```

要指定本版，输入 `dsh-kazmode@9.1.0`。装完启用，再**开一个新会话**，模式列表里会出现两个预设。命令行等价物是 `dsh plugin add dsh-kazmode`。已有会话保留旧的插件版本。

更新按桌面端的安装提示操作；若返回 `ambiguous-install`，先卸载再安装。

## 维护：只改一处

[cordis.patch.yml](./cordis.patch.yml) 同时包含两个预设。标准版中的 `&kaz-persona` 定义提示词配置，`&kaz-skills` 定义技能目录配置；PTC 版通过 `*kaz-persona` 和 `*kaz-skills` 引用。修改锚点中的内容即同时修改两版，不要在 PTC 版复制正文。

技能只有 [skills/write-like-a-person/SKILL.md](./skills/write-like-a-person/SKILL.md) 这一份随包副本。技能正文在独立仓库 `Kaczev/write-like-a-person` 维护，再用主仓库的同步脚本同步一次，两个预设同时使用。

插件列表也分别显示 **Kaz 模式** 与 **Kaz PTC 模式**，各自带有能力说明。展示元数据放在 [标准版资源](./presets/standard/locale/zh.json)和 [PTC 版资源](./presets/ptc/locale/zh.json)，共用原创鲸鱼图标。轻量入口通过[共享注册函数](./presets/shared.js)使用宿主预设服务，不改变提示词、技能或工具组合。

包没有运行时依赖，不 import 任何 `@deepseek-ai/*`；YAML 锚点由 DSH 的 Loader 解析。仓库根的 YAML 测试依赖不随此包发布。

完整维护与验证说明：<https://github.com/Kaczev/dsh-KazMode>。

MIT，Copyright (c) 2026 Kaczev。
