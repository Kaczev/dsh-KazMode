// kaz-shared —— Kaz7.0 M1 纯 ESM 树形会话模型（内存纯模块，零 I/O，无运行时接线）
// ===========================================================================
// 依据：不入库文件/Kaz7.0更新规划/Kaz7.0-M1树形会话模型设计报告.md
// 冻结决策：
//   * append/open/close/promote 是不可变 reducer，返回 { session, changes }；
//   * open 禁止嵌套同级/更高层 scope；close 必须 LIFO；
//   * close 与显式 promote 必须提供非空 summary；本模块不内嵌 LLM/自动语义摘要。
//     close 可额外传 autoPromoteSummary 指定升华父块摘要；缺省用已显式提供的
//     子块 summary 做确定性组合（不读原信息、不接 LLM）。
//   * 自动升华只发生在 close 后，作用于同一容器的“最老连续同层 closed 兄弟组”；
//   * 根容器容量无限；open scope level=M 的容量为 M-1；closed block 内部不升华；
//   * SUBLIMATION_THRESHOLD 只从 context-compress.js 引用，不在此复制；
//   * 不设 token 预算/触发字段，不注册 cordis、不接 DSH 运行时。
// 错误约定：坏输入返回 { error: { code, message } }，不抛异常。
// ===========================================================================

import {
  SUBLIMATION_THRESHOLD,
  renderOrderValid,
} from "./context-compress.js";

const DEFAULT_SCHEMA_VERSION = "kaz-context-session/1";
const MESSAGE_KINDS = new Set([
  "user",
  "assistant",
  "tool",
  "injection",
  "subagent_report",
]);
const NATURAL_LEVEL_BOUNDARIES = Object.freeze({
  1: "round",
  2: "planItem",
  3: "goal",
});

// ---------------------------------------------------------------------------
// 小型校验 / 错误工具
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isSession(value) {
  return (
    isPlainObject(value) &&
    typeof value.schemaVersion === "string" &&
    typeof value.id === "string" &&
    Number.isInteger(value.nextSeq) &&
    value.nextSeq >= 0 &&
    Number.isInteger(value.nextId) &&
    value.nextId >= 1 &&
    Array.isArray(value.rootChildren)
  );
}

function errorResult(code, message) {
  return { error: { code, message } };
}

