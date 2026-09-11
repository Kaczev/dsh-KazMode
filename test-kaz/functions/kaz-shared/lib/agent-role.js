// kaz-shared —— agent 角色判定：主代理 vs 子代理。
// 子代理的黑名单与 persona 都由派发时给定；主代理走预设自己的规则。

/** 判断是否为子代理会话。判定失败按主代理处理。 */
export function isSubagentAgent(agent) {
  try {
    const depth = agent?.options?.subagentDepth;
    if (typeof depth === "number" && depth > 0) return true;
    const header = agent?.session?.header;
    if (
      header !== null &&
      typeof header === "object" &&
      (header.origin === "subagent" || typeof header.parentSession === "string")
    ) {
      return true;
    }
    const events = agent?.session?.events;
    if (Array.isArray(events)) {
      for (const event of events) {
        if (event !== null && typeof event === "object" && event.type === "subagent/descriptor") return true;
      }
    }
  } catch {
    // 探测失败按主代理处理
  }
  return false;
}
