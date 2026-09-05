// kaz-context-runtime —— pure core: real-DSH event → Kaz tree leaf mapping,
// scope/close helpers, and direct-children evidence for whaleSummarizer.
// ===========================================================================
// Boundary:
//   * Zero Cordis / zero LLM / zero I/O; reducers come from kaz-shared and are
//     called by this module only as pure functions.
//   * This phase mirrors ONLY append-origin surface events. Replacement and
//     Kaz-owned checkpoint events never enter the tree.
//   * Surface replacement is performed by the runtime driver via the official
//     DSH seam; this module only keeps the boundary-only-replace rule and the
//     render() checkpoint contract pure, deterministic, and testable.
// ===========================================================================

import { open, render } from "kaz-shared/lib/session-tree.js";

export const PLUGIN_ID = "kaz-context-runtime";
export const WHALE_EXPAND_TOOL = "whale_expand";
export const CHECKPOINT_PURPOSE = "context-checkpoint";
export const MILESTONE_CLOSE_BOUNDARIES = Object.freeze([
  "planItem",
  "goal",
  "sublimed",
]);
export const KAZ_OWNER_MARKERS = Object.freeze(["kaz-context-runtime", "kaz-context"]);
export const APPEND_SURFACE_TYPES = Object.freeze([
  "user/message",
  "assistant/message",
  "tool/result",
]);
export const LEAF_KINDS = Object.freeze([
  "user",
  "assistant",
  "tool",
  "injection",
  "subagent_report",
]);
export const SUBAGENT_SOURCE_KINDS = Object.freeze([
  "subagent-report",
  "subagent-settled",
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function isPlainRecord(value) {
  return isPlainObject(value);
}

/** A replacement event (checkpoint-like) or one written by Kaz itself. */
export function isReplacementOrKazOwnedEvent(event) {
  if (!isPlainObject(event)) return true;
  const op = event.surfaceOp;
  if (op !== undefined && op !== "append") return true;
  const source =
    event.data !== null && typeof event.data === "object" ? event.data.source : undefined;
  if (isPlainObject(source) && KAZ_OWNER_MARKERS.includes(source.plugin)) return true;
  const nested =
    event.data !== null && typeof event.data === "object"
      ? event.data.message?.source
      : undefined;
  if (isPlainObject(nested) && KAZ_OWNER_MARKERS.includes(nested.plugin)) return true;
  return false;
}

/** Only append-origin user/assistant/tool-result events are tree leaves. */
export function isAppendSurfaceEvent(event) {
  if (!isPlainObject(event)) return false;
  return (
    APPEND_SURFACE_TYPES.includes(event.type) &&
    event.surfaceOp === "append" &&
    !isReplacementOrKazOwnedEvent(event)
  );
}

/** Map a DSH user/message source to the Kaz tree leaf kind. */
export function classifyUserMessageKind(data) {
  const source = isPlainObject(data) ? data.source : undefined;
  if (isPlainObject(source) && source.kind === "user") return "user";
  if (
    isPlainObject(source) &&
    SUBAGENT_SOURCE_KINDS.includes(source.kind)
  ) {
    return "subagent_report";
  }
  return "injection";
}

export function messageHasToolCalls(message) {
  if (!isPlainObject(message) || !Array.isArray(message.content)) return false;
  return message.content.some((block) => isPlainObject(block) && block.type === "tool-call");
}

function snapshotJson(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return { unserializable: String(value) };
  }
}

function messageObjectOf(event) {
  const data = event?.data;
  if (!isPlainObject(data)) return undefined;
  if (event.type === "user/message") return data;
  if (
    (event.type === "assistant/message" || event.type === "tool/result") &&
    isPlainObject(data.message)
  ) {
    return data.message;
  }
  return undefined;
}

function numeric(value) {
  return Number.isInteger(value) ? value : undefined;
}

/**
 * Normalize one append-origin DSH surface event into a Kaz tree leaf input.
 * Returns { leaf } or { skip: true, reason }.
 */
export function eventToLeafInput(event) {
  if (!isAppendSurfaceEvent(event)) {
    return { skip: true, reason: "not-append-surface-event" };
  }
  const data = isPlainObject(event.data) ? event.data : {};
  const message = messageObjectOf(event);
  let kind;
  if (event.type === "user/message") {
    kind = classifyUserMessageKind(data);
  } else if (event.type === "assistant/message") {
    kind = "assistant";
  } else if (event.type === "tool/result") {
    kind = "tool";
  } else {
    return { skip: true, reason: "unsupported-type" };
  }
  const content = snapshotJson(message ?? data);
  const dshSeq = numeric(event.seq);
  const dedupeKey =
    typeof dshSeq === "number"
      ? `dsh:${dshSeq}`
      : typeof message?.id === "string" && message.id.length > 0
        ? `msg:${message.id}`
        : null;
  const meta = {
    dshType: event.type,
    ...(dshSeq !== undefined ? { dshSeq } : {}),
    ...(event.time !== undefined && Number.isFinite(event.time) ? { dshTime: event.time } : {}),
    ...(data.turn !== undefined ? { turn: data.turn } : {}),
    ...(data.step !== undefined ? { step: data.step } : {}),
  };
  if (isPlainObject(message) && typeof message.id === "string" && message.id.length > 0) {
    meta.messageId = message.id;
  }
  if (isPlainObject(message) && typeof message.role === "string") {
    meta.role = message.role;
  }
  if (event.type === "user/message" && isPlainObject(message?.source)) {
    meta.sourceKind = message.source.kind;
    if (typeof message.source.plugin === "string") meta.plugin = message.source.plugin;
  }
  if (event.type === "tool/result" && isPlainObject(message?.source)) {
    meta.sourceKind = message.source.kind;
    if (typeof message.source.callId === "string") meta.toolCallId = message.source.callId;
  }
  if (event.type === "assistant/message") {
    meta.hasToolCalls = messageHasToolCalls(message) === true;
  }
  const leaf = { kind, content };
  if (typeof dshSeq === "number") leaf.sourceRef = `dsh:${event.type}:${dshSeq}`;
  leaf.meta = meta;
  return { leaf, dedupeKey };
}

/** Deep traversal of a Session collecting direct leaf meta dshSeq values. */
export function collectSeenDshSeqs(session) {
  const out = new Set();
  if (!isPlainObject(session) || !Array.isArray(session.rootChildren)) return out;
  const walk = (children) => {
    for (const node of children ?? []) {
      if (!isPlainObject(node)) continue;
      if (node.nodeType === "leaf" && Number.isInteger(node.meta?.dshSeq)) {
        out.add(node.meta.dshSeq);
      }
      if (Array.isArray(node.children)) walk(node.children);
    }
  };
  walk(session.rootChildren);
  return out;
}

/** Deep traversal collecting leaf message ids (defense against pre-step/event overlap). */
export function collectSeenMessageIds(session) {
  const out = new Set();
  if (!isPlainObject(session) || !Array.isArray(session.rootChildren)) return out;
  const walk = (children) => {
    for (const node of children ?? []) {
      if (!isPlainObject(node)) continue;
      if (node.nodeType === "leaf" && typeof node.meta?.messageId === "string") {
        out.add(node.meta.messageId);
      }
      if (Array.isArray(node.children)) walk(node.children);
    }
  };
  walk(session.rootChildren);
  return out;
}

/** Find the innermost open scope (the transparent active container), if any. */
export function findInnermostOpenScope(session) {
  if (!isPlainObject(session) || !Array.isArray(session.rootChildren)) return null;
  let found = null;
  const visit = (children, scopeIds, indexes) => {
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const node = children[i];
      if (!isPlainObject(node) || node.nodeType !== "scope") continue;
      found = {
        scope: node,
        index: i,
        parentChildren: children,
        pathIds: [...scopeIds, node.id],
        pathIndexes: [...indexes, i],
      };
      visit(node.children ?? [], found.pathIds, found.pathIndexes);
      return;
    }
  };
  visit(session.rootChildren, [], []);
  return found;
}

