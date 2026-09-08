// ka-whale-workflow 探针（v0.9 口径，Goal 模式已移除）：
//   - v0.9 stage 常量与注入文本（含 minimalTools 可选首轮提示）；
//   - stage store 只接受 v0.9 / 状态壳；
//   - 不再读写旧 reconstruction / classification / goal-recovery；
//   - 新轮路由、历史 goal-active/working-resumed 旧值防御、/goal 不再旁路；
//   - task plan 草稿/定稿；阶段定义与注入文本。
// 运行：node KazPlugins/ka-whale-workflow/probe-ka-whale-workflow.mjs
import plugin, {
  WHALE_REPORT_TOOL,
  KA_SUB_WHALE_TOOL,
  WORK_SUB_WHALE_REPORT_TOOL,
  MEMORY_SUB_WHALE_REPORT_TOOL,
  PLUGIN_MAINTAINER_SUB_WHALE_REPORT_TOOL,
  stageOf,
  setStage,
  createStageStore,
  isUserMessage,
  nextStageOnUserMessage,
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
  isFinalReportStage,
  terminalStageIdsForRole,
} from "./lib/stage-defs.js";
import { createTaskPlanStore, resolvePlanItemForDelegation, TASK_PLAN_STORE_VERSION, PLAN_PERSONAS, validateFinalPayloadItems, validateFinalPlanPayload, taskPlansDirectoryFor, runPlanFileFor, currentRunPointerFileFor, readRunPlanItems, readCurrentRunPointer, persistFinalPlanRun } from "./lib/task-plan-store.js";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
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
check("MAIN_STAGE_IDS 9 个主阶段且不含 decide-goal/goal-active", MAIN_STAGE_IDS.length === 9 && !MAIN_STAGE_IDS.includes("decide-goal") && !MAIN_STAGE_IDS.includes("goal-active") && !MAIN_STAGE_IDS.includes("working-resumed"));

