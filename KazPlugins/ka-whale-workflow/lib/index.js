// ka-whale-workflow —— 鲸鱼工作流（任务重构 → 任务分类 → done）
// ===========================================================================
// 流程：
//   1) 首轮真实用户消息（turn=1）进入「任务重构」：
//        - 系统提示词段 ka-whale-workflow:prompt 显示重构 prompt；
//        - 上下文注入 [ka-whale-workflow TaskReconstruction]；
//        - 工具面收敛为「ka-whale-workflow 配置面板重构清单 ∩ Kaz 白名单」
//          + 自动启用面板临时放行的 whale_report。
//   2) whale_report 后进入「任务分类」：
//        - 系统提示词段切为分类 prompt；
//        - 上下文注入 [ka-whale-workflow TaskClassification]；
//        - 工具面收敛为 whale_report。
//   3) whale_report({mode}) 自动启动 plan/goal 后进入 done：不再过滤，放行 Kaz 白名单。
//      plan 模式由 whale_report 内部经 create_plan 工具（planning isolate 组内）切换，
//      因为 whale_report 自身在 host 层解析不到 planMode 服务。
//   4) 插话（模型运行中，同一轮中途追加消息）不改变当前工作流阶段。
//      第 2、3、4……轮（turn>=2、模型不在运行）直接重新进入「任务重构」。
//   5) 用户通过 /plan 或 /goal 指令开启模式的那一条消息：跳过鲸鱼工作流，
//      不进入任务重构；round-minimal 极简过滤仍照常生效。
//
// 与 round-minimal：
//   round-minimal 优先。极简阶段（首次工具调用前）不进入重构；第一次 tool/call
//   解除极简后立刻进入重构。命令旁路不影响 round-minimal。
//
// 阶段状态：
//   写入插件自己的 JSON 存储（~/.dsh/storages/ka-whale-workflow-stage.json，
//   按 session id 索引），重启/续接会话自然恢复。
//   不再写入会话事件 ka-whale-workflow/stage——DSH 会把未知自定义事件视为
//   "not marked ignorable"，导致重载会话日志时拒绝读取整条日志。
// ===========================================================================

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { DEFAULT_RECONSTRUCTION_TOOLS } from "kaz-shared";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export { DEFAULT_RECONSTRUCTION_TOOLS };

/** 设置命名空间：~/.dsh/settings.yaml 中的 ka-whale-workflow: 段。 */
const NAMESPACE = settingsNamespace("ka-whale-workflow");

/** whale_report：由 kaz_tool_auto_on「鲸鱼工作流」临时放行（重构 + 分类）。 */
export const WHALE_REPORT_TOOL = "whale_report";

/** create_plan：planning isolate 组内的 realm 桥。whale_report 通过它进入/退出 plan 模式。 */
const CREATE_PLAN_TOOL = "create_plan";

/** 用户手动指令开启模式的命令名（/plan、/goal）。 */
const MANUAL_COMMAND_NAMES = ["plan", "goal"];

/** 任务重构 prompt（草案原文；<工具列表> 渲染为当前阶段实际可见工具）。 */
const RECONSTRUCTION_PROMPT =`We are now in the task reconstruction stage. Rewrite the user's request into a structured task description that preserves all key points, intent, and system-level constraints. Do NOT analyze, diagnose, or propose solutions here — that comes later.

When reconstructing, explicitly record the following metadata:
- Clarity: fully specified / partially specified / open-ended
- Open design decisions: choices the user left unspecified but that the task requires
- Deliverable shape: text / code / page / plan / analysis / other
- Exploration or design needed: would doing this well require exploring the codebase, comparing options, or designing an approach before acting?
- Expected shape: single-turn answer / multi-round iterative work / plan-then-approval

Preserve the original ambiguity. Do NOT silently turn a vague request into a concrete specification. Quote or summarize what the user left open. If the user asks for a design, a proposal, a reason ("why"), or how something should be improved, record the task as design-type.

You may only use <工具列表> tools. When done, call whale_report to proceed to classification.`;

/** 任务分类 prompt（草案原文；模式由 whale_report 统一启动）。 */
const CLASSIFICATION_PROMPT = `We are now in the task classification stage. Based on the reconstructed task description — including its clarity and open-design metadata — decide which execution mode best fits.

Use this decision order:
1. Normal — only if the task is fully specified, requires no exploration or design decisions, and can be completed in one turn.
2. Plan — if the task involves significant unknowns, open design choices, requires exploring the codebase, or asks for a design, a proposal, a migration plan, an analysis, or an explanation of why/how something should change.
3. Goal — if the objective is clear but the work naturally spans multiple turns (iterative build-and-refine, progress tracking, recovery after interruptions).

Tie-breakers:
- If unsure between Normal and Plan, prefer Plan when the user asked for design, a proposal, or "why / how to improve".
- Generating a code snippet is Normal only when the request is concrete and single-turn. Building/designing a page or feature with unspecified details is Plan (or Goal when the user gave a clear objective to iterate on).
- Do not rely only on the cleaned reconstruction: preserve signals from the original request's ambiguity.

Call whale_report with the chosen mode; it will launch plan/goal mode if needed and quit task classification stage.`;