// ---------------------------------------------------------------------------
// v0.3.1 pure workflow-boundary helpers (planItem level 2 / goal level 3)
// ---------------------------------------------------------------------------

export const BOUNDARY_SPECS = Object.freeze({
  planItem: Object.freeze({ level: 2, boundary: "planItem" }),
  goal: Object.freeze({ level: 3, boundary: "goal" }),
});

export const BOUNDARY_KINDS = Object.freeze(["planItem", "goal"]);

export const BOUNDARY_EVENT_OPEN = "kazContextBoundary/open";
export const BOUNDARY_EVENT_CLOSE = "kazContextBoundary/close";

export function isBoundaryKind(value) {
  return typeof value === "string" && BOUNDARY_KINDS.includes(value);
}

export function normalizeBoundaryKind(value) {
  if (value === "planItem" || value === "goal") return value;
  return null;
}

/** Root-to-innermost open scope stack, each entry with scope/index/path. */
export function openScopeStack(session) {
  if (!isPlainObject(session) || !Array.isArray(session.rootChildren)) return [];
  const stack = [];
  let children = session.rootChildren;
  const pathIds = [];
  const pathIndexes = [];
  for (;;) {
    let foundIndex = -1;
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const node = children[i];
      if (isPlainObject(node) && node.nodeType === "scope") {
        foundIndex = i;
        break;
      }
    }
    if (foundIndex < 0) break;
    const scope = children[foundIndex];
    pathIds.push(scope.id);
    pathIndexes.push(foundIndex);
    stack.push({
      scope,
      index: foundIndex,
      parentChildren: children,
      pathIds: [...pathIds],
      pathIndexes: [...pathIndexes],
    });
    children = Array.isArray(scope.children) ? scope.children : [];
  }
  return stack;
}

