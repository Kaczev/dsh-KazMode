# kaz-skill-safe-json — safe-json-write 技能包

> 版本：v0.1.0 · 状态：active · 工具：`safe_json_write` · CLI：`cli.mjs`

## 这是什么

这是一个可执行的种子技能包：**安全地写 JSON 文件**。

它保证：

- **无 BOM**：输出是标准 UTF-8（不带 BOM），不会被 `JSON.parse` 或 dsh 加载器报
  `Unexpected token '﻿'`。
- **越界拒绝**：目标文件必须落在指定的 `root` 目录内；`..` 逃逸或 root 之外的绝对路径都会被拒绝。
- **写前备份**：覆盖已有文件前，会先保存一份带时间戳的备份。
- **失败回滚**：写入/改名失败时，自动把原文件内容恢复回来。

## 包结构（和别的 Kaz 插件一样自包含）

```text
KazPlugins/kaz-skill-safe-json/
├── README.md                  # 本文件（中文）
├── package.json               # 插件包声明
├── lib/
│   └── index.js               # Cordis 插件：注册 safe_json_write 工具
└── skills/
    └── safe-json-write/
        ├── manifest.json      # 技能清单（name/trigger/entry/dependencies/version/status）
        ├── switch.json        # 开关：{"enabled": true}
        ├── SKILL.md           # 技能使用文档（中文）
        ├── CHANGELOG.md       # 变更记录（中文）
        ├── lib/
        │   └── core.mjs       # 核心逻辑（纯 ESM，可测试）
        ├── cli.mjs            # 命令行入口
        ├── probe-safe-json-write.mjs  # 核心功能探针
        ├── probe-registration.mjs     # 注册/部署探针
        └── versions/
            └── v0.1.0/        # 本版本快照
```

## 工具用法（`safe_json_write`）

必填参数：

- `target`（string）：目标 JSON 文件路径，相对于 `root`，或 root 内的绝对路径。
- `data`（任意 JSON 值）：要写入的数据。

可选参数：

- `root`（string，默认工作目录）：允许写入的根目录，目标不能逃出它。
- `space`（integer，默认 2）：缩进空格数。
- `backupDir`（string）：备份目录；不填则备份在目标文件旁边。

返回：`{ ok, target, bytes, backup, rolledBack }`。

## CLI 用法

```bash
node cli.mjs --input data.json --output out.json --root . --backup-dir backups
node cli.mjs --json '{"a":1}' --output out.json --root .
```

CLI 会先去掉输入里的 BOM 再解析，输出永远不带 BOM。

## 开关

- `skills/safe-json-write/switch.json`：`{"enabled": true}` 时工具可用；改成
  `false` 后工具会拒绝执行。
- 工具是否出现在模型工具面，由工具控制面板的四文件模型和
  `kaz_tool_auto_on` 控制（本包已注册好，一般不用手动改）。

## 验证

```bash
node --check lib/core.mjs
node --check cli.mjs
node --check probe-safe-json-write.mjs
node probe-safe-json-write.mjs     # 期望 ALL PASS
node probe-registration.mjs        # 部署后运行，期望 ALL PASS
```

## 相关过程文档（不在本包内，解释给你看）

仓库的 `不入库文件/safe-json-write/` 文件夹里有三个“过程文档”，不是运行时功能，
只是执行闭环的留痕，因此放在不入库目录里管理：

- `DESIGN.md`：**设计方案**。记录为什么做 safe-json-write、怎么挂载、验证门是什么。
- `CANDIDATE.md`：**候选证据**。记录 Stage 1 收集到的证据，以及为什么选这个方案。
- `AUDIT.md`：**审计日志**。记录每一步改动、备份路径、探针结果和回滚命令。

这三份文件可以随时删除，不影响本技能包运行。
