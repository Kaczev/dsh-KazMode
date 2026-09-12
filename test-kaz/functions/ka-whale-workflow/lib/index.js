// ka-whale-workflow —— 阶段机、注入与四工具的挂载点（《Kaz8.0设计.md》§3.9 / §五）。
//
// 注入：system-prompt 段 `ka-whale-workflow:stage`，内容由本插件在 assemble 钩子里按
//       当前阶段重写（`[ka-whale-workflow <stage>]` + 正文；idle 可带"子代理现状"）。
// 阶段：每个对话一份内存态（idle ⇄ arrange_agent，memory 由收尾保障触发）。
// 回填：assemble 时扫描新的"子代理完成通知"，把 status / summary 写回安排文件。
// 子代理看不到工作流四工具（§3.9）：注册表收紧 + 本次请求工具表过滤双通道。

export const name = "ka-whale-workflow";

export const inject = ["tools", "systemPrompt", "subagents"];

import { isSubagentAgent } from "../../kaz-shared/lib/agent-role.js";
import { patchEntryAt, readArrangement, settlePatchFromNotice } from "./arrangement.js";
import { registerKazForkProvider } from "./fork-provider.js";
import { renderStageText, renderSubagentsBlock } from "./stages.js";
import { getArrangementTool, kaSubWhaleTool, whaleReportTool, writeArrangementTool } from "./tools.js";

const WORKFLOW_SECTION = "ka-whale-workflow:stage";

/** 段顺序：TOOL_GOAL(2400) 与 TOOL_WORKFLOW(2600) 之间。 */
const WORKFLOW_ORDER = 2500;

/** 只挂给主代理的四件（子代理必须看不到）。 */
const MAIN_ONLY_TOOLS = ["write-arrangement", "get-arrangement", "ka_sub_whale", "whale_report"];

/** 每个对话的内存态（安排本体在文件里）。 */
function createStore() {
  const sessions = new Map();
  const stateFor = (sessionId) => {
    let state = sessions.get(sessionId);
    if (state === undefined) {
      state = { stage: "idle", entries: [], loaded: false, scannedSeq: 0, lastBlock: "" };
      sessions.set(sessionId, state);
    }
    return state;
  };
  return {
    stateFor,
    getStage: (sessionId) => stateFor(sessionId).stage,
    setStage: (sessionId, stage) => {
      stateFor(sessionId).stage = stage;
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
  const store = createStore();
  const hidden = new WeakSet();

  // kaz-fork：预设自带的 fork provider，让"fork 源"可以是任意存活会话（不只派发者自己）。
  registerKazForkProvider(ctx, ctx.logger);

  /** 回填完成通知 / 收尾保障 / 组装本轮的注入文本。 */
  const refresh = async (session) => {
    const sessionId = session?.id;
    if (typeof sessionId !== "string" || sessionId.length === 0) return "";
    const state = store.stateFor(sessionId);
    const events = typeof session.snapshotEvents === "function" ? session.snapshotEvents() : [];
    const lastSeq = events.length > 0 ? events[events.length - 1].seq : 0;
    const turnEnded = events.length > 0 && events[events.length - 1].type === "turn/end";

    if (!state.loaded) {
      state.entries = await readArrangement(sessionId);
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

    if (
      turnEnded &&
      state.stage === "idle" &&
      state.entries.length > 0 &&
      !state.entries.some((entry) => entry.persona === "memoryMaintainer")
    ) {
      state.stage = "memory";
    }

    const block = state.stage === "idle" ? renderSubagentsBlock(state.entries) : "";
    let blockToShow = "";
    if (block.length > 0 && block !== state.lastBlock) {
      blockToShow = block;
      state.lastBlock = block;
    }
    return renderStageText(state.stage, blockToShow);
  };

  ctx.on("system-prompt/assemble", async (assembly, context, next) => {
    const agent = context?.agent;
    if (agent === undefined || agent === null) return next();
    if (isSubagentAgent(agent)) {
      if (!hidden.has(agent)) {
        hidden.add(agent);
        restrictOnce(agent, MAIN_ONLY_TOOLS, ctx.logger);
      }
      if (assembly !== null && typeof assembly === "object" && Array.isArray(assembly.tools)) {
        assembly.tools = assembly.tools.filter((tool) => !MAIN_ONLY_TOOLS.includes(tool?.name));
      }
      return next();
    }
    const text = await refresh(agent.session);
    if (assembly !== null && typeof assembly === "object" && Array.isArray(assembly.sections)) {
      assembly.sections = assembly.sections.map((section) =>
        section !== null && typeof section === "object" && section.name === WORKFLOW_SECTION ? { ...section, text } : section,
      );
    }
    return next();
  });

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: WORKFLOW_SECTION,
        order: WORKFLOW_ORDER,
        text: () => "",
      }),
    "ka-whale-workflow stage section",
  );

  ctx.tools.register(writeArrangementTool({ store }));
  ctx.tools.register(getArrangementTool({ store }));
  ctx.tools.register(kaSubWhaleTool({ ctx, store }));
  ctx.tools.register(whaleReportTool({ store }));
}
