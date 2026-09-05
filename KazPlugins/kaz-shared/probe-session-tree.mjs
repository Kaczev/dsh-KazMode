// kaz-shared 探针：Kaz7.0 M1 纯 ESM 树形会话模型（lib/session-tree.js）。
// ===========================================================================
// 依据：不入库文件/Kaz7.0更新规划/Kaz7.0-M1树形会话模型设计报告.md
// 覆盖：
//   A1  leaf / level1(round) / level2(planItem) / level3(goal) / level4+(sublimed)
//       在“多回合、多 planItem、多 Goal”合成会话中层级正确；
//   A2  append 只产生 leaf；无显式边界不自动 close；
//   A3  round/planItem/goal 显式 close 生成对应 closed block；
//   A4  同一父容器可混合多级 closed block + 当前未闭合 leaf；
//   A5  render 只含最外层 block 描述 + 当前未闭合原信息；
//   A6  渲染顺序：高层→低层、同层老→新、原信息最后；renderOrderValid true；
//   A7  同输入两次 render 逐条目一致；
//   A8  N=4：3 个同层兄弟不升华，第 4 个闭合后生成父块；
//   A9  增量语义：追加不影响已落定 summary/fingerprint，未变子树保持对象引用；
//   A10 不接 DSH 运行时：直接命名空间无 cordis/注册/注入/改写导出；
//   A11 无 token 预算：无 MC/token/budget/trigger 导出，树节点无 token 字段；
//   A12 不实现持久化/归档/whale_expand 工具导出；
//   A13 与 context-compress.js 共享常量，不复制为 session-tree 自己的导出；
//   A14 按 kaz-shared probe 约定（根目录、PASS/FAIL、退出码、SESSION-TREE PROBE OK）。
// 冻结决策：
//   - open 只允许严格更小 level 嵌套（round < planItem < goal）；
//   - close 强制 LIFO，只能先闭合最内层 open scope；
//   - close/promote 必须提供非空 summary；
//   - 自动升华 = 同一容器的“最老连续同层 closed 兄弟组”，每组恰好取前 N 个；
//   - render 顺序与 context-compress.renderOrderValid 对齐。
// 运行：node KazPlugins/kaz-shared/probe-session-tree.mjs
// ===========================================================================

import {
  createSession,
  append,
  open,
  close,
  promote,
  render,
} from "./lib/session-tree.js";
import {
  SUBLIMATION_THRESHOLD,
  KAZ_CONTEXT_RENDER_ORDER,
  renderOrderValid,
} from "./lib/context-compress.js";

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

// ---------------------------------------------------------------------------
// 小型纯测试工具：坏输入返回 { error }，好输入返回 { session, changes }。
// ---------------------------------------------------------------------------
function run(result) {
  if (result?.error) {
    throw new Error(`unexpected error ${result.error.code}: ${result.error.message}`);
  }
  return result;
}

function opened(session, level, boundary, id) {
  return run(open(session, { level, boundary, id })).session;
}

function appended(session, kind, content) {
  return run(append(session, { kind, content })).session;
}

function closed(session, summary, extra = {}) {
  return run(close(session, { summary, ...extra }));
}

function collectNodes(session) {
  const nodes = [];
  const walk = (children) => {
    for (const node of children) {
      if (!node || typeof node !== "object") continue;
      nodes.push(node);
      if (node.children) walk(node.children);
    }
  };
  walk(session.rootChildren);
  return nodes;
}

function leaves(session) {
  return collectNodes(session).filter((node) => node.nodeType === "leaf");
}

function blocks(session) {
  return collectNodes(session).filter((node) => node.nodeType === "block");
}

function blocksByLevel(session, level) {
  return blocks(session).filter((node) => node.level === level);
}

function noTokenFields(session) {
  const forbidden = /token|budget|mc_|trigger/i;
  return collectNodes(session).every(
    (node) => !Object.keys(node).some((key) => forbidden.test(key)),
  );
}

