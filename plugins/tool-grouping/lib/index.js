// tool-grouping
// ===========================================================================
// 在 dsh 的 tools 注册表之上建立"工具分组 / 运行环境(realm)"运行时视图：
//
//   1) 尽早生效：给真实的 ToolRuntime 实例的 register 打补丁，在每个工具
//      注册时立即记录其归属；对注册早于本插件的工具，按"全局视图 + 每个
//      scope 层（agent preset 挂载等）"全量扫描补记，并监听 tools/change 与
//      loader/entry-init 追记——分组在工具初始化之前或同时完成，任意时刻
//      查询都能拿到完整的分组视图（含插件热挂载到已有会话之后）。
//   2) 默认分组（内置，可配置）：
//        - tool-fs 组（realm: minimal-local-fs）：
//            read / write / edit / glob / grep
//            （str_replace_editor 已移出本组，留在默认组——Kaczev 2026-08-16）
//        - workflowEngine 组（realm: workflowEngine）：
//            workflow / ralph（与 workflow-worker-thread 工作引擎同组）
//        - kaz-memory 组（realm: kazMemory）：
//            memory_save / memory_list / memory_search / memory_forget
//      其余工具保持在默认组（未分组），不受本插件影响。
//   3) 分组是"非破坏性"的：默认模式(tag)完全不介入调用链——同组工具之间、
//      跨组工具之间的调用都遵循 dsh 默认规则；可选 trace 模式只在调用时
//      记录工具及其归属（debug 级日志），仍然不阻断任何调用。
//   4) 提供只读状态工具 tool_grouping_status 与加载日志报告，用于验证分组；
//      enabled=false 时整个插件（补丁、监听、状态工具）全部停用。
//   5) 把运行时分组结果发布为 toolGrouping 服务（enabled/groups/groupOf/
//      isRegistered），供 kaz-mode 等插件消费——分组事实的唯一权威来源
//      是本插件的运行时视图，消费方不需要内置任何工具列表。
//
// 设计说明：dsh 的 tools 注册表本身没有"工具 realm"这一原生概念——realm
// （cordis 组合层的 isolate）是"服务实例"的隔离域，而工具只是注册进分层
// 注册表（全局层 + 各 scope 层）的定义。因此本插件把"组 / realm"实现为
// 运行时分组模型（工具名 → 组），同时会在报告中校验组合层的真实 realm
// 情况（如 workflowEngine 服务是否由 agent preset 的 isolate realm 提供、
// 相关组合行的挂载/禁用状态），供"权限隔离与资源管理"决策参考。若需要
// 进程级的硬隔离，请按 README 的"组合层加固"一节把工具插件行移入带
// isolate 的组合组。
// ===========================================================================

import z from "@deepseek-ai/schemastery";
import { symbols } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";

/** 设置命名空间：~/.dsh/settings.yaml 中的 tool-grouping: 段。 */
const NAMESPACE = settingsNamespace("tool-grouping");

/** 默认分组：tool-fs 组 + workflowEngine 组（与需求一致）。 */
const DEFAULT_GROUPS = [
  {
    id: "tool-fs",
    realm: "minimal-local-fs",
    tools: ["read", "write", "edit", "glob", "grep"],
  },
  {
    id: "workflowEngine",
    realm: "workflowEngine",
    tools: ["workflow", "ralph"],
  },
  {
    id: "kaz-memory",
    realm: "kazMemory",
    tools: ["memory_save", "memory_list", "memory_search", "memory_forget"],
  },
];

/** 设置 schema（同时驱动设置页 UI）。 */
const SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(true),
  registerStatusTool: z.boolean().default(true),
  mode: z.union([z.const("tag"), z.const("trace")]).default("tag"),
  groups: z
    .array(
      z.object({
        id: z.string(),
        realm: z.string(),
        tools: z.array(z.string()),
      }),
    )
    .default([...DEFAULT_GROUPS]),
});

/** 归一化单个组定义；非法条目返回 undefined。 */
function normalizeGroup(raw) {
  if (raw === null || typeof raw !== "object") return undefined;
  const id = typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id.trim() : undefined;
  if (id === undefined) return undefined;
  const realm = typeof raw.realm === "string" && raw.realm.trim().length > 0 ? raw.realm.trim() : id;
  const tools = Array.isArray(raw.tools)
    ? raw.tools.filter((tool) => typeof tool === "string" && tool.trim().length > 0).map((tool) => tool.trim())
    : [];
  if (tools.length === 0) return undefined;
  return { id, realm, tools };
}

