// kaz-shared 探针：Kaz7.0 M3 子步骤 A whale_expand 纯读取模块（lib/session-tree-expand.js）。
// ===========================================================================
// 依据：不入库文件/Kaz7.0更新规划/Kaz7.0-M3 whale_expand 设计报告.md（E1-E12）。
// 覆盖：
//   E1  path 解析支持 "" / A / A/A1 / A/A1/leaf-07；坏输入返回 error 不抛异常；
//   E2  path 只按当前树 id 祖先链解析；无目录穿越/文件系统语义；
//   E3  hiddenRootIds 不影响 expand：完整 Session 中 hidden 根及内部可读；
//       根视图含 hidden 根；
//   E4  block/scope 返回直接 children，不递归孙级；leaf 返回完整原信息；
//   E5  输出顺序 = children 源顺序（老 → 新）；同输入两次结果一致；
//   E6  默认 1000 单位分页、has_more/cursor 续读、单条超长 singleOversized；
//   E7  render / renderWindowSession 在 expand 前后保持 renderOrderValid；
//       expand 不改 Session；
//   E8  archive 只经独立只读通道；expand 不自动读 archive；
//   E9  纯模块零 I/O、无 Stable Main/cordis/工具面注册；session-tree.js 与
//       tool-lists.js 公共根无 whale_expand/expand 导出；
//   E10 不新增 token 触发/保留预算：导出、Session、expand 结果无相关字段；
//   E11 所有返回项带 sourceId/sourcePath；leaf 原信息直读不改写；
//   E12 不写/删 ka-whale-memory；展开回收不在纯读取模块。
// 运行：node KazPlugins/kaz-shared/probe-session-tree-expand.mjs
// ===========================================================================

import { readFileSync } from "node:fs";
import {
  createSession,
  append,
  open,
  close,
  render,
} from "./lib/session-tree.js";
import { renderOrderValid } from "./lib/context-compress.js";
import { renderWindowSession } from "./lib/session-tree-store-core.js";
import {
  DEFAULT_WHALE_EXPAND_LIMIT,
  parseWhalePath,
  resolveWhalePath,
  collectExpandItems,
  estimateExpandReturnTokens,
  paginateExpandItems,
  expand,
} from "./lib/session-tree-expand.js";

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

function run(result) {
  if (result?.error) {
    throw new Error(`unexpected error ${result.error.code}: ${result.error.message}`);
  }
  return result;
}

function opened(session, level, boundary, id) {
  return run(open(session, { level, boundary, id })).session;
}

function appended(session, kind, content, id) {
  return run(
    append(session, { kind, content, ...(id === undefined ? {} : { id }) }),
  ).session;
}

function closed(session, summary) {
  return run(close(session, { summary })).session;
}

function allNodes(session) {
  const out = [];
  const walk = (children) => {
    for (const node of children ?? []) {
      if (!node || typeof node !== "object") continue;
      out.push(node);
      if (Array.isArray(node.children)) walk(node.children);
    }
  };
  walk(session.rootChildren);
  return out;
}

function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// 合成会话：root = [closed A(level3, hidden-capable), closed B(level3),
//                leaf root-leaf, open scope C(level2)]
// A.children = [leaf a0, closed A1(level2)]；A1.children = [leaf leaf-07]
// C.children = [leaf c-leaf, closed C1(level1)]；C1.children = [leaf c1-leaf]
// ---------------------------------------------------------------------------
let s = run(createSession({ id: "expand-tree" })).session;

s = opened(s, 3, "goal", "A");
s = appended(s, "user", "a0 raw content", "a0");
s = opened(s, 2, "planItem", "A1");
s = appended(s, "user", "leaf-07 raw content", "leaf-07");
s = closed(s, "A1 summary");
s = closed(s, "A summary");

