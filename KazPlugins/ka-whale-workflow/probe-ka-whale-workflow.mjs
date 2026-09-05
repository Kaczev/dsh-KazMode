// ka-whale-workflow 探针（v0.9 B5 口径）：
//   - 主/子流程文案与 v0.9 stage 常量；
//   - stage store 只接受 v0.9 / goal-active / working-resumed / 状态壳；
//   - 不再读写旧 reconstruction / classification / goal-recovery；
//   - 新轮 Goal 路由与 /goal 命令；task plan 草稿/定稿；
//   - 阶段定义与注入文本。
// 运行：node KazPlugins/ka-whale-workflow/probe-ka-whale-workflow.mjs
import plugin, {
  WHALE_REPORT_TOOL,
  KA_SUB_WHALE_TOOL,
  WORK_SUB_WHALE_REPORT_TOOL,
  MEMORY_SUB_WHALE_REPORT_TOOL,
  PLUGIN_MAINTAINER_SUB_WHALE_REPORT_TOOL,
  PLUGIN_CREATOR_SUB_WHALE_REPORT_TOOL,
  MAIN_FLOW_TEXT,
  SUBAGENT_FLOW_TEXT,
  GOAL_ACTIVE_STAGE,
  GOAL_ACTIVE_CONTEXT_TEXT,
  workingResumedContextText,
  stageOf,
  setStage,
  createStageStore,
  isUserMessage,
  manualCommandIdOf,
  nextStageOnUserMessage,
  goalModeActiveOf,
  MAIN_ROLE,
  MAIN_STAGE_IDS,
  V09_SUBAGENT_ROLES,
  V09_STAGE_IDS,
  subagentReportChildSessionIdOf,
} from "./lib/index.js";
import {
  stageDefinitionFor,
  stageInjectionText,
  canAdvance,
  stageIdsForRole,
} from "./lib/stage-defs.js";
import { createTaskPlanStore, resolvePlanItemForDelegation } from "./lib/task-plan-store.js";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

const TMP = mkdtempSync(join(tmpdir(), "whale-probe-"));
const STORE_FILE = join(TMP, "ka-whale-workflow-stage.json");
const events = [];
const session = { id: "s-whale", events, append(type, data) { events.push({ type, data }); } };
const agent = { id: "s-whale", session };
const store = createStageStore(STORE_FILE);

check("插件默认导出存在", plugin !== null && typeof plugin === "object" && plugin.name === "ka-whale-workflow");
check("whale_report 工具名", WHALE_REPORT_TOOL === "whale_report");
check("主流程文案已导出且非空", typeof MAIN_FLOW_TEXT === "string" && MAIN_FLOW_TEXT.trim().length > 0);
check("主流程文案含 v0.9 §9.1 Goal-active 语义", MAIN_FLOW_TEXT.includes("working (or goal-active)") && MAIN_FLOW_TEXT.includes("do not use create_goal directly") && MAIN_FLOW_TEXT.includes("After Goal ends, proceed as if working ended") && MAIN_FLOW_TEXT.includes("At decide-goal, choose normal when the task is completable in this workflow-run") && MAIN_FLOW_TEXT.includes("Choose goal when the objective is clear"));
check("36.6 主 Persona 含事件驱动等待语义", MAIN_FLOW_TEXT.includes("must NOT use pwsh sleep") && MAIN_FLOW_TEXT.includes("poll list_agents") && MAIN_FLOW_TEXT.includes("end the current turn and wait for the subagent's report/finished message") && MAIN_FLOW_TEXT.includes("list_agents and send_message are not wait primitives"));
check("36.7 主 Persona 含批评纪律", MAIN_FLOW_TEXT.includes("Critique first") && MAIN_FLOW_TEXT.includes("do not manufacture criticism") && MAIN_FLOW_TEXT.includes("Critically evaluate subagent reports and critiques instead of accepting them blindly"));
check("36.7 worker 流程含批评纪律", SUBAGENT_FLOW_TEXT.includes("critique the delegation first") && SUBAGENT_FLOW_TEXT.includes("identify real weaknesses") && SUBAGENT_FLOW_TEXT.includes("do not blindly accept"));
check("36.6 子代理流程文案已导出且非空", typeof SUBAGENT_FLOW_TEXT === "string" && SUBAGENT_FLOW_TEXT.includes("work_sub_whale_report") && SUBAGENT_FLOW_TEXT.includes("subagent flow"));
check("goal-active 常量不在 MAIN_STAGE_IDS", GOAL_ACTIVE_STAGE === "goal-active" && !MAIN_STAGE_IDS.includes(GOAL_ACTIVE_STAGE));
check("goal-active/working-resumed 文本导出", GOAL_ACTIVE_CONTEXT_TEXT.includes("[ka-whale-workflow goal-active]") && workingResumedContextText("C:/plan.json").includes("taskPlanPath: C:/plan.json"));

