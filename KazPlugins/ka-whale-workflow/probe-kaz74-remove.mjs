// ka-whale-workflow 7.4 P4 REMOVE 落地探针：
//   - §B.1 R1/R2/R3/R6：强制 reviewer / 强制 memory 旧文本从 write-plan task 缺席；
//   - §4.1 风险触发器 T1–T8（含 decider 与 anti-trigger T8）与
//     “每 run 至多 1 个独立 reviewer、单 pass、绑定 trigger id”成本护栏；
//   - §5.1 memory on demand：先搜、先落 work-log、四条件、never on uncertainty、
//     memory_update 仍走 CANDIDATE/review（D31）；
//   - 保留项：L150/L154 是 visual/creative 判据（不是 routine reviewer 强制）。
// 运行：node KazPlugins/ka-whale-workflow/probe-kaz74-remove.mjs
import { MAIN_ROLE, stageDefinitionFor } from "./lib/stage-defs.js";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

const def = stageDefinitionFor(MAIN_ROLE, "write-plan");
const task = def?.task ?? "";
const staticCanAdvance = def?.canAdvance ?? null;

check("write-plan stage definition exists", def !== null && task.length > 0);

check(
  "REMOVE R1: forced builder/reviewer text absent",
  !task.includes('Every build-type task should include at least one "builder" and one "reviewer" planItem'),
);

check(
  "REMOVE R2/R6: forced-memory create-at-least-one-even-if-uncertain absent",
  !task.includes("create at least one if the work produces new insights, lessons, or reusable patterns") &&
    !task.includes("even if uncertain"),
);

check(
  "REMOVE R3: forced independent-builder verification question absent",
  !task.includes('Before finalizing, ask: "Is there at least one verification step independent of the builder?"'),
);

check(
  "§5.1 memory on demand: search-first/work-log/CANDIDATE-review/cost threshold/never-on-uncertainty present",
  task.includes('"memoryMaintainer": on demand only') &&
    task.includes("First memory_search") &&
    task.includes("memory_update still goes through CANDIDATE/review") &&
    task.includes("rederivation cost > storage cost") &&
    task.includes("never on uncertainty alone"),
);

check(
  "§4 reviewer ceiling: never routine, risk-triggered, at most one per run/single pass/bound trigger id",
  task.includes("Reviewer: never routine; risk-triggered only") &&
    task.includes("at most one independent reviewer per run, single pass, bound to a trigger id"),
);

check(
  "§4.1 T1-T8 with deciders present and T8 is anti-trigger (harness not reviewer)",
  ["T1 ambiguous high-impact intent", "T2 contradictory prompt", "T3 security-permission-privacy-secret-destructive (auto→parent)", "T4 cross ≥3 modules-public API-schema (auto)", "T5 external compliance", "T6 no-oracle silent-failure logic (auto)", "T7 aesthetic-UX judgment", "T8 (missing evidence) → build a harness, never a reviewer"].every((fragment) =>
    task.includes(fragment),
  ) &&
    task.includes("T1/T2/T5/T7 are parent-decided, T3/T4/T6 are auto"),
);

check(
  "P4 retention: L150/L154 visual/creative criteria remain (not routine-reviewer mandate)",
  task.includes("Every build-type planItem must include, for visual/creative work") &&
    task.includes("Reviewers must judge fidelity to the intended experience"),
);

check(
  "P4 retention: static write-plan canAdvance and compass+communication rules unchanged",
  staticCanAdvance !== null &&
    JSON.stringify(staticCanAdvance) ===
      JSON.stringify(["working", "memory-maintenance", "plugin-maintenance", "compass_context_before_communication", "communication"]) &&
    task.includes('Before advancing to communication, call "compass_context_before_communication"'),
);

console.log(
  failures === 0
    ? "\nKAZ74-REMOVE PROBE OK"
    : `\nKAZ74-REMOVE PROBE FAILED (${failures} 项失败)`,
);
process.exit(failures === 0 ? 0 : 1);
