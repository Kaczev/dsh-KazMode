// create-plan —— create_plan 工具：plan 模式的 realm 内桥
// ===========================================================================
// 挂载位置：Kaz 预设 kaz/agent.cordis.yml 的 planning isolate 组内，因此可以
// 直接解析到 planMode 服务（与 exit_plan_mode 同一个 realm）。
//
// 可见性：
//   - create_plan 不在默认白名单，模型工具面默认看不到它。
//   - ka-whale-workflow 的 whale_report 在分类时通过 tools.get("create_plan")
//     拿到本工具定义并直接执行，从而在 planMode 的 realm 内完成进入/退出；
//     这样 whale_report 自身不需要出现在 planning isolate 里。
//   - create-plan 组件在 Kaz 面板关闭时，create_plan 会拒绝执行（纵深防御）。
// ===========================================================================

import { defineTool } from "@deepseek-ai/dsh-tools";

export const CREATE_PLAN_TOOL = "create_plan";

export default {
  name: "create-plan",
  inject: ["tools"],
  apply(ctx, _config = {}) {
    const createPlanDef = defineTool({
      name: CREATE_PLAN_TOOL,
      description:
        "Enter plan mode (default) or leave plan mode for this session. Used by the whale workflow to launch plan mode after task classification, and to exit plan mode when the workflow restarts; can also be called directly whenever plan mode control is needed.",
      parameters: {
        active: {
          type: "boolean",
          description: "Optional (default true): true = enter plan mode, false = leave plan mode.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            outcome: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      execute(_args, exec) {
        const agent = exec?.agent;
        if (agent === null || agent === undefined || typeof agent !== "object") {
          return Promise.reject(new Error("create_plan requires a calling agent"));
        }
        // 组件关闭时拒绝（kaz-mode 表面已隐藏，这里是纵深防御）。
        try {
          const kazMode = ctx.get("kazMode");
          if (
            kazMode !== undefined &&
            kazMode !== null &&
            typeof kazMode.pluginEnabled === "function" &&
            kazMode.pluginEnabled(agent, "create-plan") !== true
          ) {
            return Promise.reject(new Error("create_plan is unavailable: create-plan component is disabled"));
          }
        } catch (error) {
          // 服务异常时不阻断，交给 planMode 兜底
          ctx.logger?.debug?.(`[create-plan] kazMode 检查失败：${error instanceof Error ? error.message : String(error)}`);
        }
        const planMode = ctx.get("planMode");
        if (planMode === undefined || planMode === null || typeof planMode.set !== "function") {
          return Promise.reject(new Error("planMode service is unavailable; cannot control plan mode"));
        }
        const active = args?.active !== false;
        let outcome;
        try {
          outcome = planMode.set(agent, active);
        } catch (error) {
          return Promise.reject(new Error("failed to set plan mode: " + (error instanceof Error ? error.message : String(error))));
        }
        return Promise.resolve({ ok: true, outcome });
      },
      presentCall: () => ({ card: "generic", title: "设置 plan 模式", kind: "other" }),
    });

    let disposed = false;
    const dispose = ctx.tools.register(createPlanDef);
    ctx.effect(() => () => {
      if (disposed) return;
      disposed = true;
      try {
        dispose();
      } catch (error) {
        ctx.logger?.warn?.(`[create-plan] 注销 ${CREATE_PLAN_TOOL} 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    });
  },
};
