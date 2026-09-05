#!/usr/bin/env node
// probe-core.mjs —— offline pure-core probe for kaz-context-runtime.
// Covers: capture mapping, source filtering, dedupe keys, scope open policy,
// direct-children evidence, close round persistence precondition.
// No Cordis, no LLM, no network, no file I/O.

import { append, close, createSession, open, render } from "kaz-shared/lib/session-tree.js";
import {
  BOUNDARY_EVENT_CLOSE,
  BOUNDARY_EVENT_OPEN,
  BOUNDARY_KINDS,
  boundaryCloseOrder,
  boundaryOpenPlan,
  checkpointMessageInput,
  classifyUserMessageKind,
  collectSeenDshSeqs,
  directChildrenEvidence,
  eventToLeafInput,
  findInnermostOpenScope,
  hasOpenBoundary,
  isAppendSurfaceEvent,
  isBoundaryKind,
  isCompletedTurnEndEvent,
  isMilestoneChanges,
  isReplacementOrKazOwnedEvent,
  leafTextOf,
  maxClosedLeafDshSeq,
  messageHasToolCalls,
  normalizeBoundaryEvent,
  openBoundaryScope,
  openRoundIfNeeded,
  openScopeStack,
  pickCheckpointSurfaceRange,
  renderCheckpointText,
} from "./lib/core.mjs";

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`[FAIL] ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`);
}

function userEvent(source, seq, extra = {}) {
  return {
    type: "user/message",
    seq,
    time: 1700000000000 + seq,
    surfaceOp: "append",
    sourceEventSeqs: [],
    data: {
      id: `msg-${seq}`,
      role: "user",
      content: [{ type: "text", text: `hello ${seq}` }],
      source: source ?? { kind: "user" },
      ...extra,
    },
  };
}

function assistantEvent(seq, blocks) {
  return {
    type: "assistant/message",
    seq,
    time: 1700000000100 + seq,
    surfaceOp: "append",
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `assistant-${seq}`,
        role: "assistant",
        content: blocks ?? [{ type: "text", text: `answer ${seq}` }],
        source: { kind: "model", provider: "p", model: "m" },
      },
    },
  };
}

function toolResultEvent(seq) {
  return {
    type: "tool/result",
    seq,
    time: 1700000000200 + seq,
    surfaceOp: "append",
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `tool-${seq}`,
        role: "user",
        content: [
          {
            type: "tool-result",
            toolCallId: `call-${seq}`,
            content: [{ type: "text", text: `tool result ${seq}` }],
          },
        ],
        source: { kind: "tool", callId: `call-${seq}` },
      },
    },
  };
}

check("user/message source.kind user maps to user leaf", () => {
  const mapped = eventToLeafInput(userEvent({ kind: "user" }, 1));
  if (mapped.skip || !mapped.leaf) throw new Error("skipped");
  if (mapped.leaf.kind !== "user") throw new Error(`kind=${mapped.leaf.kind}`);
  if (mapped.dedupeKey !== "dsh:1") throw new Error(`dedupeKey=${mapped.dedupeKey}`);
  if (mapped.leaf.sourceRef !== "dsh:user/message:1") throw new Error("sourceRef wrong");
});

check("user/message plugin source maps to injection", () => {
  const mapped = eventToLeafInput(
    userEvent({ kind: "plugin", plugin: "ka-whale-memory", form: "notice", summary: "x" }, 2),
  );
  if (mapped.skip || mapped.leaf.kind !== "injection") throw new Error(`kind=${mapped.leaf.kind}`);
});

check("user/message subagent-report/settled maps to subagent_report", () => {
  for (const kind of ["subagent-report", "subagent-settled"]) {
    const mapped = eventToLeafInput(
      userEvent(
        { kind, form: kind === "subagent-settled" ? "notice" : "relay", summary: "s", senderSessionId: "child-1" },
        kind === "subagent-report" ? 3 : 4,
      ),
    );
    if (mapped.skip || mapped.leaf.kind !== "subagent_report") {
      throw new Error(`${kind} -> ${mapped.leaf?.kind}`);
    }
  }
});

