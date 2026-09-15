// kaz-shared —— Kaz 8.0 的工具面门。
//
// 给主代理挂上 §2.1 工具面黑名单，并按**当前阶段**再收一道。三条腿一起走：
//   1) 注册表级：在 agent 自己的 scope 上 restrict —— 黑名单工具对主代理不可见，
//      硬报名字调用会被拒。由 agent/created 或首次 assemble 触发，每个 agent 只做一次。
//   2) 本次请求级：assemble 钩子里过滤 assembly.tools —— 请求头的工具表就是它。
//      平台每步一开始就 assemble()（工具表已算好），监听器跑在它后面；只靠 (1)
//      会晚一个请求，所以 (2) 保证第一个请求的工具面就是干净的。
//   3) 阶段级（self-check）：处于 self-check 时，请求级过滤改成**白名单**——
//      工具面只剩 whale_report。这条必须是请求级而不是注册表级：restrict 是永久的，
//      进了 self-check 再出来，工具面就回不来了。
//
// 子代理不动：子代理的黑名单由派发时交给平台处理（toolFilter），阶段对它们也不注入。

export const name = "kaz-shared";

// `restrictTools()` 会访问 `agent.ctx.tools`；cordis 只为**声明过**的服务绑定访问，
// 未声明就取会抛 `cannot get property "tools" without inject`——该错误发生在**挂载期**时
// 会让整个预设挂不起来、会话接不回来（本项目真踩过）。这里访问发生在回调内、级别低一档，
// 但同样声明掉。
export const inject = ["tools"];

import { MAIN_BLACKLIST } from "./blacklists.js";
import { isSubagentAgent } from "./agent-role.js";
import { readStageSync } from "../../ka-whale-workflow/lib/stage-store.js";
import { SELF_CHECK_ONLY_TOOL } from "../../ka-whale-workflow/lib/stages.js";

/**
 * self-check 阶段：工具面**只剩这一件**。
 *
 * 与 MAIN_BLACKLIST 的方向相反——那边是"点名禁掉几个"，这里是"只留下一个"。
 * 所以每次装配时按当前阶段算一次 assembly.tools，而不是往 agent scope 上挂 deny：
 * 挂 deny 是永久的，进了 self-check 再出来，工具面就回不来了。
 * 名字取自阶段定义（stages.js），不在这里重复写一遍。
 */
const SELF_CHECK_TOOLS = Object.freeze([SELF_CHECK_ONLY_TOOL]);

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
    // 当前阶段决定这一请求的工具面。读的是阶段文件（同步），读不到按"不在特殊阶段"处理。
    const stage = readStageSync(agent.session);
    // 注册表级收紧只在**不在 self-check** 时做：进 self-check 前它是正确的，
    // 而 self-check 里要的是"只剩一件"，那由下面的请求级过滤负责。
    if (stage !== "self-check") applyOnce(agent);
    if (assembly !== null && typeof assembly === "object" && Array.isArray(assembly.tools)) {
      assembly.tools =
        stage === "self-check"
          ? assembly.tools.filter((tool) => SELF_CHECK_TOOLS.includes(tool?.name))
          : assembly.tools.filter((tool) => !MAIN_BLACKLIST.includes(tool?.name));
    }
    return next();
  });
}
