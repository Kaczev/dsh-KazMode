#!/usr/bin/env node
// probe-runtime.mjs —— offline runtime-wiring probe for kaz-context-runtime.
// Uses a fake Cordis ctx, synthetic DSH events, a mutable whaleSummarizer stub,
// and a temporary session-tree store root. No real LLM/network.
// Covers: capture/append, close, persist, scope/whale_expand-registration and
// execution/no-DSH-append, replacement filtering, summary-failure containment
// + pre-step retry.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pluginDefault from "./lib/index.js";
import { createSessionTreeStore } from "kaz-shared/lib/session-tree-store-io.js";
import { findInnermostOpenScope } from "./lib/core.mjs";

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

function makeAgent(sessionId, registry, appendLog) {
  const session = {
    id: sessionId,
    header: {},
    events: [],
    requestHeader: () => ({ config: { provider: "probe-provider", model: "probe-model" } }),
    append(...args) {
      appendLog.push(args);
      throw new Error("kaz-context-runtime must not call DSH session.append outside the v0.3.0 checkpoint replace");
    },
  };
  const agent = {
    id: sessionId,
    options: { provider: "probe-provider", model: "probe-model" },
    session,
    requestHeader: () => ({ config: { provider: "probe-provider", model: "probe-model" } }),
  };
  registry.set(sessionId, agent);
  return { agent, session };
}

/**
 * Session/agent double whose `session.surface.nodes` is a live mutable array and
 * whose append accepts ONLY Kaz-owned user/message surface replaces (the
 * v0.3.0 checkpoint seam). All other appends throw, keeping the v0.2.0
 * "no unrelated DSH append" discipline testable.
 */
function makeCheckpointAgent(sessionId, registry, appendLog, surfaceNodes, options = {}) {
  let nextSeq = 1000;
  let failedOnce = false;
  const session = {
    id: sessionId,
    header: {},
    events: [],
    surface: { nodes: surfaceNodes },
    requestHeader: () => ({ config: { provider: "probe-provider", model: "probe-model" } }),
    append(type, data, opts) {
      if (type !== "user/message") {
        throw new Error(`checkpoint probe: unexpected append type ${type}`);
      }
      const surfaceOp = opts?.surfaceOp;
      if (!surfaceOp || surfaceOp.op !== "replace") {
        throw new Error("checkpoint probe: expected surfaceOp replace");
      }
      if (data?.source?.plugin !== "kaz-context-runtime") {
        throw new Error("checkpoint probe: replacement source must be Kaz-owned");
      }
      if (!Array.isArray(opts?.sourceEventSeqs) || opts.sourceEventSeqs.length === 0) {
        throw new Error("checkpoint probe: sourceEventSeqs must be non-empty");
      }
      if (options.failOnce === true && !failedOnce) {
        failedOnce = true;
        throw new Error("probe transient surface append failure");
      }
      const seq = nextSeq;
      nextSeq += 1;
      appendLog.push({ type, data, opts, seq });
      const shadowed = new Set(opts.sourceEventSeqs);
      const remaining = surfaceNodes.filter((node) => !shadowed.has(node));
      surfaceNodes.length = 0;
      surfaceNodes.push(seq, ...remaining);
      return { type, seq, time: 1700000000000 + seq, data };
    },
  };
  const agent = {
    id: sessionId,
    options: { provider: "probe-provider", model: "probe-model" },
    session,
    requestHeader: () => ({ config: { provider: "probe-provider", model: "probe-model" } }),
  };
  registry.set(sessionId, agent);
  return { agent, session, surfaceNodes };
}