check("assistant/message maps to assistant and marks hasToolCalls", () => {
  const plain = eventToLeafInput(assistantEvent(5, [{ type: "text", text: "done" }]));
  if (plain.skip || plain.leaf.kind !== "assistant") throw new Error("assistant mapping failed");
  if (plain.leaf.meta.hasToolCalls !== false) throw new Error("hasToolCalls flag wrong");
  const tool = eventToLeafInput(
    assistantEvent(6, [
      { type: "text", text: "calling" },
      { type: "tool-call", id: "call-6", name: "read", arguments: "{}" },
    ]),
  );
  if (tool.skip || tool.leaf.meta.hasToolCalls !== true) throw new Error("tool call flag wrong");
  if (messageHasToolCalls(tool.leaf.content) !== true) throw new Error("messageHasToolCalls wrong");
});

check("tool/result maps to tool leaf", () => {
  const mapped = eventToLeafInput(toolResultEvent(7));
  if (mapped.skip || mapped.leaf.kind !== "tool") throw new Error(`kind=${mapped.leaf?.kind}`);
  if (mapped.leaf.meta.toolCallId !== "call-7") throw new Error("toolCallId missing");
});

check("replacement and Kaz-owned events are filtered", () => {
  const replace = { type: "user/message", seq: 8, surfaceOp: { op: "replace", start: 0, end: 1 }, data: { source: { kind: "user" } } };
  if (isAppendSurfaceEvent(replace)) throw new Error("replace accepted");
  if (!isReplacementOrKazOwnedEvent(replace)) throw new Error("replace not recognized");
  const kazOwned = { type: "user/message", seq: 9, surfaceOp: "append", data: { source: { kind: "plugin", plugin: "kaz-context-runtime" } } };
  if (isAppendSurfaceEvent(kazOwned)) throw new Error("Kaz-owned append accepted");
  if (!isReplacementOrKazOwnedEvent(kazOwned)) throw new Error("Kaz-owned not recognized");
});

check("turn/end completed predicate", () => {
  if (!isCompletedTurnEndEvent({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } })) {
    throw new Error("completed turn/end not recognized");
  }
  if (isCompletedTurnEndEvent({ type: "turn/end", data: { turn: 1, reason: { kind: "max-tokens" } } })) {
    throw new Error("max-tokens incorrectly completed");
  }
  if (isCompletedTurnEndEvent({ type: "user/message", data: {} })) throw new Error("non turn/end accepted");
});

check("openRoundIfNeeded opens on empty session then stays put", () => {
  const made = createSession({ id: "s-core" });
  if (made.error) throw new Error(made.error.message);
  let session = made.session;
  const opened = openRoundIfNeeded(session, { turn: 1 });
  if (opened.error || opened.changed !== true) throw new Error("first open failed");
  session = opened.session;
  const again = openRoundIfNeeded(session, { turn: 1 });
  if (again.changed !== false || again.reason !== "round-already-open") {
    throw new Error(`second open wrong: ${JSON.stringify(again)}`);
  }
  const found = findInnermostOpenScope(session);
  if (!found || found.scope.level !== 1 || found.scope.boundary !== "round") {
    throw new Error("innermost scope wrong");
  }
});

check("collectSeenDshSeqs gathers leaf meta", () => {
  const made = createSession({ id: "s-seqs" });
  let session = made.session;
  let result = open(session, { level: 1, boundary: "round" });
  if (result.error) throw new Error(result.error.message);
  session = result.session;
  result = append(session, { kind: "user", content: "a", meta: { dshSeq: 11 } });
  if (result.error) throw new Error(result.error.message);
  session = result.session;
  result = append(session, { kind: "assistant", content: "b", meta: { dshSeq: 12 } });
  if (result.error) throw new Error(result.error.message);
  session = result.session;
  eq([...collectSeenDshSeqs(session)].sort(), [11, 12], "seen seqs");
});