function tryCatch(fn) {
  try {
    return fn();
  } catch (err) {
    return errorResult(
      "internal-error",
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ---------------------------------------------------------------------------
// 树内定位 / 不可变路径更新
// ---------------------------------------------------------------------------

/**
 * 定位“当前可写位置”以及 open scope 栈。
 * 返回：
 *   containerChildren —— 最深 open scope 的 children；无 open scope 时为 rootChildren；
 *   stack            —— 从根到最深 open scope 的 { parentChildren, index, scope }。
 */
function locateWritable(session) {
  const stack = [];
  let children = session.rootChildren;
  for (;;) {
    let index = -1;
    for (let i = children.length - 1; i >= 0; i -= 1) {
      if (children[i]?.nodeType === "scope") {
        index = i;
        break;
      }
    }
    if (index === -1) return { containerChildren: children, stack };
    const scope = children[index];
    stack.push({ parentChildren: children, index, scope });
    children = scope.children;
  }
}

function pathText(ids) {
  return ids.join("/");
}

function nodeAtPath(children, path) {
  let current = children;
  for (const index of path) {
    const node = current[index];
    if (!node) return undefined;
    current = node.children;
  }
  return current;
}

function replacePath(children, path, depth, updater) {
  if (depth === path.length) return updater(children);
  const index = path[depth];
  const node = children[index];
  if (!node || node.nodeType !== "scope") {
    // 路径只允许穿过 open scope；其它路径表示会话结构已损坏。
    return children;
  }
  const newChild = {
    ...node,
    children: replacePath(node.children, path, depth + 1, updater),
  };
  return children.map((child, i) => (i === index ? newChild : child));
}

function updateChildrenAtPath(session, path, updater) {
  const nextRootChildren = replacePath(session.rootChildren, path, 0, updater);
  return { ...session, rootChildren: nextRootChildren };
}

function childrenAtPath(session, path) {
  return nodeAtPath(session.rootChildren, path) ?? session.rootChildren;
}

function containerKindAtPath(session, path) {
  if (path.length === 0) return { kind: "root", level: Infinity };
  const parentNode = nodeAtPath(session.rootChildren, path.slice(0, -1))?.[path[path.length - 1]];
  if (parentNode?.nodeType === "scope") {
    return { kind: "scope", level: parentNode.level };
  }
  return { kind: "unknown", level: 0 };
}

function allNodeIds(session) {
  const out = new Set();
  const walk = (children) => {
    for (const node of children) {
      if (!node || typeof node.id !== "string") continue;
      out.add(node.id);
      if (node.nodeType === "block") {
        walk(node.children); // block 内部是已落定内容，但仍需防止 id 冲突
      } else if (node.nodeType === "scope") {
        walk(node.children);
      }
    }
  };
  walk(session.rootChildren);
  return out;
}

// ---------------------------------------------------------------------------
// 节点构造 / 指纹
// ---------------------------------------------------------------------------

function defaultLeafId(nextId) {
  return `ev-${String(nextId).padStart(6, "0")}`;
}

function defaultScopeId(nextId) {
  return `scope-${String(nextId).padStart(6, "0")}`;
}

function defaultSublimedId(nextId) {
  return `sublimed-${String(nextId).padStart(6, "0")}`;
}

function nodeFingerprint(node) {
  if (node?.nodeType === "leaf") return `leaf:${node.id}:${node.seq}`;
  if (node?.nodeType === "block") return node.fingerprint;
  return `scope:${node?.id ?? "?"}`;
}

function blockFingerprint({ level, summary, children }) {
  return `block:${level}:${summary}:${(children ?? [])
    .map(nodeFingerprint)
    .join(",")}`;
}

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

export function createSession(options = {}) {
  return tryCatch(() => {
    if (options === undefined || options === null) options = {};
    if (!isPlainObject(options)) {
      return errorResult("invalid-options", "createSession options must be an object");
    }
    if (options.id !== undefined && typeof options.id !== "string") {
      return errorResult("invalid-id", "session id must be a string");
    }
    if (
      options.schemaVersion !== undefined &&
      typeof options.schemaVersion !== "string"
    ) {
      return errorResult("invalid-schema-version", "schemaVersion must be a string");
    }
    const session = {
      schemaVersion: options.schemaVersion ?? DEFAULT_SCHEMA_VERSION,
      id: options.id ?? "session-1",
      nextSeq: 1,
      nextId: 1,
      rootChildren: [],
    };
    return {
      session,
      changes: [{ type: "create", sessionId: session.id }],
    };
  });
}

// ---------------------------------------------------------------------------
// append
// ---------------------------------------------------------------------------

export function append(session, event) {
  return tryCatch(() => {
    if (!isSession(session)) {
      return errorResult("invalid-session", "append requires a valid session");
    }
    if (!isPlainObject(event)) {
      return errorResult("invalid-event", "event must be an object");
    }
    if (!MESSAGE_KINDS.has(event.kind)) {
      return errorResult(
        "invalid-kind",
        `kind must be one of: ${[...MESSAGE_KINDS].join(", ")}`,
      );
    }
    if (event.id !== undefined && typeof event.id !== "string") {
      return errorResult("invalid-event-id", "event id must be a string");
    }
    if (event.meta !== undefined && !isPlainObject(event.meta)) {
      return errorResult("invalid-event-meta", "event meta must be an object");
    }
    if (event.sourceRef !== undefined && typeof event.sourceRef !== "string") {
      return errorResult("invalid-source-ref", "sourceRef must be a string");
    }
    const taken = allNodeIds(session);
    const leafId = event.id ?? defaultLeafId(session.nextId);
    if (taken.has(leafId)) {
      return errorResult("duplicate-id", `id already exists in session: ${leafId}`);
    }

    const leaf = {
      nodeType: "leaf",
      id: leafId,
      seq: session.nextSeq,
      kind: event.kind,
      content: event.content,
    };
    if (event.sourceRef !== undefined) leaf.sourceRef = event.sourceRef;
    if (event.meta !== undefined) leaf.meta = event.meta;

    const writable = locateWritable(session);
    const scopeIds = writable.stack.map((entry) => entry.scope.id);
    const path = [...scopeIds, leaf.id];
    const pathToContainer = writable.stack.map((entry) => entry.index);

    let nextSession = updateChildrenAtPath(session, pathToContainer, (children) => [
      ...children,
      leaf,
    ]);
    nextSession = { ...nextSession, nextSeq: nextSession.nextSeq + 1 };
    if (event.id === undefined) {
      nextSession = { ...nextSession, nextId: nextSession.nextId + 1 };
    }
    return {
      session: nextSession,
      changes: [{ type: "append", leafId, path: pathText(path) }],
    };
  });
}

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

export function open(session, spec) {
  return tryCatch(() => {
    if (!isSession(session)) {
      return errorResult("invalid-session", "open requires a valid session");
    }
    if (!isPlainObject(spec)) {
      return errorResult("invalid-spec", "open spec must be an object");
    }
    const { level, boundary } = spec;
    if (!Object.prototype.hasOwnProperty.call(NATURAL_LEVEL_BOUNDARIES, level)) {
      return errorResult("invalid-level", "open level must be 1, 2 or 3");
    }
    if (boundary !== NATURAL_LEVEL_BOUNDARIES[level]) {
      return errorResult(
        "invalid-boundary",
        `boundary for level ${level} must be "${NATURAL_LEVEL_BOUNDARIES[level]}"`,
      );
    }
    if (spec.id !== undefined && typeof spec.id !== "string") {
      return errorResult("invalid-scope-id", "scope id must be a string");
    }
    if (spec.meta !== undefined && !isPlainObject(spec.meta)) {
      return errorResult("invalid-scope-meta", "scope meta must be an object");
    }

    const writable = locateWritable(session);
    const deepest = writable.stack[writable.stack.length - 1];
    if (deepest && level >= deepest.scope.level) {
      return errorResult(
        "scope-level-violation",
        `cannot open level ${level} inside open level ${deepest.scope.level}; inner scope must be strictly lower`,
      );
    }

    const taken = allNodeIds(session);
    const scopeId = spec.id ?? defaultScopeId(session.nextId);
    if (taken.has(scopeId)) {
      return errorResult("duplicate-id", `id already exists in session: ${scopeId}`);
    }

    const scope = {
      nodeType: "scope",
      id: scopeId,
      level,
      boundary,
      children: [],
      openedSeq: session.nextSeq,
    };
    if (spec.meta !== undefined) scope.meta = spec.meta;

    const scopeIds = writable.stack.map((entry) => entry.scope.id);
    const pathToContainer = writable.stack.map((entry) => entry.index);
    const nextPath = pathText([...scopeIds, scopeId]);

    let nextSession = updateChildrenAtPath(session, pathToContainer, (children) => [
      ...children,
      scope,
    ]);
    if (spec.id === undefined) {
      nextSession = { ...nextSession, nextId: nextSession.nextId + 1 };
    }
    return {
      session: nextSession,
      changes: [{ type: "open", scopeId, path: nextPath }],
    };
  });
}

// ---------------------------------------------------------------------------
// close（含 close 后自动升华）
// ---------------------------------------------------------------------------

function composeAutoPromoteSummary(blocks) {
  const summaries = blocks.map((block) => block.summary).filter(isNonEmptyString);
  if (summaries.length === 0) {
    return `[sublimed ${blocks.length} blocks]`;
  }
  return summaries.join(" | ");
}

function canPromoteInContainer(container, childLevel) {
  const capacity = container.kind === "root" ? Infinity : container.level - 1;
  return childLevel + 1 <= capacity;
}

function containerCapacityText(container) {
  return container.kind === "root" ? "root" : `scope-level-${container.level}`;
}

function findOldestPromotableRun(children, container) {
  let start = -1;
  let level = 0;
  const flush = (runStart, runEnd, runLevel) => {
    const length = runEnd - runStart + 1;
    if (length >= SUBLIMATION_THRESHOLD && canPromoteInContainer(container, runLevel)) {
      return { start: runStart, count: SUBLIMATION_THRESHOLD, level: runLevel };
    }
    return null;
  };
  for (let i = 0; i <= children.length; i += 1) {
    const node = children[i];
    const isRunNode =
      node?.nodeType === "block" &&
      node.state === "closed" &&
      typeof node.level === "number";
    if (isRunNode && start !== -1 && node.level === level) {
      continue; // run continues
    }
    if (isRunNode && start === -1) {
      start = i;
      level = node.level;
      continue;
    }
    // run ended (or non-run node encountered)
    if (start !== -1) {
      const hit = flush(start, i - 1, level);
      if (hit) return hit;
    }
    if (isRunNode) {
      start = i;
      level = node.level;
    } else {
      start = -1;
      level = 0;
    }
  }
  return null;
}

function promoteRun(session, containerPath, runStart, runCount, summary, summarySourceIds) {
  const children = childrenAtPath(session, containerPath);
  const blocks = children.slice(runStart, runStart + runCount);
  const firstBlock = blocks[0];
  const lastBlock = blocks[blocks.length - 1];
  const parentLevel = firstBlock.level + 1;
  const blockId = defaultSublimedId(session.nextId);
  const parentBlock = {
    nodeType: "block",
    id: blockId,
    level: parentLevel,
    boundary: "sublimed",
    state: "closed",
    summary,
    summarySourceIds: summarySourceIds?.length ? summarySourceIds : blocks.map((b) => b.id),
    children: blocks,
    openedSeq: firstBlock.openedSeq,
    closedSeq: lastBlock.closedSeq,
    orderSeq: firstBlock.orderSeq,
    fingerprint: blockFingerprint({
      level: parentLevel,
      summary,
      children: blocks,
    }),
  };
  const nextChildren = [
    ...children.slice(0, runStart),
    parentBlock,
    ...children.slice(runStart + runCount),
  ];
  const nextSession = {
    ...updateChildrenAtPath(session, containerPath, () => nextChildren),
    nextId: session.nextId + 1,
  };
  return {
    session: nextSession,
    changes: [
      {
        type: "sublime",
        parentBlockId: blockId,
        childIds: blocks.map((b) => b.id),
        level: parentLevel,
      },
    ],
  };
}

function applyAutoPromotions(session, containerPath, container, summaryOverride) {
  let current = session;
  const extraChanges = [];
  for (;;) {
    const children = childrenAtPath(current, containerPath);
    const run = findOldestPromotableRun(children, container);
    if (!run) break;
    const runBlocks = children.slice(run.start, run.start + run.count);
    const summary =
      summaryOverride ?? composeAutoPromoteSummary(runBlocks);
    const promoted = promoteRun(
      current,
      containerPath,
      run.start,
      run.count,
      summary,
      runBlocks.map((b) => b.id),
    );
    current = promoted.session;
    extraChanges.push(...promoted.changes);
  }
  return { session: current, changes: extraChanges };
}

export function close(session, opts = {}) {
  return tryCatch(() => {
    if (!isSession(session)) {
      return errorResult("invalid-session", "close requires a valid session");
    }
    if (!isPlainObject(opts)) {
      return errorResult("invalid-opts", "close opts must be an object");
    }
    if (!isNonEmptyString(opts.summary)) {
      return errorResult(
        "summary-required",
        "close requires a non-empty string summary",
      );
    }
    if (
      opts.autoPromoteSummary !== undefined &&
      !isNonEmptyString(opts.autoPromoteSummary)
    ) {
      return errorResult(
        "auto-promote-summary-invalid",
        "autoPromoteSummary must be a non-empty string when provided",
      );
    }

    const writable = locateWritable(session);
    const deepestEntry = writable.stack[writable.stack.length - 1];
    if (!deepestEntry) {
      return errorResult("no-open-scope", "close requires an open scope (LIFO)");
    }
    const { scope, index } = deepestEntry;
    if (opts.scopeId !== undefined && opts.scopeId !== scope.id) {
      return errorResult(
        "scope-mismatch",
        `scopeId must be the innermost open scope (${scope.id}); got ${opts.scopeId}`,
      );
    }
    if (opts.boundary !== undefined && opts.boundary !== scope.boundary) {
      return errorResult(
        "boundary-mismatch",
        `boundary must match innermost open scope (${scope.boundary})`,
      );
    }
    if (scope.children.length === 0) {
      return errorResult(
        "empty-scope-close",
        "cannot close an empty scope into a block",
      );
    }

    const parentPath = writable.stack
      .slice(0, -1)
      .map((entry) => entry.index);
    const container = containerKindAtPath(session, parentPath);
    const closePath = writable.stack.map((entry) => entry.scope.id);

    const block = {
      nodeType: "block",
      id: scope.id,
      level: scope.level,
      boundary: scope.boundary,
      state: "closed",
      summary: opts.summary,
      summarySourceIds: scope.children.map((child) => child.id),
      children: scope.children,
      openedSeq: scope.openedSeq,
      closedSeq: session.nextSeq,
      orderSeq: session.nextSeq,
      fingerprint: blockFingerprint({
        level: scope.level,
        summary: opts.summary,
        children: scope.children,
      }),
    };

    let nextSession = updateChildrenAtPath(session, parentPath, (children) => [
      ...children.slice(0, index),
      block,
      ...children.slice(index + 1),
    ]);

    const changes = [
      {
        type: "close",
        blockId: block.id,
        path: pathText(closePath),
        level: block.level,
        boundary: block.boundary,
      },
    ];

    const auto = applyAutoPromotions(
      nextSession,
      parentPath,
      container,
      opts.autoPromoteSummary,
    );
    nextSession = auto.session;
    changes.push(...auto.changes);

    return { session: nextSession, changes };
  });
}

// ---------------------------------------------------------------------------
// promote（显式升华；自动升华内部复用 promoteRun）
// ---------------------------------------------------------------------------

function findContainerPathForSiblingIds(session, siblingIds) {
  const findInChildren = (children, inheritedPath) => {
    if (siblingIds.every((id) => children.some((node) => node?.id === id))) {
      return inheritedPath;
    }
    for (let i = 0; i < children.length; i += 1) {
      const node = children[i];
      if (node?.nodeType === "scope") {
        const found = findInChildren(node.children, [...inheritedPath, i]);
        if (found) return found;
      }
    }
    return null;
  };
  return findInChildren(session.rootChildren, []);
}

export function promote(session, spec) {
  return tryCatch(() => {
    if (!isSession(session)) {
      return errorResult("invalid-session", "promote requires a valid session");
    }
    if (!isPlainObject(spec)) {
      return errorResult("invalid-spec", "promote spec must be an object");
    }
    if (!isNonEmptyString(spec.summary)) {
      return errorResult(
        "summary-required",
        "promote requires a non-empty string summary",
      );
    }
    if (!Array.isArray(spec.siblingIds) || spec.siblingIds.length === 0) {
      return errorResult("invalid-sibling-ids", "siblingIds must be a non-empty array");
    }
    if (
      spec.summarySourceIds !== undefined &&
      (!Array.isArray(spec.summarySourceIds) ||
        spec.summarySourceIds.some((id) => typeof id !== "string"))
    ) {
      return errorResult(
        "invalid-summary-source-ids",
        "summarySourceIds must be an array of strings",
      );
    }
    const seen = new Set();
    for (const id of spec.siblingIds) {
      if (typeof id !== "string") {
        return errorResult("invalid-sibling-ids", "each siblingId must be a string");
      }
      if (seen.has(id)) {
        return errorResult("duplicate-sibling-id", `duplicate sibling id: ${id}`);
      }
      seen.add(id);
    }
    if (spec.siblingIds.length < SUBLIMATION_THRESHOLD) {
      return errorResult(
        "below-sublimation-threshold",
        `promote requires at least ${SUBLIMATION_THRESHOLD} closed siblings`,
      );
    }

    const containerPath = findContainerPathForSiblingIds(session, spec.siblingIds);
    if (!containerPath) {
      return errorResult(
        "siblings-not-same-parent",
        "siblingIds must all be direct children of the same container",
      );
    }
    const container = containerKindAtPath(session, containerPath);
    if (container.kind === "unknown") {
      return errorResult("invalid-container", "promote container must be root or an open scope");
    }
    const children = childrenAtPath(session, containerPath);
    const indexes = spec.siblingIds.map((id) => children.findIndex((n) => n?.id === id));
    if (indexes.some((i) => i === -1)) {
      return errorResult("sibling-not-found", "one or more siblingIds were not found");
    }
    const sorted = [...indexes].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i] !== sorted[i - 1] + 1) {
        return errorResult(
          "siblings-not-contiguous",
          "promote siblings must be a contiguous run of the same parent",
        );
      }
    }
    const blocks = sorted.map((i) => children[i]);
    if (
      blocks.some(
        (b) =>
          b.nodeType !== "block" ||
          b.state !== "closed" ||
          !Number.isInteger(b.level),
      )
    ) {
      return errorResult("invalid-sibling", "all siblings must be closed blocks");
    }
    const firstLevel = blocks[0].level;
    if (blocks.some((b) => b.level !== firstLevel)) {
      return errorResult(
        "level-mismatch",
        "all promoted siblings must have the same level",
      );
    }
    if (!canPromoteInContainer(container, firstLevel)) {
      return errorResult(
        "container-capacity",
        `cannot promote level ${firstLevel} inside ${containerCapacityText(container)}`,
      );
    }

    return promoteRun(
      session,
      containerPath,
      sorted[0],
      sorted.length,
      spec.summary,
      spec.summarySourceIds,
    );
  });
}

