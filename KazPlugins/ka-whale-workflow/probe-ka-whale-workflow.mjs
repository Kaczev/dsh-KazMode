// ka-whale-workflow 探针：验证阶段折叠 / 阶段转移 / 工具清单常量 / 不再写会话事件。
// 运行：node KazPlugins/ka-whale-workflow/probe-ka-whale-workflow.mjs
import plugin, {
  DEFAULT_RECONSTRUCTION_TOOLS,
  CLASSIFICATION_LAUNCH_TOOLS,
  WHALE_REPORT_TOOL,
  stageOf,
  setStage,
  createStageStore,
  isUserMessage,
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
check("分类启动工具清单", JSON.stringify(CLASSIFICATION_LAUNCH_TOOLS) === JSON.stringify(["create_goal", "create_plan"]));
check("whale_report 工具名", WHALE_REPORT_TOOL === "whale_report");

check("初始阶段 idle", stageOf(agent, store) === "idle");
check("setStage 进入重构", setStage(agent, "reconstruction", store) === true && stageOf(agent, store) === "reconstruction");
check("setStage 重复同阶段不追加", setStage(agent, "reconstruction", store) === false);
check("setStage 进入分类", setStage(agent, "classification", store) === true && stageOf(agent, store) === "classification");
check("setStage 进入 done", setStage(agent, "done", store) === true && stageOf(agent, store) === "done");
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

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nKA-WHALE-WORKFLOW PROBE OK" : `\nKA-WHALE-WORKFLOW PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