function makeContext(overrides = {}) {
  const handlers = {};
  const effects = [];
  const toolCalls = [];
  const provides = {};
  const appendLog = [];
  const agents = new Map();
  const whaleSummarizer = {
    async summarize(input, _runtime) {
      return { summary: `probe summary for ${input.purpose}`, sourceIds: (input.refs ?? []).map((r) => r.id) };
    },
  };
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    get(name) {
      if (name === "kaWhaleWorkflow" && overrides.kaWhaleWorkflow) return overrides.kaWhaleWorkflow;
      if (name === "goals" && overrides.goals) return overrides.goals;
      if (name === "agents") return agents;
      if (name === "whaleSummarizer") return whaleSummarizer;
      return undefined;
    },
    on(name, handler) {
      (handlers[name] ??= []).push(handler);
    },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === "function") effects.push(cleanup);
    },
    provide(name, value) {
      provides[name] = value;
      return () => {
        delete provides[name];
      };
    },
    tools: {
      register(definition) {
        toolCalls.push(definition);
        return () => {
          const index = toolCalls.indexOf(definition);
          if (index >= 0) toolCalls.splice(index, 1);
        };
      },
    },
  };
  return { ctx, handlers, effects, toolCalls, provides, appendLog, agents, whaleSummarizer };
}

function makeEvent(type, seq, payload, surface = true) {
  const event = {
    type,
    seq,
    time: 1700000000000 + seq,
    data: payload,
  };
  if (surface && (type === "user/message" || type === "assistant/message" || type === "tool/result")) {
    event.surfaceOp = "append";
    event.sourceEventSeqs = [];
  }
  return event;
}

function userEvent(seq, source = { kind: "user" }) {
  return makeEvent(
    "user/message",
    seq,
    {
      id: `user-${seq}`,
      role: "user",
      content: [{ type: "text", text: `user message ${seq}` }],
      source,
    },
    true,
  );
}

function assistantEvent(seq, text = `assistant answer ${seq}`, withToolCall = false) {
  const content = withToolCall
    ? [
        { type: "text", text: "tool request" },
        { type: "tool-call", id: `call-${seq}`, name: "read", arguments: "{}" },
      ]
    : [{ type: "text", text }];
  return makeEvent("assistant/message", seq, {
    turn: 1,
    step: 1,
    message: {
      id: `assistant-${seq}`,
      role: "assistant",
      content,
      source: { kind: "model", provider: "probe-provider", model: "probe-model" },
    },
  });
}

function replacementEvent(seq) {
  const event = userEvent(seq);
  event.surfaceOp = { op: "replace", start: 0, end: 1 };
  return event;
}

function loadSession(rootDir, sessionId) {
  const store = createSessionTreeStore({ sessionId, rootDir });
  const loaded = store.load();
  if (!loaded.ok) throw new Error(`store load failed: ${loaded.code}: ${loaded.error}`);
  return loaded.session;
}

function countLeaves(session) {
  let count = 0;
  const walk = (children) => {
    for (const node of children ?? []) {
      if (!node || typeof node !== "object") continue;
      if (node.nodeType === "leaf") count += 1;
      if (Array.isArray(node.children)) walk(node.children);
    }
  };
  walk(session?.rootChildren);
  return count;
}

const rootDirs = [];
function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), "kaz-context-runtime-probe-"));
  rootDirs.push(dir);
  return dir;
}

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function runCaptureCloseRound(env, agent, surfaceNodes, firstSeq, turn, signal = { aborted: false }) {
  const user = userEvent(firstSeq);
  env.handlers["session/event"][0](agent.session, user);
  if (!surfaceNodes.includes(user.seq)) surfaceNodes.push(user.seq);
  const assistant = assistantEvent(firstSeq + 1);
  env.handlers["session/event"][0](agent.session, assistant);
  if (!surfaceNodes.includes(assistant.seq)) surfaceNodes.push(assistant.seq);
  await env.handlers["agent/turn-stopping"][0]({ agent, turn, signal });
  await flushMicrotasks();
}

const runtimeChecks = [];