check("directChildrenEvidence builds whaleSummarizer input only from direct children", () => {
  const made = createSession({ id: "s-evidence" });
  let session = made.session;
  let result = open(session, { level: 1, boundary: "round", id: "scope-r" });
  if (result.error) throw new Error(result.error.message);
  session = result.session;
  result = append(session, { kind: "user", id: "leaf-u", content: [{ type: "text", text: "user text" }] });
  if (result.error) throw new Error(result.error.message);
  session = result.session;
  result = append(session, { kind: "assistant", id: "leaf-a", content: [{ type: "text", text: "assistant text" }] });
  if (result.error) throw new Error(result.error.message);
  session = result.session;
  const prepared = directChildrenEvidence(session);
  if (!prepared.found) throw new Error("evidence not found");
  if (prepared.boundary !== "round" || prepared.purpose !== "close-round") throw new Error("purpose wrong");
  eq(prepared.refs.map((r) => r.id), ["leaf-u", "leaf-a"], "ref ids");
  eq(prepared.evidence.map((e) => e.text), ["user text", "assistant text"], "evidence text");
});

check("leafTextOf handles structured content and fallback", () => {
  if (leafTextOf({ id: "l1", kind: "user", content: [{ type: "text", text: "abc" }] }) !== "abc") {
    throw new Error("structured text failed");
  }
  if (!leafTextOf({ id: "l2", kind: "tool", content: { z: 1 } }).includes("[tool")) {
    throw new Error("fallback missing");
  }
});

check("close round after pure reducer produces valid closed block", () => {
  const made = createSession({ id: "s-close" });
  let session = made.session;
  let result = open(session, { level: 1, boundary: "round", id: "scope-c" });
  session = result.session;
  result = append(session, { kind: "user", id: "u1", content: "hello" });
  session = result.session;
  result = append(session, { kind: "assistant", id: "a1", content: "hi" });
  session = result.session;
  const closed = close(session, { scopeId: "scope-c", boundary: "round", summary: "round summary" });
  if (closed.error) throw new Error(closed.error.message);
  const rendered = render(closed.session, { mode: "entries" });
  if (rendered.error) throw new Error(rendered.error.message);
  if (rendered.stats.outermostBlockCount !== 1) throw new Error("block not closed");
});

check("isMilestoneChanges recognizes planItem/goal close and sublime", () => {
  if (isMilestoneChanges([{ type: "close", boundary: "round" }])) {
    throw new Error("round close must not be a surface-replace milestone by itself");
  }
  if (!isMilestoneChanges([{ type: "close", boundary: "planItem" }])) {
    throw new Error("planItem close is a milestone");
  }
  if (!isMilestoneChanges([{ type: "close", boundary: "goal" }])) {
    throw new Error("goal close is a milestone");
  }
  if (!isMilestoneChanges([{ type: "sublime", parentBlockId: "s1" }])) {
    throw new Error("sublime is a milestone");
  }
  if (!isMilestoneChanges([{ type: "close", boundary: "round" }, { type: "sublime" }])) {
    throw new Error("round close followed by auto-sublime is a milestone");
  }
});

check("maxClosedLeafDshSeq ignores live open-scope raw leaves", () => {
  const made = createSession({ id: "s-maxclosed" });
  let session = made.session;
  let result = open(session, { level: 1, boundary: "round", id: "scope-old" });
  if (result.error) throw new Error(result.error.message);
  session = result.session;
  result = append(session, { kind: "user", id: "old-u", content: "old", meta: { dshSeq: 1 } });
  if (result.error) throw new Error(result.error.message);
  session = result.session;
  result = append(session, { kind: "assistant", id: "old-a", content: "old a", meta: { dshSeq: 2 } });
  if (result.error) throw new Error(result.error.message);
  session = result.session;
  result = close(session, { scopeId: "scope-old", boundary: "round", summary: "old round" });
  if (result.error) throw new Error(result.error.message);
  session = result.session;
  result = open(session, { level: 1, boundary: "round", id: "scope-live" });
  if (result.error) throw new Error(result.error.message);
  session = result.session;
  result = append(session, { kind: "user", id: "live-u", content: "live", meta: { dshSeq: 3 } });
  if (result.error) throw new Error(result.error.message);
  session = result.session;
  if (maxClosedLeafDshSeq(session) !== 2) {
    throw new Error(`max closed seq=${maxClosedLeafDshSeq(session)}, expected 2`);
  }
});

