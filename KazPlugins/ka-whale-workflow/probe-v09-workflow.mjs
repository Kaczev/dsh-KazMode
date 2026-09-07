// ka-whale-workflow v0.9 探针：主/子 stage 机 + tools/pre-execute 软闸门 + 注入格式。
// 运行：node KazPlugins/ka-whale-workflow/probe-v09-workflow.mjs
import plugin, {
  createStageStore,
  KA_SUB_WHALE_TOOL,
  WORK_SUB_WHALE_REPORT_TOOL,
  MEMORY_SUB_WHALE_REPORT_TOOL,
  SUB_WHALE_REPORT_WAIT_NOTICE,
  SUB_WHALE_REPORT_WAIT_DENY_CODE,
  isParentMainSendMessage,
} from "./lib/index.js";
import {
  MAIN_ROLE,
  MAIN_STAGE_IDS,
  FIRST_ROUND_STARTUP_FORM,
  FIRST_ROUND_STARTUP_TEXT,
  WORKER_STAGE_IDS,
  MEMORY_MAINTAINER_STAGE_IDS,
  PLUGIN_MAINTAINER_STAGE_IDS,
  stageInjectionText,
  STAGE_CONTEXT_NOTES,
  stageDefinitionFor,
  canAdvance,
} from "./lib/stage-defs.js";
import { createTaskPlanStore, resolvePlanItemForDelegation } from "./lib/task-plan-store.js";
import { KAZ_ROLE_PROMPTS } from "../kaz-shared/lib/tool-lists.js";
import { computeV09FinalSurface } from "../kaz-shared/lib/subagent-policy.js";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

const TMP = mkdtempSync(join(tmpdir(), "whale-v09-"));
const STORE_FILE = join(TMP, "ka-whale-workflow-stage.json");
const PLAN_FILE = join(TMP, "ka-whale-workflow-task-plan.json");
const store = createStageStore(STORE_FILE);
store.set("s-v09", "done");
const MEM_BASE_SURFACE = computeV09FinalSurface({
  role: "memoryMaintainer",
  assignedTools: [],
});
// memoryMaintainer 强制复用：先放一个“不同 surface”终态 child（避免第一次 p-memory
// 被复用），真正可复用 child 由 runtime 第一次 spawn 后推进到 communication 再验证。
store.setSubagentRole("child-memory-other-surface", {
  planItemId: "p-memory",
  persona: "memoryMaintainer",
  parentId: "s-v09",
  stage: "communication",
  assignedTools: [],
  finalTools: ["memory_search", "not_current_surface"],
  awaitingParent: true,
});
store.set("child-memory-other-surface", "communication");
const planStore = createTaskPlanStore(PLAN_FILE);
planStore.persistDraftItems([
  { planItemId: "p1", persona: "worker", task: "Do task", assignedTools: [] },
  { planItemId: "p-main", persona: "main", task: "Main line task", assignedTools: [] },
  { planItemId: "p-memory", persona: "memoryMaintainer", task: "Write memory", assignedTools: [] },
  { planItemId: "p-memory-2", persona: "memoryMaintainer", task: "Write memory two", assignedTools: [] },
  { planItemId: "p-maintainer", persona: "pluginMaintainer", task: "Maintain plugin", assignedTools: [] },
  { planItemId: "p-draft", persona: "worker", task: "Draft only", assignedTools: [] },
]);
planStore.persistFinalPayload({
  status: "finalized",
  items: [
    { planItemId: "p1", persona: "worker", task: "Do task", assignedTools: [] },
    { planItemId: "p-main", persona: "main", task: "Main line task", assignedTools: [] },
    { planItemId: "p-memory", persona: "memoryMaintainer", task: "Write memory", assignedTools: [] },
    { planItemId: "p-memory-2", persona: "memoryMaintainer", task: "Write memory two", assignedTools: [] },
    { planItemId: "p-maintainer", persona: "pluginMaintainer", task: "Maintain plugin", assignedTools: [] },
  ],
});

