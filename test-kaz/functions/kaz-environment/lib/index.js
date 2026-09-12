// kaz-environment —— 把 environment 记忆注入系统提示。
//
// 位置：**persona 之下、官方工具提示之上**。依据官方 SECTION_ORDERS：
//   DEPLOYMENT_PERSONA_PREFIX = 0，最早的官方工具段 = 500（PLAN_POLICY），
// 所以这里用 order 1，稳稳落在两者之间。
//
// 内容来源：两个 location 的固定文件（没有目录、不进 KINDS）：
//   global : <dsh home>/storages/ka-whale-memory/environment.json
//   local  : <项目>/.dsh/storages/ka-whale-memory/environment.json
// 读取用 `text` 回调（**每次装配时读盘**），所以改完立刻生效，不需要重启。
//
// 只注入给主代理：子代理有自己的固定 persona，看不到这段。
// 内容为空时整段不出现（不占系统提示）。

export const name = "kaz-environment";

export const inject = [];

import { promises as fs } from "node:fs";
import { environmentFilePath, projectRoot } from "../../ka-whale-memory/lib/paths.js";
import { isSubagentAgent } from "../../kaz-shared/lib/agent-role.js";

/** 注入段名与排序：persona(0) 之后、官方工具提示(≥500) 之前。 */
export const ENVIRONMENT_SECTION = "kaz-environment";
export const ENVIRONMENT_SECTION_ORDER = 1;

const HEADER = "environment memory";

/** 读一个 environment 文件正文；缺失/损坏/空 → 空串。 */
async function readBody(location, projectDir) {
  try {
    const text = await fs.readFile(environmentFilePath(location, projectDir), "utf8");
    const data = JSON.parse(text);
    const body = data?.environment;
    return typeof body === "string" ? body.trim() : "";
  } catch {
    return "";
  }
}

/**
 * 组装注入文本；两边都空则返回空串（调用方据此整段省略）。
 * 排版：标题行 → "global" 行 → global 正文 → 空行 → "local" 行 → local 正文。
 * @param {string} projectDir - local 库的根（会话 cwd）。
 */
export async function renderEnvironmentText(projectDir) {
  const [globalBody, localBody] = await Promise.all([
    readBody("global", projectDir),
    readBody("local", projectDir),
  ]);
  if (globalBody.length === 0 && localBody.length === 0) return "";
  const blocks = [];
  if (globalBody.length > 0) blocks.push(`global\n${globalBody}`);
  if (localBody.length > 0) blocks.push(`local\n${localBody}`);
  return [HEADER, ...blocks].join("\n\n");
}

/**
 * local 库的根（= 会话 cwd）。
 *
 * 首选 `context.agent.session.header.cwd`——这是官方接口，dsh-agent 自己就用它注册
 * `{{cwd}}` 变量（`ctx.systemPrompt.variable("cwd", (context) => context.agent?.session.header.cwd)`）。
 * 拿不到时（例如没有 agent 的装配）才回退到 `projectRoot()` 的路径推导。
 * **实测教训**：测试区的预设装在 `<home>\.agent-presets\kaz`，它的祖先里没有 `.dsh` 层，
 * 路径推导只能回退到 home；而会话 cwd 永远是对的，所以能用会话就绝不用推导。
 */
function localRoot(context) {
  const cwd = context?.agent?.session?.header?.cwd;
  if (typeof cwd === "string" && cwd.trim().length > 0) return cwd.trim();
  return projectRoot();
}

export function apply(ctx) {
  ctx.on("system-prompt/assemble", async (assembly, context, next) => {
    try {
      const agent = context?.agent;
      if (assembly !== null && typeof assembly === "object" && Array.isArray(assembly.sections) && !isSubagentAgent(agent)) {
        const text = await renderEnvironmentText(localRoot(context));
        if (text.length > 0) {
          const sections = assembly.sections.filter(
            (section) => section === null || typeof section !== "object" || section.name !== ENVIRONMENT_SECTION,
          );
          sections.push({ name: ENVIRONMENT_SECTION, order: ENVIRONMENT_SECTION_ORDER, text });
          assembly.sections = sections;
        }
      }
    } catch (error) {
      ctx.logger?.warn?.(`[kaz-environment] injection failed: ${String(error)}`);
    }
    return next();
  });
}
