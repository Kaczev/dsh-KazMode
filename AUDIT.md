# AUDIT — safe-json-write (Direction F v1.1)

Every mutation is preceded by a backup under `.dsh/backups/skill-v0.1.0-<timestamp>/`
and recorded here with probe results and rollback commands.

| Time | Stage | Action | Backup | Probe result | Rollback |
| --- | --- | --- | --- | --- | --- |
| 2026-09-02 05:57:44 | 0 | Environment preflight + baseline backup | `.dsh/backups/skill-v0.1.0-20260902-055744/` | All preflight checks True; dsh web HTTP 200 | None needed (no mutation yet) |
| 2026-09-02 06:0x | 1 | Wrote `DESIGN.md`, `CANDIDATE.md`, initial `AUDIT.md` | baseline above | Docs only; no code; evidence list ≥ 2 (BOM accident, pwsh encoding, install safety, four-file model, auto-on, create-plan precedent, current file state) | Delete new docs if rollback needed |
| 2026-09-02 06:1x | 2 | Implemented `lib/core.mjs`, `cli.mjs`, `probe-safe-json-write.mjs` | baseline above | Attempt 1 probe FAILED (async fs misuse); fixed to sync fs; attempt 2 `node --check` clean + `probe-safe-json-write.mjs ALL PASS (14)` + CLI smoke PASS — Gate 2→3 PASS | Delete `KazPlugins/kaz-skill-safe-json/` if rollback needed |
| 2026-09-02 06:2x | 3 | Created active manifest/switch/`versions/v0.1.0/`, `SKILL.md`, `CHANGELOG.md`, plugin `lib/index.js` + `package.json`, `probe-registration.mjs` | `.dsh/backups/skill-v0.1.0-20260902-060150/` | `node --check` clean; JSON valid; skill probe ALL PASS (14) | Delete `KazPlugins/kaz-skill-safe-json/` + profile copy if rollback needed |
| 2026-09-02 06:3x | 3 | Added mount row to `kaz/agent.cordis.yml`, copied plugin to profile KazPlugins, added profile dependency; ran allowed `npm.cmd install` | `.dsh/backups/skill-v0.1.0-20260902-060150/` | Install #1 pruned `@deepseek-ai` runtime tree (194 pkgs) → dsh broken; repair merged dsh runtime deps + peers; install #2/#3 restored tree; `probe-safe-json-write ALL PASS (14)`, `probe-registration ALL PASS (11)`, preflight True | Restore profile `package.json` from `.dsh/backups/skill-v0.1.0-20260902-060709/`, restore `kaz-agent.cordis.yml` from backup, remove profile skill copy + node_modules entry |
| 2026-09-02 06:4x | 3 | Updated `ds安装指引.md` / `ds更新指引.md` (14 dependency lines, no `npm prune`, `@deepseek-ai` repair section) | no file backup needed (docs) | Docs review only | `git checkout -- ds安装指引.md ds更新指引.md` |
| 2026-09-02 07:0x | 3 | Post-restart smoke after Kaczev repaired dsh (web HTTP 200; plugin mock-register; CLI no-BOM; both probes) | none (read-only smoke) | `probe-safe-json-write ALL PASS (14)`, `probe-registration ALL PASS (11)`, `POST_RESTART_SMOKE ALL PASS` — Gate 3→done PASS | n/a |

## Stage 4 — Retirement / rollback procedure (documented, not executed)

No trigger condition currently exists; nothing is retired now.

### Disable (soft)
- `KazPlugins/kaz-skill-safe-json/skills/safe-json-write/switch.json` → `{"enabled": false}` (tool refuses to run).
- Or remove `safe_json_write` from `ka_tool_auto_on_setting.json` and set
  `kaz-skill-safe-json` to `false` in `other-tool-plugin.json`.

### Rollback (remove deployment)
1. Restore `kaz/agent.cordis.yml` from
   `.dsh/backups/skill-v0.1.0-20260902-060150/kaz-agent.cordis.yml` (removes mount row).
2. Remove `"kaz-skill-safe-json": "file:KazPlugins/kaz-skill-safe-json"` from
   `~/.dsh/profiles/web/package.json`.
3. Remove the profile copy `~/.dsh/profiles/web/KazPlugins/kaz-skill-safe-json`
   and the node_modules junction `~/.dsh/profiles/web/node_modules/kaz-skill-safe-json`
   (use `cmd /c rmdir` on the junction only — do NOT touch other node_modules).
4. Restore project storages from baseline backup if desired.
5. Do NOT run pnpm / dsh plugin; do NOT delete profile `KazPlugins` or
   `node_modules` wholesale; do NOT damage `~/.dsh/profiles/node_modules`
   junctions (Kaczev 2026-09-02 warning).

### Retirement trigger conditions (future)
- Skill superseded by another version → write retirement note in CHANGELOG/AUDIT,
  run probe, then remove per above.
- Any gate failure after a change → roll back per above, record, stop, report.

## Notes

- Baseline backup contains: project `other-tool-plugin*.json`, `ka_tool_auto_on_setting.json`,
  project `tool-plugin*.json`, profile `package.json`, `kaz-agent.cordis.yml`.
- Found existing state: project registration JSONs already enable
  `kaz-skill-safe-json` / `safe_json_write`; plan auto-on already lists
  `safe_json_write`. The skill package itself is absent and will be created fresh.
- Safety rule: never `pnpm install` / `pnpm.cmd install` / `dsh plugin ...`;
  only the documented `npm.cmd install` command in the profile web directory.
- Repair note (2026-09-02): the allowed `npm.cmd install` pruned the
  `@deepseek-ai` runtime tree because it was not declared in profile
  `package.json`. Repair merged the global dsh runtime `dependencies` plus
  missing peers into profile `package.json` (now ~169 deps) and re-ran the same
  allowed install; `@deepseek-ai/cordis`, `dsh-tools`, `schemastery`,
  `kaz-memory`, `kaz-skill-safe-json` all resolve again.
- `ds安装指引.md` / `ds更新指引.md` were updated: `kaz-skill-safe-json` added to
  the dependency list, `npm prune` removed from the update guide, and a repair
  section documents the `@deepseek-ai` prune case.
- Web root returned HTTP 400 before the required dsh web restart; after Kaczev's
  repair/restart (2026-09-02) web health is HTTP 200 and the post-restart smoke
  passed — Gate 3→done PASS.
- Kaczev warning (2026-09-02): junctions under `~/.dsh/profiles/node_modules`
  (and nested junctions inside folders there) must never be damaged; do not
  delete/empty them, do not run pnpm/dsh plugin, do not run `npm prune`.
