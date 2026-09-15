// ka-whale-workflow —— 阶段机、上下文注入与四工具的挂载点（《Kaz8.0设计.md》§3.9 / §五）。
//
// 注入：阶段文本（`[ka-whale-workflow <stage>]` + 正文）走**上下文注入**——在每个 step 的
//       `agent/pre-step` 钩子里，作为一条 plugin 消息（form: notice）追加进这一步的上下文；
//       不是系统提示段。注入时机：每轮第一步、阶段发生变化、idle 的 "Subagents:" 块变化。
// 阶段：每个对话一份内存态（idle ⇄ arrange_agent；memory 由收尾保障在下一轮开头触发）。
// 回填：每个 step 扫描新的"子代理完成通知"，把 status / summary 写回安排文件。
// 子代理看不到工作流四工具（§3.9）：注册表收紧 + 本次请求工具表过滤双通道。

export const name = "ka-whale-workflow";

export const inject = ["tools", "subagents", "agents"];

import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { isSubagentAgent } from "../../kaz-shared/lib/agent-role.js";
import { noteEffectiveStage } from "../../kaz-shared/lib/index.js";
import { patchEntryAt, readArrangement, settlePatchFromNotice } from "./arrangement.js";
import { registerKazForkProvider } from "./fork-provider.js";
import {
  renderDivingHintText,
  renderDivingHintTextForSubagent,
  renderMemoryHintText,
  renderStageText,
  shouldEnterSelfCheck,
} from "./stages.js";
import { readRoundMarks, readStage, writeRoundMark, writeStage } from "./stage-store.js";
import { getArrangementTool, kaSubWhaleTool, whaleReportTool, writeArrangementTool } from "./tools.js";
import { noteMemoryHintEvent, shouldHintMemory } from "../../kaz-shared/lib/memory-hint.js";
import { divingHintStep, noteDivingEvent, shouldHintDiving } from "../../kaz-shared/lib/diving-hint.js";

