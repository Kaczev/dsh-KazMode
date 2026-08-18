// code-collapse —— 工具塌缩为 run_code + 每次调用后追加 We need 提示
// ===========================================================================
// 启动后，每个会话的工具面被折叠成唯一入口 `run_code`（dsh 内置 Code Mode
// 呈现，`presentAs('code')`）：模型只直接调用 run_code，其它工具以生成的
// TS SDK 函数形式出现在 `tools:sdk` 提示段里（「附带给模型可以调用工具的
// 提示」）。折叠发生在注册表/提供器层面——所以本插件负责在会话开始时就对
// 该 agent 声明 code 呈现。Kaz 模式下与 round-minimal / kaz-mode 的联动：
// 首轮极简原本滤掉 run_code（导致 Code Mode 首轮工具面为空），现改为运行时
// 检测 Code Mode 呈现后放行 run_code（kaz-mode 还会补一段 round1-code-sdk
// 极简声明，告知模型本轮可用工具与绑定名）。
//
// 每次 run_code 调用完成后，经 `tools/post-execute` 的 additionalContexts 向
// 对话追加一条 We need 推理风格提醒（默认双语信封，settings.callHint 可配；
// appendCallHint 开关控制，Kaz 面板里有按钮）。这样在工具调用之后、下一条
// 用户消息之前，模型上下文里始终带着这条提醒，不会退回 Let me 思维链
// （thinking-anchor 的系统提示只在组装时出现，工具调用间的步骤没有）。
//
// settings 命名空间 `code-collapse`（~/.dsh/settings.yaml，热重载）：
//   enabled       总开关（默认 true；Kaz 模式联动启用/关闭）
//   appendCallHint 每次 run_code 后追加提示（默认 true）
//   callHint      追加提示文案（留空 = 内置默认）
//   firstRoundHint 首轮是否注入 run_code 使用提醒（默认 true）
//   firstRoundText 首轮提醒文案（[标题] / > / 内容 / <，We need 风格；留空 = 内置默认）
// Kaz 模式把它作为第 5 个被管理插件；独立使用时在 cordis.patch.yml 加行即可。
// ===========================================================================

import z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

export const name = "code-collapse";
/** systemPrompt：首轮注入 run_code 使用提醒。 */
export const inject = ["systemPrompt"];

const NAMESPACE = settingsNamespace("code-collapse");

/** 每次 run_code 调用后追加的默认提示（双语信封；settings.callHint 留空 = 本默认）。 */
/** 这里是为了引导模型使用We need，不使用格式 */
const DEFAULT_CALL_HINT = [
  "Let's keep using 'We need...' to continue.",
].join("\n");

/** 首轮注入的默认提醒（统一消息格式：[标题] / > / 内容 / <；We need 风格）。 */
/** 不过这里是为了引导模型使用We need，不使用格式 */
const DEFAULT_FIRST_ROUND_HINT = [
  "We need to make the most of run_code: a single run_code call can invoke multiple tools or run several operations at once.",
].join("\n");

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

const SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(true),
  appendCallHint: z.boolean().default(true),
  callHint: z.string().default(DEFAULT_CALL_HINT),
  firstRoundHint: z.boolean().default(true),
  firstRoundText: z.string().default(DEFAULT_FIRST_ROUND_HINT),
});

function safeMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function apply(ctx, config = {}) {
  const entry = {
    enabled: config.enabled !== false,
    appendCallHint: config.appendCallHint !== false,
    callHint: typeof config.callHint === "string" && config.callHint.length > 0 ? config.callHint : DEFAULT_CALL_HINT,
    firstRoundHint: config.firstRoundHint !== false,
    firstRoundText: typeof config.firstRoundText === "string" && config.firstRoundText.trim().length > 0 ? config.firstRoundText : DEFAULT_FIRST_ROUND_HINT,
  };
  let source = () => entry;

  // ---- 声明 Code Mode 呈现（presentAs('code')）----
  // 状态与函数必须在 installSettingsSection 之前定义：注册 settings 时会同步
  // 触发一次 onChange，此刻若引用未初始化的 `presented` 会踩 TDZ。
  /** agentId -> presentAs('code') 的 disposer（agent 销毁时作用域自动回收，这里只清引用）。 */
  const presented = new Map();

  function ensurePresented(agent) {
    if (agent === null || typeof agent !== "object") return;
    const id = agent.id;
    if (id === undefined) return;
    if (presented.has(id)) return;
    const current = source();
    if (current === null || typeof current !== "object" || current.enabled !== true) return;
    // liangshen（梁神模式）预设自带 tool-bootstrap 晋升 Code Mode（PTC），
    // 由它自己管理该 agent 作用域的呈现声明；code-collapse 不重复折叠，
    // 否则与 liangshen 的 presentAs('code') 触发 "one declaration per scope" 冲突。
    const preset = agent?.session?.header?.agentPreset;
    if (typeof preset === "string" && preset === "liangshen") {
      presented.set(id, () => {});
      ctx.logger.info(`[code-collapse] agent ${id} 为 liangshen 预设，跳过折叠声明（由 tool-bootstrap 管理）`);
      return;
    }
    const agentCtx = agent.ctx;
    if (agentCtx === undefined || agentCtx === null || typeof agentCtx?.tools?.presentAs !== "function") return;
    // 该 agent 作用域已有非 native 呈现（例如预设组合里声明过 Code Mode）时，
    // 不重复声明——presentAs 的契约是 "one declaration per scope"。
    try {
      const toolsSvc = agentCtx.tools;
      if (typeof toolsSvc?.modeFor === "function") {
        const existing = toolsSvc.modeFor(agent);
        if (existing !== undefined && existing !== "native") {
          presented.set(id, () => {});
          ctx.logger.info(`[code-collapse] agent ${id} 已有呈现模式 ${existing}，跳过折叠声明`);
          return;
        }
      }
    } catch (error) {
      ctx.logger.debug(`[code-collapse] 读取 agent ${id} 呈现模式失败（继续尝试声明）：${safeMessage(error)}`);
    }
    try {
      const dispose = agentCtx.tools.presentAs("code");
      presented.set(id, dispose);
      ctx.logger.info(`[code-collapse] 对 agent ${id} 声明 Code Mode 呈现（工具面折叠为 run_code）`);
    } catch (error) {
      // 冲突（另一组件已声明）等失败：标记已处理，避免每次 session-start 重试刷日志。
      presented.set(id, () => {});
      ctx.logger.warn(`[code-collapse] 对 agent ${id} 声明 Code Mode 呈现失败：${safeMessage(error)}`);
    }
  }

  function teardownAll() {
    for (const [id, dispose] of presented) {
      try {
        dispose?.();
      } catch (error) {
        ctx.logger.warn(`[code-collapse] 撤销 agent ${id} 的 Code Mode 呈现失败：${safeMessage(error)}`);
      }
    }
    presented.clear();
  }

  function ensureExistingAgents() {
    try {
      const agents = ctx.get("agents");
      const list = agents !== null && agents !== undefined && typeof agents.list === "function" ? agents.list() : [];
      for (const agent of list) ensurePresented(agent);
    } catch (error) {
      ctx.logger.warn(`[code-collapse] 枚举现有 agent 失败：${safeMessage(error)}`);
    }
  }

  /** 尝试把本插件给模型发送的信息上报给 round-display 显示插件（best-effort）。
   *  服务不存在时静默跳过，不影响主流程。 */
  function reportRoundDisplay(agent, content) {
    try {
      const rd = ctx.get("roundDisplay");
      if (rd !== undefined && rd !== null && typeof rd.report === "function" && typeof content === "string" && content.trim().length > 0) {
        rd.report({ agent, plugin: "code-collapse", title: "notice", content });
      }
    } catch (error) {
      ctx.logger.debug(`[code-collapse] 上报 round-display 失败：${safeMessage(error)}`);
    }
  }

  installSettingsSection(ctx, NAMESPACE, SETTINGS_SCHEMA, entry, {
    setSource: (current) => {
      source = current;
    },
    onChange: () => {
      // enabled 热改：关闭时撤销已声明的 code 呈现；开启时对现有 agent 补声明。
      const current = source();
      if (current === null || typeof current !== "object" || current.enabled !== true) {
        teardownAll();
      } else {
        ensureExistingAgents();
      }
    },
  });

  // 插件加载时已存在的会话（对话早于插件，也要折叠）。
  ensureExistingAgents();

  // 首轮提醒：系统提示段（仅 turn 1 注入），告知模型尽量用一次 run_code 调用多个工具。
  ctx.systemPrompt.section({
    name: "code-collapse:first-round",
    order: 145,
    text: (context) => {
      const current = source();
      if (current === null || typeof current !== "object" || current.enabled !== true || current.firstRoundHint !== true) return "";
      const agent = context?.agent;
      if (agent === null || agent === undefined || typeof agent !== "object") return "";
      if (currentTurnOf(agent) !== 1) return "";
      const output =
        typeof current.firstRoundText === "string" && current.firstRoundText.trim().length > 0
          ? current.firstRoundText
          : DEFAULT_FIRST_ROUND_HINT;
      // 告诉 round-display 显示插件本轮发送了什么（best-effort）。
      reportRoundDisplay(agent, output);
      return output;
    },
  });

  // 新会话：agent/session-start 在首次组装之前发出，赶得上第一轮。
  ctx.on("agent/session-start", (payload) => {
    ensurePresented(payload !== null && typeof payload === "object" ? payload.agent : undefined);
  });
  ctx.on("agent/disposed", (payload) => {
    const id = payload !== null && typeof payload === "object" ? payload.agent?.id : undefined;
    if (id !== undefined) presented.delete(id);
  });

  // 每次 run_code 调用完成后，向下一轮模型上下文追加 We need 提示。
  // additionalContexts 随该结果的 active-batch FIFO 进入模型历史（用户角色）。
  ctx.on("tools/post-execute", (exec, _result, next) => {
    const current = source();
    if (current === null || typeof current !== "object" || current.appendCallHint !== true) return next();
    if (exec === null || typeof exec !== "object" || exec.name !== "run_code") return next();
    const hintText =
      typeof current.callHint === "string" && current.callHint.trim().length > 0
        ? current.callHint
        : DEFAULT_CALL_HINT;
    return next().then((decision) => {
      if (decision === null || typeof decision !== "object" || decision.kind !== "accept") return decision;
      let message;
      try {
        message = createUserMessage({
          content: [{ type: "text", text: hintText }],
          source: {
            kind: "plugin",
            plugin: "code-collapse",
            form: "notice",
            summary: "[code-collapse - We need]",
          },
        });
      } catch (error) {
        ctx.logger.warn(`[code-collapse] 构造提示消息失败：${safeMessage(error)}`);
        return decision;
      }
      // 告诉 round-display 显示插件本轮发送了什么（best-effort）。
      reportRoundDisplay(exec?.agent, hintText);
      return {
        ...decision,
        additionalContexts: [
          ...(Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []),
          message,
        ],
      };
    });
  });
}
