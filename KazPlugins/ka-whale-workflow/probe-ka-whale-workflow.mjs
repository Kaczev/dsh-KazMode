// ka-whale-workflow 探针：验证 v0.8 Step A 主/子流程文案、阶段状态存储、不再注入旧阶段文案。
// 运行：node KazPlugins/ka-whale-workflow/probe-ka-whale-workflow.mjs
import plugin, {
  DEFAULT_RECONSTRUCTION_TOOLS,
  WHALE_REPORT_TOOL,
  KA_SUB_WHALE_TOOL,
  WORK_SUB_WHALE_REPORT_TOOL,
  MEMORY_SUB_WHALE_REPORT_TOOL,
  PLUGIN_MAINTAINER_SUB_WHALE_REPORT_TOOL,
  PLUGIN_CREATOR_SUB_WHALE_REPORT_TOOL,
  MAX_WHALE_REMINDERS,
  MAIN_FLOW_TEXT,
  SUBAGENT_FLOW_TEXT,
  GOAL_CONTINUATION_TEXT,
  GOAL_RECOVERY_STAGE,
  GOAL_ACTIVE_STAGE,
  GOAL_ACTIVE_CONTEXT_TEXT,
  workingResumedContextText,
  whaleReportReminderText,
  stageOf,
  setStage,
  createStageStore,
  isUserMessage,
  manualCommandIdOf,
  nextStageOnUserMessage,
  hasInjectedInTurn,
  goalModeActiveOf,
  MAIN_ROLE,
  MAIN_STAGE_IDS,
  V09_SUBAGENT_ROLES,
  V09_STAGE_IDS,
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
const session = {
  id: "s-whale",
  events,
  append(type, data) {
    events.push({ type, data });
  },
};
const agent = { id: "s-whale", session };
const store = createStageStore(STORE_FILE);

check("插件默认导出存在", plugin !== null && typeof plugin === "object" && plugin.name === "ka-whale-workflow");
check("旧重构清单导出仍存在（兼容 import；不再用于阶段过滤）", JSON.stringify(DEFAULT_RECONSTRUCTION_TOOLS) === JSON.stringify(["ask_user_question", "read", "glob", "grep", "web_search", "memory_search", "memory_list", "memory_detail"]));
check("whale_report 工具名", WHALE_REPORT_TOOL === "whale_report");
check("主流程文案已导出且非空", typeof MAIN_FLOW_TEXT === "string" && MAIN_FLOW_TEXT.trim().length > 0);
check("主流程文案含 v0.9 §9.1 main flow Goal-active 语义", MAIN_FLOW_TEXT.includes("ka-whale-workflow") && MAIN_FLOW_TEXT.includes("working (or goal-active)") && MAIN_FLOW_TEXT.includes("do not use create_goal directly") && MAIN_FLOW_TEXT.includes("While goal-active, do not use whale_report to advance ordinary stages") && MAIN_FLOW_TEXT.includes("After Goal ends, proceed as if working ended"));
check("主流程文案不再以旧 TaskReconstruction/TaskClassification 块注入", !MAIN_FLOW_TEXT.startsWith("Task reconstruction stage") && !MAIN_FLOW_TEXT.startsWith("We are now in the task classification stage"));
check("子代理流程文案已导出且非空", typeof SUBAGENT_FLOW_TEXT === "string" && SUBAGENT_FLOW_TEXT.includes("work_sub_whale_report") && SUBAGENT_FLOW_TEXT.includes("subagent flow"));
check("Goal 继续确认文案已导出且非空", typeof GOAL_CONTINUATION_TEXT === "string" && GOAL_CONTINUATION_TEXT.includes("non-complete goal"));
check("GOAL_RECOVERY_STAGE 仍导出", GOAL_RECOVERY_STAGE === "goal-recovery");
check("goal-active 外部模式常量导出且不在 MAIN_STAGE_IDS", GOAL_ACTIVE_STAGE === "goal-active" && !MAIN_STAGE_IDS.includes(GOAL_ACTIVE_STAGE));
check("goal-active/working-resumed 上下文文本导出", GOAL_ACTIVE_CONTEXT_TEXT.includes("[ka-whale-workflow goal-active]") && workingResumedContextText("C:/plan.json").includes("[ka-whale-workflow working-resumed]") && workingResumedContextText("C:/plan.json").includes("taskPlanPath: C:/plan.json"));
check("提醒上限为 0（不再有旧阶段提醒）", MAX_WHALE_REMINDERS === 0);
check("whaleReportReminderText 为空实现", typeof whaleReportReminderText("reconstruction") === "string" && whaleReportReminderText("reconstruction") === "" && whaleReportReminderText("classification") === "");

check("初始阶段 idle", stageOf(agent, store) === "idle");
check("第 2+ 轮普通新任务进入 assess-complexity", nextStageOnUserMessage("done", 2) === "assess-complexity" && nextStageOnUserMessage("assess-complexity", 2) === "assess-complexity" && nextStageOnUserMessage("communication", 3) === "assess-complexity");
check("首轮 → assess-complexity", nextStageOnUserMessage("idle", 1) === "assess-complexity");
check("goal 激活时进入/保持 goal-active（不重复 assess）", nextStageOnUserMessage("done", 2, { goalActive: true }) === GOAL_ACTIVE_STAGE && nextStageOnUserMessage("idle", 1, { goalActive: true }) === GOAL_ACTIVE_STAGE && nextStageOnUserMessage("working", 2, { goalActive: true }) === GOAL_ACTIVE_STAGE && nextStageOnUserMessage(GOAL_ACTIVE_STAGE, 2, { goalActive: true }) === GOAL_ACTIVE_STAGE);
check("goal 结束后 goal-active 收到新消息回 assess", nextStageOnUserMessage(GOAL_ACTIVE_STAGE, 2, { goalActive: false }) === "assess-complexity");
check("goal 未激活仍回 assess-complexity", nextStageOnUserMessage("done", 2, { goalActive: false }) === "assess-complexity");
check("goalModeActiveOf active/paused 为 true", goalModeActiveOf(agent, { get: () => ({ phase: "active" }) }) === true && goalModeActiveOf(agent, { get: () => ({ phase: "paused" }) }) === true);
check("goalModeActiveOf complete/无 goal/无服务为 false", goalModeActiveOf(agent, { get: () => ({ phase: "complete" }) }) === false && goalModeActiveOf(agent, { get: () => undefined }) === false && goalModeActiveOf(agent, null) === false && goalModeActiveOf(agent, { get: () => { throw new Error("boom"); } }) === false);
check("setStage 进入重构", setStage(agent, "reconstruction", store) === true && stageOf(agent, store) === "reconstruction");
check("setStage 重复同阶段不追加", setStage(agent, "reconstruction", store) === false);
check("setStage 进入分类", setStage(agent, "classification", store) === true && stageOf(agent, store) === "classification");
check("setStage 进入 done", setStage(agent, "done", store) === true && stageOf(agent, store) === "done");
check(
  "done→重构→分类→done 链路",
  setStage(agent, "reconstruction", store) === true &&
    setStage(agent, "classification", store) === true &&
    setStage(agent, "done", store) === true &&
    stageOf(agent, store) === "done",
);
check("阶段切换不再写会话事件", events.filter((e) => e.type === "ka-whale-workflow/stage").length === 0);

{
  const raw = readFileSync(STORE_FILE, "utf8").replace(/^\uFEFF/, "");
  const parsed = JSON.parse(raw);
  check(
    "阶段状态已持久化到 JSON 存储",
    parsed !== null &&
      typeof parsed === "object" &&
      parsed.sessions?.["s-whale"] === "done",
  );
}

{
  // 旧版会话事件兜底：只读不回写，且不依赖 store。
  const legacyEvents = [
    { type: "ka-whale-workflow/stage", data: { stage: "reconstruction" } },
    { type: "ka-whale-workflow/stage", data: { stage: "classification" } },
  ];
  const legacyAgent = { id: "s-legacy", session: { id: "s-legacy", events: legacyEvents } };
  check("旧版会话事件只读兜底（最后一个 stage 生效）", stageOf(legacyAgent, null) === "classification");
  check("旧版兜底不回写事件", legacyEvents.length === 2);
}

check("真实用户消息判定", isUserMessage({ content: [], source: { kind: "user" } }) === true && isUserMessage({ content: [] }) === true);
check("插件消息判定为假", isUserMessage({ content: [], source: { kind: "plugin", plugin: "ka-whale-workflow", form: "reconstruction" } }) === false);
check("goal/tool 消息判定为假", isUserMessage({ content: [], source: { kind: "goal" } }) === false && isUserMessage({ content: [], source: { kind: "tool" } }) === false);
check("subagent-report/subagent-settled 消息判定为假（不触发新一轮）", isUserMessage({ content: [], source: { kind: "subagent-report", form: "relay", senderSessionId: "child" } }) === false && isUserMessage({ content: [], source: { kind: "subagent-settled", form: "notice", senderSessionId: "child" } }) === false);

{
  // 重构重入：turn 1 注入过 TaskReconstruction，turn 2 仍应允许重新注入。
  const reentryEvents = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "user/message", data: { source: { kind: "plugin", plugin: "ka-whale-workflow", form: "reconstruction" } } },
    { type: "turn/start", data: { turn: 2 } },
    { type: "turn/end", data: { turn: 2 } },
  ];
  const reentryAgent = { id: "s-reentry", session: { id: "s-reentry", events: reentryEvents } };
  check("重构重入：turn2 未注入过 → 可再次注入", hasInjectedInTurn(reentryAgent, "reconstruction", 2) === false && hasInjectedInTurn(reentryAgent, "reconstruction", 1) === true);
}

