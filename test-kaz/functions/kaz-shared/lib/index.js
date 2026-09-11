// kaz-shared —— Kaz 8.0 的工具面门。
//
// 给主代理挂上 §2.1 工具面黑名单。两条腿一起走，缺一不可：
//   1) 注册表级：在 agent 自己的 scope 上 restrict —— 黑名单工具对主代理不可见，
//      硬报名字调用会被拒。由 agent/created 或首次 assemble 触发，每个 agent 只做一次。
//   2) 本次请求级：assemble 钩子里过滤 assembly.tools —— 请求头的工具表就是它。
//      平台每步一开始就 assemble()（工具表已算好），监听器跑在它后面；只靠 (1)
//      会晚一个请求，所以 (2) 保证第一个请求的工具面就是干净的。
//
// 子代理不动：子代理的黑名单由派发时交给平台处理（toolFilter）。

export const name = "kaz-shared";

export const inject = [];

import { MAIN_BLACKLIST } from "./blacklists.js";
import { isSubagentAgent } from "./agent-role.js";

/** 已经收紧过的 agent（每个 agent 只做一次注册表级收紧）。 */
const appliedAgents = new WeakSet();

/**
 * 在某个 agent 自己的 scope 上逐名收紧工具面。
 * @param {object} agent - 目标 agent（其 ctx 即 agent 自己的 scope）。
 * @param {readonly string[]} names - 要屏蔽的工具名。
 * @param {object} [logger] - 可选日志（cordis ctx.logger）。
 * @returns {{applied: string[], skipped: string[], errors: Record<string,string>}} 逐名结果。
 */
export function restrictTools(agent, names, logger) {
  const tools = agent?.ctx?.tools;
  if (tools === undefined || tools === null || typeof tools.restrict !== "function") {
    logger?.warn?.("[kaz-shared] tools registry unavailable; blacklist not applied");
    return { applied: [], skipped: [...names], errors: { "": "tools registry unavailable" } };
  }
  const applied = [];
  const skipped = [];
  const errors = {};
  for (const name of names) {
    try {
      tools.restrict({ deny: [name] });
      applied.push(name);
    } catch (error) {
      skipped.push(name);
      errors[name] = error instanceof Error ? error.message : String(error);
    }
  }
  return { applied, skipped, errors };
}

export function apply(ctx) {
  const applyOnce = (agent) => {
    if (agent === undefined || agent === null) return;
    if (isSubagentAgent(agent)) return;
    if (appliedAgents.has(agent)) return;
    appliedAgents.add(agent);
    restrictTools(agent, MAIN_BLACKLIST, ctx.logger);
  };

  ctx.on("agent/created", (payload) => applyOnce(payload?.agent));

  ctx.on("system-prompt/assemble", (assembly, context, next) => {
    const agent = context?.agent;
    if (agent === undefined || agent === null || isSubagentAgent(agent)) return next();
    applyOnce(agent);
    if (assembly !== null && typeof assembly === "object" && Array.isArray(assembly.tools)) {
      assembly.tools = assembly.tools.filter((tool) => !MAIN_BLACKLIST.includes(tool?.name));
    }
    return next();
  });
}
