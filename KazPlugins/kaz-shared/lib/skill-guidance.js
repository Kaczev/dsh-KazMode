// kaz-shared —— 二阶段：技能自省指引（常量 + 文本 + 闭环能力可用性判断；纯 ESM）
// ===========================================================================
// 说明：
//   * 与 lib/review-guidance.js 平行的独立模块：memory review 管“写记忆”，
//     skill review 管“是否值得 Create / Update / Retire 一个可执行 skill”；
//   * 文本为英文、第三人称（We 集体口吻）、紧凑，避免把技能决策混进记忆文本；
//   * 过程目录固定为用户 profile 的私有目录
//     KazPrivatePlugins/process（SKILL_PRIVATE_DIR_NAME/SKILL_PROCESS_DIR_NAME），
//     不再依赖“当前工作目录 / project process folder”这类不可定位占位词；
//   * skillLifecycleCallable 仿 toolCallable：只判断当前环境是否具备走技能闭环
//     的基础工具（write / edit / pwsh / safe_json_write 至少一项可见）。
// ===========================================================================

import { toolCallable } from "./review-guidance.js";

/** 私有技能根目录名（用户 profile 下，不在公共 repo 内）。 */
export const SKILL_PRIVATE_DIR_NAME = "KazPrivatePlugins";

/** 私有过程文档根目录名（在 SKILL_PRIVATE_DIR_NAME 之下）。 */
export const SKILL_PROCESS_DIR_NAME = "process";

/** 每个安全边界最多落地的技能变更数（硬上限，禁止批量提取/落地）。 */
export const SKILL_BOUNDARY_MAX_CHANGES = 1;

/** 新建/更新技能的最低具体证据条数。 */
export const SKILL_EVIDENCE_MIN = 2;

/** 技能闭环的基础工具：任一可见即可注入技能自省；完整闭环还需 pwsh 跑验证。 */
export const SKILL_LIFECYCLE_TOOLS = Object.freeze(["write", "edit", "pwsh", "safe_json_write"]);

/**
 * 生成技能自省指引文本。
 * @param {"normal"|"plan"|"goal"} kind 安全边界场景
 * @param {string} [processFolder] 私有过程目录绝对路径（例如 .../KazPrivatePlugins/process）
 * @param {string} [pluginRoot] 私有插件根目录绝对路径（例如 .../KazPrivatePlugins）
 */
export function skillReviewGuidanceText(kind = "normal", processFolder = "", pluginRoot = "") {
  const label =
    kind === "plan"
      ? "The Plan has ended."
      : kind === "goal"
        ? "The Goal has ended."
        : "The task has completed.";
  const hasPaths =
    typeof processFolder === "string" && processFolder.trim().length > 0 &&
    typeof pluginRoot === "string" && pluginRoot.trim().length > 0;
  const createLine = hasPaths
    ? `- Create: write CANDIDATE.md under ${processFolder.trim()}/<candidate-name>/CANDIDATE.md (create the folder when missing). CANDIDATE.md is process trace only and does not change any switch.json or manifest version. When justified, implement the private plugin under ${pluginRoot.trim()}/<plugin>/ (package.json + lib/index.js + skills/<skill>/ + probe), add it as a file: dependency in the profile package.json and an insert in the profile cordis.patch.yml, register it in kaz-agent-managed-tools.json, and verify ALL probes before restart/versioning.`
    : `- Create: write CANDIDATE.md in the private Kaz process folder (KazPrivatePlugins/process/<skill-name>/CANDIDATE.md; create the folder when missing). CANDIDATE.md is process trace only and does not change any switch.json or manifest version. When justified, implement the private plugin under KazPrivatePlugins/<plugin>/ (package.json + lib/index.js + skills/<skill>/ + probe), add it as a file: dependency in the profile package.json and an insert in the profile cordis.patch.yml, register it in kaz-agent-managed-tools.json, and verify ALL probes before restart/versioning.`;
  return `[skill Review]
>
${label} If this run produced a reusable, low-risk, offline-verifiable procedure with at least ${SKILL_EVIDENCE_MIN} concrete evidence items (memory id, file path, error record, or repeated action), we may run at most ${SKILL_BOUNDARY_MAX_CHANGES} skill change at this safe boundary:
${createLine}
- Update: record the observed defect/fix evidence and draft the version bump; do not change switch/version silently.
- Retire: only if a documented trigger exists (superseded, broken after repair attempts, or long unused).
No batch extraction, no skill market, no generic skill runner. With insufficient evidence, write memory only and do nothing else.
<`;
}

/**
 * 当前代理环境是否具备走技能闭环的基础能力。
 * 1) 复用 review-guidance.js 的 toolCallable 可用性判定；
 * 2) 只要 write / edit / pwsh / safe_json_write 中任一可见即返回 true；
 * 3) 服务读不到或全部不可见时按“不可用”处理（返回 false）。
 */
export function skillLifecycleCallable(services, agent) {
  for (const name of SKILL_LIFECYCLE_TOOLS) {
    try {
      if (toolCallable(services, agent, name) === true) return true;
    } catch {
      // 单个工具判定异常不影响其余候选工具
    }
  }
  return false;
}