/** 设置 schema（同时驱动设置页 UI）。 */
const SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(true),
  /** 子代理是否也走鲸鱼工作流；默认关（与 round-minimal 的语义一致）。 */
  includeSubagents: z.boolean().default(false),
  /** 任务重构工具清单（配置面板代码框；白名单之上的过滤器）。 */
  reconstructionTools: z.array(z.string()).default([...DEFAULT_RECONSTRUCTION_TOOLS]),
});

/** 本插件 settings.yaml 段的默认配置（镜像作者 settings.yaml；仅含非运行时字段）。 */
export const DEFAULT_SECTION = {
  enabled: true,
  includeSubagents: false,
  reconstructionTools: [...DEFAULT_RECONSTRUCTION_TOOLS],
};

// ---------------------------------------------------------------------------
// settings 自愈（纯方案 A：kazMode.pluginConfig 优先，settings.yaml 仅作兜底）
// ---------------------------------------------------------------------------

/** 卸载判定：插件 fiber 正在拆除时不再回写 source（与 dsh-settings 内部一致）。 */
function isUnloading(ctx) {
  const state = ctx.fiber.state;
  return state === 5 || state === 4; // FiberState.Unloading / Disposed
}

function installSettingsWithDefaults(ctx, ns, schema, entry, defaults, hooks) {
  ctx.inject(["settings"], (sctx) => {
    const scope = sctx.settings.register(ns, schema, { base: entry });
    hooks.setSource(() => scope.get());
    sctx.effect(() => () => {
      if (isUnloading(ctx)) return;
      hooks.setSource(() => entry);
      hooks.onChange();
    });
    hooks.onChange();
    scope.watch(() => {
      if (isUnloading(ctx)) return;
      hooks.onChange();
    });
  });
}

/** 归一化工具清单：只保留非空字符串、trim、去重。 */
function normalizeToolList(value) {
  const out = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item !== "string") continue;
    const tool = item.trim();
    if (tool.length > 0 && !out.includes(tool)) out.push(tool);
  }
  return out;
}

/** 归一化任意来源（组合行 config / settings 解析值）的配置。 */
function normalizeConfig(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const tools = normalizeToolList(value.reconstructionTools);
  return {
    enabled: value.enabled !== false,
    includeSubagents: value.includeSubagents === true,
    reconstructionTools: tools.length > 0 ? tools : [...DEFAULT_RECONSTRUCTION_TOOLS],
  };
}

/** 是否为会话型子代理（含 workflow / ralph 派生的子会话）。 */
function isSubagent(agent) {
  try {
    const depth = agent?.options?.subagentDepth;
    if (typeof depth === "number" && depth > 0) return true;
    const events = agent?.session?.events;
    if (Array.isArray(events)) {
      for (const event of events) {
        if (event !== null && typeof event === "object" && event.type === "subagent/descriptor") return true;
      }
    }
  } catch {
    // fall through
  }
  return false;
}

/** 从 session 对象判断是否子代理（session/event 形态用）。 */
function isSubagentSession(session) {
  try {
    const header = session?.header;
    if (header === null || header === undefined || typeof header !== "object") return false;
    return header.origin === "subagent" || typeof header.parentSession === "string";
  } catch {
    return false;
  }
}

/** 会话里是否已发生第一次工具调用。 */
function hasToolCall(agent) {
  try {
    const events = agent?.session?.events;
    if (!Array.isArray(events)) return false;
    return events.some((event) => event !== null && typeof event === "object" && event.type === "tool/call");
  } catch {
    return false;
  }
}

/** 插件自己的阶段状态文件名（DSH_HOME/storages 下，按 session id 索引）。
 *  注意：不能再用 agent.session.append("ka-whale-workflow/stage", ...) 持久化——
 *  DSH 的会话日志会把未注册的自定义事件视为未知且不可忽略，重载时直接拒绝读取
 *  整个 session（SessionFormatUnsupportedError）。改用插件自己的 JSON 存储。 */
const STAGE_FILE_NAME = "ka-whale-workflow-stage.json";

/** 默认阶段状态文件：~/.dsh/storages/ka-whale-workflow-stage.json。 */
function defaultStageFile() {
  return join(process.env.DSH_HOME || join(homedir(), ".dsh"), "storages", STAGE_FILE_NAME);
}

/** 会话 id：session.id 优先，回退 agent.id。 */
export function sessionIdOf(agent) {
  try {
    const id = agent?.session?.id || agent?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * 创建阶段状态存储（可注入文件路径，便于探针用临时文件）。
 * 结构：{ version: 1, sessions: { "<sessionId>": "reconstruction"|"classification"|"done" } }
 */
export function createStageStore(file) {
  const sessions = {};
  try {
    if (file !== undefined && file !== null && existsSync(file)) {
      let raw = readFileSync(file, "utf8");
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      const parsed = JSON.parse(raw);
      const data = parsed !== null && typeof parsed === "object" ? parsed.sessions : undefined;
      if (data !== null && typeof data === "object") {
        for (const [id, stage] of Object.entries(data)) {
          if (id.length > 0 && (stage === "reconstruction" || stage === "classification" || stage === "done")) {
            sessions[id] = stage;
          }
        }
      }
    }
  } catch {
    // 存储损坏时从空状态开始，不影响主流程
  }
  return {
    file,
    get(sessionId) {
      return typeof sessionId === "string" && sessionId.length > 0 ? sessions[sessionId] ?? null : null;
    },
    set(sessionId, stage) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return false;
      sessions[sessionId] = stage;
      if (typeof file !== "string" || file.length === 0) return true;
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify({ version: 1, sessions }, null, 2) + String.fromCharCode(10), "utf8");
        return true;
      } catch {
        return false;
      }
    },
    remove(sessionId) {
      if (typeof sessionId === "string") delete sessions[sessionId];
      if (typeof file === "string" && file.length > 0) {
        try {
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, JSON.stringify({ version: 1, sessions }, null, 2) + String.fromCharCode(10), "utf8");
        } catch {
          // 忽略清理失败
        }
      }
    },
  };
}

