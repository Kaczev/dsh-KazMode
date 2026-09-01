# CANDIDATE — safe-json-write (Direction F v1.1)

Status: candidate (Stage 1 complete; no code written in this stage).

## Decision

Implement the seed skill `safe-json-write` as a Cordis plugin `kaz-skill-safe-json`
that registers tool `safe_json_write`, plus a self-contained skill directory with
core logic, CLI, verification probe, manifest, switch, and `versions/v0.1.0`.

## Concrete evidence (≥ 2 required; listed below)

1. **BOM breaks JSON parsing (memory `d863da6a`)** — dsh failed to load with
   `plugin tree failed to load` / `Unexpected token '﻿'` because a `package.json`
   was saved with a UTF-8 BOM. Conclusion: the skill MUST write JSON without BOM
   and must verify byte-level no-BOM output.
2. **PowerShell encoding trap (memory `1ba56aad`)** — `Set-Content -Encoding UTF8`
   writes a BOM; JSON files must be written with .NET `UTF8Encoding($false)` or
   Node `writeFileSync(..., 'utf8')`. Conclusion: CLI/core use Node `utf8` writes,
   and the probe checks first bytes.
3. **dsh install safety (memory `bf52cfd7`)** — profile `KazPlugins` is a COPY,
   not a junction; `node_modules` `file:` deps are junctions into profile
   `KazPlugins`; pnpm removes the `@deepseek-ai` junction and does not install
   peers. Conclusion: copy repo → profile, add `file:` dependency, and use ONLY
   `npm.cmd install --legacy-peer-deps --no-audit --no-fund --prefer-offline`.
4. **Tool control panel four-file model (memory `27d17e28`)** — external plugin
   enable/tool dictionaries live in `other-tool-plugin.json` /
   `other-tool-plugin-catalog.json`; project-level overrides live in
   `<repo>/.dsh/storages/`. Conclusion: register `kaz-skill-safe-json` and
   `safe_json_write` there (already present from prior partial work).
5. **kaz_tool_auto_on (memory `19523de6`)** — plan-mode auto-on list can include
   extra tools via `ka_tool_auto_on_setting.json`. Conclusion: add
   `safe_json_write` to `plan.tools` (already present).
6. **create-plan plugin precedent (file read)** — `KazPlugins/create-plan` is a
   minimal ESM Cordis plugin using `defineTool` + `ctx.tools.register`, mounted in
   `kaz/agent.cordis.yml`. Conclusion: mirror this pattern for `safe_json_write`.
7. **Current repo/profile state (file reads, 2026-09-02)** — project
   `other-tool-plugin.json` already contains `"kaz-skill-safe-json": true`;
   `other-tool-plugin-catalog.json` already contains
   `"safe_json_write": true`; `ka_tool_auto_on_setting.json` plan list already
   contains `safe_json_write`; profile `package.json` does NOT yet list the
   dependency; no `kaz-skill-safe-json` directory exists in repo or profile.
   Conclusion: registration is pre-seeded; we must still build the package, mount
   row, profile copy/dependency, install, guides, and smoke.

## Candidate acceptance criteria

- Gate 2→3: `node --check` clean on core/CLI/probe; probe ALL PASS.
- Gate 3→done: environment preflight True; registration probe PASS; post-restart
  smoke PASS.
- No pnpm / dsh-plugin command used at any point.
- No web-level `cordis.patch.yml` change.
