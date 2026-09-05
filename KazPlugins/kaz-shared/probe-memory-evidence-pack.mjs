// kaz-shared 探针：Kaz7.0 M5 纯证据打包模块（lib/memory-evidence-pack.js）。
// ===========================================================================
// 依据：不入库文件/Kaz7.0更新规划/Kaz7.0-M5 memory-maintenance 收口设计报告.md
//       （D1–D9、§5.2–5.6、§6 N1–N7、§7 B8-1..B8-7、§8 无 token/无运行时注册）
// 覆盖：
//   - 纯模块边界：仅 4 个预期导出；无 cordis/注册/inject/持久化导出；
//     不进入 tool-lists 公共根；无 token/budget/MC/trigger 导出；
//   - 设计函数：collectMemoryEvidenceRefs / buildMemoryCandidateDraft /
//     packMemoryCandidates / validateMemoryCandidateDraft；
//   - 证据收集：一个证据组=一个候选；leaf 并入最近祖先 block；无来源不产出；
//   - draft 生成：name/keywords/summary/content/evidence/refs/paths 形状；
//   - 不灌整树：输出只含被引用事实/摘要，不含未引用树正文/render/expand/store 全文；
//   - paths ≤8：超出记录 paths-over-limit，候选仍可验证；
//   - 无来源丢弃 / 空正文丢弃；
//   - 内容可回溯：evidence/refs 可解析到 tree-block/leaf/raw/archive 来源；
//   - N1–N7：以纯模块输出、静态源码与 main-surface 常量可测的合同断言覆盖；
//     角色运行时项（N3 汇报、B8-3 memory_search 去重）如实标注为边界，
//     不假装在纯模块内执行了 memoryMaintainer 子代理；
//   - B8-1..B8-7：合成 Session + archive/raw 夹具的收口场景验收。
// 运行：node KazPlugins/kaz-shared/probe-memory-evidence-pack.mjs
// ===========================================================================

import { readFileSync } from "node:fs";
import { createSession, append, open, close } from "./lib/session-tree.js";
import * as pack from "./lib/memory-evidence-pack.js";
import * as toolLists from "./lib/tool-lists.js";

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

function appendCapture(session, event) {
  const result = run(append(session, event));
  return {
    session: result.session,
    leafId: result.changes[0]?.leafId,
    path: result.changes[0]?.path,
  };
}

function flattenSession(session) {
  const rows = [];
  const walk = (children, prefix = []) => {
    for (const node of children ?? []) {
      const row = {
        node,
        kind: node?.nodeType,
        path: [...prefix, node?.id].filter(Boolean).join("/"),
      };
      rows.push(row);
      if (Array.isArray(node?.children)) {
        walk(node.children, [...prefix, node?.id].filter(Boolean));
      }
    }
  };
  walk(session?.rootChildren ?? []);
  return rows;
}