/** Find the deepest open scope whose boundary matches `boundary`. */
export function findOpenBoundary(session, boundary) {
  const stack = openScopeStack(session);
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i].scope.boundary === boundary) {
      return { found: true, stackIndex: i, ...stack[i] };
    }
  }
  return { found: false, stackIndex: -1 };
}

export function hasOpenBoundary(session, boundary) {
  return findOpenBoundary(session, boundary).found === true;
}

/**
 * Plan which open scopes must be closed before a requested boundary can become
 * the innermost open scope. `preClose` lists deeper scopes in LIFO close order.
 */
export function boundaryCloseOrder(session, boundary) {
  if (!isBoundaryKind(boundary)) {
    return {
      found: false,
      code: "invalid-boundary",
      reason: `boundary must be one of: ${BOUNDARY_KINDS.join(", ")}`,
    };
  }
  const stack = openScopeStack(session);
  let targetIndex = -1;
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i].scope.boundary === boundary) {
      targetIndex = i;
      break;
    }
  }
  if (targetIndex < 0) {
    return {
      found: false,
      code: "boundary-not-open",
      reason: `no open ${boundary} scope is present`,
    };
  }
  const target = stack[targetIndex];
  const preClose = stack
    .slice(targetIndex + 1)
    .reverse()
    .map((entry, order) => ({
      order,
      boundary: entry.scope.boundary,
      scopeId: entry.scope.id,
      scopeLevel: entry.scope.level,
    }));
  return {
    found: true,
    boundary,
    targetScopeId: target.scope.id,
    targetIndex,
    stackLength: stack.length,
    preClose,
  };
}

/**
 * Validate whether a new workflow boundary may be opened on the current tree.
 * Returns the spec or a structured refusal; never mutates the session.
 */
export function boundaryOpenPlan(session, boundary) {
  if (!isBoundaryKind(boundary)) {
    return {
      ok: false,
      code: "invalid-boundary",
      reason: `boundary must be one of: ${BOUNDARY_KINDS.join(", ")}`,
    };
  }
  const spec = BOUNDARY_SPECS[boundary];
  const stack = openScopeStack(session);
  if (stack.some((entry) => entry.scope.boundary === boundary)) {
    return {
      ok: false,
      code: "already-open",
      reason: `a ${boundary} scope is already open`,
    };
  }
  if (boundary === "goal" && stack.length > 0) {
    return {
      ok: false,
      code: "outer-scope-open",
      reason: "a goal (level 3) boundary can only open at the session root",
    };
  }
  if (boundary === "planItem" && stack.length > 0) {
    const deepest = stack[stack.length - 1];
    if (deepest.scope.level <= spec.level) {
      return {
        ok: false,
        code: "inner-scope-open",
        reason:
          `a planItem (level 2) boundary cannot open while a ${deepest.scope.boundary} ` +
          `(level ${deepest.scope.level}) scope is innermost`,
      };
    }
  }
  return { ok: true, spec };
}