// ---------------------------------------------------------------------------
// render（只读；最新分支剖面 newest-branch profile）
// ---------------------------------------------------------------------------
// 剖面规则（Kaz7.0-M1最新分支剖面渲染设计报告）：
//   * 每个容器只展开最右（newest）直接 child；其它 closed block 只给
//     old-sibling summary，绝不递归；
//   * open scope 透明：不输出 scope 条目，只进入其 children；
//   * root/open scope 内的未闭合 leaf 是 current-unclosed-raw；closed block
//     内部的历史 leaf 永不常驻；
//   * 沿自然 Goal/planItem 链下钻；round / sublimed / historical-leaf /
//     no-children 是停止点；
//   * entries 顺序仍兼容 context-compress.renderOrderValid。
// ---------------------------------------------------------------------------

function profileBlockEntry(node, ancestors, role) {
  const path = pathText([...ancestors, node.id]);
  return {
    kind: "block",
    role,
    level: node.level,
    id: node.id,
    boundary: node.boundary,
    summary: node.summary,
    order: node.orderSeq,
    path,
    depth: path.length === 0 ? 0 : path.split("/").length,
  };
}

function profileRawEntry(node, ancestors) {
  return {
    kind: "current-unclosed-raw",
    level: 0,
    id: node.id,
    seq: node.seq,
    path: pathText(ancestors),
    message: node,
  };
}

