// first-round-hints —— 首轮其它消息提示插件
// ===========================================================================
// 对话开始时（首个 agent/pre-step，step === 1）把一条固定消息注入一次
// （kaz-memory 自动载入 / thinking-anchor 同款机制）：以合成用户消息追加到
// decision.messages，不触碰系统提示词（Kaz 模式的系统提示词由 kaz 预设的
// kaz-system-prompt.mjs 控制）。
//
// 默认消息 = pwsh 使用要点（stdout/stderr 是对象、编码陷阱、JSON 序列化陷阱；
// run_code 要点已按 Kaczev 要求移除）。消息内容可在 settings.yaml 的
// first-round-hints.message 热改（留空 = 用内置默认）。
//
// 注入策略：
//   * 每个会话只注入一次（新对话开始时的首个 step）；
//   * 插件加载时已存活的 agent 被预标记——它们的对话开始于插件之前，不注入；
//   * 续接对话（会话日志里已有 user/message）不注入；
//   * settings `enabled: false` 关闭整个插件。
// ===========================================================================

import z from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

/** 设置命名空间：~/.dsh/settings.yaml 中的 first-round-hints: 段。 */
const NAMESPACE = settingsNamespace("first-round-hints");

/** 默认注入消息（pwsh 使用要点；统一信封格式 [标题] / > / 内容 / <）。 */
const DEFAULT_MESSAGE = [
  "[first-round-hints pwsh quick rules]",
  ">",
  "- pwsh result: stdout/stderr are OBJECTS, not strings — read .text (r.stdout?.text ?? \"\"), never concatenate them directly.",
  "- Encoding: do not read UTF-8 files with Get-Content (CJK becomes mojibake) — use the read tool.",
  "- PowerShell JSON: ConvertTo-Json flattens single-element arrays to a bare string (use -AsArray or build the JSON manually); Set-Content -Encoding UTF8 adds a BOM that breaks JSON.parse (strip /^\\uFEFF/ or write with node).",
  "<",
  "[first-round-hints EIO]",
  ">",
  "- If write/edit reports 'Error: ReplaceFileW EIO (Win32 1175)', retry the exact same edit once — it is an intermittent Windows FS error.",
  "<",
  "[first-round-hints ask]",
  ">",
  "- We need to ask the user for clarification when the task goal or context is ambiguous.",
  "- we need to ask the user to resolve conflicts when multiple requirements cannot be satisfied simultaneously.",
  "<",
].join("\n");

const SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(true),
  message: z.string().default(DEFAULT_MESSAGE),
});

/** 本插件 settings.yaml 段的默认配置（镜像作者 settings.yaml；仅含非运行时字段）。 */
export const DEFAULT_SECTION = {
  enabled: true,
  message: "",
};

// ---------------------------------------------------------------------------
// settings 自愈：settings.yaml 中本插件段缺失时自动补齐默认值。
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
    // 纯方案 A（2026-08-21）：不再自愈写 settings.yaml——生效配置由
    // kazMode.pluginConfig 提供，settings.yaml 插件段仅作 standalone 兜底。
  });
}

function ensureSettingsDefaults(settings, ns, defaults, logger) {
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
  return {
    enabled: value.enabled !== false,
    message:
      typeof value.message === "string" && value.message.trim().length > 0
        ? value.message
        : DEFAULT_MESSAGE,
  };
}

export default {
  name: "first-round-hints",
  apply(ctx, config = {}) {
    const entry = normalizeConfig(config);
    let source = () => entry;
    installSettingsWithDefaults(ctx, NAMESPACE, SETTINGS_SCHEMA, entry, DEFAULT_SECTION, {
      setSource: (getValue) => {
        source = () => normalizeConfig(getValue());
      },
      onChange: () => {
        ctx.logger.info(`[first-round-hints] 配置已热更新：enabled=${source().enabled}`);
      },
    });

    const initial = source();
    ctx.logger.info(`[first-round-hints] 已加载：enabled=${initial.enabled}`);

    /** 尝试把本插件给模型发送的信息上报给 round-display 显示插件（best-effort）。 */
    function reportRoundDisplay(agent, content) {
      try {
        const rd = ctx.get("roundDisplay");
        if (rd !== undefined && rd !== null && typeof rd.report === "function" && typeof content === "string" && content.trim().length > 0) {
          rd.report({ agent, plugin: "first-round-hints", title: "pwsh quick rules", content });
        }
      } catch (error) {
        ctx.logger.debug(`[first-round-hints] 上报 round-display 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    /** 生效配置 = kazMode.pluginConfig（完整）；服务缺失时回落到插件自身 settings.yaml。 */
    function liveFor(agent) {
      try {
        const svc = ctx.get("kazMode");
        if (svc !== undefined && svc !== null && typeof svc.pluginConfig === "function") {
          const cfg = svc.pluginConfig(agent, "first-round-hints");
          if (cfg !== null && cfg !== undefined && typeof cfg === "object") return cfg;
        }
      } catch {
        // fall through
      }
      return source();
    }

    // Conversations that started before this plugin loaded are not "new":
    // pre-mark their agents so the message is injected only into conversations
    // that begin while the plugin is active.
    const injected = new Set();
    const agents = ctx.get("agents");
    if (agents !== undefined && agents !== null && typeof agents.list === "function") {
      for (const agent of agents.list()) {
        if (agent !== null && typeof agent === "object" && agent.id !== undefined) {
          injected.add(agent.id);
        }
      }
    }

    // 对话开始时（首个 pre-step，step === 1）注入一次；续接对话不注入。
    ctx.on("agent/pre-step", async (payload, next) => {
      const decision = await next();
      if (decision === null || typeof decision !== "object" || decision.kind !== "enter") return decision;
      if (payload === null || typeof payload !== "object" || payload.step !== 1) return decision;
      const agent = payload.agent;
      if (agent === null || agent === undefined || typeof agent !== "object") return decision;
      const current = liveFor(agent);
      if (current === null || typeof current !== "object" || current.enabled === false) return decision;
      const id = agent.id;
      if (id === undefined) return decision;

      // 续接对话（会话日志里已有 user/message）不注入——对话开始时已注入过。
      const hasPriorUserMessage =
        agent.session !== undefined &&
        agent.session !== null &&
        Array.isArray(agent.session.events) &&
        agent.session.events.some((event) => event !== null && typeof event === "object" && event.type === "user/message");
      if (hasPriorUserMessage) {
        if (id !== undefined) injected.add(id);
        return decision;
      }
      if (injected.has(id)) return decision;
      injected.add(id);

      const text = typeof current.message === "string" && current.message.trim().length > 0 ? current.message : DEFAULT_MESSAGE;
      if (text.trim().length === 0) return decision;

      let message;
      try {
        message = createUserMessage({
          content: [{ type: "text", text }],
          source: { kind: "plugin", plugin: "first-round-hints" },
        });
      } catch (error) {
        ctx.logger.warn(`[first-round-hints] 构造注入消息失败：${error instanceof Error ? error.message : String(error)}`);
        return decision;
      }
      reportRoundDisplay(agent, text);
      return { ...decision, messages: Array.isArray(decision.messages) ? [...decision.messages, message] : decision.messages };
    });

    // Bounded memory: drop entries when agents leave the registry.
    ctx.on("agent/disposed", (payload) => {
      const id = payload !== null && typeof payload === "object" ? payload.agent?.id : undefined;
      if (id !== undefined) injected.delete(id);
    });
  },
};
