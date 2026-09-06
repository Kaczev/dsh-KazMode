// ka-whale-workflow 探针（v0.9 B5 口径）：
//   - v0.9 stage 常量与注入文本（含 minimalTools 可选首轮提示）；
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
  isParentMainSendMessage,
  SUB_WHALE_REPORT_WAIT_NOTICE,
  SUB_WHALE_REPORT_WAIT_DENY_CODE,
  MAIN_ROLE,
  MAIN_STAGE_IDS,
  V09_SUBAGENT_ROLES,
  V09_STAGE_IDS,
  subagentReportChildSessionIdOf,
} from "./lib/index.js";
import {
  stageDefinitionFor,
  stageInjectionText,
  STAGE_CONTEXT_NOTES,
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

const CONTEXT_TOOLS = ["context_search", "context_read", "context_compress"];
const hasContextTools = (def) =>
  def !== null &&
  Array.isArray(def.allowedTools) &&
  CONTEXT_TOOLS.every((tool) => def.allowedTools.includes(tool));

const TMP = mkdtempSync(join(tmpdir(), "whale-probe-"));
const STORE_FILE = join(TMP, "ka-whale-workflow-stage.json");
const events = [];
const session = { id: "s-whale", events, append(type, data) { events.push({ type, data }); } };
const agent = { id: "s-whale", session };
const store = createStageStore(STORE_FILE);

check("插件默认导出存在", plugin !== null && typeof plugin === "object" && plugin.name === "ka-whale-workflow");
check("whale_report 工具名", WHALE_REPORT_TOOL === "whale_report");
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
  store.setSubagentRole("child-wait-gate", {
    planItemId: "p-gate",
    persona: "worker",
    assignedTools: [],
    finalTools: ["work_sub_whale_report"],
  });
  check("subagentRoles 新记录缺省 awaitingParent=false（schema 兼容）", store.getSubagentRole("child-wait-gate")?.awaitingParent === false && store.getSubagentRole("child-wait-gate")?.persona === "worker");
  check("setSubagentRoleAwaitingParent true/false 持久化", store.setSubagentRoleAwaitingParent("child-wait-gate", true) === true && store.getSubagentRole("child-wait-gate")?.awaitingParent === true && store.setSubagentRoleAwaitingParent("child-wait-gate", false) === true && store.getSubagentRole("child-wait-gate")?.awaitingParent === false);
}
{
  // memoryMaintainer 强制复用：stage store parent→role→child 注册/查询/清理。
  store.setSubagentRole("mem-child-reuse", {
    planItemId: "p-mem",
    persona: "memoryMaintainer",
    parentId: "s-whale",
    stage: "communication",
    assignedTools: [],
    finalTools: ["memory_search", "memory_sub_whale_report"],
    awaitingParent: true,
  });
  store.set("mem-child-reuse", "communication");
  let parsed = JSON.parse(readFileSync(STORE_FILE, "utf8").replace(/^\uFEFF/, ""));
  check(
    "subagentRoleParents 持久化 parent→role→child 且角色记录含 parentId/stage",
    parsed.subagentRoleParents?.["s-whale"]?.["memoryMaintainer"]?.includes("mem-child-reuse") === true &&
      parsed.subagentRoles?.["mem-child-reuse"]?.parentId === "s-whale" &&
      parsed.subagentRoles?.["mem-child-reuse"]?.stage === "communication",
  );
  const reusable = store.getReusableSubagentChildren("s-whale", "memoryMaintainer");
  check(
    "getReusableSubagentChildren 返回同 parent+role 候选取证（childSessionId）",
    reusable.length === 1 &&
      reusable[0].childSessionId === "mem-child-reuse" &&
      reusable[0].persona === "memoryMaintainer" &&
      reusable[0].awaitingParent === true,
  );
  store.setSubagentRole("old-mem-no-parent", {
    planItemId: "p-old",
    persona: "memoryMaintainer",
    assignedTools: [],
    finalTools: ["memory_search"],
  });
  check(
    "旧记录无 parentId/stage 兼容读取（缺省空串）",
    store.getSubagentRole("old-mem-no-parent")?.parentId === "" &&
      store.getSubagentRole("old-mem-no-parent")?.stage === "" &&
      store.getReusableSubagentChildren("s-whale", "memoryMaintainer").length === 1,
  );
  check("removeSubagentRole 同步清理 parent 索引", store.removeSubagentRole("mem-child-reuse") === true && store.getReusableSubagentChildren("s-whale", "memoryMaintainer").length === 0);
  parsed = JSON.parse(readFileSync(STORE_FILE, "utf8").replace(/^\uFEFF/, ""));
  check(
    "parent 索引清理已落盘（不再指向已删 child）",
    (parsed.subagentRoleParents?.["s-whale"]?.["memoryMaintainer"] ?? []).includes("mem-child-reuse") === false,
  );
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
check("父主 send_message 判定：coordinator/relay 为真，其它 source 为假", isParentMainSendMessage({ content: [], source: { kind: "coordinator", form: "relay", senderSessionId: "parent" } }) === true && isParentMainSendMessage({ content: [], source: { kind: "coordinator", form: "other" } }) === false && isParentMainSendMessage({ content: [], source: { kind: "user" } }) === false && isParentMainSendMessage({ content: [] }) === false);
check("报告硬等门常量导出", SUB_WHALE_REPORT_WAIT_NOTICE.includes("Stage advanced; now output your full report as your final message") && SUB_WHALE_REPORT_WAIT_NOTICE.includes("parent receives it as subagent-settled") && SUB_WHALE_REPORT_WAIT_NOTICE.includes("do not call further tools") && SUB_WHALE_REPORT_WAIT_DENY_CODE === "subagent-report-wait-deny");

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

check("v0.9 工具名（三角色、无 pluginCreator/plugin_creator_sub_whale_report）", KA_SUB_WHALE_TOOL === "ka_sub_whale" && WORK_SUB_WHALE_REPORT_TOOL === "work_sub_whale_report" && MEMORY_SUB_WHALE_REPORT_TOOL === "memory_sub_whale_report" && PLUGIN_MAINTAINER_SUB_WHALE_REPORT_TOOL === "plugin_maintainer_sub_whale_report" && !V09_SUBAGENT_ROLES.includes("pluginCreator"));
check("v0.9 stage 常量导出（compass_context 已加入；三角色）", MAIN_ROLE === "main" && MAIN_STAGE_IDS.length === 10 && MAIN_STAGE_IDS.includes("compass_context") && !MAIN_STAGE_IDS.includes("plugin-preflight") && V09_SUBAGENT_ROLES.length === 3 && !V09_SUBAGENT_ROLES.includes("pluginCreator") && V09_STAGE_IDS.length > 0);

const assessDef = stageDefinitionFor(MAIN_ROLE, "assess-complexity");
const workingDef = stageDefinitionFor(MAIN_ROLE, "working");
check("主 stage 定义与 v0.9 一致", assessDef?.allowedTools.includes("whale_report") && workingDef?.canAdvance.includes("write-plan"));
check("双层语义：主 assess allowedTools = memory_search+context_search+context_read+whale_report（Minimal 不再由 stage 收口；ask_user_question 留 challenge-plan；不放 context_compress/read）", JSON.stringify(assessDef?.allowedTools) === JSON.stringify(["memory_search", "context_search", "context_read", "whale_report"]) && !assessDef?.allowedTools.includes("read") && !assessDef?.allowedTools.includes("ask_user_question") && !assessDef?.allowedTools.includes("context_compress"));
{
  const mainNonMinimal = ["challenge-plan", "decide-tools", "write-plan", "working", "memory-maintenance", "plugin-maintenance"];
  check(
    "主模型非终态需回溯阶段均含 context_search+context_read",
    mainNonMinimal.every((stage) => {
      const tools = stageDefinitionFor(MAIN_ROLE, stage)?.allowedTools ?? [];
      return tools.includes("context_search") && tools.includes("context_read");
    }),
  );
}
{
  const subagentInitialStages = {
    worker: "assess-complexity",
    memoryMaintainer: "assess-delegation",
    pluginMaintainer: "assess-delegation",
  };
  const subagentReportTools = {
    worker: "work_sub_whale_report",
    memoryMaintainer: "memory_sub_whale_report",
    pluginMaintainer: "plugin_maintainer_sub_whale_report",
  };
  check(
    "双层语义：受控子代理初始 stage allowedTools 含 memory/context/report，不含 read/context_compress",
    Object.entries(subagentInitialStages).every(([role, stage]) => {
      const tools = stageDefinitionFor(role, stage)?.allowedTools ?? [];
      return tools.includes("memory_search") && tools.includes("context_search") && tools.includes("context_read") && tools.includes(subagentReportTools[role]) && !tools.includes("read") && !tools.includes("context_compress");
    }),
  );
}
{
  const subagentNonMinimal = {
    worker: ["challenge-plan", "check-tools", "working"],
    memoryMaintainer: ["plan-memory", "save-update", "delete-memory"],
    pluginMaintainer: ["plan-plugin", "create-plugin", "update-plugin", "retire-plugin"],
  };
  check(
    "受控子代理执行阶段均含 context_search+context_read（回溯纪律）",
    Object.entries(subagentNonMinimal).every(([role, stages]) => stages.every((stage) => {
      const tools = stageDefinitionFor(role, stage)?.allowedTools ?? [];
      return tools.includes("context_search") && tools.includes("context_read");
    })),
  );
}
{
  const roles = ["main", "worker", "memoryMaintainer", "pluginMaintainer"];
  const reportTools = {
    main: "whale_report",
    worker: "work_sub_whale_report",
    memoryMaintainer: "memory_sub_whale_report",
    pluginMaintainer: "plugin_maintainer_sub_whale_report",
  };
  check(
    "各角色 communication 阶段只含各自 report 工具",
    roles.every((role) => JSON.stringify(stageDefinitionFor(role, "communication")?.allowedTools) === JSON.stringify([reportTools[role]])),
  );
}
check("37.5 新图：write-plan 可到 decide-goal/working/maintenance/communication", ["decide-goal", "working", "memory-maintenance", "plugin-maintenance", "communication"].every((stage) => canAdvance(MAIN_ROLE, "write-plan", stage)));
check("compass_context 图：working 可到 write-plan/memory-maintenance/compass_context", workingDef?.canAdvance.includes("write-plan") === true && workingDef?.canAdvance.includes("memory-maintenance") === true && workingDef?.canAdvance.includes("compass_context") === true);
check("37.5 新图：memory-maintenance 可回 write-plan", canAdvance(MAIN_ROLE, "memory-maintenance", "write-plan") === true && canAdvance(MAIN_ROLE, "memory-maintenance", "plugin-maintenance") === true && canAdvance(MAIN_ROLE, "memory-maintenance", "communication") === true);
check("37.5 plugin-preflight 不再是主阶段且 decide-tools 只到 write-plan", stageDefinitionFor(MAIN_ROLE, "plugin-preflight") === null && JSON.stringify(stageDefinitionFor(MAIN_ROLE, "decide-tools")?.canAdvance) === JSON.stringify(["write-plan"]));
check("36.8 working 不可直接 communication/plugin-maintenance", workingDef?.canAdvance.includes("communication") === false && workingDef?.canAdvance.includes("plugin-maintenance") === false && workingDef?.canAdvance.includes("memory-maintenance") === true);
{
  const mainChallenge = stageDefinitionFor(MAIN_ROLE, "challenge-plan");
  const workerChallenge = stageDefinitionFor("worker", "challenge-plan");
  check(
    "主 challenge-plan task 先批评/识别真弱点/不制造批评",
    typeof mainChallenge?.task === "string" &&
      mainChallenge.task.includes("Critique the approach first") &&
      mainChallenge.task.includes("identify real weaknesses") &&
      mainChallenge.task.includes("do not manufacture criticism"),
  );
  check(
    "worker challenge-plan task 先批评/识别真弱点/不制造批评",
    typeof workerChallenge?.task === "string" &&
      workerChallenge.task.includes("Critique the delegation first") &&
      workerChallenge.task.includes("identify real weaknesses") &&
      workerChallenge.task.includes("do not manufacture criticism"),
  );
  check(
    "worker challenge-plan 只可推进 check-tools",
    JSON.stringify(workerChallenge?.canAdvance) === JSON.stringify(["check-tools"]),
  );
  check(
    "worker challenge task 含文件工具只在 working 授予；check-tools task 含不得提前报告/阻断判定",
    typeof workerChallenge?.task === "string" &&
      workerChallenge.task.includes("full working file-tool set (edit, write, pwsh, read) is granted in working, not here") &&
      typeof stageDefinitionFor("worker", "check-tools")?.task === "string" &&
      stageDefinitionFor("worker", "check-tools").task.includes("genuine blocker") &&
      stageDefinitionFor("worker", "check-tools").task.includes("Do not report tool insufficiency before reaching working"),
  );
  check(
    "主 working task 含委派后 single settled 到达/复核报告/强制 memory gate 语义",
    typeof workingDef?.task === "string" &&
      workingDef.task.includes("single subagent-settled message") &&
      workingDef.task.includes("Reply once with send_message to resume it") &&
      workingDef.task.includes("Monitor/verify reports") &&
      workingDef.task.includes("advance to memory-maintenance before communication"),
  );
}
check("decide-goal 定义含 working 与 goal-active", canAdvance(MAIN_ROLE, "decide-goal", "working") === true && canAdvance(MAIN_ROLE, "decide-goal", GOAL_ACTIVE_STAGE) === true);
check("子代理 role stage 定义齐全", ["worker", "memoryMaintainer", "pluginMaintainer"].every((role) => stageIdsForRole(role).length >= 4));
const writePlanText = stageInjectionText(MAIN_ROLE, "write-plan", { taskPlanPath: "C:/tmp/task-plan.json" });
check("write-plan 注入携带 Allowed/Can advance/Task/taskPlanPath", writePlanText.includes("taskPlanPath: C:/tmp/task-plan.json"));
{
  const staged = [
    ["main", "assess-complexity"],
    ["main", "challenge-plan"],
    ["main", "communication"],
    ["worker", "assess-complexity"],
    ["worker", "challenge-plan"],
    ["worker", "communication"],
    ["memoryMaintainer", "communication"],
    ["pluginMaintainer", "communication"],
  ];
  check(
    "Context 注记：STAGE_CONTEXT_NOTES 覆盖目标角色/stage",
    staged.every(
      ([role, stage]) =>
        typeof STAGE_CONTEXT_NOTES?.[role]?.[stage] === "string" &&
        STAGE_CONTEXT_NOTES[role][stage].length > 0,
    ),
  );
  const assessText = stageInjectionText(MAIN_ROLE, "assess-complexity");
  const commText = stageInjectionText(MAIN_ROLE, "communication");
  const noNoteText = stageInjectionText(MAIN_ROLE, "working", { taskPlanPath: "C:/p.json" });
  check(
    "Context 注记：有注记 stage 在 Task 行后输出 Context，无注记 stage 不输出",
    assessText.includes("\nContext: ") &&
      commText.includes("\nContext: ") &&
      assessText.indexOf("Task:") < assessText.indexOf("Context:") &&
      !noNoteText.includes("Context:"),
  );
}
check(
  "Minimal 提示由 stageInjectionText 可选 minimalTools 参数承载：有值输出、缺省不输出",
  stageInjectionText(MAIN_ROLE, "assess-complexity", { minimalTools: ["memory_search", "context_search"] }).includes("Minimal (first round only): [memory_search, context_search] until your first tool call; then the Allowed tools above unlock.") &&
    stageInjectionText(MAIN_ROLE, "assess-complexity", { minimalTools: ["memory_search", "context_search"] }).indexOf("Minimal (first round only):") > stageInjectionText(MAIN_ROLE, "assess-complexity", { minimalTools: ["memory_search", "context_search"] }).indexOf("Can advance to:") &&
    !stageInjectionText(MAIN_ROLE, "assess-complexity").includes("Minimal (first round only):"),
);
{
  const waitStages = ["working", "memory-maintenance", "plugin-maintenance"];
  const waitOk = waitStages.every((stage) => {
    const text = stageInjectionText(MAIN_ROLE, stage);
    if (stage === "working") {
      return (
        text.includes("single subagent-settled message") &&
        text.includes("Reply once with send_message to resume it")
      );
    }
    return (
      text.includes("each child's full report arrives as one subagent-settled message") &&
      text.includes("reply once with send_message to resume")
    );
  });
  check("working/memory-maintenance/plugin-maintenance 阶段注入含等待/回复恢复语义", waitOk);
  check("working/memory-maintenance/plugin-maintenance 阶段注入含多轮复用口径", stageInjectionText(MAIN_ROLE, "working").includes("Whether to reuse is determined by the main agent") && stageInjectionText(MAIN_ROLE, "memory-maintenance").includes("memoryMaintainer sub-agent can be reused multiple times") && stageInjectionText(MAIN_ROLE, "plugin-maintenance").includes("Whether to reuse is determined by the main agent"));
}

{
  const PLAN_FILE = join(TMP, "ka-whale-workflow-task-plan.json");
  const planStore = createTaskPlanStore(PLAN_FILE);
  planStore.persistDraftItems([{ planItemId: "p1", persona: "worker", task: "Do work", assignedTools: [] }]);
  check("内部 store draft 兼容项仍不可委派（workflow 只在 write-plan 写 plan）", planStore.get("p1")?.status === "draft" && resolvePlanItemForDelegation(planStore, "p1").ok === false);
  planStore.persistFinalPayload({ status: "finalized", items: [{ planItemId: "p1", persona: "worker", task: "Do work", assignedTools: [] }] });
  check("write-plan 定稿为 finalized 且可委派", planStore.get("p1")?.status === "finalized" && resolvePlanItemForDelegation(planStore, "p1").ok === true);
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nKA-WHALE-WORKFLOW PROBE OK" : `\nKA-WHALE-WORKFLOW PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
