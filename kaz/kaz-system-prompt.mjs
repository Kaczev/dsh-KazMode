/**
 * kaz-system-prompt —— Kaz 模式的系统提示词控制器。
 *
 * 这个脚本放在 kaz preset 目录里，专门负责“在什么情况下用哪句系统提示词”。
 * 之前这段逻辑内嵌在 kaz-mode 插件里，现在移到 preset 层，
 * 这样改提示词不用动插件，直接改这个文件即可。
 *
 * 同时也负责把展示信息上报 round-display（best-effort）：
 *   - system-prompt/assemble 后上报“真实系统提示词”（过滤后的最终 sections，
 *     与 dsh-system-prompt 的 renderPrompt 一致：空段过滤、"\n\n" 连接；
 *     plan 模式激活时 = plan:policy 段 + persona 段）；
 *   - agent/pre-step 与 session/event 双通道上报 dsh-plan-mode 的进入/退出
 *     通知（source.plugin === "plan-mode"）。
 *
 * 规则按顺序匹配：第一个 `test` 返回 true 的规则胜出。
 * 需要新增“某种情况下的系统提示词”时，在 PROMPT_RULES 里加一条即可。
 *
 * 目前规则：
 *   - kaz-memory 启用 → 记忆优先提示词（每次任务前先 memory_search，完成后
 *     memory_save）
 *   - 默认 → 原有 Kaz 默认 persona
 */

export const name = 'kaz-system-prompt'

/** 只依赖事件系统；不需要额外 inject。 */
export const inject = []

/** 判断某个被管理插件在当前 agent 会话里是否启用（经 kazMode 服务）。 */
function pluginEnabled(ctx, agent, pluginId) {
  try {
    const svc = ctx.get('kazMode')
    if (svc && typeof svc.pluginEnabled === 'function' && agent) {
      return svc.pluginEnabled(agent, pluginId) === true
    }
  } catch {
    // 服务不可用时按未启用处理
  }
  return false
}

/** 把展示内容上报给 round-display（best-effort，服务不存在时静默跳过）。 */
function reportRoundDisplay(ctx, agent, content, plugin = "kaz-system-prompt", title = "system prompt") {
  try {
    const rd = ctx.get('roundDisplay')
    if (rd && typeof rd.report === 'function' && agent && typeof content === 'string' && content.trim().length > 0) {
      rd.report({ agent, plugin, title, content })
    }
  } catch {
    // 上报失败不影响主流程
  }
}

/** 组装真实系统提示词：与 dsh-system-prompt 的 renderPrompt 一致（空段过滤、"\n\n" 连接）。 */
function realPromptOf(sections) {
  const parts = []
  for (const section of Array.isArray(sections) ? sections : []) {
    if (section === null || typeof section !== "object") continue
    const text = typeof section.text === "string" ? section.text : ""
    if (text.trim().length > 0) parts.push(text)
  }
  return parts.join("\n\n")
}

/** 从 user 消息中提取纯文本（content 数组的 text 部分；缺失时回退 source.summary）。 */
function textOfMessage(message) {
  try {
    if (message === null || typeof message !== "object") return ""
    const content = Array.isArray(message.content) ? message.content : []
    const parts = content
      .filter(
        (part) =>
          part !== null &&
          typeof part === "object" &&
          typeof part.text === "string" &&
          part.text.trim().length > 0,
      )
      .map((part) => part.text)
    if (parts.length > 0) return parts.join("\n")
    const source = message.source
    if (source !== null && typeof source === "object" && typeof source.summary === "string") {
      return source.summary
    }
    return ""
  } catch {
    return ""
  }
}

/** 从 session 解析对应 agent（session/event 事件只给 session，没有 agent；同 output-beep 模式）。 */
function sessionAgentOf(ctx, session) {
  try {
    const id =
      session !== null && typeof session === "object" && typeof session.id === "string"
        ? session.id
        : session?.sessionId
    if (typeof id === "string" && id.length > 0) {
      const agents = ctx.get("agents")
      if (agents !== undefined && agents !== null && typeof agents.get === "function") {
        const agent = agents.get(id)
        if (agent !== undefined && agent !== null) return agent
      }
    }
  } catch {
    // 服务缺失时返回 undefined
  }
  return undefined
}

/**
 * 各种情况下的系统提示词。
 * `test` 返回 true 时使用 `text`；多条规则时取第一条命中的。
 */
const PROMPT_RULES = [
  {
    id: 'kaz-memory',
    test: (ctx, agent) => pluginEnabled(ctx, agent, 'kaz-memory'),
    text:
      "You are a helpful software engineer assistant. Always reason as 'we'. Maintain a calm, declarative tone."+"\n"+
      "---"+"\n"+
      "Search memory at the start and whenever stuck or needing details (e.g., request format). Keep gray reasoning concise — use short, clear *ENGLISH* sentences. If stuck or circling, search memory again; if still unresolved, report to the user."+"\n"+
      "---"+"\n"+
      "After reasoning, save concise insights — including workarounds, useful tools, and dead ends avoided, even if not used in the final answer."+"\n"+
      "---"+"\n"+
      "The final white response should be crisp and to the point, and only appear after reasoning and saving are complete."
  },
  {
    id: 'default',
    test: () => true,
    text: 'You are a helpful software engineer assistant.',
  },
]

