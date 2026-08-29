// ka-whale-workflow 探针：验证阶段折叠 / 阶段转移 / 工具清单常量 / 不再写会话事件。
// 运行：node KazPlugins/ka-whale-workflow/probe-ka-whale-workflow.mjs
import plugin, {
  DEFAULT_RECONSTRUCTION_TOOLS,
  WHALE_REPORT_TOOL,
  stageOf,
  setStage,
  createStageStore,
  isUserMessage,
  manualCommandIdOf,
  nextStageOnUserMessage,
  hasInjectedInTurn,
} from "./lib/index.js";
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
check("重构八工具默认清单", JSON.stringify(DEFAULT_RECONSTRUCTION_TOOLS) === JSON.stringify(["ask_user_question", "read", "glob", "grep", "web_search", "memory_search", "memory_list", "memory_detail"]));
check("whale_report 工具名", WHALE_REPORT_TOOL === "whale_report");

check("初始阶段 idle", stageOf(agent, store) === "idle");
check("n+1 轮在重构/分类 → 回重构", nextStageOnUserMessage("reconstruction", 2) === "reconstruction" && nextStageOnUserMessage("classification", 3) === "reconstruction");
check("n+1 轮在 done/assessment → 评估", nextStageOnUserMessage("done", 2) === "assessment" && nextStageOnUserMessage("assessment", 4) === "assessment");
check("首轮 → 重构", nextStageOnUserMessage("idle", 1) === "reconstruction");
check("setStage 进入重构", setStage(agent, "reconstruction", store) === true && stageOf(agent, store) === "reconstruction");
check("setStage 重复同阶段不追加", setStage(agent, "reconstruction", store) === false);
check("setStage 进入分类", setStage(agent, "classification", store) === true && stageOf(agent, store) === "classification");
check("setStage 进入 done", setStage(agent, "done", store) === true && stageOf(agent, store) === "done");
check("setStage 进入信息评估", setStage(agent, "assessment", store) === true && stageOf(agent, store) === "assessment");
check("评估 restart:false 回 done", setStage(agent, "done", store) === true && stageOf(agent, store) === "done");
check(
  "done→评估→重构→分类→done（restart:true 链路）",
  setStage(agent, "assessment", store) === true &&
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
  // /plan 命令：最后一个 turn/end 之后有 command/run + 成功 command/done。
  const cmdEvents = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "step/start", data: { turn: 1, step: 1 } },
    { type: "step/end", data: { turn: 1, step: 1 } },
    { type: "turn/end", data: { turn: 1 } },
    { type: "command/run", data: { name: "plan", args: "设计一个方案", commandId: "cmd-1" } },
    { type: "command/done", data: { commandId: "cmd-1", kind: "success" } },
  ];
  const cmdAgent = { id: "s-cmd", session: { id: "s-cmd", events: cmdEvents } };
  const hit = manualCommandIdOf(cmdAgent);
  check("manualCommandIdOf 命中 /plan", hit !== null && hit.name === "plan" && hit.commandId === "cmd-1");
}

{
  // /plan off 不旁路。
  const offEvents = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "step/start", data: { turn: 1, step: 1 } },
    { type: "step/end", data: { turn: 1, step: 1 } },
    { type: "turn/end", data: { turn: 1 } },
    { type: "command/run", data: { name: "plan", args: "off", commandId: "cmd-off" } },
    { type: "command/done", data: { commandId: "cmd-off", kind: "success" } },
  ];
  const offAgent = { id: "s-off", session: { id: "s-off", events: offEvents } };
  check("manualCommandIdOf 忽略 /plan off", manualCommandIdOf(offAgent) === null);
}

{
  // 没有命令事件 → null。
  const plainAgent = { id: "s-plain", session: { id: "s-plain", events: [{ type: "turn/start", data: { turn: 1 } }] } };
  check("manualCommandIdOf 无命令为 null", manualCommandIdOf(plainAgent) === null);
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nKA-WHALE-WORKFLOW PROBE OK" : `\nKA-WHALE-WORKFLOW PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
