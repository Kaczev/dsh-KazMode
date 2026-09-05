# CANDIDATE — kaz-context-runtime (Kaz7.0 M6 runtime tree driver)

Status: v0.3.1 implemented and probed (workflow boundary bridge); formalized
official plugin (v0.3.1) under `KazPlugins/kaz-context-runtime` on 2026-09-05
(moved from KazPrivatePlugins, no behavior change).

## Purpose

- Model-visible tool: **`whale_expand`** (read-only, Stable Main 20th tool).
- The Kaz-only runtime Cordis plugin mirrors real DSH session events into the
  Kaz session tree, closes completed structural boundaries through
  `whaleSummarizer`, persists each tree through `kaz-shared`'s
  `session-tree-store-io`, and exposes read-only tree expansion so compressed
  context can always be expanded back.
- v0.3.1 adds a workflow boundary bridge so `planItem` (level 2) and `goal`
  (level 3) scopes can be opened and closed from ka-whale-workflow signals or
  explicit Kaz boundary events; each `close(planItem)` / `close(goal)` triggers
  the v0.3.0 surface-replace checkpoint.
- One-sentence English purpose: Mirror real DSH user/assistant/tool/injection/
  subagent-report events into a persisted Kaz session tree, close completed
  structural boundaries with a `whaleSummarizer`-produced summary, persist the
  tree, and at structural milestones replace old surface history with the
  newest-branch `render()` profile via the official DSH surface-replace seam,
  while keeping `whale_expand` readable over the complete persisted Session.
- Source path: `KazPlugins/kaz-context-runtime`.
- Mount scope: Kaz preset only (`~/.dsh/.agent-presets/kaz/agent.cordis.yml`);
  profile-global `cordis.patch.yml` is NOT modified.

## Implementation shape

- `package.json` (official, name `kaz-context-runtime`, version `0.3.1`).
- `lib/index.js` — Cordis plugin applying listeners, per-session
  single-flight close/persist/checkpoint pipeline, workflow signal bridge,
  `kazContextBoundary` service provider, and `whale_expand` tool registration.
- `lib/core.mjs` — pure mapping/filter/evidence/render/checkpoint helpers plus
  pure boundary-spec/open-stack/close-order/event helpers (zero Cordis/LLM I/O).
- `README.md`, `CHANGELOG.md`, offline probes.

## Behavior contract (v0.3.1)

- v0.3.0 contract retained: mirror only append-origin session events, filter
  replacement/Kaz-owned events, per-session single-flight close/persist/
  checkpoint, boundary-only surface-replace after structural milestones, replace
  failure containment, `whale_expand` unchanged, Kaz-preset-only mount.
- v0.3.1 boundary bridge:
  - `ctx.provide("kazContextBoundary")` exposes
    `open/close/openPlanItem/closePlanItem/openGoal/closeGoal/status/
    handleBoundaryEvent` plus the convenience `openBoundarySignal/closeBoundarySignal`.
  - Open `planItem` = level 2 scope; open `goal` = level 3 scope. Both persist
    through the existing tree store/commit path.
  - Close is async and runs through the same single-flight
    `whaleSummarizer → close → commit → performSurfaceCheckpoint` pipeline as
    round closes. If nested open scopes remain below the requested boundary
    (e.g. an open round inside a planItem), the service defensively closes them
    first without issuing an intermediate checkpoint, then closes the target
    boundary and emits ONE surface-replace checkpoint.
  - Compatible explicit Kaz boundary events (`kazContextBoundary/open`,
    `kazContextBoundary/close`) arriving on `session/event` are forwarded to the
    service and are never mirrored as tree leaves.
  - Best-effort workflow signal bridge (enabled by default) consumes the live
    `kaWhaleWorkflow` and `goals` services, without reading or modifying public
    plugin files:
    - controlled v0.9 subagent with a role record → open `planItem`;
      subagent stage reaches `end` → close that `planItem`;
    - main-session goal active → open `goal`; goal no longer active →
      close that `goal`.
  - Missing upstream events are listed in this CANDIDATE as 待接清单 and are
    implemented around, not skipped: planItem-done main-session semantics, goal
    close terminal event, and subagent-report ↔ planItemId association. Until
    those upstream events exist, the explicit `kazContextBoundary` API is the
    authoritative completion path for main-line/main-session boundaries.