check("pickCheckpointSurfaceRange selects only the contiguous surface prefix", () => {
  const ok = pickCheckpointSurfaceRange([3, 4, 5, 8], 5);
  if (!ok.ok || ok.start !== 3 || ok.end !== 5) throw new Error(`prefix selection failed: ${JSON.stringify(ok)}`);
  eq(ok.shadowedSeqs, [3, 4, 5], "shadowed prefix");
  const empty = pickCheckpointSurfaceRange([], 5);
  if (empty.ok || empty.code !== "no-surface-nodes") throw new Error("empty surface accepted");
  const noHist = pickCheckpointSurfaceRange([3, 4], 2);
  if (noHist.ok || noHist.code !== "no-shadowable-prefix") throw new Error("closed history mismatch accepted");
  const tailOnly = pickCheckpointSurfaceRange([7, 8], 6);
  if (tailOnly.ok || tailOnly.code !== "no-shadowable-prefix") {
    throw new Error(`prefix rule violated: ${JSON.stringify(tailOnly)}`);
  }
});

check("renderCheckpointText returns stable render() profile text", () => {
  const made = createSession({ id: "s-render-checkpoint" });
  let session = made.session;
  let result = open(session, { level: 1, boundary: "round", id: "scope-rc" });
  if (result.error) throw new Error(result.error.message);
  session = result.session;
  result = append(session, { kind: "user", id: "rc-u", content: "hello" });
  if (result.error) throw new Error(result.error.message);
  session = result.session;
  result = append(session, { kind: "assistant", id: "rc-a", content: "hi" });
  if (result.error) throw new Error(result.error.message);
  session = result.session;
  result = close(session, { scopeId: "scope-rc", boundary: "round", summary: "round summary" });
  if (result.error) throw new Error(result.error.message);
  const checkpoint = renderCheckpointText(result.session);
  if (!checkpoint.ok || typeof checkpoint.text !== "string" || checkpoint.text.length === 0) {
    throw new Error(`render checkpoint failed: ${JSON.stringify(checkpoint)}`);
  }
  if (!checkpoint.text.includes("round summary")) throw new Error("checkpoint text missing block summary");
});

check("checkpointMessageInput is JSON-safe with Kaz plugin marker", () => {
  const input = checkpointMessageInput({
    text: "profile text",
    boundary: "sublimed",
    blockId: "b-1",
    shadowedSeqCount: 4,
    sessionId: "s-checkpoint",
    milestone: "sublimed",
  });
  if (input.source?.plugin !== "kaz-context-runtime") throw new Error("plugin marker missing");
  if (input.source?.purpose !== "context-checkpoint") throw new Error("purpose missing");
  if (input.source?.form !== "snapshot") throw new Error("snapshot form missing");
  const roundTripped = JSON.parse(JSON.stringify(input));
  if (roundTripped.content[0].text !== "profile text") throw new Error("content not JSON-safe");
  try {
    checkpointMessageInput({ text: "" });
    throw new Error("empty text accepted");
  } catch {
    // expected
  }
});

