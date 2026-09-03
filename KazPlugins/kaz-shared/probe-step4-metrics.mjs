// kaz-shared Step 4 探针：缓存/噪音验收指标的纯函数层。
// 覆盖：
//   - schema token 估计与 DSH token-meter 固定密度口径一致；
//   - request/header 工具面去重快照、变化次数；
//   - Task Surface 大小 / KAZ_BASE_TOOLS 预算复审点可计算。
// 运行：node KazPlugins/kaz-shared/probe-step4-metrics.mjs
import {
  TOKEN_CHARS_PER_TOKEN,
  TOKEN_BLOCK_OVERHEAD,
  estimateToolsSchemaTokens,
  estimateSystemTokens,
  estimateHeaderTokens,
  toolNamesOfHeader,
  surfaceSnapshots,
  surfaceTransitionCount,
  budgetReviewPoint,
} from "./lib/step4-metrics.js";

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

const simpleTools = [
  { name: "read", description: "read a file", parameters: { type: "object", properties: {} } },
  { name: "write", description: "write a file", parameters: { type: "object", properties: {} } },
];
const expected = Math.ceil(JSON.stringify(simpleTools).length / TOKEN_CHARS_PER_TOKEN) + TOKEN_BLOCK_OVERHEAD;
check("① schema token 估计 = ceil(JSON/4)+4", estimateToolsSchemaTokens(simpleTools) === expected);
check("① 空/缺失工具返回 0", estimateToolsSchemaTokens([]) === 0 && estimateToolsSchemaTokens(undefined) === 0);
const sysExpected = Math.ceil("system text".length / TOKEN_CHARS_PER_TOKEN) + TOKEN_BLOCK_OVERHEAD;
check("① system token 估计", estimateSystemTokens("system text") === sysExpected && estimateSystemTokens("") === 0);
check("① header 估计 = system+tools", estimateHeaderTokens({ system: "sys", tools: simpleTools }) === estimateSystemTokens("sys") + estimateToolsSchemaTokens(simpleTools));

const headers = [
  { seq: 1, tools: [{ name: "memory_search" }], system: "s0" },
  { seq: 2, tools: [{ name: "memory_search" }], system: "s0" },
  { seq: 3, tools: [{ name: "read" }, { name: "pwsh" }], system: "s1" },
  { seq: 4, tools: [{ name: "read" }, { name: "pwsh" }], system: "s1" },
  { seq: 5, tools: [{ name: "read" }, { name: "pwsh" }], system: "s2" },
];
const snaps = surfaceSnapshots(headers);
check("② 连续相同工具面合并、system 变化不拆分快照", snaps.length === 2 && snaps[0].count === 1 && snaps[1].count === 2);
check("② toolNamesOfHeader 去重保序", JSON.stringify(toolNamesOfHeader([{ name: "b" }, "a", "b"])) === JSON.stringify(["b", "a"]));
check("② surfaceTransitionCount(2 个不同面)=1", surfaceTransitionCount(headers) === 1);
const fourPhase = [
  { seq: 1, tools: [{ name: "memory_search" }] },
  { seq: 2, tools: ["ask_user_question", "glob", "whale_report"] },
  { seq: 3, tools: [{ name: "whale_report" }] },
  { seq: 4, tools: ["read", "pwsh", "write"] },
];
check("② Kaz 当前四阶段示例变化次数=3", surfaceTransitionCount(fourPhase) === 3);

const review = budgetReviewPoint({
  taskSurfaceTools: ["read", "pwsh", "safe_json_write"],
  kazBaseTools: ["read", "pwsh"],
  runtimeBaseTools: ["read", "pwsh", "todo_write"],
  memoryEnabled: true,
});
check("③ budgetReviewPoint 返回计数与复审点", review.taskSurfaceCount === 3 && review.kazBaseToolsCount === 2 && review.runtimeBaseToolsCount === 3 && review.memoryEnabled === true && typeof review.reviewPoint === "string" && review.reviewPoint.includes("KAZ_BASE_TOOLS"));
check("③ budgetReviewPoint 无输入不抛错", typeof budgetReviewPoint({}).reviewPoint === "string");

console.log(failures === 0 ? "\nSTEP4-METRICS PROBE OK" : `\nSTEP4-METRICS PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