- Stable Main boundary remains the v0.2.0 20-item surface (`whale_expand`
  present; no tool-list change in v0.3.0/v0.3.1); the 2026-09-05 formalization
  changed only the whale_expand candidate `source` to
  `KazPlugins/kaz-context-runtime` (available/tool behavior unchanged).

## Missing upstream events (待接清单, implemented around — not skipped)

1. **planItem done 主会话语义** — main agent has no event carrying
   "this delegated/main plan item is accepted and complete" on the main
   session. Explicit `kazContextBoundary.closePlanItem` covers it today.
2. **goal close 终态** — ka-whale-workflow transitions stage after goals
   service phase change but does not emit a terminal goal-close event carrying
   the goal id/phase. Goal bridge polls service phase at runtime; explicit
   `closeGoal` covers deterministic completion.
3. **subagent report ↔ planItemId 关联** — DSH subagent-report carries
   `senderSessionId`; planItemId exists only in the child role record, so main
   cannot yet map a received report to its planItemId without extra lookup.
   Explicit API/role-record bridge covers controlled sessions.

## Expected probe commands

- `node --check` on every changed `.js`/`.mjs`.
- `node KazPlugins/kaz-context-runtime/probe-core.mjs`
- `node KazPlugins/kaz-context-runtime/probe-runtime.mjs`
- kaz-shared/kaz-mode Stable Main probes (unchanged regression).
- All probes offline with synthetic DSH events and stubbed
  `whaleSummarizer`/store IO/session surface append.

## Rollback plan

- Migration snapshot (2026-09-05):
  `KazPrivatePlugins/process/kaz-context-runtime/backups/migrate-20260905-233657/`
  contains the pre-move plugin folder, profile package/locks,
  `node_modules/.package-lock.json`, Kaz `agent.cordis.yml`, and
  `kaz-agent-managed-tools.json`. To undo migration: restore those snapshots;
  remove the `node_modules/kaz-context-runtime` junction; move
  `KazPlugins/kaz-context-runtime` back to
  `KazPrivatePlugins/kaz-context-runtime`; recreate the junction.
- Restore pre-change backups under
  `KazPrivatePlugins/process/kaz-context-runtime/backups/v0.3.1-pre-20260905-230555/`
  (plugin folder, Kaz preset, pnpm lockfile) to undo v0.3.1.
- Full v0.3.0 rollback baseline remains
  `KazPrivatePlugins/process/kaz-context-runtime/backups/v0.3.0-20260905-225343/`.
- Re-enable `compaction-basic.auto` if preset rollback is required.
- Remove `whale_expand` from `KAZ_V09_MAIN_TOOLS`, candidate registry, and
  plugin tool registration only if full v0.2.0 boundary rollback is required.
- Remove the Kaz-preset mount row and profile dependency only if full runtime
  rollback is required.
- Remove `node_modules/kaz-context-runtime` junction if created (junction only).
- Delete `KazPlugins/kaz-context-runtime` (and process docs) if full
  removal rollback is required. Tree index deletion is limited to
  `~/.dsh/storages/kaz-context/`; DSH raw session logs remain authoritative.

## Result history

- 2026-09-05 formalized: moved to `KazPlugins/kaz-context-runtime`, removed
  `private:true`, synced profile dependency/lockfile/junction/Kaz-preset path,
  whale_expand candidate source changed to `KazPlugins/kaz-context-runtime`;
  no behavior/tool-surface change.
- v0.3.0: persistent surface replacement integration; generic planItem/goal
  checkpoint path pure-tested, live planItem/goal boundary inference deferred.
- v0.2.0: M6 Stable Main version boundary + read-only `whale_expand`.
- v0.1.0: initial model-invisible runtime driver (no tool, no replace).
