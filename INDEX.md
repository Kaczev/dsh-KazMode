# 项目导航

本仓库维护 Kaz 全局叠加插件、随包提示词与发布检查。这里只列本次已检查的入口，不覆盖本地资料和备份。

## 插件与规则

- [使用说明](README.md)：安装、生效范围与维护命令。
- [包清单](kaz/package.json)：npm 版本、发布资源和运行时入口。
- [宿主入口](kaz/index.js)：注册 Kaz 提示词和写作技能。
- [系统提示词](kaz/prompt.md)：工作偏好、渐进导航、新文件归类、HTML 设计约束与 goal 结束回复前的状态检查。

## 测试与维护

- [根包清单](package.json)：`npm test` 与 `npm run check`。
- [叠加插件测试](tests/overlay.test.mjs)：提示词快照与规则、注册、卸载和技能资源。
- [资源与客户端测试](tests/presets.test.mjs)：装配补丁、发布清单、浏览器标记及清理。
- [文档与导航测试](tests/readme.test.mjs)：导航链接目标、npm README 内容和链接转换。
- [版本检查](check-version.mjs)：README 版本与 npm 包清单一致性、必需发布资源。
- [文档同步脚本](scripts/sync-readme.mjs)：将根 README 同步到 npm 包并转换相对链接。