s = opened(s, 3, "goal", "B");
s = appended(s, "user", "b0 raw content", "b0");
s = opened(s, 2, "planItem", "B1");
s = appended(s, "user", "b-leaf raw content", "b-leaf");
s = closed(s, "B1 summary");
s = closed(s, "B summary");

s = appended(s, "user", "root raw content", "root-leaf");
s = opened(s, 2, "planItem", "C");
s = appended(s, "user", "c-leaf raw content", "c-leaf");
s = opened(s, 1, "round", "C1");
s = appended(s, "user", "c1-leaf raw content", "c1-leaf");
s = closed(s, "C1 summary");

const HIDDEN = ["A"];

// ---------------------------------------------------------------------------
// E1：path 解析 + resolve 支持；坏输入不抛异常
// ---------------------------------------------------------------------------
{
  const paths = [
    ["", { segments: [], isRoot: true }],
    ["A", { segments: ["A"], isRoot: false }],
    ["A/A1", { segments: ["A", "A1"], isRoot: false }],
    ["A/A1/leaf-07", { segments: ["A", "A1", "leaf-07"], isRoot: false }],
  ];
  const parsedOk = paths.every(([path, expected]) => {
    const parsed = parseWhalePath(path);
    return (
      parsed?.ok === true &&
      jsonEqual(parsed.segments, expected.segments) &&
      parsed.isRoot === expected.isRoot
    );
  });
  check("E1 parseWhalePath 支持 \"\", A, A/A1, A/A1/leaf-07", parsedOk);

  const kindA = run(resolveWhalePath(s, "A")).kind;
  const kindA1 = run(resolveWhalePath(s, "A/A1")).kind;
  const kindLeaf = run(resolveWhalePath(s, "A/A1/leaf-07")).kind;
  check(
    "E1 resolveWhalePath 沿祖先链解析到 root/block/block/leaf",
    run(resolveWhalePath(s, "")).kind === "root" &&
      kindA === "block" &&
      kindA1 === "block" &&
      kindLeaf === "leaf",
  );

  const badPaths = [null, 7, "/", "A//B", "A/./B", "A/../B", "A\\B", "A\u0000B", ".", ".."];
  const badResults = badPaths.map((path) => parseWhalePath(path));
  check(
    "E1 坏 path 全部返回 invalid-path error 而不抛异常",
    badResults.every((result) => result?.error?.code === "invalid-path"),
  );
}

// ---------------------------------------------------------------------------
// E2：只按当前树 id 祖先链解析；无目录穿越语义
// ---------------------------------------------------------------------------
{
  const missing = resolveWhalePath(s, "no-such-root");
  const missingDeep = resolveWhalePath(s, "A/A1/no-such-leaf");
  const tooDeep = resolveWhalePath(s, "A/A1/leaf-07/extra");
  const invalidSession = resolveWhalePath(
    { ...s, hiddenRootIds: ["not-a-session-field"] },
    "A",
  );
  const notObject = resolveWhalePath({ rootChildren: "not-an-array" }, "A");
  check(
    "E2 path 不在当前祖先链时返回 path-not-found / path-too-deep / invalid-session",
    missing.error?.code === "path-not-found" &&
      missingDeep.error?.code === "path-not-found" &&
      tooDeep.error?.code === "path-too-deep" &&
      invalidSession.error?.code === "invalid-session" &&
      notObject.error?.code === "invalid-session",
  );
}

// ---------------------------------------------------------------------------
// E3：hiddenRootIds 不影响 expand；完整 Session 中 hidden 根及内部可读
// ---------------------------------------------------------------------------
{
  const view = run(renderWindowSession(s, HIDDEN));
  const rootResult = run(expand(s, ""));
  const hiddenRootResult = run(expand(s, "A"));
  const hiddenDeepResult = run(expand(s, "A/A1/leaf-07"));
  check(
    "E3 hidden 根从 renderWindowSession 视图消失，但完整 Session 根视图仍含 hidden 根",
    view.session.rootChildren.some((node) => node.id === "A") === false &&
      rootResult.page.some((item) => item.sourceId === "A") &&
      rootResult.page.some((item) => item.sourceId === "B"),
  );
  check(
    "E3 expand 吃完整 Session：hidden 根与 hidden 根内部均可读",
    hiddenRootResult.ok === true &&
      hiddenRootResult.target.id === "A" &&
      hiddenDeepResult.ok === true &&
      hiddenDeepResult.page[0]?.message?.id === "leaf-07",
  );
}

