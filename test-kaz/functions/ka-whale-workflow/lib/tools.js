// ka-whale-workflow —— 工作流四工具（《Kaz8.0设计.md》§3.9）。
//   write_arrangement  写安排（只在 arrange_agent 阶段）
//   get_arrangement    查看安排（只读，任何阶段）
//   ka_sub_whale       按安排派发子代理（含 memoryMaintainer 与 slopCleaner 两个保留值）
//   whale_report       推进阶段
// 文案一律英文。

import { defineTool } from "@deepseek-ai/dsh-tools";
import { randomUUID } from "node:crypto";
import { CONCURRENCY_CAP_REASON, MAIN_BLACKLIST, MAX_CONCURRENT_SUBAGENTS, MEMORY_MAINTAINER_BLACKLIST, MEMORY_MAINTAINER_RESERVED, SLOP_CLEANER_BLACKLIST, SLOP_CLEANER_RESERVED, SUBAGENT_DEFAULT_BLACKLIST, sanitizeBlacklist } from "../../kaz-shared/lib/blacklists.js";
import { MEMORY_MAINTAINER_PERSONA, SLOP_CLEANER_PERSONA, renderSubagentPersona } from "../../kaz-shared/lib/roles.js";
import { normalizeEntry, patchEntryAt, writeArrangement } from "./arrangement.js";
import { KAZ_FORK_PROVIDER, noteForkSource, resolveForkTarget } from "./fork-provider.js";
import { LEGAL_TRANSITIONS, REFLECTION_ADVERTISED_BYTES, STAGES, reflectionProblem } from "./stages.js";

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean", required: true },
    message: { type: "string", required: true },
  },
};

const RESULT_RENDER = (_args, value) => [
  { type: "text", text: value.ok ? `success: ${value.message}` : `failure: ${value.message}` },
];

const TEXT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean", required: true },
    message: { type: "string", required: true },
    text: { type: "string", required: true },
  },
};

const TEXT_RENDER = (_args, value) => [{ type: "text", text: value.ok ? value.text : `failure: ${value.message}` }];

/**
 * `ka_sub_whale` 的回执渲染：**把 `message` 也给模型看**。
 *
 * 为什么不能只回 `text`（= 一行 `subagent id: …`）：回执的全部真相都在 `message` 里——
 * 用了哪个 provider、fork 目标解析到了没有、有没有退回、黑名单跳过了谁。只渲染 id 等于让
 * 模型看不见这些，于是"fork 目标早已不是活会话、这次全新开始"这种事它永远学不到，还会继续
 * 以为自己拿到了前情（2026-09-19 实测）。
 */
const RECEIPT_RENDER = (_args, value) => [{ type: "text", text: value.ok ? value.message : `failure: ${value.message}` }];

const ok = (message) => ({ ok: true, message });
const fail = (message) => ({ ok: false, message });
const reason = (error) => (error instanceof Error ? error.message : String(error));

function sessionIdOf(exec) {
  const id = exec?.agent?.session?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** 会话的项目目录（安排文件的落点）。 */
function sessionCwdOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === "string" ? cwd : "";
}

/** persona 的匹配键：字符串本身，或 [角色, 描述] 的角色名。 */
function personaKey(persona) {
  return Array.isArray(persona) ? persona[0] : typeof persona === "string" ? persona : "";
}

/**
 * persona 的角色名（纯字符串 = 模型只写了角色）。
 *
 * 它就是 personaKey 再收一道"必须是字符串"，不是另一份实现：匹配键只跟字符串比
 * （`=== wanted`），而角色名会当 label / 人格渲染的入参一路传下去，非字符串会漏到下游。
 * 写成调用 personaKey 是为了让这一点只写一遍——两份并排的 Array.isArray 链迟早会各自漂移。
 */
function roleOf(persona) {
  const key = personaKey(persona);
  return typeof key === "string" ? key : "";
}

