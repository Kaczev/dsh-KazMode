// only_we —— 把组装好的系统提示词里的第二人称改成"我们"的口吻。
//
// 目标：提示词里所有面向 agent 的 you / your（含 You / Your 与常见缩写）统一成 we / our，
// 与预设 persona 的 "We are the user's point of contact…" 口径一致，
// 让模型始终沿着同一条 "We" 逻辑链推理。
//
// 时机：`system-prompt/assemble` 瀑布。它在**渲染前**拿到可变 assembly，
//   `kaz-system-prompt.mjs` 就是用这个钩子把 persona 段替换成 MAIN_PERSONA 的；
//   本插件排在它之后，看到的是已替换过的 persona 文本。
//   （平台对 `complete` 段会在瀑布后还原；本预设没有 complete 段。）
//
// text 有两种形态，**都必须处理，且必须保持原形态**：
//   * 静态字符串（多数官方段，如 tool:pwsh）：直接替换。
//   * 函数（装配期才求值者，如 tool:read / tool:glob / context:file-reference）：
//     包装成"调用原函数、对结果做替换"的新函数。**不能回写成字符串**——
//     那会改变平台对该段的处理方式（平台只对函数求值）。
//
// 边界：**改不到工具描述与 schema**（它们在 `assembly.tools`，另一条路）。本插件只管提示词正文。

export const name = "only-we";

// 只用普通属性（on / logger / systemPrompt 之外的引擎事件），不访问服务：无需 inject。
export const inject = [];

/** 第二人称的词形。顺序重要：长的先替换，避免 your→our 把 yours 弄坏。 */
const PAIRS = Object.freeze([
  [/\byourselves\b/g, "ourselves"],
  [/\bYourselves\b/g, "Ourselves"],
  [/\byourself\b/g, "ourself"],
  [/\bYourself\b/g, "Ourself"],
  [/\byours\b/g, "ours"],
  [/\bYours\b/g, "Ours"],
  [/\byour\b/g, "our"],
  [/\bYour\b/g, "Our"],
  [/\byou're\b/g, "we're"],
  [/\bYou're\b/g, "We're"],
  [/\byou've\b/g, "we've"],
  [/\bYou've\b/g, "We've"],
  [/\byou'll\b/g, "we'll"],
  [/\bYou'll\b/g, "We'll"],
  [/\byou'd\b/g, "we'd"],
  [/\bYou'd\b/g, "We'd"],
  [/\byou\b/g, "we"],
  [/\bYou\b/g, "We"],
]);

/** 执行替换。 */
function rewrite(text) {
  let out = text;
  for (const [re, to] of PAIRS) out = out.replace(re, to);
  return out;
}

/** 就地处理一个段/上下文数组：字符串直接改，函数包装后回写。 */
function rewriteEntries(list) {
  if (!Array.isArray(list)) return;
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    if (typeof entry.text === "function") {
      // 保持函数形态：每次装配由平台调用，返回替换后的文本。
      const original = entry.text;
      entry.text = (context) => {
        const value = original(context);
        return typeof value === "string" ? rewrite(value) : value;
      };
    } else if (typeof entry.text === "string") {
      entry.text = rewrite(entry.text);
    }
  }
}

export function apply(ctx) {
  ctx.on("system-prompt/assemble", (assembly, context, next) => {
    try {
      if (assembly !== null && typeof assembly === "object") {
        rewriteEntries(assembly.sections);
        rewriteEntries(assembly.contexts);
      }
    } catch (error) {
      // 替换失败不该让装配整体失败：报一声，交给原流程。
      ctx.logger?.warn?.(`[only-we] rewrite failed: ${String(error)}`);
    }
    return next();
  });
}
