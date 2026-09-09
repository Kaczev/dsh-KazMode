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
  isFinalReportStage,
  terminalStageIdsForRole,
} from "./lib/stage-defs.js";
import { createTaskPlanStore, resolvePlanItemForDelegation, PLAN_PERSONAS } from "./lib/task-plan-store.js";
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
// 被复用），真正可复用 child 由 runtime 第一次 spawn 后推进到 merged 终态再验证。
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
check("worker/memory/plugin stage ids 无 compress_context_then_communication（含旧 compass/communication 也不存在）", WORKER_STAGE_IDS.includes("working-then-compress-context-then-report") && MEMORY_MAINTAINER_STAGE_IDS.includes("save-update-then-compress-context-then-report") && MEMORY_MAINTAINER_STAGE_IDS.includes("delete-memory-then-compress-context-then-report") && PLUGIN_MAINTAINER_STAGE_IDS.includes("create-plugin-then-compress-context-then-report") && PLUGIN_MAINTAINER_STAGE_IDS.includes("update-plugin-then-compress-context-then-report") && PLUGIN_MAINTAINER_STAGE_IDS.includes("retire-plugin-then-compress-context-then-report") && [WORKER_STAGE_IDS, MEMORY_MAINTAINER_STAGE_IDS, PLUGIN_MAINTAINER_STAGE_IDS].every((ids) => !ids.includes("compress_context_then_communication") && !ids.includes("communication") && !ids.includes("compass_context_before_communication")));
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
    worker: "challenge-plan",
    memoryMaintainer: "plan-memory",
    pluginMaintainer: "plan-plugin",
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
            def.allowedTools.includes(roleReportTools[role]) &&
            def.terminal === true;
        }),
      ),
  );
  check(
    "初始 stage（main assess / role planning stages）含 memory/context/report，不含 context_compress（Minimal 不再由 stage 收口）",
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
    "初始 planning stage 不放写/执行工具（write/edit/pwsh），文件写工具仍留到 working/plugin 执行阶段",
    ["worker", "memoryMaintainer", "pluginMaintainer"].every((role) => {
      const allowed = stageDefinitionFor(role, initialStages[role])?.allowedTools ?? [];
      return !allowed.includes("write") && !allowed.includes("edit") && !allowed.includes("pwsh");
    }),
  );
  check(
    "最后执行阶段 terminal:true（terminal full report 由 final:true 表达，不再有单独 stage）",
    Object.entries(finalStages).every(([role, stages]) =>
      stages.every((stage) => stageDefinitionFor(role, stage)?.terminal === true),
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
  check(
    "受控子代理不再有 compress_context_then_communication / subagent communication / compass 定义",
    ["worker", "memoryMaintainer", "pluginMaintainer"].every((role) =>
      stageDefinitionFor(role, "compress_context_then_communication") === null &&
      stageDefinitionFor(role, "communication") === null &&
      stageDefinitionFor(role, "compass_context_before_communication") === null,
    ),
  );
}
check("37.5 新图：decide-tools-before-writing-plan 只到 write-plan，write-plan 可到 working/maintenance/communication", JSON.stringify(stageDefinitionFor(MAIN_ROLE, "decide-tools-before-writing-plan")?.canAdvance) === JSON.stringify(["write-plan"]) && ["working", "memory-maintenance", "plugin-maintenance", "compass_context_before_communication", "communication"].every((stage) => canAdvance(MAIN_ROLE, "write-plan", stage)));
check("37.5 plugin-preflight 无主 stage 定义/无 taskPlanPath 注入", stageDefinitionFor(MAIN_ROLE, "plugin-preflight") === null && !stageInjectionText(MAIN_ROLE, "write-plan").includes("plugin-preflight"));
check("decide-goal 已移除：无主 stage 定义、write-plan 不可推进、注入为空", stageDefinitionFor(MAIN_ROLE, "decide-goal") === null && canAdvance(MAIN_ROLE, "write-plan", "decide-goal") === false && stageInjectionText(MAIN_ROLE, "decide-goal") === "");
check("goal-active/working-resumed 特殊文本导出已不存在", !Object.keys(await import("./lib/stage-defs.js")).some((key) => key === "GOAL_ACTIVE_CONTEXT_TEXT" || key === "workingResumedContextText" || key === "GOAL_ACTIVE_STAGE" || key === "WORKING_RESUMED_STAGE"));
check("write-plan 注入格式含 taskPlanPath", stageInjectionText(MAIN_ROLE, "write-plan", { taskPlanPath: "C:/plan.json" }).includes("taskPlanPath: C:/plan.json"));
check("create-plugin-then-compress-context-then-report 注入格式含 lifecyclePath", stageInjectionText("pluginMaintainer", "create-plugin-then-compress-context-then-report", { lifecyclePath: "C:/lifecycle.md" }).includes("lifecyclePath: C:/lifecycle.md"));
check("Context 注记：STAGE_CONTEXT_NOTES 冻结且覆盖目标角色/stage", STAGE_CONTEXT_NOTES !== undefined && Object.isFrozen(STAGE_CONTEXT_NOTES) && ["main", "worker", "memoryMaintainer", "pluginMaintainer"].every((role) => Object.isFrozen(STAGE_CONTEXT_NOTES[role])));
check("Context 注记：有注记 stage 在 Task 后输出，无注记 stage 不输出", stageInjectionText("main", "assess-complexity").includes("\nContext: ") && stageInjectionText("main", "challenge-plan").includes("\nContext: ") && stageInjectionText("worker", "challenge-plan").includes("\nContext: ") && stageInjectionText("main", "communication").includes("\nContext: ") && stageInjectionText("worker", "working-then-compress-context-then-report").includes("\nContext: ") && stageInjectionText("memoryMaintainer", "save-update-then-compress-context-then-report").includes("\nContext: ") && stageInjectionText("memoryMaintainer", "delete-memory-then-compress-context-then-report").includes("\nContext: ") && stageInjectionText("pluginMaintainer", "create-plugin-then-compress-context-then-report").includes("\nContext: ") && stageInjectionText("pluginMaintainer", "update-plugin-then-compress-context-then-report").includes("\nContext: ") && stageInjectionText("pluginMaintainer", "retire-plugin-then-compress-context-then-report").includes("\nContext: ") && !stageInjectionText(MAIN_ROLE, "working").includes("Context:"));
check("Minimal 提示由 stageInjectionText 可选 minimalTools 参数承载：有值输出、缺省不输出", stageInjectionText("main", "assess-complexity", { minimalTools: ["memory_search", "context_search"] }).includes("Minimal (first round only): [memory_search, context_search] until your first tool call; then the Allowed tools above unlock.") && !stageInjectionText("main", "assess-complexity").includes("Minimal (first round only):"));
check("advance 校验：assess→working default false + S true", canAdvance(MAIN_ROLE, "assess-complexity", "working") === false && canAdvance(MAIN_ROLE, "assess-complexity", "working", { tier: "S" }) === true && canAdvance(MAIN_ROLE, "assess-complexity", "working", { tier: "M" }) === false);
check("S gated：working→communication default false + S true；S 不能走 M-only working→write-plan", canAdvance(MAIN_ROLE, "working", "communication") === false && canAdvance(MAIN_ROLE, "working", "communication", { tier: "S" }) === true && canAdvance(MAIN_ROLE, "working", "write-plan", { tier: "S" }) === false);
{
  const challengeDef = stageDefinitionFor(MAIN_ROLE, "challenge-plan");
  const workerChallengeDef = stageDefinitionFor("worker", "challenge-plan");
  const workingText = stageInjectionText(MAIN_ROLE, "working", { taskPlanPath: "C:/plan.json" });
  const workingDef = stageDefinitionFor(MAIN_ROLE, "working");
  check("challenge-plan 不持有 ka_sub_whale 且任务禁止写 plan/调用子代理", !challengeDef?.allowedTools.includes("ka_sub_whale") && typeof challengeDef?.task === "string" && challengeDef.task.includes("Do not write task plans here") && challengeDef.task.includes("do not call ka_sub_whale"));
  check("主 challenge-plan task 含批评纪律", typeof challengeDef?.task === "string" && challengeDef.task.includes("Critique the approach first") && challengeDef.task.includes("identify real weaknesses") && challengeDef.task.includes("do not manufacture criticism"));
  check("worker challenge-plan task 含批评纪律", typeof workerChallengeDef?.task === "string" && workerChallengeDef.task.includes("Critique the assigned task first") && workerChallengeDef.task.includes("do not manufacture criticism"));
  check("worker challenge-plan 只可推进 working-then-compress-context-then-report", JSON.stringify(workerChallengeDef?.canAdvance) === JSON.stringify(["working-then-compress-context-then-report"]));
  check("worker challenge-plan 不保留 check-tools stage", stageDefinitionFor("worker", "check-tools") === null);
  check("working 只可推进 decide-tools-before-writing-plan/write-plan/memory-maintenance", JSON.stringify(workingDef?.canAdvance) === JSON.stringify(["decide-tools-before-writing-plan", "write-plan", "memory-maintenance"]));
  check("working task 含逐个 worker 委派/维护项保留/memory gate", typeof workingDef?.task === "string" && workingDef.task.includes("Delegate each persona=worker plan item individually via ka_sub_whale") && workingDef.task.includes("do not delegate memory/plugin items here") && workingDef.task.includes("advance to memory-maintenance before communication") && !workingDef.task.includes("plugin-preflight"));
  check("write-plan task 含按 coherent task 拆分 planItems", typeof stageDefinitionFor(MAIN_ROLE, "write-plan")?.task === "string" && stageDefinitionFor(MAIN_ROLE, "write-plan").task.includes("One planItem per coherent task") && stageDefinitionFor(MAIN_ROLE, "write-plan").task.includes("do not pack all work into one."));
  check("write-plan task 描述固定 persona 枚举 + 可选结构化字段 + 整包拒绝语义", (() => { const text = stageDefinitionFor(MAIN_ROLE, "write-plan")?.task ?? ""; return text.includes("main, worker, memoryMaintainer, pluginMaintainer") && text.includes("summary (one-line purpose)") && text.includes("dependsOn (planItemIds this item depends on)") && text.includes("targets (files/dirs/domains)") && text.includes("verification (concrete checks)") && text.includes("structured plan-item-invalid error") && text.includes("nothing is persisted") && text.includes("no item is silently dropped"); })());
  check("write-plan/working/memory/plugin 主阶段不再引用 pluginCreator/plugin-preflight", ["write-plan", "working", "memory-maintenance", "plugin-maintenance"].every((stage) => !stageDefinitionFor(MAIN_ROLE, stage)?.task.includes("pluginCreator") && !stageDefinitionFor(MAIN_ROLE, stage)?.task.includes("plugin-preflight")));
  check("memory-maintenance 可回 write-plan", canAdvance(MAIN_ROLE, "memory-maintenance", "write-plan") === true && canAdvance(MAIN_ROLE, "plugin-maintenance", "write-plan") === true);
  check("working 注入携带 taskPlanPath", workingText.includes("taskPlanPath: C:/plan.json"));
  check("working task 含 mid-work pause → final:true TERMINAL full report 语义", typeof workingDef?.task === "string" && workingDef.task.includes("pause mid-work") && workingDef.task.includes("final: true") && workingDef.task.includes("single subagent-settled message") && workingDef.task.includes("reply with send_message to resume it") && workingDef.task.includes("TERMINAL full report"));
  check("主 working/memory-maintenance/plugin-maintenance 任务含复用口径与 final:true 预期", stageDefinitionFor(MAIN_ROLE, "working")?.task.includes("send_message to continue that child") && stageDefinitionFor(MAIN_ROLE, "working")?.task.includes("send_message") && stageDefinitionFor(MAIN_ROLE, "memory-maintenance")?.task.includes("memoryMaintainer sub-agent can be reused multiple times") && stageDefinitionFor(MAIN_ROLE, "plugin-maintenance")?.task.includes("Whether to reuse is determined by the main agent") && stageDefinitionFor(MAIN_ROLE, "memory-maintenance")?.task.includes('memory_sub_whale_report({ final: true })') && stageDefinitionFor(MAIN_ROLE, "plugin-maintenance")?.task.includes('plugin_maintainer_sub_whale_report({ final: true })'));
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
const allowRead = await preExecute({ name: "read", agent }, async () => ({ kind: "allow" }));
const allowGlob = await preExecute({ name: "glob", agent }, async () => ({ kind: "allow" }));
const allowGrep = await preExecute({ name: "grep", agent }, async () => ({ kind: "allow" }));
const allowPwsh = await preExecute({ name: "pwsh", agent }, async () => ({ kind: "allow" }));
check("assess 软闸门放行 read/glob/grep/pwsh（只读侦查工具）", allowRead?.kind === "allow" && allowGlob?.kind === "allow" && allowGrep?.kind === "allow" && allowPwsh?.kind === "allow");
const denyEdit = await preExecute({ name: "edit", agent }, async () => ({ kind: "allow" }));
const denyWrite = await preExecute({ name: "write", agent }, async () => ({ kind: "allow" }));
check("assess 中调用 edit/write 仍返回 workflow-stage-deny", denyEdit.kind === "deny" && String(denyEdit.reason).startsWith("workflow-stage-deny:") && denyWrite.kind === "deny" && String(denyWrite.reason).startsWith("workflow-stage-deny:"));
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
{
  const planFileBeforeReject = readFileSync(PLAN_FILE, "utf8");
  let invalidFinalError = null;
  try {
    await whaleReport.execute(
      {
        finalPlanPayload: {
          status: "finalized",
          items: [{ planItemId: "bad-runtime", persona: "coder", task: "Invalid persona" }],
        },
      },
      { agent },
    );
  } catch (error) {
    invalidFinalError = error;
  }
  const stageAfterReject = JSON.parse(readFileSync(STORE_FILE, "utf8")).sessions?.["s-v09"];
  const allowedText = `allowedPersonas=[${PLAN_PERSONAS.join(", ")}]`;
  check(
    "write-plan whale_report rejects invalid free-text persona with structured plan-item-invalid error, persists nothing, and does not advance stage",
    invalidFinalError !== null &&
      invalidFinalError.code === "plan-item-invalid" &&
      String(invalidFinalError.message).includes("plan-item-invalid") &&
      String(invalidFinalError.message).includes("invalid-persona") &&
      String(invalidFinalError.message).includes("bad-runtime") &&
      String(invalidFinalError.message).includes(allowedText) &&
      stageAfterReject === "write-plan" &&
      readFileSync(PLAN_FILE, "utf8") === planFileBeforeReject,
  );
}
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
  // 让刚 spawn 的 child 走 v0.10a 尾部：plan-memory → save-update-then-compress-context-then-report(nextStage) →
  // 在该执行阶段内 final:true terminal full report（stage 不变，terminalFinal=true）。
  const firstMemoryChildId = memoryInMemory.subagentId;
  const childAgent = {
    id: firstMemoryChildId,
    session: { id: firstMemoryChildId, events: [] },
    options: { subagentDepth: 1 },
  };
  childAgent.session.events.push({ type: "tool/call", data: { name: "memory_search" } });
  agentRegistry.set(firstMemoryChildId, childAgent);
  const sessionEventV09 = listeners.get("session/event")?.[0];
  if (typeof sessionEventV09 === "function") {
    await sessionEventV09({ id: firstMemoryChildId }, { type: "tool/call", data: { name: "memory_search" } });
  }
  const memoryReport = registeredTools.get(MEMORY_SUB_WHALE_REPORT_TOOL);
  const planToActionResult = await memoryReport.execute(
    { nextStage: "save-update-then-compress-context-then-report" },
    { agent: childAgent, signal: new AbortController().signal },
  );
  const terminalResult = await memoryReport.execute(
    { final: true },
    { agent: childAgent, signal: new AbortController().signal },
  );
  const storedTerminal = JSON.parse(readFileSync(STORE_FILE, "utf8")).subagentRoles?.[firstMemoryChildId];
  check(
    "新 spawn memoryMaintainer child 经 plan-memory→save-update-then-compress-context-then-report 后 final:true 保持该执行阶段并置 terminalFinal",
    planToActionResult?.stage === "save-update-then-compress-context-then-report" &&
      planToActionResult?.advanced === true &&
      terminalResult?.final === true &&
      terminalResult?.terminalFinal === true &&
      terminalResult?.stage === "save-update-then-compress-context-then-report" &&
      storedTerminal?.terminalFinal === true &&
      storedTerminal?.awaitingParent === true,
  );
  const startsBeforeReuse = startedSubagentRequests.length;
  const followsBeforeReuse = capturedFollowups.length;
  const secondMemory = await kaSubWhale.execute({ planItemId: "p-memory-2" }, { agent });
  const secondContentText = (capturedFollowups.at(-1)?.content ?? [])
    .map((part) => part?.text ?? "")
    .join("\n");
  check(
    "memoryMaintainer 同 surface 第二项复用同一 terminalFinal save-update-then-compress-context-then-report child（followup 投递 planItemId+task）",
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
check("whale_report params keep machine contract: plans only in write-plan, persona enum, plan-item-invalid", (() => { const text = JSON.stringify(whaleReport?.parameters ?? {}); return whaleReport !== undefined && text.includes("write-plan") && text.includes("main/worker/memoryMaintainer/pluginMaintainer") && text.includes("plan-item-invalid"); })());
check("36.6 ka_sub_whale description 含异步等待提示", typeof kaSubWhale?.description === "string" && kaSubWhale.description.includes("end the current turn and await its report/finished message") && kaSubWhale.description.includes("do not poll/sleep"));
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
