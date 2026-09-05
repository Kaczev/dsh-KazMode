// kaz-shared 探针：Kaz7.0 M4 缓存与稳定前缀纯测量/守卫模块（lib/context-cache-guard.js）。
// ===========================================================================
// 依据：不入库文件/Kaz7.0更新规划/Kaz7.0-M4缓存与稳定前缀设计报告.md
//       （权威最终基准 v1.2 §7/§8/§10；M4 验收清单 F1–F14）
// 覆盖：
//   - F1/F10/F11/F13 纯模块边界：预期导出、无运行时注册、无 token 预算、
//     不进入 tool-lists 公共工具面；
//   - F2/F3 A/B/C/D + hFull / hReadProxy / cache_unmeasurable 组合；
//   - stableCanonicalText / prefixStableAfter（前缀稳定，对象键序无关）；
//   - S1/S2/C3 systemToolsHashStable、S3/C8 surfaceHashStable；
//   - classifyTransition：append-only / planned-invalidation / version-boundary /
//     prefix-violation / hidden-window；
//   - invalidationCount：close+sublime 同组不重复计、promote、fallback-hide；
//   - renderStableAcrossAppend（S8/S9）与 windowStableAfterHidden（C1/v1.2，
//     hiddenRootIds 以 path-prefix + entry.id 过滤 newest-path 隐藏根）；
//   - stablePeriodMedianH / m4Verdict（InvalidationEvents、前缀违规、A 门禁、B/C/D）；
//   - B7 连续 10 step 的 S1–S9 纯守卫覆盖；
//   - F14 已知限制/未收口自述：真实 usage 映射未收口；renderOrderValid 不校验剖面语义。
// 运行：node KazPlugins/kaz-shared/probe-context-cache-guard.mjs
// ===========================================================================

import {
  stableCanonicalText,
  classifyTransition,
  prefixStableAfter,
  invalidationCount,
  systemToolsHashStable,
  surfaceHashStable,
  renderStableAcrossAppend,
  windowStableAfterHidden,
  evaluateCacheSample,
  stablePeriodMedianH,
  m4Verdict,
} from "./lib/context-cache-guard.js";
import {
  createSession,
  append,
  open,
  close,
  render,
} from "./lib/session-tree.js";

// F14：本探针不自称已把尚未收口的能力包装成完成态。
const KNOWN_GAPS = Object.freeze([
  "真实 provider usage 的字段映射尚未用真实 DSH usage 样例收口；本探针只验证纯函数对 A/B/C/D 的语义，不宣称真实采样已完成",
  "renderOrderValid 只校验 flat 顺序（不校验 newest-branch 剖面语义）；剖面语义由 session-tree probe 的 P1-P8 专测",
]);

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

// 小型纯测试工具：坏输入返回 { error }，好输入返回 { session, changes }。
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

function closedRootRound(session, id, summary) {
  let s = opened(session, 1, "round", id);
  s = appended(s, "user", `u:${id}`);
  return run(close(s, { summary })).session;
}

function closeOneRoundScope(session, id, summary) {
  let s = opened(session, 1, "round", id);
  s = appended(s, "user", `u:${id}`);
  return run(close(s, { summary })).session;
}

function approx(a, b, eps = 1e-9) {
  return typeof a === "number" && typeof b === "number" && Math.abs(a - b) < eps;
}

function jsonStableEqual(left, right) {
  const a = stableCanonicalText(left);
  const b = stableCanonicalText(right);
  return !a?.error && !b?.error && a === b;
}

// ---------------------------------------------------------------------------
// ① F1/F10/F11/F13：模块边界、导出面、无运行时注册、无 token 预算
// ---------------------------------------------------------------------------
const EXPECTED_GUARD_EXPORTS = [
  "stableCanonicalText",
  "classifyTransition",
  "prefixStableAfter",
  "invalidationCount",
  "systemToolsHashStable",
  "surfaceHashStable",
  "renderStableAcrossAppend",
  "windowStableAfterHidden",
  "evaluateCacheSample",
  "stablePeriodMedianH",
  "m4Verdict",
];
const FORBIDDEN_RUNTIME_EXPORTS = [
  "register",
  "unregister",
  "cordis",
  "inject",
  "stableMainSurface",
  "registerStableMain",
  "llm",
  "whale_expand",
  "persist",
  "archive",
];
const DELETED_BUDGET_EXPORTS = [
  "MC_trigger",
  "MC_emergency",
  "MC_expand",
  "RawTailBudget",
  "OuterResidentBudget",
];

