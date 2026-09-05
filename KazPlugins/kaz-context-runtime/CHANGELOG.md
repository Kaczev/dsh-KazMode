# CHANGELOG — kaz-context-runtime

## v0.3.1 (2026-09-05)

- Workflow boundary bridge: planItem/goal open-close is no longer deferred.
  `planItem` = level 2, `goal` = level 3.
- `ctx.provide("kazContextBoundary")`: internal open/close/status API plus
  `handleBoundaryEvent`; compatible `session/event` types
  `kazContextBoundary/open|close` are forwarded and never mirrored.
- Close routes through the existing single-flight
  `whaleSummarizer → close → commit → surface-replace checkpoint` pipeline.
  Nested open scopes below the target are closed first without intermediate
  checkpoints; the target boundary close issues one surface-replace.
- Best-effort workflow signal bridge (no public plugin/file changes): controlled
  v0.9 subagent role record + stage signal opens/closes planItem; goals service
  phase opens/closes goal.
- Missing upstream events listed as 待接清单, not skipped: planItem-done
  main-session semantics, goal-close terminal event, subagent report ↔
  planItemId association. Explicit `kazContextBoundary` API is the completion
  path until those upstream events exist.
- Probes now cover real chains: planItem complete → level2 close → replace;
  Goal complete → level3 close → replace; explicit service and compatible event
  paths; signal-bridge auto open/close.
- No Stable Main / tool-list / candidate-registry change; no DSH core change;
  Kaz-preset-only mount retained.

## v0.3.0 (2026-09-05)

- Persistent surface replacement integration: after a structural milestone
  (close `planItem`/`goal` or an auto-sublime of round blocks), the driver
  appends ONE Kaz-owned `user/message` checkpoint via the official DSH
  `surfaceOp: { op: "replace" }` seam; content = `render()` newest-branch
  profile text, `sourceEventSeqs` = full shadowed surface prefix.
- Checkpoint runs inside the same per-session single-flight section as
  close/persist; boundary-only and prefix-only; skips while a foreign DSH
  `compaction/start…end` bracket is live.
- Replace failure is contained (atomic DSH append leaves original history
  intact; tree close stays committed; no user-turn error; retried at next
  milestone).
- Kaz preset `compaction-basic` set to `auto:false` so stock auto pressure
  compaction does not fight the Kaz boundary replace.
- Pure core helpers added and probes extended: capture → render → replace →
  expand → scope/rollback coverage; original leaves remain readable through
  `whale_expand` from the full persisted Session after replacement.
- No DSH core / kaz-shared / kaz-mode / Stable Main / candidate-registry
  changes in this update (Stable Main stays at the v0.2.0 20-item boundary).

## v0.2.0 (2026-09-05)

- M6 version boundary: registers read-only Stable Main tool `whale_expand`.
- `whale_expand` wraps `kaz-shared/lib/session-tree-expand.js` over the full
  persisted Session: `path` required, optional `limit`/`cursor`, no DSH append,
  no tree/store writes.
- Added `whale_expand` to `KAZ_V09_MAIN_TOOLS`/`KAZ_STABLE_MAIN_TOOLS`
  (Stable Main 19 → 20) and to `kaz-agent-managed-tools.json` candidates.
- kaz-shared/kaz-mode probes/docs updated to the 20-item boundary.

## v0.1.0 (2026-09-05)

- Initial private runtime driver under KazPrivatePlugins (formalized under
  KazPlugins on 2026-09-05).
- Mirrors append-origin DSH surface events into a persisted Kaz session tree.
- Closes completed round boundaries via whaleSummarizer at turn-stopping with a
  turn/end completed fallback.
- Contains summary failures (pending + pre-step retry), never turns a completed
  user turn into an error.
- No tool surface, no candidate entry, no real DSH messages replacement.
- Mounted only in the Kaz preset.