function closeRootRound(session, id, summary) {
  const s1 = opened(session, 1, "round", id);
  const s2 = appended(s1, "user", `u:${id}`);
  return closed(s2, summary);
}

// ---------------------------------------------------------------------------
// ① A1/A3：多回合、多 planItem、多 Goal 合成会话 → level1/2/3，第 4 个 Goal
//    close 后自动升华出 level4；同时覆盖 round/planItem/goal 显式 close。
// ---------------------------------------------------------------------------
let s = run(createSession({ id: "multi-level" })).session;
let fourthChanges = null;
for (let g = 1; g <= 4; g += 1) {
  s = opened(s, 3, "goal", `goal-${g}`);
  for (let p = 1; p <= 2; p += 1) {
    s = opened(s, 2, "planItem", `goal-${g}-pi-${p}`);
    for (let t = 1; t <= 2; t += 1) {
      s = opened(s, 1, "round", `goal-${g}-pi-${p}-r-${t}`);
      s = appended(s, "user", `user ${g}/${p}/${t}`);
      s = appended(s, "assistant", `assistant ${g}/${p}/${t}`);
      s = closed(s, `round summary ${g}/${p}/${t}`).session;
    }
    s = closed(s, `planItem summary ${g}/${p}`).session;
  }
  const goalResult = closed(s, `goal summary ${g}`);
  s = goalResult.session;
  if (g === 4) fourthChanges = goalResult.changes;
}

const allBlocks = blocks(s);
check(
  "① A1 多回合/多 planItem/多 Goal 后 leaf=32、level1=16、level2=8、level3=4、level4=1",
  leaves(s).length === 32 &&
    blocksByLevel(s, 1).length === 16 &&
    blocksByLevel(s, 2).length === 8 &&
    blocksByLevel(s, 3).length === 4 &&
    blocksByLevel(s, 4).length === 1,
);
check(
  "① A1 层级单调：level2 children 只含 level1/leaf，level3 只含 level2，level4 只含 level3",
  blocksByLevel(s, 2).every((b) => b.children.every((c) => c.nodeType === "leaf" || c.level < 2)) &&
    blocksByLevel(s, 3).every((b) => b.children.every((c) => c.level < 3)) &&
    blocksByLevel(s, 4).every((b) => b.children.every((c) => c.level < 4)),
);
check(
  "① A3 round/planItem/goal 显式 close 生成 closed block 且 boundary 正确",
  blocksByLevel(s, 1).every((b) => b.boundary === "round" && b.state === "closed" && typeof b.summary === "string" && Array.isArray(b.summarySourceIds)) &&
    blocksByLevel(s, 2).every((b) => b.boundary === "planItem" && b.state === "closed") &&
    blocksByLevel(s, 3).every((b) => b.boundary === "goal" && b.state === "closed") &&
    blocksByLevel(s, 4).every((b) => b.boundary === "sublimed" && b.state === "closed"),
);
check(
  "① A1/A8 第 4 个 Goal close 自动升华 changes 含 sublime 且生成 level4 父块",
  Array.isArray(fourthChanges) &&
    fourthChanges.some((change) => change.type === "sublime" && change.level === 4),
);

// ---------------------------------------------------------------------------
// ② A2：append 只产生 leaf；无显式边界不自动 close。
// ---------------------------------------------------------------------------
s = run(createSession({ id: "raw-only" })).session;
s = appended(s, "user", "u1");
s = appended(s, "assistant", "a1");
s = appended(s, "tool", { name: "read", ok: true });
const rawRender = run(render(s));
check(
  "② A2 无显式边界时 rootChildren 全是 leaf，无 scope/block，render 全为 current-unclosed-raw",
  s.rootChildren.every((node) => node.nodeType === "leaf") &&
    rawRender.entries.every((entry) => entry.kind === "current-unclosed-raw") &&
    rawRender.stats.outermostBlockCount === 0 &&
    rawRender.stats.currentRawCount === 3,
);