const guardNs = await import("./lib/context-cache-guard.js");
const publicNs = await import("./lib/tool-lists.js");

check(
  "① F1 预期 11 个 M4 守卫导出全部存在且无多余公共导出",
  EXPECTED_GUARD_EXPORTS.every((name) =>
    Object.prototype.hasOwnProperty.call(guardNs, name),
  ) && Object.keys(guardNs).length === EXPECTED_GUARD_EXPORTS.length,
);
check(
  "① F1/F10 模块命名空间无 cordis/注册/注入/持久化/whale_expand 等运行时接线",
  FORBIDDEN_RUNTIME_EXPORTS.every(
    (name) => !Object.prototype.hasOwnProperty.call(guardNs, name),
  ),
);
check(
  "① F10 设计边界：M4 守卫不进入 tool-lists 公共根/工具面（无运行时注册）",
  EXPECTED_GUARD_EXPORTS.every(
    (name) => !Object.prototype.hasOwnProperty.call(publicNs, name),
  ),
);
check(
  "① F11 直接命名空间与公共命名空间均无已删除 token 触发/保留预算导出",
  DELETED_BUDGET_EXPORTS.every(
    (name) => !Object.prototype.hasOwnProperty.call(guardNs, name),
  ) &&
    DELETED_BUDGET_EXPORTS.every(
      (name) => !Object.prototype.hasOwnProperty.call(publicNs, name),
    ) &&
    !Object.keys(guardNs).some((name) => /token|budget|mc_|trigger/i.test(name)),
);

// ---------------------------------------------------------------------------
// ② stableCanonicalText / prefixStableAfter：稳定序列化与 append-only 前缀
// ---------------------------------------------------------------------------
check(
  "② stableCanonicalText 对象键排序且数组顺序保留",
  stableCanonicalText({ b: 2, a: 1 }) === '{"a":1,"b":2}' &&
    stableCanonicalText([{ b: 2, a: 1 }, { z: true }]) ===
      '[{"a":1,"b":2},{"z":true}]' &&
    stableCanonicalText(null) === "null",
);
check(
  "② stableCanonicalText 非 JSON/循环输入返回统一错误对象",
  stableCanonicalText({ a: undefined })?.error?.code === "invalid-value" &&
    stableCanonicalText(undefined)?.error?.code === "invalid-value" &&
    (() => {
      const cyclic = {};
      cyclic.self = cyclic;
      return stableCanonicalText(cyclic)?.error?.code === "invalid-value";
    })(),
);
check(
  "② prefixStableAfter：旧 entries 是下一 entries 逐项 JSON 前缀即稳定（含键序不同）",
  (() => {
    const result = prefixStableAfter(
      [{ a: 1, b: 2 }],
      [{ b: 2, a: 1 }, { a: 3 }],
    );
    return (
      result.ok === true &&
      result.prefixStable === true &&
      result.commonPrefixCount === 1 &&
      result.nextTotal === 2
    );
  })(),
);
check(
  "② prefixStableAfter：相等也算稳定；被改写/重排旧条目为 prefixStable=false",
  prefixStableAfter([{ a: 1 }], [{ a: 1 }])?.prefixStable === true &&
    (() => {
      const broken = prefixStableAfter([{ a: 1 }], [{ a: 2 }]);
      return (
        broken.ok === true &&
        broken.prefixStable === false &&
        broken.commonPrefixCount === 0
      );
    })(),
);
check(
  "② prefixStableAfter 坏输入返回 invalid-entries",
  prefixStableAfter(null, [])?.error?.code === "invalid-entries" &&
    prefixStableAfter([], undefined)?.error?.code === "invalid-entries",
);