{
  // /goal 命令：最后一个 turn/end 之后有 command/run + 成功 command/done。
  const cmdEvents = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "step/start", data: { turn: 1, step: 1 } },
    { type: "step/end", data: { turn: 1, step: 1 } },
    { type: "turn/end", data: { turn: 1 } },
    { type: "command/run", data: { name: "goal", args: "目标", commandId: "cmd-1" } },
    { type: "command/done", data: { commandId: "cmd-1", kind: "success" } },
  ];
  const cmdAgent = { id: "s-cmd", session: { id: "s-cmd", events: cmdEvents } };
  const hit = manualCommandIdOf(cmdAgent);
  check("manualCommandIdOf 命中 /goal", hit !== null && hit.name === "goal" && hit.commandId === "cmd-1");
}

{
  // /plan 已移除：即使有旧 command/run 也不识别。
  const oldPlanEvents = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "turn/end", data: { turn: 1 } },
    { type: "command/run", data: { name: "plan", args: "设计一个方案", commandId: "cmd-old" } },
    { type: "command/done", data: { commandId: "cmd-old", kind: "success" } },
  ];
  const oldPlanAgent = { id: "s-old-plan", session: { id: "s-old-plan", events: oldPlanEvents } };
  check("manualCommandIdOf 不再识别旧 /plan 命令", manualCommandIdOf(oldPlanAgent) === null);
}