// ---------------------------------------------------------------------------
// ③ A4/A5/A6/A7：同父混合多级 closed block + 未闭合 leaf；render 只输出最外层。
// ---------------------------------------------------------------------------
s = run(createSession({ id: "mixed-root" })).session;
s = opened(s, 1, "round", "mixed-round");
s = appended(s, "user", "hidden-round-raw");
s = closed(s, "mixed round summary").session;
s = opened(s, 3, "goal", "mixed-goal");
s = appended(s, "user", "hidden-goal-raw");
s = closed(s, "mixed goal summary").session;
s = opened(s, 2, "planItem", "mixed-plan");
s = appended(s, "user", "hidden-plan-raw");
s = closed(s, "mixed plan summary").session;
s = appended(s, "user", "visible-root-raw");

const mixedRender1 = run(render(s, { mode: "text" }));
const mixedRender2 = run(render(s, { mode: "text" }));
const mixedText1 = mixedRender1.text;
const mixedBlockIds = mixedRender1.entries
  .filter((entry) => entry.kind === "block")
  .map((entry) => entry.id);
const mixedRawIds = mixedRender1.entries
  .filter((entry) => entry.kind === "current-unclosed-raw")
  .map((entry) => entry.id);
check(
  "③ A4 同一根容器可混合 level1/2/3 closed block + 当前未闭合 leaf",
  s.rootChildren.filter((node) => node.nodeType === "block").map((node) => node.level).sort((a, b) => a - b).join(",") === "1,2,3" &&
    s.rootChildren.some((node) => node.nodeType === "leaf" && node.id === mixedRawIds[0]),
);
check(
  "③ A5 render 只含最外层 block 描述 + 未闭合 raw，不含 closed block 内部原信息",
  mixedBlockIds.join(",") === "mixed-goal,mixed-plan,mixed-round" &&
    mixedRawIds.length === 1 &&
    mixedRender1.stats.outermostBlockCount === 3 &&
    mixedRender1.stats.currentRawCount === 1 &&
    typeof mixedText1 === "string" &&
    !mixedText1.includes("hidden-round-raw") &&
    !mixedText1.includes("hidden-goal-raw") &&
    !mixedText1.includes("hidden-plan-raw") &&
    mixedText1.includes("visible-root-raw"),
);
check(
  "③ A6 渲染顺序：高层→低层、同层老→新、原信息最后；renderOrderValid true",
  mixedBlockIds.join(",") === "mixed-goal,mixed-plan,mixed-round" &&
    mixedRender1.entries[mixedRender1.entries.length - 1]?.kind === "current-unclosed-raw" &&
    mixedRender1.orderValid === true &&
    renderOrderValid(mixedRender1.entries) === true,
);
check(
  "③ A6 同层老→新：三个先后闭合的 level1 块顺序不因渲染重排",
  (() => {
    let r = run(createSession({ id: "same-level" })).session;
    const ids = ["same-1", "same-2", "same-3"];
    for (const id of ids) {
      const closedRes = closeRootRound(r, id, `${id} summary`);
      r = closedRes.session;
    }
    r = appended(r, "user", "tail-raw");
    const rr = run(render(r));
    return (
      rr.entries.filter((entry) => entry.kind === "block").map((entry) => entry.id).join(",") === "same-1,same-2,same-3" &&
      rr.entries.at(-1)?.kind === "current-unclosed-raw" &&
      rr.orderValid === true
    );
  })(),
);
check(
  "③ A7 同输入两次 render 逐 token/逐条目一致且不修改 session",
  JSON.stringify(mixedRender1.entries) === JSON.stringify(mixedRender2.entries) &&
    mixedRender1.text === mixedRender2.text &&
    mixedRender1.orderValid === mixedRender2.orderValid &&
    JSON.stringify(mixedRender1.stats) === JSON.stringify(mixedRender2.stats) &&
    JSON.stringify(s) === JSON.stringify(mixedRender1.session),
);

