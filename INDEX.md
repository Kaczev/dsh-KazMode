# 项目导航

本仓库维护 Kaz 全局叠加插件、随包提示词与发布检查。这里只列本次已检查的入口，不覆盖本地资料和备份。

## 插件与规则

- [使用说明](README.md)：安装、生效范围与维护命令。
- [包清单](kaz/package.json)：npm 版本、发布资源和运行时入口。
- [宿主入口](kaz/index.js)：注册 Kaz 提示词和三个随包技能。
- [系统提示词](kaz/prompt.md)：五部分工作规则：目标决策、授权澄清、实施验证、项目导航与文件管理，以及 HTML、写作和 goal 条件协议。

## 技能

- [技能目录](kaz/skills/INDEX.md)：自动化恢复、Windows 专项操作与写作。
- [七方向归属](docs/skill-catalog.md)：跨仓库单一来源、整理与安装边界。
- [技能回归](tests/skills.test.mjs)：全目录注册卸载、frontmatter 和通用政策边界。

## 测试与维护

- [9.4.0 发布说明](docs/release-v9.4.0.md)：五技能更新与真实宿主验收记录。

- [根包清单](package.json)：`npm test` 与 `npm run check`。
- [叠加插件测试](tests/overlay.test.mjs)：提示词快照与规则、注册、卸载和技能资源。
- [资源与客户端测试](tests/presets.test.mjs)：装配补丁、发布清单、浏览器标记及清理。
- [文档与导航测试](tests/readme.test.mjs)：导航链接目标、npm README 内容和链接转换。
- [版本检查](check-version.mjs)：README 版本与 npm 包清单一致性、必需发布资源。
- [文档同步脚本](scripts/sync-readme.mjs)：将根 README 同步到 npm 包并转换相对链接。

- [9.5.1 发布说明](docs/release-v9.5.1.md)：当前状态使用说明重写与文档补丁验收。
- [9.5.0 release notes](docs/release-v9.5.0.md): five-part prompt revision, three retained skills and verification scope.
- [9.4.1 release notes](docs/release-v9.4.1.md): English skill documentation and verification scope.