runtimeChecks.push(async () => {
  const rootDir = tempRoot();
  const env = makeContext();
  pluginDefault.apply(env.ctx, { storeRootDir: rootDir });
  const sessionId = "session-a";
  const { agent } = makeAgent(sessionId, env.agents, env.appendLog);

  env.handlers["session/event"][0](agent.session, userEvent(1));
  env.handlers["session/event"][0](agent.session, assistantEvent(2));
  let session = loadSession(rootDir, sessionId);
  if (countLeaves(session) !== 2) throw new Error(`capture leaves=${countLeaves(session)}`);
  const innermostBefore = findInnermostOpenScope(session);
  if (!innermostBefore || innermostBefore.scope.boundary !== "round") throw new Error("open round missing");

  await env.handlers["agent/turn-stopping"][0]({ agent, turn: 1, signal: { aborted: false } });
  await flushMicrotasks();

  session = loadSession(rootDir, sessionId);
  const innermostAfter = findInnermostOpenScope(session);
  if (innermostAfter) throw new Error("scope still open after close");
  if (session.rootChildren.length !== 1) throw new Error(`rootChildren=${session.rootChildren.length}`);
  const block = session.rootChildren[0];
  if (block.nodeType !== "block" || block.state !== "closed") throw new Error("block not closed");
  if (block.summary !== "probe summary for close-round") throw new Error(`summary=${block.summary}`);

  env.handlers["session/event"][0](agent.session, replacementEvent(99));
  await flushMicrotasks();
  session = loadSession(rootDir, sessionId);
  if (session.rootChildren.length !== 1 || countLeaves(session) !== 2) {
    throw new Error("replacement event entered the tree");
  }
  if (env.toolCalls.length !== 1) throw new Error(`tools.register calls=${env.toolCalls.length}`);
  if (env.toolCalls[0]?.name !== "whale_expand") throw new Error("whale_expand not registered");
  if (Object.keys(env.provides).length !== 1) throw new Error(`plugin provided services: ${Object.keys(env.provides).join(",")}`);
  if (typeof env.provides["kazContextBoundary"]?.openPlanItem !== "function") {
    throw new Error("kazContextBoundary service not provided");
  }
  if (env.appendLog.length !== 0) throw new Error(`DSH session.append called ${env.appendLog.length} times`);
  if (env.effects.length !== 3) throw new Error("cleanup effects missing");
});

runtimeChecks.push(async () => {
  const rootDir = tempRoot();
  const env = makeContext();
  pluginDefault.apply(env.ctx, { storeRootDir: rootDir });
  const sessionId = "session-b";
  const { agent } = makeAgent(sessionId, env.agents, env.appendLog);

  env.whaleSummarizer.summarize = async () => {
    throw new Error("probe transient summarizer failure");
  };
  env.handlers["session/event"][0](agent.session, userEvent(1));
  env.handlers["session/event"][0](agent.session, assistantEvent(2));
  await env.handlers["agent/turn-stopping"][0]({ agent, turn: 1, signal: { aborted: false } });

  let session = loadSession(rootDir, sessionId);
  const innermost = findInnermostOpenScope(session);
  if (!innermost || innermost.scope.children.length !== 2) throw new Error("failed close folded scope incorrectly");
  if (session.rootChildren.some((node) => node.nodeType === "block")) throw new Error("block created after failure");

  // Retry at next pre-step: close old round BEFORE the next step's user/message
  // is durably logged, so the new step starts in a fresh round.
  env.whaleSummarizer.summarize = async (input) => ({ summary: "retry ok", sourceIds: (input.refs ?? []).map((r) => r.id) });
  const next = async () => ({ kind: "enter", messages: [] });
  await env.handlers["agent/pre-step"][0]({ agent, turn: 2, step: 1 }, next);

  session = loadSession(rootDir, sessionId);
  if (findInnermostOpenScope(session)) throw new Error("scope open after pre-step retry");
  if (session.rootChildren.length !== 1 || session.rootChildren[0].state !== "closed") {
    throw new Error("pre-step retry did not close old round");
  }

  // New step starts a fresh round and appends normally.
  env.handlers["session/event"][0](agent.session, userEvent(4));
  env.handlers["session/event"][0](agent.session, assistantEvent(5));
  session = loadSession(rootDir, sessionId);
  if (session.rootChildren.length !== 2) throw new Error(`root children after new round=${session.rootChildren.length}`);
  const open = findInnermostOpenScope(session);
  if (!open || open.scope.children.length !== 2) throw new Error("new round not opened");
});