// ---------------------------------------------------------------------------
// ③ F4 S1/S2/C3、S3/C8：system/tools 与 surface 稳定 hash
// ---------------------------------------------------------------------------
const sysToolsBefore = {
  systemText: "stable system",
  tools: [
    { name: "read", description: "read a file" },
    { name: "edit", parameters: { path: { type: "string" } } },
  ],
};
const sysToolsReordered = {
  systemText: "stable system",
  tools: [
    { name: "edit", parameters: { path: { type: "string" } } },
    { name: "read", description: "read a file" },
  ],
};
const sysToolsChangedSystem = {
  ...sysToolsBefore,
  systemText: "changed system",
};
check(
  "③ S1/S2/C3 systemToolsHashStable：相同快照稳定；tools 顺序或 systemText 变化判违规",
  (() => {
    const stableResult = systemToolsHashStable(sysToolsBefore, sysToolsBefore);
    const orderResult = systemToolsHashStable(sysToolsBefore, sysToolsReordered);
    const systemResult = systemToolsHashStable(
      sysToolsBefore,
      sysToolsChangedSystem,
    );
    return (
      stableResult.ok === true &&
      stableResult.stable === true &&
      orderResult.ok === false &&
      orderResult.code === "system-or-tools-hash-changed" &&
      systemResult.ok === false &&
      systemResult.code === "system-or-tools-hash-changed"
    );
  })(),
);
check(
  "③ S3/C8 surfaceHashStable：Persona/Stable Main/Sub Surface 快照不被压缩改写",
  surfaceHashStable(
    { persona: "main", surface: ["read", "edit"] },
    { surface: ["read", "edit"], persona: "main" },
  )?.stable === true &&
    (() => {
      const result = surfaceHashStable(
        { persona: "main", surface: ["read", "edit"] },
        { persona: "changed", surface: ["read", "edit"] },
      );
      return (
        result.ok === false &&
        result.code === "surface-hash-changed" &&
        result.stable === false
      );
    })(),
);
check(
  "③ S1-S3 坏输入按统一错误约定返回，不抛异常",
  systemToolsHashStable(null, {})?.error?.code === "invalid-snapshot" &&
    systemToolsHashStable(
      { systemText: 1, tools: [] },
      { systemText: "x", tools: [] },
    )?.error?.code === "invalid-system-text" &&
    surfaceHashStable(undefined, {})?.error?.code ===
      "invalid-surface-snapshot",
);

// ---------------------------------------------------------------------------
// ④ classifyTransition：过渡分类
// ---------------------------------------------------------------------------
const ENTRY_A = [{ kind: "block", level: 1, id: "a", summary: "s1", order: 1 }];
const ENTRY_A_PLUS_RAW = [
  ...ENTRY_A,
  {
    kind: "current-unclosed-raw",
    level: 0,
    id: "r1",
    seq: 2,
    message: { nodeType: "leaf", id: "r1", seq: 2, kind: "user", content: "tail" },
  },
];
const ENTRY_A_CHANGED = [
  { kind: "block", level: 1, id: "a", summary: "CHANGED", order: 1 },
];

check(
  "④ classifyTransition：无失效/无版本边界且前缀稳定 → append-only",
  (() => {
    const result = classifyTransition(
      { entries: ENTRY_A },
      { entries: ENTRY_A_PLUS_RAW },
    );
    return (
      result.ok === true &&
      result.type === "append-only" &&
      result.classification === "append-only" &&
      result.prefixStable === true &&
      result.commonPrefixCount === 1 &&
      result.nextTotal === 2
    );
  })(),
);
check(
  "④ classifyTransition：无计划内失效但旧条目被改写 → prefix-violation",
  (() => {
    const result = classifyTransition(
      { entries: ENTRY_A },
      { entries: ENTRY_A_CHANGED },
    );
    return (
      result.ok === true &&
      result.type === "prefix-violation" &&
      result.prefixStable === false &&
      result.reason === "entries-prefix-broken"
    );
  })(),
);
check(
  "④ classifyTransition：close / promote / fallback-hide 都归 planned-invalidation",
  classifyTransition(
    { entries: ENTRY_A },
    { entries: [] },
    { changes: [{ type: "close" }] },
  )?.type === "planned-invalidation" &&
    classifyTransition(
      { entries: ENTRY_A },
      { entries: [] },
      { changes: [{ type: "promote" }] },
    )?.plannedKind === "promote" &&
    classifyTransition(
      { entries: ENTRY_A },
      { entries: [] },
      { changes: [{ type: "fallback-hide" }] },
    )?.subtype === "hidden-window",
);
check(
  "④ classifyTransition：hiddenRootIdsChanged 单独触发 hidden-window 计划内失效",
  (() => {
    const result = classifyTransition(
      { entries: ENTRY_A },
      { entries: ENTRY_A_PLUS_RAW },
      { hiddenRootIdsChanged: true },
    );
    return (
      result.ok === true &&
      result.type === "planned-invalidation" &&
      result.plannedKind === "fallback-hide" &&
      result.subtype === "hidden-window"
    );
  })(),
);
check(
  "④ classifyTransition：versionBoundary 优先返回 version-boundary",
  (() => {
    const result = classifyTransition(
      { entries: ENTRY_A },
      { entries: ENTRY_A_CHANGED },
      { versionBoundary: true, changes: [{ type: "close" }] },
    );
    return (
      result.ok === true &&
      result.type === "version-boundary" &&
      result.classification === "version-boundary"
    );
  })(),
);
check(
  "④ classifyTransition：非版本边界内 system/tools hash 变化 → prefix-violation",
  (() => {
    const result = classifyTransition(
      { entries: ENTRY_A },
      { entries: ENTRY_A_PLUS_RAW },
      {
        systemToolsBefore: { systemText: "S1", tools: [] },
        systemToolsAfter: { systemText: "S2", tools: [] },
      },
    );
    return (
      result.ok === true &&
      result.type === "prefix-violation" &&
      result.reason === "system-or-tools-hash-changed" &&
      result.systemToolsStable === false
    );
  })(),
);
check(
  "④ classifyTransition 坏输入返回错误而非抛出",
  classifyTransition(null, { entries: [] })?.code ===
    "invalid-session-or-entries" &&
    classifyTransition(
      { entries: ENTRY_A },
      { entries: ENTRY_A_PLUS_RAW },
      { changes: "bad" },
    )?.error?.code === "invalid-changes",
);

