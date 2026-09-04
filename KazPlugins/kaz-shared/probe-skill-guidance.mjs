// kaz-shared 探针：v0.9 B3.5 后 skill-guidance 只保留生命周期常量与
// skillLifecycleCallable，不再提供 [skill Review] 文案。
// 运行：node KazPlugins/kaz-shared/probe-skill-guidance.mjs
import {
  SKILL_PRIVATE_DIR_NAME,
  SKILL_PROCESS_DIR_NAME,
  SKILL_BOUNDARY_MAX_CHANGES,
  SKILL_LIFECYCLE_TOOLS,
  skillLifecycleCallable,
} from "./lib/tool-lists.js";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

check("常量 SKILL_BOUNDARY_MAX_CHANGES = 1", SKILL_BOUNDARY_MAX_CHANGES === 1);
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

const agent = { id: "agent" };
const noVisible = {
  kazMode: { toolVisible: () => false },
  tools: { schemas: () => [] },
};
check("skillLifecycleCallable: 全部不可见 → false", skillLifecycleCallable(noVisible, agent) === false);
check("skillLifecycleCallable: 无服务/null → false", skillLifecycleCallable(undefined, agent) === false && skillLifecycleCallable(null, agent) === false);

const kazModeVisible = {
  kazMode: { toolVisible: (a, name) => a === agent && name === "pwsh" },
};
check("skillLifecycleCallable: kazMode.toolVisible 可见任一工具 → true", skillLifecycleCallable(kazModeVisible, agent) === true);

const schemasFallback = {
  kazMode: null,
  tools: {
    schemas: (a) =>
      a === agent ? [{ name: "edit" }, { name: "read" }] : [],
  },
};
check("skillLifecycleCallable: tools.schemas 含 edit → true", skillLifecycleCallable(schemasFallback, agent) === true);

// B3.5：Review 文案已移除，主入口不应再提供 skillReviewGuidanceText / SKILL_EVIDENCE_MIN。
(async () => {
  const entry = await import("./lib/tool-lists.js");
  check(
    "主入口不再导出 skillReviewGuidanceText / SKILL_EVIDENCE_MIN",
    !("skillReviewGuidanceText" in entry) && !("SKILL_EVIDENCE_MIN" in entry),
  );
  if (failures === 0) {
    console.log("\nSKILL-GUIDANCE PROBE OK");
    process.exit(0);
  } else {
    console.error(`\nSKILL-GUIDANCE PROBE FAILED: ${failures}`);
    process.exit(1);
  }
})();