check("workflow boundary kinds and open plans reject duplicates/illegal nesting", () => {
  if (!isBoundaryKind("planItem") || !isBoundaryKind("goal")) {
    throw new Error("planItem/goal must be boundary kinds");
  }
  if (isBoundaryKind("round") || !Array.isArray(BOUNDARY_KINDS)) throw new Error("boundary kind set wrong");
  const made = createSession({ id: "s-boundary-open" });
  if (made.error) throw new Error(made.error.message);
  let session = made.session;
  const invalid = boundaryOpenPlan(session, "round");
  if (invalid.ok !== false || invalid.code !== "invalid-boundary") throw new Error("round open plan accepted");
  const openP = openBoundaryScope(session, { boundary: "planItem", scopeId: "p-1", meta: { planItemId: "pi-1" } });
  if (openP.error) throw new Error(openP.error.message);
  session = openP.session;
  if (!hasOpenBoundary(session, "planItem")) throw new Error("planItem not open");
  if (hasOpenBoundary(session, "goal")) throw new Error("goal unexpectedly open");
  const dup = boundaryOpenPlan(session, "planItem");
  if (dup.ok !== false || dup.code !== "already-open") throw new Error("duplicate planItem accepted");
  const goalInsidePlanItem = boundaryOpenPlan(session, "goal");
  if (goalInsidePlanItem.ok !== false || goalInsidePlanItem.code !== "outer-scope-open") {
    throw new Error("goal opening inside planItem accepted");
  }
});

check("goal/planItem nesting and boundaryCloseOrder pre-close plan", () => {
  const made = createSession({ id: "s-boundary-order" });
  if (made.error) throw new Error(made.error.message);
  let session = made.session;
  const goal = openBoundaryScope(session, { boundary: "goal", scopeId: "g-1", meta: { goalId: "goal-1" } });
  if (goal.error) throw new Error(goal.error.message);
  session = goal.session;
  const plan = openBoundaryScope(session, { boundary: "planItem", scopeId: "p-2", meta: { planItemId: "plan-2" } });
  if (plan.error) throw new Error(plan.error.message);
  session = plan.session;
  const stack = openScopeStack(session);
  eq(stack.map((entry) => entry.scope.boundary), ["goal", "planItem"], "open stack");
  const planClose = boundaryCloseOrder(session, "planItem");
  if (!planClose.found || planClose.targetScopeId !== "p-2" || planClose.preClose.length !== 0) {
    throw new Error(`planItem close order wrong: ${JSON.stringify(planClose)}`);
  }
  const goalClose = boundaryCloseOrder(session, "goal");
  if (!goalClose.found || goalClose.targetScopeId !== "g-1") {
    throw new Error(`goal close order wrong: ${JSON.stringify(goalClose)}`);
  }
  if (goalClose.preClose.length !== 1 || goalClose.preClose[0].boundary !== "planItem") {
    throw new Error(`goal pre-close must include planItem: ${JSON.stringify(goalClose.preClose)}`);
  }
  const missing = boundaryCloseOrder(session, "round");
  if (missing.found || missing.code !== "invalid-boundary") {
    throw new Error("round boundary close order not refused as invalid");
  }
});

check("normalizeBoundaryEvent parses explicit Kaz open/close events", () => {
  const open = normalizeBoundaryEvent({
    type: BOUNDARY_EVENT_OPEN,
    data: { boundary: "goal", sessionId: "s-e", goalId: "goal-e" },
  });
  if (!open.ok || open.op !== "open" || open.boundary !== "goal" || open.sessionId !== "s-e") {
    throw new Error(`open event parse failed: ${JSON.stringify(open)}`);
  }
  const close = normalizeBoundaryEvent({
    type: BOUNDARY_EVENT_CLOSE,
    data: { kind: "planItem", sessionId: "s-e" },
  });
  if (!close.ok || close.op !== "close" || close.boundary !== "planItem") {
    throw new Error(`close event parse failed: ${JSON.stringify(close)}`);
  }
  const notBoundary = normalizeBoundaryEvent({ type: "user/message" });
  if (notBoundary.ok !== false || notBoundary.code !== "not-boundary-event") {
    throw new Error("non-boundary event accepted");
  }
});

if (failed > 0) {
  console.error(`probe-core.mjs FAILED (${failed})`);
  process.exitCode = 1;
} else {
  console.log(`probe-core.mjs ALL PASS (${passed})`);
}
