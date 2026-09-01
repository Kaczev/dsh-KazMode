# DESIGN — safe-json-write seed skill (Direction F v1.1)

## 1. Goal

Deliver exactly ONE executable seed skill, `safe-json-write`, and ONE closed loop
(extract → verify → version → retire). No skill marketplace, no generic skill
runner, no auto batch extraction, no meta-level pipeline.

## 2. The skill

- **Name**: `safe-json-write`
- **Tool**: `safe_json_write` (registered by plugin `kaz-skill-safe-json`)
- **CLI**: `node cli.mjs` inside the skill directory
- **Version**: `v0.1.0`
- **Core behavior**:
  - Writes JSON to a target file as UTF-8 **without BOM** (BOM breaks `JSON.parse`).
  - Rejects writes that escape an allowed root (out-of-bounds rejection).
  - Creates a timestamped backup of the target before writing.
  - On write failure, rolls the target back to its previous content.
  - Optionally accepts `space` for pretty-printing and `root` for confinement.

## 3. Executable module layout (repo = source)

```
KazPlugins/kaz-skill-safe-json/
  package.json                 # plugin package: name kaz-skill-safe-json, type module
  lib/index.js                 # Cordis plugin registering tool safe_json_write
  skills/safe-json-write/
    manifest.json              # name/trigger/entry/dependencies/version/status
    switch.json                # enable/disable switch (enabled: true)
    lib/core.mjs               # pure, testable core logic
    cli.mjs                    # CLI entry (basename check for direct invocation)
    probe-safe-json-write.mjs  # self-contained verification probe
    versions/v0.1.0/           # version snapshot (core + cli + manifest + probe)
    SKILL.md                   # usage docs
    CHANGELOG.md               # change log
```

## 4. Registration (tool surface only, never bypassed)

- Project four-file model in `<repo>/.dsh/storages/`:
  - `other-tool-plugin.json` → `{ "kaz-skill-safe-json": true }`
  - `other-tool-plugin-catalog.json` → `{ "kaz-skill-safe-json": { "safe_json_write": true } }`
  - `kaz_tool_auto_on_setting.json` → `plan.tools` includes `safe_json_write`
- Mount row added ONLY in `kaz/agent.cordis.yml` (repo path is a junction to
  `~/.dsh/.agent-presets/kaz/agent.cordis.yml`), using the proven relative path:
  `../../profiles/web/KazPlugins/kaz-skill-safe-json/lib/index.js`
  (bare package name failed previously with `Cannot find package`).
- Web-level `cordis.patch.yml` is NOT touched.
- Profile copy: `~/.dsh/profiles/web/KazPlugins/kaz-skill-safe-json` is a COPY of
  the repo source; never rely on a junction.
- Profile dependency: add `"kaz-skill-safe-json": "file:KazPlugins/kaz-skill-safe-json"`
  to `~/.dsh/profiles/web/package.json`.

## 5. Install safety (learned from previous dsh breakage)

- NEVER run `pnpm install`, `pnpm.cmd install`, or `dsh plugin ...`.
- The ONLY allowed install command, run in `C:\Users\Kaczev\.dsh\profiles\web`:

```powershell
Remove-Item Env:npm_config_allow_scripts -ErrorAction SilentlyContinue
npm.cmd install --legacy-peer-deps --no-audit --no-fund --prefer-offline
```

- NEVER delete or empty profile `KazPlugins` or `node_modules`.
- Repo `KazPlugins` is the SOURCE; profile `KazPlugins` is a COPY.
  Always copy repo `KazPlugins\*` → profile `KazPlugins`.

## 6. Verification gates

| Gate | Condition |
| --- | --- |
| 2 → 3 | `probe-safe-json-write.mjs` ALL PASS + `node --check` clean |
| 3 → done | Environment preflight True + registration probe PASS + post-restart smoke PASS |

Failure policy: max 2 attempts per failing action, then roll back to the last
stable state, record in AUDIT.md, stop, and report.

## 7. Cost / retry limits

- Total budget ≤ 150k tokens; stop immediately when exceeded, save progress and
  AUDIT entries, report to Kaczev.
- Max 2 attempts per failing action; no unbounded retries.

## 8. State snapshot (2026-09-02, Stage 0)

- Environment preflight: all checks True (repo/profile KazPlugins exist, profile
  KazPlugins is not a junction, `node_modules` and `@deepseek-ai` packages exist,
  `kaz-memory` resolves, `kaz` junction targets agent-presets, dsh web HTTP 200).
- Existing state found: project registration JSONs already contain
  `kaz-skill-safe-json` / `safe_json_write`; `kaz_tool_auto_on` plan list already
  contains `safe_json_write`.
- Missing (to be built in Stages 2–3): repo skill package, plugin `lib/index.js`,
  profile copy, profile dependency, `kaz/agent.cordis.yml` mount row, guides,
  AUDIT entries, post-restart smoke.
- Baseline backup: `.dsh/backups/skill-v0.1.0-20260902-055744/`.