runtimeChecks.push(async () => {
  const rootDir = tempRoot();
  const env = makeContext();
  pluginDefault.apply(env.ctx, { storeRootDir: rootDir });
  const sessionId = "session-c";
  const { agent } = makeAgent(sessionId, env.agents, env.appendLog);

  env.handlers["session/event"][0](agent.session, userEvent(1));
  env.handlers["session/event"][0](agent.session, assistantEvent(2));

  if (env.toolCalls.length !== 1) throw new Error("whale_expand registration missing");
  const definition = env.toolCalls[0];
  const expanded = await definition.execute({ path: "", limit: 100 }, { agent });
  if (!expanded || expanded.ok !== true) {
    throw new Error(`root expand failed: ${JSON.stringify(expanded)}`);
  }
  if (expanded.total !== 1 || expanded.page.length !== 1 || expanded.page[0]?.kind !== "scope") {
    throw new Error(`unexpected root expand: ${JSON.stringify(expanded)}`);
  }
  if (expanded.page[0]?.childCount !== 2) {
    throw new Error(`scope childCount=${expanded.page[0]?.childCount}, expected 2`);
  }
  if (env.appendLog.length !== 0) throw new Error("whale_expand must not append DSH messages");
});

runtimeChecks.push(async () => {
  const rootDir = tempRoot();
  const env = makeContext();
  pluginDefault.apply(env.ctx, { storeRootDir: rootDir });
  const sessionId = "session-d";
  const surfaceNodes = [];
  const { agent } = makeCheckpointAgent(sessionId, env.agents, env.appendLog, surfaceNodes);

  for (let round = 1; round <= 4; round += 1) {
    await runCaptureCloseRound(env, agent, surfaceNodes, (round - 1) * 2 + 1, round);
    if (round < 4 && env.appendLog.length !== 0) {
      throw new Error(`replace happened before first compressible boundary (round ${round})`);
    }
  }
  if (env.appendLog.length !== 1) {
    throw new Error(`expected exactly one replace after 4th round, got ${env.appendLog.length}`);
  }
  const append = env.appendLog[0];
  if (append.type !== "user/message") throw new Error(`checkpoint type=${append.type}`);
  if (append.data?.source?.plugin !== "kaz-context-runtime") throw new Error("checkpoint source not Kaz-owned");
  const op = append.opts?.surfaceOp;
  if (!op || op.op !== "replace" || op.start !== 1 || op.end !== 8) {
    throw new Error(`checkpoint surfaceOp wrong: ${JSON.stringify(op)}`);
  }
  if (append.opts?.sourceEventSeqs?.length !== 8) {
    throw new Error(`shadowed seqs=${append.opts?.sourceEventSeqs?.length}, expected 8`);
  }
  const contentText = append.data?.content?.[0]?.text ?? "";
  if (!contentText.includes("probe summary for close-round")) {
    throw new Error("checkpoint content does not carry render() profile text");
  }
  if (surfaceNodes.length !== 1) throw new Error(`surface tail after replace=${surfaceNodes.length}`);

  const session = loadSession(rootDir, sessionId);
  if (session.rootChildren.length !== 1) throw new Error("auto-sublime block missing");
  const block = session.rootChildren[0];
  if (block.nodeType !== "block" || block.boundary !== "sublimed" || block.level !== 2) {
    throw new Error(`root block shape wrong: ${JSON.stringify({ nodeType: block.nodeType, boundary: block.boundary, level: block.level })}`);
  }

  // whale_expand reads the FULL persisted Session: hidden original leaves stay
  // reachable through the sublimed block → round block path.
  const definition = env.toolCalls[0];
  const rootExpanded = await definition.execute({ path: "" }, { agent });
  if (!rootExpanded.ok || rootExpanded.page[0]?.kind !== "block") {
    throw new Error(`root expand after replace failed: ${JSON.stringify(rootExpanded)}`);
  }
  const blockId = rootExpanded.page[0].sourceId;
  const roundsExpanded = await definition.execute({ path: blockId, limit: 100 }, { agent });
  if (!roundsExpanded.ok || roundsExpanded.total !== 4) {
    throw new Error(`round blocks expand failed: ${JSON.stringify(roundsExpanded)}`);
  }
  const firstRoundId = roundsExpanded.page[0]?.sourceId;
  const leavesExpanded = await definition.execute({ path: `${blockId}/${firstRoundId}`, limit: 100 }, { agent });
  const originalFound = (leavesExpanded.page ?? []).some(
    (item) => item?.kind === "leaf" && JSON.stringify(item.message).includes("user message 1"),
  );
  if (!originalFound) throw new Error("whale_expand cannot read original leaf inside closed history");
});

