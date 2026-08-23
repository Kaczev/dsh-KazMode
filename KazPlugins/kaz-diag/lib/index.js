// kaz-diag —— Kaz 模式诊断插件（独立状态工具）
// ===========================================================================
// 只做一件事：注册只读状态工具 kaz_mode_status，报告 Kaz 模式当前状态：
//   1) Kaz 模式开关（kaz-mode.enabled）与预设联动（agent-presets.default）；
//   2) 被管理插件（thinking-anchor / round-minimal / plugin-filter / output-beep /
//      round-display / deepseek-default-model / kaz-memory / kaz-diag）的启停与
//      开启 Kaz 前的原始状态快照；
//   3) Kaz 工具面：toolWhitelist 白名单 + kaz-shared 工具群组（= Kaz 模式
//      全部工具的手动编辑点），并给出动态调整后的实际工具面：
//        - kaz-memory 关闭 → 其四个记忆工具自动移出；
//        - 本插件（kaz-diag）开启 → kaz_mode_status 自动加入；
//   4) round-minimal 信号：首次工具调用前 = 首阶段极简（memory_search），
//      首次工具调用后 = 恢复 Kaz 全部工具。
//
// 工具注册跟随本插件 enabled 开关（settings.yaml 的 kaz-diag: 段，热重载）：
// 关闭时工具不注册、也不进入 Kaz 工具面；开启后才注册并加入 Kaz 全部工具列表
// （与 kaz-memory 的工具同款条件）。
// ===========================================================================

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import {
  TOOL_WHITELIST,
  MANAGED_PLUGINS,
  FIXED_PERSONA,
  computeSurface,
} from "kaz-shared";

/** 设置命名空间：~/.dsh/settings.yaml 中的 kaz-diag: 段。 */
const NAMESPACE = settingsNamespace("kaz-diag");

/** Kaz 模式对应的 agent preset id。 */
const KAZ_PRESET_ID = "kaz";

/** 默认系统提示词（kaz 预设的 kaz-system-prompt.mjs 会按条件覆盖；这里仅作展示参考）。 */
// （FIXED_PERSONA 来自 kaz-shared 单一事实源，不再本地维护副本）

const SETTINGS_SCHEMA = z.object({
  /** 总开关：关闭时 kaz_mode_status 不注册、不进入 Kaz 工具面。 */
  enabled: z.boolean().default(true),
});

/** 本插件 settings.yaml 段的默认配置。 */
export const DEFAULT_SECTION = {
  enabled: true,
};

// ---------------------------------------------------------------------------
// settings 自愈（与其它 Kaz 插件同款）：缺失键补齐默认值。
// ---------------------------------------------------------------------------

/** 卸载判定：插件 fiber 正在拆除时不再回写 source。 */
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

/** 安全地把任意抛出的值转成可打印字符串。 */
function safeMessage(error) {
  try {
    if (error instanceof Error) return error.message;
    if (error !== null && typeof error === "object" && "message" in error) return String(error.message);
    return String(error);
  } catch {
    return "<不可打印的错误>";
  }
}