/**
 * Pure open of a workflow boundary through the shared session-tree reducer.
 * Result is an `open()`-shaped reducer result.
 */
export function openBoundaryScope(session, { boundary, scopeId, meta } = {}) {
  const plan = boundaryOpenPlan(session, boundary);
  if (!plan.ok) return plan;
  const spec = plan.spec;
  return open(session, {
    level: spec.level,
    boundary: spec.boundary,
    ...(typeof scopeId === "string" && scopeId.trim().length > 0
      ? { id: scopeId.trim() }
      : {}),
    ...(isPlainObject(meta) ? { meta } : {}),
  });
}

/** Parse a compatible explicit Kaz boundary event (never mirrors into tree). */
export function normalizeBoundaryEvent(event) {
  if (!isPlainObject(event)) {
    return { ok: false, code: "invalid-event", reason: "boundary event must be an object" };
  }
  let op = null;
  if (event.type === BOUNDARY_EVENT_OPEN) op = "open";
  else if (event.type === BOUNDARY_EVENT_CLOSE) op = "close";
  if (op === null) {
    return { ok: false, code: "not-boundary-event", reason: "unrecognized boundary event type" };
  }
  const data = isPlainObject(event.data) ? event.data : {};
  const boundary =
    typeof data.boundary === "string"
      ? normalizeBoundaryKind(data.boundary)
      : typeof data.kind === "string"
        ? normalizeBoundaryKind(data.kind)
        : null;
  if (boundary === null) {
    return {
      ok: false,
      code: "invalid-boundary-kind",
      reason: "boundary event requires boundary/kind planItem or goal",
    };
  }
  const sessionId =
    typeof data.sessionId === "string" && data.sessionId.trim().length > 0
      ? data.sessionId.trim()
      : undefined;
  const scopeId =
    typeof data.scopeId === "string" && data.scopeId.trim().length > 0
      ? data.scopeId.trim()
      : typeof data.id === "string" && data.id.trim().length > 0
        ? data.id.trim()
        : undefined;
  const meta = isPlainObject(data.meta) ? data.meta : {};
  return {
    ok: true,
    op,
    boundary,
    sessionId,
    scopeId,
    meta: {
      ...meta,
      ...(typeof data.planItemId === "string" ? { planItemId: data.planItemId } : {}),
      ...(typeof data.goalId === "string" ? { goalId: data.goalId } : {}),
      source: "kazContextBoundary",
    },
  };
}

/**
 * Open a round scope if the current deepest open scope allows it:
 * no scope, or deepest level > 1 (goal/planItem open). A level-1 scope that is
 * already open must not be nested; the caller appends into it.
 */
export function openRoundIfNeeded(session, meta = {}) {
  const innermost = findInnermostOpenScope(session);
  if (innermost && innermost.scope.level === 1) {
    return { changed: false, reason: "round-already-open", session };
  }
  const result = open(session, { level: 1, boundary: "round", meta });
  if (result.error) return result;
  return { ...result, changed: true };
}

/** Block text / leaf original text used as whaleSummarizer direct-child evidence. */
export function contentTextOf(value, depth = 0) {
  if (depth > 6) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => contentTextOf(item, depth + 1))
      .filter((text) => text.trim().length > 0)
      .join("\n");
  }
  if (!isPlainObject(value)) return "";
  if (typeof value.text === "string" && value.text.trim().length > 0) return value.text;
  if (typeof value.summary === "string" && value.summary.trim().length > 0) return value.summary;
  if (value.type === "tool-call") {
    const args = typeof value.arguments === "string" ? value.arguments : JSON.stringify(value.arguments ?? {});
    return `[tool-call ${value.name ?? "unknown"}] ${args}`;
  }
  if (Array.isArray(value.content)) {
    return contentTextOf(value.content, depth + 1);
  }
  return "";
}

/** Readable text for one leaf used as evidence input. */
export function leafTextOf(leaf) {
  if (!isPlainObject(leaf)) return "";
  const content = leaf.content;
  const text =
    typeof content === "string"
      ? content
      : isPlainObject(content) && Array.isArray(content.content)
        ? contentTextOf(content.content)
        : contentTextOf(content);
  const fallback = `[${leaf.kind ?? "leaf"} ${leaf.id ?? "?"} no-text-content]`;
  return text.trim().length > 0 ? text.trim() : fallback;
}