runtimeChecks.push(async () => {
  const rootDir = tempRoot();
  const env = makeContext();
  pluginDefault.apply(env.ctx, { storeRootDir: rootDir });
  const sessionId = "session-e";
  const surfaceNodes = [];
  const { agent } = makeCheckpointAgent(sessionId, env.agents, env.appendLog, surfaceNodes, {
    failOnce: true,
  });

  // First compressible boundary (4th round): replace append throws once. The
  // close/tree commit must survive, the surface must stay original, and the
  // user round must not fail.
  for (let round = 1; round <= 4; round += 1) {
    await runCaptureCloseRound(env, agent, surfaceNodes, (round - 1) * 2 + 1, round);
  }
  if (env.appendLog.length !== 0) throw new Error("failed replace must not append");
  if (surfaceNodes.length !== 8) throw new Error(`surface changed on failed replace: ${surfaceNodes.length}`);
  let session = loadSession(rootDir, sessionId);
  if (session.rootChildren.length !== 1 || session.rootChildren[0].boundary !== "sublimed") {
    throw new Error("tree close/sublime did not survive replace failure");
  }
  if (findInnermostOpenScope(session)) throw new Error("failed replace left an open scope");

  // Next milestone (8th round) retries and succeeds; the new checkpoint shadows
  // all 16 original surface nodes (old 8 from the failed first milestone plus
  // the 8 new round events), because the original history was never replaced.
  for (let round = 5; round <= 8; round += 1) {
    await runCaptureCloseRound(env, agent, surfaceNodes, (round - 1) * 2 + 1, round);
  }
  if (env.appendLog.length !== 1) {
    throw new Error(`retry replace count=${env.appendLog.length}, expected 1`);
  }
  const append = env.appendLog[0];
  if (append.opts?.sourceEventSeqs?.length !== 16) {
    throw new Error(`retry shadowed seqs=${append.opts?.sourceEventSeqs?.length}, expected 16`);
  }
  if (surfaceNodes.length !== 1) throw new Error(`surface tail after retry=${surfaceNodes.length}`);
  session = loadSession(rootDir, sessionId);
  if (findInnermostOpenScope(session)) throw new Error("open scope left after retry milestone");
});

runtimeChecks.push(async () => {
  const rootDir = tempRoot();
  const env = makeContext();
  pluginDefault.apply(env.ctx, { storeRootDir: rootDir });
  const sessionId = "session-f";
  const surfaceNodes = [];
  const { agent } = makeCheckpointAgent(sessionId, env.agents, env.appendLog, surfaceNodes);

  // A foreign DSH compaction bracket must suppress Kaz replaces until end.
  env.handlers["session/event"][0](agent.session, {
    type: "compaction/start",
    seq: 100,
    data: { compactionId: "foreign-1", turn: null },
  });
  for (let round = 1; round <= 4; round += 1) {
    await runCaptureCloseRound(env, agent, surfaceNodes, (round - 1) * 2 + 1, round);
  }
  if (env.appendLog.length !== 0) throw new Error("replace ran during foreign compaction bracket");
  if (surfaceNodes.length !== 8) throw new Error(`surface changed during foreign bracket: ${surfaceNodes.length}`);

  env.handlers["session/event"][0](agent.session, {
    type: "compaction/end",
    seq: 101,
    data: { compactionId: "foreign-1", turn: null },
  });
  for (let round = 5; round <= 8; round += 1) {
    await runCaptureCloseRound(env, agent, surfaceNodes, (round - 1) * 2 + 1, round);
  }
  if (env.appendLog.length !== 1) {
    throw new Error(`replace after foreign bracket=${env.appendLog.length}, expected 1`);
  }
  const append = env.appendLog[0];
  if (append.opts?.sourceEventSeqs?.length !== 16) {
    throw new Error(`post-bracket shadowed seqs=${append.opts?.sourceEventSeqs?.length}, expected 16`);
  }
});

