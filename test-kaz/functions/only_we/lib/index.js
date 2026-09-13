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
// 诊断（查完删）：每次装配落盘——我看到的段清单与下标、每个含第二人称的段（处数 + 样例）、
//   以及**替换后仍残留第二人称的段**。残留项说明该段在我处理之后才被追加或替换。

export const name = "only-we";

// 只用普通属性（on / logger），不碰服务：无需 inject。
export const inject = [];

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 只数不改 → false；真正执行替换 → true。 */
const APPLY_REPLACEMENT = true;

/** 诊断落盘（查完删）。 */
const TRACE_FILE = join(homedir(), ".dsh-test", "only-we-trace.log");

/** 第二人称的词形（顺序重要：长的先替换，避免 your→our 把 yours 弄坏）。 */
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

const SECOND_PERSON = /\b([Yy]ou|[Yy]our|yours|Yours|yourself|Yourself|yourselves|Yourselves)\b/;

/** 数一段文本里有多少个第二人称词。 */
function countSecondPerson(text) {
  let n = 0;
  for (const [re] of PAIRS) {
    const m = text.match(re);
    if (m !== null) n += m.length;
  }
  return n;
}

/** 执行替换。 */
function rewrite(text) {
  let out = text;
  for (const [re, to] of PAIRS) out = out.replace(re, to);
  return out;
}

/** 取一处样例，便于离线判读。 */
function sampleOf(text) {
  const m = SECOND_PERSON.exec(text);
  if (m === null) return "";
  const at = m.index;
  return text.slice(Math.max(0, at - 24), at + 34).replace(/\s+/g, " ");
}

export function apply(ctx) {
  ctx.on("system-prompt/assemble", (assembly, context, next) => {
    try {
      if (assembly === null || typeof assembly !== "object") return next();
      const lines = [];

      const allSections = Array.isArray(assembly.sections) ? assembly.sections : [];
      lines.push(`  SECTIONS(${allSections.length}): ` + allSections.map((s, i) => `${i}:${s?.name ?? "?"}`).join(", "));
      // 诊断：逐段打印 text 的实际形态（字符串/函数/其它）——一眼看出谁逃过了替换。
      lines.push(
        "  TYPES: " +
          allSections
            .map((s) => {
              if (s === null || typeof s !== "object") return "?";
              const t = typeof s.text;
              return `${s.name}=${t}${t === "string" ? `(${s.text.length})` : ""}`;
            })
            .join(", "),
      );
      // 诊断：把"不含第二人称的段"全文打出来——用来定位残留的 you 究竟住在哪一段。
      for (const s of allSections) {
        if (s === null || typeof s !== "object") continue;
        if (typeof s.text !== "string") continue;
        if (countSecondPerson(s.text) > 0) continue;
        lines.push(`  CLEAN ${s.name}(${s.text.length}): ${JSON.stringify(s.text)}`);
      }

      const walk = (list, label) => {
        if (!Array.isArray(list)) return;
        list.forEach((entry, index) => {
          if (entry === null || typeof entry !== "object") return;
          // text 有两种形态：静态字符串，或装配期才求值的函数（如 tool:read / context:file-reference）。
          // 函数必须**包装后回写**——保持"函数"这一形态，否则会改变平台对该段的处理方式。
          if (typeof entry.text === "function") {
            const original = entry.text;
            const value = original(context);
            const text = typeof value === "string" ? value : "";
            const before = countSecondPerson(text);
            if (before === 0) return;
            lines.push(`  ${label}[${index}] ${entry.name}: 函数型, ${before} 处 -> "${sampleOf(text)}"`);
            if (APPLY_REPLACEMENT) entry.text = (ctx2) => rewrite(original(ctx2));
            return;
          }
          if (typeof entry.text !== "string") {
            lines.push(`  ${label}[${index}] ${entry.name}: 未处理（text 是 ${typeof entry.text}）`);
            return;
          }
          const before = countSecondPerson(entry.text);
          if (before === 0) return;
          lines.push(`  ${label}[${index}] ${entry.name}: ${before} 处 -> "${sampleOf(entry.text)}"`);
          if (APPLY_REPLACEMENT) entry.text = rewrite(entry.text);
        });
      };
      walk(assembly.sections, "section");
      walk(assembly.contexts, "context");

      // 替换后再扫一遍：残留 = 该段在我处理之后才出现，或 text 本来不是字符串
      const leftovers = [];
      const scan = (list, label) => {
        if (!Array.isArray(list)) return;
        list.forEach((entry, index) => {
          if (entry === null || typeof entry !== "object" || typeof entry.text !== "string") return;
          const left = countSecondPerson(entry.text);
          if (left > 0) leftovers.push(`${label}[${index}] ${entry.name}: ${left} 处残留 -> "${sampleOf(entry.text)}"`);
        });
      };
      scan(assembly.sections, "section");
      scan(assembly.contexts, "context");
      if (leftovers.length > 0) lines.push("  LEFTOVERS:", ...leftovers.map((l) => "    " + l));

      appendFileSync(
        TRACE_FILE,
        `${new Date().toISOString()}\tmode=${APPLY_REPLACEMENT ? "REWRITE" : "COUNT-ONLY"}\trows=${lines.length}\n${lines.join("\n")}\n`,
      );
    } catch (error) {
      ctx.logger?.warn?.(`[only-we] failed: ${String(error)}`);
    }
    return next();
  });
}
