// kaz-shared —— 方向1 复盘指引：语义 + 文本 + 工具可用性判断（共享配置/常量，纯 ESM）
// ===========================================================================
// 说明：
//   * review 的“语义”描述结构化字段的含义与约束；这些字段是元数据，不进入
//     BM25 文档（content + summary + keywords）；
//   * 文本为英文、简短、第三人称（We/They 集体口吻）；
//   * 可用性判断为纯函数：ka-whale-workflow 只需要传入当前 agent 的
//     kazMode/tools 服务，不依赖 kaz-memory 私有字段名。
// ===========================================================================

/** 每次复盘最多写入的记忆条数。 */
export const MEMORY_REVIEW_MAX_ITEMS = 2;

/** 新记忆的默认生命周期状态。 */
export const MEMORY_REVIEW_DEFAULT_LIFECYCLE_STATUS = "CANDIDATE";

/** 复盘涉及的结构化字段名（仅供文档/校验引用；这些字段不进 BM25）。 */
export const MEMORY_REVIEW_FIELDS = Object.freeze({
  type: "type",
  evidence: "evidence",
  confidence: "confidence",
  lifecycleStatus: "lifecycle_status",
});

/**
 * 生成复盘指引文本。
 * @param {"normal"|"plan"|"goal"} kind 复盘场景
 * @param {number} [maxItems] 最多写入条数，默认 MEMORY_REVIEW_MAX_ITEMS
 */
export function reviewGuidanceText(kind = "normal", maxItems = MEMORY_REVIEW_MAX_ITEMS) {
  const label =
    kind === "plan"
      ? "The Plan has ended."
      : kind === "goal"
        ? "The Goal has ended."
        : "The task has completed.";
  const n = Number.isInteger(maxItems) && maxItems >= 1 ? maxItems : MEMORY_REVIEW_MAX_ITEMS;
  return `[kaz-memory Review]
>
${label} If there was a substantive change or new conclusion (not repeating known content), we may write 1–${n} memories with memory_save:
- type: success_pattern / error_pattern / insight, etc.
- evidence: concrete source (probe / file / code / user feedback).
- confidence: unknown / low / medium / high; never high without evidence.
- New memories default to lifecycle_status=${MEMORY_REVIEW_DEFAULT_LIFECYCLE_STATUS}.
If there is no substantive conclusion, do not write anything (avoid noise).`;
}

/**
 * 判断某工具在当前代理环境是否真正可调用。
 * 1) services.kazMode 存在且 toolVisible 返回 true 时直接判定可调用；
 * 2) 否则回退 services.tools.schemas(agent) 是否包含该工具。
 * 读不到的服务/设置不阻断；判定失败按“不可用”处理。
 */
export function toolCallable(services, agent, toolName) {
  try {
    const kazMode = services?.kazMode;
    if (kazMode !== undefined && kazMode !== null && typeof kazMode.toolVisible === "function") {
      if (kazMode.toolVisible(agent, toolName) === true) return true;
    }
  } catch {
    // fall through
  }
  try {
    const tools = services?.tools;
    if (tools !== undefined && tools !== null && typeof tools.schemas === "function") {
      const schemas = tools.schemas(agent);
      return (
        Array.isArray(schemas) &&
        schemas.some((schema) => schema !== null && typeof schema === "object" && schema.name === toolName)
      );
    }
  } catch {
    // fall through
  }
  return false;
}
