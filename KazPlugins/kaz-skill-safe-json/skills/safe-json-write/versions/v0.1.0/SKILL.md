# safe-json-write — 技能文档

版本：v0.1.0 · 状态：active · 工具：`safe_json_write` · CLI：`cli.mjs`

## 功能

安全地把 JSON 数据写入文件：

- **无 UTF-8 BOM**：输出直接从 JSON 文本开始，`JSON.parse` 和 dsh 加载器不会遇到
  `Unexpected token '﻿'`。
- **越界拒绝**：目标必须位于给定的 `root` 内；`../` 逃逸和 root 外的绝对路径都会被拒绝。
- **写前备份**：目标已有内容时，先保存备份（默认在目标旁，或放到 `backupDir`）。
- **失败回滚**：临时写入或改名失败时，自动恢复原内容。

## 工具参数（`safe_json_write`）

必填：

- `target`（string）：目标文件路径，相对于 `root` 或 root 内绝对路径。
- `data`（任意 JSON 值）：要写入的值。

可选：

- `root`（string，默认当前工作目录）：允许写入的根目录。
- `space`（integer，默认 2）：缩进空格数。
- `backupDir`（string）：备份目录。

返回：`{ ok, target, bytes, backup, rolledBack }`。

## CLI 用法

```bash
node cli.mjs --input data.json --output out.json --root . --backup-dir backups
node cli.mjs --json '{"a":1}' --output out.json --root .
```

CLI 会先剥离输入中的 BOM，输出始终不带 BOM。

## 开关

- 技能开关：`switch.json` → `{"enabled": true}`；不是 true 时工具拒绝执行。
- 工具表面：项目四文件模型
  （`other-tool-plugin.json`、`other-tool-plugin-catalog.json`）和
  `kaz_tool_auto_on_setting.json` 控制工具是否可见/启用。

## 验证

```bash
node --check lib/core.mjs
node --check cli.mjs
node --check probe-safe-json-write.mjs
node probe-safe-json-write.mjs        # 期望 ALL PASS
node probe-registration.mjs           # Stage 3 安装后运行；期望 ALL PASS
```