runtimeChecks.push(async () => {
  const rootDir = tempRoot();
  const env = makeContext();
  pluginDefault.apply(env.ctx, { storeRootDir: rootDir });
  const sessionId = "session-planitem";
  const surfaceNodes = [];
  const { agent } = makeCheckpointAgent(sessionId, env.agents, env.appendLog, surfaceNodes);
  const service = env.provides["kazContextBoundary"];

  const opened = service.openPlanItem(agent, { planItemId: "plan-1" });
  if (!opened.opened || opened.boundary !== "planItem") {
    throw new Error(`openPlanItem failed: ${JSON.stringify(opened)}`);
  }
  for (let round = 1; round <= 2; round += 1) {
    await runCaptureCloseRound(env, agent, surfaceNodes, (round - 1) * 2 + 1, round);
  }
  if (env.appendLog.length !== 0) {
    throw new Error(`planItem replace happened before planItem close: ${env.appendLog.length}`);
  }
  const openStatus = service.status(agent);
  if (!openStatus.ok || openStatus.planItem !== true || openStatus.round !== false) {
    throw new Error(`open planItem status wrong: ${JSON.stringify(openStatus)}`);
  }

  // Real chain: planItem complete → level2 close → one surface-replace.
  const closed = await service.closePlanItem(agent);
  if (!closed.closed || closed.boundary !== "planItem") {
    throw new Error(`closePlanItem failed: ${JSON.stringify(closed)}`);
  }
  if (env.appendLog.length !== 1) {
    throw new Error(`planItem replace count=${env.appendLog.length}, expected 1`);
  }
  const append = env.appendLog[0];
  if (append.data?.source?.boundary !== "planItem") {
    throw new Error(`planItem checkpoint boundary wrong: ${JSON.stringify(append.data?.source)}`);
  }
  if (append.opts?.sourceEventSeqs?.length !== 4) {
    throw new Error(`planItem shadowed seqs=${append.opts?.sourceEventSeqs?.length}, expected 4`);
  }
  const session = loadSession(rootDir, sessionId);
  const block = session.rootChildren[0];
  if (!block || block.nodeType !== "block" || block.boundary !== "planItem" || block.level !== 2) {
    throw new Error(`planItem block shape wrong: ${JSON.stringify(block)}`);
  }
  const closedStatus = service.status(agent);
  if (closedStatus.planItem !== false) {
    throw new Error(`planItem still open after close: ${JSON.stringify(closedStatus)}`);
  }
});