// ---------------------------------------------------------------------------
// E4：block/scope 返回直接 children；leaf 返回完整原信息
// ---------------------------------------------------------------------------
{
  const a = run(expand(s, "A"));
  const c = run(expand(s, "C"));
  const leaf = run(expand(s, "A/A1/leaf-07"));
  const nestedLeafIds = (result) =>
    result.page.filter((item) => item.kind === "leaf").map((item) => item.sourceId);
  check(
    "E4 block 展开只含直接 children（leaf + 子 block），不含孙级 leaf",
    a.target.kind === "block" &&
      a.total === 2 &&
      a.page.map((item) => item.sourceId).join(",") === "a0,A1" &&
      nestedLeafIds(a).join(",") === "a0" &&
      a.page.every((item) => item.sourceId !== "leaf-07"),
  );
  check(
    "E4 scope 展开只含直接 children，不递归到 scope 内 block 的孙级",
    c.target.kind === "scope" &&
      c.total === 2 &&
      c.page.map((item) => item.sourceId).join(",") === "c-leaf,C1" &&
      c.page.every((item) => item.sourceId !== "c1-leaf"),
  );
  check(
    "E4 leaf 展开返回完整原信息（sourceId/sourcePath/message 原样）",
    leaf.target.kind === "leaf" &&
      leaf.target.id === "leaf-07" &&
      leaf.page.length === 1 &&
      leaf.page[0].kind === "leaf" &&
      leaf.page[0].sourceId === "leaf-07" &&
      leaf.page[0].sourcePath === "A/A1/leaf-07" &&
      leaf.page[0].message.id === "leaf-07" &&
      leaf.page[0].message.content === "leaf-07 raw content",
  );
}

// ---------------------------------------------------------------------------
// E5：输出顺序 = children 源顺序；同输入两次结果一致
// ---------------------------------------------------------------------------
{
  const rootA = run(collectExpandItems(s, ""));
  const rootB = run(collectExpandItems(s, ""));
  const a = run(expand(s, "A"));
  const a2 = run(expand(s, "A"));
  const snapshot = JSON.stringify(s);
  const aChildrenIds = s.rootChildren
    .find((node) => node.id === "A")
    .children.map((child) => child.id);
  const rootIds = s.rootChildren.map((child) => child.id);
  check(
    "E5 root/block 展开顺序与 children 源顺序一致（老 → 新）",
    rootA.items.map((item) => item.sourceId).join(",") === rootIds.join(",") &&
      a.page.map((item) => item.sourceId).join(",") === aChildrenIds.join(","),
  );
  check(
    "E5 同输入两次 expand/collect 结果一致且不改 Session",
    jsonEqual(rootA, rootB) &&
      jsonEqual(a, a2) &&
      JSON.stringify(s) === snapshot,
  );
}

