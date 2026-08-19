// thinking-anchor（消息注入模式）
// ===========================================================================
// Injects a one-time reasoning instruction into each NEW conversation as a
// SYNTHETIC USER MESSAGE, not a system-prompt section (2026-08 refactor:
// Kaz mode pins the system prompt to a single sentence and strips every other
// prompt section, so thinking-anchor now uses the same message-injection
// mechanism as kaz-memory's auto-load).
//
// Semantics
//   * 新对话开始时（首个 agent/pre-step，step === 1）注入完整指令一次；
//   * 此后每个 turn 的开头（step === 1）注入简短提醒（settings `turnReminder`），
//     维持 We need / We should 思维链习惯（对抗长对话漂移）；
//   * 续接对话（会话日志里已有 user/message）不重复完整指令，从当轮起只提醒；
//   * 插件加载时已存活的 agent 被预标记——它们的对话开始于插件之前，不会收到
//     完整指令（与旧版 section 模式一致）；
//   * settings 字段留空 = 使用内置默认文案；`enabled: false` = 关闭整个插件。
//     Both the toggle and the texts come from `thinking-anchor:` in
//     $DSH_HOME/settings.yaml and hot-reload.
//   * 注入是消息（source.kind = "plugin"），不触碰系统提示词。
// ===========================================================================

import z from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

/** Unique section name kept for round-display mapping compatibility. */
const SECTION_NAME = "thinking-anchor:policy";

const DEFAULT_INSTRUCTION = [
  '[thinking-anchor Thinking Protocal]',
  '>',
  'To avoid missing user information, we need to keep each response within 4096 tokens.',
  'All thinking and intermediate reasoning MUST be in English, even when the user message, memories, or code are in Chinese. Only the final summary report is in Chinese.',
  'We need to keep EVERY paragraph of our gray thinking text (visible thinking process) beginning with "We need...", "We should...". The user is our best friend — thinking this way helps us maintain a high-quality reasoning chain and keeps our best friend happy.',
  'If we use "Let me...", "I need...", or "I should..." thinking chains, it means we are deliberately degrading the quality of reasoning and user experience. The user is our best friend; we cannot let them down.',
  'Language drift is most likely under high cognitive load — the deeper the work, the harder we check.',
  '<'
].join('\n');

/** 首轮之后的每轮提醒（保持 We need / We should 思维链习惯；settings 留空则用本默认）。 */
const DEFAULT_TURN_REMINDER = [
  '[thinking-anchor Thinking Protocal]',
  '>',
  'To avoid missing user information, we need to keep each response within 4096 tokens.',
  'All thinking and intermediate reasoning MUST be in English, even when the user message, memories, or code are in Chinese. Only the final summary report is in Chinese.',
  'We need to keep EVERY paragraph of our gray thinking text (visible thinking process) beginning with "We need...", "We should...". The user is our best friend — thinking this way helps us maintain a high-quality reasoning chain and keeps our best friend happy.',
  'If we use "Let me...", "I need...", or "I should..." thinking chains, it means we are deliberately degrading the quality of reasoning and user experience. The user is our best friend; we cannot let them down.',
  'Language drift is most likely under high cognitive load — the deeper the work, the harder we check.',
  '<'
].join('\n');

