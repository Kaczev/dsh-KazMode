// kaz-fork —— 预设自带的 fork provider（《Kaz8.0设计.md》§3.10）。
//
// 与官方 fork 的唯一区别：种子（seed）可以来自"任意存活会话"，而不只是派发者自己。
//   * 官方 fork：seed = 派发者（parent）日志的"最后一个 turn/end 之前"的连续前缀。
//   * kaz-fork：seed = 指定源会话（主代理或某个存活子代理）的同一前缀。
//
// 旁路：`prepareContinuable` 只拿得到 { sessionId, parent, signal }，拿不到自定义字段；
// 所以派发前预生成 childId 并在这里登记"childId → 源会话 id"，provider 用 childId 取回。

import { startInProcessRun } from "@deepseek-ai/dsh-subagent-in-process-driver";

export const KAZ_FORK_PROVIDER = "kaz-fork";

/** childId → 源会话 id（"" 表示派发者自己）。 */
const sourcesByChildId = new Map();

export function noteForkSource(childId, sourceSessionId) {
  sourcesByChildId.set(childId, sourceSessionId ?? "");
}

export function takeForkSource(childId) {
  const value = sourcesByChildId.get(childId);
  sourcesByChildId.delete(childId);
  return value;
}

/**
 * 会话日志里"最后一个 turn/end（含）"之前的连续前缀；没有完成的回合就返回空。
 * 与官方 fork 同规则：seq 从 0 起连续、切在平衡边界。
 * @param {object} session - 源会话。
 * @returns {object[]} 种子事件。
 */
export function completedTurnPrefix(session) {
  const events = typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : [];
  let lastEnd = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === "turn/end") {
      lastEnd = i;
      break;
    }
  }
  if (lastEnd < 0) return [];
  return events.slice(0, lastEnd + 1);
}

/** 按登记信息解析源会话所属的 agent：缺省/派发者自己 → parent；否则查存活的 agent。 */
function resolveSource(ctx, request) {
  const sourceId = takeForkSource(request.sessionId);
  if (sourceId === undefined || sourceId === "" || sourceId === request.parent?.session?.id) return request.parent;
  const agents = ctx.get("agents");
  const agent = agents?.get?.(sourceId);
  return agent ?? undefined;
}

/**
 * 构造 kaz-fork provider。
 * capabilities 与官方 fork 相同；`inheritsParentContext = true`（子代理确实继承一段历史）。
 */
export function createKazForkProvider(ctx) {
  const seedFor = (request) => completedTurnPrefix(resolveSource(ctx, request)?.session);
  return {
    name: KAZ_FORK_PROVIDER,
    capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: true,
    start(request) {
      const seed = seedFor(request);
      return startInProcessRun(request, { ...(seed.length > 0 ? { seed } : {}) });
    },
    async prepareContinuable(request) {
      const seed = seedFor(request);
      return seed.length > 0 ? { seed } : {};
    },
  };
}

/** 注册（返回 disposer）；失败不让预设挂掉。 */
export function registerKazForkProvider(ctx, logger) {
  try {
    const dispose = ctx.subagents.registerProvider(createKazForkProvider(ctx));
    return dispose;
  } catch (error) {
    logger?.warn?.(`[kaz-fork] register failed: ${error instanceof Error ? error.message : String(error)}`);
    return () => {};
  }
}