const rdReports = [];
const promptSections = [];
const startedSubagentRequests = [];
const capturedFollowups = [];
const childCatalog = new Map();
const agentRegistry = new Map();
const sessionsRegistry = new Map();
// --- minimal plugin mock ---
const listeners = new Map();
const registeredTools = new Map();
const settings = {
  register(ns, _schema, opts = {}) {
    let current = { ...(opts.base ?? {}) };
    return {
      get: () => ({ ...current }),
      watch: () => () => {},
      update: (patch) => { current = { ...current, ...patch }; return Promise.resolve(); },
    };
  },
  get: () => ({ enabled: true, includeSubagents: false }),
  update: () => Promise.resolve(),
};
const toolsMock = {
  register(def) {
    registeredTools.set(def.name, def);
    return () => registeredTools.delete(def.name);
  },
  schemas() {
    return [...registeredTools.keys()].map((name) => ({ name, description: "", parameters: {} }));
  },
  get(name) {
    return registeredTools.get(name);
  },
};
const mockKazMode = {
  kazEnabled: () => true,
  pluginConfig: () => ({ enabled: true, includeSubagents: false }),
  toolVisible: () => true,
};
const base = {
  fiber: { state: 0 },
  logger: { info: () => {}, warn: (...a) => console.log("[mock:warn]", ...a), debug: () => {} },
  async plugin() { return; },
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(fn);
    return () => {};
  },
  inject(deps, cb) {
    if (deps.includes("settings")) setImmediate(() => cb({ ...base, settings }));
  },
  effect(fn) {
    const dispose = fn();
    return () => { if (typeof dispose === "function") dispose(); };
  },
  provide() { return () => {}; },
  get(name) {
    if (name === "settings") return settings;
    if (name === "tools") return toolsMock;
    if (name === "kazMode") return mockKazMode;
    if (name === "roundDisplay") return { report: (payload) => rdReports.push(payload) };
    if (name === "agents") return { get: (id) => agentRegistry.get(id) };
    if (name === "sessions") return { get: (id) => sessionsRegistry.get(id) };
    if (name === "subagents") {
      return {
        listChildren: async (parentId) =>
          [...childCatalog.values()].filter((entry) => entry.parentId === parentId),
        followup: async (parent, childId, content, options) => {
          capturedFollowups.push({ parent, childId, content, options });
          return `msg-v09-${capturedFollowups.length}`;
        },
        startContinuable: async (spec) => {
          startedSubagentRequests.push(spec?.request ?? null);
          const parentId = spec?.request?.parent?.id ?? spec?.request?.parent ?? "s-v09";
          childCatalog.set(spec?.childId, {
            id: spec?.childId,
            kind: "child",
            mode: "continuable",
            label: spec?.label ?? "",
            activity: "running",
            parentId,
          });
          return { childId: spec.childId };
        },
      };
    }
    return undefined;
  },
  systemPrompt: {
    section(section) {
      promptSections.push(section);
      return () => {};
    },
  },
  tools: toolsMock,
};

await plugin.apply(base, { stageStore: STORE_FILE, taskPlanStore: PLAN_FILE });
await new Promise((resolve) => setTimeout(resolve, 20));

const agent = {
  id: "s-v09",
  session: { id: "s-v09", events: [] },
  steer() {},
};
const userMessage = { content: [{ type: "text", text: "任务" }], source: { kind: "user" } };
const claimed = listeners.get("agent/inbox/claimed")?.[0];
const preExecute = listeners.get("tools/pre-execute")?.[0];
const whaleReport = registeredTools.get("whale_report");
const kaSubWhale = registeredTools.get(KA_SUB_WHALE_TOOL);
childCatalog.set("child-memory-other-surface", {
  id: "child-memory-other-surface",
  kind: "child",
  mode: "continuable",
  label: "kaz:memoryMaintainer:p-memory",
  activity: "running",
  parentId: "s-v09",
});