// Stage store clean: only v0.9 stages + shells are accepted.
check("初始阶段 idle", stageOf(agent, store) === "idle");
check("setStage 接受 v0.9 stage", setStage(agent, "assess-complexity", store) === true && stageOf(agent, store) === "assess-complexity");
check("setStage 接受 done 状态壳", setStage(agent, "done", store) === true && stageOf(agent, store) === "done");
check("旧 goal-active/working-resumed/reconstruction/classification/goal-recovery 拒绝", setStage(agent, "goal-active", store) === false && setStage(agent, "working-resumed", store) === false && setStage(agent, "reconstruction", store) === false && setStage(agent, "classification", store) === false && setStage(agent, "goal-recovery", store) === false);
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
    stage: "save-update-then-compress-context-then-report",
    assignedTools: [],
    finalTools: ["memory_search", "memory_sub_whale_report"],
    awaitingParent: true,
    terminalFinal: true,
  });
  store.set("mem-child-reuse", "save-update-then-compress-context-then-report");
  let parsed = JSON.parse(readFileSync(STORE_FILE, "utf8").replace(/^\uFEFF/, ""));
  check(
    "subagentRoleParents 持久化 parent→role→child 且角色记录含 parentId/stage/terminalFinal",
    parsed.subagentRoleParents?.["s-whale"]?.["memoryMaintainer"]?.includes("mem-child-reuse") === true &&
      parsed.subagentRoles?.["mem-child-reuse"]?.parentId === "s-whale" &&
      parsed.subagentRoles?.["mem-child-reuse"]?.stage === "save-update-then-compress-context-then-report" &&
      parsed.subagentRoles?.["mem-child-reuse"]?.terminalFinal === true,
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
check("36.5/37.5 活动阶段新消息保留当前阶段", nextStageOnUserMessage("working", 2) === "working" && nextStageOnUserMessage("challenge-plan", 3) === "challenge-plan" && nextStageOnUserMessage("decide-tools-before-writing-plan", 2) === "decide-tools-before-writing-plan" && nextStageOnUserMessage("write-plan", 2) === "write-plan" && nextStageOnUserMessage("memory-maintenance", 2) === "memory-maintenance");
check("nextStageOnUserMessage 把旧 merged 终态字符串视为 legacy terminal（不崩）", nextStageOnUserMessage("compress_context_then_communication", 2) === "assess-complexity");
check("stale goal-active/working-resumed 旧值回到 assess-complexity", nextStageOnUserMessage("goal-active", 2, { goalActive: true }) === "assess-complexity" && nextStageOnUserMessage("goal-active", 2) === "assess-complexity" && nextStageOnUserMessage("working-resumed", 2) === "assess-complexity");

check("真实用户消息判定", isUserMessage({ content: [], source: { kind: "user" } }) === true && isUserMessage({ content: [] }) === true);
check("plugin/goal/tool 消息判定为假", isUserMessage({ content: [], source: { kind: "plugin", plugin: "ka-whale-workflow" } }) === false && isUserMessage({ content: [], source: { kind: "goal" } }) === false && isUserMessage({ content: [], source: { kind: "tool" } }) === false);
check("subagent report/settled 消息判定为假", isUserMessage({ content: [], source: { kind: "subagent-report", form: "relay" } }) === false && isUserMessage({ content: [], source: { kind: "subagent-settled", form: "notice" } }) === false);
check("37.5 从 subagent-report/settled 提取 child session id", subagentReportChildSessionIdOf({ content: [], source: { kind: "subagent-report", senderSessionId: "child-1" } }) === "child-1" && subagentReportChildSessionIdOf({ content: [], source: { kind: "subagent-settled", senderSessionId: "child-2" } }) === "child-2" && subagentReportChildSessionIdOf({ content: [], source: { kind: "user" } }) === "");
check("父主 send_message 判定：coordinator/relay 为真，其它 source 为假", isParentMainSendMessage({ content: [], source: { kind: "coordinator", form: "relay", senderSessionId: "parent" } }) === true && isParentMainSendMessage({ content: [], source: { kind: "coordinator", form: "other" } }) === false && isParentMainSendMessage({ content: [], source: { kind: "user" } }) === false && isParentMainSendMessage({ content: [] }) === false);
check("报告硬等门常量导出", SUB_WHALE_REPORT_WAIT_NOTICE.includes("Stage advanced; now output your full report as your final message") && SUB_WHALE_REPORT_WAIT_NOTICE.includes("parent receives it as subagent-settled") && SUB_WHALE_REPORT_WAIT_NOTICE.includes("do not call further tools") && SUB_WHALE_REPORT_WAIT_DENY_CODE === "subagent-report-wait-deny");

check("v0.9 工具名（三角色、无 pluginCreator/plugin_creator_sub_whale_report）", KA_SUB_WHALE_TOOL === "ka_sub_whale" && WORK_SUB_WHALE_REPORT_TOOL === "work_sub_whale_report" && MEMORY_SUB_WHALE_REPORT_TOOL === "memory_sub_whale_report" && PLUGIN_MAINTAINER_SUB_WHALE_REPORT_TOOL === "plugin_maintainer_sub_whale_report" && !V09_SUBAGENT_ROLES.includes("pluginCreator"));
check("v0.9 stage 常量导出（9 主阶段全名；三角色）", MAIN_ROLE === "main" && JSON.stringify(MAIN_STAGE_IDS) === JSON.stringify(["assess-complexity","challenge-plan","decide-tools-before-writing-plan","write-plan","working","memory-maintenance","plugin-maintenance","compass_context_before_communication","communication"]) && !MAIN_STAGE_IDS.includes("plugin-preflight") && V09_SUBAGENT_ROLES.length === 3 && !V09_SUBAGENT_ROLES.includes("pluginCreator") && V09_STAGE_IDS.length > 0);

const assessDef = stageDefinitionFor(MAIN_ROLE, "assess-complexity");
const workingDef = stageDefinitionFor(MAIN_ROLE, "working");
check("主 stage 定义与 v0.9 一致", assessDef?.allowedTools.includes("whale_report") && workingDef?.canAdvance.includes("write-plan"));
check("双层语义：主 assess allowedTools = memory/context/whale_report（Minimal 不再由 stage 收口；ask_user_question 留 challenge-plan；不放 context_compress/read）", JSON.stringify(assessDef?.allowedTools) === JSON.stringify(["memory_search", "memory_detail", "memory_list", "context_search", "context_read", "whale_report"]) && !assessDef?.allowedTools.includes("read") && !assessDef?.allowedTools.includes("ask_user_question") && !assessDef?.allowedTools.includes("context_compress"));
{
  const mainNonMinimal = ["challenge-plan", "decide-tools-before-writing-plan", "write-plan", "working", "memory-maintenance", "plugin-maintenance"];
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
    worker: "challenge-plan",
    memoryMaintainer: "plan-memory",
    pluginMaintainer: "plan-plugin",
  };
  const subagentReportTools = {
    worker: "work_sub_whale_report",
    memoryMaintainer: "memory_sub_whale_report",
    pluginMaintainer: "plugin_maintainer_sub_whale_report",
  };
  check(
    "受控子代理初始 planning stage 含各自 report/context tools 且不放 context_compress",
    Object.entries(subagentInitialStages).every(([role, stage]) => {
      const tools = stageDefinitionFor(role, stage)?.allowedTools ?? [];
      return tools.includes(subagentReportTools[role]) && tools.includes("context_search") && tools.includes("context_read") && !tools.includes("context_compress");
    }),
  );
}
{
  const subagentNonMinimal = {
    worker: ["challenge-plan", "working-then-compress-context-then-report"],
    memoryMaintainer: ["plan-memory", "save-update-then-compress-context-then-report", "delete-memory-then-compress-context-then-report"],
    pluginMaintainer: ["plan-plugin", "create-plugin-then-compress-context-then-report", "update-plugin-then-compress-context-then-report", "retire-plugin-then-compress-context-then-report"],
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
  const finalStages = {
    worker: ["working-then-compress-context-then-report"],
    memoryMaintainer: ["save-update-then-compress-context-then-report", "delete-memory-then-compress-context-then-report"],
    pluginMaintainer: ["create-plugin-then-compress-context-then-report", "update-plugin-then-compress-context-then-report", "retire-plugin-then-compress-context-then-report"],
  };
  check(
    "main communication allowedTools = whale_report+plan_read；各 role 最后执行阶段 = context_compress + 各自 report 且 terminal:true",
    JSON.stringify(stageDefinitionFor("main", "communication")?.allowedTools) === JSON.stringify(["whale_report", "plan_read"]) &&
      Object.entries(finalStages).every(([role, stages]) =>
        stages.every((stage) => {
          const def = stageDefinitionFor(role, stage);
          return def !== null &&
            def.allowedTools.includes("context_compress") &&
            def.allowedTools.includes(reportTools[role]) &&
            def.terminal === true;
        }),
      ),
  );
  check(
    "terminal 不变量：worker/memoryMaintainer/pluginMaintainer 恰为其执行阶段，planning stage 不是 terminal",
    JSON.stringify(terminalStageIdsForRole("worker")) === JSON.stringify(["working-then-compress-context-then-report"]) &&
      JSON.stringify(terminalStageIdsForRole("memoryMaintainer")) === JSON.stringify(["save-update-then-compress-context-then-report", "delete-memory-then-compress-context-then-report"]) &&
      JSON.stringify(terminalStageIdsForRole("pluginMaintainer")) === JSON.stringify(["create-plugin-then-compress-context-then-report", "update-plugin-then-compress-context-then-report", "retire-plugin-then-compress-context-then-report"]) &&
      !isFinalReportStage("worker", "challenge-plan") &&
      !isFinalReportStage("memoryMaintainer", "plan-memory") &&
      !isFinalReportStage("pluginMaintainer", "plan-plugin"),
  );
}
check("37.5 新图：write-plan 可到 working/maintenance/communication", ["working", "memory-maintenance", "plugin-maintenance", "compass_context_before_communication", "communication"].every((stage) => canAdvance(MAIN_ROLE, "write-plan", stage)));
check("working 图：可到 decide-tools-before-writing-plan/write-plan/memory-maintenance", workingDef?.canAdvance.includes("decide-tools-before-writing-plan") === true && workingDef?.canAdvance.includes("write-plan") === true && workingDef?.canAdvance.includes("memory-maintenance") === true);
check("37.5 新图：memory-maintenance 可回 write-plan", canAdvance(MAIN_ROLE, "memory-maintenance", "write-plan") === true && canAdvance(MAIN_ROLE, "memory-maintenance", "plugin-maintenance") === true && canAdvance(MAIN_ROLE, "memory-maintenance", "communication") === true);
check("37.5 plugin-preflight 不再是主阶段且 decide-tools-before-writing-plan 只到 write-plan", stageDefinitionFor(MAIN_ROLE, "plugin-preflight") === null && JSON.stringify(stageDefinitionFor(MAIN_ROLE, "decide-tools-before-writing-plan")?.canAdvance) === JSON.stringify(["write-plan"]));
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
      workerChallenge.task.includes("Critique the assigned task first") &&
      workerChallenge.task.includes("identify real weaknesses") &&
      workerChallenge.task.includes("do not manufacture criticism"),
  );
  check(
    "worker challenge-plan 只可推进 working-then-compress-context-then-report",
    JSON.stringify(workerChallenge?.canAdvance) === JSON.stringify(["working-then-compress-context-then-report"]),
  );
  check(
    "主 working task 含委派后 single settled 到达/复核报告/强制 memory gate 语义",
    typeof workingDef?.task === "string" &&
      workingDef.task.includes("single subagent-settled message") &&
      workingDef.task.includes("reply with send_message to resume it") &&
      workingDef.task.includes("We wait for the report, verify it") &&
      workingDef.task.includes("advance to memory-maintenance before communication"),
  );
}
check("decide-goal 无主 stage 定义且不可从 write-plan 推进", stageDefinitionFor(MAIN_ROLE, "decide-goal") === null && canAdvance(MAIN_ROLE, "write-plan", "decide-goal") === false);
check("子代理 role stage 定义无旧终态阶段（长度固定且无 compress_context_then_communication）", stageIdsForRole("worker").length === 2 && stageIdsForRole("memoryMaintainer").length === 3 && stageIdsForRole("pluginMaintainer").length === 4 && ["worker", "memoryMaintainer", "pluginMaintainer"].every((role) => !stageIdsForRole(role).includes("compress_context_then_communication")));
const writePlanText = stageInjectionText(MAIN_ROLE, "write-plan", { taskPlanPath: "C:/tmp/task-plan.json" });
check("write-plan 注入携带 Allowed/Can advance/Task/taskPlanPath", writePlanText.includes("taskPlanPath: C:/tmp/task-plan.json"));
{
  const staged = [
    ["main", "assess-complexity"],
    ["main", "challenge-plan"],
    ["main", "communication"],
    ["worker", "challenge-plan"],
    ["worker", "working-then-compress-context-then-report"],
    ["memoryMaintainer", "save-update-then-compress-context-then-report"],
    ["memoryMaintainer", "delete-memory-then-compress-context-then-report"],
    ["pluginMaintainer", "create-plugin-then-compress-context-then-report"],
    ["pluginMaintainer", "update-plugin-then-compress-context-then-report"],
    ["pluginMaintainer", "retire-plugin-then-compress-context-then-report"],
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
    return (
      text.includes("final: true") &&
      text.includes("send_message") &&
      text.includes("subagent-settled message") &&
      text.includes("TERMINAL full report")
    );
  });
  check("working/memory-maintenance/plugin-maintenance 阶段注入含等待/回复恢复语义", waitOk);
  check("working/memory-maintenance/plugin-maintenance 阶段注入含多轮复用口径", stageInjectionText(MAIN_ROLE, "working").includes("send_message to continue that child") && stageInjectionText(MAIN_ROLE, "memory-maintenance").includes("memoryMaintainer sub-agent can be reused multiple times") && stageInjectionText(MAIN_ROLE, "plugin-maintenance").includes("Whether to reuse is determined by the main agent"));
}

