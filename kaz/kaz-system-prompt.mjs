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
 *     Kaz 主会话真实 system = deployment:persona 整段逐字为
 *     kaz-shared KAZ_ROLE_PROMPTS.main（v0.9 §9.1 完整 Persona，含基础首句/末句），
 *     不再有独立的 BASE_PROMPT 重复段，也不再注册/保留 ka-whale-workflow:main
 *     第二段；受控子代理保留 request.persona 带入的
 *     KAZ_ROLE_PROMPTS.subagent.*，不再被本控制器覆盖成基础 persona。
 *     原生 plan:policy / tool:goal 段不再注入——v0.8 Step B1 已实际移除）；
 *   - agent/pre-step 扫描上报：
 *       - dsh-goal-round-driver 的 <goal_round>（source.kind === "goal"）；
 *       - dsh-tool-goal 的 <goal_complete>/<goal_blocked>
 *         （source.plugin === "tool-goal"）；
 *
 * 注意：不监听 session/event——kaz-system-prompt 挂在 agent scope 下，而
 * session/event 从 host 根 scope 派发，agent scope 监听器收不到（output-beep
 * 能收是因为它在 host 平面）。
 *
 * 规则：Kaz 主会话 persona = kaz-shared KAZ_ROLE_PROMPTS.main（完整 Persona，
 * 不按 kaz-memory/ka-whale-memory 插件开关切换 persona 变体）；
 * 记忆搜索/保存指引改由追加消息承担。
 * 受控子代理的 request.persona 是完整的 KAZ_ROLE_PROMPTS.subagent.* 角色
 * Persona，必须原样保留；普通/未知子代理没有显式 role persona 时才回退基础词。
 * 角色/任务类型特化段固定存放于 kaz-shared 的 KAZ_ROLE_PROMPTS，
 * 代码级维护，禁止按具体任务实例动态生成 system。
 *
 * kaz-shared 解析：本文件可能在仓库 kaz/ 位置（与 KazPlugins 同级）或部署后的
 * .agent-presets/kaz 位置（与 profiles/web/KazPlugins 相隔两层）运行；先尝试
 * config.kazSharedPath，再按两个相对布局逐个探测，避免把单一硬编码路径当唯一解。
 */

export const name = 'kaz-system-prompt'

/** 只依赖事件系统；不需要额外 inject。 */
export const inject = []

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 本脚本所在目录（仓库 kaz/ 或部署 .agent-presets/kaz/）。 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** kaz-shared/lib/tool-lists.js 候选相对布局。
 *  候选 1：仓库 kaz/ → ../KazPlugins/kaz-shared；也可兼容 .agent-presets 下
 *  与 KazPlugins 同级的复制布局。
 *  候选 2：部署 .agent-presets/kaz/ → ../../profiles/web/KazPlugins/kaz-shared。 */
const KAZ_SHARED_CANDIDATES = [
  join(MODULE_DIR, "..", "KazPlugins", "kaz-shared", "lib", "tool-lists.js"),
  join(MODULE_DIR, "..", "..", "profiles", "web", "KazPlugins", "kaz-shared", "lib", "tool-lists.js"),
];

/** 动态 import 缓存（按绝对路径，避免每个 assemble 都重复解析）。 */
const kazSharedCache = new Map();

