# CHANGELOG — safe-json-write

## v0.1.0 (2026-09-02)

- Initial active version.
- Core: no-BOM UTF-8 JSON write, out-of-bounds rejection, backup, rollback.
- CLI: `--input` / `--json` → `--output`, `--root`, `--space`, `--backup-dir`;
  strips leading BOM from input.
- Probe: `probe-safe-json-write.mjs` ALL PASS (14 checks).
- Plugin: `kaz-skill-safe-json` registers tool `safe_json_write`, honors
  `switch.json`, mounted only in `kaz/agent.cordis.yml`.
- Registration: project four-file model + `kaz_tool_auto_on` plan list.