check("TASK_PLAN_STORE_VERSION 升至 v3 且 PLAN_PERSONAS 固定为四值", TASK_PLAN_STORE_VERSION === 3 && JSON.stringify([...PLAN_PERSONAS]) === JSON.stringify(["main", "worker", "memoryMaintainer", "pluginMaintainer"]));

{
  const PLAN_FILE = join(TMP, "ka-whale-workflow-task-plan.json");
  const planStore = createTaskPlanStore(PLAN_FILE);
  planStore.persistDraftItems([{ planItemId: "p1", persona: "worker", task: "Do work", assignedTools: [] }]);
  check("内部 store draft 兼容项仍不可委派（workflow 只在 write-plan 写 plan）", planStore.get("p1")?.status === "draft" && resolvePlanItemForDelegation(planStore, "p1").ok === false);

  const finalResult = planStore.persistFinalPayload({
    status: "finalized",
    items: [
      {
        planItemId: "p1",
        persona: "worker",
        task: "Do work",
        summary: "  Build the module  ",
        dependsOn: ["p0", "", "p0", "p2"],
        targets: ["src/a.js", "src/a.js"],
        verification: ["node --check", "node --check"],
        assignedTools: ["job_list", "", "job_list"],
      },
      {
        planItemId: "p-main",
        persona: "main",
        task: "Main line task",
        summary: 42,
        dependsOn: "not-an-array",
        targets: [123],
        verification: [null],
        assignedTools: [],
      },
    ],
  });
  const p1After = planStore.get("p1");
  const pMainAfter = planStore.get("p-main");
  check(
    "valid finalPlanPayload persists new schema v2 fields readable back",
    finalResult.ok === true &&
      p1After?.status === "finalized" &&
      p1After?.summary === "Build the module" &&
      JSON.stringify(p1After?.dependsOn) === JSON.stringify(["p0", "p2"]) &&
      JSON.stringify(p1After?.targets) === JSON.stringify(["src/a.js"]) &&
      JSON.stringify(p1After?.verification) === JSON.stringify(["node --check"]) &&
      JSON.stringify(p1After?.assignedTools) === JSON.stringify(["job_list"]) &&
      resolvePlanItemForDelegation(planStore, "p1").ok === true,
  );
  check(
    "malformed optional strings treated as absent and malformed optional arrays normalized like assignedTools",
    finalResult.ok === true &&
      pMainAfter?.summary === "" &&
      JSON.stringify(pMainAfter?.dependsOn) === "[]" &&
      JSON.stringify(pMainAfter?.targets) === "[]" &&
      JSON.stringify(pMainAfter?.verification) === "[]",
  );

  const beforeInvalid = readFileSync(PLAN_FILE, "utf8");
  const invalidPersona = planStore.persistFinalPayload({
    status: "finalized",
    items: [{ planItemId: "bad-persona", persona: "coder", task: "Bad persona task" }],
  });
  check(
    "free-text persona rejects with structured plan-item-invalid/invalid-persona and file unchanged",
    invalidPersona.ok === false &&
      invalidPersona.code === "plan-item-invalid" &&
      invalidPersona.rejected.some((entry) => entry.planItemId === "bad-persona" && entry.code === "invalid-persona" && entry.reason.includes("main, worker, memoryMaintainer, pluginMaintainer")) &&
      readFileSync(PLAN_FILE, "utf8") === beforeInvalid &&
      planStore.get("bad-persona") === null,
  );

  const missingTask = planStore.persistFinalPayload({
    status: "finalized",
    items: [{ planItemId: "no-task", persona: "worker", task: "   " }],
  });
  check(
    "empty/missing task rejects with structured code missing-task and file unchanged",
    missingTask.ok === false &&
      missingTask.code === "plan-item-invalid" &&
      missingTask.rejected.some((entry) => entry.planItemId === "no-task" && entry.code === "missing-task") &&
      readFileSync(PLAN_FILE, "utf8") === beforeInvalid &&
      planStore.get("no-task") === null,
  );

  const beforeMix = readFileSync(PLAN_FILE, "utf8");
  const mixed = planStore.persistFinalPayload({
    status: "finalized",
    items: [
      { planItemId: "valid-in-mix", persona: "worker", task: "Should not be kept", assignedTools: [] },
      { planItemId: "bad-in-mix", persona: "coder", task: "Invalid persona" },
    ],
  });
  check(
    "partial invalid + valid mix rejects everything atomically (nothing persisted, no partial memory commit)",
    mixed.ok === false &&
      mixed.code === "plan-item-invalid" &&
      mixed.rejected.some((entry) => entry.planItemId === "bad-in-mix" && entry.code === "invalid-persona") &&
      readFileSync(PLAN_FILE, "utf8") === beforeMix &&
      planStore.get("valid-in-mix") === null &&
      planStore.get("bad-in-mix") === null,
  );

  const badStatus = planStore.persistFinalPayload({
    status: "draft",
    items: [{ planItemId: "status-ok", persona: "worker", task: "Task" }],
  });
  check("top-level status must be finalized (plan-item-invalid rejection before persist)", badStatus.ok === false && badStatus.code === "plan-item-invalid" && badStatus.rejected.some((entry) => entry.code === "invalid-final-status"));

  const emptyItems = planStore.persistFinalPayload({ status: "finalized", items: [] });
  check("top-level items must be a non-empty array (plan-item-invalid rejection)", emptyItems.ok === false && emptyItems.code === "plan-item-invalid" && emptyItems.rejected.some((entry) => entry.code === "empty-plan-items"));

  const helper = validateFinalPayloadItems([
    {},
    { planItemId: "", persona: "", task: "" },
    { planItemId: 7, persona: "coder", task: "" },
    { planItemId: "ok", persona: "worker", task: "ok" },
  ]);
  const helperCodes = helper.rejected.map((entry) => entry.code);
  check(
    "validateFinalPayloadItems returns canonical per-item codes",
    helper.ok === false &&
      helper.code === "plan-item-invalid" &&
      helperCodes.includes("missing-plan-item-id") &&
      helperCodes.includes("invalid-plan-item-id") &&
      helperCodes.includes("missing-persona") &&
      helperCodes.includes("invalid-persona") &&
      helperCodes.includes("missing-task"),
  );
  check("validateFinalPlanPayload rejects non-finalized/non-array top-level containers", validateFinalPlanPayload(null).ok === false && validateFinalPlanPayload({ status: "draft", items: [] }).ok === false && validateFinalPlanPayload({ status: "finalized", items: [{ planItemId: "x", persona: "worker", task: "ok" }] }).ok === true);
}

