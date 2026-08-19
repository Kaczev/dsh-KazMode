// thinking-anchor
// ---------------------------------------------------------------------------
// Injects a one-time reasoning instruction into the system prompt of each NEW
// conversation, appended as its own prompt section at the VERY END of the
// system prompt (order 10000, plus an assemble-time guarantee that moves this
// section to the last position of assembly.sections), so its strong wording
// overrides built-in defaults by recency (the original persona and other
// sections stay untouched).
//
// Semantics
//   * The full instruction text is returned only on the FIRST prompt
//     assembly of a new conversation; from turn 2 on, every assembly gets a
//     short reminder (settings `turnReminder`). Both messages use the
//     "[title] / > / content / <" envelope with an English and a Chinese
//     section each. A settings field left EMPTY falls back to the built-in
//     default text below; set `enabled: false` to disable the whole plugin.
//   * The instruction is bilingual: the full protocol is stated in English
//     and repeated in Chinese, so the requirement is unambiguous.
//   * "New conversation" is judged two ways:
//       1. agents already alive when this plugin loads are pre-marked as
//          anchored — their conversations began before the plugin, so they
//          never receive the instruction;
//       2. a session whose log already contains a user message (a resumed
//          conversation after a restart) is skipped as well.
//   * The `enabled` toggle AND the instruction text come from the
//     `thinking-anchor:` section of $DSH_HOME/settings.yaml — both hot-reload
//     (no restart needed), so the wording can be tuned live. Without a
//     settings provider, the composition entry config + schema defaults act
//     as the source.
//
// Composition: a host-plane row (see README). The section is registered on
// the host layer, so it participates in every agent's prompt assembly.
// ---------------------------------------------------------------------------

import z from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";

/** Unique section name; scoped registrations with the same name shadow this one. */
const SECTION_NAME = "thinking-anchor:policy";
/** Concatenation order: 10000 远大于任何内置（-100/0/50/110/115/150/200）与
 * 插件注册的 section order，配合组装层兜底（把本段移到 assembly.sections
 * 末尾），保证推理协议是系统提示的最后一段（最近因覆盖默认思考习惯）。 */
const SECTION_ORDER = 10000;

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

/** 读取代理当前轮次：会话日志中最近一个 turn/start 的 data.turn；无则 0。 */
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
  // The section must be registered as soon as the prompt registry exists;
  // it is always mounted by the base composition.
  inject: ["systemPrompt"],
  apply(ctx, config = {}) {
    // Composition entry config doubles as the settings `base` layer, so the
    // row may pin `enabled` and the user document may still override it.
    const entry = { enabled: config.enabled !== false };
    let source = () => entry;

    // Optional settings consumer: registers the `thinking-anchor` namespace
    // while a settings service exists and falls back to `entry` otherwise.
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

    // Conversations that started before this plugin loaded are not "new":
    // pre-mark their agents so the instruction is injected only into
    // conversations that begin while the plugin is active.
    const anchored = new Set();
    const agents = ctx.get("agents");
    if (agents !== undefined) {
      for (const agent of agents.list()) {
        if (agent !== null && typeof agent === "object" && agent.id !== undefined) {
          anchored.add(agent.id);
        }
      }
    }

    // 注入策略：新对话首轮一次性完整指令；此后每轮（turn >= 2）注入
    // turnReminder 简短提醒。续接对话不重复完整指令，但从当轮起提醒。
    ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: (context) => {
        const agent = context.agent;
        if (agent === null || typeof agent !== "object") return "";
        const current = source();
        if (current.enabled === false) return "";

        const id = agent.id;
        if (id === undefined) return "";

        // 每轮提醒：turn >= 2 才输出；settings 字段留空则用内置默认文案
        // （关闭整个插件用 enabled: false）。
        const textOf = (value, fallback) =>
          typeof value === "string" && value.trim().length > 0 ? value : fallback;
        const turnReminderOf = (config) =>
          currentTurnOf(agent) >= 2 ? textOf(config.turnReminder, DEFAULT_TURN_REMINDER) : "";

        let output = "";
        // 首轮（或重启后续接对话的首个组装）：注入完整指令一次并标记；
        // 此后每轮注入简短提醒，保持思维链习惯。
        if (!anchored.has(id)) {
          // Skip resumed conversations: a session that already contains a user
          // message began before this process, so its first assembly here is not
          // a "first request".
          const session = agent.session;
          const hasPriorUserMessage =
            session !== undefined &&
            session !== null &&
            Array.isArray(session.events) &&
            session.events.some((event) => event !== null && event.type === "user/message");
          anchored.add(id);
          if (hasPriorUserMessage) {
            // 续接对话：不再注入完整指令，但后续每轮仍提醒。
            output = turnReminderOf(current);
          } else {
            output = textOf(current.instruction, DEFAULT_INSTRUCTION);
          }
        } else {
          output = turnReminderOf(current);
        }

        // 告诉 round-display 显示插件本轮发送了什么（best-effort）。
        reportRoundDisplay(agent, output);
        return output;
      },
    });

    // 组装层兜底：无论其它插件给 section 排了什么 order，都把本段移到
    // assembly.sections 的末尾——保证 thinking-anchor 提示词一定渲染在
    // 所有系统提示之后（最近因覆盖默认思考习惯）。kaz-mode 首轮极简会
    // 保留本段（persona + thinking-anchor），此处的重排与其过滤互不干扰。
    ctx.on("system-prompt/assemble", (assembly, _context, next) => {
      if (assembly !== null && typeof assembly === "object" && Array.isArray(assembly.sections)) {
        const anchorIndex = assembly.sections.findIndex(
          (section) => section !== null && typeof section === "object" && section.name === SECTION_NAME,
        );
        if (anchorIndex >= 0 && anchorIndex !== assembly.sections.length - 1) {
          const [anchor] = assembly.sections.splice(anchorIndex, 1);
          assembly.sections.push(anchor);
        }
      }
      return next();
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
