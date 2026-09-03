# Kaz 6.0 Step 4 — Cache & noise acceptance record (v0.4 §13 / C20)

> Produced by Whale 25 during Step 4.
> Backup root: `.dsh/backups/kaz50-step4-20260904-001643`.
> Kaczev direction (2026-09-04): use **existing DSH session logs** as the
> reproducible metric source; do **not** implement the workflow-surface refactor
> yet — produce an `.md` discrepancy/change-needs list for Whale 22/23 planning.

## 1. Prerequisites (confirmed)

- Repo `dsh-KazMode`, branch `main`, commit `3b53761` (Step 3), working tree
  clean except ignored handoff files.
- DSH was restarted after the Step 3 commit (node process start
  `2026-09-04 00:04`, Step 3 commit `2026-09-04 00:01`).
- Step 3 smoke suite: **29/29 probes PASS** and `node --check` **61 files OK**
  before any Step 4 edits.
- KazPlugins repo <-> profile web copies were identical at start.
- Step 2 `maintenance_subagent` preset block is **still not present** in
  `kaz/agent.cordis.yml`; remains a restart-required/pending item (not part of
  Step 4 scope).

## 2. Metric source and method

- Source: DSH session logs `%USERPROFILE%\.dsh\sessions\...\session.jsonl.zstd`
  (concatenated Zstandard frames).
- Each `request/header` event carries the actual system text + tool schemas used
  for a model request; consecutive headers with the same tool-name set are
  merged into one surface snapshot.
- Each `assistant/message`/`usage` event reports disjoint usage:
  `inputTokens` = uncached prompt tokens, `cacheReadTokens` = cache-hit prompt
  tokens (DSH `dsh-llm-deepseek` mapUsage). Cache ratio =
  `cacheRead / (input + cacheRead)`.
- Schema-token estimate mirrors `@deepseek-ai/dsh-token-meter`:
  `ceil(JSON.stringify(tools).length / 4) + 4`.
- Analysis scripts are local-only: `.dsh/step4/{analyze-log,steps-table,transition-first-hit,list-sessions}.mjs`
  + `metric-*.json` / `*.tsv`. They are ignored by git; commands are listed in
  the discrepancy file.

## 3. Representative session selection

| Label | Session | Why |
|---|---|---|
| Ordinary control A | `dsh-KazMode` `45063914` (router-standard) | non-Kaz, large session |
| Ordinary control B | `dsh-KazMode` `5f9a4848` (router-standard) | non-Kaz, large session |
| Kaz pre-Step1 | `437459e6` | Kaz 4.4.8-era session before Step 1 |
| Kaz Step1 impl | `21f3a06c` | Step 1 execution session |
| Kaz Step2 impl | `86f8c544` | Step 2 execution session |
| Kaz Step3 impl | `de0019f5` | Step 3 execution session |

> Note: Step1/2/3 sessions were recorded while implementing each step, so their
> surfaces reflect the runtime at that moment (Step2 session still shows
> `memory_save/update/forget` before the Step2 final runtime shape).

## 4. Cache hit/miss and rounds

| Session | Preset | Turns | Assistant steps | Tool calls | Unique surfaces | Surface transitions | Cache hit % | Uncache in | Cache read |
|---|---|---|---|---|---|---|---|---|---|
| Ordinary A `45063914` | router-standard | 27 | 294 | 284 | 2 | 1 | 99.73 | 184,187 | 67,869,824 |
| Ordinary B `5f9a4848` | router-standard | 10 | 455 | 473 | 2 | 1 | 99.49 | 508,002 | 99,623,040 |
| Kaz pre-Step1 `437459e6` | kaz | 1 | 315 | 315 | 5 | 4 | 87.64 | 780,961 | 5,536,451 |
| Kaz Step1 `21f3a06c` | kaz | 2 | 373 | 413 | 9 | 8 | 97.83 | 2,938,603 | 132,360,192 |
| Kaz Step2 `86f8c544` | kaz | 4 | 92 | 131 | 5 | 4 | 96.43 | 425,258 | 11,489,536 |
| Kaz Step3 `de0019f5` | kaz | 8 | 159 | 201 | 5 | 4 | 98.05 | 545,871 | 27,436,032 |

Rounds = `turn/start` events. The high overall Kaz percentages come from very
long stable runs after the last expansion; the **first request after every
surface change still misses almost completely**, see §6.

## 5. Tool-surface snapshots and schema tokens

Surface sequence from the most representative current-shape session
(`de0019f5`, Step 3):

| # | Tool count | Tools (compact) | Schema tokens | System tokens |
|---|---|---|---|---|
| 1 | 1 | `memory_search` | 282 | 96 |
| 2 | 9 | `ask_user_question, glob, grep, memory_detail, memory_list, memory_search, read, web_search, whale_report` | 1,932 | 384 |
| 3 | 1 | `whale_report` | 311 | 671 |
| 4 | 16 | base + memory reads + `enable_tool` + `safe_json_write` + `get_goal/update_goal` (goal mode) | 4,215 | 361 |
| 5 | 14 | same without `get_goal/update_goal` (goal ended) | 3,850 | 96 |