/**
 * Build whaleSummarizer input from the current innermost open scope's direct
 * children. Returns { found, scopeId, boundary, purpose, evidence, refs }.
 */
export function directChildrenEvidence(session) {
  const innermost = findInnermostOpenScope(session);
  if (!innermost) return { found: false, reason: "no-open-scope" };
  const scope = innermost.scope;
  const scopePath = innermost.pathIds.join("/");
  const children = Array.isArray(scope.children) ? scope.children : [];
  if (children.length === 0) {
    return { found: false, reason: "empty-scope", scopeId: scope.id };
  }
  const evidence = [];
  const refs = [];
  for (const child of children) {
    if (!isPlainObject(child) || typeof child.id !== "string") continue;
    const path = scopePath.length > 0 ? `${scopePath}/${child.id}` : child.id;
    if (child.nodeType === "block") {
      evidence.push({
        kind: "block",
        id: child.id,
        text: (typeof child.summary === "string" && child.summary.trim().length > 0
          ? child.summary
          : `[block ${child.id} no-summary]`
        ).trim(),
        path,
      });
      refs.push({ kind: "block", id: child.id, path });
    } else {
      evidence.push({
        kind: "leaf",
        id: child.id,
        text: leafTextOf(child),
        path,
      });
      refs.push({
        kind: "leaf",
        id: child.id,
        path,
        ...(Number.isInteger(child.seq) ? { seq: child.seq } : {}),
      });
    }
  }
  if (evidence.length === 0) {
    return { found: false, reason: "no-evidence-children", scopeId: scope.id };
  }
  const purpose =
    scope.boundary === "round"
      ? "close-round"
      : scope.boundary === "planItem"
        ? "close-planItem"
        : "close-goal";
  return {
    found: true,
    scopeId: scope.id,
    boundary: scope.boundary,
    purpose,
    evidence,
    refs,
  };
}

/** True when a session/event turn/end carries the completed reason. */
export function isCompletedTurnEndEvent(event) {
  if (!isPlainObject(event) || event.type !== "turn/end") return false;
  const reason = isPlainObject(event.data) ? event.data.reason : undefined;
  return isPlainObject(reason) && reason.kind === "completed";
}

export function completedTurnNumberOf(event) {
  if (!isCompletedTurnEndEvent(event)) return undefined;
  return Number.isInteger(event.data?.turn) ? event.data.turn : undefined;
}

