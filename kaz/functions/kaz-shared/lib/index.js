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

/**
 * 本回合生效的阶段（按会话记）。
 *
 * 为什么需要它：工具面在**每一步开头**装配，而阶段切换发生在同一步的 `agent/pre-step` 里。
 * 如果两边各自去读阶段文件，就会出现"注入显示 self-check、工具面还是旧的"这种错位回合——
 * 实测踩过：自动进入的那一回合拿不到 self-check 的工具面，于是多花一整个回合手动调
 * whale_report 才真正进去（用户数出来就是"差一轮"）。
 * 所以改成**在 pre-step 定一次**（ka-whale-workflow 算完后广播），装配工具面时用同一个值。
 */
const effectiveStages = new Map();

/**
 * 由 ka-whale-workflow 在 pre-step 里调用：记下**本回合**对外的阶段。
 * @param {string} sessionId - 会话 id。
 * @param {string} stage - 阶段名。
 */
export function noteEffectiveStage(sessionId, stage) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return;
  if (typeof stage !== "string" || stage.length === 0) return;
  effectiveStages.set(sessionId, stage);
}

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

  /**
   * self-check 的**调用时刻锁**。
   *
   * 为什么不能只靠过滤工具表：循环里 `assemble()` 在 `agent/pre-step` **之前**（dsh-agent-loop:889-894），
   * 所以本步的工具表在本步的阶段决定之前就已经冻结 —— 无论怎么广播阶段，**进入 self-check 的那一步**
   * 的工具表里仍有别的工具（实测：那时 pwsh 照样跑得起来）。
   *
   * `tools.guard` 是**分发前**求值的否决（dsh-tools：ToolGuard = exec => reason | undefined，
   * 在 `tools/pre-execute` 之后），所以它读到的阶段一定是最新的，与装配时机无关。
   * 通过 `agent.ctx` 注册 → 只对该 agent 生效；`guard()` 返回解除用的 disposer。
   */
  const guardInstalled = new WeakSet();
  const installSelfCheckGuard = (agent) => {
    if (agent === undefined || agent === null) return;
    if (isSubagentAgent(agent)) return;
    if (guardInstalled.has(agent)) return;
    const tools = agent?.ctx?.tools;
    if (tools === undefined || tools === null || typeof tools.guard !== "function") {
      ctx.logger?.warn?.("[kaz-shared] tools.guard unavailable; self-check lock not enforced");
      return;
    }
    guardInstalled.add(agent);
    tools.guard((execution) => {
      const stage = effectiveStages.get(agent.session?.id) ?? readStageSync(agent.session);
      if (stage !== "self-check") return undefined;
      const called = execution?.name;
      if (typeof called === "string" && SELF_CHECK_TOOLS.includes(called)) return undefined;
      return `self-check: ${SELF_CHECK_ONLY_TOOL} is the only tool that works in this stage`;
    });
  };
  ctx.on("agent/created", (payload) => installSelfCheckGuard(payload?.agent));

  ctx.on("system-prompt/assemble", (assembly, context, next) => {
    const agent = context?.agent;
    if (agent === undefined || agent === null || isSubagentAgent(agent)) return next();
    // 当前阶段决定这一请求的工具面：**优先用 pre-step 定下的"本回合阶段"**，
    // 读不到才退回阶段文件（首次装配、或 pre-step 还没跑过）。
    // 两边用同一次判断，才不会出现"注入是新阶段、工具面是旧阶段"的错位回合。
    const sessionId = agent.session?.id;
    const remembered = typeof sessionId === "string" ? effectiveStages.get(sessionId) : undefined;
    const stage = remembered ?? readStageSync(agent.session);
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