/** 取当前会话命中的系统提示词。 */
function resolvePrompt(ctx, agent) {
  for (const rule of PROMPT_RULES) {
    try {
      if (rule.test(ctx, agent)) return rule.text
    } catch {
      // 某条规则异常时跳过，继续往下找
    }
  }
  return PROMPT_RULES[PROMPT_RULES.length - 1].text
}

/** persona 段名（与 kaz preset 的 persona 行一致）。 */
const PERSONA_SECTION = 'deployment:persona'

export function apply(ctx, _config) {
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const agent = context?.agent

    // 非 Kaz 会话不应被这个 preset 脚本干预（防御性检查）。
    try {
      const svc = ctx.get('kazMode')
      if (svc && typeof svc.kazEnabled === 'function' && agent && svc.kazEnabled(agent) !== true) {
        return next()
      }
    } catch {
      // 服务缺失时不拦截，继续按 Kaz 预设处理
    }

    const prompt = resolvePrompt(ctx, agent)

    // 保持 plan mode 段，其余提示段收敛为 persona 一句。
    // 顺序：persona 绝对最前（与 dsh 原生 order 排序一致：persona 0 < plan:policy 50），
    // plan 段跟在 persona 后面。
    const planSection = assembly.sections.find(
      (section) =>
        section !== null &&
        typeof section === 'object' &&
        typeof section.name === 'string' &&
        /plan/i.test(section.name),
    )
    const kept = []

    let personaKept = false
    for (const section of assembly.sections) {
      if (section === null || typeof section !== 'object' || section.name !== PERSONA_SECTION) {
        continue
      }
      if (typeof section.text === 'string') section.text = prompt
      kept.push(section)
      personaKept = true
    }
    if (!personaKept) {
      kept.push({ name: PERSONA_SECTION, order: 0, text: prompt })
    }
    if (planSection !== undefined) kept.push(planSection)

    assembly.sections = kept
    // 等后续监听器（round-minimal / kaz-mode 只过滤工具段，不动 sections）跑完，
    // 取最终 sections 组装“真实系统提示词”再上报（与 dsh-system-prompt 的
    // renderPrompt 一致：空段过滤、"\n\n" 连接）。plan 模式激活时内容 =
    // persona 段 + plan:policy 段，persona 在最前，正是模型真实看到的 system 字段。
    const nextResult = await next()
    const finalAssembly = nextResult ?? assembly
    const finalPrompt = realPromptOf(finalAssembly?.sections)
    if (finalPrompt.length > 0) reportRoundDisplay(ctx, agent, finalPrompt)
    return nextResult
  })

  // 进入/退出 plan 模式通知上报（source.plugin === "plan-mode" 的 user 消息）：
  //   - agent/pre-step：直接扫描本次 step 的 messages（dsh-plan-mode 在开放 turn
  //     内由瀑布追加 notice；轮间切换则 notice 已由 inbox.claim 进 messages）；
  //   - session/event：兜底，通知消息真正落盘（步骤被接受）时必然触发，
  //     不受 pre-step 监听器顺序影响。重复上报由 round-display 按 (plugin, content) 去重。
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision === null || typeof decision !== 'object' || decision.kind !== 'enter') return decision
    const agent = payload?.agent
    if (agent === null || agent === undefined || typeof agent !== 'object') return decision

    // 非 Kaz 会话不应被这个 preset 脚本干预（防御性检查）。
    try {
      const svc = ctx.get('kazMode')
      if (svc && typeof svc.kazEnabled === 'function' && agent && svc.kazEnabled(agent) !== true) {
        return decision
      }
    } catch {
      // 服务缺失时不拦截，继续按 Kaz 预设处理
    }

    const messages = Array.isArray(decision.messages) ? decision.messages : []
    for (const message of messages) {
      const source = message?.source
      if (source === null || typeof source !== 'object') continue
      if (source.plugin !== 'plan-mode') continue
      const text = textOfMessage(message)
      if (text.length === 0) continue
      reportRoundDisplay(ctx, agent, text, 'plan-mode', 'plan mode notice')
    }
    return decision
  })

  ctx.on('session/event', (session, event) => {
    if (event === null || typeof event !== 'object' || event.type !== 'user/message') return
    const source = event.data?.source
    if (source === null || typeof source !== 'object' || source.plugin !== 'plan-mode') return
    const agent = sessionAgentOf(ctx, session)
    if (agent === undefined) return

    // 非 Kaz 会话不应被这个 preset 脚本干预（防御性检查）。
    try {
      const svc = ctx.get('kazMode')
      if (svc && typeof svc.kazEnabled === 'function' && agent && svc.kazEnabled(agent) !== true) {
        return
      }
    } catch {
      // 服务缺失时不拦截，继续按 Kaz 预设处理
    }

    const text = textOfMessage(event.data)
    if (text.length === 0) return
    reportRoundDisplay(ctx, agent, text, 'plan-mode', 'plan mode notice')
  })
}
