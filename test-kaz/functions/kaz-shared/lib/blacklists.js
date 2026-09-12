// kaz-shared —— Kaz 8.0 三角色工具面黑名单的唯一事实源。对应《Kaz8.0设计.md》§二。
//
// 规则：
//   * 黑名单里的工具不出现在该角色模型的工具面上；调用即报错。
//   * 只有黑名单，没有白名单——黑名单之外剩下什么就是什么。
//   * 三个 context 工具是保留集：任何黑名单都不能挡掉它们。

/** 主代理黑名单：写记忆三件不可见（写操作全部交给 memoryMaintainer）。设计稿 §2.1。 */
export const MAIN_BLACKLIST = Object.freeze(["memory_save", "memory_update", "memory_forget"]);

/** 记忆管理子代理黑名单（点名列出）。设计稿 §2.2。 */
export const MEMORY_MAINTAINER_BLACKLIST = Object.freeze([
  "pwsh",
  "write",
  "edit",
  "todo_write",
  "ask_user_question",
  "web_search",
  "web_fetch",
  "job_output",
  "job_list",
  "job_kill",
  "skill",
  "present",
  "list_agents",
  "send_message",
  "interrupt_agent",
  "ka_sub_whale",
  "whale_report",
  "write-arrangement",
  "get-arrangement",
]);

/** 保留集：黑名单挡不掉的工具（§2.2 / §2.3 的"必须保留"）。 */
export const RESERVED_TOOLS = Object.freeze([
  "context_compress",
  "context_search",
  "context_read",
]);

/** 子代理默认黑名单（§2.3）：不参与编排、不碰工作流、不写记忆；主代理派发时可在其上追加。 */
export const SUBAGENT_DEFAULT_BLACKLIST = Object.freeze([
  "send_message",
  "interrupt_agent",
  "ka_sub_whale",
  "write-arrangement",
  "whale_report",
  "memory_save",
  "memory_update",
  "memory_forget",
]);

/**
 * 清洗一份黑名单：去掉保留集、非字符串、空白与重复项。
 * 子代理与记忆管理员的黑名单在派发前都要过这一道。
 * @param {unknown} names - 原始黑名单。
 * @returns {string[]} 清洗后的黑名单。
 */
export function sanitizeBlacklist(names) {
  const out = [];
  for (const name of Array.isArray(names) ? names : []) {
    if (typeof name !== "string") continue;
    const trimmed = name.trim();
    if (trimmed.length === 0) continue;
    if (RESERVED_TOOLS.includes(trimmed)) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}
