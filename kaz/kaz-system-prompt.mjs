// kaz-system-prompt —— Kaz 8.0 系统提示控制器。
//
// 两件事：
//   1) persona 注入：主代理的系统提示 persona 取 functions/kaz-shared 的
//      MAIN_PERSONA（单一事实源）；子代理保留派发时给定的自己的 persona。
//   2) 摘掉平台默认的 harness:identity 段（"You are an AI agent powered by
//      DeepSeek Harness."）——它会让 Kaz 看起来像标准模式。其余平台段落
//      （工具指引、环境说明等）保留。
//
// DROP_SECTIONS 是唯一的"不要出现"清单；以后 Kaz 自己的注入段（阶段、提醒）
// 由对应功能直接注册，不需要在这里登记。

export const name = "kaz-system-prompt";

export const inject = [];

import { PERSONA_PREFIX_SECTION } from "@deepseek-ai/dsh-persona";
import { MAIN_PERSONA } from "./functions/kaz-shared/lib/roles.js";
import { isSubagentAgent } from "./functions/kaz-shared/lib/agent-role.js";

/** 不允许出现在模型系统提示里的平台段落名。 */
export const DROP_SECTIONS = new Set(["harness:identity"]);

export function apply(ctx) {
  ctx.on("system-prompt/assemble", async (assembly, context, next) => {
    try {
      const agent = context?.agent;
      if (assembly !== null && typeof assembly === "object" && Array.isArray(assembly.sections)) {
        const isSubagent = isSubagentAgent(agent);
        let sections = assembly.sections.filter(
          (section) => section !== null && typeof section === "object" && !DROP_SECTIONS.has(section.name),
        );
        if (!isSubagent) {
          const persona = sections.find((section) => section.name === PERSONA_PREFIX_SECTION);
          if (persona === undefined) {
            sections = [{ name: PERSONA_PREFIX_SECTION, order: 0, text: MAIN_PERSONA }, ...sections];
          } else {
            persona.text = MAIN_PERSONA;
          }
        }
        assembly.sections = sections;
      }
    } catch (error) {
      ctx.logger?.warn?.(`[kaz-system-prompt] prompt assembly failed: ${String(error)}`);
    }
    return next();
  });
}
