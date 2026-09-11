// kaz-system-prompt —— Kaz 8.0 系统提示控制器（persona 注入）。
//
// 作用：主代理的系统提示 persona 取 functions/kaz-prompts 的 MAIN_PERSONA
//（单一事实源），而不是 agent.cordis.yml 里的短兜底；子代理保留派发时给定的
// 自己的 persona，不被覆盖。
//
// 只做这一件事。阶段注入（ka-whale-workflow）与压缩提醒（ka-context-policy）
// 各自在对应功能里注册段落，不并进这里。

export const name = "kaz-system-prompt";

export const inject = [];

import { PERSONA_PREFIX_SECTION } from "@deepseek-ai/dsh-persona";
import { MAIN_PERSONA } from "./functions/kaz-prompts/lib/roles.js";

/** 判断是否为子代理会话（子代理的 persona 由派发时给定，必须原样保留）。 */
function isSubagentAgent(agent) {
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

export function apply(ctx) {
  ctx.on("system-prompt/assemble", async (assembly, context, next) => {
    try {
      const agent = context?.agent;
      if (assembly !== null && typeof assembly === "object" && Array.isArray(assembly.sections) && !isSubagentAgent(agent)) {
        let replaced = false;
        for (const section of assembly.sections) {
          if (section !== null && typeof section === "object" && section.name === PERSONA_PREFIX_SECTION) {
            section.text = MAIN_PERSONA;
            replaced = true;
          }
        }
        if (!replaced) {
          assembly.sections.push({ name: PERSONA_PREFIX_SECTION, order: 0, text: MAIN_PERSONA });
        }
      }
    } catch (error) {
      ctx.logger?.warn?.(`[kaz-system-prompt] persona injection failed: ${String(error)}`);
    }
    return next();
  });
}