// Stage store clean: only v0.9 stages + external markers + shells are accepted.
check("初始阶段 idle", stageOf(agent, store) === "idle");
check("setStage 接受 v0.9 stage", setStage(agent, "assess-complexity", store) === true && stageOf(agent, store) === "assess-complexity");
check("setStage 接受 done 状态壳", setStage(agent, "done", store) === true && stageOf(agent, store) === "done");
check("旧 reconstruction/classification/goal-recovery 拒绝", setStage(agent, "reconstruction", store) === false && setStage(agent, "classification", store) === false && setStage(agent, "goal-recovery", store) === false);
check("阶段切换不再写会话事件", events.filter((e) => e.type === "ka-whale-workflow/stage").length === 0);
{
  const raw = readFileSync(STORE_FILE, "utf8").replace(/^\uFEFF/, "");
  const parsed = JSON.parse(raw);
  check("阶段状态已持久化到 JSON 存储", parsed.sessions?.["s-whale"] === "done" && parsed.taskToolState === undefined);
}

check("36.5 终态新消息进入 assess-complexity", nextStageOnUserMessage("done", 2) === "assess-complexity" && nextStageOnUserMessage("communication", 3) === "assess-complexity" && nextStageOnUserMessage("end", 3) === "assess-complexity" && nextStageOnUserMessage("idle", 1) === "assess-complexity");
check("36.5/37.5 活动阶段新消息保留当前阶段", nextStageOnUserMessage("working", 2) === "working" && nextStageOnUserMessage("challenge-plan", 3) === "challenge-plan" && nextStageOnUserMessage("decide-tools", 2) === "decide-tools" && nextStageOnUserMessage("write-plan", 2) === "write-plan" && nextStageOnUserMessage("memory-maintenance", 2) === "memory-maintenance");
check("goal active 时进入/保持 goal-active", nextStageOnUserMessage("done", 2, { goalActive: true }) === GOAL_ACTIVE_STAGE && nextStageOnUserMessage("idle", 1, { goalActive: true }) === GOAL_ACTIVE_STAGE && nextStageOnUserMessage(GOAL_ACTIVE_STAGE, 2, { goalActive: true }) === GOAL_ACTIVE_STAGE);
check("stale goal-active（goalActive=false/缺省）回到 assess-complexity", nextStageOnUserMessage(GOAL_ACTIVE_STAGE, 2, { goalActive: false }) === "assess-complexity" && nextStageOnUserMessage(GOAL_ACTIVE_STAGE, 2) === "assess-complexity");
check("goalModeActiveOf active/paused 为 true", goalModeActiveOf(agent, { get: () => ({ phase: "active" }) }) === true && goalModeActiveOf(agent, { get: () => ({ phase: "paused" }) }) === true);
check("goalModeActiveOf complete/无 goal/无服务为 false", goalModeActiveOf(agent, { get: () => ({ phase: "complete" }) }) === false && goalModeActiveOf(agent, { get: () => undefined }) === false && goalModeActiveOf(agent, null) === false);