// ---------------------------------------------------------------------------
// ⑤ F5 invalidationCount：close+sublime 同组不重复计 / promote / fallback-hide
// ---------------------------------------------------------------------------
check(
  "⑤ F5 invalidationCount：扁平 close 后 sublime 合并计 1，promote/fallback-hide 各自计",
  (() => {
    const result = invalidationCount([
      { type: "close" },
      { type: "sublime" },
      { type: "promote" },
      { type: "fallback-hide" },
    ]);
    return (
      result.ok === true &&
      result.count === 3 &&
      result.kinds.close === 1 &&
      result.kinds.promote === 1 &&
      result.kinds.fallbackHide === 1 &&
      result.unclassified.length === 0
    );
  })(),
);
check(
  "⑤ F5 invalidationCount：失效组对象与未知组/非对象按 unclassified 处理",
  (() => {
    const result = invalidationCount([
      { id: "g1", kind: "close", changes: [{ type: "close" }, { type: "sublime" }] },
      { kind: "promote", reason: "explicit" },
      { kind: "fallback-hide" },
      { kind: "unknown" },
      42,
    ]);
    return (
      result.ok === true &&
      result.count === 3 &&
      result.kinds.close === 1 &&
      result.kinds.promote === 1 &&
      result.kinds.fallbackHide === 1 &&
      result.unclassified.length === 2
    );
  })(),
);
check(
  "⑤ F5 invalidationCount 坏输入：非数组返回 invalid-groups",
  invalidationCount("bad")?.error?.code === "invalid-groups" &&
    invalidationCount(undefined)?.error?.code === "invalid-groups",
);

// ---------------------------------------------------------------------------
// ⑥ F8/F9 renderStableAcrossAppend：S8/S9 追加后旧条目前缀稳定
// ---------------------------------------------------------------------------
check(
  "⑥ F8/S9 renderStableAcrossAppend：open scope 内 append 只加 raw 尾 → append-only/prefixStable",
  (() => {
    let sessionBefore = run(createSession({ id: "append-stable" })).session;
    sessionBefore = closedRootRound(sessionBefore, "r1", "round 1 summary");
    sessionBefore = opened(sessionBefore, 3, "goal", "live-goal");
    sessionBefore = appended(sessionBefore, "user", "live u1");
    const sessionAfter = appended(sessionBefore, "assistant", "live a2");
    const result = renderStableAcrossAppend(sessionBefore, sessionAfter);
    return (
      result.ok === true &&
      result.prefixStable === true &&
      result.transition === "append-only" &&
      result.orderValidBefore === true &&
      result.orderValidAfter === true &&
      jsonStableEqual(result.entriesBefore[0], result.entriesAfter[0]) &&
      result.entriesBefore[0].role === "old-sibling" &&
      result.entriesAfter.at(-1).kind === "current-unclosed-raw"
    );
  })(),
);
check(
  "⑥ S8/S9 renderStableAcrossAppend：close 作为计划内失效，不被误判为 prefix-violation",
  (() => {
    let session = run(createSession({ id: "close-boundary" })).session;
    session = opened(session, 1, "round", "rb");
    session = appended(session, "user", "inside rb");
    const closeResult = run(close(session, { summary: "rb summary" }));
    const result = renderStableAcrossAppend(session, closeResult.session, {
      changes: closeResult.changes,
    });
    return (
      result.ok === true &&
      result.transition === "planned-invalidation" &&
      result.orderValidBefore === true &&
      result.orderValidAfter === true
    );
  })(),
);
check(
  "⑥ F8/S9 同输入两次 render 逐条目一致；顺序仍过 renderOrderValid",
  (() => {
    let session = run(createSession({ id: "deterministic" })).session;
    session = closedRootRound(session, "d1", "d1 summary");
    session = appended(session, "user", "tail");
    const first = render(session);
    const second = render(session);
    return (
      first.orderValid === true &&
      jsonStableEqual(first.entries, second.entries) &&
      first.stats.outermostBlockCount === 1 &&
      first.stats.currentRawCount === 1
    );
  })(),
);

