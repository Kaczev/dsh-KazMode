// round-minimal
// ===========================================================================
// 按「首次工具调用」切换工具集（2026-08 重构，替代旧的按轮次判定）：
//
//   1) 首次工具调用前——极简阶段：
//        - 模型可见的工具只保留 firstRoundTools（为空时自动：kaz-memory 开 =
//          memory_search；关 = pwsh + read + edit，由 kaz-shared 统一解析）：
//          组装层（system-prompt/assemble）把其它工具及 tool:* 指导段全部滤除，
//          执行层（tools/pre-execute）对白名单之外的调用一律拒绝（纵深防御）；
//        - 第一轮开始时按 guidanceHeadEnabled 注入一条极简工具解锁提示
//          （类似 kaz-memory 的 guidance_head；Kaz 模式默认开、非 Kaz 默认关）；
//          原 round-minimal:policy 的两条旧消息已删除，普通轮次不再注入。
//   2) 首次工具调用之后——全量恢复：
//        - 工具列表恢复为组合/预设配置的全部工具（round-minimal 不再过滤）。
//
// 阶段判定（可靠且无状态）：以会话日志中是否存在 tool/call 事件为准。agent-loop
// 在每次工具调用落盘 tool/call 事件，因此任意一次组装/执行时，读取会话事件里
// 是否已有 tool/call 即当前阶段：无 = 极简阶段，有 = 全量阶段。这也天然免疫
// 重启续接旧对话——旧对话已有工具调用，直接走全量模式。
//
// 子代理：默认不受影响（includeSubagents=false）。subagentDepth > 0 或会话
// 含 subagent/descriptor 事件的代理（subagent / subagent_fork / workflow /
// ralph 的子会话）始终走全量模式，避免极简阶段破坏委托任务的执行能力。
//
// 对外信号：本插件把极简状态发布为 roundMinimal 服务（enabled /
// firstRoundTools / isMinimal / turnOf），并在状态判定变化时发送
// round-minimal/state 事件（{ agent, minimal, turn, firstRoundTools }）——
// 供 kaz-mode 等消费方在极简阶段抑制"请先搜索记忆"之类的指引。
//
// 工具变化显示：每次 system-prompt/assemble 时记录过滤前后的可见工具面，
// 把当前轮的增删明细（移除/新增工具名）主动上报给 roundDisplay 服务，
// 由 round-display 的「本轮注入」面板展示。
//
// 配置（热重载，写入 ~/.dsh/settings.yaml 的 round-minimal: 命名空间即可，
// 无需重启；组合行 cordis.patch.yml 的 config 作为 base 层，用户设置优先）：
//   enabled                是否启用，默认 true
//   firstRoundTools        极简阶段可用工具白名单（空 = 按 kaz-memory 自动解析）
//   includeSubagents       是否对子代理也施加极简阶段，默认 false
//   guidanceHeadEnabled    第一轮工具解锁提示开关（Kaz 模式默认开；非 Kaz 默认关）
//   guidanceHead           第一轮工具解锁提示文本（留空 = 内置默认，按首轮工具拼装）
// ===========================================================================

import z from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { resolveFirstRoundTools } from "kaz-shared";

/** 设置命名空间：~/.dsh/settings.yaml 中的 round-minimal: 段。 */
const NAMESPACE = settingsNamespace("round-minimal");

/** 设置 schema（同时驱动设置页 UI）。 */
const SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(true),
  firstRoundTools: z.array(z.string()).default([]),
  includeSubagents: z.boolean().default(false),
  /** 第一轮工具解锁提示开关：Kaz 模式默认开，非 Kaz 模式默认关。 */
  guidanceHeadEnabled: z.boolean().default(false),
  /** 第一轮工具解锁提示文本：留空 = 内置默认（按 firstRoundTools 自动拼装）。 */
  guidanceHead: z.string().default(""),
});

/** 本插件 settings.yaml 段的默认配置（镜像作者 settings.yaml；仅含非运行时字段）。 */
export const DEFAULT_SECTION = {
  enabled: true,
  guidanceHeadEnabled: false,
  guidanceHead: "",
};
// ---------------------------------------------------------------------------
// settings 自愈：settings.yaml 中本插件段缺失时自动补齐默认值。
// 只写"缺失的键"，保留用户已有配置；settings.yaml 文件不存在时由 settings
// 服务在首次写入时自动创建（DSH_HOME 下的 settings.yaml）。
// ---------------------------------------------------------------------------

/** 卸载判定：插件 fiber 正在拆除时不再回写 source（与 dsh-settings 内部一致）。 */
function isUnloading(ctx) {
  const state = ctx.fiber.state;
  return state === 5 || state === 4; // FiberState.Unloading / Disposed
}