check("真实用户消息判定", isUserMessage({ content: [], source: { kind: "user" } }) === true && isUserMessage({ content: [] }) === true);
check("plugin/goal/tool 消息判定为假", isUserMessage({ content: [], source: { kind: "plugin", plugin: "ka-whale-workflow" } }) === false && isUserMessage({ content: [], source: { kind: "goal" } }) === false && isUserMessage({ content: [], source: { kind: "tool" } }) === false);
check("subagent report/settled 消息判定为假", isUserMessage({ content: [], source: { kind: "subagent-report", form: "relay" } }) === false && isUserMessage({ content: [], source: { kind: "subagent-settled", form: "notice" } }) === false);
check("37.5 从 subagent-report/settled 提取 child session id", subagentReportChildSessionIdOf({ content: [], source: { kind: "subagent-report", senderSessionId: "child-1" } }) === "child-1" && subagentReportChildSessionIdOf({ content: [], source: { kind: "subagent-settled", senderSessionId: "child-2" } }) === "child-2" && subagentReportChildSessionIdOf({ content: [], source: { kind: "user" } }) === "");

{
  const cmdEvents = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "turn/end", data: { turn: 1 } },
    { type: "command/run", data: { name: "goal", args: "目标", commandId: "cmd-1" } },
    { type: "command/done", data: { commandId: "cmd-1", kind: "success" } },
  ];
  const cmdAgent = { id: "s-cmd", session: { id: "s-cmd", events: cmdEvents } };
  check("manualCommandIdOf 命中 /goal", manualCommandIdOf(cmdAgent)?.commandId === "cmd-1");
}
{
  const oldPlanEvents = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "turn/end", data: { turn: 1 } },
    { type: "command/run", data: { name: "plan", args: "x", commandId: "cmd-old" } },
    { type: "command/done", data: { commandId: "cmd-old", kind: "success" } },
  ];
  check("manualCommandIdOf 不再识别旧 /plan", manualCommandIdOf({ id: "s-old-plan", session: { id: "s-old-plan", events: oldPlanEvents } }) === null);
}

check("v0.9 工具名", KA_SUB_WHALE_TOOL === "ka_sub_whale" && WORK_SUB_WHALE_REPORT_TOOL === "work_sub_whale_report" && MEMORY_SUB_WHALE_REPORT_TOOL === "memory_sub_whale_report" && PLUGIN_MAINTAINER_SUB_WHALE_REPORT_TOOL === "plugin_maintainer_sub_whale_report" && PLUGIN_CREATOR_SUB_WHALE_REPORT_TOOL === "plugin_creator_sub_whale_report");
check("v0.9 stage 常量导出（37.5 无 plugin-preflight）", MAIN_ROLE === "main" && MAIN_STAGE_IDS.length === 9 && !MAIN_STAGE_IDS.includes("plugin-preflight") && V09_SUBAGENT_ROLES.length === 4 && V09_SUBAGENT_ROLES.includes("pluginCreator") && V09_STAGE_IDS.length > 0);