runtimeChecks.push(async () => {
  const rootDir = tempRoot();
  const env = makeContext();
  pluginDefault.apply(env.ctx, { storeRootDir: rootDir });
  const sessionId = "session-goal";
  const surfaceNodes = [];
  const { agent } = makeCheckpointAgent(sessionId, env.agents, env.appendLog, surfaceNodes);
  const service = env.provides["kazContextBoundary"];

  const opened = service.openGoal(agent, { goalId: "goal-1" });
  if (!opened.opened || opened.boundary !== "goal") {
    throw new Error(`openGoal failed: ${JSON.stringify(opened)}`);
  }
  for (let round = 1; round <= 2; round += 1) {
    await runCaptureCloseRound(env, agent, surfaceNodes, (round - 1) * 2 + 1, round);
  }
  if (env.appendLog.length !== 0) {
    throw new Error(`goal replace happened before goal close: ${env.appendLog.length}`);
  }
  const openStatus = service.status(agent);
  if (!openStatus.ok || openStatus.goal !== true || openStatus.round !== false) {
    throw new Error(`open goal status wrong: ${JSON.stringify(openStatus)}`);
  }

  // Real chain: Goal complete → level3 close → one surface-replace.
  const closed = await service.closeGoal(agent);
  if (!closed.closed || closed.boundary !== "goal") {
    throw new Error(`closeGoal failed: ${JSON.stringify(closed)}`);
  }
  if (env.appendLog.length !== 1) {
    throw new Error(`goal replace count=${env.appendLog.length}, expected 1`);
  }
  const append = env.appendLog[0];
  if (append.data?.source?.boundary !== "goal") {
    throw new Error(`goal checkpoint boundary wrong: ${JSON.stringify(append.data?.source)}`);
  }
  if (append.opts?.sourceEventSeqs?.length !== 4) {
    throw new Error(`goal shadowed seqs=${append.opts?.sourceEventSeqs?.length}, expected 4`);
  }
  const session = loadSession(rootDir, sessionId);
  const block = session.rootChildren[0];
  if (!block || block.nodeType !== "block" || block.boundary !== "goal" || block.level !== 3) {
    throw new Error(`goal block shape wrong: ${JSON.stringify(block)}`);
  }
});

runtimeChecks.push(async () => {
  const rootDir = tempRoot();
  const env = makeContext();
  pluginDefault.apply(env.ctx, { storeRootDir: rootDir });
  const sessionId = "session-event";
  const surfaceNodes = [];
  const { agent } = makeCheckpointAgent(sessionId, env.agents, env.appendLog, surfaceNodes);

  // Compatible explicit Kaz boundary events (service entry through session/event).
  env.handlers["session/event"][0](agent.session, {
    type: "kazContextBoundary/open",
    data: { boundary: "planItem", sessionId, planItemId: "plan-event" },
  });
  const service = env.provides["kazContextBoundary"];
  const afterOpenStatus = service.status(agent);
  if (!afterOpenStatus.ok || afterOpenStatus.planItem !== true) {
    throw new Error(`open event status wrong: ${JSON.stringify(afterOpenStatus)}`);
  }
  for (let round = 1; round <= 2; round += 1) {
    await runCaptureCloseRound(env, agent, surfaceNodes, (round - 1) * 2 + 1, round);
  }
  if (env.appendLog.length !== 0) {
    throw new Error(`event planItem replace happened early: ${env.appendLog.length}`);
  }
  const closeEvent = {
    type: "kazContextBoundary/close",
    data: { boundary: "planItem", sessionId },
  };
  const closeHandled = service.handleBoundaryEvent(agent.session, closeEvent);
  const closeResult = await closeHandled.promise;
  if (!closeResult.closed) {
    throw new Error(`service close after event open failed: ${JSON.stringify(closeResult)}`);
  }
  if (env.appendLog.length !== 1) {
    throw new Error(`boundary event replace count=${env.appendLog.length}, result=${JSON.stringify(closeResult)}`);
  }
  const append = env.appendLog[0];
  if (append.data?.source?.boundary !== "planItem") {
    throw new Error(`boundary event checkpoint boundary wrong: ${JSON.stringify(append.data?.source)}`);
  }
  const session = loadSession(rootDir, sessionId);
  if (!session.rootChildren[0] || session.rootChildren[0].boundary !== "planItem") {
    throw new Error("boundary event did not close planItem scope");
  }
});