/** persona 的性格/行为描述（纯字符串或数组缺第二项 = 空串）。 */
function descriptionOf(persona) {
  return Array.isArray(persona) && typeof persona[1] === "string" ? persona[1] : "";
}

/**
 * 此刻**同时运行**的直系子代理个数。
 *
 * 数的是状态，不是计划条数：主代理可以错开时间派，所以上限约束的是"同一时间有几个在跑"，
 * 而不是安排文件里写了几条。子代理这一回合结束后活体注册表转为 idle/ready，
 * 所以"跑完一个就腾出一个名额"是自动的，不需要主代理再确认一次。
 *
 * 口径：只数 status === "running" 的孩子，**不是"存在几个孩子"**——已加载但停在两步之间的
 * （idle）不占名额，那种可以直接 send_message 接着用。
 *
 * 数据源是活体 Agent 注册表（`ctx.agents`）——`list_agents` 判 running 用的也是它；
 * `subagents.listChildren` 只负责枚举，它自己不带状态。
 *
 * 已知的窄误差：顺序是**先枚举、再查状态**，而刚派出去的孩子可能还没进枚举结果，
 * 所以同一轮里连派两次时第一个会漏计一次（不是"查到了但状态是临时的 idle"）——那就是 6 个。
 * 宁可少算一次，也不要因为一个永远不回填的账本条目把名额永久卡死。
 *
 * 已知的**大口子**（审查实测出来的，别当成小事）：枚举本身失败时返回 0，等于这次派发**放过了上限**。
 * 触发条件至少有三种——`listChildren` 抛错（平台侧缺 sessionProjections / sessions / sessionQuery
 * 任一服务时就会抛）、`ctx.agents` 拿不到活体注册表、孩子不是以 kind === "child" 的行被枚举出来
 * （例如返回成 diagnostic 行）。下面那条 warn 日志就是为此存在的；选失败放行而不是失败拒绝，
 * 是因为后者会让一次平台改动把整个派发通道卡死。
 *
 * @param {object} ctx - 插件上下文。
 * @param {string} sessionId - 主代理的会话 id（子代理挂在它下面）。
 * @param {AbortSignal} [signal] - 调用信号。
 * @returns {Promise<number>} 同时运行的直系子代理个数；数不到时返回 0。
 */
async function liveSubagentCount(ctx, sessionId, signal) {
  const subagents = ctx?.subagents ?? ctx?.get?.("subagents");
  const agents = ctx?.agents ?? ctx?.get?.("agents");
  try {
    if (subagents === null || subagents === undefined || typeof subagents.listChildren !== "function") return 0;
    const children = await subagents.listChildren(sessionId, signal);
    if (!Array.isArray(children)) return 0;
    let count = 0;
    for (const child of children) {
      if (child === null || typeof child !== "object" || child.kind !== "child") continue;
      const live = typeof agents?.get === "function" ? agents.get(child.id) : undefined;
      if (live !== undefined && live !== null && live.status === "running") count += 1;
    }
    return count;
  } catch (error) {
    // 失败方向是"什么都不在跑"，也就是**这次派发放过上限**。这是有意选的：
    // 反过来选（数不到就拒绝）会让一次平台改动把整个派发通道卡死。
    // 但它是静的——所以这里用 warn 而不是 debug：上限被绕过了，日志里要留痕。
    ctx?.logger?.warn?.(`[ka-whale-workflow] liveSubagentCount: enumeration failed, the concurrency cap did not apply to this dispatch: ${reason(error)}`);
    return 0;
  }
}

/**
 * 平台"已知工具名"集合：以调用者（主代理）可见的工具面为准，再补上对主代理自己隐身的
 * 写记忆三件（它们对子代理仍然存在）。拿不到工具服务时返回 null（不过滤，保持原样）。
 * 平台侧 toolFilter 会在遇到不存在的名字时直接抛错，所以派发前必须先按这个集合过滤。
 */
