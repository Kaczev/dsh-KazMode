// kaz-shared —— Kaz 8.0 三角色工具面黑名单的唯一事实源。对应《Kaz8.0设计.md》§二。
//
// 规则：
//   * 黑名单里的工具不出现在该角色模型的工具面上；调用即报错。
//   * 只有黑名单，没有白名单——黑名单之外剩下什么就是什么。
//   * 保留集（RESERVED_TOOLS）是"任何黑名单都挡不掉"的名单：上下文四件 + 记忆只读三件 +
//     list_agents + get_arrangement。所以管家虽然黑名单里有东西，仍看得见 get_arrangement。

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
  "send_message",
  "interrupt_agent",
  "ka_sub_whale",
  "whale_report",
  "write_arrangement",
]);

/** 保留集（普通子代理）：黑名单挡不掉的工具（§2.3）——上下文四件 + 记忆只读三件 + list_agents + get_arrangement。 */
export const RESERVED_TOOLS = Object.freeze([
  "context_hotspots",
  "context_compress",
  "context_search",
  "context_read",
  "memory_search",
  "memory_detail",
  "memory_list",
  "list_agents",
  "get_arrangement",
]);

/**
 * 保留集（记忆管理子代理）：上下文四件 + 记忆六件全部（§2.2）——管家要读写记忆，也要能看安排。
 */
export const MEMORY_MAINTAINER_RESERVED = Object.freeze([
  ...RESERVED_TOOLS,
  "memory_save",
  "memory_update",
  "memory_forget",
]);

/** 子代理默认黑名单（§2.3）：不参与编排、不碰工作流、不写记忆；主代理派发时可在其上追加。 */
export const SUBAGENT_DEFAULT_BLACKLIST = Object.freeze([
  "send_message",
  "interrupt_agent",
  "ka_sub_whale",
  "write_arrangement",
  "whale_report",
  "memory_save",
  "memory_update",
  "memory_forget",
  "ask_user_question"
]);

/**
 * AI slop 清理子代理黑名单：在普通子代理默认之上，再挡掉"替主代理做决定"的两件——
 * 直接问用户、以及把某个东西交给用户看。它的活是只读地查、必要时改、然后回报；
 * 要不要问用户、要不要出面交付，是主代理的事。写类工具（read / glob / grep / pwsh / write / edit）
 * 有意**不挡**：它必须能读整份文件、能跑项目的检查与探针、能在证明得动的前提下动手改。
 */
export const SLOP_CLEANER_BLACKLIST = Object.freeze([
  ...SUBAGENT_DEFAULT_BLACKLIST,
  "present",
]);

/**
 * 保留集（AI slop 清理子代理）：**不含 `get_arrangement`**。
 *
 * 为什么单独一套而不是直接引用 RESERVED_TOOLS：清理者事实上看不到主代理的安排。`tools.js` 里
 * 清理者有**自己的分支**（`isCleaner` 那一路），用的是这个常量；而 `get_arrangement` 是主代理与
 * 管家的东西，没有传给清理者。早先这里写 `= RESERVED_TOOLS`，等于注释宣称它有这件工具而没有——
 * 注释与事实相反，正是本轮主题。
 *
 * 这个常量的**含义**要说清：它表示"清理者拥有、因而黑名单不许把它挡掉"的工具，不是"它一定看得见"。
 * 派发时真正生效的黑名单是 SLOP_CLEANER_BLACKLIST 减去保留集，逐字发给平台。
 */
export const SLOP_CLEANER_RESERVED = Object.freeze(RESERVED_TOOLS.filter((name) => name !== "get_arrangement"));

/**
 * 同时在**运行**的直系子代理上限。**限制的是"此刻有几个在跑"，不是"计划里写几条"**——
 * 主代理可以错开时间派：先派 3 个，等回来再派下一批，计划写多少条都不受这条约束。
 *
 * 口径（与实现逐字一致，别写成"活着/live"）：数的是活体注册表里 status === "running" 的孩子。
 * 已加载但停在两步之间的（idle）**不占名额**——那种可以直接 send_message 接着用。
 *
 * 执行点：`kaSubWhaleTool.execute` 在"复用不成、准备新开"之前数一次；
 * 数满即拒绝并说明原因。复用（把任务交给一个已有的空闲孩子）**不算新增，不受此限**。
 * 说明文字在 kaz-shared/lib/roles.js（MAIN_PERSONA）与 ka-whale-workflow/lib/stages.js。
 */
export const MAX_CONCURRENT_SUBAGENTS = 5;

/** 上限的模型面理由（工具拒绝时原样回给模型，避免它只知道被拒、不知道为什么）。 */
export const CONCURRENCY_CAP_REASON =
  `at most ${MAX_CONCURRENT_SUBAGENTS} subagents may be RUNNING at once: each report you have to hold at the same time costs attention, and past a handful the parallel round stops being cheaper than doing the work in sequence. A subagent that is loaded but between turns is not running and does not use a slot - send it a message instead of starting another. Queue the rest and dispatch them as the running ones settle.`;

/**
 * 清洗一份黑名单：去掉保留集、非字符串、空白与重复项。
 * 子代理与记忆管理员的黑名单在派发前都要过这一道。
 * @param {unknown} names - 原始黑名单。
 * @param {readonly string[]} [reserved] - 保留集（默认普通子代理那套）。
 * @returns {string[]} 清洗后的黑名单。
 */
export function sanitizeBlacklist(names, reserved = RESERVED_TOOLS) {
  const out = [];
  for (const name of Array.isArray(names) ? names : []) {
    if (typeof name !== "string") continue;
    const trimmed = name.trim();
    if (trimmed.length === 0) continue;
    if (reserved.includes(trimmed)) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}