export function isSelfOwnedEvent(event) {
  if (!isPlainObject(event)) return false;
  const source = isPlainObject(event.data) ? event.data.source : undefined;
  const nested = isPlainObject(event.data?.message) ? event.data.message.source : undefined;
  for (const candidate of [source, nested]) {
    if (
      isPlainObject(candidate) &&
      typeof candidate.plugin === "string" &&
      KAZ_OWNER_MARKERS.includes(candidate.plugin)
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// v0.3.0 pure helpers: milestone detection, checkpoint range, render profile
// ---------------------------------------------------------------------------

/**
 * True when a reducer commit contains a structural milestone that may trigger
 * one persistent surface checkpoint: an explicit close of planItem/goal, or an
 * auto/explicit sublime (the first compressible boundary after N round blocks).
 */
export function isMilestoneChanges(changes) {
  if (!Array.isArray(changes)) return false;
  return changes.some((change) => {
    if (!isPlainObject(change)) return false;
    if (change.type === "sublime") return true;
    return (
      change.type === "close" &&
      typeof change.boundary === "string" &&
      MILESTONE_CLOSE_BOUNDARIES.includes(change.boundary)
    );
  });
}

function collectSubtreeDshSeqs(node, out) {
  if (!isPlainObject(node)) return;
  if (node.nodeType === "leaf" && Number.isInteger(node.meta?.dshSeq)) {
    out.add(node.meta.dshSeq);
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) collectSubtreeDshSeqs(child, out);
  }
}

/**
 * Largest append-origin dshSeq currently enclosed by a closed block anywhere in
 * the Session (including blocks nested under an open planItem/goal scope).
 * Raw leaves of the live open scope are excluded because they stay on the
 * surface tail and must never be shadowed by the prefix checkpoint.
 */
export function maxClosedLeafDshSeq(session) {
  if (!isPlainObject(session) || !Array.isArray(session.rootChildren)) {
    return undefined;
  }
  const all = new Set();
  const visit = (children) => {
    for (const node of children ?? []) {
      if (!isPlainObject(node)) continue;
      if (node.nodeType === "block") {
        collectSubtreeDshSeqs(node, all);
      } else if (node.nodeType === "scope") {
        visit(node.children);
      }
    }
  };
  visit(session.rootChildren);
  return all.size > 0 ? Math.max(...all) : undefined;
}

/**
 * Select the contiguous surface prefix that one checkpoint may shadow.
 * `surfaceNodes` is DSH `session.surface.nodes` in model-visible order;
 * `maxClosedSeq` comes from {@link maxClosedLeafDshSeq}. The rule is
 * boundary-only and prefix-only: never skip an earlier live surface node.
 */
export function pickCheckpointSurfaceRange(surfaceNodes, maxClosedSeq) {
  if (!Array.isArray(surfaceNodes) || surfaceNodes.length === 0) {
    return { ok: false, code: "no-surface-nodes", reason: "DSH surface is empty" };
  }
  if (!Number.isInteger(maxClosedSeq)) {
    return {
      ok: false,
      code: "no-closed-history",
      reason: "no closed-block history is available for a checkpoint",
    };
  }
  if (surfaceNodes.some((seq) => !Number.isInteger(seq))) {
    return {
      ok: false,
      code: "invalid-surface-nodes",
      reason: "DSH surface nodes must be integer seqs",
    };
  }
  const first = surfaceNodes[0];
  const candidates = surfaceNodes.filter((seq) => seq <= maxClosedSeq);
  if (candidates.length === 0) {
    return {
      ok: false,
      code: "no-shadowable-prefix",
      reason: "closed history does not cover the current surface prefix",
    };
  }
  if (candidates[0] !== first) {
    return {
      ok: false,
      code: "non-prefix-boundary",
      reason: "checkpoint replace is only allowed on the contiguous surface prefix",
    };
  }
  return {
    ok: true,
    start: candidates[0],
    end: candidates[candidates.length - 1],
    shadowedSeqs: [...candidates],
  };
}

/**
 * Render the stable newest-branch profile text that becomes a checkpoint
 * message body. Requires render success and renderOrderValid.
 */
export function renderCheckpointText(session) {
  const rendered = render(session, { mode: "text" });
  if (rendered.error) {
    return {
      ok: false,
      code: "render-error",
      reason: rendered.error.message ?? String(rendered.error),
    };
  }
  if (rendered.orderValid !== true) {
    return {
      ok: false,
      code: "render-order-invalid",
      reason: "renderOrderValid failed before checkpoint creation",
    };
  }
  const text = typeof rendered.text === "string" ? rendered.text.trim() : "";
  if (text.length === 0) {
    return {
      ok: false,
      code: "empty-render",
      reason: "render() produced no checkpoint text",
    };
  }
  return {
    ok: true,
    text,
    stats: rendered.stats,
    newestPath: rendered.stats?.newestPath ?? null,
  };
}

/**
 * Pure JSON-safe checkpoint message body/source for `createUserMessage`.
 * The source carries the Kaz plugin marker so the driver's own mirror filter
 * never re-enters the tree.
 */
export function checkpointMessageInput({
  text,
  boundary,
  blockId,
  scopeId,
  shadowedSeqCount,
  sessionId,
  milestone,
}) {
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("checkpointMessageInput requires non-empty text");
  }
  return {
    content: [{ type: "text", text }],
    source: {
      kind: "plugin",
      plugin: PLUGIN_ID,
      form: "snapshot",
      sections: [{ name: "kaz-context-profile", text }],
      purpose: CHECKPOINT_PURPOSE,
      ...(typeof boundary === "string" && boundary.length > 0 ? { boundary } : {}),
      ...(typeof blockId === "string" && blockId.length > 0 ? { blockId } : {}),
      ...(typeof scopeId === "string" && scopeId.length > 0 ? { scopeId } : {}),
      ...(typeof milestone === "string" && milestone.length > 0 ? { milestone } : {}),
      shadowedSeqCount,
      sessionId,
    },
  };
}
