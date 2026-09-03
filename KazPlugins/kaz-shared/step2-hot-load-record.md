# Kaz 6.0 Step 2 — Controlled hot-load probe record

Date (local): 2026-09-03 23:xx
Backup root: `.dsh/backups/kaz50-step2-20260903-233612`
Probe module: `KazPlugins/kaz-shared/lib/hot-load-probe.js`

## Inputs captured from the running profile

- `runtimePluginMountToolAvailable`: **false**
  - Evidence: `C:\Users\Kaczev\.dsh\.agent-presets\kaz\agent.cordis.yml` still disables `tool-cordis` (`disabled: true`), so the Kaz main tool surface exposes no model-facing runtime private-plugin mount channel.
- `pluginHmrAvailable`: **true**
  - Evidence: `@deepseek-ai/cordis-plugin-hmr` is installed in the web profile. This supports config/plugin hot-reload, not a model-controlled private-plugin mount path.
- `privateRegistryRegistrationSupported`: **false**
  - Evidence: no Kaz-visible tool/API that safely registers private plugins from the main task surface was found in the current profile.

## Verdict

`unsupported-from-main-surface`

## Fallback path (required)

New tools/skills take effect **next task or after DSH restart**. Do **not** expand the current Task Surface at runtime while this verdict stands.

## Cache-cost note

No runtime Task Surface expansion is permitted under this path; therefore no cache/prefix invalidation cost is incurred. If a future DSH version exposes a safe mount channel, the supported path allows at most one controlled expansion and requires the cache/prefix cost to be logged before use.
