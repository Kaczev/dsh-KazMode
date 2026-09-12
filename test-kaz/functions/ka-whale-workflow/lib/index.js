// ka-whale-workflow —— 阶段机、上下文注入与四工具的挂载点（《Kaz8.0设计.md》§3.9 / §五）。
//
// 注入：阶段文本（`[ka-whale-workflow <stage>]` + 正文）走**上下文注入**——在每个 step 的
//       `agent/pre-step` 钩子里，作为一条 plugin 消息（form: notice）追加进这一步的上下文；
//       不是系统提示段。注入时机：每轮第一步、阶段发生变化、idle 的 "Subagents:" 块变化。
// 阶段：每个对话一份内存态（idle ⇄ arrange_agent；memory 由收尾保障在下一轮开头触发）。
// 回填：每个 step 扫描新的"子代理完成通知"，把 status / summary 写回安排文件。
// 子代理看不到工作流四工具（§3.9）：注册表收紧 + 本次请求工具表过滤双通道。

export const name = "ka-whale-workflow";

export const inject = ["tools", "subagents"];

import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { isSubagentAgent } from "../../kaz-shared/lib/agent-role.js";
import { patchEntryAt, readArrangement, settlePatchFromNotice } from "./arrangement.js";
import { registerKazForkProvider } from "./fork-provider.js";
import { STAGES, renderStageText, renderSubagentsBlock } from "./stages.js";
import { readStage, writeStage } from "./stage-store.js";
import { getArrangementTool, kaSubWhaleTool, whaleReportTool, writeArrangementTool } from "./tools.js";

/** 只挂给主代理的四件（子代理必须看不到）。 */
const MAIN_ONLY_TOOLS = ["write-arrangement", "get-arrangement", "ka_sub_whale", "whale_report"];

/** 每个对话的内存态（安排本体在文件里；阶段落盘，跨重启保留）。 */
function createStore(persistStage = null) {
  const sessions = new Map();
  const stateFor = (sessionId) => {
    let state = sessions.get(sessionId);
    if (state === undefined) {
      state = {
        stage: "idle",
        entries: [],
        loaded: false,
        scannedSeq: 0,
        lastBlock: "",
        cwd: "",
      };
      sessions.set(sessionId, state);
    }
    return state;
  };
  return {
    stateFor,
    /** 记住该对话的项目目录（阶段文件的落点）。 */
    noteCwd: (sessionId, cwd) => {
      stateFor(sessionId).cwd = typeof cwd === "string" ? cwd : "";
    },
    getStage: (sessionId) => stateFor(sessionId).stage,
    setStage: (sessionId, stage) => {
      const state = stateFor(sessionId);
      state.stage = stage;
      if (persistStage !== null) persistStage(state.cwd, sessionId, stage);
    },
    setEntries: (sessionId, entries) => {
      const state = stateFor(sessionId);
      state.entries = entries;
      state.loaded = true;
    },
    loadEntries: async (sessionId) => {
      const state = stateFor(sessionId);
      if (!state.loaded) {
        state.entries = await readArrangement(sessionId);
        state.loaded = true;
      }
      return state.entries;
    },
  };
}

/** 在 agent 自己的 scope 上逐名收紧（未知名字跳过，不让一个坏名字搞挂会话）。 */
function restrictOnce(agent, names, logger) {
  const tools = agent?.ctx?.tools;
  if (tools === undefined || tools === null || typeof tools.restrict !== "function") return;
  for (const name of names) {
    try {
      tools.restrict({ deny: [name] });
    } catch {
      logger?.debug?.(`[ka-whale-workflow] tool "${name}" is not registered; skipped`);
    }
  }
}