function knownToolNames(ctx, agent) {
  try {
    const tools = ctx?.tools ?? ctx?.get?.("tools");
    if (tools === undefined || tools === null || typeof tools.schemas !== "function") return null;
    const schemas = tools.schemas(agent);
    if (!Array.isArray(schemas)) return null;
    const names = new Set();
    for (const schema of schemas) {
      if (schema !== null && typeof schema === "object" && typeof schema.name === "string") names.add(schema.name);
    }
    for (const name of MAIN_BLACKLIST) names.add(name);
    return names;
  } catch {
    return null;
  }
}

export function writeArrangementTool({ store }) {
  return defineTool({
    name: "write_arrangement",
    description:
      'Record this round\'s dispatch plan for the current conversation (usable only in the arrange_agent stage). Entries: { persona, blacklist?, task, fork? } — persona must be exactly one of: "main", "memoryMaintainer", "slopCleaner", or [role, description] (an array of exactly two non-empty strings); fork must be exactly "main" (inherit your own conversation), "none" (start a fresh subagent — the same as leaving the field out), or a subagent session id, and is NOT a boolean — true/false/"true"/"yes" are rejected; anything else is rejected. The plan must contain memoryMaintainer: only it can write memories.',
    parameters: {
      entries: { type: "array", required: true, items: { type: "json" }, description: "The dispatch plan entries." },
    },
    output: { schema: RESULT_SCHEMA, render: RESULT_RENDER },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec);
      if (sessionId === undefined) return fail("this agent has no session");
      const stage = store.getStage(sessionId);
      if (stage !== "arrange_agent") return fail(`write_arrangement works only in the arrange_agent stage (current: ${stage})`);
      const raw = Array.isArray(args?.entries) ? args.entries : [];
      if (raw.length === 0) return fail("entries must be a non-empty array");
      const previous = await store.loadEntries(sessionId);
      const entries = [];
      for (const item of raw) {
        const { entry, error } = normalizeEntry(item);
        if (error !== undefined) return fail(error);
        // 重写安排时按 persona 保留程序账本字段（id/status/summary）——
        // 模型每轮都会重写计划，账本不能跟着被清掉。
        const old = previous.find((prev) => personaKey(prev.persona) === personaKey(entry.persona));
        entries.push(old === undefined ? entry : { ...entry, id: old.id, status: old.status, summary: old.summary });
      }
      await writeArrangement(sessionCwdOf(exec), sessionId, entries);
      store.setEntries(sessionId, entries);
      return ok(`arrangement written: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`);
    },
  });
}

export function getArrangementTool({ store }) {
  return defineTool({
    name: "get_arrangement",
    description:
      "Read the current conversation's arrangement (including the program-filled id / status / summary). Read-only; usable in any stage.",
    parameters: {
      persona: { type: "string", description: "Only show this persona's entry." },
    },
    output: { schema: TEXT_SCHEMA, render: TEXT_RENDER },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec);
      if (sessionId === undefined) return { ...fail("this agent has no session"), text: "" };
      const wanted = typeof args?.persona === "string" ? args.persona.trim() : "";
      const entries = await store.loadEntries(sessionId);
      const shown = wanted.length > 0 ? entries.filter((entry) => personaKey(entry.persona) === wanted) : entries;
      if (shown.length === 0) {
        return { ...fail(wanted.length > 0 ? `no arrangement entry with persona "${wanted}"` : "the arrangement is empty"), text: "" };
      }
      return { ok: true, message: `${shown.length} entr${shown.length === 1 ? "y" : "ies"}`, text: JSON.stringify(shown, null, 2) };
    },
  });
}

