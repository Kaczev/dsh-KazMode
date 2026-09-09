// ka-whale-workflow 7.4 P4 REMOVE + P5 slimming 落地探针：
//   - §B.1 R1/R2/R3/R6：强制 reviewer / 强制 memory 旧文本从 write-plan task 缺席；
//   - 7.4 后完整规则住在 README §Stage/tool detail reference（on-demand detail）；
//   - stage task ≤ ~600 chars（P5 R4）；
//   - README 记录 fast lane / evidence gate / Intent Map / meter / slimming。
// 运行：node KazPlugins/ka-whale-workflow/probe-kaz74-remove.mjs
import {
  MAIN_ROLE,
  MAIN_STAGE_IDS,
  WORKER_STAGE_IDS,
  MEMORY_MAINTAINER_STAGE_IDS,
  PLUGIN_MAINTAINER_STAGE_IDS,
  stageDefinitionFor,
} from "./lib/stage-defs.js";
import { readFileSync } from "node:fs";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

const def = stageDefinitionFor(MAIN_ROLE, "write-plan");
const task = def?.task ?? "";
const staticCanAdvance = def?.canAdvance ?? null;
const README = readFileSync(new URL("./README.md", import.meta.url), "utf8");
const allStageDefs = [
  ...MAIN_STAGE_IDS.map((stage) => stageDefinitionFor(MAIN_ROLE, stage)),
  ...WORKER_STAGE_IDS.map((stage) => stageDefinitionFor("worker", stage)),
  ...MEMORY_MAINTAINER_STAGE_IDS.map((stage) => stageDefinitionFor("memoryMaintainer", stage)),
  ...PLUGIN_MAINTAINER_STAGE_IDS.map((stage) => stageDefinitionFor("pluginMaintainer", stage)),
].filter((d) => d !== null && d !== undefined);

check("write-plan stage definition exists", def !== null && task.length > 0);

check(
  "REMOVE R1: forced builder/reviewer text absent from write-plan task",
  !task.includes('Every build-type task should include at least one "builder" and one "reviewer" planItem'),
);

check(
  "REMOVE R2/R6: forced-memory create-at-least-one-even-if-uncertain absent from write-plan task",
  !task.includes("create at least one if the work produces new insights, lessons, or reusable patterns") &&
    !task.includes("even if uncertain"),
);

check(
  "REMOVE R3: forced independent-builder verification question absent from write-plan task",
  !task.includes('Before finalizing, ask: "Is there at least one verification step independent of the builder?"'),
);

check(
  "§5.1 memory on demand full rules live in README and write-plan points to §7.4",
  task.includes("memory/reviewer/visual rules: README §7.4") &&
    README.includes("First memory_search") &&
    README.includes("memory_update still goes through CANDIDATE/review") &&
    README.includes("rederivation cost > storage cost") &&
    README.includes("never on uncertainty alone"),
);

check(
  "§4 reviewer ceiling full rules live in README and write-plan points to §7.4",
  task.includes("memory/reviewer/visual rules: README §7.4") &&
    README.includes("Reviewer: never routine; risk-triggered only") &&
    README.includes("at most one independent reviewer per run, single pass, bound to a trigger id"),
);

check(
  "§4.1 T1-T8 with deciders live in README and T8 is anti-trigger (harness not reviewer)",
  ["T1 ambiguous high-impact intent", "T2 contradictory prompt", "T3 security-permission-privacy-secret-destructive (auto→parent)", "T4 cross ≥3 modules-public API-schema (auto)", "T5 external compliance", "T6 no-oracle silent-failure logic (auto)", "T7 aesthetic-UX judgment", "T8 (missing evidence) → build a harness, never a reviewer"].every((fragment) =>
    README.includes(fragment),
  ) &&
    README.includes("T1/T2/T5/T7 are parent-decided, T3/T4/T6 are auto"),
);

check(
  "P4 retention: L150/L154 visual/creative criteria live in README (not routine-reviewer mandate)",
  README.includes("Every build-type planItem must include, for visual/creative work") &&
    README.includes("Reviewers must judge fidelity to the intended experience"),
);

check(
  "P4 retention: static write-plan canAdvance and compass/communication stages unchanged",
  staticCanAdvance !== null &&
    JSON.stringify(staticCanAdvance) ===
      JSON.stringify(["working", "memory-maintenance", "plugin-maintenance", "compass_context_before_communication", "communication"]) &&
    stageDefinitionFor(MAIN_ROLE, "compass_context_before_communication")?.canAdvance.join(",") === "communication" &&
    stageDefinitionFor(MAIN_ROLE, "communication")?.canAdvance.join(",") === "assess-complexity",
);

// Kaczev 批准（7.4 P3 option A）：main/assess-complexity 例外放宽到 ≤1500 chars——
// design §2.5 要求 S/M/L 分类 + delivery-gate 规则常驻该 stage 正文；其余 17 条仍 ≤600。
const assessDef = stageDefinitionFor(MAIN_ROLE, "assess-complexity");
const ASSESS_TASK_CAP = 1500;
const STAGE_TASK_CAP = 600;
check(
  "P5 R4: 18 stage tasks; 17 ≤ 600 chars; main/assess-complexity ≤ 1500 (approved exception)",
  allStageDefs.length === 18 &&
    allStageDefs.every((d) => {
      if (typeof d.task !== "string") return false;
      return d === assessDef ? d.task.length <= ASSESS_TASK_CAP : d.task.length <= STAGE_TASK_CAP;
    }) &&
    assessDef !== null &&
    assessDef.task.length <= ASSESS_TASK_CAP,
);

// 7.4 P3 (2a)：assess-complexity 正文必须常驻 S/M/L 分类与 delivery-gate 契约。
// 断言使用工作树真实子串（非规格措辞）：例如实际是 "default M, never default S"（空格）。
const assessTask = assessDef?.task ?? "";
check(
  "P3 2a: assess task states the four machine-decidable S conditions",
  ["exactly 1 changed file", "no risk word", "an existing probe covers it", "that probe passes now"].every(
    (fragment) => assessTask.includes(fragment),
  ),
);
check(
  "P3 2a: assess task states default M / never default S + tierReason/tierSignals",
  assessTask.includes("default M, never default S") &&
    assessTask.includes("tierReason") &&
    assessTask.includes("tierSignals"),
);
check(
  "P3 2a: assess task has the S call form tier:\"S\" + nextStage:\"working\" and tierCeiling",
  assessTask.includes('tier: "S"') &&
    assessTask.includes('nextStage: "working"') &&
    assessTask.includes("tierCeiling"),
);
check(
  "P3 2a: assess task has the delivery-gate rule (S false explicit / M externally verifiable / L true default)",
  assessTask.includes("S -> evidenceGate:false explicitly") &&
    assessTask.includes("M -> true when externally verifiable") &&
    assessTask.includes("L -> true by default"),
);

check(
  "P5 README: 7.4 overview documents fast lane / evidence gate / Intent Map / meter / slimming",
  README.includes("S/M/L fast lane") &&
    README.includes("Intent Map") &&
    README.includes("Evidence & delivery gate") &&
    README.includes("Cost meter") &&
    README.includes("Slimming"),
);

console.log(
  failures === 0
    ? "\nKAZ74-REMOVE PROBE OK"
    : `\nKAZ74-REMOVE PROBE FAILED (${failures} 项失败)`,
);
process.exit(failures === 0 ? 0 : 1);