/** 归一化任意来源（组合行 config / settings 解析值）的配置。 */
function normalizeConfig(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const seen = new Set();
  const groups = [];
  const rawGroups = Array.isArray(value.groups) ? value.groups : DEFAULT_GROUPS;
  for (const group of rawGroups) {
    const normalized = normalizeGroup(group);
    if (normalized === undefined || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    groups.push(normalized);
  }
  return {
    enabled: value.enabled !== false,
    registerStatusTool: value.registerStatusTool !== false,
    mode: value.mode === "trace" ? "trace" : "tag",
    groups,
  };
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
  name: "tool-grouping",
  // 尽早拿到 tools 服务：注册补丁、扫描、状态工具都挂在它的链路上。
  inject: ["tools"],
  apply(ctx, config = {}) {
    // 组合行 config 作为 base 层；settings.yaml 用户层优先（热重载）。
    // 注意：installSettingsSection 的 ctx.inject 回调可能同步触发（其 onChange
    // 会调用 sync()），所以 settings 注册必须放在所有变量与函数定义之后，
    // 避免 TDZ（Cannot access ... before initialization）。
    const entry = normalizeConfig(config);
    let source = () => entry;

    // 拿到真实的 ToolRuntime 实例（context 代理经 symbols.original 暴露）。
    // 任何上下文的 ctx.tools.register(...) 都会经过这里；补丁在插件卸载
    // （HMR/重启）时恢复。
    const raw = ctx.tools[symbols.original] ?? ctx.tools;
    const originalRegister = raw.register;

    /** 工具名 → 提供该工具的插件名（本插件观察到的注册记录）。 */
    const registered = new Map();
    /** 工具名 → { groupId, realm }（纯配置派生的分组索引）。 */
    const groupIndex = new Map();
    let statusDisposer = null;
    let patchInstalled = false;

    /** 依据当前配置重建分组索引（幂等）。 */
    function recomputeGroupIndex() {
      groupIndex.clear();
      const current = source();
      for (const group of current.groups) {
        for (const name of group.tools) {
          groupIndex.set(name, { groupId: group.id, realm: group.realm });
        }
      }
    }

    /** 记录一次工具注册（含调用方插件名，取自 Cordis 追踪代理注入的 ctx）。 */
    function recordRegistration(definition) {
      if (source().enabled !== true) return;
      if (definition === null || typeof definition !== "object") return;
      const name = definition.name;
      if (typeof name !== "string" || name.length === 0) return;
      registered.set(name, registered.get(name));
    }

    /** 注册补丁：先走原注册逻辑，成功后记录归属。 */
    const registerWrapper = function register(definition) {
      const result = originalRegister.call(this, definition);
      const callerCtx = this && typeof this === "object" ? this.ctx : undefined;
      const pluginName =
        callerCtx && typeof callerCtx === "object" && callerCtx.fiber ? callerCtx.fiber.name : undefined;
      if (source().enabled === true && definition !== null && typeof definition === "object") {
        const name = definition.name;
        if (typeof name === "string" && name.length > 0) {
          registered.set(name, typeof pluginName === "string" ? pluginName : undefined);
        }
      }
      return result;
    };

    function installPatch() {
      if (patchInstalled) return;
      raw.register = registerWrapper;
      patchInstalled = true;
    }

    function uninstallPatch() {
      if (!patchInstalled) return;
      if (raw.register === registerWrapper) raw.register = originalRegister;
      patchInstalled = false;
    }

    /**
     * 全量扫描补记：把"全局视图 + 每个 scope 层"中已注册的工具名补进
     * registered。scope 层（agent preset 挂载等）注册的工具在全局视图不可
     * 见，但它们的 layer 键都挂在 raw.layers.scoped 上，逐个 scope 扫描即可
     * 覆盖。注册补丁负责"此刻之后"的注册，扫描负责"此前"的存量——两者
     * 合起来，任意时刻（含插件热挂载到已有会话之后）都能拿到完整视图。
     */
    function collectNames(scope) {
      const names = [];
      for (const schema of raw.schemas(scope)) {
        if (schema !== null && typeof schema === "object" && typeof schema.name === "string") {
          names.push(schema.name);
        }
      }
      return names;
    }

    const sweep = () => {
      if (source().enabled !== true) return;
      try {
        for (const name of collectNames(undefined)) registered.set(name, registered.get(name));
      } catch (error) {
        ctx.logger.warn(`[tool-grouping] 扫描全局工具失败：${safeMessage(error)}`);
      }
      try {
        const keys = raw.layers?.scoped?.keys?.();
        if (keys !== undefined) {
          for (const key of keys) {
            try {
              for (const name of collectNames(key)) registered.set(name, registered.get(name));
            } catch {
              // 单个 scope 的视图扫描失败不影响整体
            }
          }
        }
      } catch (error) {
        // 兜底：更旧/不同的 dsh-tools 版本没有 layers 字段时，按 agent 列表扫描。
        try {
          const agents = ctx.get("agents");
          if (agents !== undefined && typeof agents.list === "function") {
            for (const agent of agents.list()) {
              if (agent === null || typeof agent !== "object") continue;
              try {
                for (const name of collectNames(agent)) registered.set(name, registered.get(name));
              } catch {
                // 单个 agent 的视图扫描失败不影响整体
              }
            }
          }
        } catch (error2) {
          ctx.logger.warn(`[tool-grouping] 扫描 scope 层工具失败：${safeMessage(error2)}`);
        }
      }
    };

    /** 组合层事实：workflowEngine 服务可见性 + 相关组合行的挂载状态 + realm 组结构。 */
    function compositionFacts() {
      const facts = [];
      let engine;
      try {
        engine = ctx.get("workflowEngine");
      } catch {
        engine = undefined;
      }
      facts.push(
        engine !== undefined
          ? "workflowEngine 服务: 宿主平面可见（组合层未隔离该服务，或当前为 TUI/单会话模式）"
          : "workflowEngine 服务: 宿主平面不可见（由 agent preset 在 isolate realm 中提供，与默认环境隔离 ✓）",
      );

      const loader = ctx.get("loader");
      if (loader !== undefined && typeof loader.entries === "function") {
        try {
          const interest = new Set([
            "tool-fs",
            "tool-fs-search",
            "tool-str-replace-editor",
            "tool-workflow",
            "tool-ralph",
            "workflow-worker-thread",
            "memory",
          ]);
          const groupRows = [];
          for (const entry of loader.entries()) {
            const options = entry?.options;
            if (options === undefined || options === null || typeof options !== "object") continue;
            if (options.group === true) {
              groupRows.push(entry);
              continue;
            }
            if (!interest.has(options.id)) continue;
            let groupId;
            try {
              groupId = entry?.parent?.tree?.ctx?.fiber?.entry?.options?.id;
            } catch {
              groupId = undefined;
            }
            facts.push(
              `组合行 ${options.id} (${options.name}): ${entry.disabled ? "disabled" : "active"}, 所属组: ${groupId ?? "(无)"}`,
            );
          }
          for (const entry of groupRows) {
            const options = entry?.options;
            const isolate = options?.isolate && typeof options.isolate === "object" ? options.isolate : undefined;
            const realms = isolate !== undefined ? Object.keys(isolate) : [];
            facts.push(
              `组合组 ${options?.id ?? "(未知)"}: ${realms.length > 0 ? `isolate realm = {${realms.join(", ")}}` : "无 isolate realm"}`,
            );
          }
        } catch (error) {
          facts.push(`组合行扫描失败: ${safeMessage(error)}`);
        }
      }
      return facts;
    }

    /** 生成完整的分组报告（日志与状态工具共用）。 */
    function buildReport() {
      const current = source();
      const lines = [];
      lines.push("tool-grouping 分组状态报告");
      lines.push("==================================================");
      lines.push(
        `配置: enabled=${current.enabled}, mode=${current.mode}, registerStatusTool=${current.registerStatusTool}`,
      );
      if (current.enabled !== true) {
        lines.push("");
        lines.push("插件已禁用（enabled=false），未执行任何分组。");
        return lines.join("\n");
      }
      recomputeGroupIndex();
      lines.push(`分组数: ${current.groups.length}`);
      lines.push("");
      for (const group of current.groups) {
        lines.push(`[组] ${group.id}  (realm: ${group.realm})`);
        for (const name of group.tools) {
          // 存在性用 has() 判断：扫描补记的工具其"插件名"值为 undefined，
          // get() 会把它与"未注册"混淆。
          if (!registered.has(name)) {
            lines.push(`  ✗ ${name}  （未注册：当前组合未挂载该工具）`);
            continue;
          }
          const pluginName = registered.get(name);
          lines.push(
            `  ✓ ${name}  （已注册${typeof pluginName === "string" ? `，由 ${pluginName} 提供` : ""}）`,
          );
        }
        lines.push("");
      }
      const grouped = new Set();
      for (const group of current.groups) {
        for (const name of group.tools) grouped.add(name);
      }
      const defaults = [...registered.keys()].filter((name) => !grouped.has(name)).sort();
      lines.push(`[默认组] 未分组工具（${defaults.length} 个）: ${defaults.join(", ") || "(无)"}`);
      lines.push("");
      lines.push("组合层事实:");
      for (const fact of compositionFacts()) lines.push(`  • ${fact}`);
      return lines.join("\n");
    }

    // -----------------------------------------------------------------------
    // 对外服务 toolGrouping：把本插件的运行时分组结果发布出去（如 kaz-mode
    // 消费）。消费方只读这里的视图，不内置任何工具列表；enabled=false 时
    // enabled() 返回 false、groupOf() 返回 null，表示当前没有分组。
    // -----------------------------------------------------------------------
    const toolGroupingService = {
      version: 1,
      enabled: () => source().enabled === true,
      groups: () => {
        recomputeGroupIndex();
        const current = source();
        return current.groups.map((group) => ({
          id: group.id,
          realm: group.realm,
          tools: [...group.tools],
        }));
      },
      groupOf: (name) => {
        if (source().enabled !== true) return null;
        recomputeGroupIndex();
        const hit = groupIndex.get(name);
        return hit === undefined ? null : { groupId: hit.groupId, realm: hit.realm };
      },
      isRegistered: (name) => registered.has(name),
    };

    ctx.effect(() => {
      const disposeService = ctx.provide("toolGrouping", toolGroupingService);
      return () => {
        if (typeof disposeService === "function") disposeService();
      };
    }, "tool-grouping: 对外发布 toolGrouping 分组服务");

    /** 注册只读状态工具（enabled 且 registerStatusTool=true 时）。 */
    function installStatusTool() {
      if (statusDisposer !== null) return;
      const current = source();
      if (current.enabled !== true || current.registerStatusTool !== true) return;
      try {
        statusDisposer = ctx.tools.register(
          defineTool({
            name: "tool_grouping_status",
            description:
              "只读报告 tool-grouping 插件当前的分组状态：各工具被分配到哪个组 / realm（tool-fs、workflowEngine、kaz-memory、默认组），以及组合层事实（workflowEngine 服务可见性、相关组合行挂载状态）。无需任何参数。",
            parameters: {},
            output: {
              schema: { type: "string" },
              render: (_args, value) => [{ type: "text", text: value }],
            },
            async execute() {
              return buildReport();
            },
          }),
        );
      } catch (error) {
        ctx.logger.warn(`[tool-grouping] 注册状态工具失败：${safeMessage(error)}`);
        statusDisposer = null;
      }
    }

    function uninstallStatusTool() {
      if (statusDisposer === null) return;
      try {
        statusDisposer();
      } catch (error) {
        ctx.logger.warn(`[tool-grouping] 注销状态工具失败：${safeMessage(error)}`);
      }
      statusDisposer = null;
    }

    /** 按当前配置同步插件状态（补丁 / 扫描 / 状态工具 / 报告）。 */
    function sync() {
      const current = source();
      if (current.enabled === true) {
        installPatch();
        sweep();
        recomputeGroupIndex();
        installStatusTool();
      } else {
        uninstallPatch();
        uninstallStatusTool();
      }
      if (current.enabled === true) {
        ctx.logger.info(`[tool-grouping] 已加载并完成分组：\n${buildReport()}`);
      } else {
        ctx.logger.info("[tool-grouping] 已禁用（enabled=false），未执行任何分组。");
      }
    }

    // settings 注册放到所有变量/函数定义之后：ctx.inject 可能同步回调，
    // 其 onChange 会调用 sync()，必须保证闭包变量已初始化（避免 TDZ）。
    // 注意：setSource 收到的是一个 thunk（`() => scope.get()`），不是当前值。
    // 必须包一层：每次 source() 时先调用 thunk 取到最新值再 normalize，
    // 否则把函数对象当值处理会退化成默认配置、settings 永远不生效。
    installSettingsSection(ctx, NAMESPACE, SETTINGS_SCHEMA, entry, {
      setSource: (getValue) => {
        source = () => normalizeConfig(getValue());
      },
      onChange: () => sync(),
    });

    sync();

    // 卸载时恢复补丁并注销状态工具（HMR / 重启 / 卸载插件）。
    ctx.effect(() => () => {
      uninstallPatch();
      uninstallStatusTool();
    });

    // 追记：注册表变化（含 scope 层注册/注销）与 loader 条目初始化后补扫。
    ctx.on("tools/change", () => {
      sweep();
    });
    ctx.on("loader/entry-init", () => {
      sweep();
    });
    queueMicrotask(sweep);
    setTimeout(sweep, 0);

    // -----------------------------------------------------------------------
    // 可选 trace 模式：只记录、不阻断。默认模式(tag)完全不介入调用链。
    // -----------------------------------------------------------------------
    ctx.on("tools/pre-execute", function (exec, next) {
      const current = source();
      if (current.enabled === true && current.mode === "trace") {
        const name = exec !== null && typeof exec === "object" ? exec.name : undefined;
        if (typeof name === "string") {
          const group = groupIndex.get(name);
          const nested = exec !== null && typeof exec === "object" && exec.parent !== undefined;
          ctx.logger.debug(
            `[tool-grouping] trace: 调用工具 "${name}"（${
              group !== undefined ? `组 ${group.groupId} / realm ${group.realm}` : "默认组（未分组）"
            }${nested ? "，嵌套子调度" : ""}）`,
          );
        }
      }
      return next();
    });
  },
};