// 首轮 startup hint：新会话 turn 1、stage=idle、尚无 tool/call 时，pre-step
// 注入一次 [ka-whale-workflow first-round]，随后同一会话不重复注入。
{
  const preStep = listeners.get("agent/pre-step")?.[0];
  const startupTextsOf = (decision) =>
    (decision?.messages ?? [])
      .map((message) => (message?.content ?? []).map((part) => part?.text ?? "").join("\n"))
      .join("\n");
  const startupMessagesOf = (decision) =>
    (decision?.messages ?? []).filter(
      (message) =>
        message?.source?.kind === "plugin" &&
        message?.source?.plugin === "ka-whale-workflow" &&
        message?.source?.form === FIRST_ROUND_STARTUP_FORM,
    );

  const startupAgent = {
    id: "s-startup-hint",
    session: { id: "s-startup-hint", events: [] },
    steer() {},
  };
  const firstDecision = await preStep(
    { agent: startupAgent, turn: 1, messages: [userMessage] },
    async () => ({ kind: "enter", messages: [userMessage] }),
  );
  const firstText = startupTextsOf(firstDecision);
  const firstStartupMessages = startupMessagesOf(firstDecision);
  check(
    "首轮 idle+Minimal pre-step 注入 [ka-whale-workflow first-round] startup hint",
    firstText.includes("[ka-whale-workflow first-round]") &&
      firstText.includes("memory_search or context_search") &&
      firstStartupMessages.length === 1,
  );

  // 模拟真实会话事件已写入（插件 user message source.form=startup-tool-hint）。
  startupAgent.session.events.push({
    type: "user/message",
    data: {
      source: { kind: "plugin", plugin: "ka-whale-workflow", form: FIRST_ROUND_STARTUP_FORM },
    },
  });
  const secondDecision = await preStep(
    { agent: startupAgent, turn: 1, messages: [userMessage] },
    async () => ({ kind: "enter", messages: [userMessage] }),
  );
  check(
    "startup hint 每会话只注入一次（已注入事件后不再追加）",
    startupMessagesOf(secondDecision).length === 0,
  );

  // 已有 tool/call：不再属于首轮 Minimal，不注入 startup hint（可能注入 assess stage）。
  const toolAgent = {
    id: "s-startup-tool",
    session: { id: "s-startup-tool", events: [{ type: "tool/call" }] },
    steer() {},
  };
  const toolDecision = await preStep(
    { agent: toolAgent, turn: 1, messages: [userMessage] },
    async () => ({ kind: "enter", messages: [userMessage] }),
  );
  check("已有 tool/call 不注入 startup hint", startupMessagesOf(toolDecision).length === 0);

  // turn 2 起走正常 assess 路由，不注入 startup hint。
  const secondTurnAgent = {
    id: "s-startup-turn2",
    session: { id: "s-startup-turn2", events: [] },
    steer() {},
  };
  const secondTurnDecision = await preStep(
    { agent: secondTurnAgent, turn: 2, messages: [userMessage] },
    async () => ({ kind: "enter", messages: [userMessage] }),
  );
  check("非首轮（turn 2）不注入 startup hint", startupMessagesOf(secondTurnDecision).length === 0);
  check("FIRST_ROUND_STARTUP_TEXT 导出且标题正确", FIRST_ROUND_STARTUP_TEXT.startsWith("[ka-whale-workflow first-round]"));
}

// persona application: ka-whale-workflow no longer registers ka-whale-workflow:main
// (or any system section); kaz-system-prompt sets deployment:persona to
// KAZ_ROLE_PROMPTS.main for main and preserves KAZ_ROLE_PROMPTS.subagent.* children.
{
  const mainSection = promptSections.find((section) => section?.name === "ka-whale-workflow:main");
  const anyWhaleSection = promptSections.some((section) => typeof section?.name === "string" && section.name.startsWith("ka-whale-workflow:"));
  check(
    "persona application: ka-whale-workflow no longer registers ka-whale-workflow:main system section",
    mainSection === undefined && anyWhaleSection === false,
  );
}