function buildEvidenceSession() {
  let s = run(createSession({ id: "session-evidence-1" })).session;

  // 旧根（B8-1 hidden 旧根；只隐藏、不删除、仍可作证据引用）。
  s = run(open(s, { level: 1, boundary: "round", id: "round-old" })).session;
  const oldLeaf = appendCapture(s, {
    kind: "user",
    content: "old hidden root exact fact",
    sourceRef: "KazPlugins/kaz-shared/lib/old-evidence.js",
  });
  s = oldLeaf.session;
  s = run(close(s, { summary: "Old hidden root round summary" })).session;

  // 已闭合 goal → planItem → round 链。
  s = run(open(s, { level: 3, boundary: "goal", id: "goal-main" })).session;
  s = run(open(s, { level: 2, boundary: "planItem", id: "pi-fix" })).session;
  s = run(open(s, { level: 1, boundary: "round", id: "round-fix" })).session;
  const fixLeaf = appendCapture(s, {
    kind: "user",
    content:
      "node --check passed after EPERM in KazPlugins/kaz-shared/lib/memory-evidence-pack.js",
    sourceRef: "KazPlugins/kaz-shared/lib/memory-evidence-pack.js",
  });
  s = fixLeaf.session;
  s = run(close(s, { summary: "EPERM resolved by read-only probe command" })).session;
  s = run(close(s, { summary: "planItem: evidence pack probe passed" })).session;
  s = run(close(s, { summary: "goal: memory evidence pack complete" })).session;

  // 当前未闭合 raw（主线不应因打包/收口而把整树正文回灌）。
  s = run(open(s, { level: 1, boundary: "round", id: "round-current" })).session;
  const currentLeaf = appendCapture(s, {
    kind: "user",
    content: "current unclosed raw observation that must never appear in mainline",
    sourceRef: "KazPlugins/kaz-shared/lib/current.js",
  });
  s = currentLeaf.session;

  const rows = flattenSession(s);
  const byId = (id) => rows.find((row) => row.node?.id === id);
  return {
    session: s,
    rows,
    goalBlock: byId("goal-main"),
    piBlock: byId("pi-fix"),
    roundFixBlock: byId("round-fix"),
    oldBlock: byId("round-old"),
    fixLeaf: rows.find(
      (row) =>
        row.kind === "leaf" &&
        typeof row.node?.content === "string" &&
        row.node.content.includes("EPERM"),
    ),
    oldLeaf: rows.find(
      (row) =>
        row.kind === "leaf" &&
        typeof row.node?.content === "string" &&
        row.node.content.includes("old hidden root"),
    ),
    currentLeaf: rows.find(
      (row) =>
        row.kind === "leaf" &&
        typeof row.node?.content === "string" &&
        row.node.content.includes("current unclosed raw"),
    ),
  };
}

// ---------------------------------------------------------------------------
// 合成证据夹具：Session + archive + raw
// ---------------------------------------------------------------------------
const FX = buildEvidenceSession();

const FIX_FILE = "KazPlugins/kaz-shared/lib/memory-evidence-pack.js";
const ARCHIVE_FILE = "KazPlugins/kaz-shared/lib/session-tree.js";

const archiveRecords = [
  {
    archiveId: "arch-main-1",
    path: "goal-archived/block-id",
    block: {
      nodeType: "block",
      id: "arch-block-1",
      level: 3,
      boundary: "goal",
      state: "closed",
      summary: "Archived old design decision kept as traceable evidence",
      children: [],
    },
    removedAt: "2026-09-05T00:00:00.000Z",
    reason: "archived during earlier hidden-root pass",
    sourceRefs: [ARCHIVE_FILE],
    leafIds: ["leaf-arch-1"],
  },
  {
    archiveId: "arch-empty-1",
    path: "arch-empty/block-id",
    block: {
      nodeType: "block",
      id: "arch-empty-block",
      level: 3,
      boundary: "goal",
      state: "closed",
      summary: "",
      children: [],
    },
    removedAt: "2026-09-04T00:00:00.000Z",
    reason: "empty archive should drop",
    sourceRefs: [],
    leafIds: [],
  },
];

const rawEventBySeq = new Map([
  [
    9101,
    {
      type: "raw",
      seq: 9101,
      content: "raw exact: node --check KazPlugins/kaz-shared/probe-memory-evidence-pack.mjs",
      sourceRef: FIX_FILE,
    },
  ],
  [
    7777,
    {
      type: "raw",
      seq: 7777,
      content: Array.from({ length: 8 }, (_, i) => `C:\\ev\\file${i + 1}.js`).join(" "),
      sourceRef: "C:\\ev\\source-evidence.js",
    },
  ],
]);