function profileStop(kind, id, path, reason) {
  return { kind, id, path, reason };
}

/**
 * 沿最新分支剖面收集 block/raw entries，并记录最终下钻停止点。
 * mode: { open, kind: "root"|"scope"|"block", id?, path? }；
 * ancestors 是当前容器从根起的节点 id 链（含透明 scope 与已下钻 block）。
 */
function walkProfile(children, mode, ancestors, state) {
  if (!Array.isArray(children) || children.length === 0) {
    if (!state.stoppedAt) {
      if (mode.kind === "scope") {
        state.stoppedAt = profileStop("scope", mode.id, mode.path, "no-children");
      } else if (mode.kind === "block") {
        state.stoppedAt = profileStop("block", mode.id, mode.path, "no-children");
      } else {
        state.stoppedAt = profileStop("empty", null, "", "no-children");
      }
    }
    return;
  }

  const lastIndex = children.length - 1;
  for (let i = 0; i < lastIndex; i += 1) {
    const node = children[i];
    if (!node || typeof node !== "object") continue;
    if (node.nodeType === "block") {
      state.oldSiblingEntries.push(profileBlockEntry(node, ancestors, "old-sibling"));
    } else if (node.nodeType === "leaf" && mode.open) {
      state.rawEntries.push(profileRawEntry(node, ancestors));
    }
    // 合法 Session 不允许旧 sibling open scope；此处不猜测、不递归。
  }

  const newest = children[lastIndex];
  if (!newest || typeof newest !== "object") {
    if (!state.stoppedAt) {
      state.stoppedAt = profileStop("empty", null, pathText(ancestors), "no-children");
    }
    return;
  }

  if (newest.nodeType === "leaf") {
    if (mode.open) state.rawEntries.push(profileRawEntry(newest, ancestors));
    state.stoppedAt = profileStop(
      "leaf",
      newest.id,
      pathText([...ancestors, newest.id]),
      mode.open ? "current-raw" : "closed-leaf",
    );
    return;
  }

  if (newest.nodeType === "scope") {
    if (mode.open) {
      const scopePath = pathText([...ancestors, newest.id]);
      walkProfile(
        newest.children,
        { open: true, kind: "scope", id: newest.id, path: scopePath },
        [...ancestors, newest.id],
        state,
      );
    } else if (!state.stoppedAt) {
      // closed block 内含 open scope 属坏树；不展开，避免历史 leaf 泄出。
      state.stoppedAt = profileStop(
        "scope",
        newest.id,
        pathText([...ancestors, newest.id]),
        "no-children",
      );
    }
    return;
  }

  if (newest.nodeType === "block") {
    const blockPath = pathText([...ancestors, newest.id]);
    state.newestPathEntries.push(profileBlockEntry(newest, ancestors, "newest-path"));
    if (newest.boundary === "round") {
      state.stoppedAt = profileStop("block", newest.id, blockPath, "round-boundary");
      return;
    }
    if (newest.boundary === "sublimed") {
      state.stoppedAt = profileStop("block", newest.id, blockPath, "sublimed-boundary");
      return;
    }
    if (!Array.isArray(newest.children) || newest.children.length === 0) {
      state.stoppedAt = profileStop("block", newest.id, blockPath, "no-children");
      return;
    }
    const lastChild = newest.children[newest.children.length - 1];
    if (
      !lastChild ||
      typeof lastChild !== "object" ||
      lastChild.nodeType !== "block"
    ) {
      state.stoppedAt = profileStop("block", newest.id, blockPath, "closed-leaf");
      return;
    }
    // 自然 Goal/planItem 链还有更深的 closed block：进入 closed 容器模式。
    walkProfile(
      newest.children,
      { open: false, kind: "block", id: newest.id, path: blockPath },
      [...ancestors, newest.id],
      state,
    );
    return;
  }

  if (!state.stoppedAt) {
    state.stoppedAt = profileStop("empty", null, pathText(ancestors), "no-children");
  }
}

