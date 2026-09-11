// kaz-core —— Kaz 8.0 的工具面门。
//
// 当前只做一件事：给主代理挂上 §2.1 工具面黑名单（写记忆三件对主代理不可见、
// 调用即报错）。子代理的黑名单由派发时交给平台处理（toolFilter），不在这里管；
// 记忆管理员的固定黑名单由派发方按 §2.2 使用。
//
// 挂点：agent/created —— 每个 agent 创建时，在它自己的 scope 上收紧工具面。
// 还没挂上的工具名会被跳过（等工具挂上后自然收紧），单个名字失败不影响其它名字。

export const name = "kaz-core";

export const inject = [];

import { MAIN_BLACKLIST } from "../../kaz-prompts/lib/blacklists.js";
import { isSubagentAgent } from "./agent-role.js";

/**
 * 在某个 agent 自己的 scope 上逐名收紧工具面。
 * @param {object} agent - 目标 agent（其 ctx 即 agent 自己的 scope）。
 * @param {readonly string[]} names - 要屏蔽的工具名。
 * @param {object} [logger] - 可选日志（cordis ctx.logger）。
 * @returns {{applied: string[], skipped: string[]}} 实际生效与跳过的名字。
 */
export function restrictTools(agent, names, logger) {
  const tools = agent?.ctx?.tools;
  if (tools === undefined || tools === null || typeof tools.restrict !== "function") {
    logger?.warn?.("[kaz-core] tools registry unavailable; blacklist not applied");
    return { applied: [], skipped: [...names] };
  }
  const applied = [];
  const skipped = [];
  for (const name of names) {
    try {
      tools.restrict({ deny: [name] });
      applied.push(name);
    } catch {
      skipped.push(name);
    }
  }
  if (skipped.length > 0) {
    logger?.debug?.(`[kaz-core] blacklist skipped (not mounted yet): ${skipped.join(", ")}`);
  }
  return { applied, skipped };
}

export function apply(ctx) {
  ctx.on("agent/created", (payload) => {
    try {
      const agent = payload?.agent;
      if (agent === undefined || agent === null) return;
      if (isSubagentAgent(agent)) return; // 子代理：黑名单由派发时给定
      restrictTools(agent, MAIN_BLACKLIST, ctx.logger);
    } catch (error) {
      ctx.logger?.warn?.(`[kaz-core] main blacklist failed: ${String(error)}`);
    }
  });
}