// 纯函数层
check("主 stage ids 9 个且使用完整 stage 名", JSON.stringify(MAIN_STAGE_IDS) === JSON.stringify(["assess-complexity","challenge-plan","decide-tools-before-writing-plan","write-plan","working","memory-maintenance","plugin-maintenance","compass_context_before_communication","communication"]));
check("worker/memory/plugin stage ids 齐全且含 compass_context_before_communication", WORKER_STAGE_IDS.includes("working") && MEMORY_MAINTAINER_STAGE_IDS.includes("save-update") && PLUGIN_MAINTAINER_STAGE_IDS.includes("retire-plugin") && PLUGIN_MAINTAINER_STAGE_IDS.includes("create-plugin") && WORKER_STAGE_IDS.includes("compass_context_before_communication") && MEMORY_MAINTAINER_STAGE_IDS.includes("compass_context_before_communication") && PLUGIN_MAINTAINER_STAGE_IDS.includes("compass_context_before_communication"));
check("decide-goal/goal-active/working-resumed 均不在 MAIN_STAGE_IDS 且无 Goal 常量导出", !MAIN_STAGE_IDS.includes("decide-goal") && !MAIN_STAGE_IDS.includes("goal-active") && !MAIN_STAGE_IDS.includes("working-resumed") && MAIN_STAGE_IDS.length === 9 && !MAIN_STAGE_IDS.includes("plugin-preflight"));
{
  const roleReportTools = {
    main: "whale_report",
    worker: "work_sub_whale_report",
    memoryMaintainer: "memory_sub_whale_report",
    pluginMaintainer: "plugin_maintainer_sub_whale_report",
  };
  const roles = ["main", "worker", "memoryMaintainer", "pluginMaintainer"];
  const initialStages = {
    main: "assess-complexity",
    worker: "assess-complexity",
    memoryMaintainer: "assess-delegation",
    pluginMaintainer: "assess-delegation",
  };
  check(
    "communication allowedTools 只含各自 report 工具（37.5/当前语义）",
    roles.every((role) => JSON.stringify(stageDefinitionFor(role, "communication")?.allowedTools) === JSON.stringify([roleReportTools[role]])),
  );
  check(
    "双层语义：stage 初始 allowedTools 含 memory/context/report，不含 context_compress（Minimal 不再由 stage 收口）",
    roles.every((role) => {
      const allowed = stageDefinitionFor(role, initialStages[role])?.allowedTools ?? [];
      return (
        allowed.includes("memory_search") &&
        allowed.includes("context_search") &&
        allowed.includes("context_read") &&
        allowed.includes(roleReportTools[role]) &&
        !allowed.includes("context_compress")
      );
    }),
  );
  check(
    "stage 初始 allowedTools 仍不含 read（文件执行工具不属于初始阶段软闸门）",
    roles.every((role) => !stageDefinitionFor(role, initialStages[role])?.allowedTools.includes("read")),
  );
}
check("37.5 新图：decide-tools-before-writing-plan 只到 write-plan，write-plan 可到 working/maintenance/communication", JSON.stringify(stageDefinitionFor(MAIN_ROLE, "decide-tools-before-writing-plan")?.canAdvance) === JSON.stringify(["write-plan"]) && ["working", "memory-maintenance", "plugin-maintenance", "compass_context_before_communication", "communication"].every((stage) => canAdvance(MAIN_ROLE, "write-plan", stage)));
check("37.5 plugin-preflight 无主 stage 定义/无 taskPlanPath 注入", stageDefinitionFor(MAIN_ROLE, "plugin-preflight") === null && !stageInjectionText(MAIN_ROLE, "write-plan").includes("plugin-preflight"));
check("decide-goal 已移除：无主 stage 定义、write-plan 不可推进、注入为空", stageDefinitionFor(MAIN_ROLE, "decide-goal") === null && canAdvance(MAIN_ROLE, "write-plan", "decide-goal") === false && stageInjectionText(MAIN_ROLE, "decide-goal") === "");
check("goal-active/working-resumed 特殊文本导出已不存在", !Object.keys(await import("./lib/stage-defs.js")).some((key) => key === "GOAL_ACTIVE_CONTEXT_TEXT" || key === "workingResumedContextText" || key === "GOAL_ACTIVE_STAGE" || key === "WORKING_RESUMED_STAGE"));
check("write-plan 注入格式含 taskPlanPath", stageInjectionText(MAIN_ROLE, "write-plan", { taskPlanPath: "C:/plan.json" }).includes("taskPlanPath: C:/plan.json"));
check("create-plugin 注入格式含 lifecyclePath", stageInjectionText("pluginMaintainer", "create-plugin", { lifecyclePath: "C:/lifecycle.md" }).includes("lifecyclePath: C:/lifecycle.md"));
check("Context 注记：STAGE_CONTEXT_NOTES 冻结且覆盖目标角色/stage", STAGE_CONTEXT_NOTES !== undefined && Object.isFrozen(STAGE_CONTEXT_NOTES) && ["main", "worker", "memoryMaintainer", "pluginMaintainer"].every((role) => Object.isFrozen(STAGE_CONTEXT_NOTES[role])));
check("Context 注记：有注记 stage 在 Task 后输出，无注记 stage 不输出", ["main", "worker"].every((role) => stageInjectionText(role, "assess-complexity").includes("\nContext: ") && stageInjectionText(role, "challenge-plan").includes("\nContext: ")) && stageInjectionText("main", "communication").includes("\nContext: ") && stageInjectionText("worker", "communication").includes("\nContext: ") && stageInjectionText("memoryMaintainer", "communication").includes("\nContext: ") && stageInjectionText("pluginMaintainer", "communication").includes("\nContext: ") && !stageInjectionText(MAIN_ROLE, "working").includes("Context:"));
check("Minimal 提示由 stageInjectionText 可选 minimalTools 参数承载：有值输出、缺省不输出", stageInjectionText("worker", "assess-complexity", { minimalTools: ["memory_search", "context_search"] }).includes("Minimal (first round only): [memory_search, context_search] until your first tool call; then the Allowed tools above unlock.") && !stageInjectionText("worker", "assess-complexity").includes("Minimal (first round only):"));
check("advance 校验拒绝非法边", canAdvance(MAIN_ROLE, "assess-complexity", "working") === false);
{
  const challengeDef = stageDefinitionFor(MAIN_ROLE, "challenge-plan");
  const workerChallengeDef = stageDefinitionFor("worker", "challenge-plan");
  const workingText = stageInjectionText(MAIN_ROLE, "working", { taskPlanPath: "C:/plan.json" });
  const workingDef = stageDefinitionFor(MAIN_ROLE, "working");
  check("challenge-plan 不持有 ka_sub_whale 且任务禁止写 plan/调用子代理", !challengeDef?.allowedTools.includes("ka_sub_whale") && typeof challengeDef?.task === "string" && challengeDef.task.includes("Do not write task plans here") && challengeDef.task.includes("do not call ka_sub_whale"));
  check("主 challenge-plan task 含批评纪律", typeof challengeDef?.task === "string" && challengeDef.task.includes("Critique the approach first") && challengeDef.task.includes("identify real weaknesses") && challengeDef.task.includes("do not manufacture criticism"));
  check("worker challenge-plan task 含批评纪律", typeof workerChallengeDef?.task === "string" && workerChallengeDef.task.includes("Critique the assigned task first") && workerChallengeDef.task.includes("do not manufacture criticism"));
  check("worker challenge-plan 只可推进 working", JSON.stringify(workerChallengeDef?.canAdvance) === JSON.stringify(["working"]));
  check("worker challenge-plan 不保留 check-tools stage", stageDefinitionFor("worker", "check-tools") === null);
  check("working 只可推进 decide-tools-before-writing-plan/write-plan/memory-maintenance", JSON.stringify(workingDef?.canAdvance) === JSON.stringify(["decide-tools-before-writing-plan", "write-plan", "memory-maintenance"]));
  check("working task 含逐个 worker 委派/维护项保留/强制 memory gate", typeof workingDef?.task === "string" && workingDef.task.includes("delegate each persona=worker plan item individually via ka_sub_whale") && workingDef.task.includes("Do not delegate memory/plugin items here") && workingDef.task.includes("advance to memory-maintenance before communication") && !workingDef.task.includes("plugin-preflight"));
  check("write-plan task 含按 coherent task 拆分 planItems", typeof stageDefinitionFor(MAIN_ROLE, "write-plan")?.task === "string" && stageDefinitionFor(MAIN_ROLE, "write-plan").task.includes("One planItem per coherent task") && stageDefinitionFor(MAIN_ROLE, "write-plan").task.includes("Do not pack all work into one."));
  check("write-plan/working/memory/plugin 主阶段不再引用 pluginCreator/plugin-preflight", ["write-plan", "working", "memory-maintenance", "plugin-maintenance"].every((stage) => !stageDefinitionFor(MAIN_ROLE, stage)?.task.includes("pluginCreator") && !stageDefinitionFor(MAIN_ROLE, stage)?.task.includes("plugin-preflight")));
  check("memory-maintenance 可回 write-plan", canAdvance(MAIN_ROLE, "memory-maintenance", "write-plan") === true && canAdvance(MAIN_ROLE, "plugin-maintenance", "write-plan") === true);
  check("working 注入携带 taskPlanPath", workingText.includes("taskPlanPath: C:/plan.json"));
  check("working task 含 single subagent-settled 到达且父回复一次 send_message 语义", typeof workingDef?.task === "string" && workingDef.task.includes("single subagent-settled message") && workingDef.task.includes("reply with send_message to resume it") && workingDef.task.includes("child's full report arrives as a single"));
  check("主 working/memory-maintenance/plugin-maintenance 任务含复用口径", stageDefinitionFor(MAIN_ROLE, "working")?.task.includes("send_message to continue that child") && stageDefinitionFor(MAIN_ROLE, "working")?.task.includes("send_message") && stageDefinitionFor(MAIN_ROLE, "memory-maintenance")?.task.includes("memoryMaintainer sub-agent can be reused multiple times") && stageDefinitionFor(MAIN_ROLE, "plugin-maintenance")?.task.includes("Whether to reuse is determined by the main agent"));
}

