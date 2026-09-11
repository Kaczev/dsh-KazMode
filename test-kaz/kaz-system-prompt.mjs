// kaz-system-prompt —— Kaz 8.0 系统提示控制器。
//
// 两件事：
//   1) persona 注入：主代理的系统提示 persona 取 functions/kaz-prompts 的
//      MAIN_PERSONA（单一事实源）；子代理保留派发时给定的自己的 persona。
//   2) 提示面收口：只保留 Kaz 自己的注入段落（现在=persona；以后的阶段注入、
//      压缩提醒由对应功能加进 KEEP_SECTIONS）。平台默认的 base 身份句、工具
//      指引、环境说明等段落一律丢弃——否则模型看到的就是"标准模式"的提示。

export const name = "kaz-system-prompt";

export const inject = [];

import { PERSONA_PREFIX_SECTION } from "@deepseek-ai/dsh-persona";
import { MAIN_PERSONA } from "./functions/kaz-prompts/lib/roles.js";

/** 允许出现在模型系统提示里的段落名（Kaz 自己的注入内容）。 */
export const KEEP_SECTIONS = new Set([PERSONA_PREFIX_SECTION]);

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
      if (assembly !== null && typeof assembly === "object" && Array.isArray(assembly.sections)) {
        const isSubagent = isSubagentAgent(agent);
        const sections = assembly.sections;
        let kept = sections.filter(
          (section) => section !== null && typeof section === "object" && KEEP_SECTIONS.has(section.name),
        );
        if (!isSubagent) {
          const persona = kept.find((section) => section.name === PERSONA_PREFIX_SECTION);
          if (persona === undefined) {
            kept = [{ name: PERSONA_PREFIX_SECTION, order: 0, text: MAIN_PERSONA }, ...kept];
          } else {
            persona.text = MAIN_PERSONA;
          }
        } else if (kept.length === 0) {
          // 子代理的 persona 段缺位时不收口，避免把一个子代理的提示清空。
          kept = sections;
        }
        assembly.sections = kept;
      }
    } catch (error) {
      ctx.logger?.warn?.(`[kaz-system-prompt] persona injection failed: ${String(error)}`);
    }
    return next();
  });
}
