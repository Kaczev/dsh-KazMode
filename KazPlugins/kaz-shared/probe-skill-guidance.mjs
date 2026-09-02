// kaz-shared 探针：验证二阶段 skill-guidance（常量/文本/闭环可用性）及 tool-lists 主入口 re-export。
// 运行：node KazPlugins/kaz-shared/probe-skill-guidance.mjs
import {
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
check("normal 文本含 [skill Review] 与完成语义", normalText.includes("[skill Review]") && normalText.includes("The task has completed."));
check("plan 文本语义", planText.includes("[skill Review]") && planText.includes("The Plan has ended."));
check("goal 文本语义", goalText.includes("[skill Review]") && goalText.includes("The Goal has ended."));
check("文本含证据门槛 ≥2", normalText.includes("at least 2 concrete evidence items"));
check("文本含每边界 ≤1 变更", normalText.includes("at most 1 skill change"));
check("文本禁批量/市场/通用 runner", normalText.includes("No batch extraction") && normalText.includes("no skill market") && normalText.includes("no generic skill runner"));
check("文本为英文且无 CJK", !/[\u4e00-\u9fff]/.test(normalText));

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
