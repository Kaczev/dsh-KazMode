/**
 * kaz-system-prompt —— Kaz 模式的系统提示词控制器。
 *
 * 这个脚本放在 kaz preset 目录里，专门负责“在什么情况下用哪句系统提示词”。
 * 之前这段逻辑内嵌在 kaz-mode 插件里，现在移到 preset 层，
 * 这样改提示词不用动插件，直接改这个文件即可。
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

/** 把系统提示词上报给 round-display（best-effort，服务不存在时静默跳过）。 */
function reportRoundDisplay(ctx, agent, content) {
  try {
    const rd = ctx.get('roundDisplay')
    if (rd && typeof rd.report === 'function' && agent && typeof content === 'string' && content.trim().length > 0) {
      rd.report({ agent, plugin: 'kaz-system-prompt', title: 'system prompt', content })
    }
  } catch {
    // 上报失败不影响系统提示词
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
      "You are a helpful software engineer assistant. In all reasoning, refer to ourselves as 'we' and to the users as 'they' in English. Keep reasoning in gray text; final white response only after reasoning completes. Search memory before tasks, save concise insights. ",
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
    const planSection = assembly.sections.find(
      (section) =>
        section !== null &&
        typeof section === 'object' &&
        typeof section.name === 'string' &&
        /plan/i.test(section.name),
    )
    const kept = []
    if (planSection !== undefined) kept.push(planSection)

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

    assembly.sections = kept
    reportRoundDisplay(ctx, agent, prompt)
    return next()
  })
}