// Task plan draft/finalized 骨架（planStore 在 plugin.apply 前预写，plugin store 可见）
{
  check("draft 拒绝委派", resolvePlanItemForDelegation(planStore, "p-draft").ok === false);
  check("finalized 可解析", resolvePlanItemForDelegation(planStore, "p1").ok === true);
  check("task plan store 接受 persona=main", planStore.get("p-main")?.persona === "main" && planStore.get("p-main")?.status === "finalized" && resolvePlanItemForDelegation(planStore, "p-main").ok === true);
  const invalid = await kaSubWhale.execute({ planItemId: "missing" }, { agent });
  check("ka_sub_whale 无效 planItemId 结构化拒绝", invalid.ok === false && invalid.code === "plan-item-not-found");
  const mainRejected = await kaSubWhale.execute({ planItemId: "p-main" }, { agent });
  check("ka_sub_whale 拒绝 persona=main 委派（结构化）", mainRejected.ok === false && mainRejected.code === "main-persona-delegation-denied");
}

// 插件级：进入 assess → 软闸门
await claimed({ agent, message: userMessage, turn: 2 });
const stageNow = JSON.parse(readFileSync(STORE_FILE, "utf8")).sessions?.["s-v09"];
check("新一轮消息进入 assess-complexity", stageNow === "assess-complexity");
{
  // live main 首轮 Minimal：agent 尚无 tool/call，pre-step 阶段注入应带 Minimal 行。
  const preStepV09 = listeners.get("agent/pre-step")?.[0];
  const assessDecision = await preStepV09(
    { agent, turn: 2, messages: [] },
    async () => ({ kind: "enter", messages: [] }),
  );
  const assessText = (assessDecision?.messages ?? [])
    .map((message) => (message?.content ?? []).map((part) => part?.text ?? "").join("\n"))
    .join("\n");
  check(
    "main 首轮（尚无工具调用）live assess 注入含 Minimal (first round only) 行",
    assessText.includes("[ka-whale-workflow assess-complexity]") &&
      assessText.includes("Minimal (first round only): [memory_search, context_search] until your first tool call; then the Allowed tools above unlock."),
  );
}
const deny = await preExecute({ name: "read", agent }, async () => ({ kind: "allow" }));
check("assess 中调用 read 返回 workflow-stage-deny", deny.kind === "deny" && String(deny.reason).startsWith("workflow-stage-deny:"));
const allowMem = await preExecute({ name: "memory_search", agent }, async () => ({ kind: "allow" }));
check("assess 中调用 memory_search 放行", allowMem.kind === "allow");
const allowCtxAssess = await preExecute({ name: "context_search", agent }, async () => ({ kind: "allow" }));
check("assess 软闸门放行 context_search/context_read，拒绝 context_compress（当前 assess 不放 compress）", allowCtxAssess?.kind === "allow" && (await preExecute({ name: "context_read", agent }, async () => ({ kind: "allow" })))?.kind === "allow" && (await preExecute({ name: "context_compress", agent }, async () => ({ kind: "allow" })))?.kind === "deny");

