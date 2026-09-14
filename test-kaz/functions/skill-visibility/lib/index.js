// skill-visibility —— 把"技能可见性"做成机制层门禁：**子代理看不到主代理专用的技能**。
//
// 为什么需要它：技能目录是全代理共享的（`customSkillDirs` 是插件级配置，预设里挂一次，
// 主代理与子代理读的是同一份）。更根本的是**注册表结构**决定的——
//   主代理链：[主Agent, 预设standingKey]
//   子代理链：[子Agent, 预设standingKey]        ← 不含主代理自己的 scope
// 读取时**永远合并祖先层**，而预设层是两者的共同祖先，所以预设层里的技能对子代理
// 按构造必然可见；注册表**没有减法 API**（无 restrict/filter），跨层同名只是"最近的层赢"，
// 一个条目也减不掉。结论：**没法用配置实现，必须由 provider 侧过滤**——就是这个插件。
//
// ⚠ 为什么过滤与注册必须合并在这一处：providers 是 dsh-scope 的 NamedEntries，同一层里
// 按名字唯一，重名 insert **直接 throw**——既不是 shadow，也不是"后注册者顶掉先注册者"。
// 曾经这里想挂一个同名 provider 去顶掉官方的 filesystem，代价是整份预设挂载失败：
//   a skill provider named "filesystem" is already registered in this scope
// 抵消同名注册的唯一办法是**只注册一次**：本插件自己包装官方 provider 并注册它，
// 组合文件里不再单独挂 skill-filesystem（那两行必然相撞）。
//
// 做法：包装官方 `@deepseek-ai/dsh-skill-filesystem` 的 provider，在 `list()` 里按调用者过滤。
//   * provider 名沿用官方默认的 "filesystem"：候选的 `provider` 字段必须等于注册名
//     （注册表校验 `candidate.provider !== providerName` 就抛），所以名字不是随便起的，
//     也不能靠改名来回避冲突。
//   * 生命周期照官方那段补全：watcher 是进程级句柄，卸载时必须显式归还；`fs/observed`
//     也要转发，否则用 edit/write 改技能文件时只能等 watcher 的防抖窗口过去才失效。
//
// 判断"谁在读"：`SkillLookupOptions` 的**契约**只有 cwd/signal，但注册表把同一个借用对象
// 原样透传，`options.scope` 实际可达（类型是 `ScopeKey | undefined`）。取值有三种：
//     · 活着的 Agent（主代理或子代理）——最常见
//     · 预设 standing key（`{ agentPreset }`，浏览器/冷会话路径）
//     · undefined（全局读）
// **这是契约外读取**（官方文档说 provider 只该读自己的契约字段）。用它的理由：这是唯一
// 不改 dsh 包的实现路径，而结果按 scope 链正确缓存（注册表的缓存键含 scopeChain）。
// 保守取向与 `kaz-shared/lib/agent-role.js` 一致：**判定失败一律按主代理处理**——
// 宁可多给，不可误挡（误挡会让子代理悄悄少一个技能，很难发现）。
//
// 各 agent 的注册面是隔离的，所以 `ctx.skills` 的可见性也按 agent 生效。

export const name = "skill-visibility";

// 只用 `ctx.skills`；声明出来，免得挂载期取服务抛错。
export const inject = ["skills"];

import { FileSystemSkillProvider } from "@deepseek-ai/dsh-skill-filesystem";
import { isSubagentAgent } from "../../kaz-shared/lib/agent-role.js";
import { MAIN_AGENT_ONLY_SKILLS } from "../../kaz-shared/lib/skill-visibility.js";

/** 官方 provider 的默认名；注册名与候选的 `provider` 字段必须是它。 */
const DEFAULT_PROVIDER_NAME = "filesystem";

/** 只给主代理的技能名集合（查表用）。 */
const MAIN_ONLY = new Set(MAIN_AGENT_ONLY_SKILLS);

/**
 * 判断这次读取是不是子代理发起的。
 * @param {object} options - provider 的 lookup options（实际含 `scope`）。
 * @returns {boolean}
 */
function readBySubagent(options) {
  const scope = options?.scope;
  if (scope === undefined || scope === null || typeof scope !== "object") return false;
  // scope 可能是 Agent（有 session）或预设 standing key（无 session）。
  // isSubagentAgent 对两者都安全：读不到判据就返回 false（按主代理处理）。
  return isSubagentAgent(scope);
}

/**
 * 过滤候选：子代理侧剔除主代理专用的技能。
 * @param {readonly object[]} candidates
 * @returns {object[]}
 */
function filterForSubagent(candidates) {
  return candidates.filter((candidate) => !MAIN_ONLY.has(candidate?.name));
}

/**
 * 这次 `fs/observed` 是不是"mutation 工具"造成的。
 *
 * 选择**照官方那段的判断**（只认 edit / write），不做"不确定就全转发"的保守版：
 * `observeHostMutation()` 对任何落在技能根里的路径都会 invalidate，而 read 同样会发
 * fs/observed——全转发等于每读一次 SKILL.md 就清掉注册表那份收集缓存。其它写者
 * （shell、外部编辑器）本来就由 provider 自己的 watcher 兜住，不依赖这条转发。
 * @param {object} actor - 事件里的 actor（工具描述符，可能不存在）。
 * @returns {boolean}
 */
function isMutationActor(actor) {
  if (actor === null || typeof actor !== "object" || !("name" in actor)) return false;
  return actor.name === "edit" || actor.name === "write";
}

export function apply(ctx, config) {
  const providerName = config?.providerName ?? DEFAULT_PROVIDER_NAME;
  // 官方 provider 实例记在外层：它既是 list()/get() 的数据源，也是 watcher 与观察的接收方
  // （本插件注册出去的是过滤壳，壳里不持有句柄）。
  let inner;
  ctx.skills.registerProvider((control) => {
    inner = new FileSystemSkillProvider(ctx, control, { ...(config ?? {}), providerName });
    return {
      name: providerName,
      list: async (options) => {
        const listed = await inner.list(options);
        if (!readBySubagent(options)) return listed;
        // 官方 provider 可能返回"显式 observation"（发现不完整时），两种形状都要处理。
        if (Array.isArray(listed)) return filterForSubagent(listed);
        if (listed !== null && typeof listed === "object" && Array.isArray(listed.candidates)) {
          return { ...listed, candidates: filterForSubagent(listed.candidates) };
        }
        return listed;
      },
      // 不按调用者过滤 get()：目录里已经看不见的名字，工具侧也载入不了（走的是同一套查找），
      // 在这里再挡一道只会多一个可能出错的判断点。
      get: (candidate, options) => inner.get(candidate, options),
    };
  });
  // 官方同款归还：provider 的 watcher 是进程级句柄，注册被撤销/插件卸载后必须关掉，
  // 否则它继续跟着文件系统跑（且持有 provider 自身）。
  ctx.effect(function* () {
    yield async () => {
      await inner?.dispose?.();
    };
  }, "skill-visibility watcher");
  ctx.on("fs/observed", (target, _observation, actor) => {
    if (!isMutationActor(actor)) return;
    inner?.observeHostMutation?.(target.displayPath);
  });
}