Other sampled Kaz sessions have 13–19 tools in their Task Surface snapshots and
schema-token estimates ~1,276–5,669.

### KAZ_BASE_TOOLS budget review point

- Design `KAZ_BASE_TOOLS` (v0.4 K2): **12** fixed entries
  (`ask_user_question/edit/glob/grep/memory_detail/memory_list/memory_search/pwsh/read/todo_write/web_search/write`).
- Runtime `BASE_TOOLS` (`kaz-shared/lib/task-tool-selection.js`): **10** entries
  (`BASE_TOOLS` without memory read tools, includes `enable_tool`); memory read
  tools are added by `baseToolNames({ memoryEnabled: true })` → 13 with memory on.
- Step3 final Task Surface: 14 tools = runtime base 13 (memory on) +
  `safe_json_write` optional (1). Optional count = 1 ≤ 6, so no budget warning.
- `KAZ_BASE_TOOLS` 12-item audit conclusion: **keep as the design-side 12-item
  baseline**; no code change made in Step 4. The real per-task “optional count”
  must be computed as `Task Surface − runtime base − mode-scoped`, not as
  `Task Surface − KAZ_BASE_TOOLS`, because `enable_tool` is runtime base-only and
  memory read tools are conditional.

## 6. First-step cache cost after each surface change

| Session | Surface transition | Tools before → after | First step after change cache % | Later avg on same surface % |
|---|---|---|---|---|
| Ordinary A `45063914` | initial → full | 2 → 29 | 44.48 | 99.73 |
| Ordinary B `5f9a4848` | initial → full | 3 → 18 | 10.75 | 99.49 |
| Kaz pre-Step1 `437459e6` | 极简 → 重构 | 1 → 9 | 50.97 | 81.19 |
| Kaz pre-Step1 `437459e6` | 重构 → 分类 | 9 → 1 | 1.03 | 1.03 |
| Kaz pre-Step1 `437459e6` | 分类 → Task | 1 → 16 | 0.74 | 88.17 |
| Kaz Step1 `21f3a06c` | 重构 → 分类 | 9 → 1 | 11.64 | 11.64 |
| Kaz Step1 `21f3a06c` | 分类 → Task | 1 → 19 | 40.16 | 99.64 |
| Kaz Step2 `86f8c544` | 极简 → 分类 | 1 → 1 | 1.81 | 1.81 |
| Kaz Step2 `86f8c544` | 分类 → Task | 1 → 18 | 0.00 | 98.47 |
| Kaz Step3 `de0019f5` | 极简 → 重构 | 1 → 9 | 2.49 | 80.67 |
| Kaz Step3 `de0019f5` | 重构 → 分类 | 9 → 1 | 0.82 | 0.82 |
| Kaz Step3 `de0019f5` | 分类 → Task | 1 → 16 | 0.00 | 99.29 |
| Kaz Step3 `de0019f5` | goal 结束 | 16 → 14 | 0.10 | 50.04 |

Finding: every tool-schema replacement invalidates the prefix; the very next
model request is a cache miss (0–50% hit). Ordinary router-standard sessions
pay that cost once per session; Kaz Step1/2/3 sessions pay it 4–8 times because
reconstruction/classification/goal-boundary each replace the header.

## 7. Acceptance vs current state

| Step4 acceptance item | State |
|---|---|
| 1. cache hit/miss reproducible, Kaz vs ordinary | ✅ This record; existing session logs |
| 2. tool-surface change count = minimal→Task Surface once; recovery/reconstruction/classification do not replace system | ❌ Current runtime changes 4–8 times; discrepancy list written for Whale 22/23 (`不入库文件/Kaz5.0与6.0更新规划/Step4-工具面验收不一致-待22与23规划.md`) |
| 3. token/round/schema token/Task Surface records | ✅ This record + `.dsh/step4/*` |
| 4. KAZ_BASE_TOOLS 12-item review | ✅ Keep baseline; evidence above; final adjustment may remain Step 5 |
| 5. all existing and new probes pass; no syntax errors | ✅ 30/30 after Step 4 probe (see below) |
| 6. report to Kaczev + Whale 26 handoff | pending final step |

## 8. New Step 4 metric helpers/probes

- `KazPlugins/kaz-shared/lib/step4-metrics.js` (pure functions):
  `estimateToolsSchemaTokens`, `estimateSystemTokens`, `estimateHeaderTokens`,
  `toolNamesOfHeader`, `surfaceSnapshots`, `surfaceTransitionCount`,
  `budgetReviewPoint`.
- `KazPlugins/kaz-shared/probe-step4-metrics.mjs` — new probe suite.
- Final validation after sync: **30/30 probes PASS**, `node --check` **63 files OK**.