/**
 * 注册 settings 命名空间（语义与 installSettingsSection 相同：composition entry
 * 作 base、用户层优先、热重载），并在用户段缺失时只写缺失的键补齐默认值。
 */
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
    // 纯方案 A（2026-08-21）：不再自愈写 settings.yaml——生效配置由
    // kazMode.pluginConfig 提供，settings.yaml 插件段仅作 standalone 兜底。
  });
}

/**
 * 检查 settings.yaml 用户段：缺失的默认键用默认值补齐（合并写入，保留已有键）。
 * 返回写入的 patch；无需写入或失败时返回 null。独立导出便于测试。
 */
export function ensureSettingsDefaults(settings, ns, defaults, logger) {
  try {
    const descriptor = settings.describe().find((item) => item.ns === ns);
    const user =
      descriptor !== undefined && descriptor.user !== null && typeof descriptor.user === "object"
        ? descriptor.user
        : {};
    const patch = {};
    for (const [key, value] of Object.entries(defaults)) {
      if (!Object.prototype.hasOwnProperty.call(user, key)) patch[key] = value;
    }
    if (Object.keys(patch).length === 0) return null;
    const write = settings.update(ns, patch);
    if (write !== null && typeof write.then === "function") {
      void write.then(
        () => {
          logger?.info?.("[ns] settings.yaml config section auto-filled missing keys: " + Object.keys(patch).join(", "));
        },
        (error) => {
          logger?.warn?.("[ns] auto-fill defaults failed: " + (error instanceof Error ? error.message : String(error)));
        },
      );
    }
    return patch;
  } catch (error) {
    logger?.warn?.("[ns] check defaults failed: " + (error instanceof Error ? error.message : String(error)));
    return null;
  }
}


/** 归一化任意来源（组合行 config / settings 解析值）的配置。
 *  firstRoundTools 为空 = 自动：由 kaz-shared 按 kaz-memory 启用状态解析。 */
function normalizeConfig(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const tools = Array.isArray(value.firstRoundTools)
    ? value.firstRoundTools
        .filter((tool) => typeof tool === "string" && tool.trim().length > 0)
        .map((tool) => tool.trim())
    : [];
  return {
    enabled: value.enabled !== false,
    firstRoundTools: tools,
    includeSubagents: value.includeSubagents === true,
    guidanceHeadEnabled: value.guidanceHeadEnabled === true,
    guidanceHead: typeof value.guidanceHead === "string" ? value.guidanceHead : "",
  };
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

/** 读取代理当前轮次（仅供信号展示）：会话日志中最近一个 turn/start 的 data.turn；无则 0。 */
function currentTurnOf(agent) {
  try {
    const events = agent?.session?.events;
    if (!Array.isArray(events)) return 0;
    let turn = 0;
    for (const event of events) {
      if (event === null || typeof event !== "object") continue;
      if (event.type !== "turn/start") continue;
      const value = event.data?.turn;
      if (typeof value === "number" && value > turn) turn = value;
    }
    return turn;
  } catch {
    return 0;
  }
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
    return false;
  } catch {
    return false;
  }
}

/** 会话日志里是否已注入过 round-minimal 的指定 form 消息（跨重启/同 turn 防重复）。 */
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
      if (source.kind !== "plugin" || source.plugin !== "round-minimal") return false;
      return form === undefined || source.form === form;
    });
  } catch {
    return false;
  }
}