function renderText(entries) {
  const lines = entries.map((entry) => {
    if (entry.kind === "block") {
      return `[block] role=${entry.role} level=${entry.level} id=${entry.id} path=${entry.path} summary=${entry.summary}`;
    }
    const message = entry.message;
    const contentText =
      message && typeof message.content === "string"
        ? message.content
        : JSON.stringify(message?.content ?? null);
    return `[raw] id=${entry.id} seq=${entry.seq} kind=${message?.kind ?? "?"} content=${contentText}`;
  });
  return lines.join("\n");
}

export function render(session, opts = {}) {
  return tryCatch(() => {
    if (!isSession(session)) {
      return errorResult("invalid-session", "render requires a valid session");
    }
    if (!isPlainObject(opts)) {
      return errorResult("invalid-opts", "render opts must be an object");
    }
    const mode = opts.mode ?? "entries";
    if (mode !== "entries" && mode !== "text") {
      return errorResult("invalid-mode", "render mode must be \"entries\" or \"text\"");
    }

    const state = {
      oldSiblingEntries: [],
      newestPathEntries: [],
      rawEntries: [],
      stoppedAt: null,
    };
    walkProfile(
      session.rootChildren,
      { open: true, kind: "root", id: null, path: "" },
      [],
      state,
    );

    const oldSiblingEntries = state.oldSiblingEntries;
    const newestPathEntries = state.newestPathEntries;
    const rawEntries = state.rawEntries;
    const blockEntries = [...oldSiblingEntries, ...newestPathEntries];

    blockEntries.sort(
      (a, b) => (b.level - a.level) || ((a.order ?? 0) - (b.order ?? 0)),
    );
    rawEntries.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

    const entries = [...blockEntries, ...rawEntries];
    const orderValid = renderOrderValid(entries);
    const text = mode === "text" ? renderText(entries) : undefined;
    const stoppedAt =
      state.stoppedAt ?? profileStop("empty", null, "", "no-children");
    return {
      session,
      changes: [],
      entries,
      text,
      orderValid,
      stats: {
        // 旧字段兼容：outermostBlockCount = 当前常驻可见块总数。
        outermostBlockCount: blockEntries.length,
        currentRawCount: rawEntries.length,
        oldSiblingBlockCount: oldSiblingEntries.length,
        newestPathBlockCount: newestPathEntries.length,
        newestPath:
          newestPathEntries.length > 0
            ? newestPathEntries.map((entry) => entry.id)
            : null,
        stoppedAt,
      },
    };
  });
}