export function apply(ctx) {
  const store = createStore((cwd, sessionId, stage) => {
    void writeStage(cwd, sessionId, stage).catch((error) => {
      ctx.logger?.warn?.(`[ka-whale-workflow] stage persist failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
  const hidden = new WeakSet();

  // kaz-fork：预设自带的 fork provider，让"fork 源"可以是任意存活会话（不只派发者自己）。
  registerKazForkProvider(ctx, ctx.logger);

  /** 回填新的完成通知，返回本对话的状态（session 不可用时返回 null）。 */
  const refresh = async (session) => {
    const sessionId = session?.id;
    if (typeof sessionId !== "string" || sessionId.length === 0) return null;
    const state = store.stateFor(sessionId);
    const events = typeof session.snapshotEvents === "function" ? session.snapshotEvents() : [];
    const lastSeq = events.length > 0 ? events[events.length - 1].seq : 0;

    store.noteCwd(sessionId, typeof session?.header?.cwd === "string" ? session.header.cwd : "");
    if (!state.loaded) {
      state.entries = await readArrangement(sessionId);
      // 重启后从项目里的阶段文件恢复（只认已知阶段名）。
      const persisted = await readStage(state.cwd, sessionId);
      if (persisted !== undefined && STAGES.includes(persisted)) state.stage = persisted;
      state.loaded = true;
    }

    if (lastSeq > state.scannedSeq) {
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i];
        if (event.seq <= state.scannedSeq) break;
        const patch = settlePatchFromNotice(event);
        if (patch === null || patch.childId.length === 0) continue;
        const index = state.entries.findIndex((entry) => entry.id === patch.childId);
        if (index < 0) continue;
        state.entries = await patchEntryAt(sessionId, index, { status: patch.status, summary: patch.summary });
      }
      state.scannedSeq = lastSeq;
    }
    return state;
  };

  // 主代理：只在"用户发消息的那一轮开头"注入阶段文本（上下文注入，不是系统提示）。
  // 工具循环里的中间步骤、whale_report 切阶段、子代理报告都不注入——避免刷屏。
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (decision === null || typeof decision !== "object" || decision.kind !== "enter") return decision;
    const agent = payload?.agent;
    if (agent === undefined || agent === null || typeof agent !== "object") return decision;
    if (isSubagentAgent(agent)) return decision;
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    const userTurn = payload?.step === 1 && messages.some((message) => message?.source?.kind === "user");
    if (!userTurn) return decision;
    const state = await refresh(agent.session);
    if (state === null) return decision;

    const block = state.stage === "idle" ? renderSubagentsBlock(state.entries) : "";
    const blockChanged = block.length > 0 && block !== state.lastBlock;
    if (blockChanged) state.lastBlock = block;

    const text = renderStageText(state.stage, blockChanged ? block : "");
    if (text.length === 0) return decision;
    decision.messages.push(
      createUserMessage({
        content: [{ type: "text", text }],
        source: {
          kind: "plugin",
          plugin: "ka-whale-workflow",
          form: "notice",
          summary: `stage:${state.stage}`,
        },
      }),
    );
    return decision;
  });

  // 子代理：没有阶段注入；工作流四工具在注册表与本次请求两个层面都挡住。
  ctx.on("system-prompt/assemble", (assembly, context, next) => {
    const agent = context?.agent;
    if (agent === undefined || agent === null || !isSubagentAgent(agent)) return next();
    if (!hidden.has(agent)) {
      hidden.add(agent);
      restrictOnce(agent, MAIN_ONLY_TOOLS, ctx.logger);
    }
    if (assembly !== null && typeof assembly === "object" && Array.isArray(assembly.tools)) {
      assembly.tools = assembly.tools.filter((tool) => !MAIN_ONLY_TOOLS.includes(tool?.name));
    }
    return next();
  });

  // 收尾保障：主代理结束一轮（turn/end）时，安排里没有 memoryMaintainer 就进入 memory 阶段，
  // 并追加一条消息把它唤醒去做安排——不必等用户的下一条消息。
  ctx.on("session/event", async (session, event) => {
    if (event === null || typeof event !== "object" || event.type !== "turn/end") return;
    const sessionId = session?.id;
    if (typeof sessionId !== "string" || sessionId.length === 0) return;
    const agents = ctx.get("agents");
    const agent =
      agents !== undefined && agents !== null && typeof agents.get === "function" ? agents.get(sessionId) : undefined;
    if (agent === undefined || agent === null || isSubagentAgent(agent)) return;
    const state = await refresh(session);
    if (state === null || state.stage !== "idle") return;
    if (state.entries.length === 0) return;
    if (state.entries.some((entry) => entry.persona === "memoryMaintainer")) return;
    store.setStage(sessionId, "memory");
    const inbox = agent.inbox;
    if (inbox === undefined || inbox === null || typeof inbox.append !== "function") return;
    inbox.append(
      "next-turn",
      createUserMessage({
        content: [{ type: "text", text: renderStageText("memory") }],
        source: { kind: "plugin", plugin: "ka-whale-workflow", form: "notice", summary: "stage:memory" },
      }),
    );
  });

  ctx.tools.register(writeArrangementTool({ store }));
  ctx.tools.register(getArrangementTool({ store }));
  ctx.tools.register(kaSubWhaleTool({ ctx, store }));
  ctx.tools.register(whaleReportTool({ store }));
}