{
  // 没有命令事件 → null。
  const plainAgent = { id: "s-plain", session: { id: "s-plain", events: [{ type: "turn/start", data: { turn: 1 } }] } };
  check("manualCommandIdOf 无命令为 null", manualCommandIdOf(plainAgent) === null);
}

// v0.9 新工具名/常量。
check("ka_sub_whale 工具名", KA_SUB_WHALE_TOOL === "ka_sub_whale");
check("四个子代理 report 工具名", WORK_SUB_WHALE_REPORT_TOOL === "work_sub_whale_report" && MEMORY_SUB_WHALE_REPORT_TOOL === "memory_sub_whale_report" && PLUGIN_MAINTAINER_SUB_WHALE_REPORT_TOOL === "plugin_maintainer_sub_whale_report" && PLUGIN_CREATOR_SUB_WHALE_REPORT_TOOL === "plugin_creator_sub_whale_report");
check("v0.9 stage 常量导出", MAIN_ROLE === "main" && MAIN_STAGE_IDS.length === 9 && V09_SUBAGENT_ROLES.length === 4 && V09_STAGE_IDS.length > 0);

// 阶段定义与注入文本。
const assessDef = stageDefinitionFor(MAIN_ROLE, "assess-complexity");
const workingDef = stageDefinitionFor(MAIN_ROLE, "working");
check("主 stage 定义允许工具/推进与 v0.9 一致", assessDef?.allowedTools.includes("whale_report") && assessDef?.canAdvance.includes("communication") && workingDef?.canAdvance.includes("write-plan"));
check("decide-goal 定义含 working 与 goal-active", canAdvance(MAIN_ROLE, "decide-goal", "working") === true && canAdvance(MAIN_ROLE, "decide-goal", GOAL_ACTIVE_STAGE) === true && stageDefinitionFor(MAIN_ROLE, "decide-goal")?.task.includes("max_goal_rounds?"));
check("主 stage 可推进校验", canAdvance(MAIN_ROLE, "assess-complexity", "challenge-plan") === true && canAdvance(MAIN_ROLE, "assess-complexity", "working") === false);
check("子代理 role stage 定义齐全", ["worker","memoryMaintainer","pluginMaintainer","pluginCreator"].every((role) => stageIdsForRole(role).length >= 4));
const writePlanText = stageInjectionText(MAIN_ROLE, "write-plan", { taskPlanPath: "C:/tmp/task-plan.json" });
check("write-plan 注入携带 Allowed/Can advance/Task/taskPlanPath", writePlanText.includes("Allowed tools: [whale_report, read]") && writePlanText.includes("Can advance to: [decide-goal, working]") && writePlanText.includes("Task: Finalize") && writePlanText.includes("taskPlanPath: C:/tmp/task-plan.json"));
const createText = stageInjectionText("pluginCreator", "create-plugin", { lifecyclePath: "C:/tmp/PLUGIN_LIFECYCLE.md" });
check("create-plugin 注入携带 lifecyclePath", createText.includes("[ka-whale-workflow create-plugin]") && createText.includes("lifecyclePath: C:/tmp/PLUGIN_LIFECYCLE.md"));

