// kaz-context-runtime —— Kaz-only tree runtime driver (Cordis plugin).
// ===========================================================================
// Kaz7.0 M6 runtime wiring, v0.3.0:
//   * Listens to real DSH session/event, agent/pre-step, agent/turn-stopping,
//     agent/status, and agent/disposed.
//   * Mirrors append-origin user/assistant/tool/injection/subagent_report
//     events into the Kaz session tree and persists each reducer commit through
//     kaz-shared session-tree-store-io.
//   * Closes a completed round at agent/turn-stopping using whaleSummarizer;
//     turn/end completed is the authoritative fallback. Summary failure is
//     contained: pendingClose is retried at the next pre-step, never turned
//     into a user-visible turn error.
//   * v0.3.0 persistent surface compaction: after a structural milestone
//     (close planItem/goal or an auto-sublime of round blocks) whose child
//     summaries are already landed, appends ONE Kaz-owned user/message
//     checkpoint through the official DSH surface-replace seam
//     (surfaceOp {op:'replace',start,end} + complete sourceEventSeqs). The
//     checkpoint text is render(session,{mode:'text'}) newest-branch profile.
//     Replace runs inside the per-session single-flight close section; a
//     failure is contained (atomic append leaves the original surface intact)
//     and is retried at the next milestone.
//   * v0.2.0 M6 version boundary retained: read-only Stable Main tool
//     whale_expand (wraps kaz-shared session-tree-expand over the complete
//     persisted Session).
//   * Per-session single-flight guards close/persist/checkpoint;
//     replacement/Kaz-owned events are filtered out so the driver cannot mirror
//     its own checkpoints; foreign compaction/start…end brackets suppress Kaz
//     replaces.
// ===========================================================================

import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { expand } from "kaz-shared/lib/session-tree-expand.js";
import { append, close, createSession } from "kaz-shared/lib/session-tree.js";
import { createSessionTreeStore } from "kaz-shared/lib/session-tree-store-io.js";
import {
  BOUNDARY_EVENT_CLOSE,
  BOUNDARY_EVENT_OPEN,
  PLUGIN_ID,
  WHALE_EXPAND_TOOL,
  boundaryCloseOrder,
  boundaryOpenPlan,
  checkpointMessageInput,
  collectSeenDshSeqs,
  collectSeenMessageIds,
  directChildrenEvidence,
  eventToLeafInput,
  findInnermostOpenScope,
  hasOpenBoundary,
  isAppendSurfaceEvent,
  isBoundaryKind,
  isCompletedTurnEndEvent,
  isMilestoneChanges,
  maxClosedLeafDshSeq,
  normalizeBoundaryEvent,
  openBoundaryScope,
  openRoundIfNeeded,
  openScopeStack,
  pickCheckpointSurfaceRange,
  renderCheckpointText,
} from "./core.mjs";