const assessDef = stageDefinitionFor(MAIN_ROLE, "assess-complexity");
const workingDef = stageDefinitionFor(MAIN_ROLE, "working");
check("主 stage 定义与 v0.9 一致", assessDef?.allowedTools.includes("whale_report") && workingDef?.canAdvance.includes("write-plan"));
check("37.5 新图：write-plan 可到 decide-goal/working/maintenance/communication", ["decide-goal", "working", "memory-maintenance", "plugin-maintenance", "communication"].every((stage) => canAdvance(MAIN_ROLE, "write-plan", stage)));
check("37.5 新图：working 只到 write-plan/memory-maintenance", JSON.stringify(workingDef?.canAdvance) === JSON.stringify(["write-plan", "memory-maintenance"]));
check("37.5 新图：memory-maintenance 可回 write-plan", canAdvance(MAIN_ROLE, "memory-maintenance", "write-plan") === true && canAdvance(MAIN_ROLE, "memory-maintenance", "plugin-maintenance") === true && canAdvance(MAIN_ROLE, "memory-maintenance", "communication") === true);
check("37.5 plugin-preflight 不再是主阶段且 decide-tools 只到 write-plan", stageDefinitionFor(MAIN_ROLE, "plugin-preflight") === null && JSON.stringify(stageDefinitionFor(MAIN_ROLE, "decide-tools")?.canAdvance) === JSON.stringify(["write-plan"]));
check("36.8 working 不可直接 communication/plugin-maintenance", workingDef?.canAdvance.includes("communication") === false && workingDef?.canAdvance.includes("plugin-maintenance") === false && workingDef?.canAdvance.includes("memory-maintenance") === true);
{
  const mainChallenge = stageDefinitionFor(MAIN_ROLE, "challenge-plan");
  const workerChallenge = stageDefinitionFor("worker", "challenge-plan");
  check(
    "36.7 主 challenge-plan task 先批评/识别真弱点/不制造批评",
    typeof mainChallenge?.task === "string" &&
      mainChallenge.task.includes("Critique the user's approach first") &&
      mainChallenge.task.includes("identify real weaknesses") &&
      mainChallenge.task.includes("do not manufacture criticism"),
  );
  check(
    "36.7 worker challenge-plan task 先批评/识别真弱点/不制造批评",
    typeof workerChallenge?.task === "string" &&
      workerChallenge.task.includes("Critique the delegation first") &&
      workerChallenge.task.includes("identify real weaknesses") &&
      workerChallenge.task.includes("do not manufacture criticism"),
  );
  check(
    "36.8 worker challenge-plan 只可推进 check-tools",
    JSON.stringify(workerChallenge?.canAdvance) === JSON.stringify(["check-tools"]),
  );
  check(
    "36.8 worker challenge/check-tools 文本含文件工具只在 working 与不得提前报告",
    typeof workerChallenge?.task === "string" &&
      workerChallenge.task.includes("full working file-tool set (edit, write, pwsh, read) is granted in the working stage") &&
      workerChallenge.task.includes("Do not report tool insufficiency before reaching working") &&
      typeof stageDefinitionFor("worker", "check-tools")?.task === "string" &&
      stageDefinitionFor("worker", "check-tools").task.includes("do not report tool insufficiency before reaching working"),
  );
  check(
    "36.7 主 working task 批判性评估子代理批评而非盲从",
    typeof workingDef?.task === "string" &&
      workingDef.task.includes("critically evaluates subagent reports and their critiques") &&
      workingDef.task.includes("instead of accepting them blindly"),
  );
}
check("decide-goal 定义含 working 与 goal-active", canAdvance(MAIN_ROLE, "decide-goal", "working") === true && canAdvance(MAIN_ROLE, "decide-goal", GOAL_ACTIVE_STAGE) === true);
check("子代理 role stage 定义齐全", ["worker", "memoryMaintainer", "pluginMaintainer", "pluginCreator"].every((role) => stageIdsForRole(role).length >= 4));
const writePlanText = stageInjectionText(MAIN_ROLE, "write-plan", { taskPlanPath: "C:/tmp/task-plan.json" });
check("write-plan 注入携带 Allowed/Can advance/Task/taskPlanPath", writePlanText.includes("taskPlanPath: C:/tmp/task-plan.json"));
{
  const waitStages = ["working", "memory-maintenance", "plugin-maintenance"];
  const waitOk = waitStages.every((stage) => {
    const text = stageInjectionText(MAIN_ROLE, stage);
    return (
      text.includes("end the current turn and wait for the subagent's report/finished message") &&
      text.includes("pwsh sleep") &&
      text.includes("poll list_agents") &&
      text.includes("not wait primitives")
    );
  });
  check("36.6 working/memory-maintenance/plugin-maintenance 阶段注入含事件驱动等待语义", waitOk);
}

{
  const PLAN_FILE = join(TMP, "ka-whale-workflow-task-plan.json");
  const planStore = createTaskPlanStore(PLAN_FILE);
  planStore.persistDraftItems([{ planItemId: "p1", persona: "worker", task: "Do work", assignedTools: [] }]);
  check("decide-tools 草稿为 draft 且不可委派", planStore.get("p1")?.status === "draft" && resolvePlanItemForDelegation(planStore, "p1").ok === false);
  planStore.persistFinalPayload({ status: "finalized", items: [{ planItemId: "p1", persona: "worker", task: "Do work", assignedTools: [] }] });
  check("write-plan 定稿为 finalized 且可委派", planStore.get("p1")?.status === "finalized" && resolvePlanItemForDelegation(planStore, "p1").ok === true);
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nKA-WHALE-WORKFLOW PROBE OK" : `\nKA-WHALE-WORKFLOW PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
