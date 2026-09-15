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
        // 是否已经把落盘计数并进来（跨重启恢复只做一次，见 store.loadRoundBaseline）。
        roundsRestored: false,
        // 模型本轮是否自己选过阶段（whale_report）。选过则本轮不再自动进入 self-check，
        // 否则跳出去的 idle 会被下一轮计算按回去 —— 实测整轮出不来。
        //
        // 由 whale_report 置位，由 pre-step 在**每个新回合的第一步**（`payload.step === 1`，
        // 就在本回合那次阶段计算之后）清零（见那里的注释）：模型是轮中途才选的，
        // 所以从选定到下一次阶段计算之间都必须看得见它，
        // 才挡得住"按轮次重算又把阶段按回去"。
        modelChoseStage: false,
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
    /**
     * 记下"模型本轮自己选过阶段"。
     * 由 whale_report 调用；由 `agent/pre-step` 在**每个新回合的第一步**（`payload.step === 1`，
     * 就在本回合那次阶段计算之后）清零——**不在 claim 监听器里清**（见那里的注释）。
     * 用途：本轮内不再自动进入 self-check，否则模型跳出的 idle 会被按回去。
     */
    markModelStageChoice: (sessionId) => {
      stateFor(sessionId).modelChoseStage = true;
    },
    loadEntries: async (sessionId) => {
      const state = stateFor(sessionId);
      if (!state.loaded) {
        state.entries = await readArrangement(state.cwd, sessionId);
        state.loaded = true;
      }
      return state.entries;
    },
    /**
     * 把**落盘的轮次总数**并进内存计数，**每个会话只做一次**。
     *
     * 必须发生在"本会话的第一次 +1 之前"（见 claim 监听器），而不是在 +1 之后补：
     * 本轮一旦落过盘，盘上的值就是**本轮自己写的**，此时再加一次等于把这一条消息数两遍
     * ——实测就是这样，文件里记成 1、3、4…，self-check 落在第 3 条真人消息上而不是第 4 条。
     *
     * 计数是**单调累加的绝对总数**，所以恢复的语义是"以盘上那份为起点接着数"，
     * 不是"内存 +1 之后再并一次盘上值"。`state.rounds` 非 0 说明本会话已经在数，那就不动它。
     * @param {string} sessionId - 会话 id。
     * @returns {Promise<number>} 本次加载后的计数。
     */
    loadRoundBaseline: async (sessionId) => {
      const state = stateFor(sessionId);
      if (state.roundsRestored) return state.rounds;
      // 先立标记：本次读盘期间若有第二次调用，不能重复并入。
      state.roundsRestored = true;
      if (!(Number.isFinite(state.rounds) && state.rounds > 0)) {
        const marks = await readRoundMarks(state.cwd);
        const persisted = marks[sessionId]?.count;
        if (typeof persisted === "number" && Number.isFinite(persisted) && persisted > 0) state.rounds = persisted;
      }
      return state.rounds;
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
    // **模型本轮自己选过阶段，就尊重它**——本轮不再自动进入。
    // 只在 self-check 里鲸报了 idle 后必须豁免，否则下一轮计算又把它按回 self-check
    // （实测踩过：整轮只剩 whale_report，出不去）。豁免的是"模型的选择"，不是某个具体阶段名——
    // 原先只写 `!== "arrange_agent"`，于是跳 idle 不在豁免里。
    if (state.modelChoseStage === true) return state.stage;
    if (shouldEnterSelfCheck(rounds)) {
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
    // 先并入盘上的总数，**再** +1：顺序反了就是把这一条消息数两遍（见 loadRoundBaseline）。
    // 落盘本身失败不拦这一轮：本轮照旧决定并广播阶段，只是这一笔计数没写下去。
    try {
      await store.loadRoundBaseline(sessionId);
      state.rounds = (Number.isFinite(state.rounds) ? state.rounds : 0) + 1;
      state.selfCheckEntered = false;
      // 落盘：跨重启存活，存"数到第几条"。
      await writeRoundMark(state.cwd, sessionId, state.rounds);
    } catch (error) {
      ctx.logger?.warn?.(
        `[ka-whale-workflow] round mark persist failed (count ${state.rounds}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // 决定这一轮的阶段，并**立刻**写进去：注入点、工具面、磁盘从此同一个值。
    const stage = entranceFor(sessionId, state.rounds);
    store.setStage(sessionId, stage);
    // 阶段写盘失败只丢这一笔持久化，不该连"已经决定的阶段"和广播一起丢掉：
    // 少了广播，kaz-shared 的工具面门禁会拿着上一轮的值，本轮的阶段对工具面就不生效。
    try {
      await writeStage(state.cwd, sessionId, stage);
    } catch (error) {
      ctx.logger?.warn?.(
        `[ka-whale-workflow] stage persist failed (stage ${stage}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
      // 轮次计数**不在这里恢复**：它由 claim 监听器在"本会话第一次 +1 之前"并入一次
      // （见 store.loadRoundBaseline）。放在这里恢复是把加载推迟到 +1 之后——那时盘上
      // 已经是本轮自己写的值，再加一次就把同一条消息数了两遍（实测：self-check 落在第 3 条）。
      state.loaded = true;
      // **阶段不从磁盘恢复**（除 arrange_agent 外）。"这一轮该进哪个阶段"由 entranceFor 按轮次算，
      // 而磁盘天然比内存旧一拍——恢复它就会把刚算好的 self-check 拉回 idle。
      // 只有 arrange_agent 是模型轮内跳的、必须跨重启留住，所以只认它。
      state.stage = (await readStage(state.cwd, sessionId)) === "arrange_agent" ? "arrange_agent" : entranceFor(sessionId, state.rounds);
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
    // 本回合的会话 id **必须在这里取**：下面"重算阶段 + 落盘 + 记账"那几处用的是这个处理函数
    // 自己的作用域，而 `sessionId` 只声明在 claim 监听器和 refresh 内部，两者都不在这里可见
    // （曾经在那几处直接引用它 → 每一步都 `sessionId is not defined`，整轮失败）。
    // refresh 返回非 null 已经保证它是非空字符串（refresh 开头就是这么判的），所以这里无需再判。
    const sessionId = agent.session?.id;
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
    // 阶段**只在回合开头算一次**（`userTurn` 就是"真人消息的第一步"）。
    //
    // 为什么不能每一步都算：模型在 self-check 里用 whale_report 跳到 idle 之后，
    // 若这里再算一次，同一个 4n 轮次又会算出 self-check —— 把刚跳出去的阶段按回去，
    // 于是**整轮都出不来**（实测踩过）。回合开头算一次，模型轮内的跳转才作数。
    if (userTurn) {
      const stage = entranceFor(sessionId, state.rounds);
      // **每次真人回合都广播**，即使阶段没变。
      // 这一句是补的线：whale_report 跳出 self-check 后，guard 读的是这份广播值；
      // 原先只在"阶段变化"时广播，于是跳出后 guard 仍读到 self-check、本轮剩下的步骤全被锁
      // （实测踩过：连着三版都是这个位置被拒）。
      if (state.stage !== stage) {
        state.stage = stage;
        store.setStage(sessionId, stage);
        // 与 claim 监听器里那笔阶段写**同等对待**：写盘失败只丢这一笔持久化。
        // 这笔写是被 pre-step 直接 await 的，抛出去就**整个 step 失败**；而阶段本身已经定
        // 下来、也记在内存里，广播照样发得出去——没理由让磁盘上的一次 IO 把这一步拦掉。
        try {
          await writeStage(state.cwd, sessionId, stage);
        } catch (error) {
          ctx.logger?.warn?.(
            `[ka-whale-workflow] stage persist failed (stage ${stage}): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      noteEffectiveStage(sessionId, state.stage);
    }
    // **"模型本轮自己选过阶段"的清零**：判据是"这是新回合的第一步"（`payload.step === 1`），
    // **不是** `userTurn`；位置在上面那次阶段计算**之后**，所以那次计算还看得见模型的选择。
    //
    // 为什么不能只挂在 userTurn 里：userTurn 要求 `payload.step === 1` **且**这一步的消息里
    // 有 `source.kind === "user"`。起手不是真人消息的回合（插件提示、子代理完成通知等）同样
    // 走到 step 1，却进不了 userTurn——那种回合不清零，flag 就一直为真，entranceFor 每次都
    // 原样返回 state.stage，**轮次规则被永久压住**（再也回不到按 4n 轮进 self-check）。
    //
    // 为什么不能挪去 claim 监听器：模型是在**本轮中途**（whale_report，pre-step 之后）才选的，
    // 而下一轮的 claim 与 pre-step 都会再算一次阶段——claim 里提前清零就等于那次重算看不见
    // 模型的选择，它会按轮次把阶段按回 idle/self-check，模型刚跳出去的一轮立刻被按回去
    // （实测：第 4 轮里 whale_report 跳 arrange_agent，第 5 轮的注入又变回 idle）。
    // 放在这里，豁免正好覆盖"从模型选定到下一次阶段计算"这一段；而每个回合的第一步必然经过
    // 这个处理函数（子代理在前面就返回；decision 不是 enter 时这一步压根不跑），
    // 所以"每个新回合都会清零"是有保证的。
    if (payload?.step === 1) state.modelChoseStage = false;
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
  ctx.tools.register(whaleReportTool({ store, noteStage: noteEffectiveStage }));
}