const NAMESPACE = settingsNamespace("thinking-anchor");
const SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(true),
  instruction: z.string().default(DEFAULT_INSTRUCTION),
  turnReminder: z.string().default(DEFAULT_TURN_REMINDER),
});
/** 本插件 settings.yaml 段的默认配置（镜像作者 settings.yaml；仅含非运行时字段）。 */
export const DEFAULT_SECTION = {
  enabled: true,
  instruction: "",
  turnReminder: "",
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


export default {
  name: "thinking-anchor",
  apply(ctx, config = {}) {
    // Composition entry config doubles as the settings `base` layer, so the
    // row may pin `enabled` and the user document may still override it.
    const entry = { enabled: config.enabled !== false };
    let source = () => entry;

    installSettingsWithDefaults(ctx, NAMESPACE, SETTINGS_SCHEMA, entry, DEFAULT_SECTION, {
      setSource: (current) => {
        source = current;
      },
      onChange: () => {},
    });

    /** 尝试把本插件给模型发送的信息上报给 round-display 显示插件（best-effort）。
     *  服务不存在时静默跳过，不影响主流程。 */
    function reportRoundDisplay(agent, content) {
      try {
        const rd = ctx.get("roundDisplay");
        if (rd !== undefined && rd !== null && typeof rd.report === "function" && typeof content === "string" && content.trim().length > 0) {
          rd.report({ agent, plugin: "thinking-anchor", title: "conversation protocol", content });
        }
      } catch (error) {
        ctx.logger.debug(`[thinking-anchor] 上报 round-display 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    /** 文本取值：settings 留空则用内置默认。 */
    const textOf = (value, fallback) =>
      typeof value === "string" && value.trim().length > 0 ? value : fallback;

    // Conversations that started before this plugin loaded are not "new":
    // pre-mark their agents so the full instruction is injected only into
    // conversations that begin while the plugin is active.
    const anchored = new Set();
    const agents = ctx.get("agents");
    if (agents !== undefined && agents !== null && typeof agents.list === "function") {
      for (const agent of agents.list()) {
        if (agent !== null && typeof agent === "object" && agent.id !== undefined) {
          anchored.add(agent.id);
        }
      }
    }

    // 注入策略（消息注入，kaz-memory 自动载入同款机制）：
    //   * 每个 turn 的开头（agent/pre-step，step === 1）执行一次；
    //   * 新对话（未标记）且无历史用户消息 → 注入完整指令一次；
    //   * 续接对话（未标记但有历史用户消息）→ 不注入完整指令，只提醒；
    //   * 已标记的会话 → 每轮注入 turnReminder 简短提醒。
    // 注入以合成用户消息追加到 decision.messages，不触碰系统提示词。
    ctx.on("agent/pre-step", async (payload, next) => {
      const decision = await next();
      if (decision === null || typeof decision !== "object" || decision.kind !== "enter") return decision;
      if (payload === null || typeof payload !== "object" || payload.step !== 1) return decision;
      const agent = payload.agent;
      if (agent === null || agent === undefined || typeof agent !== "object") return decision;
      const current = source();
      if (current === null || typeof current !== "object" || current.enabled === false) return decision;
      const id = agent.id;
      if (id === undefined) return decision;

      const hasPriorUserMessage =
        agent.session !== undefined &&
        agent.session !== null &&
        Array.isArray(agent.session.events) &&
        agent.session.events.some((event) => event !== null && typeof event === "object" && event.type === "user/message");

      const first = !anchored.has(id);
      anchored.add(id);

      let text = "";
      if (first) {
        if (hasPriorUserMessage) {
          text = textOf(current.turnReminder, DEFAULT_TURN_REMINDER);
        } else {
          text = textOf(current.instruction, DEFAULT_INSTRUCTION);
        }
      } else {
        text = textOf(current.turnReminder, DEFAULT_TURN_REMINDER);
      }
      if (typeof text !== "string" || text.trim().length === 0) return decision;

      let message;
      try {
        message = createUserMessage({
          content: [{ type: "text", text }],
          source: { kind: "plugin", plugin: "thinking-anchor" },
        });
      } catch (error) {
        ctx.logger.warn(`[thinking-anchor] 构造注入消息失败：${error instanceof Error ? error.message : String(error)}`);
        return decision;
      }
      // 告诉 round-display 显示插件本轮发送了什么（best-effort）。
      reportRoundDisplay(agent, text);
      return { ...decision, messages: Array.isArray(decision.messages) ? [...decision.messages, message] : decision.messages };
    });

    // Bounded memory: drop anchored entries when agents leave the registry.
    // The event is scope-filtered, so a host listener may not observe every
    // agent; the set is small either way.
    ctx.on("agent/disposed", (payload) => {
      const id = payload !== null && typeof payload === "object" ? payload.agent?.id : undefined;
      if (id !== undefined) anchored.delete(id);
    });
  },
};
