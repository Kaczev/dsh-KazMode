// tool-filter
// ===========================================================================
// 在 dsh 的工具"注册 → 组装 → 执行"三条链路上过滤指定工具，阻止它们被加载
// 或使用：
//
//   模式 remove（默认，不添加）：分两层生效——
//     a) 插件级：直接禁用命中"插件名"的 loader 条目（如 tool-subagent-report），
//        该插件本体不再加载（工具、提示段、提供者全部消失），dsh 插件列表
//        显示"已停用"；
//     b) 工具级：工具定义在注册时直接被丢弃（返回空 disposer）；即使目标工具
//        先于本插件被注册（例如来自 bundle 层的工具插件），"组装"与"查询"
//        两个兜底层也会把它彻底藏起来：
//        - system-prompt/assemble：从模型可见的工具列表与 tool:* 指导段中移除；
//        - tools.get / tools.schemas：任何查询都返回"不存在"，
//          执行器因此以 UNKNOWN_TOOL 拒绝调用。
//   模式 disable（禁用）：工具正常注册、保留在列表中（插件也不停用），但
//     tools/pre-execute 拦截所有对它们的调用并返回明确的拒绝原因——dsh 永远
//     不会真正执行它们。
//
// 配置（热重载，写入 ~/.dsh/settings.yaml 的 tool-filter: 命名空间即可，无需
// 重启；组合行 cordis.patch.yml 的 config 作为 base 层，用户设置优先）：
//   enabled       是否启用过滤，默认 true
//   mode          "remove" | "disable"，默认 "remove"
//   disabledTools 额外禁用的工具/插件名列表，默认：
//                 ["tool-cordis", "tool-subagent-report", "codex", "claude-code"]
//
// 匹配规则（对 disabledTools 中的每个条目，全部大小写不敏感）：
//   1. 工具名完全一致（如 codex、claude-code）；
//   2. 注册该工具的插件名完全一致（如 tool-cordis，或带 dsh- 前缀的
//      dsh-tool-cordis）；插件名取自 Cordis 运行时 fiber.name，即工具插件
//      模块导出的 name 字段；
//   3. 归一化后一致（忽略所有非字母数字字符，如 claude_code 匹配 claude-code）；
//   4. 以 tool- 开头的条目，其最后一个 "-" 分段与工具名一致（例如
//      tool-subagent-report 也会禁用字面名为 report 的工具——该工具在子代理
//      作用域异步注册，无法用插件名归属，靠这条规则命中）。
//   另外，模式 A 的"插件级禁用"按 loader 条目的 id/name 精确、归一化或
//   包含匹配（如 dsh-tool-cordis 命中 name 为 @deepseek-ai/dsh-tool-cordis
//   的条目）；不使用规则 4 的末段匹配，避免误伤 cordis-host-runner 这类名字
//   里带 cordis 的 dsh 基础设施插件。
// ===========================================================================

import z from "@deepseek-ai/schemastery";
import { symbols } from "@deepseek-ai/cordis";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";

/** 默认禁用的工具/插件名。 */
const DEFAULT_DISABLED_TOOLS = ["tool-cordis", "tool-subagent-report", "codex", "claude-code"];

/** 设置命名空间：~/.dsh/settings.yaml 中的 tool-filter: 段。 */
const NAMESPACE = settingsNamespace("tool-filter");

/** 设置 schema（同时驱动设置页 UI）。 */
const SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(true),
  mode: z.union([z.const("remove"), z.const("disable")]).default("remove"),
  disabledTools: z.array(z.string()).default([...DEFAULT_DISABLED_TOOLS]),
});

/** 归一化任意来源（组合行 config / settings 解析值）的配置。 */
function normalizeConfig(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const tools = Array.isArray(value.disabledTools)
    ? value.disabledTools.filter((t) => typeof t === "string" && t.length > 0)
    : [...DEFAULT_DISABLED_TOOLS];
  return {
    enabled: value.enabled !== false,
    mode: value.mode === "disable" ? "disable" : "remove",
    disabledTools: tools,
  };
}

