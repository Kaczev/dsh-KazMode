# Kaz 6.0 Step 3 — Goal 恢复修复记录

> **历史记录提示（v0.8 Step B2 后）**：本文记录的是 Step 3 当时的实现快照。
> `kaz_tool_auto_on` / `whaleStageOf` / “whale auto-on”已随 v0.8 Step B2 整体退役，
> 该节描述不再代表当前 Kaz 运行机制，仅作历史上下文保留。
>
> Step 3 target from `不入库文件/Kaz5.0与6.0更新规划/描述v0.4.md` §9.3 / §13 Step 3
> and bug/rollback context `BUG-20260903-001` (already fixed in `039f7dd`).
> Backup root: `.dsh/backups/kaz50-step3-20260903-235046`.

## 1. What changed

- `KazPlugins/ka-whale-workflow/lib/index.js`
  - New exported pure helpers: `currentGoalOf`, `hasDirectHumanInOpenTurn`,
    `goalRecoveryNeededOf`.
  - New `GOAL_RECOVERY_STAGE = "goal-recovery"` and `GOAL_RECOVERY_PROMPT`.
  - `whale_report({mode:'goal'})` now:
    - creates only when there is no goal or the current goal is `complete`;
    - resumes an existing non-complete goal via `goals.resume` on a direct human
      turn when rounds remain;
    - rejects with structured guidance when rounds are exhausted or a different
      objective is supplied (no silent create/edit/clear).
  - New `goal-recovery` turn-start branch: a real human message after
    `blocked` / `paused` / disarmed-active does **not** blindly re-enter task
    reconstruction; the model confirms “continue original Goal / new task / end”
    with `ask_user_question`.
  - `whale_report` in `goal-recovery`: `mode:'goal'` resumes and returns to
    `done`; no mode starts a normal new task via reconstruction.
  - Classification prompt now prefixes existing-goal
    `phase / roundsStarted / maxGoalRounds / objective / blockedReason`.
- `KazPlugins/kaz-mode/lib/index.js`
  - `whaleStageOf` recognizes `goal-recovery`;
  - whale auto-on exposes `whale_report` during `goal-recovery`.
- `KazPlugins/ka-whale-workflow/probe-goal-guard.mjs`
  - Updated Step 3 semantics: paused/blocked now enter `goal-recovery`.
- `KazPlugins/ka-whale-workflow/probe-step3-goal-recovery.mjs`
  - New Step 3 probe suite (27 checks).

## 2. Validation

- Full profile probe suite: **29/29 PASS** (Step 2 close was 28; +1 new Step 3
  probe file).
- `node --check`: **61 files** OK (Step 2 close was 60; +1 new probe file).
- Hard boundaries unchanged:
  - physical-deletion rules / maintenance-subagent approval guard;
  - subagent tool whitelist projection;
  - panel 4 components + external tool add channel;
  - `KAZ_TOOL_UNIVERSE` fixed;
  - `ka-whale-memory` naming preserved.

## 3. Restart-required items (pending restart)

1. **Step 3 runtime activation**: `ka-whale-workflow` and `kaz-mode` profile
   copies are synced, but the running DSH process still loads the old code.
   Restart DSH to activate `goal-recovery` routing and the new
   `whale_report` existing-goal handling.
2. **Step 2 maintenance subagent wiring (already known)**: the preset
   `~/.dsh/.agent-presets/kaz/agent.cordis.yml` still does not contain the
   `tool-subagent-maintenance` block from `step2-runtime-config.md`; after
   applying it, restart and verify `maintenance_subagent` registration.

No new tools were hot-mounted; no runtime Task Surface expansion was made.
