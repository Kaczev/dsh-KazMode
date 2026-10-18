# dsh-kazmode

给 **DeepSeek Harness（dsh）桌面端**用的 agent preset（代理预设）：标准模式的逐行副本，多一段说话与办事的提示词，并附带 `write-like-a-person` 写作技能。preset id 是 `kaz`，模式列表里显示为 **Kaz 模式**。

## 安装

在桌面端打开 **添加插件**，输入：

```
dsh-kazmode
```

装完在插件页启用，然后**开一个新会话**，模式列表里就会出现 Kaz 模式。命令行等价物是 `dsh plugin add dsh-kazmode`。

更新走「先卸载、再装」：先卸载 `dsh-kazmode`，再装一次。

## 需要什么

- dsh 桌面端，Windows。
- 能连上 npm 或配好的镜像源。
- 没有运行时依赖，不 import 任何 `@deepseek-ai/*`。

## 更多

完整说明、工具面对比和给维护者的约定在仓库里：<https://github.com/Kaczev/dsh-KazMode>。

MIT，Copyright (c) 2026 Kaczev。
