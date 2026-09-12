// kaz-environment —— 把 environment 记忆注入模型输入。
//
// 位置：**persona 之下、官方工具提示之上**。这里必须用"动态上下文"（context）而不是"段"（section）：
//   官方把模型输入分成两条渲染路径——
//     * 段   `systemPrompt.section(...)`   → 由 renderPrompt 渲染进**系统提示**（序在 SECTION_ORDERS）
//     * 上下文 `systemPrompt.context(...)` → 由 renderContextSections 渲染进**动态快照**（序在 CONTEXT_ORDERS）
//   官方那批"工具使用提示"（如 SUBAGENT_DELEGATION）走的是**上下文**，序是 110/115/120；
//   而 `FILE_REFERENCE` 是**段**、序 900。
//   先前把 environment 注册成段（order=1）会挤进系统提示里、离工具提示很远——实测就是"位置不对"。
//   现在注册成上下文、序 200：落在**官方那三条上下文（110/115/120）之后**，又远早于段里的 500/900。
//
// 内容来源：两个 location 的固定文件（没有目录、不进 KINDS）：
//   global : <dsh home>/storages/ka-whale-memory/environment.json
//   local  : <项目>/.dsh/storages/ka-whale-memory/environment.json
// text 用**同步回调**：每次装配都重新读盘，所以改完立刻生效、不需要重启。
//   ⚠ 回调必须**同步**：装配期 `assemble()` 是直接 `entry.text(context)` 而**不 await**
//   （官方 dsh-system-prompt/lib/index.js:346），返回 Promise 就会被当成正文送进 interpolate，
//   抛 `text.indexOf is not a function` → **整轮运行失败**（8.1.0 实测）。
//   要"每次读盘"就用 `readFileSync`（两个文件都很小，装配期读盘成本可忽略）；
//   若非要异步，只能改用会被 await 的 `system-prompt/assemble` 事件。
//   ⚠ 正文会过平台变量插值（interpolate）：出现完整的 `{{名字}}` 而该变量未注册即装配抛错、
//   整轮失败——记忆正文里不要写完整的双花括号。
//
// 只注入给主代理：子代理有自己的固定 persona，跳过。
// 两侧都空 → 返回空串 → 整段不出现（空文本的 context 不贡献内容）。
//
// **本行必须声明 `inject = ["systemPrompt"]`**：cordis 只把行自己声明过的服务绑进它的
// 注入存储，未声明的直接属性访问会抛 `cannot get property "systemPrompt" without inject`，
// 且失败发生在**挂载期**——整个预设挂不起来、会话接不回来（8.1.0 实测）。
// 官方 persona 行（@deepseek-ai/dsh-persona）是同一写法的正面样例。

export const name = "kaz-environment";

export const inject = ["systemPrompt"];

import { readFileSync } from "node:fs";
import { environmentFilePath, projectRoot } from "../../ka-whale-memory/lib/paths.js";
import { isSubagentAgent } from "../../kaz-shared/lib/agent-role.js";

/** 注入用的上下文名与排序（见文件头：官方三条上下文是 110/115/120）。 */
export const ENVIRONMENT_CONTEXT = "kaz-environment";
export const ENVIRONMENT_CONTEXT_ORDER = 200;

const HEADER = "environment memory";

/** 读一个 environment 文件正文；缺失/损坏/空 → 空串。同步读（见文件头：装配期不 await 回调）。 */
function readBody(location, projectDir) {
  try {
    const text = readFileSync(environmentFilePath(location, projectDir), "utf8");
    const data = JSON.parse(text);
    const body = data?.environment;
    return typeof body === "string" ? body.trim() : "";
  } catch {
    return "";
  }
}

/**
 * 组装注入文本；两边都空则返回空串（调用方据此不贡献内容）。
 * 排版：标题行 → "global" 行 → global 正文 → 空行 → "local" 行 → local 正文。
 * @param {string} projectDir - local 库的根（会话 cwd）。
 */
export function renderEnvironmentText(projectDir) {
  const globalBody = readBody("global", projectDir);
  const localBody = readBody("local", projectDir);
  if (globalBody.length === 0 && localBody.length === 0) return "";
  const blocks = [];
  if (globalBody.length > 0) blocks.push(`global\n${globalBody}`);
  if (localBody.length > 0) blocks.push(`local\n${localBody}`);
  return [HEADER, ...blocks].join("\n\n");
}

/**
 * local 库的根（= 会话 cwd）。
 *
 * 首选 `context.agent.session.header.cwd`——官方接口，dsh-agent 自己就用它注册 `{{cwd}}` 变量。
 * 拿不到时才回退 `projectRoot()` 的路径推导。**实测教训**：测试区的预设装在 `<home>\.agent-presets\kaz`，
 * 祖先里没有 `.dsh` 层，路径推导只能回退 home；会话 cwd 永远是对的，所以能用会话就绝不用推导。
 */
function localRoot(context) {
  const cwd = context?.agent?.session?.header?.cwd;
  if (typeof cwd === "string" && cwd.trim().length > 0) return cwd.trim();
  return projectRoot();
}

export function apply(ctx) {
  const systemPrompt = ctx?.systemPrompt;
  if (systemPrompt === undefined || systemPrompt === null || typeof systemPrompt.context !== "function") {
    ctx.logger?.warn?.("[kaz-environment] systemPrompt.context is unavailable; environment memory not injected");
    return;
  }
  systemPrompt.context({
    name: ENVIRONMENT_CONTEXT,
    order: ENVIRONMENT_CONTEXT_ORDER,
    // 同步回调：装配期不会 await 它（见文件头）。返回字符串，绝不返回 Promise。
    text: (context) => {
      try {
        if (isSubagentAgent(context?.agent)) return "";
        return renderEnvironmentText(localRoot(context));
      } catch (error) {
        ctx.logger?.warn?.(`[kaz-environment] injection failed: ${String(error)}`);
        return "";
      }
    },
  });
}