function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sessionIdOf(value) {
  try {
    if (value === null || value === undefined) return null;
    const id =
      value.session?.id ??
      value.id ??
      value.sessionId ??
      value.session?.sessionId;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function reducerError(error) {
  if (error && typeof error === "object" && error.error) {
    return `${error.error.code ?? "unknown"}: ${error.error.message ?? String(error)}`;
  }
  return errorMessage(error);
}

export default {
  name: PLUGIN_ID,
  inject: ["tools"],
  apply(ctx, config = {}) {
    const rootDir =
      typeof config.storeRootDir === "string" && config.storeRootDir.trim().length > 0
        ? config.storeRootDir.trim()
        : undefined;
    const enableSurfaceReplace =
      config.enableSurfaceReplace !== false;
    const enableWorkflowBridge =
      config.workflowSignalBridge !== false;
    const bySession = new Map();

    function sessionStateForTool(agent) {
      const sessionId = sessionIdOf(agent);
      if (!sessionId) {
        throw new Error(
          "WHALE_EXPAND_NO_SESSION: whale_expand requires a live agent/session",
        );
      }
      return ensureState(sessionId);
    }

    async function executeWhaleExpand(args, exec) {
      const state = sessionStateForTool(exec?.agent);
      const result = expand(
        state.currentSession,
        typeof args.path === "string" ? args.path : "",
        {
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        },
      );
      return result;
    }

    const whaleExpandDef = defineTool({
      name: WHALE_EXPAND_TOOL,
      description:
        "Read-only tree expansion for the current Kaz context session: given a tree path, return that block/scope's direct children or a leaf's full original message with sourceId/sourcePath. Use when compressed tree context hides details that must be recovered exactly.",
      parameters: {
        path: {
          type: "string",
          required: true,
          description:
            "Tree path of source ids from the current session tree root; empty string lists all root children (including hidden roots).",
        },
        limit: {
          type: "integer",
          description:
            "Optional maximum return size in approximate units (default 1000). A single oversized item is returned whole.",
        },
        cursor: {
          type: "string",
          description:
            "Opaque continuation cursor from a previous whale_expand result with hasMore true; pass it with the same path to fetch the next page.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
        },
        render: (_args, value) => [
          { type: "text", text: JSON.stringify(value) },
        ],
      },
      execute: executeWhaleExpand,
      presentCall: () => ({ card: "generic", title: "展开上下文树", kind: "other" }),
    });

    let whaleExpandDisposed = false;
    const disposeWhaleExpand = ctx.tools.register(whaleExpandDef);
    ctx.effect(() => () => {
      if (whaleExpandDisposed) return;
      whaleExpandDisposed = true;
      try {
        disposeWhaleExpand();
      } catch (error) {
        logWarn(`unregister ${WHALE_EXPAND_TOOL} failed: ${errorMessage(error)}`);
      }
    }, `${PLUGIN_ID}: unregister ${WHALE_EXPAND_TOOL}`);

    function logInfo(message) {
      try {
        ctx.logger?.info?.(`[${PLUGIN_ID}] ${message}`);
      } catch {
        // logging must never break the driver
      }
    }

    function logWarn(message) {
      try {
        ctx.logger?.warn?.(`[${PLUGIN_ID}] ${message}`);
      } catch {
        // logging must never break the driver
      }
    }

    function logDebug(message) {
      try {
        ctx.logger?.debug?.(`[${PLUGIN_ID}] ${message}`);
      } catch {
        // logging must never break the driver
      }
    }



    function resolveAgent(sessionId) {
      try {
        const agents = ctx.get?.("agents");
        if (agents !== null && agents !== undefined && typeof agents.get === "function") {
          const agent = agents.get(sessionId);
          if (agent !== null && agent !== undefined) return agent;
        }
      } catch {
        // fall through
      }
      return undefined;
    }

    function ensureState(sessionId) {
      let state = bySession.get(sessionId);
      if (state) return state;
      const store = createSessionTreeStore(
        rootDir === undefined ? { sessionId } : { sessionId, rootDir },
      );
      const loaded = store.load();
      let session;
      if (loaded.ok) {
        session = loaded.session;
      } else if (loaded.code === "missing-logs") {
        const created = createSession({ id: sessionId });
        if (created.error) {
          throw new Error(`createSession failed: ${reducerError(created)}`);
        }
        session = created.session;
      } else {
        throw new Error(`session-tree store load failed: ${loaded.code ?? "unknown"}: ${loaded.error ?? ""}`);
      }
      state = {
        store,
        sessionId,
        currentSession: session,
        seenDshSeqs: collectSeenDshSeqs(session),
        seenMessageIds: collectSeenMessageIds(session),
        pendingClose: false,
        busy: false,
        disposed: false,
        compactionActive: false,
        lastCheckpoint: null,
        goalCloseQueued: false,
        planItemCloseQueued: false,
      };
      bySession.set(sessionId, state);
      return state;
    }

    function commit(sessionId, result) {
      if (!result || typeof result !== "object" || result.error) {
        throw new Error(`tree reducer failed: ${reducerError(result ?? "empty result")}`);
      }
      const state = bySession.get(sessionId);
      if (!state) throw new Error("state missing during commit");
      const saved = state.store.commitReducerResult(result);
      if (!saved?.ok) {
        throw new Error(`tree store commit failed: ${saved?.code ?? "unknown"}: ${saved?.error ?? ""}`);
      }
      state.currentSession = result.session;
      state.seenDshSeqs = collectSeenDshSeqs(result.session);
      state.seenMessageIds = collectSeenMessageIds(result.session);
      return saved;
    }

    function milestoneOf(changes) {
      if (!Array.isArray(changes)) return null;
      for (const change of changes) {
        if (!isPlainObject(change)) continue;
        if (change.type === "sublime") {
          return {
            boundary: "sublimed",
            blockId:
              typeof change.parentBlockId === "string" ? change.parentBlockId : undefined,
          };
        }
        if (change.type === "close") {
          return {
            boundary: typeof change.boundary === "string" ? change.boundary : undefined,
            blockId: typeof change.blockId === "string" ? change.blockId : undefined,
          };
        }
      }
      return null;
    }

    /**
     * One boundary-only surface checkpoint replace through the official DSH
     * surface-replace seam. Runs inside the same single-flight close section;
     * any failure is contained (Session.append is atomic, so the original
     * surface/history stays intact) and never turns the user round into error.
     */
    function performSurfaceCheckpoint(sessionId, agent, changes) {
      const state = bySession.get(sessionId);
      if (!state || state.disposed) {
        return { replaced: false, reason: "disposed" };
      }
      if (enableSurfaceReplace !== true) {
        return { replaced: false, reason: "disabled" };
      }
      const milestone = milestoneOf(changes);
      if (!milestone || !isMilestoneChanges(changes)) {
        return { replaced: false, reason: "not-milestone" };
      }
      if (state.compactionActive === true) {
        return {
          replaced: false,
          reason: "foreign-compaction-active",
          detail: "skipped while a DSH compaction/start…end bracket is open",
        };
      }
      const liveAgent = agent ?? resolveAgent(sessionId);
      const dshSession = liveAgent?.session;
      if (!dshSession || typeof dshSession.append !== "function") {
        return { replaced: false, reason: "no-dsh-session" };
      }
      const surfaceNodes = Array.isArray(dshSession.surface?.nodes)
        ? Array.from(dshSession.surface.nodes)
        : undefined;
      if (!surfaceNodes) {
        return { replaced: false, reason: "no-surface-view" };
      }
      const rendered = renderCheckpointText(state.currentSession);
      if (!rendered.ok) {
        logWarn(`checkpoint render skipped for ${sessionId}: ${rendered.code}: ${rendered.reason}`);
        return { replaced: false, reason: rendered.code };
      }
      const maxClosedSeq = maxClosedLeafDshSeq(state.currentSession);
      const range = pickCheckpointSurfaceRange(surfaceNodes, maxClosedSeq);
      if (!range.ok) {
        logDebug(`checkpoint range skipped for ${sessionId}: ${range.code}: ${range.reason}`);
        return { replaced: false, reason: range.code };
      }
      const input = checkpointMessageInput({
        text: rendered.text,
        boundary: milestone.boundary,
        blockId: milestone.blockId,
        shadowedSeqCount: range.shadowedSeqs.length,
        sessionId,
        milestone: milestone.boundary,
      });
      let message;
      try {
        message = createUserMessage(input);
      } catch (error) {
        logWarn(`checkpoint message construction failed for ${sessionId}: ${errorMessage(error)}`);
        return { replaced: false, reason: "message-construction-failed" };
      }
      try {
        const appended = dshSession.append("user/message", message, {
          surfaceOp: { op: "replace", start: range.start, end: range.end },
          sourceEventSeqs: range.shadowedSeqs,
        });
        state.lastCheckpoint = {
          boundary: milestone.boundary,
          blockId: milestone.blockId,
          start: range.start,
          end: range.end,
          shadowedSeqCount: range.shadowedSeqs.length,
          eventSeq: typeof appended?.seq === "number" ? appended.seq : undefined,
        };
        logInfo(
          `surface checkpoint replaced ${range.shadowedSeqs.length} node(s) for ${sessionId} ` +
            `(boundary=${milestone.boundary}, start=${range.start}, end=${range.end})`,
        );
        return { replaced: true, ...state.lastCheckpoint };
      } catch (error) {
        logWarn(
          `surface checkpoint replace failed for ${sessionId}; original history untouched: ${errorMessage(error)}`,
        );
        return { replaced: false, reason: "append-failed", error: errorMessage(error) };
      }
    }

    function captureEvent(sessionId, event) {
      const state = ensureState(sessionId);
      if (state.disposed) return { skipped: true, reason: "disposed" };
      if (!isAppendSurfaceEvent(event)) {
        return { skipped: true, reason: "filtered" };
      }
      const mapped = eventToLeafInput(event);
      if (mapped.skip || !mapped.leaf) {
        return { skipped: true, reason: mapped.reason ?? "unmapped" };
      }
      const dshSeq = Number.isInteger(mapped.leaf.meta?.dshSeq)
        ? mapped.leaf.meta.dshSeq
        : undefined;
      if (dshSeq !== undefined && state.seenDshSeqs.has(dshSeq)) {
        return { skipped: true, reason: "duplicate-dsh-seq" };
      }
      if (
        dshSeq === undefined &&
        typeof mapped.leaf.meta?.messageId === "string" &&
        state.seenMessageIds.has(mapped.leaf.meta.messageId)
      ) {
        return { skipped: true, reason: "duplicate-message-id" };
      }

      const opened = openRoundIfNeeded(state.currentSession, {
        ...(mapped.leaf.meta?.turn !== undefined
          ? { turn: mapped.leaf.meta.turn }
          : {}),
        source: PLUGIN_ID,
      });
      if (opened.error) {
        throw new Error(`open round failed: ${reducerError(opened)}`);
      }
      if (opened.changed !== false) commit(sessionId, opened);

      const appended = append(state.currentSession, mapped.leaf);
      if (appended.error) {
        throw new Error(`append leaf failed: ${reducerError(appended)}`);
      }
      commit(sessionId, appended);
      return {
        captured: true,
        leafId: appended.changes?.[0]?.leafId,
        kind: mapped.leaf.kind,
        dshSeq,
      };
    }

    /**
     * Summarize and close the CURRENT innermost open scope. Caller must hold
     * the per-session single-flight lock (`state.busy === true`). Returns a
     * `closed: true` result or a structured refusal. Throws on summarizer
     * contract/LLM errors so the caller can decide pending/retry semantics.
     */
    async function summarizeAndCloseInnermost(
      sessionId,
      { agent, signal, allowCheckpoint = true, expectedBoundary } = {},
    ) {
      const state = bySession.get(sessionId);
      if (!state || state.disposed) return { closed: false, reason: "disposed" };
      const innermost = findInnermostOpenScope(state.currentSession);
      if (!innermost) return { closed: false, reason: "no-open-scope" };
      if (expectedBoundary !== undefined && innermost.scope.boundary !== expectedBoundary) {
        return {
          closed: false,
          reason: "boundary-mismatch",
          expected: expectedBoundary,
          actual: innermost.scope.boundary,
        };
      }
      if (!Array.isArray(innermost.scope.children) || innermost.scope.children.length === 0) {
        return { closed: false, reason: "empty-scope", scopeId: innermost.scope.id };
      }
      const prepared = directChildrenEvidence(state.currentSession);
      if (!prepared.found) {
        return { closed: false, reason: prepared.reason ?? "no-evidence" };
      }
      let summarizer;
      try {
        summarizer = ctx.get?.("whaleSummarizer");
      } catch {
        summarizer = undefined;
      }
      if (!summarizer || typeof summarizer.summarize !== "function") {
        logWarn(`whaleSummarizer unavailable for ${sessionId}; boundary stays open (pending close)`);
        return { closed: false, reason: "summarizer-unavailable" };
      }
      const liveAgent = agent ?? resolveAgent(sessionId);
      const summarized = await summarizer.summarize(
        {
          evidence: prepared.evidence,
          refs: prepared.refs,
          purpose: prepared.purpose,
        },
        { agent: liveAgent, signal },
      );
      if (!isPlainObject(summarized) || typeof summarized.summary !== "string" || summarized.summary.trim().length === 0) {
        throw new Error("whaleSummarizer returned an empty summary");
      }
      const closed = close(state.currentSession, {
        scopeId: prepared.scopeId,
        boundary: prepared.boundary,
        summary: summarized.summary.trim(),
      });
      if (closed.error) {
        throw new Error(`close reducer failed: ${reducerError(closed)}`);
      }
      commit(sessionId, closed);
      const checkpoint =
        allowCheckpoint === true
          ? performSurfaceCheckpoint(sessionId, agent, closed.changes)
          : { replaced: false, reason: "suppressed" };
      logInfo(
        `closed ${prepared.boundary} ${prepared.scopeId} for ${sessionId} (children=${prepared.evidence.length}, ` +
          `checkpoint=${checkpoint.replaced === true ? "replaced" : checkpoint.reason})`,
      );
      return {
        closed: true,
        scopeId: prepared.scopeId,
        blockId: closed.changes?.find((change) => change?.type === "close")?.blockId,
        summary: summarized.summary.trim(),
        checkpoint,
      };
    }

    /** Round-close entry: keeps the old single-flight closeRound contract. */
    async function closeRound(sessionId, { agent, signal } = {}) {
      const state = bySession.get(sessionId);
      if (!state || state.disposed) return { closed: false, reason: "disposed" };
      const innermost = findInnermostOpenScope(state.currentSession);
      if (!innermost) {
        state.pendingClose = false;
        return { closed: false, reason: "no-open-scope" };
      }
      if (!Array.isArray(innermost.scope.children) || innermost.scope.children.length === 0) {
        state.pendingClose = false;
        return { closed: false, reason: "empty-scope" };
      }
      if (state.busy) {
        state.pendingClose = true;
        return { closed: false, reason: "busy" };
      }
      state.busy = true;
      try {
        const result = await summarizeAndCloseInnermost(sessionId, {
          agent,
          signal,
          allowCheckpoint: true,
        });

        if (result.closed === true || result.reason === "no-open-scope" || result.reason === "empty-scope") {
          state.pendingClose = false;
        } else if (result.reason === "summarizer-unavailable") {

          state.pendingClose = true;
        }
        return result;
      } catch (error) {
        if (signal?.aborted === true || error?.name === "AbortError") {
          logDebug(`close round aborted for ${sessionId}: ${errorMessage(error)}`);
          state.pendingClose = false;
          return { closed: false, reason: "aborted" };
        }
        logWarn(`close round failed for ${sessionId}; boundary stays open and pending retry: ${errorMessage(error)}`);

        state.pendingClose = true;
        return { closed: false, reason: "summary-failed" };
      } finally {
        state.busy = false;
      }
    }

    /**
     * v0.3.1 boundary-close entry for planItem/goal. Runs inside one
     * per-session single-flight section: deeper open scopes are closed first
     * WITHOUT intermediate checkpoints, then the requested boundary is closed
     * and exactly one surface-replace checkpoint is attempted.
     */
    async function closeBoundaryScope(sessionId, boundary, { agent, signal } = {}) {
      const state = bySession.get(sessionId);
      if (!state || state.disposed) return { closed: false, reason: "disposed" };
      const order = boundaryCloseOrder(state.currentSession, boundary);
      if (!order.found) {
        return { closed: false, reason: order.code ?? "boundary-not-open" };
      }
      if (state.busy) {
        state.pendingClose = true;
        return { closed: false, reason: "busy" };
      }
      state.busy = true;
      try {
        for (const pre of order.preClose) {
          const result = await summarizeAndCloseInnermost(sessionId, {
            agent,
            signal,
            allowCheckpoint: false,
            expectedBoundary: pre.boundary,
          });
          if (result.closed !== true) {
            state.pendingClose = true;
            return {
              closed: false,
              reason: `pre-close-${result.reason ?? "failed"}`,
              boundary,
              preCloseBoundary: pre.boundary,
              preCloseScopeId: pre.scopeId,
            };
          }
        }
        const result = await summarizeAndCloseInnermost(sessionId, {
          agent,
          signal,
          allowCheckpoint: true,
          expectedBoundary: boundary,
        });
        if (result.closed !== true) {
          if (result.reason === "summarizer-unavailable") state.pendingClose = true;
          return { closed: false, reason: result.reason ?? "close-failed", boundary };
        }
        state.pendingClose = false;
        return { ...result, boundary };
      } catch (error) {
        if (signal?.aborted === true || error?.name === "AbortError") {
          logDebug(`boundary close aborted for ${sessionId} (${boundary}): ${errorMessage(error)}`);
          state.pendingClose = false;
          return { closed: false, reason: "aborted", boundary };
        }
        logWarn(
          `boundary close failed for ${sessionId} (${boundary}); scopes stay open and pending retry: ${errorMessage(error)}`,
        );
        state.pendingClose = true;
        return { closed: false, reason: "boundary-close-failed", boundary };
      } finally {
        state.busy = false;
      }
    }

    function lastChildIsAssistantLeaf(session) {
      const innermost = findInnermostOpenScope(session);
      if (!innermost) return false;
      const children = Array.isArray(innermost.scope.children) ? innermost.scope.children : [];
      if (children.length === 0) return false;
      const last = children[children.length - 1];
      return last?.nodeType === "leaf" && last?.kind === "assistant";
    }
    async function retryPendingClose(agent) {
      const sessionId = sessionIdOf(agent);
      if (!sessionId) return { retried: false };
      const state = bySession.get(sessionId);
      if (!state || !state.pendingClose || state.busy || state.disposed) {
        return { retried: false };
      }
      logDebug(`retrying pending close for ${sessionId} at pre-step`);
      return closeRound(sessionId, { agent, signal: agent?.session?.signal });
    }

    // -----------------------------------------------------------------------
    // v0.3.1 workflow boundary bridge: session resolution, open/close API,
    // compatible event handling, and best-effort ka-whale-workflow signal sync.
    // -----------------------------------------------------------------------

    function sessionIdFromTarget(target) {
      if (typeof target === "string" && target.trim().length > 0) return target.trim();
      if (target === null || target === undefined || typeof target !== "object") return null;
      const id =
        target.session?.id ??
        target.id ??
        target.sessionId ??
        target.session?.sessionId;
      return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
    }

    function agentFromTarget(target) {
      if (target === null || target === undefined) return undefined;
      if (typeof target === "object" && target !== null) {
        const looksLikeAgent =
          (typeof target.session === "object" && target.session !== null) ||
          (typeof target.options === "object" && target.options !== null);
        if (looksLikeAgent) return target;
        const id = sessionIdFromTarget(target);
        if (id) return resolveAgent(id);
      }
      if (typeof target === "string") return resolveAgent(target);
      return undefined;
    }

    function openBoundaryForSession(sessionId, boundary, options = {}) {
      if (!isBoundaryKind(boundary)) {
        return { opened: false, reason: "invalid-boundary" };
      }
      const state = ensureState(sessionId);
      if (state.disposed) return { opened: false, reason: "disposed" };
      const plan = boundaryOpenPlan(state.currentSession, boundary);
      if (!plan.ok) {
        return { opened: false, reason: plan.code, detail: plan.reason };
      }
      const meta = {
        source: PLUGIN_ID,
        boundary,
        ...(options.planItemId !== undefined ? { planItemId: options.planItemId } : {}),
        ...(options.goalId !== undefined ? { goalId: options.goalId } : {}),
        ...(isPlainObject(options.meta) ? options.meta : {}),
      };
      const opened = openBoundaryScope(state.currentSession, {
        boundary,
        scopeId: options.scopeId,
        meta,
      });
      if (opened.error) {
        return {
          opened: false,
          reason: opened.error.code ?? "open-failed",
          detail: opened.error.message ?? String(opened.error),
        };
      }
      commit(sessionId, opened);
      const scopeId = opened.changes?.[0]?.scopeId;
      logInfo(`opened ${boundary} scope ${scopeId ?? "(auto)"} for ${sessionId}`);
      return { opened: true, boundary, scopeId, changes: opened.changes };
    }

    function boundaryStatusForSession(sessionId) {
      const state = ensureState(sessionId);
      const stack = openScopeStack(state.currentSession);
      return {
        goal: stack.some((entry) => entry.scope.boundary === "goal"),
        planItem: stack.some((entry) => entry.scope.boundary === "planItem"),
        round: stack.some((entry) => entry.scope.boundary === "round"),
        stack: stack.map((entry) => entry.scope.boundary),
      };
    }

    function workflowServiceOrNull() {
      try {
        const svc = ctx.get?.("kaWhaleWorkflow");
        return svc && typeof svc === "object" ? svc : null;
      } catch {
        return null;
      }
    }

    function goalsServiceOrNull() {
      try {
        const svc = ctx.get?.("goals");
        return svc && typeof svc === "object" ? svc : null;
      } catch {
        return null;
      }
    }

    function workflowStageOfAgent(agent) {
      if (agent === null || agent === undefined || typeof agent !== "object") return null;
      try {
        const svc = workflowServiceOrNull();
        return svc && typeof svc.stageOf === "function" ? svc.stageOf(agent) : null;
      } catch {
        return null;
      }
    }

    function controlledRoleRecordOfAgent(agent) {
      if (agent === null || agent === undefined || typeof agent !== "object") return null;
      try {
        const svc = workflowServiceOrNull();
        if (svc && typeof svc.subagentRoleOf === "function") {
          const record = svc.subagentRoleOf(agent);
          return record && typeof record === "object" ? record : null;
        }
      } catch {
        // fall through
      }
      return null;
    }

    function goalActiveOfAgent(agent) {
      if (agent === null || agent === undefined || typeof agent !== "object") return false;
      try {
        const goals = goalsServiceOrNull();
        if (!goals || typeof goals.get !== "function") return false;
        const goal = goals.get(agent);
        if (goal === null || goal === undefined || typeof goal !== "object") return false;
        return goal.phase === "active" || goal.phase === "paused";
      } catch {
        return false;
      }
    }

    function scheduleBoundaryClose(sessionId, boundary, agent) {
      const state = bySession.get(sessionId);
      if (!state || state.disposed) return false;
      const queuedKey = boundary === "goal" ? "goalCloseQueued" : "planItemCloseQueued";
      if (state[queuedKey] === true) return false;
      state[queuedKey] = true;
      queueMicrotask(() => {
        const current = bySession.get(sessionId);
        if (current) current[queuedKey] = false;
        if (!current || current.disposed) return;
        if (!hasOpenBoundary(current.currentSession, boundary)) return;
        void closeBoundaryScope(sessionId, boundary, { agent: agent ?? resolveAgent(sessionId) })
          .catch((error) => {
            logDebug(`scheduled boundary close failed for ${sessionId} (${boundary}): ${errorMessage(error)}`);
          });
      });
      return true;
    }

    /**
     * Best-effort workflow signal bridge. Uses live ka-whale-workflow/goals
     * services only; never reads or modifies public plugin JSON files.
     * - controlled v0.9 child role record → open planItem (stage end → close)
     * - main goal active → open goal (no active goal → close)
     * Missing upstream main planItem-done semantics remains explicit-API.
     */
    function syncWorkflowBoundaries(agent, options = {}) {
      const scheduleCloses = options.scheduleCloses !== false;
      if (enableWorkflowBridge !== true) return { synced: false, reason: "disabled" };
      const sessionId = sessionIdOf(agent);
      if (!sessionId) return { synced: false, reason: "no-session" };
      const state = ensureState(sessionId);
      if (state.disposed) return { synced: false, reason: "disposed" };
      const record = controlledRoleRecordOfAgent(agent);
      const stage = workflowStageOfAgent(agent);
      const goals = goalsServiceOrNull();
      const goalActive = goals !== null ? goalActiveOfAgent(agent) : null;
      const changes = [];
      if (record && typeof record.planItemId === "string") {
        if (
          stage !== "end" &&
          stage !== "done" &&
          !hasOpenBoundary(state.currentSession, "planItem")
        ) {
          const opened = openBoundaryForSession(sessionId, "planItem", {
            planItemId: record.planItemId,
            meta: { persona: record.persona, workflowRole: record.persona },
          });
          changes.push({ kind: "planItem", op: "open", ...opened });
        } else if (
          (stage === "end" || stage === "done") &&
          hasOpenBoundary(state.currentSession, "planItem") &&
          scheduleCloses === true
        ) {
          scheduleBoundaryClose(sessionId, "planItem", agent);
          changes.push({ kind: "planItem", op: "close-scheduled", stage });
        }
      } else if (goalActive && !hasOpenBoundary(state.currentSession, "goal")) {
        const opened = openBoundaryForSession(sessionId, "goal", {
          meta: { goalActive: true },
        });
        changes.push({ kind: "goal", op: "open", ...opened });
      } else if (
        !goalActive &&
        hasOpenBoundary(state.currentSession, "goal") &&
        scheduleCloses === true
      ) {
        scheduleBoundaryClose(sessionId, "goal", agent);
        changes.push({ kind: "goal", op: "close-scheduled", stage });
      }
      if (changes.length > 0) {
        logDebug(`workflow boundary sync for ${sessionId}: ${JSON.stringify(changes)}`);
      }
      return { synced: true, changes };
    }

    /** After a completed turn, close workflow boundaries that reached terminal state. */
    async function closeTerminalWorkflowBoundaries(agent, sessionId, signal) {
      const state = bySession.get(sessionId);
      if (!state || state.disposed) return { closed: [] };
      const record = controlledRoleRecordOfAgent(agent);
      const stage = workflowStageOfAgent(agent);
      const goals = goalsServiceOrNull();
      const goalActive = goals !== null ? goalActiveOfAgent(agent) : null;
      const closed = [];
      if (record && typeof record.planItemId === "string" && (stage === "end" || stage === "done")) {
        if (hasOpenBoundary(state.currentSession, "planItem")) {
          const result = await closeBoundaryScope(sessionId, "planItem", { agent, signal });
          closed.push({ boundary: "planItem", ...result });
        }
      } else if (!record && goals !== null && !goalActive && hasOpenBoundary(state.currentSession, "goal")) {
        const result = await closeBoundaryScope(sessionId, "goal", { agent, signal });
        closed.push({ boundary: "goal", ...result });
      }
      return { closed };
    }

    function handleBoundaryEvent(session, event) {
      const parsed = normalizeBoundaryEvent(event);
      if (!parsed.ok) return { handled: false, reason: parsed.code };
      const sessionId = parsed.sessionId ?? sessionIdFromTarget(session);
      if (!sessionId) return { handled: false, reason: "no-session" };
      const agent = agentFromTarget(session) ?? resolveAgent(sessionId);
      if (parsed.op === "open") {
        const result = openBoundaryForSession(sessionId, parsed.boundary, {
          scopeId: parsed.scopeId,
          meta: parsed.meta,
          ...(parsed.boundary === "planItem"
            ? { planItemId: parsed.meta?.planItemId }
            : { goalId: parsed.meta?.goalId }),
        });
        return { handled: true, op: parsed.op, boundary: parsed.boundary, ...result };
      }
      if (parsed.op === "close") {
        const promise = closeBoundaryScope(sessionId, parsed.boundary, {
          agent,
        });
        return { handled: true, op: parsed.op, boundary: parsed.boundary, promise };
      }
      return { handled: false, reason: "unknown-op" };
    }

    const kazContextBoundaryService = {
      version: 1,
      openPlanItem(target, options = {}) {
        const sessionId = sessionIdFromTarget(target);
        if (!sessionId) return { opened: false, reason: "no-session" };
        return openBoundaryForSession(sessionId, "planItem", options);
      },
      closePlanItem(target, options = {}) {
        const sessionId = sessionIdFromTarget(target);
        if (!sessionId) return Promise.resolve({ closed: false, reason: "no-session" });
        return closeBoundaryScope(sessionId, "planItem", {
          agent: options.agent ?? agentFromTarget(target),
          signal: options.signal,
        });
      },
      openGoal(target, options = {}) {
        const sessionId = sessionIdFromTarget(target);
        if (!sessionId) return { opened: false, reason: "no-session" };
        return openBoundaryForSession(sessionId, "goal", options);
      },
      closeGoal(target, options = {}) {
        const sessionId = sessionIdFromTarget(target);
        if (!sessionId) return Promise.resolve({ closed: false, reason: "no-session" });
        return closeBoundaryScope(sessionId, "goal", {
          agent: options.agent ?? agentFromTarget(target),
          signal: options.signal,
        });
      },
      open(target, options = {}) {
        const sessionId = sessionIdFromTarget(target);
        if (!sessionId) return { opened: false, reason: "no-session" };
        const boundary = options.boundary ?? options.kind;
        return openBoundaryForSession(sessionId, boundary, options);
      },
      close(target, options = {}) {
        const sessionId = sessionIdFromTarget(target);
        if (!sessionId) return Promise.resolve({ closed: false, reason: "no-session" });
        const boundary = options.boundary ?? options.kind;
        return closeBoundaryScope(sessionId, boundary, {
          agent: options.agent ?? agentFromTarget(target),
          signal: options.signal,
        });
      },
      status(target) {
        const sessionId = sessionIdFromTarget(target);
        if (!sessionId) return { ok: false, reason: "no-session" };
        return { ok: true, ...boundaryStatusForSession(sessionId) };
      },
      handleBoundaryEvent(session, event) {
        return handleBoundaryEvent(session, event);
      },
    };

    ctx.effect(() => {
      const disposeBoundaryService = ctx.provide("kazContextBoundary", kazContextBoundaryService);
      return () => {
        if (typeof disposeBoundaryService === "function") {
          try {
            disposeBoundaryService();
          } catch {
            // ignore cleanup errors
          }
        }
      };
    }, `${PLUGIN_ID}: 发布 kazContextBoundary 服务`);

    ctx.on("session/event", (session, event) => {

      const sessionId = sessionIdOf(session);
      if (!sessionId || !isPlainObject(event)) return;
      try {
        if (event.type === "compaction/start") {
          const state = ensureState(sessionId);
          state.compactionActive = true;
          return;
        }
        if (event.type === "compaction/end") {
          const state = ensureState(sessionId);
          state.compactionActive = false;
          return;
        }
        if (event.type === BOUNDARY_EVENT_OPEN || event.type === BOUNDARY_EVENT_CLOSE) {
          const handled = handleBoundaryEvent(session, event);
          logDebug(`boundary event ${event.type} handled=${handled.handled} for ${sessionId}`);
          return;
        }
        if (enableWorkflowBridge === true) {
          const agent = resolveAgent(sessionId);
          if (agent) syncWorkflowBoundaries(agent);
        }
        if (isAppendSurfaceEvent(event)) {
          captureEvent(sessionId, event);
          return;
        }
        if (isCompletedTurnEndEvent(event)) {
          // Authoritative fallback: if turn-stopping could not close (summary
          // failure/unavailable), retry once the completed boundary is durable.
          queueMicrotask(() => {
            const state = bySession.get(sessionId);
            if (!state || state.disposed || state.busy) return;
            const innermost = findInnermostOpenScope(state.currentSession);
            if (
              innermost &&
              Array.isArray(innermost.scope.children) &&
              innermost.scope.children.length > 0
            ) {
              void closeRound(sessionId, { agent: resolveAgent(sessionId) }).catch((error) => {
                logDebug(`turn/end fallback close failed: ${errorMessage(error)}`);
              });
            }
          });
        }
      } catch (error) {
        logWarn(`session/event handling failed for ${sessionId}: ${errorMessage(error)}`);
      }
    });

    // agent/pre-step happens BEFORE the durable user/message events of the step
    // are logged, so retrying a failed boundary close here never folds the new
    // step into the old open scope. No claimed/unlogged message is mirrored.
    ctx.on("agent/pre-step", async (payload, next) => {

      const agent = payload?.agent;
      if (agent !== null && agent !== undefined && typeof agent === "object") {
        try {
          syncWorkflowBoundaries(agent, { scheduleCloses: false });
          const sessionId = sessionIdOf(agent);
          const state = sessionId ? bySession.get(sessionId) : undefined;
          if (state && !state.busy && lastChildIsAssistantLeaf(state.currentSession)) {

            await closeRound(sessionId, { agent, signal: agent?.session?.signal });
          } else if (state && state.pendingClose && !state.busy) {
            await retryPendingClose(agent);
          }
        } catch (error) {
          logDebug(`pre-step pending close retry error: ${errorMessage(error)}`);
        }
      }
      return next();
    });

    ctx.on("agent/turn-stopping", async (payload) => {

      const agent = payload?.agent;
      const sessionId = sessionIdOf(agent);
      if (!sessionId) return;
      const state = bySession.get(sessionId);
      if (!state || state.disposed) return;
      syncWorkflowBoundaries(agent, { scheduleCloses: false });
      const innermost = findInnermostOpenScope(state.currentSession);
      if (
        innermost &&
        innermost.scope.level === 1 &&
        Array.isArray(innermost.scope.children) &&
        innermost.scope.children.length > 0
      ) {
        logDebug(`turn-stopping close candidate for ${sessionId} (turn=${payload?.turn ?? "?"})`);
        await closeRound(sessionId, { agent, signal: payload?.signal });
      }
      await closeTerminalWorkflowBoundaries(agent, sessionId, payload?.signal);
    });

    ctx.on("agent/status", ({ agent, status }) => {
      const sessionId = sessionIdOf(agent);
      if (!sessionId) return;
      const state = bySession.get(sessionId);
      if (!state) return;
      logDebug(`status ${status} for ${sessionId}`);
      // Store writes are synchronous per event; nothing further needs flushing.
    });

    ctx.on("agent/disposed", ({ agent }) => {
      const sessionId = sessionIdOf(agent);
      if (!sessionId) return;
      const state = bySession.get(sessionId);
      if (state) {
        state.disposed = true;
        state.pendingClose = false;
      }
      bySession.delete(sessionId);
      logDebug(`disposed/cleanup ${sessionId}`);
    });

    ctx.effect(() => () => {
      bySession.clear();
    }, `${PLUGIN_ID}: clear per-session runtime state on unload`);
  },
};