// whale_report mode='goal' 已移除：任何阶段都返回结构化 workflow-stage-deny。
{
  let goalError = null;
  try {
    await whaleReport.execute({ mode: "goal", objective: "x", max_goal_rounds: 3 }, { agent });
  } catch (error) {
    goalError = error;
  }
  check(
    "whale_report mode='goal' 被拒绝（workflow-stage-deny + Goal mode has been removed）",
    goalError !== null &&
      String(goalError.message).startsWith("workflow-stage-deny:") &&
      String(goalError.message).includes("Goal mode has been removed"),
  );
}

// whale_report 推进到 communication 后再闸门
const result = await whaleReport.execute({ nextStage: "communication" }, { agent });
check("whale_report assess→communication", result.ok === true && result.stage === "communication");
const denyComm = await preExecute({ name: "read", agent }, async () => ({ kind: "allow" }));
check("communication 中调用 read 返回 workflow-stage-deny", denyComm.kind === "deny" && String(denyComm.reason).startsWith("workflow-stage-deny:"));
const allowCtxComm = await preExecute({ name: "context_search", agent }, async () => ({ kind: "allow" }));
check("communication 软闸门拒绝 context_search/context_read/context_compress（communication 只放 report 工具）", allowCtxComm?.kind === "deny" && (await preExecute({ name: "context_read", agent }, async () => ({ kind: "allow" })))?.kind === "deny" && (await preExecute({ name: "context_compress", agent }, async () => ({ kind: "allow" })))?.kind === "deny");

// 36.5 用户插话/新轮路由：终态 communication 重置；活动阶段保留。
await claimed({ agent, message: userMessage, turn: 2 });
check("36.5 communication 收到新一轮真实用户消息进入 assess-complexity", JSON.parse(readFileSync(STORE_FILE, "utf8")).sessions?.["s-v09"] === "assess-complexity");

// 37.5 runtime: reach working through decide-tools-before-writing-plan → write-plan.
await whaleReport.execute({ nextStage: "challenge-plan" }, { agent });
await whaleReport.execute({ nextStage: "decide-tools-before-writing-plan" }, { agent });
let draftPayloadError = null;
try {
  await whaleReport.execute(
    { draftPlanItems: [{ planItemId: "p-draft-runtime", persona: "worker", task: "Draft should be rejected", assignedTools: [] }] },
    { agent },
  );
} catch (error) {
  draftPayloadError = error;
}
check("decide-tools-before-writing-plan 拒绝 draftPlanItems（只能在 write-plan 写入 task plan）", draftPayloadError !== null && String(draftPayloadError.message).includes("write-plan"));
let badPayloadError = null;
try {
  await whaleReport.execute(
    { finalPlanPayload: { status: "finalized", items: [{ planItemId: "p1", persona: "worker", task: "Do task", assignedTools: [] }] } },
    { agent },
  );
} catch (error) {
  badPayloadError = error;
}
check("decide-tools-before-writing-plan 拒绝 finalPlanPayload（只能在 write-plan）", badPayloadError !== null && String(badPayloadError.message).includes("write-plan"));
const defaultToWritePlan = await whaleReport.execute({}, { agent });
check("whale_report 从 decide-tools-before-writing-plan 默认推进到 write-plan", defaultToWritePlan.ok === true && defaultToWritePlan.stage === "write-plan");
await whaleReport.execute(
  {
    finalPlanPayload: {
      status: "finalized",
      items: [
        { planItemId: "p1", persona: "worker", task: "Do task", assignedTools: [] },
        { planItemId: "p-main", persona: "main", task: "Main line task", assignedTools: [] },
        { planItemId: "p-memory", persona: "memoryMaintainer", task: "Write memory", assignedTools: [] },
        { planItemId: "p-maintainer", persona: "pluginMaintainer", task: "Maintain plugin", assignedTools: [] },
      ],
    },
    nextStage: "working",
  },
  { agent },
);