// ---------------------------------------------------------------------------
// ④ A8：N=4 唯一升华阈值 —— 3 个兄弟不升华，第 4 个 close 后自动升华。
// ---------------------------------------------------------------------------
s = run(createSession({ id: "threshold" })).session;
let lastCloseChanges = null;
for (let i = 1; i <= 4; i += 1) {
  const result = closeRootRound(s, `round-${i}`, `round ${i} summary`);
  s = result.session;
  lastCloseChanges = result.changes;
  if (i === 3) {
    check(
      "④ A8 3 个同层 closed 兄弟不升华（rootChildren 无 level2 父块）",
      s.rootChildren.length === 3 &&
        s.rootChildren.every((node) => node.nodeType === "block" && node.level === 1) &&
        blocksByLevel(s, 2).length === 0,
    );
  }
}
check(
  "④ A8 第 4 个 close 触发自动升华：生成 level2 sublimed 父块并收起 4 个 level1",
  s.rootChildren.length === 1 &&
    s.rootChildren[0].nodeType === "block" &&
    s.rootChildren[0].level === 2 &&
    s.rootChildren[0].boundary === "sublimed" &&
    s.rootChildren[0].children.length === 4 &&
    Array.isArray(lastCloseChanges) &&
    lastCloseChanges.some((change) => change.type === "sublime" && change.level === 2),
);
check(
  "④ A8/13 升华数量阈值只引用 context-compress：SUBLIMATION_THRESHOLD=4 且行为与其一致",
  SUBLIMATION_THRESHOLD === 4 &&
    s.rootChildren.length === 1 &&
    s.rootChildren[0].level === 2 &&
    blocksByLevel(s, 2).length === 1,
);

// ---------------------------------------------------------------------------
// ⑤ 冻结决策：open 严格递减嵌套；close 必须 LIFO；summary 必填。
// ---------------------------------------------------------------------------
s = run(createSession({ id: "nesting" })).session;
s = opened(s, 3, "goal", "goal-nest");
const openSameGoal = open(s, { level: 3, boundary: "goal", id: "bad-goal" });
s = opened(s, 2, "planItem", "plan-nest");
const openSamePlan = open(s, { level: 2, boundary: "planItem", id: "bad-plan" });
s = opened(s, 1, "round", "round-nest");
const openHigher = open(s, { level: 2, boundary: "planItem", id: "bad-higher" });
check(
  "⑤ 嵌套规则：open 禁止同级或更高层 scope，只允许 level 严格更小",
  openSameGoal.error?.code === "scope-level-violation" &&
    openSamePlan.error?.code === "scope-level-violation" &&
    openHigher.error?.code === "scope-level-violation",
);

s = run(createSession({ id: "lifo" })).session;
s = opened(s, 3, "goal", "lifo-goal");
s = opened(s, 2, "planItem", "lifo-plan");
const closeOuterEarly = close(
  s,
  { summary: "goal too early", scopeId: "lifo-goal" },
);
const closeBoundaryMismatch = close(
  s,
  { summary: "plan summary", boundary: "goal" },
);
check(
  "⑤ LIFO：内层 open scope 未 close 时不能 close 外层/错 boundary",
  closeOuterEarly.error?.code === "scope-mismatch" &&
    closeBoundaryMismatch.error?.code === "boundary-mismatch",
);

s = run(createSession({ id: "summary-required" })).session;
s = opened(s, 1, "round", "summary-round");
s = appended(s, "user", "u");
const closeNoSummary = close(s, {});
const closeEmptySummary = close(s, { summary: "   " });
check(
  "⑤ close summary 必填：缺省/空白 summary 返回 summary-required",
  closeNoSummary.error?.code === "summary-required" &&
    closeEmptySummary.error?.code === "summary-required",
);