/** 从会话事件折叠旧版鲸鱼工作流阶段（兼容旧日志；只读，不再追加）。 */
function legacyStageOf(agent) {
  try {
    const events = agent?.session?.events;
    if (!Array.isArray(events)) return "idle";
    let stage = "idle";
    for (const event of events) {
      if (event === null || typeof event !== "object" || event.type !== "ka-whale-workflow/stage") continue;
      const value = event.data?.stage;
      if (value === "reconstruction" || value === "classification" || value === "done") stage = value;
    }
    return stage;
  } catch {
    return "idle";
  }
}

/** 读取当前阶段：插件 JSON 存储优先，旧会话事件兜底；无记录返回 "idle"。 */
export function stageOf(agent, store = null) {
  const sessionId = sessionIdOf(agent);
  if (store !== null && store !== undefined && typeof store.get === "function") {
    const stored = store.get(sessionId);
    if (stored === "reconstruction" || stored === "classification" || stored === "done") return stored;
  }
  return legacyStageOf(agent);
}

/** 设置阶段（仅当与当前阶段不同）：写入插件自己的 JSON 存储，不再 append 会话事件。 */
export function setStage(agent, stage, store = null) {
  const current = stageOf(agent, store);
  if (current === stage) return false;
  const sessionId = sessionIdOf(agent);
  if (sessionId === null) return false;
  if (store !== null && store !== undefined && typeof store.set === "function") {
    return store.set(sessionId, stage);
  }
  return false;
}

/** 是否真实用户消息（跳过 plugin / goal / tool 注入消息）。 */
export function isUserMessage(message) {
  if (message === null || message === undefined || typeof message !== "object") return false;
  const source = message.source;
  if (source === null || source === undefined || typeof source !== "object") return true;
  if (source.kind === "plugin" || source.kind === "goal" || source.kind === "tool") return false;
  if (typeof source.plugin === "string" && source.plugin.length > 0) return false;
  return true;
}

/** 会话日志里是否已注入过 ka-whale-workflow 的指定 form 消息。 */
function hasInjectedBefore(agent, form) {
  try {
    const events = agent?.session?.events;
    if (!Array.isArray(events)) return false;
    return events.some((event) => {
      if (event === null || typeof event !== "object" || event.type !== "user/message") return false;
      const data = event.data;
      if (data === null || typeof data !== "object") return false;
      const source = data.source;
      if (source === null || typeof source !== "object") return false;
      if (source.kind !== "plugin" || source.plugin !== "ka-whale-workflow") return false;
      return form === undefined || source.form === form;
    });
  } catch {
    return false;
  }
}

/** 会话日志里当前轮次（最后一个 turn/start 的 turn；无则 0）。 */
function currentTurnOf(agent) {
  try {
    const events = agent?.session?.events;
    if (!Array.isArray(events)) return 0;
    let turn = 0;
    for (const event of events) {
      if (
        event !== null &&
        typeof event === "object" &&
        event.type === "turn/start" &&
        event.data !== null &&
        typeof event.data === "object" &&
        typeof event.data.turn === "number" &&
        event.data.turn > turn
      ) {
        turn = event.data.turn;
      }
    }
    return turn;
  } catch {
    return 0;
  }
}