// ---------------------------------------------------------------------------
// E6：分页（默认 1000、cursor 续读、singleOversized）
// ---------------------------------------------------------------------------
{
  let p = run(createSession({ id: "expand-paging" })).session;
  for (let i = 0; i < 30; i += 1) {
    p = appended(p, "user", `p-${i} ${"x".repeat(220)}`, `p-${i}`);
  }
  const first = run(expand(p, ""));
  check(
    "E6 默认 limit=1000；首页在预算内截断并返回 hasMore/nextCursor",
    DEFAULT_WHALE_EXPAND_LIMIT === 1000 &&
      first.hasMore === true &&
      first.total === 30 &&
      first.offset === 0 &&
      first.page.length > 0 &&
      first.page.length < first.total &&
      first.budgetUsed <= 1000 &&
      typeof first.nextCursor === "string",
  );

  let cursor;
  let pages = 0;
  const seen = [];
  do {
    const pageResult = run(expand(p, "", cursor === undefined ? {} : { cursor }));
    for (const item of pageResult.page) seen.push(item.sourceId);
    cursor = pageResult.hasMore ? pageResult.nextCursor : null;
    pages += 1;
    if (pages > 50) throw new Error("cursor continuation did not terminate");
  } while (cursor !== null);
  check(
    "E6 cursor 续读到同层末尾：无重复、无遗漏、末页 hasMore=false",
    pages > 1 &&
      seen.length === 30 &&
      new Set(seen).size === 30 &&
      new Set(seen).size === first.total,
  );

  const hugeItem = {
    kind: "leaf",
    sourceId: "huge",
    sourcePath: "huge",
    seq: 1,
    message: {
      nodeType: "leaf",
      id: "huge",
      seq: 1,
      kind: "user",
      content: `huge ${"y".repeat(600)}`,
    },
  };
  const single = run(paginateExpandItems([hugeItem], { limit: 20 }));
  check(
    "E6 单条超限不截断：整条返回并标记 singleOversized",
    single.singleOversized === true &&
      single.page.length === 1 &&
      single.page[0].sourceId === "huge" &&
      single.page[0].message.content.length > 100 &&
      single.budgetUsed > 20 &&
      single.hasMore === false,
  );

  const badLimit = paginateExpandItems([hugeItem], { limit: 0 });
  const badCursor = paginateExpandItems([hugeItem], { cursor: "k7e:not-a-number" });
  check(
    "E6 非法 limit/cursor 返回 invalid-limit/invalid-cursor",
    badLimit.error?.code === "invalid-limit" &&
      badCursor.error?.code === "invalid-cursor",
  );
}

// ---------------------------------------------------------------------------
// E7：render / renderWindowSession 前后保持 renderOrderValid；expand 不改 Session
// ---------------------------------------------------------------------------
{
  const renderBefore = run(render(s));
  const windowViewBefore = run(renderWindowSession(s, HIDDEN)).session;
  const windowBefore = run(render(windowViewBefore));
  const snapshot = JSON.stringify(s);
  run(expand(s, ""));
  run(expand(s, "A"));
  run(expand(s, "A/A1/leaf-07"));
  run(expand(s, "C"));
  const renderAfter = run(render(s));
  const windowViewAfter = run(renderWindowSession(s, HIDDEN)).session;
  const windowAfter = run(render(windowViewAfter));
  check(
    "E7 expand 前后 render(session) 仍 renderOrderValid 且结果稳定",
    renderBefore.orderValid === true &&
      renderAfter.orderValid === true &&
      renderOrderValid(renderBefore.entries) === true &&
      renderOrderValid(renderAfter.entries) === true &&
      jsonEqual(renderBefore.entries, renderAfter.entries),
  );
  check(
    "E7 expand 前后 renderWindowSession 常驻渲染仍 renderOrderValid 且结果稳定",
    windowBefore.orderValid === true &&
      windowAfter.orderValid === true &&
      renderOrderValid(windowBefore.entries) === true &&
      renderOrderValid(windowAfter.entries) === true &&
      jsonEqual(windowBefore.entries, windowAfter.entries),
  );
  check(
    "E7 expand 是纯只读：Session 在多次展开后 JSON 不变",
    JSON.stringify(s) === snapshot,
  );
}