// ---------------------------------------------------------------------------
// ⑦ F9/B7 压缩边界后连续 10 个 append-only step：S1–S9 纯守卫不回退
// ---------------------------------------------------------------------------
check(
  "⑦ F9/B7 连续 10 个 append-only step：每次 prefixStable、transition=append-only、S1/S2/S3 稳定",
  (() => {
    let session = run(createSession({ id: "b7-ten-steps" })).session;
    session = closedRootRound(session, "b7-r0", "round 0 summary");
    // 最新链保持在 open scope 内：后续 append 只追加 raw 尾，不改变任何 block role/path。
    session = opened(session, 3, "goal", "b7-goal");
    session = opened(session, 2, "planItem", "b7-plan");
    const sysTools = {
      systemText: "b7 system",
      tools: [{ name: "read" }, { name: "edit" }],
    };
    const surface = { persona: "main", stableMain: ["read", "edit"] };
    let ok = true;
    for (let i = 1; i <= 10; i += 1) {
      const before = session;
      session = appended(session, "assistant", `step ${i}`);
      const stable = renderStableAcrossAppend(before, session);
      const sysStable = systemToolsHashStable(sysTools, sysTools);
      const surfaceStable = surfaceHashStable(surface, surface);
      ok =
        ok &&
        stable.ok === true &&
        stable.prefixStable === true &&
        stable.transition === "append-only" &&
        stable.orderValidBefore === true &&
        stable.orderValidAfter === true &&
        sysStable.stable === true &&
        surfaceStable.stable === true;
    }
    return ok;
  })(),
);

// ---------------------------------------------------------------------------
// ⑧ F7/C1/v1.2 windowStableAfterHidden：hiddenRootIds 只影响窗口、树不变、
//    expand 可读；newest-path 隐藏根按 path-prefix 过滤
// ---------------------------------------------------------------------------
let hiddenSession = run(
  createSession({ id: "hidden-window-stable" }),
).session;
for (let i = 1; i <= 3; i += 1) {
  hiddenSession = closedRootRound(hiddenSession, `root-${i}`, `root ${i} summary`);
}
hiddenSession = appended(hiddenSession, "user", "visible-tail");
const rootClosedIds = hiddenSession.rootChildren
  .filter((node) => node.nodeType === "block" && node.state === "closed")
  .map((node) => node.id);
const hiddenId = rootClosedIds[0];

