// kaz-fork —— 预设自带的 fork provider（《Kaz8.0设计.md》§3.10）。
//
// 与官方 fork 的唯一区别：种子（seed）可以来自"任意存活会话"，而不只是派发者自己。
//   * 官方 fork：seed = 派发者（parent）日志的"最后一个 turn/end 之前"的连续前缀。
//   * kaz-fork：seed = 指定源会话（主代理或某个存活子代理）的同一前缀。
//
// 旁路：`prepareContinuable` 只拿得到 { sessionId, parent, signal }，拿不到自定义字段；
// 所以派发前预生成 childId 并在这里登记"childId → 源会话 id"，provider 用 childId 取回。

import { startInProcessRun } from "@deepseek-ai/dsh-subagent-in-process-driver";
import { FORK_FROM_MAIN } from "./arrangement.js";

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

/** 目标就是派发者自己（主代理）时 `fork` 的唯一合法字面值。唯一定义在 arrangement.js（条目形状那一层）。 */
export { FORK_FROM_MAIN };

/**
 * 把条目上的 `fork` 解析成"这次派发实际能用什么"。
 *
 * **两种缺省必须分开，不能合成一种。** 它们的回执含义正好相反：
 *   * `kind: "none"` —— 条目没说 `fork`（`undefined` / `null` / 空串）：这次就是全新开始，
 *     回执里一个字都不用提。
 *   * `kind: "fallback"` —— 条目说了目标，但它此刻不是活会话：没有源可继承，子代理全新开始，
 *     而且**回执里必须明说**（绝不能出现 "forked from" 这类字眼）。
 *   * `kind: "target"` —— 目标活着（或就是 `"main"`）：`source` 是要交给 provider 的会话 id，
 *     `null` 表示派发者自己的会话。
 *
 * 为什么要有这个函数：早先派发点把"目标就是主代理"和"目标没解析到"都写成空串 `""`，
 * 于是回执无法分辨这两种情况，模型写 `fork: "true"` 时照样读到 "forked from"，
 * 而子代理其实什么都没继承（2026-09-19 实测）。分辨这件事只写一遍，写在这里。
 *
 * @param {unknown} fork - 条目上的 `fork`（形状已由 arrangement.js 校验）。
 * @param {(id: string) => unknown} agentOf - 按会话 id 取活体 agent；拿不到返回 undefined。
 * @returns {{kind: "none"}|{kind: "fallback", target: string}|{kind: "target", target: string, source: string|null}}
 */
export function resolveForkTarget(fork, agentOf) {
  if (typeof fork !== "string" || fork.length === 0) return { kind: "none" };
  if (fork === FORK_FROM_MAIN) return { kind: "target", target: FORK_FROM_MAIN, source: null };
  const agent = typeof agentOf === "function" ? agentOf(fork) : undefined;
  if (agent === undefined || agent === null) return { kind: "fallback", target: fork };
  return { kind: "target", target: fork, source: fork };
}

/**
 * 按登记信息取源会话所属的 agent（登记表由派发点用 `noteForkSource` 写好）。
 *
 * 只认两种登记值：空串 = 派发者自己的会话（`"main"` 与"目标失效退回派发者"都登记成空串，
 * 因为两者最终都从派发者日志取前缀）；别的字符串是外部会话 id，必须在活体注册表里查得到——
 * 查不到就返回 `undefined`（**故意不退回 parent**：派发点已经在 `resolveForkTarget` 里决定过
 * "目标失效 ⇒ 退回派发者"，这里再退一次就是把同一个决定写第二遍）。留 `undefined` 的结果是
 * 前缀为空、子代理全新开始，与派发点对回执的说法一致。
 *
 * @param {object} ctx - 插件上下文。
 * @param {object} request - provider 收到的请求。
 * @returns {object|undefined} 源 agent。
 */
function sourceAgentFor(ctx, request) {
  const sourceId = takeForkSource(request.sessionId);
  if (sourceId === undefined || sourceId === "") return request.parent;
  const agents = ctx.get("agents");
  return agents?.get?.(sourceId) ?? undefined;
}

/**
 * 构造 kaz-fork provider。
 * capabilities 与官方 fork 相同；`inheritsParentContext = true`（子代理确实继承一段历史）。
 */
export function createKazForkProvider(ctx) {
  const seedFor = (request) => completedTurnPrefix(sourceAgentFor(ctx, request)?.session);
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