export default {
  name: "kaz-diag",
  inject: ["settings", "tools"],
  apply(ctx, config = {}) {
    const entry = { enabled: config.enabled !== false };
    let source = () => entry;
    installSettingsWithDefaults(ctx, NAMESPACE, SETTINGS_SCHEMA, entry, DEFAULT_SECTION, {
      setSource: (getValue) => {
        source = () => ({ enabled: getValue()?.enabled !== false });
      },
      // 关键：settings 热重载（含用户层在启动后到达）必须重新评估工具注册——
      // 否则 kaz_mode_status 只在启动瞬间按默认 enabled=true 注册一次，
      // 之后 enabled:false 永远不会注销它（kaz-memory 同款写法）。
      onChange: () => handleChange(),
    });

    const initial = source();
    ctx.logger.info(`[kaz-diag] 已加载：enabled=${initial.enabled}`);

    /** settings 服务（apply 阶段可能尚未挂载，调用时再解析）。 */
    const getSettings = () => ctx.get("settings");

    /** 读取某个命名空间的当前配置；读不到返回 undefined。 */
    function readNamespace(ns) {
      const settings = getSettings();
      if (settings === undefined) return undefined;
      try {
        return settings.get(ns);
      } catch {
        return undefined;
      }
    }

    /** 读取某插件状态的 enabled 与是否用户覆盖。 */
    function readPluginState(pluginId) {
      const settings = getSettings();
      if (settings === undefined) return null;
      try {
        const ns = settingsNamespace(pluginId);
        const value = settings.get(ns);
        if (value === undefined || value === null || typeof value !== "object") return null;
        let user = null;
        try {
          const descriptor = settings.describe().find((item) => item.ns === ns);
          user = descriptor?.user;
        } catch {
          user = null;
        }
        return {
          registered: true,
          enabled: value.enabled !== false,
          hadOverride:
            user !== null && typeof user === "object" && Object.prototype.hasOwnProperty.call(user, "enabled"),
        };
      } catch (error) {
        ctx.logger.warn(`[kaz-diag] 读取 ${pluginId} 状态失败：${safeMessage(error)}`);
        return null;
      }
    }

    /** 当前被管理插件清单（优先 kaz-mode.managedPlugins，缺省用 kaz-shared 目录）。 */
    function managedList() {
      const kazSettings = readNamespace(settingsNamespace("kaz-mode"));
      const byId = new Map(MANAGED_PLUGINS.map((p) => [p.id, p.label]));
      const ids =
        kazSettings !== undefined &&
        kazSettings !== null &&
        typeof kazSettings === "object" &&
        Array.isArray(kazSettings.managedPlugins) &&
        kazSettings.managedPlugins.length > 0
          ? kazSettings.managedPlugins.filter((id) => typeof id === "string" && id.trim().length > 0)
          : MANAGED_PLUGINS.map((p) => p.id);
      return ids.map((id) => ({ id, label: byId.get(id) ?? id }));
    }

    /** 读取 kaz-mode 的 toolWhitelist（缺省用 kaz-shared 的默认值）。 */
    function kazToolWhitelist() {
      const kazSettings = readNamespace(settingsNamespace("kaz-mode"));
      return Array.isArray(kazSettings?.toolWhitelist)
        ? kazSettings.toolWhitelist.filter((t) => typeof t === "string" && t.length > 0)
        : TOOL_WHITELIST;
    }

    /** 该代理是否处于首阶段极简：完全由 round-minimal 服务判定；
     *  服务缺失或禁用 → 无首阶段（不自行兜底）。 */
    function isMinimalAgent(agent) {
      if (agent === null || agent === undefined || typeof agent !== "object") return false;
      try {
        const depth = agent?.options?.subagentDepth;
        if (typeof depth === "number" && depth > 0) return false;
        const events = agent?.session?.events;
        if (Array.isArray(events)) {
          for (const event of events) {
            if (event !== null && typeof event === "object" && event.type === "subagent/descriptor") return false;
          }
        }
      } catch {
        // fall through
      }
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

    /** 读取 kazMode 服务（kaz-mode 方案 A：按 agent 会话判定工具面）；缺失返回 null。 */
    function kazModeServiceOf() {
      try {
        const svc = ctx.get("kazMode");
        return svc !== undefined && svc !== null && typeof svc.kazEnabled === "function" ? svc : null;
      } catch {
        return null;
      }
    }

    /** 生成完整状态报告。 */
    function buildReport(agent = undefined) {
      const kazSettings = readNamespace(settingsNamespace("kaz-mode"));
      const kazModeSvc = kazModeServiceOf();
      const kazEnabled =
        kazModeSvc !== null
          ? kazModeSvc.kazEnabled(agent) === true
          : kazSettings !== undefined && kazSettings !== null && kazSettings.enabled === true;
      const lines = [];
      lines.push("kaz-mode 状态报告（kaz-diag）");
      lines.push("==================================================");
      lines.push(
        `配置: enabled=${kazEnabled}`,
      );
      lines.push("");

      lines.push("[预设联动]");
      const presets = readNamespace(settingsNamespace("agent-presets"));
      const preset = presets !== undefined && presets !== null && typeof presets === "object" ? presets.default : undefined;
      lines.push(
        `  当前预设: ${preset ?? "（不可读）"}${preset === KAZ_PRESET_ID ? " ← Kaz 模式" : ""}` +
          `；上次非 kaz 预设（关闭时切回目标）: ${kazSettings?.previousPreset ?? "cordis"}`,
      );
      lines.push(`  说明：Kaz 模式已注册为 agent preset（id: kaz），按钮与预设选择器双向同步。`);
      lines.push("");

      lines.push("[系统提示词]");
      lines.push(`  默认 persona（由 kaz 预设的 kaz-system-prompt.mjs 按条件覆盖，kaz-memory 启用时切换为记忆优先提示词）: ${FIXED_PERSONA}`);
      lines.push("");

      lines.push("[插件联动]");
      const saved = kazSettings?.savedPluginStates ?? {};
      for (const plugin of managedList()) {
        const state = readPluginState(plugin.id);
        lines.push(`  • ${plugin.label}`);
        if (state === null) {
          lines.push("      状态: 未加载（settings 未注册，该插件行可能未挂载）");
        } else {
          lines.push(
            `      状态: ${state.enabled ? "启用" : "禁用"}` +
              `${state.hadOverride ? "（用户在 settings.yaml 有覆盖）" : "（继承组合配置/默认值）"}`,
          );
        }
        const before = saved[plugin.id];
        if (before !== undefined && before !== null) {
          lines.push(
            `      开启 Kaz 前的原始状态: enabled=${before.enabled}` +
              `${before.hadOverride ? "（用户覆盖）" : "（继承）"}`,
          );
        }
        // kazMode 服务存在且绑定 agent 时，显示「本会话生效」状态（模式默认+会话覆盖）。
        if (kazModeSvc !== null && kazModeSvc !== undefined && typeof kazModeSvc.pluginConfig === "function" && agent !== undefined) {
          try {
            const eff = kazModeSvc.pluginConfig(agent, plugin.id);
            if (eff !== null && eff !== undefined && typeof eff === "object") {
              lines.push(`      本会话生效: enabled=${eff.enabled !== false}`);
            }
          } catch {
            // 忽略
          }
        }
      }
      lines.push(
        kazEnabled
          ? `联动状态: 已开启${Object.keys(saved).length > 0 ? `，保存了 ${Object.keys(saved).length} 个插件的原始状态` : ""}`
          : "联动状态: 未开启",
      );
      lines.push("");

      lines.push("[前置插件]（Kaz 模式工具面 / 记忆的关键依赖）");
      for (const id of ["round-minimal", "plugin-filter", "kaz-memory"]) {
        const state = readPluginState(id);
        if (state === null) {
          lines.push(`  ✗ ${id}（未加载——前置缺失！）`);
        } else {
          lines.push(`  ✓ ${id}（${state.enabled ? "已启用" : "已加载但关闭"}）`);
        }
      }
      lines.push("");

      lines.push("[Kaz 工具面]（toolWhitelist 白名单是唯一闸门；记忆/诊断工具按 agent 会话过滤）");
      const whitelist = kazToolWhitelist();
      lines.push(`  手动白名单 toolWhitelist（Kaz 全部工具的唯一闸门，settings.yaml 的 kaz-mode.toolWhitelist，Kaz 面板可编辑）: [${whitelist.join(", ")}]`);

      let firstRoundTools = [];
      try {
        const rm = ctx.get("roundMinimal");
        if (rm !== undefined && rm !== null && typeof rm.firstRoundTools === "function") {
          const tools = rm.firstRoundTools().filter((t) => typeof t === "string" && t.length > 0);
          if (tools.length > 0) firstRoundTools = tools;
        }
      } catch {
        // 保持空数组（computeSurface 按 kaz-memory 自动解析）
      }
      const kazMemoryState = readPluginState("kaz-memory");
      const kazMemoryEnabled = kazMemoryState !== null && typeof kazMemoryState === "object" && kazMemoryState.enabled === true;
      const fallbackSurface = computeSurface({ toolWhitelist: whitelist, minimalPhase: isMinimalAgent(agent), firstRoundTools, kazMemoryEnabled });
      let sessionSurface = null;
      if (kazModeSvc !== null && kazEnabled && typeof kazModeSvc.surfaceOf === "function") {
        try {
          sessionSurface = kazModeSvc.surfaceOf(agent);
        } catch {
          sessionSurface = null;
        }
      }
      const surface = sessionSurface !== null && sessionSurface !== undefined ? sessionSurface : fallbackSurface;
      const schemas = [];
      try {
        const toolsSvc = ctx.get("tools");
        if (toolsSvc !== undefined && toolsSvc !== null && typeof toolsSvc.schemas === "function") {
          schemas.push(...(toolsSvc.schemas(agent) ?? []));
        }
      } catch {
        // 保持空
      }
      const registered = new Set(schemas.map((schema) => schema?.name).filter((n) => typeof n === "string"));
      if (kazEnabled) {
        const surfaceNames = [...surface].sort();
        const mounted = surfaceNames.filter((name) => registered.has(name));
        const unmounted = surfaceNames.filter((name) => !registered.has(name));
        lines.push(
          `  当前工具面（定义 ${surfaceNames.length} 个，实际已注册 ${mounted.length} 个）: ${mounted.join(", ") || "（无）"}`,
        );
        if (unmounted.length > 0) {
          lines.push(`  定义中但未挂载（不计入实际工具面）: ${unmounted.join(", ")}`);
        }
      } else {
        const mem =
          kazModeSvc !== null && typeof kazModeSvc.pluginEnabled === "function"
            ? kazModeSvc.pluginEnabled(agent, "kaz-memory")
            : readPluginState("kaz-memory")?.enabled !== false;
        const diag =
          kazModeSvc !== null && typeof kazModeSvc.pluginEnabled === "function"
            ? kazModeSvc.pluginEnabled(agent, "kaz-diag")
            : readPluginState("kaz-diag")?.enabled !== false;
        lines.push(
          `  当前为 非 Kaz 会话：工具面由标准模式决定；本会话 kaz-memory=${mem ? "启用" : "关闭"}（记忆工具${mem ? "可见" : "已过滤"}）、` +
            `kaz-diag=${diag ? "启用" : "关闭"}（kaz_mode_status${diag ? "可见" : "已过滤"}）。`,
        );
      }
      lines.push("  子代理会话: 同样按各自会话判定工具面（host 平面监听器对所有 agent 生效）");
      lines.push("");

      lines.push("[round-minimal 信号]（首次工具调用前 = 首阶段极简）");
      if (agent !== undefined) {
        lines.push(
          `  当前代理首阶段极简: ${isMinimalAgent(agent) ? "是（工具面 = round-minimal 首轮工具集；首次工具调用后恢复全部工具）" : "否（已恢复 Kaz 全部工具）"}`,
        );
      } else {
        lines.push("  （未绑定代理，无法判定当前阶段）");
      }
      lines.push("");
      return lines.join("\n");
    }

    /** kaz_mode_status 注册跟随 kaz-diag.enabled（2026-08-21 修复，恢复文档语义）：
     *  enabled=true 时注册，enabled=false 时完全注销（不只是移出 Kaz 工具面），
     *  热重载生效。会话级可见性仍由 kaz-mode 在组装/执行层按 agent 会话计算。 */
    let toolDisposer = null;
    function installTool() {
      if (toolDisposer !== null) return;
      try {
        toolDisposer = ctx.tools.register(
          defineTool({
            name: "kaz_mode_status",
            description:
              "只读报告 Kaz 模式当前状态：Kaz 模式开关、系统提示词（由 kaz-system-prompt.mjs 按条件控制）、被管理插件（thinking-anchor / round-minimal / plugin-filter / output-beep / round-display / deepseek-default-model / kaz-memory / kaz-diag）的启停、Kaz 工具面（toolWhitelist 白名单是唯一闸门）、round-minimal 首阶段信号。无需任何参数。",
            parameters: {},
            output: {
              schema: { type: "string" },
              render: (_args, value) => [{ type: "text", text: value }],
            },
            async execute(_args, exec) {
              return buildReport(exec?.agent);
            },
          }),
        );
      } catch (error) {
        ctx.logger.warn(`[kaz-diag] 注册状态工具失败：${safeMessage(error)}`);
        toolDisposer = null;
      }
    }
    function uninstallTool() {
      if (toolDisposer === null) return;
      try {
        toolDisposer();
      } catch (error) {
        ctx.logger.warn(`[kaz-diag] 注销状态工具失败：${safeMessage(error)}`);
      }
      toolDisposer = null;
    }
    function handleChange() {
      const enabled = source().enabled !== false;
      if (enabled) installTool();
      else uninstallTool();
      ctx.logger.info(
        `[kaz-diag] 配置已生效：enabled=${enabled ? "true" : "false"}` +
          `（kaz_mode_status 已${enabled ? "注册" : "完全注销"}；会话级可见性由 kaz-mode 按 agent 会话过滤）`,
      );
    }

    ctx.effect(() => () => {
      uninstallTool();
    });
  },
};