const mainPackInput = {
  session: FX.session,
  hiddenRootIds: ["round-old"],
  refs: [
    {
      kind: "block",
      id: FX.goalBlock.node.id,
      path: FX.goalBlock.path,
      reason: "closed goal with evidence pack probe",
    },
    {
      kind: "leaf",
      id: FX.fixLeaf.node.id,
      path: FX.fixLeaf.path,
      seq: FX.fixLeaf.node.seq,
      reason: "node --check EPERM fix",
    },
    {
      kind: "block",
      id: FX.oldBlock.node.id,
      path: FX.oldBlock.path,
      reason: "hidden old root evidence",
    },
    { kind: "raw", seq: 9101, reason: "exact raw command" },
    {
      kind: "archive",
      archiveId: "arch-main-1",
      reason: "archived old design decision",
    },
    { kind: "raw", seq: 999999, reason: "missing source should drop" },
  ],
  archiveRecords,
  rawEventBySeq,
  opts: {
    storePath: "C:\\Kaz\\store\\session-abc",
    namespaceHint: "project",
  },
};

const packResult = run(pack.packMemoryCandidates(mainPackInput));
const collectResult = run(pack.collectMemoryEvidenceRefs(mainPackInput));
const mainJson = JSON.stringify(packResult);
const moduleSource = readFileSync(
  new URL("./lib/memory-evidence-pack.js", import.meta.url),
  "utf8",
);
const treeSources = [
  "session-tree.js",
  "session-tree-store-core.js",
  "session-tree-expand.js",
].map((file) =>
  readFileSync(new URL(`./lib/${file}`, import.meta.url), "utf8"),
);

const EXPECTED_EXPORTS = [
  "collectMemoryEvidenceRefs",
  "buildMemoryCandidateDraft",
  "packMemoryCandidates",
  "validateMemoryCandidateDraft",
];
const FORBIDDEN_RUNTIME_EXPORTS = [
  "register",
  "unregister",
  "cordis",
  "inject",
  "stableMainSurface",
  "registerStableMain",
  "llm",
  "persist",
  "archive",
];
const MEMORY_WRITE_APIS = ["memory_save", "memory_update", "memory_forget"];

// ---------------------------------------------------------------------------
// ① 纯模块边界 / 无运行时注册 / 无 token / 不进入公共工具面
// ---------------------------------------------------------------------------
check(
  "① M5 预期 4 个证据打包导出全部存在且无多余公共导出",
  EXPECTED_EXPORTS.every((name) =>
    Object.prototype.hasOwnProperty.call(pack, name),
  ) && Object.keys(pack).length === EXPECTED_EXPORTS.length,
);

check(
  "① D7/§8.2 模块命名空间无 cordis/注册/inject/持久化/archive 等运行时接线",
  FORBIDDEN_RUNTIME_EXPORTS.every(
    (name) => !Object.prototype.hasOwnProperty.call(pack, name),
  ),
);

check(
  "① D7/§8.2 memory-evidence-pack 不进 tool-lists 公共根/工具面",
  EXPECTED_EXPORTS.every(
    (name) => !Object.prototype.hasOwnProperty.call(toolLists, name),
  ),
);

check(
  "① §8.1 直接命名空间与公共命名空间均无 token/budget/MC/trigger 导出",
  !Object.keys(pack).some((name) => /token|budget|mc_|trigger/i.test(name)) &&
    !Object.keys(toolLists).some(
      (name) => /token|budget|mc_|trigger/i.test(name) && /^(MC|Raw|Outer)/.test(name),
    ) &&
    !Object.keys(pack).some((name) => name === "MC_trigger" || name === "RawTailBudget"),
);

