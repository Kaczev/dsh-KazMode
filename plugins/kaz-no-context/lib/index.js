// kaz-no-context —— Kaz 预设专用「降噪」插件
// ===========================================================================
// 两个作用，都只在 Kaz 会话作用域内生效（宿主与其它预设不受影响）：
//   1) ctx.systemPrompt.suppressRuntimeContext()：抑制运行时上下文快照
//      （"Current runtime context. This snapshot supersedes ..." 段，含
//      sandbox / approval 策略注记）。快照为空后整段不再渲染。
//   2) agent/pre-step 水fall：剔除 tool-skill 注入的 skill-catalog 合成
//      消息（技能目录不再进入模型上下文）；skill 工具与技能加载能力不变，
//      用户点名某个技能时仍可通过 skill 工具加载其完整指令。
// ===========================================================================

export const name = "kaz-no-context";

export default {
  name: "kaz-no-context",
  inject: ["systemPrompt"],
  apply(ctx) {
    // 作用域级抑制器：只屏蔽本预设会话的动态上下文快照。
    ctx.systemPrompt.suppressRuntimeContext();

    // 剔除 skill-catalog 合成消息（保留 skill 工具本身）。
    ctx.on("agent/pre-step", async (payload, next) => {
      const decision = await next();
      if (decision === null || typeof decision !== "object") return decision;
      if (decision.kind === "reject") return decision;
      const messages = decision.messages;
      if (!Array.isArray(messages)) return decision;
      const filtered = messages.filter((message) => {
        const source = message !== null && typeof message === "object" ? message.source : undefined;
        return !(source !== null && typeof source === "object" && source.kind === "skill-catalog");
      });
      if (filtered.length === messages.length) return decision;
      return { ...decision, messages: filtered };
    });
  },
};