check(
  "⑧ F7 hiddenRootIds 只隐藏直接根级 closed block，且会话内存在",
  rootClosedIds.length === 3 &&
    hiddenSession.rootChildren.length === 4 &&
    rootClosedIds.includes(hiddenId),
);
check(
  "⑧ F7/C1/v1.2 windowStableAfterHidden：完整 Session 不变、窗口两次一致、expand 可读",
  (() => {
    const beforeText = stableCanonicalText(hiddenSession);
    const result = windowStableAfterHidden(hiddenSession, [hiddenId]);
    const afterText = stableCanonicalText(hiddenSession);
    return (
      result.ok === true &&
      result.stable === true &&
      result.classification === "planned-invalidation" &&
      result.subtype === "hidden-window" &&
      result.checks.sessionUnchanged === true &&
      result.checks.windowRenderDeterministic === true &&
      result.checks.orderValidBefore === true &&
      result.checks.orderValidAfter === true &&
      result.checks.hiddenRemovedAndOrderPreserved === true &&
      result.checks.expandReadable === true &&
      beforeText === afterText
    );
  })(),
);
check(
  "⑧ F7 windowStableAfterHidden：隐藏后非隐藏根顺序保留，尾部 append 仍前缀稳定",
  (() => {
    const result = windowStableAfterHidden(hiddenSession, [hiddenId]);
    const windowSession = (() => {
      // 用返回内部执行结果无法拿中间视图，因此直接复用纯 core 语义校验可见窗口。
      // 这里以守卫断言 hiddenRemovedAndOrderPreserved 与 renderStableAcrossAppend
      // 在原始完整会话上 append 的组合验证边界语义。
      return result.ok === true && result.checks.hiddenRemovedAndOrderPreserved;
    })();
    const appendedSession = appended(hiddenSession, "user", "after-hidden-tail");
    const appendResult = renderStableAcrossAppend(hiddenSession, appendedSession);
    return (
      windowSession === true &&
      appendResult.ok === true &&
      appendResult.prefixStable === true &&
      appendResult.transition === "append-only"
    );
  })(),
);
check(
  "⑧ F7 windowStableAfterHidden：非法/重复/非直接根 closed block 的 hiddenRootIds 被拒",
  windowStableAfterHidden(hiddenSession, ["missing-root"])?.error?.code ===
    "invalid-hidden-root-id" &&
    windowStableAfterHidden(hiddenSession, [hiddenId, hiddenId])?.error?.code ===
      "invalid-hidden-root-ids" &&
    windowStableAfterHidden(hiddenSession, ["visible-tail"])?.error?.code ===
      "invalid-hidden-root-id",
);
check(
  "⑧ F7/C1/v1.2 windowStableAfterHidden path-prefix：隐藏唯一 newest-path 根会滤除其全部 path 前缀子块",
  (() => {
    let s = run(createSession({ id: "hidden-newest-path" })).session;
    s = opened(s, 3, "goal", "latestGoal");
    s = opened(s, 2, "planItem", "latestGoal-oldPi");
    s = closeOneRoundScope(s, "latestGoal-oldPi-oldRound", "latestGoal-oldPi-oldRound summary");
    s = run(close(s, { summary: "latestGoal-oldPi planItem summary" })).session;
    s = opened(s, 2, "planItem", "latestGoal-newestPi");
    s = closeOneRoundScope(s, "newestPi-oldRound", "newestPi-oldRound summary");
    s = closeOneRoundScope(s, "newestPi-newestRound", "newestPi-newestRound summary");
    s = run(close(s, { summary: "latestGoal-newestPi planItem summary" })).session;
    s = run(close(s, { summary: "latestGoal goal summary" })).session;
    const hidden = "latestGoal";
    const fullRender = run(render(s));
    const hiddenDescendantCount = fullRender.entries.filter(
      (entry) =>
        typeof entry?.path === "string" &&
        (entry.path === hidden || entry.path.startsWith(`${hidden}/`)),
    ).length;
    const result = windowStableAfterHidden(s, [hidden]);
    return (
      fullRender.entries.some(
        (entry) => entry.kind === "block" && entry.id === "latestGoal",
      ) &&
      hiddenDescendantCount > 1 &&
      result.ok === true &&
      result.stable === true &&
      result.classification === "planned-invalidation" &&
      result.subtype === "hidden-window" &&
      result.checks.hiddenRemovedAndOrderPreserved === true &&
      result.checks.orderValidBefore === true &&
      result.checks.orderValidAfter === true &&
      result.checks.expandReadable === true
    );
  })(),
);

