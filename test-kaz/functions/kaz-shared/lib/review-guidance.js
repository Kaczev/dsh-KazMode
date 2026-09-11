// kaz-shared —— 工具可用性判断（纯 ESM）
// ===========================================================================
// v0.9 B3.5：方向1 memory Review 复盘文案已移除；本文件只保留 toolCallable，
// 供 skill-guidance / ka-whale-workflow 做“工具在当前环境是否可调用”的判定。
// ===========================================================================

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