export function kaSubWhaleTool({ ctx, store }) {
  return defineTool({
    name: "ka_sub_whale",
    description:
      'Dispatch one arrangement entry as a subagent. Input is only the persona (the reserved values are "memoryMaintainer" for the memory keeper and "slopCleaner" for the AI-slop cleaner); blacklist / task / fork come from the arrangement, and the task becomes the subagent\'s first message. The result line is the dispatch receipt - read it, because it is the only place that says which provider ran, whether the child actually inherited a fork target\'s history, and what was skipped. Memory dispatches and their reports stay internal: never relay them to the user.',
    parameters: {
      persona: { type: "string", required: true, description: 'The arrangement entry to dispatch: "memoryMaintainer", "slopCleaner", or a custom role name.' },
    },
    output: { schema: TEXT_SCHEMA, render: RECEIPT_RENDER },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec);
      if (sessionId === undefined) return { ...fail("this agent has no session"), text: "" };
      const wanted = String(args?.persona ?? "").trim();
      if (wanted.length === 0) return { ...fail("persona is required"), text: "" };
      const entries = await store.loadEntries(sessionId);
      const index = entries.findIndex((entry) => personaKey(entry.persona) === wanted);
      if (index < 0) return { ...fail(`no arrangement entry with persona "${wanted}"`), text: "" };
      const entry = entries[index];
      if (personaKey(entry.persona) === "main") return { ...fail('the "main" entry is for the main agent itself; dispatch only subagent entries'), text: "" };
      // 两个保留角色按**匹配键**判定，不是按整个 persona 值：数组形式的 ["slopCleaner", …] 也合法
      // （arrangement.js 只校验 [role, description] 两个非空字符串），而 personaKey 对数组取的是角色名。
      // 早先这里比的是 `entry.persona === "memoryMaintainer"`，于是数组形式会带着保留值当复用键、
      // 却拿到通用 persona 与通用黑名单——名字是管家或清理者，待遇不是（2026-09-17 验证者实测）。
      const personaName = personaKey(entry.persona);
      const isKeeper = personaName === "memoryMaintainer";
      const isCleaner = personaName === "slopCleaner";
      const role = roleOf(entry.persona);
      const personaText = isKeeper
        ? MEMORY_MAINTAINER_PERSONA
        : isCleaner
          ? SLOP_CLEANER_PERSONA
          : renderSubagentPersona(role, descriptionOf(entry.persona));
      const blacklist = isKeeper
        ? sanitizeBlacklist([...MEMORY_MAINTAINER_BLACKLIST], MEMORY_MAINTAINER_RESERVED)
        : isCleaner
          ? sanitizeBlacklist([...SLOP_CLEANER_BLACKLIST], SLOP_CLEANER_RESERVED)
          : sanitizeBlacklist([...SUBAGENT_DEFAULT_BLACKLIST, ...(Array.isArray(entry.blacklist) ? entry.blacklist : [])]);
      // 平台 toolFilter 遇到不存在的工具名会直接抛错：先按"平台已知的工具"过滤，跳过的写进回执。
      const known = knownToolNames(ctx, exec.agent);
      const applied = known === null ? blacklist : blacklist.filter((name) => known.has(name));
      const skipped = known === null ? [] : blacklist.filter((name) => !known.has(name));
      const skippedNote =
        skipped.length > 0 ? ` (blacklist skipped unknown tool${skipped.length > 1 ? "s" : ""}: ${skipped.join(", ")})` : "";
      const label = isKeeper ? "memoryMaintainer" : isCleaner ? "slopCleaner" : role;
      // fork 目标：`"main"` 或一个会话 id。两种缺省分开处理（见 resolveForkTarget）——
      // "没写 fork" 与 "目标已失效、退回派发者" 的回执含义正好相反，不能共用一句话。
      const agents = ctx.get("agents");
      const agentOf = (id) =>
        agents !== undefined && agents !== null && typeof agents.get === "function" ? agents.get(id) : undefined;
      const fork = resolveForkTarget(entry.fork, agentOf);
      let provider = "spawn";
      let forkSource = "";
      let note = "";
      if (fork.kind === "fallback") {
        // provider 保持 `spawn`：这里**没有**任何可以继承的源，所以不许出现 "forked from"
        // 这类字眼——那正是这个 bug 的原形（回执说继承了，子代理其实什么都没有）。
        note = ` (fork target "${fork.target}" is not a live session right now, and there is no other source to inherit from, so this child started fresh with no inherited history)`;
      } else if (fork.kind === "target") {
        provider = KAZ_FORK_PROVIDER;
        forkSource = fork.source ?? "";
        note = fork.source === null ? " (forked from your conversation)" : ` (forked from "${fork.source}")`;
      }
      const subagents = ctx.get("subagents");
      if (subagents === undefined || subagents === null) {
        return { ...fail("the subagent registry is unavailable"), text: "" };
      }
      // 复用（旧 kaz 的强制复用机制）：先在本对话的 continuable 子代理里按 label
      // （= 角色名）找同角色、且当前不在忙的那个 → 把新任务 sendMessage 给它；
      // 都在忙就先别派（等它报告）；找不到才新开一个。
      let reusableId = "";
      let busyId = "";
      let enumerated = false;
      try {
        if (typeof subagents.listChildren === "function") {
          const children = await subagents.listChildren(sessionId, exec.signal);
          enumerated = true;
          for (const child of Array.isArray(children) ? children : []) {
            if (child === null || typeof child !== "object") continue;
            if (child.kind !== "child" || child.mode !== "continuable" || child.label !== label) continue;
            const live = agentOf(child.id);
            if (live !== undefined && live !== null && live.status === "running") {
              if (busyId.length === 0) busyId = child.id;
              continue;
            }
            reusableId = child.id;
            break;
          }
        }
      } catch (error) {
        ctx.logger?.debug?.(`[ka-whale-workflow] listChildren failed: ${reason(error)}`);
      }
      if (!enumerated && reusableId.length === 0 && typeof entry.id === "string" && entry.id.length > 0) {
        const live = agentOf(entry.id);
        if (live !== undefined && live !== null) {
          if (live.status === "running") busyId = entry.id;
          else reusableId = entry.id;
        }
      }
      if (reusableId.length === 0 && busyId.length > 0) {
        return { ...fail(`${label} is still working (subagent ${busyId}); wait for its report before dispatching it again`), text: "" };
      }
      let reused = false;
      if (reusableId.length > 0 && typeof subagents.sendMessage === "function") {
        try {
          await subagents.sendMessage(exec.agent, reusableId, [{ type: "text", text: entry.task }], { signal: exec.signal });
          reused = true;
        } catch (error) {
          // 复用一个"已不可达"的子代理（注册表里还留着旧记录，但会话已经没了）
          // 会永远失败——那时不要卡住整个 persona，改成新开一个可续子代理。
          ctx.logger?.warn?.(`[ka-whale-workflow] reusing ${reusableId} failed, starting a fresh one: ${reason(error)}`);
        }
      }
      if (reused) {
        const continued = await patchEntryAt(sessionCwdOf(exec), sessionId, index, { id: reusableId, status: "running" });
        store.setEntries(sessionId, continued);
        // 复用发生在选 provider 之前，所以 `fork` 在这个分支里从来不会被消费：写下来的目标
        // **不会**被继承，子代理接着自己原有的历史。静默照写 "dispatched" 会让模型以为
        // fork 生效了，所以这里必须自己说一句。
        const reuseNote =
          fork.kind === "none" ? "" : ` (reused an existing ${label}, so the fork target "${fork.target}" was NOT applied)`;
        return { ok: true, message: `continued ${label} as ${reusableId} (reused, no new subagent)${reuseNote}`, text: `subagent id: ${reusableId}` };
      }
      // 复用不成 → 准备新开一个：先数"此刻同时活着几个"。上限见
      // kaz-shared/lib/blacklists.js（MAX_CONCURRENT_SUBAGENTS）——限的是同时运行数，不是计划条数。
      const liveNow = await liveSubagentCount(ctx, sessionId, exec.signal);
      if (liveNow >= MAX_CONCURRENT_SUBAGENTS) {
        return {
          ...fail(
            `${liveNow} subagents are already running (cap ${MAX_CONCURRENT_SUBAGENTS}); ${CONCURRENCY_CAP_REASON} ${label} has not been dispatched.`,
          ),
          text: "",
        };
      }
      if (typeof subagents.startContinuable !== "function") {
        return { ...fail("the subagent registry is unavailable"), text: "" };
      }
      const childId = randomUUID();
      if (provider === KAZ_FORK_PROVIDER) noteForkSource(childId, forkSource);
      const request = {
        label,
        prompt: [{ type: "text", text: entry.task }],
        parent: exec.agent,
        persona: personaText,
        ...(applied.length > 0 ? { toolFilter: { deny: applied } } : {}),
      };
      let started;
      try {
        started = await subagents.startContinuable({ provider, label, childId, request, signal: exec.signal });
      } catch (error) {
        return { ...fail(`dispatch failed: ${reason(error)}${note}${skippedNote}`), text: "" };
      }
      const startedId = started?.childId ?? childId;
      const next = await patchEntryAt(sessionCwdOf(exec), sessionId, index, { id: startedId, status: "running" });
      store.setEntries(sessionId, next);
      return { ok: true, message: `dispatched ${label} as ${startedId} (${provider})${note}${skippedNote}`, text: `subagent id: ${startedId}` };
    },
  });
}