{
  const V1_FILE = join(TMP, "ka-whale-workflow-task-plan-v1.json");
  writeFileSync(
    V1_FILE,
    JSON.stringify(
      {
        version: 1,
        plans: {
          old: { planItemId: "old", status: "draft", persona: "worker", task: "Old v1 task", assignedTools: ["job_list"] },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  const v1Store = createTaskPlanStore(V1_FILE);
  const oldBefore = v1Store.get("old");
  v1Store.persistFinalPayload({
    status: "finalized",
    items: [{ planItemId: "old", persona: "worker", task: "Old v1 task", assignedTools: ["job_list"] }],
  });
  const parsedV1 = JSON.parse(readFileSync(V1_FILE, "utf8"));
  check(
    "v1 task-plan file loads compatibly and is re-emitted as schema v3",
    oldBefore?.status === "draft" &&
      oldBefore?.summary === "" &&
      JSON.stringify(oldBefore?.dependsOn) === "[]" &&
      JSON.stringify(oldBefore?.targets) === "[]" &&
      JSON.stringify(oldBefore?.verification) === "[]" &&
      parsedV1?.version === 3 &&
      parsedV1?.plans?.old?.status === "finalized",
  );
}

{
  // k10-project-store run-scoped unit coverage: run file + current.json + amendment.
  const PROJECT = join(TMP, "project-run-store");
  const SESSION = "s-run-session";
  const RUN = 7;
  const planFile = runPlanFileFor(PROJECT, SESSION, RUN);
  const currentFile = currentRunPointerFileFor(PROJECT);
  const first = persistFinalPlanRun({
    projectRoot: PROJECT,
    sessionId: SESSION,
    runId: RUN,
    payload: {
      status: "finalized",
      items: [
        { planItemId: "p-run", persona: "worker", task: "Run item", summary: "run summary", targets: ["src"], assignedTools: [] },
        { planItemId: "p-main-run", persona: "main", task: "Main run item", assignedTools: [] },
      ],
    },
  });
  const pointer1 = JSON.parse(readFileSync(currentFile, "utf8"));
  check(
    "write-plan run finalization writes run file + current.json pointer",
    first.ok === true &&
      existsSync(planFile) &&
      pointer1?.version === 1 &&
      pointer1?.sessionId === SESSION &&
      pointer1?.runId === RUN &&
      pointer1?.planFile === planFile,
  );
  const runItems1 = readRunPlanItems(planFile);
  check(
    "run file items readable back and do not include unrelated global/legacy items",
    runItems1.some((item) => item.planItemId === "p-run" && item.summary === "run summary") &&
      runItems1.some((item) => item.planItemId === "p-main-run") &&
      !runItems1.some((item) => item.planItemId === "p-global"),
  );

  const second = persistFinalPlanRun({
    projectRoot: PROJECT,
    sessionId: SESSION,
    runId: RUN,
    payload: {
      status: "finalized",
      items: [
        { planItemId: "p-run", persona: "worker", task: "Run item amended", summary: "updated", assignedTools: [] },
        { planItemId: "p-added", persona: "memoryMaintainer", task: "Added in amendment", assignedTools: [] },
      ],
    },
  });
  const pointer2 = JSON.parse(readFileSync(currentFile, "utf8"));
  const runFiles = readdirSync(taskPlansDirectoryFor(PROJECT)).filter((name) => name.endsWith(".json") && name !== "current.json");
  check(
    "amendment rewrites same run file and current pointer (no new run accumulation)",
    second.ok === true &&
      pointer2?.runId === RUN &&
      pointer2?.planFile === planFile &&
      runFiles.length === 1 &&
      readRunPlanItems(planFile).some((item) => item.planItemId === "p-added"),
  );

  const beforeInvalid = readFileSync(planFile, "utf8");
  const invalidRun = persistFinalPlanRun({
    projectRoot: PROJECT,
    sessionId: SESSION,
    runId: RUN,
    payload: {
      status: "finalized",
      items: [{ planItemId: "bad", persona: "coder", task: "bad" }],
    },
  });
  check(
    "invalid final payload in run mode rejects atomically and leaves run file/pointer unchanged",
    invalidRun.ok === false &&
      invalidRun.code === "plan-item-invalid" &&
      readFileSync(planFile, "utf8") === beforeInvalid,
  );
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nKA-WHALE-WORKFLOW PROBE OK" : `\nKA-WHALE-WORKFLOW PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