runtimeChecks.push(async () => {
  const rootDir = tempRoot();
  const sessionId = "session-auto-planitem";
  let workflowStage = "working";
  const workflowService = {
    stageOf: () => workflowStage,
    subagentRoleOf: (agent) =>
      agent?.session?.id === sessionId
        ? { planItemId: "p-auto", persona: "worker", assignedTools: [], finalTools: [] }
        : null,
  };
  const env = makeContext({ kaWhaleWorkflow: workflowService });
  pluginDefault.apply(env.ctx, { storeRootDir: rootDir });
  const surfaceNodes = [];
  const { agent } = makeCheckpointAgent(sessionId, env.agents, env.appendLog, surfaceNodes);
  const service = env.provides["kazContextBoundary"];

  // ka-whale-workflow controlled role record signals planItem open automatically.
  for (let round = 1; round <= 2; round += 1) {
    await runCaptureCloseRound(env, agent, surfaceNodes, (round - 1) * 2 + 1, round);
  }
  const openStatus = service.status(agent);
  if (openStatus.planItem !== true) {
    throw new Error(`workflow bridge did not open planItem: ${JSON.stringify(openStatus)}`);
  }
  if (env.appendLog.length !== 0) {
    throw new Error(`auto planItem replace happened early: ${env.appendLog.length}`);
  }

  // Controlled stage reaches end → level2 close → one surface-replace.
  workflowStage = "end";
  await env.handlers["agent/turn-stopping"][0]({ agent, turn: 3, signal: { aborted: false } });
  await flushMicrotasks();
  if (env.appendLog.length !== 1) {
    throw new Error(`auto planItem replace count=${env.appendLog.length}, expected 1`);
  }
  const append = env.appendLog[0];
  if (append.data?.source?.boundary !== "planItem") {
    throw new Error(`auto planItem checkpoint boundary wrong: ${JSON.stringify(append.data?.source)}`);
  }
  const session = loadSession(rootDir, sessionId);
  if (!session.rootChildren[0] || session.rootChildren[0].boundary !== "planItem") {
    throw new Error("auto planItem close did not produce a planItem block");
  }
});

runtimeChecks.push(async () => {
  const rootDir = tempRoot();
  const sessionId = "session-auto-goal";
  let goalPhase = "active";
  const goalsService = {
    get: () => ({ id: "goal-auto", phase: goalPhase }),
  };
  const env = makeContext({ goals: goalsService });
  pluginDefault.apply(env.ctx, { storeRootDir: rootDir });
  const surfaceNodes = [];
  const { agent } = makeCheckpointAgent(sessionId, env.agents, env.appendLog, surfaceNodes);
  const service = env.provides["kazContextBoundary"];

  // goals service phase=active signals main goal open automatically.
  for (let round = 1; round <= 2; round += 1) {
    await runCaptureCloseRound(env, agent, surfaceNodes, (round - 1) * 2 + 1, round);
  }
  const openStatus = service.status(agent);
  if (openStatus.goal !== true) {
    throw new Error(`workflow bridge did not open goal: ${JSON.stringify(openStatus)}`);
  }
  if (env.appendLog.length !== 0) {
    throw new Error(`auto goal replace happened early: ${env.appendLog.length}`);
  }

  // Goal terminal phase (no active/paused goal) → level3 close → one replace.
  goalPhase = "complete";
  await env.handlers["agent/turn-stopping"][0]({ agent, turn: 3, signal: { aborted: false } });
  await flushMicrotasks();
  if (env.appendLog.length !== 1) {
    throw new Error(`auto goal replace count=${env.appendLog.length}, expected 1`);
  }
  const append = env.appendLog[0];
  if (append.data?.source?.boundary !== "goal") {
    throw new Error(`auto goal checkpoint boundary wrong: ${JSON.stringify(append.data?.source)}`);
  }
  const session = loadSession(rootDir, sessionId);
  if (!session.rootChildren[0] || session.rootChildren[0].boundary !== "goal") {
    throw new Error("auto goal close did not produce a goal block");
  }
});

for (const fn of runtimeChecks) {
  try {
    await fn();
    passed += 1;
    console.log(`[PASS] runtime check ${passed}`);
  } catch (error) {
    failed += 1;
    console.log(`[FAIL] runtime check ${failed}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

for (const dir of rootDirs) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort temp cleanup
  }
}

if (failed > 0) {
  console.error(`probe-runtime.mjs FAILED (${failed})`);
  process.exitCode = 1;
} else {
  console.log(`probe-runtime.mjs ALL PASS (${passed})`);
}