/** 指定 turn 内是否已注入过 ka-whale-workflow 的指定 form 消息。 */
export function hasInjectedInTurn(agent, form, turn) {
  try {
    const events = agent?.session?.events;
    if (!Array.isArray(events)) return false;
    let turnStartIndex = -1;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (
        event !== null &&
        typeof event === "object" &&
        event.type === "turn/start" &&
        event.data !== null &&
        typeof event.data === "object" &&
        event.data.turn === turn
      ) {
        turnStartIndex = index;
      }
    }
    if (turnStartIndex === -1) return false;
    for (let index = turnStartIndex + 1; index < events.length; index += 1) {
      const event = events[index];
      if (event === null || typeof event !== "object" || event.type !== "user/message") continue;
      const data = event.data;
      if (data === null || typeof data !== "object") continue;
      const source = data.source;
      if (source === null || typeof source !== "object") continue;
      if (source.kind !== "plugin" || source.plugin !== "ka-whale-workflow") continue;
      if (form === undefined || source.form === form) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** 新一轮真实用户消息（第 2、3、4……轮，模型不在运行）直接重新进入「任务重构」。 */
export function nextStageOnUserMessage(_current, _turn) {
  return "reconstruction";
}

/** 检测 /plan 或 /goal 命令触发的消息：最后一个 turn/end 之后有成功的 command/run。
 *  返回 { commandId, name }；调用方负责消费（每个 commandId 只旁路一次）。 */
export function manualCommandIdOf(agent) {
  try {
    const events = agent?.session?.events;
    if (!Array.isArray(events)) return null;
    let start = 0;
    for (let index = 0; index < events.length; index += 1) {
      if (events[index]?.type === "turn/end") start = index + 1;
    }
    let found = null;
    for (let index = start; index < events.length; index += 1) {
      const event = events[index];
      if (event === null || typeof event !== "object" || event.type !== "command/run") continue;
      const data = event.data;
      if (data === null || typeof data !== "object") continue;
      const name = data.name;
      if (typeof name !== "string" || !MANUAL_COMMAND_NAMES.includes(name)) continue;
      if (name === "plan" && typeof data.args === "string" && data.args.trim() === "off") continue;
      found = { commandId: data.commandId, name };
    }
    if (found === null) return null;
    const done = events.slice(start).some(
      (event) =>
        event !== null &&
        typeof event === "object" &&
        event.type === "command/done" &&
        event.data !== null &&
        typeof event.data === "object" &&
        event.data.commandId === found.commandId &&
        event.data.kind === "success",
    );
    return done ? found : null;
  } catch {
    return null;
  }
}

/** 提取 assembly.tools 里的工具名（去重、保留顺序）。 */
function toolNamesOf(tools) {
  const names = [];
  const seen = new Set();
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (tool === null || typeof tool !== "object") continue;
    const name = tool.name;
    if (typeof name !== "string" || name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

export default {
  name: "ka-whale-workflow",
  inject: ["systemPrompt", "tools"],
  apply(ctx, config = {}) {
    const entry = normalizeConfig(config);
    let source = () => entry;
    installSettingsWithDefaults(ctx, NAMESPACE, SETTINGS_SCHEMA, entry, DEFAULT_SECTION, {
      setSource: (getValue) => {
        source = () => normalizeConfig(getValue());
      },
      onChange: () => {
        const live = source();
        ctx.logger.info(
          `[ka-whale-workflow] 配置已热更新：enabled=${live.enabled}, includeSubagents=${live.includeSubagents}`,
        );
        handleChange();
      },
    });

    /** 阶段状态存储：插件自己的 JSON（config.stageStore 可覆盖，探针用临时文件）。
     *  绝不写会话事件——自定义事件会让 dsh 重载会话日志时拒绝整条日志。 */
    const stageStore = createStageStore(
      typeof config.stageStore === "string" && config.stageStore.trim().length > 0
        ? config.stageStore.trim()
        : defaultStageFile(),
    );
    /** 当前会话的鲸鱼工作流阶段（JSON 存储优先，旧会话事件只读兜底）。 */
    function stageOfAgent(agent) {
      return stageOf(agent, stageStore);
    }
    /** 推进鲸鱼工作流阶段（写 JSON 存储；不再 append 会话事件）。 */
    function setStageAgent(agent, stage) {
      return setStage(agent, stage, stageStore);
    }

    /** 生效配置 = kazMode.pluginConfig（完整）；服务缺失时回落到插件自身 settings.yaml。 */
    function liveFor(agent) {
      try {
        const svc = ctx.get("kazMode");
        if (svc !== undefined && svc !== null && typeof svc.pluginConfig === "function") {
          const cfg = svc.pluginConfig(agent, "ka-whale-workflow");
          if (cfg !== null && cfg !== undefined && typeof cfg === "object") return cfg;
        }
      } catch {
        // fall through
      }
      return source();
    }

    /** 是否处于 round-minimal 极简阶段（服务缺失按 false 处理）。 */
    function isMinimal(agent) {
      try {
        const rm = ctx.get("roundMinimal");
        if (rm !== undefined && rm !== null && typeof rm.isMinimal === "function") {
          return rm.isMinimal(agent) === true;
        }
      } catch {
        // fall through
      }
      return false;
    }

    /** ka-whale-workflow 配置面板里的重构工具清单（白名单之上的过滤器）。 */
    function reconstructionToolsFor(agent) {
      const current = liveFor(agent);
      const tools = Array.isArray(current.reconstructionTools)
        ? current.reconstructionTools.filter((tool) => typeof tool === "string" && tool.trim().length > 0)
        : [];
      return tools.length > 0 ? tools : [...DEFAULT_RECONSTRUCTION_TOOLS];
    }

    /** 当前阶段实际可见工具（供 prompt 里的 <工具列表> 渲染）。 */
    function availableStageTools(agent, stage) {
      const candidates =
        stage === "reconstruction"
          ? [...reconstructionToolsFor(agent), WHALE_REPORT_TOOL]
          : stage === "classification"
            ? [WHALE_REPORT_TOOL]
            : [];
      const out = [];
      for (const tool of candidates) {
        if (out.includes(tool)) continue;
        try {
          const svc = ctx.get("kazMode");
          if (svc !== undefined && svc !== null && typeof svc.toolVisible === "function") {
            if (svc.toolVisible(agent, tool) !== true) continue;
          }
        } catch {
          // 服务异常时保留候选
        }
        out.push(tool);
      }
      return out;
    }

    function renderPrompt(agent, stage) {
      const prompt =
        stage === "reconstruction"
          ? RECONSTRUCTION_PROMPT
          : stage === "classification"
            ? CLASSIFICATION_PROMPT
            : "";
      const tools = availableStageTools(agent, stage);
      const list = tools.length > 0 ? tools.join(", ") : "the currently available tools";
      return prompt.replace(/<工具列表>/g, list);
    }

    /** 尝试把本插件给模型发送的信息上报给 round-display（best-effort）。 */
    function reportRoundDisplay(agent, content, title) {
      try {
        const rd = ctx.get("roundDisplay");
        if (rd !== undefined && rd !== null && typeof rd.report === "function" && typeof content === "string" && content.trim().length > 0) {
          rd.report({ agent, plugin: "ka-whale-workflow", title: title || "工作流", content });
        }
      } catch (error) {
        ctx.logger?.debug?.(`[ka-whale-workflow] 上报 round-display 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    /**
     * 通过 create_plan 工具（planning isolate 组内）执行 plan 模式切换。
     * whale_report 自身在 host 层解析不到 planMode 服务，必须借 create_plan
     * 的 realm 执行上下文来调用 planMode.set。
     */
    function runPlanBridge(agent, exec, active) {
      const tools = ctx.get("tools");
      const tool =
        tools !== undefined &&
        tools !== null &&
        typeof tools.get === "function"
          ? tools.get(CREATE_PLAN_TOOL, agent)
          : undefined;
      if (tool === undefined || tool === null || typeof tool.execute !== "function") {
        throw new Error(`create_plan bridge is unavailable; cannot ${active ? "enter" : "exit"} plan mode`);
      }
      return tool.execute({ active }, exec);
    }

    // -----------------------------------------------------------------------
    // whale_report 工具：重构/分类各调用一次，向插件汇报阶段完成。
    // -----------------------------------------------------------------------
    const whaleReportDef = defineTool({
      name: WHALE_REPORT_TOOL,
      description:
        "Report that the current ka-whale-workflow stage is complete and advance to the next stage. Call once per stage: during task reconstruction, calling without mode only advances to task classification (stage='classification'); during task classification, pass mode ('normal' | 'plan' | 'goal') to finish the workflow (stage='done') and launch plan/goal mode if needed, so create_plan/create_goal are not needed. For goal mode, also pass objective.",
      parameters: {
        mode: {
          type: "string",
          description:
            "Only for the task classification stage: 'normal' (no mode, default), 'plan' (enter plan mode), or 'goal' (create a goal; objective required).",
        },
        objective: {
          type: "string",
          description: "Required when mode='goal': the concrete completion objective for the goal.",
        },
        max_goal_rounds: {
          type: "number",
          description: "Optional positive integer for mode='goal': automatic continuation round cap.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            stage: { type: "string", required: true },
            restarted: { type: "boolean", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const agent = exec?.agent;
        if (agent === null || agent === undefined || typeof agent !== "object") {
          return Promise.reject(new Error("whale_report requires a calling agent"));
        }
        const current = stageOfAgent(agent);
        if (current === "reconstruction") {
          setStageAgent(agent, "classification");
          reportRoundDisplay(agent, "任务重构完成，进入任务分类。", "阶段切换");
          return Promise.resolve({ ok: true, stage: "classification", restarted: false });
        }
        if (current === "classification") {
          const mode = args?.mode === "plan" ? "plan" : args?.mode === "goal" ? "goal" : "normal";
          const launches = [];
          if (mode === "plan") {
            try {
              const result = await runPlanBridge(agent, exec, true);
              if (result === null || typeof result !== "object" || result.ok !== true) {
                throw new Error("unexpected create_plan result: " + JSON.stringify(result));
              }
              launches.push("plan");
            } catch (error) {
              return Promise.reject(new Error("failed to enter plan mode: " + (error instanceof Error ? error.message : String(error))));
            }
          } else if (mode === "goal") {
            const objective = typeof args?.objective === "string" ? args.objective.trim() : "";
            if (objective.length === 0) {
              return Promise.reject(new Error("whale_report mode=goal requires an objective"));
            }
            const goals = ctx.get("goals");
            if (goals === undefined || goals === null || typeof goals.create !== "function") {
              return Promise.reject(new Error("goals service is unavailable; cannot create goal"));
            }
            try {
              goals.create(agent, {
                objective,
                ...(typeof args?.max_goal_rounds === "number" && Number.isInteger(args.max_goal_rounds) && args.max_goal_rounds > 0
                  ? { maxGoalRounds: args.max_goal_rounds }
                  : {}),
              });
              launches.push("goal");
            } catch (error) {
              return Promise.reject(new Error("failed to create goal: " + (error instanceof Error ? error.message : String(error))));
            }
          }
          setStageAgent(agent, "done");
          reportRoundDisplay(
            agent,
            "任务分类完成（模式：" + mode + (launches.length > 0 ? "，已启动 " + launches.join("、") : "") + "），鲸鱼工作流结束，放行 Kaz 白名单工具。",
            "阶段切换",
          );
          return Promise.resolve({ ok: true, stage: "done", restarted: false });
        }
        return Promise.reject(
          new Error("whale_report can only be called during task reconstruction or task classification"),
        );
      },
      presentCall: () => ({ card: "generic", title: "鲸鱼工作流汇报", kind: "other" }),
    });

    let toolDisposers = [];
    function installTools() {
      if (toolDisposers.length > 0) return;
      try {
        toolDisposers.push(ctx.tools.register(whaleReportDef));
      } catch (error) {
        ctx.logger.warn(`[ka-whale-workflow] 注册 ${WHALE_REPORT_TOOL} 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    function uninstallTools() {
      for (const dispose of toolDisposers) {
        try {
          dispose();
        } catch (error) {
          ctx.logger.warn(`[ka-whale-workflow] 注销 ${WHALE_REPORT_TOOL} 失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      toolDisposers = [];
    }
    function handleChange() {
      const enabled = source()?.enabled !== false;
      if (enabled) installTools();
      else uninstallTools();
    }

    // -----------------------------------------------------------------------
    // 对外信号：kaWhaleWorkflow 服务（供 kaz-mode 的 auto-on 读取阶段）。
    // -----------------------------------------------------------------------
    const kaWhaleWorkflowService = {
      version: 1,
      stageOf: (agent) => stageOfAgent(agent),
      enabledFor: (agent) => liveFor(agent).enabled === true,
    };
    ctx.effect(() => {
      const disposeService = ctx.provide("kaWhaleWorkflow", kaWhaleWorkflowService);
      return () => {
        if (typeof disposeService === "function") disposeService();
      };
    }, "ka-whale-workflow: 发布 kaWhaleWorkflow 阶段服务");

    // -----------------------------------------------------------------------
    // 启动：真实用户消息被 inbox claim 后、assembly 之前进入对应阶段。
    //   - /plan /goal 命令触发的消息：旁路鲸鱼工作流（不进入重构），
    //     round-minimal 极简过滤仍照常生效。
    //   - 用户插话不改变当前阶段；仅首轮/未开始且已解除极简时进入任务重构。
    // -----------------------------------------------------------------------
    const pendingStart = new Set();
    /** 进程内已消费的 /plan /goal 命令 id（每个命令只旁路下一次 claim）。 */
    const consumedManualCommands = new Set();
    /** 当前处于命令旁路的 session id 集合（assemble / pre-step 读取）。 */
    const manualBypassSessions = new Set();

    /** 当前会话是否处于命令旁路。 */
    function isBypassed(agent) {
      const sessionId = sessionIdOf(agent);
      return typeof sessionId === "string" && sessionId.length > 0 && manualBypassSessions.has(sessionId);
    }

    /** 查询并消费一次命令旁路：命中返回命令信息，未命中返回 null。 */
    function consumeManualCommand(agent) {
      const found = manualCommandIdOf(agent);
      if (found === null || found.commandId === undefined || found.commandId === null) return null;
      if (consumedManualCommands.has(found.commandId)) return null;
      consumedManualCommands.add(found.commandId);
      return found;
    }

    ctx.on("agent/inbox/claimed", ({ agent, message, turn }) => {
      if (agent === null || agent === undefined || typeof agent !== "object") return;
      if (liveFor(agent).enabled !== true) return;
      if (liveFor(agent).includeSubagents !== true && isSubagent(agent)) return;
      if (!isUserMessage(message)) return;
      const sessionId = agent?.session?.id || agent?.id;
      if (typeof sessionId !== "string" || sessionId.length === 0) return;
      // /plan /goal 命令触发的消息：只跳过鲸鱼工作流，round-minimal 极简仍生效。
      const manual = consumeManualCommand(agent);
      if (manual !== null) {
        manualBypassSessions.add(sessionId);
        reportRoundDisplay(agent, `检测到 /${manual.name} 指令：本消息跳过鲸鱼工作流，直接放行白名单工具。`, "工作流旁路");
        return;
      }
      manualBypassSessions.delete(sessionId);
      const current = stageOfAgent(agent);
      // 第 2、3、4……轮（turn>=2，模型不在运行）：直接重新进入任务重构。
      if (typeof turn === "number" && turn >= 2) {
        const next = nextStageOnUserMessage(current, turn);
        if (setStageAgent(agent, next)) {
          reportRoundDisplay(agent, "收到新一轮消息，重新进入任务重构。", "阶段切换");
        }
        return;
      }
      // 插话（模型运行中）不改变当前工作流阶段；仅尚未开始（idle）时进入任务重构。
      if (current !== "idle") return;
      if (isMinimal(agent)) {
        pendingStart.add(sessionId);
        return;
      }
      if (setStageAgent(agent, "reconstruction")) {
        reportRoundDisplay(agent, "进入任务重构。", "阶段切换");
      }
    });

    /** 从 session/event 的 session 对象解析 agent（output-beep 同款）。 */
    function sessionAgentOf(session) {
      try {
        const id =
          session !== null && typeof session === "object" && typeof session.id === "string"
            ? session.id
            : session?.sessionId;
        if (typeof id === "string" && id.length > 0) {
          const agents = ctx.get("agents");
          if (agents !== undefined && agents !== null && typeof agents.get === "function") {
            const agent = agents.get(id);
            if (agent !== undefined && agent !== null) return agent;
          }
        }
      } catch {
        // fall through
      }
      return undefined;
    }

    ctx.on("session/event", (session, event) => {
      if (event === null || typeof event !== "object" || event.type !== "tool/call") return;
      const sessionId = session !== null && typeof session === "object" && typeof session.id === "string"
        ? session.id
        : session?.sessionId;
      if (typeof sessionId !== "string" || sessionId.length === 0 || !pendingStart.has(sessionId)) return;
      pendingStart.delete(sessionId);
      const agent = sessionAgentOf(session);
      if (agent === null || agent === undefined || typeof agent !== "object") return;
      if (liveFor(agent).enabled !== true) return;
      if (liveFor(agent).includeSubagents !== true && isSubagentSession(session)) return;
      const current = stageOfAgent(agent);
      if (current !== "idle") return;
      if (setStageAgent(agent, "reconstruction")) {
        reportRoundDisplay(agent, "round-minimal 已解除，进入任务重构。", "阶段切换");
      }
    });

    // -----------------------------------------------------------------------
    // 上下文注入：重构/分类按 turn 去重注入一次。
    // -----------------------------------------------------------------------
    ctx.on("agent/pre-step", async (payload, next) => {
      const agent = payload?.agent;
      if (agent !== null && agent !== undefined && typeof agent === "object") {
        const live = liveFor(agent);
        const skipSubagent = live.includeSubagents !== true && isSubagent(agent);
        const messages = Array.isArray(payload?.messages) ? payload.messages : [];
        const hasRealUserMessage = messages.some((message) => isUserMessage(message));
        const turn = typeof payload?.turn === "number" ? payload.turn : currentTurnOf(agent);
        const bypassed = isBypassed(agent);
        if (live.enabled === true && !skipSubagent && !bypassed) {
          const stage = stageOfAgent(agent);
          if (hasRealUserMessage) {
            if (turn >= 2) {
              const next = nextStageOnUserMessage(stage, turn);
              if (setStageAgent(agent, next)) {
                reportRoundDisplay(
                  agent,
                  "收到新一轮消息，重新进入任务重构（pre-step 兜底）。",
                  "阶段切换",
                );
              }
            } else if (stage === "idle" && !isMinimal(agent)) {
              if (setStageAgent(agent, "reconstruction")) {
                reportRoundDisplay(agent, "进入任务重构（pre-step 兜底）。", "阶段切换");
              }
            }
          } else if (turn < 2 && stage === "idle" && !isMinimal(agent) && hasToolCall(agent)) {
            if (setStageAgent(agent, "reconstruction")) {
              reportRoundDisplay(agent, "round-minimal 已解除，进入任务重构（pre-step 兜底）。", "阶段切换");
            }
          }
        }
      }
      const decision = await next();
      if (decision === null || typeof decision !== "object" || decision.kind !== "enter") return decision;
      if (agent === null || agent === undefined || typeof agent !== "object") return decision;
      if (liveFor(agent).enabled !== true) return decision;
      if (isBypassed(agent)) return decision;
      const stage = stageOfAgent(agent);
      const form =
        stage === "reconstruction"
          ? "reconstruction"
          : stage === "classification"
            ? "classification"
            : null;
      if (form === null) return decision;
      const turn = typeof payload?.turn === "number" ? payload.turn : currentTurnOf(agent);
      if (hasInjectedInTurn(agent, form, turn)) return decision;
      const title =
        stage === "reconstruction"
          ? "ka-whale-workflow TaskReconstruction"
          : "ka-whale-workflow TaskClassification";
      const text = ["[" + title + "]", ">", renderPrompt(agent, stage), "<"].join("\n");
      let message;
      try {
        message = createUserMessage({
          content: [{ type: "text", text }],
          source: { kind: "plugin", plugin: "ka-whale-workflow", form },
        });
      } catch (error) {
        ctx.logger.warn(`[ka-whale-workflow] 构造上下文消息失败：${error instanceof Error ? error.message : String(error)}`);
        return decision;
      }
      reportRoundDisplay(
        agent,
        text,
        stage === "reconstruction" ? "任务重构" : "任务分类",
      );
      return { ...decision, messages: Array.isArray(decision.messages) ? [...decision.messages, message] : decision.messages };
    });

    // -----------------------------------------------------------------------
    // 系统提示词段：接在 persona 后面（kaz-system-prompt 会保留本段）。
    // -----------------------------------------------------------------------
    ctx.systemPrompt.section({
      name: "ka-whale-workflow:prompt",
      order: 40,
      text: (context) => {
        const agent = context?.agent;
        if (agent === null || agent === undefined || typeof agent !== "object") return "";
        if (liveFor(agent).enabled !== true) return "";
        const stage = stageOfAgent(agent);
        if (stage !== "reconstruction" && stage !== "classification") return "";
        if (isBypassed(agent)) return "";
        return renderPrompt(agent, stage);
      },
    });

    // -----------------------------------------------------------------------
    // 工具面过滤：重构/分类按阶段清单过滤；命令旁路/done/idle 放行白名单。
    // -----------------------------------------------------------------------
    ctx.on("system-prompt/assemble", async function (assembly, context, next) {
      const agent = context?.agent;
      const before = toolNamesOf(assembly?.tools);
      const enabled = agent !== null && agent !== undefined && typeof agent === "object" && liveFor(agent).enabled === true;
      const bypassed = enabled && isBypassed(agent);
      // /plan /goal 命令消息：跳过鲸鱼工作流过滤与提示词段，直接放行白名单工具。
      if (bypassed) {
        const whaleSection = assembly.sections.find(
          (section) => typeof section?.name === "string" && section.name === "ka-whale-workflow:prompt",
        );
        if (whaleSection !== null && whaleSection !== undefined) whaleSection.text = "";
        const nextResult = await next();
        const finalAssembly = nextResult ?? assembly;
        const after = toolNamesOf(finalAssembly?.tools);
        if (before.join(",") !== after.join(",")) {
          reportRoundDisplay(
            agent,
            "工具面变化（命令旁路）\n- 阶段：manual-command\n- 当前工具（" + after.length + "）：" + (after.length > 0 ? after.join(", ") : "（无）"),
            "工作流工具面",
          );
        }
        return nextResult;
      }
      let stage = enabled ? stageOfAgent(agent) : "idle";
      // assemble 兜底：round-minimal 解除后、首次 tool/call 的下一步组装时，
      // 阶段可能还没被 session/event 路径推进（assemble 先于 agent/pre-step 执行）。
      // 在这里补一次阶段切换，使【紧跟在首次工具调用后的那次请求】就拿到对应工具面
      // 和系统提示词段，而不是再等一个 step。阶段丢失时一律进入任务重构。
      if (
        enabled &&
        stage === "idle" &&
        liveFor(agent).includeSubagents !== true &&
        !isSubagent(agent) &&
        !isMinimal(agent) &&
        hasToolCall(agent)
      ) {
        if (setStageAgent(agent, "reconstruction")) {
          reportRoundDisplay(
            agent,
            "round-minimal 已解除，进入任务重构（assemble 兜底）。",
            "阶段切换",
          );
          stage = "reconstruction";
        }
      }
      let allowed = null;
      if (stage === "reconstruction") {
        allowed = new Set([...reconstructionToolsFor(agent), WHALE_REPORT_TOOL]);
      } else if (stage === "classification") {
        allowed = new Set([WHALE_REPORT_TOOL]);
      }
      if (allowed !== null) {
        assembly.tools = assembly.tools.filter(
          (tool) => tool !== null && typeof tool === "object" && allowed.has(tool.name),
        );
        assembly.sections = assembly.sections.filter((section) => {
          if (typeof section?.name !== "string" || !section.name.startsWith("tool:")) return true;
          return allowed.has(section.name.slice("tool:".length));
        });
        // 本插件自己的提示词段在 assemble 开始时已按旧阶段渲染成空串；
        // 阶段刚被推进时在这里补写，让同一请求的 system 里就带对应阶段提示。
        const whaleSection = assembly.sections.find(
          (section) => typeof section?.name === "string" && section.name === "ka-whale-workflow:prompt",
        );
        if (whaleSection !== null && whaleSection !== undefined) {
          whaleSection.text = renderPrompt(agent, stage);
        }
      }
      const nextResult = await next();
      const finalAssembly = nextResult ?? assembly;
      const after = toolNamesOf(finalAssembly?.tools);
      if (before.join(",") !== after.join(",")) {
        reportRoundDisplay(
          agent,
          "工具面变化（ka-whale-workflow 阶段过滤）\n- 阶段：" + stage + "\n- 当前工具（" + after.length + "）：" + (after.length > 0 ? after.join(", ") : "（无）"),
          "工作流工具面",
        );
      }
      return nextResult;
    });

    // -----------------------------------------------------------------------
    // 执行层闸门：重构/分类阶段只允许阶段工具（纵深防御，组装层已隐藏）。
    // -----------------------------------------------------------------------
    ctx.on("tools/pre-execute", (exec, next) => {
      const agent = exec?.agent;
      if (agent === null || agent === undefined || typeof agent !== "object") return next();
      if (liveFor(agent).enabled !== true) return next();
      if (liveFor(agent).includeSubagents !== true && isSubagent(agent)) return next();
      if (isBypassed(agent)) return next();
      const stage = stageOfAgent(agent);
      let allowed = null;
      if (stage === "reconstruction") {
        allowed = new Set([...reconstructionToolsFor(agent), WHALE_REPORT_TOOL]);
      } else if (stage === "classification") {
        allowed = new Set([WHALE_REPORT_TOOL]);
      }
      if (allowed !== null && typeof exec?.name === "string" && !allowed.has(exec.name)) {
        ctx.logger.info(
          `[ka-whale-workflow] ${stage} 阶段拒绝调用工具 "${exec.name}"（仅允许：${[...allowed].join(", ")}）`,
        );
        return {
          kind: "deny",
          reason:
            `工具 "${exec.name}" 在鲸鱼工作流「${stage}」阶段不可用，当前仅允许：` +
            `${[...allowed].join(", ")}。完成本阶段（调用 whale_report）后即可恢复白名单工具。`,
        };
      }
      return next();
    });

    ctx.effect(() => () => {
      uninstallTools();
    });
  },
};