/** 指定 turn 内是否已注入过 round-minimal 的指定 form 消息。 */
function hasInjectedInTurn(agent, form, turn) {
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
      if (source.kind !== "plugin" || source.plugin !== "round-minimal") continue;
      if (form === undefined || source.form === form) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export default {
  name: "round-minimal",
  // systemPrompt：监听组装瀑布；tools：监听执行前闸门。
  inject: ["systemPrompt", "tools"],
  apply(ctx, config = {}) {
    // 组合行 config 作为 base 层；settings.yaml 用户层优先（热重载）。
    const entry = normalizeConfig(config);
    let source = () => entry;
    installSettingsWithDefaults(ctx, NAMESPACE, SETTINGS_SCHEMA, entry, DEFAULT_SECTION, {
      setSource: (current) => {
        source = () => normalizeConfig(current());
      },
      onChange: () => {
        const live = source();
        ctx.logger.info(
          `[round-minimal] 配置已热更新：enabled=${live.enabled}, ` +
            `firstRoundTools=[${live.firstRoundTools.join(", ")}], ` +
            `includeSubagents=${live.includeSubagents}, ` +
            `guidanceHeadEnabled=${live.guidanceHeadEnabled}`,
        );
      },
    });

    /** 生效配置 = kazMode.pluginConfig（完整）；服务缺失时回落到插件自身 settings.yaml。 */
    function liveFor(agent) {
      try {
        const svc = ctx.get("kazMode");
        if (svc !== undefined && svc !== null && typeof svc.pluginConfig === "function") {
          const cfg = svc.pluginConfig(agent, "round-minimal");
          if (cfg !== null && cfg !== undefined && typeof cfg === "object") return cfg;
        }
      } catch {
        // fall through
      }
      return source();
    }

    /** 该代理此刻的首轮工具白名单：显式配置优先；为空时按 kaz-memory 启用状态解析。 */
    function effectiveFirstRoundTools(agent) {
      const current = liveFor(agent);
      const explicit = Array.isArray(current.firstRoundTools) ? current.firstRoundTools.filter((t) => typeof t === "string" && t.trim().length > 0) : [];
      if (explicit.length > 0) return explicit;
      let kazMemoryEnabled;
      try {
        const svc = ctx.get("kazMode");
        if (svc !== undefined && svc !== null && typeof svc.pluginEnabled === "function" && agent) {
          kazMemoryEnabled = svc.pluginEnabled(agent, "kaz-memory") === true;
        }
      } catch {
        // 服务缺失时交给 resolveFirstRoundTools 兜底
      }
      return resolveFirstRoundTools({ kazMemoryEnabled });
    }

    /** 该代理此刻是否处于极简阶段（enabled、非子代理（按配置）、尚无 tool/call）。 */
    function isFirstRound(agent) {
      const current = liveFor(agent);
      if (current.enabled !== true) return false;
      if (agent === null || typeof agent !== "object") return false;
      if (manualBypass.get(agent) === true) return false;
      if (current.includeSubagents !== true && isSubagent(agent)) return false;
      return !hasToolCall(agent);
    }

    /** 首轮工具解锁提示文本：guidanceHead 留空时按 firstRoundTools 自动拼装。 */
    function firstRoundGuidanceText(agent, current) {
      const override =
        current !== null && typeof current === "object" && typeof current.guidanceHead === "string"
          ? current.guidanceHead.trim()
          : "";
      if (override.length > 0) return override;
      const tools = effectiveFirstRoundTools(agent);
      if (tools.length === 0) return "";
      let list;
      if (tools.length === 1) {
        list = tools[0];
      } else if (tools.length === 2) {
        list = tools.join(" or ");
      } else {
        list = tools.slice(0, -1).join(", ") + ", or " + tools[tools.length - 1];
      }
      return "Only " + list + " are available at beginning." + " Any call you make will unlock all tools";
    }

    /** 首轮工具提示的进程内去重（会话事件里已有 source 标记时同样跳过）。 */
    const firstRoundGuidanceInjected = new WeakMap();

    const initial = source();
    ctx.logger.info(
      `[round-minimal] 已加载：enabled=${initial.enabled}, ` +
        `firstRoundTools=[${initial.firstRoundTools.join(", ")}], ` +
        `includeSubagents=${initial.includeSubagents}, ` +
        `guidanceHeadEnabled=${initial.guidanceHeadEnabled}`,
    );

    // -----------------------------------------------------------------------
    // 对外信号：roundMinimal 服务（供 kaz-mode 等同步查询极简状态）+
    // round-minimal/state 事件（状态变化时推送，供状态报告与日志）。
    // -----------------------------------------------------------------------
    const roundMinimalService = {
      version: 1,
      enabled: () => source().enabled === true,
      /** 首轮工具白名单：传入 agent 时返回该对话的生效值（Kaz 面板覆盖优先），
       *  不传时兼容旧调用，返回插件自身 settings.yaml 的全局值。 */
      firstRoundTools: (agent) => {
        if (agent !== null && agent !== undefined && typeof agent === "object") {
          return effectiveFirstRoundTools(agent);
        }
        return Array.isArray(source().firstRoundTools) ? source().firstRoundTools : [];
      },
      isMinimal: (agent) => isFirstRound(agent),
      turnOf: (agent) => currentTurnOf(agent),
      /** 命令旁路：ka-whale-workflow 检测到 /plan /goal 指令消息时临时解除极简。 */
      setManualBypass: (agent, active) => {
        try {
          if (agent === null || agent === undefined || typeof agent !== "object") return;
          if (active === true) manualBypass.set(agent, true);
          else manualBypass.delete(agent);
        } catch {
          // 忽略异常
        }
      },
    };
    ctx.effect(() => {
      const disposeService = ctx.provide("roundMinimal", roundMinimalService);
      return () => {
        if (typeof disposeService === "function") disposeService();
      };
    }, "round-minimal: 发布 roundMinimal 首阶段状态服务");

    const lastMinimalState = new WeakMap();
    /** 命令旁路（/plan /goal 指令消息）：按 agent 临时解除极简。 */
    const manualBypass = new WeakMap();
    /** 状态变化时推送一次 round-minimal/state 信号；失败不影响主流程。 */
    function signalState(agent) {
      try {
        const minimal = isFirstRound(agent);
        if (lastMinimalState.get(agent) === minimal) return;
        lastMinimalState.set(agent, minimal);
        ctx.emit("round-minimal/state", {
          agent,
          minimal,
          turn: currentTurnOf(agent),
          firstRoundTools: roundMinimalService.firstRoundTools(agent),
        });
      } catch {
        // 信号发送失败不影响主流程
      }
    }

    // -----------------------------------------------------------------------
    // 首轮工具解锁提示（类似 kaz-memory guidance_head）：
    // 第一轮一开始（首个 pre-step，尚无 tool/call）注入一条精简用户消息，
    // 告诉模型先使用 firstRoundTools 中的工具，之后才能使用其它工具。
    // 默认：Kaz 模式开，非 Kaz 模式关（guidanceHeadEnabled 可显式覆盖）。
    // -----------------------------------------------------------------------
    ctx.on("agent/pre-step", async (payload, next) => {
      const decision = await next();
      if (decision === null || typeof decision !== "object" || decision.kind !== "enter") return decision;
      if (payload === null || typeof payload !== "object" || payload.step !== 1) return decision;
      const agent = payload?.agent;
      if (agent === null || agent === undefined || typeof agent !== "object") return decision;
      const live = liveFor(agent);
      if (live.enabled !== true) return decision;
      if (live.includeSubagents !== true && isSubagent(agent)) return decision;
      if (hasToolCall(agent)) return decision;
      if (firstRoundGuidanceInjected.get(agent) === true) return decision;
      const turn = currentTurnOf(agent);
      if (hasInjectedInTurn(agent, "first-round-guidance", turn)) return decision;
      if (hasInjectedBefore(agent, "first-round-guidance")) return decision;

      // 默认值：Kaz 模式开、非 Kaz 关；显式配置优先。
      let guidanceEnabled;
      if (live.guidanceHeadEnabled === true || live.guidanceHeadEnabled === false) {
        guidanceEnabled = live.guidanceHeadEnabled;
      } else {
        let kazEnabled = false;
        try {
          const svc = ctx.get("kazMode");
          if (svc !== undefined && svc !== null && typeof svc.kazEnabled === "function") {
            kazEnabled = svc.kazEnabled(agent) === true;
          }
        } catch {
          kazEnabled = false;
        }
        guidanceEnabled = kazEnabled;
      }
      if (!guidanceEnabled) return decision;

      const text = firstRoundGuidanceText(agent, live);
      if (typeof text !== "string" || text.trim().length === 0) return decision;
      const messageText = ["[round-minimal guidance]", ">", text.trim(), "<"].join("\n");
      let message;
      try {
        message = createUserMessage({
          content: [{ type: "text", text: messageText }],
          source: { kind: "plugin", plugin: "round-minimal", form: "first-round-guidance" },
        });
      } catch (error) {
        ctx.logger.warn("[round-minimal] 构造首轮工具提示消息失败：" + (error instanceof Error ? error.message : String(error)));
        return decision;
      }
      if (!Array.isArray(decision.messages)) return decision;
      firstRoundGuidanceInjected.set(agent, true);
      try {
        const rd = ctx.get("roundDisplay");
        if (rd !== undefined && rd !== null && typeof rd.report === "function") {
          rd.report({ agent, plugin: "round-minimal", title: "guidance", content: messageText });
        }
      } catch (error) {
        ctx.logger?.debug?.("[round-minimal] 首轮工具提示上报 round-display 失败：" + (error instanceof Error ? error.message : String(error)));
      }
      return { ...decision, messages: [...decision.messages, message] };
    });

    // -----------------------------------------------------------------------
    // 工具面变化展示：按 agent × 轮次记录上一次 assemble 后的可见工具面，
    // 每次组装时把增删明细主动上报给 round-display（best-effort）。
    // -----------------------------------------------------------------------
    const lastToolSurfaces = new WeakMap();
    /** 向 round-display 上报一次工具面增删明细（数据来自 system-prompt/assemble）。 */
    function reportToolSurfaceChange(agent, before, after, minimal) {
      try {
        if (agent === null || typeof agent !== "object") return;
        if (agent.id === undefined) return;
        const turn = currentTurnOf(agent);
        let state = lastToolSurfaces.get(agent);
        if (state === undefined || state.turn !== turn) {
          // 新一轮的第一条基线：
          //  - 全新会话且还在极简阶段：用过滤前的原始面，让面板能展示“极简阶段”的收窄；
          //  - 轮次切换或历史缺失：用当前真实最终工具面，避免把 kaz-mode 白名单过滤前
          //    的原始全量误当作上一轮状态。
          const useRawBaseline = state === undefined && minimal === true;
          state = { turn, names: useRawBaseline ? before : after };
          lastToolSurfaces.set(agent, state);
        }
        const prev = state.names;
        const added = after.filter((name) => !prev.includes(name));
        const removed = prev.filter((name) => !after.includes(name));
        if (added.length === 0 && removed.length === 0) return;
        state.names = after;

        let phase;
        if (minimal) {
          phase = "极简阶段（首次工具调用前）";
        } else if (added.length > 0 && removed.length === 0) {
          phase = "恢复全量（首次工具调用后）";
        } else {
          phase = "工具面变化";
        }
        const content =
          "工具面变化（来自 system-prompt/assemble）\n" +
          phase + "\n" +
          "- 当前工具（" + after.length + "）：" + (after.length > 0 ? after.join(", ") : "（无）") + "\n" +
          "- 移除（" + removed.length + "）：" + (removed.length > 0 ? removed.join(", ") : "（无）") + "\n" +
          "+ 新增（" + added.length + "）：" + (added.length > 0 ? added.join(", ") : "（无）");
        const roundDisplay = ctx.get("roundDisplay");
        if (
          roundDisplay !== null &&
          roundDisplay !== undefined &&
          typeof roundDisplay.report === "function"
        ) {
          roundDisplay.report({
            agent,
            plugin: "round-minimal",
            title: "本轮工具变化",
            content,
          });
        }
      } catch (error) {
        ctx.logger?.debug?.("[round-minimal] 工具变化上报失败：" + (error instanceof Error ? error.message : String(error)));
      }
    }

    // -----------------------------------------------------------------------
    // 组装层过滤：极简阶段只保留白名单工具及其 tool:* 指导段。
    //    host 平面的监听器无 scope 标签，对 agent 作用域的组装同样生效。
    //    同时把 assemble 前后的工具面差异上报 round-display。
    // -----------------------------------------------------------------------
    ctx.on("system-prompt/assemble", async function (assembly, context, next) {
      signalState(context?.agent);
      const agent = context?.agent;
      const before = toolNamesOf(assembly?.tools);
      const live = liveFor(agent);
      const minimal = live.enabled === true && isFirstRound(agent);
      if (minimal) {
        const allow = new Set(effectiveFirstRoundTools(agent));
        assembly.tools = assembly.tools.filter(
          (tool) => tool !== null && typeof tool === "object" && allow.has(tool.name),
        );
        assembly.sections = assembly.sections.filter((section) => {
          if (typeof section?.name !== "string" || !section.name.startsWith("tool:")) return true;
          return allow.has(section.name.slice("tool:".length));
        });
      }
      // 等后面所有监听器（含 kaz-mode 的白名单过滤）都跑完，再取最终工具面。
      // 这样上报的才是模型真正可见的工具面，而不是 round-minimal 自己过滤前的原始全量。
      const nextResult = await next();
      const finalAssembly = nextResult ?? assembly;
      const after = toolNamesOf(finalAssembly?.tools);
      reportToolSurfaceChange(agent, before, after, minimal);
      return nextResult;
    });

    // -----------------------------------------------------------------------
    // 执行层闸门：极简阶段调用白名单之外的工具一律拒绝。
    //    组装层已让模型看不到其它工具，这里是纵深防御。
    // -----------------------------------------------------------------------
    ctx.on("tools/pre-execute", (exec, next) => {
      signalState(exec?.agent);
      const live = liveFor(exec?.agent);
      if (live.enabled === true && isFirstRound(exec?.agent)) {
        const name = exec?.name;
        const tools = effectiveFirstRoundTools(exec?.agent);
        if (typeof name === "string" && !tools.includes(name)) {
          ctx.logger.info(
            `[round-minimal] 极简阶段拒绝调用工具 "${name}"（仅允许：${tools.join(", ")}）`,
          );
          return {
            kind: "deny",
            reason:
              `工具 "${name}" 在首次工具调用前（round-minimal 极简阶段）不可用，当前仅允许：` +
              `${tools.join(", ")}。第一次工具调用之后即可使用全部工具。`,
          };
        }
      }
      return next();
    });
  },
};