// 用三个已闭合 level1 兄弟验证 promote 的 summary 必填 / 阈值前置条件。
s = run(createSession({ id: "promote-required" })).session;
for (let i = 1; i <= 3; i += 1) {
  s = closeRootRound(s, `pro-${i}`, `pro ${i} summary`).session;
}
const promoteNoSummary = promote(
  s,
  { siblingIds: ["pro-1", "pro-2", "pro-3"] },
);
const promoteTooFew = promote(
  s,
  { siblingIds: ["pro-1", "pro-2", "pro-3"], summary: "x" },
);
check(
  "⑤ promote summary 必填且受 N=4 阈值约束",
  promoteNoSummary.error?.code === "summary-required" &&
    promoteTooFew.error?.code === "below-sublimation-threshold",
);

// ---------------------------------------------------------------------------
// ⑥ 冻结决策：自动升华“最老连续组”——5 个同层兄弟先取最老 4 个，
//    余下 1 个等待下一组凑满 4 个后形成第二个父块。
// ---------------------------------------------------------------------------
s = run(createSession({ id: "oldest-run" })).session;
for (let i = 1; i <= 5; i += 1) {
  const result = closeRootRound(s, `old-${i}`, `old ${i} summary`);
  s = result.session;
}
check(
  "⑥ 5 个同层兄弟只升华最老连续 4 个，第 5 个保留在根序列等待下一组",
  s.rootChildren.length === 2 &&
    s.rootChildren[0].nodeType === "block" &&
    s.rootChildren[0].level === 2 &&
    s.rootChildren[0].boundary === "sublimed" &&
    s.rootChildren[0].children.map((b) => b.id).join(",") === "old-1,old-2,old-3,old-4" &&
    s.rootChildren[1].nodeType === "block" &&
    s.rootChildren[1].level === 1 &&
    s.rootChildren[1].id === "old-5",
);
for (let i = 6; i <= 8; i += 1) {
  const result = closeRootRound(s, `old-${i}`, `old ${i} summary`);
  s = result.session;
}
check(
  "⑥ 后续 3 个与旧的第 5 个凑满 4 个后升华成第二个父块（old-5..old-8）",
  s.rootChildren.length === 2 &&
    s.rootChildren[0].children.map((b) => b.id).join(",") === "old-1,old-2,old-3,old-4" &&
    s.rootChildren[1].children.map((b) => b.id).join(",") === "old-5,old-6,old-7,old-8",
);

// ---------------------------------------------------------------------------
// ⑦ A9：追加不影响已落定块 —— 对象引用、summary、fingerprint、children 不变。
// ---------------------------------------------------------------------------
s = run(createSession({ id: "append-settled" })).session;
s = opened(s, 1, "round", "settled-round");
s = appended(s, "user", "inside settled");
s = closed(s, "settled summary").session;
const settledBefore = s.rootChildren[0];
const fingerprintBefore = settledBefore.fingerprint;
const summaryBefore = settledBefore.summary;
const childIdsBefore = settledBefore.children.map((child) => child.id).join(",");
s = appended(s, "user", "new root raw");
const settledAfter = s.rootChildren.find((node) => node.id === "settled-round");
check(
  "⑦ A9 append 不重写已落定块：引用不变，summary/fingerprint/children 不变",
  settledAfter === settledBefore &&
    settledAfter.summary === summaryBefore &&
    settledAfter.fingerprint === fingerprintBefore &&
    settledAfter.children.map((child) => child.id).join(",") === childIdsBefore &&
    s.rootChildren.some((node) => node.nodeType === "leaf" && node.content === "new root raw"),
);

// ---------------------------------------------------------------------------
// ⑧ A10/A11/A12/A13：导出面冻结 —— 无运行时注册、无 token 预算、无持久化/
//    whale_expand，共享常量不复制，公共出口齐全。
// ---------------------------------------------------------------------------
const directNs = await import("./lib/session-tree.js");
const publicNs = await import("./lib/tool-lists.js");

