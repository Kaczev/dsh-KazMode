// kaz-shared 探针：验证二阶段 skill-guidance（常量/文本/闭环可用性）及 tool-lists 主入口 re-export。
// 运行：node KazPlugins/kaz-shared/probe-skill-guidance.mjs
import {
  SKILL_PRIVATE_DIR_NAME,
  SKILL_PROCESS_DIR_NAME,
  SKILL_BOUNDARY_MAX_CHANGES,
  SKILL_EVIDENCE_MIN,
  SKILL_LIFECYCLE_TOOLS,
  skillReviewGuidanceText,
  skillLifecycleCallable,
  toolCallable,
} from "./lib/tool-lists.js";

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

check("常量 SKILL_BOUNDARY_MAX_CHANGES = 1", SKILL_BOUNDARY_MAX_CHANGES === 1);
check("常量 SKILL_EVIDENCE_MIN = 2", SKILL_EVIDENCE_MIN === 2);
check("常量 SKILL_PRIVATE_DIR_NAME = KazPrivatePlugins", SKILL_PRIVATE_DIR_NAME === "KazPrivatePlugins");
check("常量 SKILL_PROCESS_DIR_NAME = process", SKILL_PROCESS_DIR_NAME === "process");
check(
  "SKILL_LIFECYCLE_TOOLS 覆盖 write/edit/pwsh/safe_json_write",
  Array.isArray(SKILL_LIFECYCLE_TOOLS) &&
    SKILL_LIFECYCLE_TOOLS.includes("write") &&
    SKILL_LIFECYCLE_TOOLS.includes("edit") &&
    SKILL_LIFECYCLE_TOOLS.includes("pwsh") &&
    SKILL_LIFECYCLE_TOOLS.includes("safe_json_write") &&
    SKILL_LIFECYCLE_TOOLS.length === 4,
);

const normalText = skillReviewGuidanceText();
const planText = skillReviewGuidanceText("plan");
const goalText = skillReviewGuidanceText("goal");
const summaryText = skillReviewGuidanceText("normal", "", "", "Lifecycle summary: auto-retired: 1; retire-pending: 2; update-needed: 1.");
const summaryEmptyText = skillReviewGuidanceText("normal", "", "", "");
check("normal 文本含 [skill Review] 与完成语义", normalText.includes("[skill Review]") && normalText.includes("The task has completed."));
check("plan 文本语义", planText.includes("[skill Review]") && planText.includes("The Plan has ended."));
check("goal 文本语义", goalText.includes("[skill Review]") && goalText.includes("The Goal has ended."));
check("summary 参数注入生命周期摘要", summaryText.includes("Lifecycle summary: auto-retired: 1; retire-pending: 2; update-needed: 1."));
check("summary 为空时文本与无摘要一致（不出现 Lifecycle summary）", !summaryEmptyText.includes("Lifecycle summary") && summaryEmptyText === normalText);
check("文本含证据门槛 ≥2", normalText.includes("at least 2 concrete evidence items"));
check("文本含每边界 ≤1 变更", normalText.includes("at most 1 skill change"));
check("文本禁批量/市场/通用 runner", normalText.includes("No batch extraction") && normalText.includes("no skill market") && normalText.includes("no generic skill runner"));
check("文本为英文且无 CJK", !/[\u4e00-\u9fff]/.test(normalText));

const processFolder = "C:\\Users\\Kaczev\\.dsh\\profiles\\web\\KazPrivatePlugins\\process";
const pluginRoot = "C:\\Users\\Kaczev\\.dsh\\profiles\\web\\KazPrivatePlugins";
const pathText = skillReviewGuidanceText("normal", processFolder, pluginRoot);
check("传入路径时 Create 含具体 processFolder", pathText.includes(`${processFolder}/<candidate-name>/CANDIDATE.md`));
check("传入路径时 Create 含具体 pluginRoot", pathText.includes(`${pluginRoot}/<plugin>/`));
check("文本含 create the folder when missing", pathText.includes("create the folder when missing") && normalText.includes("create the folder when missing"));
check("文本含 process trace only", pathText.includes("process trace only") && normalText.includes("process trace only"));
check("文本不再包含 project process folder", !pathText.includes("project process folder") && !normalText.includes("project process folder"));
check("路径文本为英文且无 CJK", !/[\u4e00-\u9fff]/.test(pathText));
check("兜底文本明确 private Kaz process folder / KazPrivatePlugins", normalText.includes("private Kaz process folder") && normalText.includes("KazPrivatePlugins"));
check("Create 含 justified 判定锚点", pathText.includes("Create is justified only when") && normalText.includes("Create is justified only when"));
check("Create 要求 executable module + offline probe", pathText.includes("executable module + offline probe") && normalText.includes("executable module + offline probe"));
check("Create 排除已 active skill 覆盖", pathText.includes("not already covered by an active skill") && normalText.includes("not already covered by an active skill"));
check("Create 要求可调用工具/模块或 Kaczev 显式要求", pathText.includes("adds a tool/module an agent can actually call") && pathText.includes("Kaczev explicitly asked for full implementation"));
check("runbook 只写 memory 不建 CANDIDATE", pathText.includes("Pure knowledge/runbook/config procedures") && pathText.includes("write memory only") && pathText.includes("do NOT create a CANDIDATE skill"));
check("CANDIDATE-only 不算完成自我更新", pathText.includes("CANDIDATE-only") && pathText.includes("does NOT complete self-update"));
check("CANDIDATE-only 不消耗变更预算", pathText.includes("does not consume the at-most-1 skill-change budget"));
check("停在 CANDIDATE 需显式声明未完成", pathText.includes("self-update is NOT complete yet") && pathText.includes("keep a next-stage entry"));
check("Create 粒度 = 完整生命周期", pathText.includes("one Create = full lifecycle") && pathText.includes("CANDIDATE + implementation + probe + registration"));

const agent = { id: "s-skill" };
const kazModeVisible = {
  kazMode: { toolVisible: () => true },
  tools: { schemas: () => [] },
};
check("skillLifecycleCallable: kazMode.toolVisible 可见任一工具 → true", skillLifecycleCallable(kazModeVisible, agent) === true);

const schemasFallback = {
  kazMode: undefined,
  tools: {
    schemas: () => [{ name: "edit", description: "", parameters: {} }, { name: "pwsh", description: "", parameters: {} }],
  },
};
check("skillLifecycleCallable: tools.schemas 含 edit → true", skillLifecycleCallable(schemasFallback, agent) === true);

const noVisible = {
  kazMode: { toolVisible: () => false },
  tools: { schemas: () => [] },
};
check("skillLifecycleCallable: 全部不可见 → false", skillLifecycleCallable(noVisible, agent) === false);
check("skillLifecycleCallable: 无服务/null → false", skillLifecycleCallable(undefined, agent) === false && skillLifecycleCallable(null, agent) === false);

const kazModePartial = {
  kazMode: { toolVisible: (a, name) => name === "safe_json_write" },
  tools: { schemas: () => [] },
};
check("skillLifecycleCallable: 仅 safe_json_write 可见 → true", skillLifecycleCallable(kazModePartial, agent) === true);

check("toolCallable 仍从主入口 re-export", typeof toolCallable === "function");
check("skillReviewGuidanceText 仍从主入口 re-export", typeof skillReviewGuidanceText === "function" && typeof skillLifecycleCallable === "function");

console.log(failures === 0 ? "\nSKILL-GUIDANCE PROBE OK" : `\nSKILL-GUIDANCE PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
