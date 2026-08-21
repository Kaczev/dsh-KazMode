// round-minimal
// ===========================================================================
// 按「首次工具调用」切换工具集（2026-08 重构，替代旧的按轮次判定）：
//
//   1) 首次工具调用前——极简阶段：
//        - 模型可见的工具只保留 firstRoundTools（默认 pwsh、str_replace_editor）：
//          组装层（system-prompt/assemble）把其它工具及 tool:* 指导段全部滤除，
//          执行层（tools/pre-execute）对白名单之外的调用一律拒绝（纵深防御）；
//        - 不再注入任何提示段（2026-08：原 round-minimal:policy 的两条消息已删除，
//          对话开始时的注入消息改由 first-round-hints 插件提供）。
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
// 配置（热重载，写入 ~/.dsh/settings.yaml 的 round-minimal: 命名空间即可，
// 无需重启；组合行 cordis.patch.yml 的 config 作为 base 层，用户设置优先）：
//   enabled                是否启用，默认 true
//   firstRoundTools        极简阶段可用工具白名单，默认 ["pwsh", "str_replace_editor"]
//   includeSubagents       是否对子代理也施加极简阶段，默认 false
// ===========================================================================

import z from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { DEFAULT_FIRST_ROUND_TOOLS } from "kaz-shared";

/** 设置命名空间：~/.dsh/settings.yaml 中的 round-minimal: 段。 */
const NAMESPACE = settingsNamespace("round-minimal");

/** 设置 schema（同时驱动设置页 UI）。 */
const SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(true),
  firstRoundTools: z.array(z.string()).default([...DEFAULT_FIRST_ROUND_TOOLS]),
  includeSubagents: z.boolean().default(false),
});

/** 本插件 settings.yaml 段的默认配置（镜像作者 settings.yaml；仅含非运行时字段）。 */
export const DEFAULT_SECTION = {
  enabled: true,
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
    // 自愈：只补缺失键，保留用户已有配置（best-effort，失败只记日志）。
    ensureSettingsDefaults(sctx.settings, ns, defaults, ctx.logger);
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


/** 归一化任意来源（组合行 config / settings 解析值）的配置。 */
function normalizeConfig(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const tools = Array.isArray(value.firstRoundTools)
    ? value.firstRoundTools
        .filter((tool) => typeof tool === "string" && tool.trim().length > 0)
        .map((tool) => tool.trim())
    : [...DEFAULT_FIRST_ROUND_TOOLS];
  return {
    enabled: value.enabled !== false,
    firstRoundTools: tools,
    includeSubagents: value.includeSubagents === true,
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
            `includeSubagents=${live.includeSubagents}`,
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

    /** 该代理此刻是否处于极简阶段（enabled、非子代理（按配置）、尚无 tool/call）。 */
    function isFirstRound(agent) {
      const current = liveFor(agent);
      if (current.enabled !== true) return false;
      if (agent === null || typeof agent !== "object") return false;
      if (current.includeSubagents !== true && isSubagent(agent)) return false;
      return !hasToolCall(agent);
    }

    const initial = source();
    ctx.logger.info(
      `[round-minimal] 已加载：enabled=${initial.enabled}, ` +
        `firstRoundTools=[${initial.firstRoundTools.join(", ")}], ` +
        `includeSubagents=${initial.includeSubagents}`,
    );

    // -----------------------------------------------------------------------
    // 对外信号：roundMinimal 服务（供 kaz-mode 等同步查询极简状态）+
    // round-minimal/state 事件（状态变化时推送，供状态报告与日志）。
    // -----------------------------------------------------------------------
    const roundMinimalService = {
      version: 1,
      enabled: () => source().enabled === true,
      firstRoundTools: () => (Array.isArray(source().firstRoundTools) ? source().firstRoundTools : []),
      isMinimal: (agent) => isFirstRound(agent),
      turnOf: (agent) => currentTurnOf(agent),
    };
    ctx.effect(() => {
      const disposeService = ctx.provide("roundMinimal", roundMinimalService);
      return () => {
        if (typeof disposeService === "function") disposeService();
      };
    }, "round-minimal: 发布 roundMinimal 首阶段状态服务");

    const lastMinimalState = new WeakMap();
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
          firstRoundTools: roundMinimalService.firstRoundTools(),
        });
      } catch {
        // 信号发送失败不影响主流程
      }
    }

    // -----------------------------------------------------------------------
    // 组装层过滤：极简阶段只保留白名单工具及其 tool:* 指导段。
    //    host 平面的监听器无 scope 标签，对 agent 作用域的组装同样生效。
    // -----------------------------------------------------------------------
    ctx.on("system-prompt/assemble", function (assembly, context, next) {
      signalState(context?.agent);
      const live = liveFor(context?.agent);
      if (live.enabled === true && isFirstRound(context?.agent)) {
        const allow = new Set(Array.isArray(live.firstRoundTools) ? live.firstRoundTools : []);
        assembly.tools = assembly.tools.filter(
          (tool) => tool !== null && typeof tool === "object" && allow.has(tool.name),
        );
        assembly.sections = assembly.sections.filter((section) => {
          if (typeof section?.name !== "string" || !section.name.startsWith("tool:")) return true;
          return allow.has(section.name.slice("tool:".length));
        });
      }
      return next();
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
        const tools = Array.isArray(live.firstRoundTools) ? live.firstRoundTools : [];
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
