// ka-whale-workflow 探针：验证阶段折叠 / 阶段转移 / 工具清单常量。
// 运行：node KazPlugins/ka-whale-workflow/probe-ka-whale-workflow.mjs
import plugin, {
  DEFAULT_RECONSTRUCTION_TOOLS,
  CLASSIFICATION_LAUNCH_TOOLS,
  WHALE_REPORT_TOOL,
  stageOf,
  setStage,
  isUserMessage,
} from "./lib/index.js";

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

const events = [];
const session = {
  events,
  append(type, data) {
    events.push({ type, data });
  },
};
const agent = { session };

check("插件默认导出存在", plugin !== null && typeof plugin === "object" && plugin.name === "ka-whale-workflow");
check("重构八工具默认清单", JSON.stringify(DEFAULT_RECONSTRUCTION_TOOLS) === JSON.stringify(["ask_user_question", "read", "glob", "grep", "web_search", "memory_search", "memory_list", "memory_detail"]));
check("分类启动工具清单", JSON.stringify(CLASSIFICATION_LAUNCH_TOOLS) === JSON.stringify(["create_goal", "create_plan"]));
check("whale_report 工具名", WHALE_REPORT_TOOL === "whale_report");

check("初始阶段 idle", stageOf(agent) === "idle");
check("setStage 进入重构", setStage(agent, "reconstruction") === true && stageOf(agent) === "reconstruction");
check("setStage 重复同阶段不追加", setStage(agent, "reconstruction") === false && events.length === 1);
check("setStage 进入分类", setStage(agent, "classification") === true && stageOf(agent) === "classification");
check("setStage 进入 done", setStage(agent, "done") === true && stageOf(agent) === "done");
check("setStage done 后不回到旧阶段", events.filter((e) => e.type === "ka-whale-workflow/stage").length === 3);

check("真实用户消息判定", isUserMessage({ content: [], source: { kind: "user" } }) === true && isUserMessage({ content: [] }) === true);
check("插件消息判定为假", isUserMessage({ content: [], source: { kind: "plugin", plugin: "ka-whale-workflow", form: "reconstruction" } }) === false);
check("goal/tool 消息判定为假", isUserMessage({ content: [], source: { kind: "goal" } }) === false && isUserMessage({ content: [], source: { kind: "tool" } }) === false);

console.log(failures === 0 ? "\nKA-WHALE-WORKFLOW PROBE OK" : `\nKA-WHALE-WORKFLOW PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