/** 归一化：小写并去掉所有非字母数字字符。 */
function normalizeName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** 取条目最后一个 "-"/"_"/"/" 分段（用于 tool- 前缀条目的工具名匹配）。 */
function lastToken(value) {
  const parts = String(value ?? "")
    .toLowerCase()
    .split(/[-_/]+/)
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

/** 单个条目与"工具名 + 注册插件名"的匹配。 */
function matchesEntry(toolName, pluginName, entry) {
  const name = String(toolName ?? "").toLowerCase();
  const plugin = String(pluginName ?? "").toLowerCase();
  const candidate = String(entry ?? "").toLowerCase();
  if (candidate.length === 0) return false;
  // 规则 1：工具名完全一致
  if (name === candidate) return true;
  // 规则 2：插件名完全一致（容忍一侧的 dsh- 前缀差异）
  if (plugin === candidate) return true;
  if (plugin !== "" && (plugin === candidate.replace(/^dsh-/, "") || plugin.replace(/^dsh-/, "") === candidate)) return true;
  // 规则 3：归一化后一致
  const normalizedCandidate = normalizeName(candidate);
  if (normalizeName(name) === normalizedCandidate) return true;
  if (plugin !== "" && normalizeName(plugin) === normalizedCandidate) return true;
  // 规则 4：tool- 前缀条目的最后分段与工具名一致
  if (candidate.startsWith("tool-") && name === lastToken(candidate)) return true;
  return false;
}

/** 判断某个工具是否被当前配置命中；返回命中的条目名，未命中返回 undefined。 */
function isBlocked(config, toolName, pluginName) {
  if (config.enabled !== true) return undefined;
  for (const entry of config.disabledTools) {
    if (matchesEntry(toolName, pluginName, entry)) return entry;
  }
  return undefined;
}

/**
 * 插件级条目匹配（模式 A 禁用 loader 条目用）：按条目的 id / name 与名单条目
 * 做精确、归一化或包含匹配。不做规则 4 的末段匹配——那是给工具名的，
 * 避免误伤 cordis-host-runner 这类名字里含 cordis 的 dsh 基础设施插件。
 */
function matchesPluginEntry(entryId, entryName, entry) {
  const id = String(entryId ?? "").toLowerCase();
  const name = String(entryName ?? "").toLowerCase();
  const candidate = String(entry ?? "").toLowerCase();
  if (candidate.length === 0) return false;
  if (id === candidate || name === candidate) return true;
  const normalizedCandidate = normalizeName(candidate);
  if (normalizedCandidate.length === 0) return false;
  if (normalizeName(id) === normalizedCandidate) return true;
  const normalizedName = normalizeName(name);
  // 包含匹配：@deepseek-ai/dsh-tool-cordis 归一化后包含 dsh-tool-cordis 等。
  if (normalizedName === normalizedCandidate || normalizedName.includes(normalizedCandidate)) return true;
  return false;
}

/** 判断某个 loader 条目（插件）是否被当前配置命中；返回命中的条目名。 */
function isBlockedPlugin(config, entryId, entryName) {
  if (config.enabled !== true) return undefined;
  for (const entry of config.disabledTools) {
    if (matchesPluginEntry(entryId, entryName, entry)) return entry;
  }
  return undefined;
}

export default {
  name: "tool-filter",
  // 尽早拿到 tools 与 systemPrompt 服务：注册拦截、查询兜底、
  // 组装过滤、执行拒绝都挂在这两个服务的链路上。
  inject: ["tools", "systemPrompt"],
  apply(ctx, config = {}) {
    // 组合行 config 作为 base 层；settings.yaml 用户层优先（热重载）。
    const entry = normalizeConfig(config);
    let source = () => entry;
    installSettingsSection(ctx, NAMESPACE, SETTINGS_SCHEMA, entry, {
      // 注意：setSource 收到的是一个 thunk（`() => scope.get()`），不是当前值。
      // 必须包一层：每次 source() 时先调用 thunk 取到最新值再 normalize，
      // 否则把函数对象当值处理会退化成默认配置、settings 永远不生效。
      setSource: (getValue) => {
        source = () => normalizeConfig(getValue());
      },
      onChange: () => {},
    });

    const initial = source();
    ctx.logger.info(
      `[tool-filter] 已加载：enabled=${initial.enabled}, mode=${initial.mode}, ` +
        `disabledTools=[${initial.disabledTools.join(", ")}]`,
    );

    // -----------------------------------------------------------------------
    // 模式 remove：插件级禁用 —— 直接禁用命中的 loader 条目（如
    // tool-subagent-report），让插件本体不再加载、dsh 插件列表显示"已停用"。
    // 启动时条目是并发初始化的，可能先于本插件跑完，所以：
    //   1) apply 时立即扫一遍（覆盖已启动的条目 → 走 loader 自己的禁用/卸载路径）；
    //   2) 微任务/宏任务各补扫一次（覆盖仍在初始化中的条目）；
    //   3) 监听 loader/entry-init（之后新增的条目，如配置热更新）；
    //   4) 兜底 internal/plugin：若禁用标志落定前插件 fiber 已被创建（并发
    //      竞态），直接销毁该 fiber。
    // -----------------------------------------------------------------------
    const loader = ctx.get("loader");
    if (loader !== undefined && typeof loader.entries === "function") {
      const sweep = () => {
        const current = source();
        if (current.mode !== "remove" || current.enabled !== true) return;
        for (const item of loader.entries()) {
          const options = item?.options;
          if (options === undefined || options === null || typeof options !== "object") continue;
          if (item.disabled) continue;
          // 自保护：绝不禁用本插件自己的条目。
          if (options.id === "tool-filter" || options.name === "tool-filter") continue;
          const hit = isBlockedPlugin(current, options.id, options.name);
          if (hit === undefined) continue;
          ctx.logger.info(
            `[tool-filter] mode=remove：禁用插件条目 "${options.id ?? options.name}"（命中 "${hit}"）`,
          );
          Promise.resolve(item.update({ disabled: true })).catch((error) => {
            ctx.logger.warn(
              `[tool-filter] 禁用插件条目 "${options.id ?? options.name}" 失败：` +
                (error instanceof Error ? error.message : String(error)),
            );
          });
        }
      };
      sweep();
      queueMicrotask(sweep);
      setTimeout(sweep, 0);
      ctx.on("loader/entry-init", sweep);

      ctx.on("internal/plugin", (fiber) => {
        const options = fiber?.entry?.options;
        if (options === undefined || options === null || typeof options !== "object") return;
        // 自保护：绝不禁用本插件自己的 fiber。
        if (options.id === "tool-filter" || options.name === "tool-filter") return;
        const current = source();
        if (current.mode !== "remove" || current.enabled !== true) return;
        if (isBlockedPlugin(current, options.id, options.name) === undefined) return;
        if (!options.disabled) options.disabled = true;
        if (fiber.uid === null) return;
        ctx.logger.info(
          `[tool-filter] mode=remove：销毁匹配插件 "${options.id ?? options.name}" 的已创建 fiber`,
        );
        Promise.resolve(fiber.dispose?.()).catch((error) => {
          ctx.logger.warn(
            `[tool-filter] 销毁 fiber 失败：` +
              (error instanceof Error ? error.message : String(error)),
          );
        });
      });
    }

    // -----------------------------------------------------------------------
    // 拿到真实的 ToolRuntime 实例（context 代理经 symbols.original 暴露）。
    // 注册/查询补丁打在实例上，任何上下文的 ctx.tools.register(...) 都会
    // 经过这里；补丁在插件卸载（HMR/重启）时恢复。
    // -----------------------------------------------------------------------
    const raw = ctx.tools[symbols.original] ?? ctx.tools;
    const originalRegister = raw.register;
    const originalGet = raw.get;
    const originalSchemas = raw.schemas;

    /** 模式 remove：注册时直接丢弃被禁用的工具定义。 */
    const registerWrapper = function register(definition) {
      const current = source();
      if (current.mode === "remove") {
        // this.ctx 是 Cordis 追踪代理注入的"调用方上下文"，
        // this.ctx.fiber.name 即注册该工具的插件名（fiber.name）。
        const callerCtx = this && typeof this === "object" ? this.ctx : undefined;
        const pluginName = callerCtx && typeof callerCtx === "object" ? callerCtx.fiber?.name : undefined;
        const hit = isBlocked(current, definition?.name, pluginName);
        if (hit !== undefined) {
          ctx.logger.info(
            `[tool-filter] mode=remove：丢弃工具 "${definition?.name}"` +
              (pluginName ? `（插件 ${pluginName} 注册）` : "") +
              `，命中 disabledTools 条目 "${hit}"`,
          );
          // 返回空 disposer，假装注册成功——工具从未进入注册表。
          return () => {};
        }
      }
      return originalRegister.call(this, definition);
    };

    /** 模式 remove：get 查询兜底——已注册但被禁用的工具一律视为不存在。 */
    const getWrapper = function get(name, scope) {
      const current = source();
      if (current.mode === "remove" && isBlocked(current, name, undefined) !== undefined) {
        return undefined;
      }
      return originalGet.call(this, name, scope);
    };

    /** 模式 remove：schemas 查询兜底（覆盖 run_code 的 SDK 绑定等路径）。 */
    const schemasWrapper = function schemas(scope) {
      const result = originalSchemas.call(this, scope);
      const current = source();
      if (current.mode !== "remove") return result;
      return result.filter((tool) => tool && isBlocked(current, tool.name, undefined) === undefined);
    };

    raw.register = registerWrapper;
    raw.get = getWrapper;
    raw.schemas = schemasWrapper;

    // 卸载时恢复补丁（HMR / 重启 / 卸载插件）。
    ctx.effect(() => () => {
      if (raw.register === registerWrapper) raw.register = originalRegister;
      if (raw.get === getWrapper) raw.get = originalGet;
      if (raw.schemas === schemasWrapper) raw.schemas = originalSchemas;
    });

    // -----------------------------------------------------------------------
    // 组装层（模型可见的工具列表与 tool:* 指导段）——模式 remove 的最终闸门。
    // 该 waterfall 的返回值是权威的，host 平面的监听器对所有作用域生效。
    // -----------------------------------------------------------------------
    ctx.on("system-prompt/assemble", function (assembly, _context, next) {
      const current = source();
      if (current.mode === "remove" && current.enabled === true) {
        assembly.tools = assembly.tools.filter(
          (tool) => tool && isBlocked(current, tool.name, undefined) === undefined,
        );
        assembly.sections = assembly.sections.filter((section) => {
          if (typeof section?.name !== "string" || !section.name.startsWith("tool:")) return true;
          return isBlocked(current, section.name.slice("tool:".length), undefined) === undefined;
        });
      }
      return next();
    });

    // -----------------------------------------------------------------------
    // 执行层——模式 disable：工具保留在列表中，但一切调用在此被拒绝。
    // -----------------------------------------------------------------------
    ctx.on("tools/pre-execute", (exec, next) => {
      const current = source();
      if (current.mode === "disable" && current.enabled === true) {
        const hit = isBlocked(current, exec?.name, undefined);
        if (hit !== undefined) {
          ctx.logger.info(`[tool-filter] mode=disable：拒绝调用工具 "${exec?.name}"（命中 "${hit}"）`);
          return {
            kind: "deny",
            reason: `工具 "${exec?.name}" 已被 tool-filter 禁用（mode: disable，命中 disabledTools 条目 "${hit}"）。如确需使用，请在设置中调整 tool-filter 配置。`,
          };
        }
      }
      return next();
    });
  },
};