/** 解析 kaz-shared 模块：config.kazSharedPath 优先，随后按候选路径探测。 */
async function loadKazShared(config) {
  const explicit =
    config !== null &&
    typeof config === "object" &&
    typeof config.kazSharedPath === "string" &&
    config.kazSharedPath.trim().length > 0
      ? config.kazSharedPath.trim()
      : "";
  const candidates = [];
  if (explicit.length > 0) candidates.push(explicit);
  candidates.push(...KAZ_SHARED_CANDIDATES);
  let lastError = null;
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      if (!kazSharedCache.has(candidate)) {
        kazSharedCache.set(candidate, import(pathToFileURL(candidate).href));
      }
      return await kazSharedCache.get(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  const detail =
    lastError !== null && lastError instanceof Error
      ? ` (last error: ${lastError.message})`
      : "";
  throw new Error(
    `[kaz-system-prompt] cannot resolve kaz-shared/lib/tool-lists.js from ${MODULE_DIR}; tried ${JSON.stringify(candidates)}${detail}`,
  );
}

/** 把展示内容上报给 round-display（best-effort，服务不存在时静默跳过）。
 *  36.7：真实系统提示词显式带 category=system-prompt；goal 通知显式带
 *  category=goal-context，避免依赖旧回退分类。 */
function reportRoundDisplay(
  ctx,
  agent,
  content,
  plugin = "kaz-system-prompt",
  title = "system prompt",
  category = "system-prompt",
) {
  try {
    const rd = ctx.get('roundDisplay')
    if (rd && typeof rd.report === 'function' && agent && typeof content === 'string' && content.trim().length > 0) {
      rd.report({ agent, plugin, title, content, category })
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

/** 把一条带 source 的注入消息上报 round-display（goal_round / goal wrapup）。 */
function reportInjectedMessage(ctx, agent, message) {
  try {
    const source = message === null || typeof message !== "object" ? undefined : message.source
    if (source === null || typeof source !== "object") return
    const text = textOfMessage(message)
    if (text.length === 0) return
    if (source.kind === "goal" && typeof source.round === "number" && source.round > 0) {
      reportRoundDisplay(ctx, agent, text, "goal-round-driver", "goal round", "goal-context")
    } else if (source.plugin === "tool-goal") {
      reportRoundDisplay(ctx, agent, text, "tool-goal", "goal wrapup", "goal-context")
    }
  } catch {
    // 上报失败不影响主流程
  }
}

/**
 * 普通/未知子代理的兜底 prompt（旧行为兼容；仅在该类子代理带着默认/短 persona
 * 时使用。Kaz 主会话与受控 v0.9 子代理都走 KAZ_ROLE_PROMPTS，不经过这里）。
 */
const SUBAGENT_FALLBACK_PROMPT = `You are a helpful software engineer assistant. **ALWAYS REASON AS 'WE'**. Maintain a calm, declarative tone.

Keep gray reasoning concise — use short, clear **ENGLISH**(IMPORTANT) sentences. If stuck or circling, report to the user and stop the work immediately.

The final white response should be crisp and to the point, and only appear after reasoning and working.`

/** kaz/agent.cordis.yml 的 persona 行原始短文本（未受 kaz-system-prompt 覆盖前）。 */
const PRESET_PERSONA_TEXT = 'You are a helpful software engineer assistant.'

/** 是否为默认/基础 persona 文本（preset 短兜底或未知子代理完整 base）。
 *  子代理只有 request.persona 带来的显式 role persona 才需要保留。 */
function isDefaultPersonaText(text) {
  return (
    text === PRESET_PERSONA_TEXT ||
    text === SUBAGENT_FALLBACK_PROMPT ||
    text.trim() === PRESET_PERSONA_TEXT.trim()
  )
}

/** 从 agent 形状判断子代理会话。 */
function isSubagentAgent(agent) {
  try {
    const depth = agent?.options?.subagentDepth
    if (typeof depth === 'number' && depth > 0) return true
    const events = agent?.session?.events
    if (Array.isArray(events)) {
      for (const event of events) {
        if (event !== null && typeof event === 'object' && event.type === 'subagent/descriptor') return true
      }
    }
    const header = agent?.session?.header
    if (header !== null && header !== undefined && typeof header === 'object') {
      return header.origin === 'subagent' || typeof header.parentSession === 'string'
    }
  } catch {
    // fall through
  }
  return false
}

/** 是否为子代理显式 role Persona 文本（非默认即保留；包含
 *  KAZ_ROLE_PROMPTS.subagent.* 四条）。 */
function isSubagentRolePersonaText(text) {
  return typeof text === 'string' && !isDefaultPersonaText(text)
}

/** persona 段名（与 kaz preset 的 persona 行一致）。 */
const PERSONA_SECTION = 'deployment:persona'

/** ka-whale-workflow 历史 system 段前缀：新机制不再保留任何此类段，
 *  只保留 deployment:persona 单段，避免旧插件残留段导致 persona 重复。 */
const WHALE_SECTION_PREFIX = 'ka-whale-workflow:'

export function apply(ctx, config = {}) {
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

    // v0.9 §9.1 完整 Persona 是 main 真实系统的唯一内容源。
    const kazShared = await loadKazShared(config)
    const MAIN_PROMPT = kazShared?.KAZ_ROLE_PROMPTS?.main
    if (typeof MAIN_PROMPT !== 'string' || MAIN_PROMPT.length === 0) {
      throw new Error('[kaz-system-prompt] KAZ_ROLE_PROMPTS.main missing from kaz-shared')
    }

    // v0.8 Step B1：收敛为 persona 单段；其余提示段一律过滤（含历史
    // ka-whale-workflow:* system 段）。persona 绝对最前。Kaz 主会话
    // deployment:persona = KAZ_ROLE_PROMPTS.main 全量文本。
    const kept = []

    let personaKept = false
    for (const section of assembly.sections) {
      if (section === null || typeof section !== 'object' || section.name !== PERSONA_SECTION) {
        continue
      }
      // 受控 v0.9 子代理的 request.persona（KAZ_ROLE_PROMPTS.subagent.*）通过
      // deployment:persona 携带，是显式 role 文本，原样保留；只替换默认/base
      // persona（主会话替换为完整 main；普通未知子代理保留旧 fallback 语义）。
      const preserveSubagentRolePersona =
        isSubagentAgent(agent) && isSubagentRolePersonaText(section.text)
      if (typeof section.text === 'string' && !preserveSubagentRolePersona) {
        section.text = isSubagentAgent(agent) ? SUBAGENT_FALLBACK_PROMPT : MAIN_PROMPT
      }
      kept.push(section)
      personaKept = true
    }
    if (!personaKept) {
      kept.push({
        name: PERSONA_SECTION,
        order: 0,
        text: isSubagentAgent(agent) ? SUBAGENT_FALLBACK_PROMPT : MAIN_PROMPT,
      })
    }
    // 不保留任何 ka-whale-workflow:* 段：主 Persona 已完整在 deployment:persona。
    // 这样即使旧插件仍注册 ka-whale-workflow:main，真实 system 也不会重复正文。
    const _discardedWhaleSections = assembly.sections.filter(
      (section) =>
        section !== null &&
        typeof section === 'object' &&
        typeof section.name === 'string' &&
        section.name.startsWith(WHALE_SECTION_PREFIX),
    )
    if (_discardedWhaleSections.length > 0) {
      ctx.logger?.debug?.(
        `[kaz-system-prompt] discarded ${_discardedWhaleSections.length} legacy ka-whale-workflow:* system section(s); main persona is deployment:persona only`,
      )
    }

    assembly.sections = kept
    // 等后续监听器（kaz-mode 只过滤工具段；36.9 起首轮 Minimal 由 kaz-mode 核心
    // 处理）跑完，
    // 取最终 sections 组装“真实系统提示词”再上报（与 dsh-system-prompt 的
    // renderPrompt 一致：空段过滤、"\n\n" 连接）。persona 在最前；
    // 这正是模型真实看到的 system 字段。
    const nextResult = await next()
    const finalAssembly = nextResult ?? assembly
    const finalPrompt = realPromptOf(finalAssembly?.sections)
    if (finalPrompt.length > 0) reportRoundDisplay(ctx, agent, finalPrompt)
    return nextResult
  })

  // goal 注入消息上报：
  //   - agent/pre-step 直接扫描本次 step 的 messages（goal_round 由 followup 进
  //     inbox、tool-goal wrapup 由 deferContext 进 next-step）。
  //   - 原生 Plan 已移除，不再扫描 plan/mode 状态事件或上报 plan-mode 通知。
  // 重复上报由 round-display 按 (plugin, content) 去重。
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

    return decision
  })
}