// Task plan 持久化：draft 不可委派，finalized 可委派。
{
  const PLAN_FILE = join(TMP, "ka-whale-workflow-task-plan.json");
  const planStore = createTaskPlanStore(PLAN_FILE);
  const draft = planStore.persistDraftItems([
    { planItemId: "p1", persona: "worker", task: "Do work", assignedTools: [] },
  ]);
  check("decide-tools 第一次持久化为 draft", draft.ok === true && planStore.get("p1")?.status === "draft");
  const draftResolve = resolvePlanItemForDelegation(planStore, "p1");
  check("ka_sub_whale 拒绝 draft planItemId", draftResolve.ok === false && draftResolve.code === "plan-item-not-finalized");
  const missing = resolvePlanItemForDelegation(planStore, "nope");
  check("ka_sub_whale 拒绝不存在 planItemId", missing.ok === false && missing.code === "plan-item-not-found");
  const final = planStore.persistFinalPayload({
    status: "finalized",
    items: [{ planItemId: "p1", persona: "worker", task: "Do work", assignedTools: [] }],
  });
  check("write-plan 第二次定稿为 finalized", final.ok === true && planStore.get("p1")?.status === "finalized");
  const okResolve = resolvePlanItemForDelegation(planStore, "p1");
  check("finalized planItemId 可解析", okResolve.ok === true && okResolve.item.persona === "worker");
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nKA-WHALE-WORKFLOW PROBE OK" : `\nKA-WHALE-WORKFLOW PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