// 36.8 stage-persona mapping runtime: the runtime is already in working; verify
// each stage only delegates its mapped persona.
const memoryInWorking = await kaSubWhale.execute({ planItemId: "p-memory" }, { agent });
check("working 拒绝 memoryMaintainer 委派（stage-persona-mismatch）", memoryInWorking.ok === false && memoryInWorking.code === "stage-persona-mismatch");
const creatorMissing = await kaSubWhale.execute({ planItemId: "p-creator" }, { agent });
check("working 无 pluginCreator plan item 可委派（plan-item-not-found）", creatorMissing.ok === false && creatorMissing.code === "plan-item-not-found");
const workerInWorking = await kaSubWhale.execute({ planItemId: "p1" }, { agent });
check("working 允许 worker 委派", workerInWorking.ok === true && workerInWorking.code === "subagent-created");
const workingDefault = await whaleReport.execute({}, { agent });
check("whale_report 从 working 默认推进到 memory-maintenance", workingDefault.ok === true && workingDefault.stage === "memory-maintenance");
const workerInMemory = await kaSubWhale.execute({ planItemId: "p1" }, { agent });
check("memory-maintenance 拒绝 worker 委派（stage-persona-mismatch）", workerInMemory.ok === false && workerInMemory.code === "stage-persona-mismatch");
const memoryInMemory = await kaSubWhale.execute({ planItemId: "p-memory" }, { agent });
check(
  "memory-maintenance 允许 memoryMaintainer 委派（无同 surface 候选时先 spawn）",
  memoryInMemory.ok === true && memoryInMemory.code === "subagent-created",
);
{
  // 让刚 spawn 的 child 真正到达 communication 终态（等同该子代理已完成第一轮并报告）。
  const firstMemoryChildId = memoryInMemory.subagentId;
  const childAgent = {
    id: firstMemoryChildId,
    session: { id: firstMemoryChildId, events: [] },
    options: { subagentDepth: 1 },
  };
  // 新受控子代理先完成首次工具调用（真实路径：session/event 置 minimalDone 并进入 assess-delegation）。
  childAgent.session.events.push({ type: "tool/call", data: { name: "memory_search" } });
  agentRegistry.set(firstMemoryChildId, childAgent);
  const sessionEventV09 = listeners.get("session/event")?.[0];
  if (typeof sessionEventV09 === "function") {
    await sessionEventV09({ id: firstMemoryChildId }, { type: "tool/call", data: { name: "memory_search" } });
  }
  const memoryReport = registeredTools.get(MEMORY_SUB_WHALE_REPORT_TOOL);
  const reportResult = await memoryReport.execute(
    { nextStage: "communication" },
    { agent: childAgent, signal: new AbortController().signal },
  );
  check("新 spawn memoryMaintainer child 报告到 communication 终态", reportResult?.stage === "communication" && reportResult?.advanced === true);
  const startsBeforeReuse = startedSubagentRequests.length;
  const followsBeforeReuse = capturedFollowups.length;
  const secondMemory = await kaSubWhale.execute({ planItemId: "p-memory-2" }, { agent });
  const secondContentText = (capturedFollowups.at(-1)?.content ?? [])
    .map((part) => part?.text ?? "")
    .join("\n");
  check(
    "memoryMaintainer 同 surface 第二项复用同一 terminal communication child（followup 投递 planItemId+task）",
    secondMemory.ok === true &&
      secondMemory.code === "subagent-reused" &&
      secondMemory.reused === true &&
      secondMemory.childId === firstMemoryChildId &&
      startedSubagentRequests.length === startsBeforeReuse &&
      capturedFollowups.length === followsBeforeReuse + 1 &&
      secondContentText.includes("planItemId: p-memory-2") &&
      secondContentText.includes("Write memory two"),
  );
}
await whaleReport.execute({ nextStage: "plugin-maintenance" }, { agent });
const memoryInPlugin = await kaSubWhale.execute({ planItemId: "p-memory" }, { agent });
check("plugin-maintenance 拒绝 memoryMaintainer 委派（stage-persona-mismatch）", memoryInPlugin.ok === false && memoryInPlugin.code === "stage-persona-mismatch");
const maintainerInPlugin = await kaSubWhale.execute({ planItemId: "p-maintainer" }, { agent });
check("plugin-maintenance 允许 pluginMaintainer 委派", maintainerInPlugin.ok === true && maintainerInPlugin.code === "subagent-created");

