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
import {
  STAGES,
  renderDivingHintText,
  renderDivingHintTextForSubagent,
  renderMemoryHintText,
  renderStageText,
} from "./stages.js";
import { readStage, writeStage } from "./stage-store.js";
import { getArrangementTool, kaSubWhaleTool, whaleReportTool, writeArrangementTool } from "./tools.js";
import { noteMemoryHintEvent, shouldHintMemory } from "../../kaz-shared/lib/memory-hint.js";
import { divingHintStep, noteDivingEvent, shouldHintDiving } from "../../kaz-shared/lib/diving-hint.js";

/** 只挂给主代理的四件（子代理必须看不到）。 */
const MAIN_ONLY_TOOLS = ["write_arrangement", "get_arrangement", "ka_sub_whale", "whale_report"];

/** 子代理的刹车状态：按 session 分开（子代理的会话不进工作流的会话表）。 */
const subagentHintStates = new WeakMap();

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
        lastInjectedStage: "",
        cwd: "",
        // 记忆提示：连续调用观察工具集的次数，以及本轮（自最近一条用户消息）是否已提示过。
        streak: 0,
        roundHinted: false,
        // 刹车提示：本轮（自最近一条用户消息）的全部工具调用次数，以及已触发到哪个节点。
        roundToolCalls: 0,
        divingMilestone: 0,
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
        state.entries = await readArrangement(state.cwd, sessionId);
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
      state.entries = await readArrangement(state.cwd, sessionId);
      // 重启后从项目里的阶段文件恢复（只认已知阶段名）。
      const persisted = await readStage(state.cwd, sessionId);
      if (persisted !== undefined && STAGES.includes(persisted)) state.stage = persisted;
      state.loaded = true;
    }

    if (lastSeq > state.scannedSeq) {
      // **必须正序**（旧→新）处理：计数器（记忆提示的连续数、刹车提示的本轮总数）依赖事件先后。
      // 倒序会让"用户消息清零"最后执行，把刚数好的计数抹掉——实测踩过这个坑。
      // 结算子代理补丁与顺序无关，正序同样正确。
      for (const event of events) {
        if (!(event.seq > state.scannedSeq)) continue;
        // 提示计数：同一次扫描、同一个"已扫到哪"的守卫，所以每个事件只算一次，天然幂等。
        noteMemoryHintEvent(state, event);
        noteDivingEvent(state, event);
        const patch = settlePatchFromNotice(event);
        if (patch === null || patch.childId.length === 0) continue;
        const index = state.entries.findIndex((entry) => entry.id === patch.childId);
        if (index < 0) continue;
        state.entries = await patchEntryAt(state.cwd, sessionId, index, { status: patch.status, summary: patch.summary });
      }
      state.scannedSeq = lastSeq;
    }
    return state;
  };

  /** 取（必要时建）某个子代理会话的刹车状态。会话不可读时返回 null。 */
  const subagentHintStateFor = (session) => {
    if (session === undefined || session === null || typeof session !== "object") return null;
    let hintState = subagentHintStates.get(session);
    if (hintState === undefined) {
      hintState = { roundToolCalls: 0, divingMilestone: 0, scannedSeq: 0 };
      subagentHintStates.set(session, hintState);
    }
    return hintState;
  };

  // 主代理：用户发消息的那一轮开头、以及阶段切换后（whale_report）各注入一条；
  // 工具循环的其它步骤、子代理报告都不注入——避免刷屏。（子代理现状用 get_arrangement 看。）
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (decision === null || typeof decision !== "object" || decision.kind !== "enter") return decision;
    const agent = payload?.agent;
    if (agent === undefined || agent === null || typeof agent !== "object") return decision;

    // ── 子代理：只注入刹车提示（阶段文本与记忆提示都不给子代理）。 ──────────────
    // 子代理也会在一个回合里埋头调用工具几十次，所以同一个门槛对它成立；只是"停下汇报"的
    // 对象是派发它的主代理，不是用户，所以正文用子代理版（the main agent and hand back）。
    if (isSubagentAgent(agent)) {
      const hintState = subagentHintStateFor(agent.session);
      if (hintState === null) return decision;
      const events = typeof agent.session?.snapshotEvents === "function" ? agent.session.snapshotEvents() : [];
      const lastSeq = events.length > 0 ? events[events.length - 1].seq : 0;
      let shouldHint = false;
      if (lastSeq > hintState.scannedSeq) {
        // 同样**正序**：子代理的计数也依赖事件先后（用户消息要先把本轮清零）。
        for (const event of events) {
          if (!(event.seq > hintState.scannedSeq)) continue;
          if (divingHintStep(hintState, event)) shouldHint = true;
        }
        hintState.scannedSeq = lastSeq;
      }
      if (shouldHint) {
        decision.messages.push(
          createUserMessage({
            content: [{ type: "text", text: renderDivingHintTextForSubagent() }],
            source: {
              kind: "plugin",
              plugin: "ka-whale-workflow",
              form: "notice",
              summary: "diving-hint",
            },
          }),
        );
      }
      return decision;
    }

    const state = await refresh(agent.session);
    if (state === null) return decision;
    // 刹车提示：本轮工具调用总数跨过 32，之后每再满 16 各提示一次（见 kaz-shared/lib/diving-hint.js）。
    if (shouldHintDiving(state)) {
      decision.messages.push(
        createUserMessage({
          content: [{ type: "text", text: renderDivingHintText() }],
          source: {
            kind: "plugin",
            plugin: "ka-whale-workflow",
            form: "notice",
            summary: "diving-hint",
          },
        }),
      );
    }

    // 记忆提示：连续调用观察工具集达阈值、且这一轮还没提示过、且仍在 idle 阶段。
    // 每轮最多一次；进过 arrange_agent 就清零（见 kaz-shared/lib/memory-hint.js）。
    if (shouldHintMemory(state)) {
      decision.messages.push(
        createUserMessage({
          content: [{ type: "text", text: renderMemoryHintText() }],
          source: {
            kind: "plugin",
            plugin: "ka-whale-workflow",
            form: "notice",
            summary: "memory_hint",
          },
        }),
      );
    }

    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    const userTurn = payload?.step === 1 && messages.some((message) => message?.source?.kind === "user");
    const stageChanged = state.stage !== state.lastInjectedStage;
    if (!userTurn && !stageChanged) return decision;
    state.lastInjectedStage = state.stage;

    const text = renderStageText(state.stage);
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

  ctx.tools.register(writeArrangementTool({ store }));
  ctx.tools.register(getArrangementTool({ store }));
  ctx.tools.register(kaSubWhaleTool({ ctx, store }));
  ctx.tools.register(whaleReportTool({ store }));
}
