# CANDIDATE — whale-summarizer (Kaz7.0 whale_summarizer internal service)

Status: formalized official plugin (v0.1.0) under `KazPlugins/whale-summarizer`;
moved from KazPrivatePlugins on 2026-09-05, no behavior change.

## Purpose

- Proposed model-visible tool name(s): **none**.
  This is an internal Cordis service (`ctx.provide("whaleSummarizer")`),
  model-invisible by design; no candidate-registry tool entry is created.
- One-sentence English purpose: Summarize a Kaz tree boundary's direct-child
  semantic evidence with an auxiliary LLM call, returning a source-attributed
  block summary for close/promote.
- Source path: `KazPlugins/whale-summarizer`.
- Mount scope: Kaz preset only (`~/.dsh/.agent-presets/kaz/agent.cordis.yml`);
  profile-global `cordis.patch.yml` is NOT modified.

## Implementation shape

- `package.json` (official, name `whale-summarizer`, version `0.1.0`).
- `lib/index.js` — Cordis plugin publishing the service + Kaz scope gate.
- `lib/core.mjs` — pure validation, prompt construction, source-id resolution,
  retry/error policy.
- `lib/llm-call.mjs` — one-shot `ctx.llm.stream` call with `BlockAssembler`.
- `README.md`, `CHANGELOG.md`, probes.

## Expected probe commands

- `node --check` on every changed `.js`/`.mjs`.
- `node KazPlugins/whale-summarizer/probe-core.mjs`
- `node KazPlugins/whale-summarizer/probe-service.mjs`
- `node KazPlugins/whale-summarizer/probe-registration.mjs`
- All probes offline with stubbed llm/kazMode.

## Rollback plan

- Migration snapshot (2026-09-05):
  `KazPrivatePlugins/process/whale-summarizer/backups/migrate-20260905-233657/`
  contains the pre-move plugin folder, profile `package.json`,
  `package-lock.json`, `pnpm-lock.yaml`, `node_modules/.package-lock.json`,
  Kaz `agent.cordis.yml`, and `kaz-agent-managed-tools.json`.
- To undo the migration: restore those snapshots; remove the
  `node_modules/whale-summarizer` junction; move
  `KazPlugins/whale-summarizer` back to `KazPrivatePlugins/whale-summarizer`;
  recreate the junction to the private path.
- Delete `KazPlugins/whale-summarizer` (and this CANDIDATE/process docs) only
  if a full removal rollback is required.

## Result (v0.1.0)

Implemented and registered 2026-09-05. `node --check` clean; probe-core ALL
PASS (12); probe-service ALL PASS (10); probe-registration ALL PASS (10);
JSON valid; Kaz-preset row added; profile dependency added and installed;
profile-global/non-Kaz mounts untouched; no candidate-registry tool entry.
- 2026-09-05 formalized: moved to `KazPlugins/whale-summarizer`, removed
  `private:true`, synced profile dependency/lockfile/junction/Kaz-preset path;
  no behavior/tool-surface change.