// ---------------------------------------------------------------------------
// E8：archive 独立；expand 不自动读 archive / 不做隐式 fallback
// ---------------------------------------------------------------------------
{
  const expandNs = await import("./lib/session-tree-expand.js");
  const source = readFileSync(
    new URL("./lib/session-tree-expand.js", import.meta.url),
    "utf8",
  );
  const result = run(expand(s, "A"));
  const archiveForbidden = ["archive", "fallback", "readArchive", "listArchiveRefs"];
  const hasNodeIoImport =
    /\bfrom\s+["']node:(fs|crypto|path|url)["']/.test(source) ||
    /\bimport\s*\(\s*["']node:(fs|crypto|path|url)["']/.test(source);
  check(
    "E8 expand 结果/命名空间无 archive 隐式来源或回退字段",
    !archiveForbidden.some((key) =>
      Object.prototype.hasOwnProperty.call(expandNs, key),
    ) &&
      !archiveForbidden.some((key) =>
        Object.prototype.hasOwnProperty.call(result, key),
      ),
  );
  check(
    "E8 纯模块无 node:fs/crypto/path/url import（archive 必须走独立只读通道）",
    !hasNodeIoImport,
  );
}

// ---------------------------------------------------------------------------
// E9：零 I/O、无 Stable Main/cordis/工具面注册；公共根无 whale_expand
// ---------------------------------------------------------------------------
{
  const expandNs = await import("./lib/session-tree-expand.js");
  const sessionTreeNs = await import("./lib/session-tree.js");
  const publicNs = await import("./lib/tool-lists.js");
  const source = readFileSync(
    new URL("./lib/session-tree-expand.js", import.meta.url),
    "utf8",
  );
  const expectedExports = [
    "DEFAULT_WHALE_EXPAND_LIMIT",
    "parseWhalePath",
    "resolveWhalePath",
    "collectExpandItems",
    "estimateExpandReturnTokens",
    "paginateExpandItems",
    "expand",
  ];
  check(
    "E9 session-tree-expand 命名空间只有 7 个纯函数/常量导出",
    Object.keys(expandNs).length === expectedExports.length &&
      expectedExports.every((name) => Object.prototype.hasOwnProperty.call(expandNs, name)),
  );
  const forbiddenRuntime = [
    "register",
    "unregister",
    "cordis",
    "inject",
    "whale_expand",
    "persist",
    "archive",
  ];
  const publicForbidden = [
    ...forbiddenRuntime,
    "expand",
    "parseWhalePath",
    "resolveWhalePath",
    "collectExpandItems",
    "paginateExpandItems",
  ];
  check(
    "E9 新纯模块/公共根无 cordis/register/inject/whale_expand/expand/archive 注册",
    forbiddenRuntime.every((name) => !Object.prototype.hasOwnProperty.call(expandNs, name)) &&
      publicForbidden.every((name) => !Object.prototype.hasOwnProperty.call(publicNs, name)) &&
      publicForbidden.every((name) => !Object.prototype.hasOwnProperty.call(sessionTreeNs, name)),
  );
  const hasNodeIoImport =
    /\bfrom\s+["']node:(fs|crypto|path|url)["']/.test(source) ||
    /\bimport\s*\(\s*["']node:(fs|crypto|path|url)["']/.test(source);
  check("E9 新纯模块源码零 node I/O import", !hasNodeIoImport);
}

// ---------------------------------------------------------------------------
// E10：不新增 token 触发/保留预算字段或导出
// （budgetUsed / estimateExpandReturnTokens 是文档化的临时返回体积报告，
//   不是写入 Session/store/archive 的触发或常驻预算。）
// ---------------------------------------------------------------------------
{
  const expandNs = await import("./lib/session-tree-expand.js");
  const result = run(expand(s, "A"));
  const forbiddenResidentBudget = /(?:^|_)(?:mc_|trigger|budget)|token(?:Budget|Limit|Trigger|Retention|Resident)|retentionBudget|residentBudget/i;
  const forbiddenDeletedExports = [
    "MC_trigger",
    "MC_emergency",
    "MC_expand",
    "RawTailBudget",
    "OuterResidentBudget",
  ];
  const allNodeKeys = allNodes(s).flatMap((node) => Object.keys(node));
  check(
    "E10 Session 树节点与 expand 返回项无 token 触发/常驻预算字段",
    !allNodeKeys.some((key) => forbiddenResidentBudget.test(key)) &&
      !Object.keys(result.page[0]).some((key) => forbiddenResidentBudget.test(key)) &&
      !Object.keys(s).some((key) => forbiddenResidentBudget.test(key)),
  );
  check(
    "E10 session-tree-expand 命名空间无 MC/trigger/常驻 budget 导出（token 估算函数除外）",
    !Object.keys(expandNs).some((key) => forbiddenResidentBudget.test(key)) &&
      forbiddenDeletedExports.every(
        (name) => !Object.prototype.hasOwnProperty.call(expandNs, name),
      ),
  );
}

// ---------------------------------------------------------------------------
// E11：所有返回项带 sourceId/sourcePath；无来源改写/推断
// ---------------------------------------------------------------------------
{
  const results = [
    run(expand(s, "")),
    run(expand(s, "A")),
    run(expand(s, "C")),
    run(expand(s, "A/A1/leaf-07")),
  ];
  const itemFieldOk = results.every((result) =>
    result.page.every(
      (item) =>
        typeof item?.sourceId === "string" &&
        item.sourceId.length > 0 &&
        typeof item?.sourcePath === "string" &&
        item.sourcePath.length > 0 &&
        ["block", "scope", "leaf"].includes(item.kind),
    ),
  );
  const leafResult = run(expand(s, "A/A1/leaf-07"));
  const originalLeaf = s.rootChildren
    .find((node) => node.id === "A")
    .children.find((node) => node.id === "A1")
    .children.find((node) => node.id === "leaf-07");
  const leafItem = leafResult.page[0];
  check("E11 所有展开返回项均带 sourceId/sourcePath/kind", itemFieldOk);
  check(
    "E11 leaf 原信息直读不改写：message 与 Session 中 leaf 节点一致",
    leafItem.sourceId === originalLeaf.id &&
      leafItem.sourcePath === "A/A1/leaf-07" &&
      jsonEqual(leafItem.message, originalLeaf),
  );
  check("E11 estimateExpandReturnTokens 使用 4 字符 ≈ 1 token 启发式", estimateExpandReturnTokens("abcd") === 1 && estimateExpandReturnTokens(123) === 0);
}

// ---------------------------------------------------------------------------
// E12：不写/删 ka-whale-memory；展开回收不在纯读取模块
// ---------------------------------------------------------------------------
{
  const expandNs = await import("./lib/session-tree-expand.js");
  const source = readFileSync(
    new URL("./lib/session-tree-expand.js", import.meta.url),
    "utf8",
  );
  const memoryApiNames = [
    "writeMemory",
    "deleteMemory",
    "readMemory",
    "memoryWrite",
    "memoryDelete",
    "memoryConsolidate",
  ];
  check(
    "E12 新模块无 memory 写入/删除 API 导出",
    memoryApiNames.every((name) => !Object.prototype.hasOwnProperty.call(expandNs, name)) &&
      !source.includes("ka-whale-memory") &&
      !/\bimport\b[^;]*ka-whale-memory/.test(source),
  );
  const snapshot = JSON.stringify(s);
  run(expand(s, "A"));
  run(expand(s, ""));
  check(
    "E12 多次 expand 无任何可观察写入副作用（Session 不变、无导出写接口）",
    JSON.stringify(s) === snapshot,
  );
}

if (failures === 0) {
  console.log("\nSESSION-TREE-EXPAND PROBE OK");
  process.exit(0);
} else {
  console.error(`\nSESSION-TREE-EXPAND PROBE FAILED: ${failures}`);
  process.exit(1);
}