{
  const requestPersonas = startedSubagentRequests
    .filter((request) => request !== null && typeof request === "object" && typeof request.persona === "string")
    .map((request) => request.persona);
  const expectedPersonas = ["worker", "memoryMaintainer", "pluginMaintainer"]
    .map((role) => KAZ_ROLE_PROMPTS.subagent[role]);
  check(
    "受控子代理 startContinuable request.persona 逐字等于 KAZ_ROLE_PROMPTS.subagent.<role>",
    JSON.stringify(requestPersonas) === JSON.stringify(expectedPersonas),
  );
}

check("v0.9 工具已注册", registeredTools.has("whale_report") && registeredTools.has(KA_SUB_WHALE_TOOL) && registeredTools.has(WORK_SUB_WHALE_REPORT_TOOL));
check("36.6 ka_sub_whale description 含异步等待提示", typeof kaSubWhale?.description === "string" && kaSubWhale.description.includes("end the current turn and await its report/finished message") && kaSubWhale.description.includes("do not use pwsh sleep or poll list_agents"));
check("36.6 ka_sub_whale 成功输出含 notice", workerInWorking?.ok === true && typeof workerInWorking?.notice === "string" && workerInWorking.notice.includes("End the current turn and await its report/finished message") && workerInWorking.notice.includes("not wait primitives"));

// 37.5 subagent-report routing: parent agent receives subagent report/settled
// messages, and ka-whale-workflow reports one-line summaries to round-display
// under BOTH the parent/main agent and the child subagent session.
{
  const preStep = listeners.get("agent/pre-step")?.[0];
  const parent = { id: "s-parent-375", session: { id: "s-parent-375", events: [] } };
  const child = {
    id: "child-v09-375",
    options: { subagentDepth: 1 },
    session: {
      id: "child-v09-375",
      events: [{ type: "turn/start", data: { turn: 1 } }],
      header: { origin: "subagent", parentSession: parent.id },
    },
  };
  agentRegistry.set(child.id, child);
  const reportMessage = {
    role: "user",
    content: [{ type: "text", text: "parent report\nsecond line" }],
    source: { kind: "subagent-report", form: "relay", senderSessionId: child.id },
  };
  const settledMessage = {
    role: "user",
    content: [],
    source: {
      kind: "subagent-settled",
      form: "notice",
      summary: "settled summary here",
      senderSessionId: child.id,
    },
  };
  const before = rdReports.length;
  const preDecision = { kind: "enter", messages: [reportMessage, settledMessage] };
  await preStep({ agent: parent, turn: 1 }, async () => preDecision);
  const reports = rdReports.slice(before).filter(
    (payload) =>
      payload?.category === "subagent-report" && payload?.plugin === "ka-whale-workflow",
  );
  const parentReports = reports.filter((payload) => payload?.agent?.id === parent.id);
  const childReports = reports.filter((payload) => payload?.agent?.id === child.id);
  check(
    "37.5 父代理 pre-step 收到 subagent-report/settled 同时写主会话与 child 会话 round-display 记录",
    parentReports.length === 2 &&
      parentReports.some((payload) => payload.content === "parent report second line") &&
      parentReports.some((payload) => payload.content === "settled summary here") &&
      childReports.length === 2 &&
      childReports.some((payload) => payload.content === "parent report second line") &&
      childReports.some((payload) => payload.content === "settled summary here"),
  );
  check(
    "37.5 main-flow 不再作为一次性 user message 注入",
    reports.length === 4 && !reports.some((payload) => payload.title === "主流程"),
  );
}

// 子代理 report 硬等门纯常量/消息判定（完整行为覆盖在 probe-subagent-workflow.mjs）。
{
  check("report 硬等门常量/拒绝 code 导出", SUB_WHALE_REPORT_WAIT_NOTICE.includes("Stage advanced; now output your full report as your final message") && SUB_WHALE_REPORT_WAIT_NOTICE.includes("parent receives it as subagent-settled") && SUB_WHALE_REPORT_WAIT_NOTICE.includes("do not call further tools") && SUB_WHALE_REPORT_WAIT_DENY_CODE === "subagent-report-wait-deny");
  check("父主 send_message（coordinator/relay）判定可用", isParentMainSendMessage({ content: [], source: { kind: "coordinator", form: "relay", senderSessionId: "parent" } }) === true && isParentMainSendMessage({ content: [], source: { kind: "coordinator", form: "notice" } }) === false);
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nV09 WORKFLOW PROBE OK" : `\nV09 WORKFLOW PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
