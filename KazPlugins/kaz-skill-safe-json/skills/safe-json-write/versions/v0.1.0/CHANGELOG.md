# CHANGELOG — safe-json-write

## v0.1.0（2026-09-02）

- 首个 active 版本。
- 核心：无 BOM 的 UTF-8 JSON 写入、越界拒绝、写前备份、失败回滚。
- CLI：`--input` / `--json` → `--output`，支持 `--root`、`--space`、`--backup-dir`；
  自动剥离输入 BOM。
- 探针：`probe-safe-json-write.mjs` ALL PASS（14 项）。
- 插件：`kaz-skill-safe-json` 注册 `safe_json_write`，尊重 `switch.json`，
  只挂载在 `kaz/agent.cordis.yml`。
- 注册：项目四文件模型 + `kaz_tool_auto_on` plan 列表。
- 文档：本包内 README / SKILL / CHANGELOG 均为中文。
