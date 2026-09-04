// kaz-shared —— Kaz 6.0 Step 4 缓存/噪音验收指标（纯 ESM 模块，非 cordis 插件）
// ===========================================================================
// Step 4 (v0.4 §13 / C20) 需要可复现、可探针的指标口径：
//   - schema token：沿用 @deepseek-ai/dsh-token-meter 的固定密度启发式
//     （每 4 字符 1 token + 4 结构性 overhead），保证与 DSH 内部估计同源；
//   - 工具面变化次数：以 DSH request/header 的“工具名集合连续去重序列”为准；
//   - Task Surface 大小：展开后稳定请求头的工具数量；预算复审点对照
//     KAZ_BASE_TOOLS（设计 12 项初稿）。B5 后旧运行时 BASE_TOOLS/enable_tool 层已删除。
// 本模块只做纯计算，不读取会话文件；会话日志解析脚本位于 .dsh/step4/（不入库）。
// ===========================================================================

/** 固定文本密度（与 DSH token-meter estimate 一致）。 */
export const TOKEN_CHARS_PER_TOKEN = 4;
/** 结构性 overhead（与 DSH token-meter estimate 一致）。 */
export const TOKEN_BLOCK_OVERHEAD = 4;

/** 工具 schema 的固定密度 token 估计：ceil(JSON.stringify(tools).length / 4) + 4。
 *  @param tools request/header 里的完整工具数组（对象或字符串均可；估计按 JSON 长度）。
 */
export function estimateToolsSchemaTokens(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  return Math.ceil(JSON.stringify(tools).length / TOKEN_CHARS_PER_TOKEN) + TOKEN_BLOCK_OVERHEAD;
}

/** system 文本 token 估计：ceil(system.length / 4) + 4；空/缺失为 0。 */
export function estimateSystemTokens(system) {
  if (typeof system !== "string" || system.length === 0) return 0;
  return Math.ceil(system.length / TOKEN_CHARS_PER_TOKEN) + TOKEN_BLOCK_OVERHEAD;
}

/** header 总估计 = system tokens + tools tokens（与 dsh-token-meter 口径一致）。 */
export function estimateHeaderTokens(header) {
  if (header === null || typeof header !== "object") return 0;
  return estimateSystemTokens(header.system) + estimateToolsSchemaTokens(header.tools);
}

/** 从 request/header 工具数组提取去重、保序的工具名列表。 */
export function toolNamesOfHeader(tools) {
  const seen = new Set();
  const out = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    const name = typeof tool === "string" ? tool : tool?.name;
    if (typeof name !== "string" || name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** 工具面快照（纯计算）：连续 request/header 中“工具名集合不变”的相邻请求合并。
 *  @returns [{ seq, tools, count, signature, schemaTokens, systemTokens }]
 */
export function surfaceSnapshots(headers) {
  const out = [];
  for (const entry of Array.isArray(headers) ? headers : []) {
    if (entry === null || typeof entry !== "object") continue;
    const seq = typeof entry.seq === "number" ? entry.seq : null;
    const tools = Array.isArray(entry.tools) ? toolNamesOfHeader(entry.tools) : toolNamesOfHeader(entry);
    const signature = tools.join(",");
    const last = out.at(-1);
    if (last !== undefined && last.signature === signature) continue;
    out.push({
      seq,
      tools,
      count: tools.length,
      signature,
      schemaTokens: estimateToolsSchemaTokens(entry.tools ?? tools),
      systemTokens: estimateSystemTokens(entry.system),
    });
  }
  return out;
}

/** 工具面变化次数 = 连续去重后的快照数 - 1（首轮极简前的初始快照不计变化）。
 *  @param headers request/header 数组（按 seq/时间排序）
 */
export function surfaceTransitionCount(headers) {
  const snapshots = surfaceSnapshots(headers);
  return snapshots.length > 0 ? snapshots.length - 1 : 0;
}

/** Task Surface 大小与预算复审点（纯函数）。
 *  @param options { taskSurfaceTools, kazBaseTools=KAZ_BASE_TOOLS, runtimeBaseTools, memoryEnabled }
 *  runtimeBaseTools 是历史兼容参数（B5 后不再有 enable_tool 运行时基础面）。
 *  返回 { taskSurfaceCount, kazBaseToolsCount, runtimeBaseToolsCount, reviewPoint }
 */
export function budgetReviewPoint({ taskSurfaceTools, kazBaseTools, runtimeBaseTools, memoryEnabled = false } = {}) {
  const taskSurfaceCount = Array.isArray(taskSurfaceTools) ? new Set(taskSurfaceTools).size : (typeof taskSurfaceTools === "number" ? taskSurfaceTools : 0);
  const kazBaseToolsCount = Array.isArray(kazBaseTools) ? kazBaseTools.length : 0;
  const runtimeBaseToolsCount = Array.isArray(runtimeBaseTools) ? runtimeBaseTools.length : 0;
  const memorySuffix = memoryEnabled === true ? " + memory read tools" : "";
  const reviewPoint =
    `Task Surface=${taskSurfaceCount}; KAZ_BASE_TOOLS design=${kazBaseToolsCount}; ` +
    `runtime BASE_TOOLS=${runtimeBaseToolsCount}${memorySuffix}; ` +
    `assigned budget: >6 warn / >8 reject (v0.9)`;
  return {
    taskSurfaceCount,
    kazBaseToolsCount,
    runtimeBaseToolsCount,
    memoryEnabled: memoryEnabled === true,
    reviewPoint,
  };
}