export function whaleReportTool({ store, noteStage }) {
  return defineTool({
    name: "whale_report",
    description:
      "Advance the main agent's workflow stage. Targets: idle, arrange_agent, self-check. While the current stage is self-check this is the only tool that works, and `reflection` is then required: a short written self-check, at most 1024 bytes. Reflection findings are internal — they are not reported to the user.",
    parameters: {
      stage: { type: "string", required: true, enum: [...STAGES], description: "Target stage." },
      reflection: {
        type: "string",
        description: `Required while the current stage is self-check, ignored otherwise: a brief reflection, at most ${REFLECTION_ADVERTISED_BYTES} bytes. It is not a deliverable — do not paste it into your reply to the user.`,
      },
    },
    output: { schema: RESULT_SCHEMA, render: RESULT_RENDER },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec);
      if (sessionId === undefined) return fail("this agent has no session");
      const target = String(args?.stage ?? "").trim();
      if (!STAGES.includes(target)) return fail(`unknown stage "${target}"; known stages: ${STAGES.join(", ")}`);
      const current = store.getStage(sessionId);
      // 反思门禁：只在**离开 self-check 时**强制。其它阶段传了也不看（避免把普通阶段推进变成写小作文）。
      if (current === "self-check") {
        const problem = reflectionProblem(args?.reflection);
        if (problem !== null) return fail(problem);
      }
      // **同阶段也算非法**：`target === current` 不是"推进"，以前它从这里溜过去，于是
      // 在 self-check 里报 self-check（或 idle 里报 idle）会回一句 `success: stage: …`——
      // 一次什么都没变的调用被报成成功，还顺手广播/记了一笔"模型选过阶段"。
      // 判据只有一张表（LEGAL_TRANSITIONS），同阶段不在任何一张表的"可跳转"里，所以不特判。
      if (!LEGAL_TRANSITIONS[current].includes(target)) {
        return fail(`cannot go from ${current} to ${target}; legal from ${current}: ${LEGAL_TRANSITIONS[current].join(", ")}`);
      }
      store.setStage(sessionId, target);
      // **立即广播**：guard（kaz-shared 的调用时刻否决）读的就是这份值。
      // 少了这句，从 self-check 跳出后本轮剩下的步骤仍被拒（实测踩过）。
      noteStage?.(sessionId, target);
      // 记一笔"模型本轮自己选过阶段"：本轮内不再自动进入 self-check，
      // 否则刚从 self-check 跳出的 idle 会被下一轮计算按回去（实测整轮出不来）。
      store.markModelStageChoice?.(sessionId);
      return ok(`stage: ${target}`);
    },
  });
}
