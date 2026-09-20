// kaz-shared —— 报错/回执里**有界回显**一个模型原始值。三条用途同源，所以放在共享层：
//   * ka-whale-workflow（写安排、派发回执）
//   * kaz-context-policy（context_search 的 companion）
//   * ka-whale-memory（记忆工具回显 name）
//
// 为什么放在 `kaz-shared/lib/` 下的**独立文件**、而不是并进 `kaz-shared/lib/index.js`：
// index.js 是"工具面门"那个插件本体（有 apply/inject），而且它自己 import 了
// `ka-whale-workflow/lib/stage-store.js` 与 `stages.js`。把它当公共工具入口的话，
// ka-whale-workflow → kaz-shared/index.js → ka-whale-workflow 就是一个环。
// 同目录的 `clamp-int.js` / `blacklists.js` / `roles.js` 已经是"共享层的叶子模块"这个形状，
// 本文件按同一形状加一个——所以三个插件 import 的是一条边，谁也不多绕一层。

/**
 * 回显模型原始值时的字符上限。
 *
 * 为什么必须有上界：写参数的是模型，它把一个字段写错位置时，值可能是几千到几万个字符
 * （实测形态：主代理把整段任务正文塞进 persona 数组的第二项、或把 5 万字的串当角色名）。
 * 原样回显，这段正文就整段进到它的上下文里，而它多半已经从别处收过一遍了——一次形状错误
 * 因此变成一次上下文事故。截断并写明省了多少，比原样回显更诚实：模型看到的是"值太长、被切了"，
 * 而不是"值就这么长"。
 */
export const ERROR_ECHO_MAX_CHARS = 200;

/**
 * 有界回显一个原始值：JSON 化（字符串带引号、其它值就是字面量），超长则截断并写明省了多少字符。
 *
 * **这是本预设里唯一允许回显模型原始值的地方。**任何新写的报错只要要印一个模型给的值，都必须过
 * 这一道——"这条一定很短"的历史判断已经错过三次：`ka-whale-workflow` 里先是 E6 的数组第二项、
 * 再是派发回执里的黑名单与角色名；然后是 `kaz-context-policy` 的 companion 与 `ka-whale-memory`
 * 的 name（两处各 5 万字，最后一轮才收）。
 *
 * `JSON.stringify` 会抛的两种值（BigInt、循环引用）走 `String(value)` 兜底：它们**到不了**这里
 * （工具的入参是 JSON 解析出来的，两个都构造不出来），但这个函数是导出的、会被复用到别处，
 * 一个"回显函数在回显时抛异常"的失败模式比回显得难看坏得多——抛出去会让整条报错路径变成
 * 一个未捕获异常。
 *
 * 被切的可能正好是**代理对的一半**：那样会产出孤立代理（显示成 U+FFFD，看起来像原值里本来就有
 * 乱码）。所以切点落在高位代理上时往前多让一个字符。
 *
 * @param {unknown} value - 要回显的值。
 * @returns {string} 有长度上界的回显文本：单次回显 ≤ 222 字。**有界是逐处的，不是逐条消息的**——
 *   一条派发回执最多同时拼进四个回显，见 ka-whale-workflow 的 fork-param.regression.mjs 5p。
 */
export function boundedShown(value) {
  let text;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  if (text.length <= ERROR_ECHO_MAX_CHARS) return text;
  const head = text.slice(0, ERROR_ECHO_MAX_CHARS - 1);
  const safe = /[\uD800-\uDBFF]$/u.test(head) ? head.slice(0, -1) : head;
  return `${safe}… (+${text.length - safe.length} more chars)`;
}