// ---------------------------------------------------------------------------
// ⑨ F2/F3 A/B/C/D + H_full / H_read_proxy / cache_unmeasurable
// ---------------------------------------------------------------------------
check(
  "⑨ F2 A 类完整字段：evaluateCacheSample 用 hFull 且 measurement=h-full",
  (() => {
    const result = evaluateCacheSample({
      usage: { uncached: 9, cacheRead: 1, cacheWrite: 0 },
    });
    return (
      result.ok === true &&
      result.scenario === "A" &&
      result.measurement === "h-full" &&
      result.h === 0.1 &&
      result.hFull === 0.1 &&
      jsonStableEqual(result.usage, {
        uncached: 9,
        cacheRead: 1,
        cacheWrite: 0,
      })
    );
  })(),
);
check(
  "⑨ F2 B 类无 cacheWrite 字段：evaluateCacheSample 用 hReadProxy 代理，不宣称硬门禁",
  (() => {
    const result = evaluateCacheSample({
      usage: { uncached: 1, cacheRead: 9 },
    });
    return (
      result.ok === true &&
      result.scenario === "B" &&
      result.measurement === "h-read-proxy" &&
      result.h === 0.9 &&
      result.hReadProxy === 0.9
    );
  })(),
);
check(
  "⑨ F2/F3 C/D 类：显式 cache_unmeasurable，不参与达标判定",
  (() => {
    const c = evaluateCacheSample({
      usage: { uncached: 1 },
    });
    const d = evaluateCacheSample({ usage: {} });
    const explicitD = evaluateCacheSample({ scenario: "D" });
    return (
      c.ok === true &&
      c.scenario === "C" &&
      c.measurement === "cache_unmeasurable" &&
      c.h === null &&
      d.ok === true &&
      d.scenario === "D" &&
      d.measurement === "cache_unmeasurable" &&
      d.h === null &&
      explicitD.ok === true &&
      explicitD.scenario === "D" &&
      explicitD.h === null
    );
  })(),
);
check(
  "⑨ F3 H 值只作事后测量：结果不含 MC/token/budget/trigger 触发字段",
  (() => {
    const result = evaluateCacheSample({
      usage: { uncached: 1, cacheRead: 9, cacheWrite: 0 },
    });
    const text = JSON.stringify(result);
    return (
      result.ok === true &&
      !/token|budget|mc_|trigger/i.test(text)
    );
  })(),
);
check(
  "⑨ F2 坏输入：evaluateCacheSample 拒绝非对象 sample / 非对象 usage",
  evaluateCacheSample(null)?.error?.code === "invalid-sample" &&
    evaluateCacheSample({ usage: "bad" })?.error?.code === "invalid-usage",
);

