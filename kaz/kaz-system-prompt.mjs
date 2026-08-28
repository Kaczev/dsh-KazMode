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
 *     plan 模式激活时 = persona 段 + plan:policy 段；goal 工具启用时
 *     （Kaz 白名单里任一 goal 工具可见）再追加 tool:goal 段，顺序
 *     persona → plan:policy → tool:goal）；
 *   - agent/pre-step 扫描上报：
 *       - dsh-plan-mode 的进入/退出通知（source.plugin === "plan-mode"）；
 *       - dsh-goal-round-driver 的 <goal_round>（source.kind === "goal"）；
 *       - dsh-tool-goal 的 <goal_complete>/<goal_blocked>
 *         （source.plugin === "tool-goal"）；
 *   - agent/pre-step 另扫描 agent.session.events 里的 plan/mode 事件兜底：
 *     dsh-plan-mode 只在“上一个请求头描述的是另一种模式”时才生成
 *     source.plugin === "plan-mode" 的通知消息（例如首条消息前进入 plan 模式、
 *     或经 exit_plan_mode 退出时都没有该消息），所以直接由 plan/mode 状态事件
 *     合成进入/退出文本上报，保证 round-display 始终能看到切换；与既有通知
 *     消息重复时由 round-display 去重。
 *
 * 注意：不监听 session/event——kaz-system-prompt 挂在 agent scope 下，而
 * session/event 从 host 根 scope 派发，agent scope 监听器收不到（output-beep
 * 能收是因为它在 host 平面）。
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

/** Kaz 白名单里 goal 工具名（任一可见即视为 goal 模式开启）。 */
const GOAL_TOOLS = ['create_goal', 'get_goal', 'update_goal']

/** 判断 goal 工具是否已在本会话工具面启用（经 kazMode 服务读取白名单）。 */
function goalToolsEnabled(ctx, agent) {
  try {
    const svc = ctx.get('kazMode')
    if (svc && typeof svc.toolVisible === 'function' && agent) {
      return GOAL_TOOLS.some((name) => svc.toolVisible(agent, name) === true)
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

/** 把一条带 source 的注入消息上报 round-display（goal_round / goal wrapup / plan 通知）。 */
function reportInjectedMessage(ctx, agent, message) {
  try {
    const source = message === null || typeof message !== "object" ? undefined : message.source
    if (source === null || typeof source !== "object") return
    const text = textOfMessage(message)
    if (text.length === 0) return
    if (source.kind === "goal" && typeof source.round === "number" && source.round > 0) {
      reportRoundDisplay(ctx, agent, text, "goal-round-driver", "goal round")
    } else if (source.plugin === "tool-goal") {
      reportRoundDisplay(ctx, agent, text, "tool-goal", "goal wrapup")
    } else if (source.plugin === "plan-mode") {
      reportRoundDisplay(ctx, agent, text, "plan-mode", "plan mode notice")
    }
  } catch {
    // 上报失败不影响主流程
  }
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

    // 保持 plan mode 段与 tool:goal 段（仅 goal 工具启用时），其余提示段
    // 收敛为 persona 一句。顺序：persona 绝对最前（与 dsh 原生 order 排序一致：
    // persona 0 < plan:policy 50 < tool:goal 114），plan 段、tool:goal 段随后。
    const planSection = assembly.sections.find(
      (section) =>
        section !== null &&
        typeof section === 'object' &&
        typeof section.name === 'string' &&
        /plan/i.test(section.name),
    )
    const goalSection = assembly.sections.find(
      (section) =>
        section !== null &&
        typeof section === 'object' &&
        typeof section.name === 'string' &&
        section.name === 'tool:goal',
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
    if (goalSection !== undefined && goalToolsEnabled(ctx, agent)) kept.push(goalSection)

    assembly.sections = kept
    // 等后续监听器（kaz-mode 只过滤工具段；round-minimal 首轮还会按首轮工具
    // 白名单过滤 tool:* 段）跑完，
    // 取最终 sections 组装“真实系统提示词”再上报（与 dsh-system-prompt 的
    // renderPrompt 一致：空段过滤、"\n\n" 连接）。plan 模式激活时内容 =
    // persona 段 + plan:policy 段；goal 工具段启用时再含 tool:goal 段。
    // persona 在最前，正是模型真实看到的 system 字段。
    const nextResult = await next()
    const finalAssembly = nextResult ?? assembly
    const finalPrompt = realPromptOf(finalAssembly?.sections)
    if (finalPrompt.length > 0) reportRoundDisplay(ctx, agent, finalPrompt)
    return nextResult
  })

  // goal/plan 注入消息上报：
  //   - agent/pre-step 直接扫描本次 step 的 messages（goal_round 由 followup 进
  //     inbox、tool-goal wrapup 由 deferContext 进 next-step、plan-mode 通知由
  //     瀑布追加或 inbox.claim 进 messages）；
  //   - 同一 pre-step 再扫描 agent.session.events 里的 plan/mode 事件：
  //     dsh-plan-mode 不保证为每次切换生成 source.plugin === "plan-mode" 消息
  //     （首条消息前进入 / exit_plan_mode 退出都没有），由状态事件合成兜底。
  //     不监听 session/event：kaz-system-prompt 在 agent scope，而 session/event
  //     从 host 根 scope 派发，agent scope 监听器收不到（见文件头注释）。
  // 重复上报由 round-display 按 (plugin, content) 去重。
  const startedAt = Date.now()
  /** sessionId -> 已处理过的最大 plan/mode seq（含加载前基线，避免 resume 时补报旧切换）。 */
  const lastPlanModeSeq = new Map()

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
      reportInjectedMessage(ctx, agent, message)
    }

    // plan/mode 状态事件兜底：本轮新增的切换（seq > 已见且发生在插件加载后）
    // 合成进入/退出通知。轮间切换会在这里自然落到“plan 模式生效的那一轮”。
    try {
      const events = agent.session?.events
      if (Array.isArray(events)) {
        const sessionId = agent.id ?? agent.session?.id
        if (typeof sessionId === 'string') {
          const lastSeen = lastPlanModeSeq.get(sessionId) ?? -1
          let maxSeen = lastSeen
          for (const event of events) {
            if (event === null || typeof event !== 'object' || event.type !== 'plan/mode') continue
            const seq = typeof event.seq === 'number' ? event.seq : -1
            if (seq > maxSeen) maxSeen = seq
            if (seq <= lastSeen) continue
            // resume/冷启动的旧事件不补报（插件加载时间之前的切换已经过去）。
            if (typeof event.time === 'number' && event.time < startedAt) continue
            if (typeof event.data?.active !== 'boolean') continue
            const text = event.data.active
              ? 'The user switched this session to plan mode.'
              : 'The user switched this session back to the default mode.'
            reportRoundDisplay(ctx, agent, text, 'plan-mode', 'plan mode notice')
          }
          if (maxSeen > lastSeen) lastPlanModeSeq.set(sessionId, maxSeen)
        }
      }
    } catch {
      // 上报失败不影响主流程
    }

    return decision
  })
}
