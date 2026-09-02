# safe-json-write — SKILL

Version: v0.1.0 · Status: active · Tool: `safe_json_write` · CLI: `cli.mjs`

## What it does

Safely writes JSON data to a file:

- **No UTF-8 BOM** — output starts with the JSON text itself, so `JSON.parse`
  and dsh loaders never see `Unexpected token '﻿'`.
- **Out-of-bounds rejection** — the target must stay inside the given `root`;
  `../` escapes and absolute paths outside the root are rejected.
- **Backup before write** — previous file content is saved before the target is
  touched (next to the target or in `backupDir`).
- **Rollback on failure** — if the temp write/rename fails, the previous content
  is restored.

## Tool usage (`safe_json_write`)

Required parameters:

- `target` (string): target file path, relative to `root` or absolute inside it.
- `data` (any JSON value): the value to write.

Optional parameters:

- `root` (string, default: workspace cwd): confinement root.
- `space` (integer, default 2): pretty-print indent spaces.
- `backupDir` (string): optional directory for backups.

Result: `{ ok, target, bytes, backup, rolledBack }`.

## CLI usage

```bash
node cli.mjs --input data.json --output out.json --root . --backup-dir backups
node cli.mjs --json '{"a":1}' --output out.json --root .
```

The CLI strips a leading BOM from `--input`/`--json` before parsing, and always
writes output without a BOM.

## Enable / disable

- Skill switch: `switch.json` → `{"enabled": true}`. The tool refuses to run
  when this is not `true`.
- Tool surface: the project four-file model
  (`other-tool-plugin.json`, `other-tool-plugin-catalog.json`) plus
  `kaz_tool_auto_on_setting.json` control whether the tool is visible/enabled.

## Verification

```bash
node --check lib/core.mjs
node --check cli.mjs
node --check probe-safe-json-write.mjs
node probe-safe-json-write.mjs        # expects ALL PASS
node probe-registration.mjs           # after Stage 3 install; expects ALL PASS
```