// ---------------------------------------------------------------------------
// ⑩ stablePeriodMedianH / m4Verdict：稳定期中位、InvalidationEvents、A 门禁
// ---------------------------------------------------------------------------
check(
  "⑩ stablePeriodMedianH：计划内失效后重置，仅统计其后 ≥3 append-only A 样本",
  (() => {
    const rows = [
      {
        transition: "append-only",
        scenario: "A",
        h: 0.9,
        prefixStable: true,
        systemToolsStable: true,
      },
      {
        transition: "planned-invalidation",
        scenario: "A",
        h: 0.4,
        prefixStable: false,
        systemToolsStable: false,
      },
      {
        transition: "append-only",
        scenario: "A",
        h: 0.6,
        prefixStable: true,
        systemToolsStable: true,
      },
      {
        transition: "append-only",
        scenario: "A",
        h: 0.7,
        prefixStable: true,
        systemToolsStable: true,
      },
      {
        transition: "append-only",
        scenario: "A",
        h: 0.8,
        prefixStable: true,
        systemToolsStable: true,
      },
    ];
    const result = stablePeriodMedianH(rows);
    return (
      result.ok === true &&
      result.appendOnlyCount === 4 &&
      result.plannedInvalidationCount === 1 &&
      result.stablePeriodCount === 3 &&
      approx(result.medianHFull, 0.7) &&
      approx(result.medianH, 0.7)
    );
  })(),
);
check(
  "⑩ stablePeriodMedianH：B 给代理中位，C/D 显式 unmeasurable，prefix-violation 独立计数",
  (() => {
    const rows = [
      {
        transition: "prefix-violation",
        scenario: "A",
        h: 0.99,
        prefixStable: false,
        systemToolsStable: false,
      },
      {
        transition: "append-only",
        scenario: "B",
        h: 0.7,
        prefixStable: true,
        systemToolsStable: true,
      },
      {
        transition: "append-only",
        scenario: "C",
        h: null,
        prefixStable: true,
        systemToolsStable: true,
      },
      {
        transition: "append-only",
        scenario: "D",
        h: null,
        prefixStable: true,
        systemToolsStable: true,
      },
    ];
    const result = stablePeriodMedianH(rows);
    return (
      result.ok === true &&
      result.prefixViolationCount === 1 &&
      result.appendOnlyCount === 3 &&
      result.medianHReadProxy === 0.7 &&
      result.bMedianHReadProxy === 0.7 &&
      result.unmeasurableCount === 2 &&
      result.medianHFull === null
    );
  })(),
);
check(
  "⑩ F5/F6 m4Verdict：InvalidationEvents/前缀违规/A 门禁/B/C/D 摘要正确 → PASS",
  (() => {
    const result = m4Verdict([
      { type: "planned-invalidation", kind: "close" },
      {
        transition: "append-only",
        scenario: "A",
        h: 0.95,
        prefixStable: true,
        systemToolsStable: true,
      },
      {
        transition: "append-only",
        scenario: "A",
        h: 0.93,
        prefixStable: true,
        systemToolsStable: true,
      },
      {
        transition: "append-only",
        scenario: "A",
        h: 0.91,
        prefixStable: true,
        systemToolsStable: true,
      },
      {
        transition: "append-only",
        scenario: "B",
        h: 0.6,
        prefixStable: true,
        systemToolsStable: true,
      },
      { scenario: "C" },
      { scenario: "D" },
    ]);
    return (
      result.ok === true &&
      result.invalidationEvents === 1 &&
      result.plannedInvalidationCount === 1 &&
      result.prefixViolations === 0 &&
      result.appendOnlyCount === 4 &&
      result.a.count === 3 &&
      result.a.gatePassed === true &&
      result.aGatePassed === true &&
      result.b.count === 1 &&
      result.b.proxyOnly === true &&
      result.c.count === 1 &&
      result.d.count === 1 &&
      result.verdict === "PASS"
    );
  })(),
);
check(
  "⑩ F6 m4Verdict：前缀违规 >0 → FAIL，计入 prefixViolations",
  (() => {
    const result = m4Verdict([
      { transition: "prefix-violation", prefixStable: false },
      {
        transition: "append-only",
        scenario: "A",
        h: 0.99,
        prefixStable: true,
        systemToolsStable: true,
      },
    ]);
    return (
      result.ok === true &&
      result.prefixViolations === 1 &&
      result.prefixViolationCount === 1 &&
      result.verdict === "FAIL"
    );
  })(),
);
check(
  "⑩ C5/F6 m4Verdict：A 类中位 <90% 硬门禁 → FAIL；空记录 → INCONCLUSIVE",
  (() => {
    const low = m4Verdict([
      {
        transition: "append-only",
        scenario: "A",
        h: 0.8,
        prefixStable: true,
        systemToolsStable: true,
      },
    ]);
    const empty = m4Verdict([]);
    return (
      low.ok === true &&
      low.a.medianHFull === 0.8 &&
      low.a.gatePassed === false &&
      low.verdict === "FAIL" &&
      empty.ok === true &&
      empty.verdict === "INCONCLUSIVE"
    );
  })(),
);
check(
  "⑩ m4Verdict 坏输入：非数组返回 invalid-records",
  m4Verdict(null)?.error?.code === "invalid-records" &&
    m4Verdict("bad")?.error?.code === "invalid-records",
);

// ---------------------------------------------------------------------------
// ⑪ F14：已知限制/未收口自述（newest-branch 投影已落地，故不再列为缺口）
// ---------------------------------------------------------------------------
check(
  "⑪ F14 已移除 newest-branch 投影未落地缺口；保留 usage 未收口与 renderOrderValid 语义边界",
  KNOWN_GAPS.length === 2 &&
    KNOWN_GAPS[0].includes("usage") &&
    KNOWN_GAPS[1].includes("renderOrderValid") &&
    KNOWN_GAPS[1].includes("P1-P8") &&
    KNOWN_GAPS.every((gap) => typeof gap === "string" && gap.length > 0) &&
    !KNOWN_GAPS.some(
      (gap) =>
        gap.includes("尚未落地") ||
        (gap.includes("newest-branch") && gap.includes("投影")),
    ),
);
console.log(
  "\n[F14 known gaps]\n" +
    KNOWN_GAPS.map((gap, index) => `  ${index + 1}. ${gap}`).join("\n"),
);

if (failures === 0) {
  console.log("\nCONTEXT-CACHE-GUARD PROBE OK");
  process.exit(0);
} else {
  console.error(`\nCONTEXT-CACHE-GUARD PROBE FAILED: ${failures}`);
  process.exit(1);
}