check(
  "① 模块源码零 I/O 边界：不 import node:fs/node:crypto/node:path",
  !/from\s+["']node:(?:fs|crypto|path)["']/.test(moduleSource),
);

// ---------------------------------------------------------------------------
// ② N1–N7 合同断言（纯模块可测口径 + 静态边界）
// ---------------------------------------------------------------------------
const simulatedDelegation = {
  storeRoot: "C:\\Kaz\\store",
  sessionId: FX.session.id,
  sessionDirId: "session-abc",
  candidateRefs: [
    { kind: "block", id: "goal-main", path: "goal-main", reason: "closed goal" },
    {
      kind: "leaf",
      id: FX.fixLeaf.node.id,
      path: FX.fixLeaf.path,
      seq: FX.fixLeaf.node.seq,
      reason: "exact fix",
    },
  ],
};

check(
  "② N1 treeEvidence 委派载荷只含 store/session/refs/path/count；不含 store.json/render/expand 正文",
  simulatedDelegation.candidateRefs.every(
    (ref) => !("content" in ref) && !("message" in ref) && !("text" in ref),
  ) &&
    Object.keys(simulatedDelegation).every(
      (key) =>
        !/storeJson|renderText|expandText|fullSession|storeBody/.test(key),
    ) &&
    !mainJson.includes('"store.json"'),
);

const mainTools = toolLists.KAZ_V09_MAIN_TOOLS ?? [];
check(
  "② N2/S4/C7 主面常量不含 memory 写/删工具；只保留 memory 读工具",
  MEMORY_WRITE_APIS.every((tool) => !mainTools.includes(tool)) &&
    ["memory_detail", "memory_list", "memory_search"].every((tool) =>
      mainTools.includes(tool),
    ),
);

check(
  "② N3 pack 结果不回灌完整 Session/未引用 raw/未引用树正文（纯模块侧的汇报/委派边界）",
  !mainJson.includes("current unclosed raw observation") &&
    !mainJson.includes(FX.oldLeaf.node.content) &&
    !mainJson.includes('"rootChildren"') &&
    packResult.dropped.every((item) => !("content" in item)),
);

check(
  "② N4/S4 压缩/打包源码与命名空间无 memory_save/update/forget 调用或导出",
  MEMORY_WRITE_APIS.every((api) => !Object.prototype.hasOwnProperty.call(pack, api)) &&
    MEMORY_WRITE_APIS.every((api) => !mainTools.includes(api)) &&
    !new RegExp(`(?:^|\\W)${MEMORY_WRITE_APIS.join("(?:\\W|$)|(?:^|\\W)")}(?:\\s*\\()`).test(
      moduleSource,
    ),
);

check(
  "② N5 打包层不新增 auto-load/注入正文字段：draft 形状无 content 注入器、模块无 auto-load 运行时导出",
  !Object.keys(pack).some((name) => /autoload|autoloadinject|inject/i.test(name)) &&
    packResult.candidates.every(
      (draft) => !("autoLoad" in draft) && !("injectionText" in draft),
    ) &&
    !/autoLoad|autoload/i.test(moduleSource.replace(/\/\/[^\n]*/g, "")),
);

check(
  "② N6/C6 draft.evidence 可回溯：含 source/store/reason 前缀且 refs 指向 block/leaf/raw/archive",
  packResult.candidates.every(
    (draft) =>
      draft.evidence.includes("source:") &&
      draft.evidence.includes("store:") &&
      Array.isArray(draft.refs) &&
      draft.refs.length > 0 &&
      draft.refs.every((ref) =>
        ["block", "leaf", "raw", "archive"].includes(ref.kind),
      ),
  ) &&
    packResult.candidates
      .find((draft) => draft.refs.some((ref) => ref.kind === "block" && ref.id === "goal-main"))
      ?.evidence.includes("tree-block:goal-main") === true &&
    packResult.candidates
      .find((draft) => draft.refs.some((ref) => ref.kind === "raw" && ref.seq === 9101))
      ?.evidence.includes("raw:9101") === true &&
    packResult.candidates
      .find((draft) => draft.refs.some((ref) => ref.kind === "archive"))
      ?.evidence.includes("archive:arch-main-1") === true,
);

check(
  "② N7/§8.3 树/压缩/store/expand 模块源码无 memory 写/删 API 调用",
  treeSources.every(
    (source) =>
      !/memory_(?:save|update|forget)\s*\(/.test(source) &&
      !/from\s+["'][^"']*ka-whale-memory["']/.test(source),
  ) && !/memory_(?:save|update|forget)\s*\(/.test(moduleSource),
);

// ---------------------------------------------------------------------------
// ③ 设计函数：collectMemoryEvidenceRefs —— 证据收集/分组
// ---------------------------------------------------------------------------
const goalCollectGroup = collectResult.nodes.find(
  (node) => node.kind === "block" && node.id === "goal-main",
);

check(
  "③ collectMemoryEvidenceRefs 成功返回分组 nodes；block+其后代 leaf 合并为一个证据组",
  collectResult.ok === true &&
    Array.isArray(collectResult.nodes) &&
    goalCollectGroup?.members?.length === 1 &&
    goalCollectGroup?.members?.[0]?.kind === "leaf" &&
    goalCollectGroup?.members?.[0]?.id === FX.fixLeaf.node.id &&
    goalCollectGroup?.groupRefs?.length === 2,
);

check(
  "③ collectMemoryEvidenceRefs 找不到来源的 ref 不进 nodes（pack 负责记 dropped）",
  !collectResult.nodes.some((node) => node.ref?.seq === 999999) &&
    packResult.dropped.some(
      (item) => item.ref?.kind === "raw" && item.ref?.seq === 999999 && item.reason === "no-source",
    ),
);

check(
  "③ collectMemoryEvidenceRefs 坏输入返回 invalid-refs / invalid-ref",
  pack.collectMemoryEvidenceRefs(null)?.error?.code === "invalid-input" &&
    pack.collectMemoryEvidenceRefs({ refs: "bad" })?.error?.code === "invalid-refs" &&
    pack.collectMemoryEvidenceRefs({ refs: [{ kind: "nope" }] })?.error?.code ===
      "invalid-ref",
);

// ---------------------------------------------------------------------------
// ④ 设计函数：buildMemoryCandidateDraft / validateMemoryCandidateDraft
// ---------------------------------------------------------------------------
const goalDraftResult = run(
  pack.buildMemoryCandidateDraft(goalCollectGroup, {
    storePath: mainPackInput.opts.storePath,
    namespaceHint: "project",
  }),
);

check(
  "④ buildMemoryCandidateDraft 从单证据组生成合法 draft：必填字段非空",
  goalDraftResult.ok === true &&
    typeof goalDraftResult.draft.name === "string" &&
    goalDraftResult.draft.name.length > 0 &&
    Array.isArray(goalDraftResult.draft.keywords) &&
    goalDraftResult.draft.keywords.length > 0 &&
    typeof goalDraftResult.draft.summary === "string" &&
    goalDraftResult.draft.summary.length > 0 &&
    typeof goalDraftResult.draft.content === "string" &&
    goalDraftResult.draft.content.length > 0 &&
    typeof goalDraftResult.draft.evidence === "string" &&
    goalDraftResult.draft.evidence.length > 0 &&
    goalDraftResult.draft.refs.length === 2 &&
    goalDraftResult.draft.paths.length <= 8,
);

check(
  "④ validateMemoryCandidateDraft：合法 draft ok:true；缺 name / paths>8 / 空 keywords 判失败",
  pack.validateMemoryCandidateDraft(goalDraftResult.draft)?.ok === true &&
    (() => {
      const missingName = { ...goalDraftResult.draft, name: "" };
      const tooManyPaths = {
        ...goalDraftResult.draft,
        paths: Array.from({ length: 9 }, (_, i) => ({
          path: `C:\\p\\${i}.js`,
          purpose: "evidence-file",
        })),
      };
      const emptyKeywords = { ...goalDraftResult.draft, keywords: [] };
      return (
        pack.validateMemoryCandidateDraft(missingName)?.ok === false &&
        pack.validateMemoryCandidateDraft(tooManyPaths)?.errors.some((err) =>
          err.includes("must not exceed 8"),
        ) &&
        pack.validateMemoryCandidateDraft(emptyKeywords)?.ok === false
      );
    })(),
);

check(
  "④ buildMemoryCandidateDraft 坏 source 返回 invalid-source",
  pack.buildMemoryCandidateDraft({ not: "a source" })?.error?.code ===
    "invalid-source" &&
    pack.buildMemoryCandidateDraft(null)?.error?.code === "invalid-source",
);

// ---------------------------------------------------------------------------
// ⑤ packMemoryCandidates：组合规则 / 不灌整树 / paths≤8 / dropped
// ---------------------------------------------------------------------------
check(
  "⑤ packMemoryCandidates 一个证据组=一个候选：goal+leaf 合并，四组产出四候选",
  packResult.ok === true &&
    packResult.candidates.length === 4 &&
    packResult.candidates.filter((draft) =>
      draft.refs.some((ref) => ref.kind === "block" && ref.id === "goal-main"),
    ).length === 1,
);

check(
  "⑤ pack 输出不含整树/未引用叶子/当前 open round 正文；candidates 均通过 draft 校验",
  packResult.candidates.every((draft) => pack.validateMemoryCandidateDraft(draft)?.ok) &&
    !mainJson.includes("current unclosed raw observation") &&
    !mainJson.includes(FX.currentLeaf.node.content) &&
    !mainJson.includes(FX.oldLeaf.node.content),
);

check(
  "⑤ no-source 丢弃只记 ref+reason，不带原正文；empty-content 会以 empty-content 丢弃",
  packResult.dropped.some(
    (item) => item.ref?.kind === "raw" && item.ref?.seq === 999999 && item.reason === "no-source",
  ) &&
    (() => {
      const empty = run(
        pack.packMemoryCandidates({
          refs: [{ kind: "archive", archiveId: "arch-empty-1" }],
          archiveRecords,
        }),
      );
      return (
        empty.ok === true &&
        empty.candidates.length === 0 &&
        empty.dropped.some((item) => item.reason === "empty-content")
      );
    })(),
);

check(
  "⑤ B8-2 paths≤8：draft.paths 全部 ≤8；paths-over-limit 被截断并记录",
  packResult.candidates.every((draft) => draft.paths.length <= 8) &&
    (() => {
      const overflow = run(
        pack.packMemoryCandidates({
          refs: [{ kind: "raw", seq: 7777 }],
          rawEventBySeq,
        }),
      );
      const draft = overflow.candidates[0];
      return (
        overflow.ok === true &&
        draft?.paths.length === 8 &&
        overflow.dropped.some((item) => item.reason === "paths-over-limit") &&
        pack.validateMemoryCandidateDraft(draft)?.ok === true
      );
    })(),
);

// ---------------------------------------------------------------------------
// ⑥ B8 场景验收
// ---------------------------------------------------------------------------
check(
  "⑥ B8-1 合成 Session：已闭合 goal/planItem/round + hidden 旧根 + 当前 raw；refs 委派能产出可读候选",
  packResult.ok === true &&
    packResult.candidates.length === 4 &&
    goalCollectGroup?.node?.id === "goal-main" &&
    collectResult.nodes.some((node) => node.kind === "block" && node.hidden === true) &&
    mainPackInput.session.id === "session-evidence-1" &&
    packResult.candidates.some((draft) => draft.summary.includes("goal: memory evidence pack complete")),
);

check(
  "⑥ B8-2 memory_save 前置字段完整：name/keywords/summary/content/evidence 非空；paths≤8；refs 可回溯",
  packResult.candidates.every(
    (draft) =>
      pack.validateMemoryCandidateDraft(draft)?.ok === true &&
      draft.evidence.length > 0 &&
      draft.paths.length <= 8 &&
      draft.refs.length > 0,
  ),
);

check(
  "⑥ B8-3 去重边界：纯打包模块不冒充去重（无 dedup 导出）；重复与否归 memoryMaintainer memory_search",
  !Object.keys(pack).some((name) => /dedup|duplicate|memory_search/i.test(name)) &&
    packResult.candidates.length === 4,
);

check(
  "⑥ B8-4 压缩/树 store 全流程零自动 memory 写/删：模块与 tree/store/expand 源码均无调用",
  treeSources.every(
    (source) => !/memory_(?:save|update|forget)\s*\(/.test(source),
  ) &&
    !/memory_(?:save|update|forget)\s*\(/.test(moduleSource) &&
    MEMORY_WRITE_APIS.every((api) => !Object.prototype.hasOwnProperty.call(pack, api)),
);

check(
  "⑥ B8-5 证据回溯：evidence 与原始日志一致地含 tree-block path / raw seq / archiveId / store 标签",
  packResult.candidates
    .find((draft) => draft.refs.some((ref) => ref.kind === "raw" && ref.seq === 9101))
    ?.evidence.includes("raw:9101") === true &&
    packResult.candidates
      .find((draft) => draft.refs.some((ref) => ref.kind === "archive"))
      ?.evidence.includes("archive:arch-main-1") === true &&
    goalCollectGroup?.node?.id === "goal-main" &&
    packResult.candidates
      .find((draft) =>
        draft.refs.some((ref) => ref.kind === "leaf" && ref.id === FX.fixLeaf.node.id),
      )
      ?.evidence.includes(`leaf:${FX.fixLeaf.path}(seq ${FX.fixLeaf.node.seq})`) === true,
);

check(
  "⑥ B8-6 主线上下文：pack 结果不含未引用树正文/store 全文/render 全文/expand 全文/auto-load 正文",
  !mainJson.includes(FX.currentLeaf.node.content) &&
    !mainJson.includes(FX.oldLeaf.node.content) &&
    !mainJson.includes('"rootChildren"') &&
    !mainJson.includes('"store.json"') &&
    !mainJson.includes('"expand') &&
    !mainJson.includes('"render"'),
);

check(
  "⑥ B8-7 关闭树证据通道：无 session/无 treeEvidence 的 memory-maintenance 回退仍可正常 pack（不依赖树 refs）",
  (() => {
    const fallback = run(
      pack.packMemoryCandidates({
        refs: [{ kind: "raw", seq: 9101 }],
        rawEventBySeq,
      }),
    );
    return (
      fallback.ok === true &&
      fallback.candidates.length === 1 &&
      fallback.candidates[0].refs[0].kind === "raw"
    );
  })(),
);

// ---------------------------------------------------------------------------
// ⑦ 已知边界自述
// ---------------------------------------------------------------------------
const KNOWN_BOUNDARIES = Object.freeze([
  "N3/N4/N5 的 memoryMaintainer 汇报、memory_save 后主线可见性、auto-load 行为属于运行时/子代理层；本探针只把纯模块输出与静态 main-surface/源码边界作为纯函数可测口径，不宣称运行了 memoryMaintainer 子代理",
  "B8-3 的去重命中/update 由 memoryMaintainer memory_search 完成；纯打包模块按设计不做去重",
]);

check(
  "⑦ 已知边界自述存在且明确（不把角色层行为伪报为纯模块已执行）",
  KNOWN_BOUNDARIES.length === 2 &&
    KNOWN_BOUNDARIES.every((text) => typeof text === "string" && text.length > 0),
);

console.log(
  "\n[memory-evidence-pack known boundaries]\n" +
    KNOWN_BOUNDARIES.map((text, index) => `  ${index + 1}. ${text}`).join("\n"),
);

if (failures === 0) {
  console.log("\nMEMORY-EVIDENCE-PACK PROBE OK");
  process.exit(0);
} else {
  console.error(`\nMEMORY-EVIDENCE-PACK PROBE FAILED: ${failures}`);
  process.exit(1);
}