const EXPECTED_SESSION_TREE_EXPORTS = [
  "createSession",
  "append",
  "open",
  "close",
  "promote",
  "render",
];
const DELETED_BUDGET_EXPORTS = [
  "MC_trigger",
  "MC_emergency",
  "MC_expand",
  "RawTailBudget",
  "OuterResidentBudget",
];
const FORBIDDEN_RUNTIME_EXPORTS = [
  "register",
  "unregister",
  "cordis",
  "inject",
  "whale_expand",
  "persist",
  "archive",
  "loadSession",
  "saveSession",
];
const FORBIDDEN_DUPLICATE_CONSTANT_EXPORTS = [
  "SUBLIMATION_THRESHOLD",
  "KAZ_CONTEXT_RENDER_ORDER",
  "renderOrderValid",
  "SESSION_TREE_SUBLIMATION_THRESHOLD",
];

check(
  "⑧ A10/A12 直接命名空间只导出六个纯函数，无 cordis/注册/注入/持久化/whale_expand",
  EXPECTED_SESSION_TREE_EXPORTS.every((name) => Object.prototype.hasOwnProperty.call(directNs, name)) &&
    Object.keys(directNs).length === EXPECTED_SESSION_TREE_EXPORTS.length &&
    FORBIDDEN_RUNTIME_EXPORTS.every((name) => !Object.prototype.hasOwnProperty.call(directNs, name)),
);
check(
  "⑧ A11 session-tree 直接命名空间与公共出口都不含已删除 token 触发/保留预算导出",
  DELETED_BUDGET_EXPORTS.every((name) => !Object.prototype.hasOwnProperty.call(directNs, name)) &&
    DELETED_BUDGET_EXPORTS.every((name) => !Object.prototype.hasOwnProperty.call(publicNs, name)) &&
    !Object.keys(directNs).some((name) => /token|budget|mc_|trigger/i.test(name)),
);
let tokenFree = run(createSession({ id: "token-free" })).session;
tokenFree = opened(tokenFree, 1, "round", "tf-round");
tokenFree = appended(tokenFree, "user", "u");
tokenFree = closed(tokenFree, "tf summary").session;
check(
  "⑧ A11 合成/混合会话的树节点没有 token/budget/MC/trigger 字段",
  noTokenFields(tokenFree) && noTokenFields(s),
);
check(
  "⑧ A13 不复制为 session-tree 自有导出：共享常量仍在 context-compress，且 behavior 与 N=4 一致",
  SUBLIMATION_THRESHOLD === 4 &&
    Object.isFrozen(KAZ_CONTEXT_RENDER_ORDER) &&
    JSON.stringify(KAZ_CONTEXT_RENDER_ORDER) === JSON.stringify(["outermost-blocks", "current-unclosed-raw"]) &&
    FORBIDDEN_DUPLICATE_CONSTANT_EXPORTS.every((name) => !Object.prototype.hasOwnProperty.call(directNs, name)),
);
check(
  "⑧ A13/A14 session-tree 六函数经 tool-lists 公共出口可用（kaz-shared re-export 约定）",
  EXPECTED_SESSION_TREE_EXPORTS.every((name) => Object.prototype.hasOwnProperty.call(publicNs, name)),
);
check(
  "⑧ A10/A12 公共命名空间无 whale_expand/持久化/归档注册等 M2/M3 工具",
  ["whale_expand", "persist", "archive", "register", "cordis"].every(
    (name) => !Object.prototype.hasOwnProperty.call(publicNs, name),
  ),
);

if (failures === 0) {
  console.log("\nSESSION-TREE PROBE OK");
  process.exit(0);
} else {
  console.error(`\nSESSION-TREE PROBE FAILED: ${failures}`);
  process.exit(1);
}