/** 只挂给主代理的四件（子代理必须看不到）。导出是为了让"谁拿到工作流工具"这件事可被引用与核对。 */
export const MAIN_ONLY_TOOLS = ["write_arrangement", "get_arrangement", "ka_sub_whale", "whale_report"];

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
        // 是否已经看过这个会话的事件流（首次只看游标、不回放历史，见 refresh）。
        scannedOnce: false,
        // self-check 的轮次计数：**跨重启存活**（见 stage-store 的 __rounds）。
        // 由 `agent/inbox/claimed` 监听器 +1 —— 那个时刻在 assemble 之前，所以当轮就能生效。
        rounds: 0,
        selfCheckEntered: false,
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

  /**
   * self-check 的**轮次计数**与**自动进入**。
   *
   * 为什么必须挂在这里，而不是 pre-step、也不是数事件流：
   * 循环里每步的顺序是 `inbox.claim()` → `systemPrompt.assemble()` → `agent/pre-step` 瀑布
   * （dsh-agent-loop：889-894）。也就是说 ——
   *   * 在 pre-step 里改阶段，只影响**下一步**的工具表（本步的工具表已经算完了）；
   *   * 而 `user/message` 事件要等这一步跑完才 append（同文件：1028），
   *     所以从事件流里数，永远少数当轮这一条 —— 表现为"第 4 轮不触发、第 5 轮才触发"。
   * `agent/inbox/claimed` 在 claim() 里同步发出（同文件：107），**在 assemble 之前**，
   * 且负载带 agent（fused dispatcher），所以这里是"当轮消息已知、工具表还没生成"的唯一时刻。
   */
  /**
   * 第 n 个真人回合该进哪个阶段。**唯一**决定入口的地方。
   *
   * 为什么要有一个函数：判断原先散在两处（claim 监听器 + refresh 里的持久化恢复），
   * 两边对"该不该进 self-check"各有一套理解，又被 refresh 用磁盘旧值盖回去 ——
   * 表现为"第 4 轮注入显示 idle、self-check 迟一步才出现"（实测踩了好几轮）。
   * 现在：注入点、工具面、落盘都从这一个判断取值。
   *
   * 规则：4n 轮进 self-check；其余回合是 idle。
   * arrange_agent 是模型在**轮内**自己跳的（whale_report），不在这里决定，也不被这里覆盖。
   */
  const entranceFor = (sessionId, rounds) => {
    const state = store.stateFor(sessionId);
    if (shouldEnterSelfCheck(rounds) && state.stage !== "arrange_agent") {
      if (!state.selfCheckEntered) {
        state.selfCheckEntered = true;
        ctx.logger?.debug?.(`[ka-whale-workflow] self-check entered at round ${rounds}`);
      }
      return "self-check";
    }
    return "idle";
  };

  ctx.on("agent/inbox/claimed", async (payload) => {
    const agent = payload?.agent;
    const message = payload?.message;
    if (agent === undefined || agent === null || isSubagentAgent(agent)) return;
    // 只数**真人**消息：插件自己注入的阶段文本/提示走 inbox，但它们的 source.kind 是 "plugin"。
    if (message?.source?.kind !== "user") return;
    const session = agent.session;
    const sessionId = session?.id;
    if (typeof sessionId !== "string" || sessionId.length === 0) return;
    const state = store.stateFor(sessionId);
    store.noteCwd(sessionId, typeof session?.header?.cwd === "string" ? session.header.cwd : "");
    state.rounds = (Number.isFinite(state.rounds) ? state.rounds : 0) + 1;
    state.selfCheckEntered = false;
    // 落盘：跨重启存活，存"数到第几条"。
    await writeRoundMark(state.cwd, sessionId, state.rounds);
    // 决定这一轮的阶段，并**立刻**写进去：注入点、工具面、磁盘从此同一个值。
    const stage = entranceFor(sessionId, state.rounds);
    store.setStage(sessionId, stage);
    await writeStage(state.cwd, sessionId, stage);
    noteEffectiveStage(sessionId, stage);
  });

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
      // 轮次计数恢复：**只增不减**。count 在 claim 监听器里已经 +1，磁盘那份还是旧的；
      // 无条件覆盖会把同一轮刚数好的值盖回去（实测踩过）。
      const marks = await readRoundMarks(state.cwd);
      const persistedRounds = marks[sessionId]?.count;
      if (typeof persistedRounds === "number" && persistedRounds > state.rounds) state.rounds = persistedRounds;
      // **阶段不从磁盘恢复**（除 arrange_agent 外）。"这一轮该进哪个阶段"由 entranceFor 按轮次算，
      // 而磁盘天然比内存旧一拍——恢复它就会把刚算好的 self-check 拉回 idle。
      // 只有 arrange_agent 是模型轮内跳的、必须跨重启留住，所以只认它。
      state.stage = (await readStage(state.cwd, sessionId)) === "arrange_agent" ? "arrange_agent" : entranceFor(sessionId, state.rounds);
      state.loaded = true;
    }

    if (lastSeq > state.scannedSeq) {
      if (!state.scannedOnce) {
        // **首次看到这个会话**：只把游标推到当前末尾，**不数历史**。
        // 计数器只关心"从现在起"的活动；新进程（重启后）scannedSeq 从 0 开始，
        // 若在这里回放整段历史，32 次门槛会被历史一次性跨过 —— 表现为"一开局就注入刹车提示"。
        // 实测踩过：重启后第一次 pre-step 立刻弹提示。
        state.scannedOnce = true;
        state.scannedSeq = lastSeq;
        return state;
      }
      // 提示计数与子代理结算：**必须正序**（旧→新）——计数器依赖事件先后。
      // 轮次计数不在这里：它由 agent/inbox/claimed 监听器做（那个时刻在 assemble 之前，
      // 见下面的监听器注释）。事件流里数会晚一轮，因为当前这条消息要等这一步跑完才 append。
      for (const event of events) {
        if (!(event.seq > state.scannedSeq)) continue;
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
      hintState = { roundToolCalls: 0, divingMilestone: 0, scannedSeq: 0, scannedOnce: false };
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
        if (!hintState.scannedOnce) {
          // 同主代理：子代理首次被看到时只看游标，不回放它已发生的工具调用。
          hintState.scannedOnce = true;
          hintState.scannedSeq = lastSeq;
          return decision;
        }
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
    // 阶段在**注入点**重新算一次，而不是读一个可能被别处覆盖的 state.stage。
    // 这是唯一稳定的一步：claim 刚数完当轮消息（assemble 之前），而这里正是"这一刻注入什么"。
    const stage = entranceFor(sessionId, state.rounds);
    if (state.stage !== stage) {
      state.stage = stage;
      store.setStage(sessionId, stage);
      await writeStage(state.cwd, sessionId, stage);
      noteEffectiveStage(sessionId, stage);
    }
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
