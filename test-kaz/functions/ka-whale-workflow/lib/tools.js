// ka-whale-workflow —— 工作流四工具（《Kaz8.0设计.md》§3.9）。
//   write-arrangement  写安排（只在 arrange_agent 阶段）
//   get-arrangement    查看安排（只读，任何阶段）
//   ka_sub_whale       按安排派发子代理（含 memoryMaintainer 保留值）
//   whale_report       推进阶段
// 文案一律英文。

import { defineTool } from "@deepseek-ai/dsh-tools";
import { randomUUID } from "node:crypto";
import { MAIN_BLACKLIST, MEMORY_MAINTAINER_BLACKLIST, SUBAGENT_DEFAULT_BLACKLIST, sanitizeBlacklist } from "../../kaz-shared/lib/blacklists.js";
import { MEMORY_MAINTAINER_PERSONA, renderSubagentPersona } from "../../kaz-shared/lib/roles.js";
import { normalizeEntry, patchEntryAt, writeArrangement } from "./arrangement.js";
import { KAZ_FORK_PROVIDER, noteForkSource } from "./fork-provider.js";
import { LEGAL_TRANSITIONS, STAGES } from "./stages.js";

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
    name: "write-arrangement",
    description:
      'Record this round\'s dispatch plan for the current conversation (usable only in the arrange_agent stage). Entries: { persona, blacklist?, task, fork? } — persona is "main", "memoryMaintainer", or [role, description]. The plan must contain memoryMaintainer: only it can write memories.',
    parameters: {
      entries: { type: "array", required: true, items: { type: "json" }, description: "The dispatch plan entries." },
    },
    output: { schema: RESULT_SCHEMA, render: RESULT_RENDER },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec);
      if (sessionId === undefined) return fail("this agent has no session");
      const stage = store.getStage(sessionId);
      if (stage !== "arrange_agent") return fail(`write-arrangement works only in the arrange_agent stage (current: ${stage})`);
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
    name: "get-arrangement",
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
      'Dispatch one arrangement entry as a subagent. Input is only the persona (the reserved value "memoryMaintainer" is the memory keeper); blacklist / task / fork come from the arrangement, and the task becomes the subagent\'s first message. Memory dispatches and their reports stay internal: never relay them to the user.',
    parameters: {
      persona: { type: "string", required: true, description: 'The arrangement entry to dispatch: "memoryMaintainer" or a custom role name.' },
    },
    output: { schema: TEXT_SCHEMA, render: TEXT_RENDER },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec);
      if (sessionId === undefined) return { ...fail("this agent has no session"), text: "" };
      const wanted = String(args?.persona ?? "").trim();
      if (wanted.length === 0) return { ...fail("persona is required"), text: "" };
      const entries = await store.loadEntries(sessionId);
      const index = entries.findIndex((entry) => personaKey(entry.persona) === wanted);
      if (index < 0) return { ...fail(`no arrangement entry with persona "${wanted}"`), text: "" };
      const entry = entries[index];
      if (entry.persona === "main") return { ...fail('the "main" entry is for the main agent itself; dispatch only subagent entries'), text: "" };
      const isKeeper = entry.persona === "memoryMaintainer";
      const personaText = isKeeper ? MEMORY_MAINTAINER_PERSONA : renderSubagentPersona(entry.persona[0], entry.persona[1]);
      const blacklist = isKeeper
        ? [...MEMORY_MAINTAINER_BLACKLIST]
        : sanitizeBlacklist([...SUBAGENT_DEFAULT_BLACKLIST, ...(Array.isArray(entry.blacklist) ? entry.blacklist : [])]);
      // 平台 toolFilter 遇到不存在的工具名会直接抛错：先按"平台已知的工具"过滤，跳过的写进回执。
      const known = knownToolNames(ctx, exec.agent);
      const applied = known === null ? blacklist : blacklist.filter((name) => known.has(name));
      const skipped = known === null ? [] : blacklist.filter((name) => !known.has(name));
      const skippedNote =
        skipped.length > 0 ? ` (blacklist skipped unknown tool${skipped.length > 1 ? "s" : ""}: ${skipped.join(", ")})` : "";
      const label = isKeeper ? "memoryMaintainer" : entry.persona[0];
      const forkTarget = typeof entry.fork === "string" ? entry.fork : "";
      let provider = "spawn";
      let forkSource = "";
      let note = "";
      if (forkTarget.length > 0) {
        const agents = ctx.get("agents");
        const sourceAgent = forkTarget === "main" ? exec.agent : agents?.get?.(forkTarget);
        if (sourceAgent === undefined || sourceAgent === null) {
          note = ` (fork target "${forkTarget}" is not a live session; started fresh instead — read that history with context_search companion="${forkTarget}")`;
        } else {
          provider = KAZ_FORK_PROVIDER;
          forkSource = forkTarget === "main" ? "" : forkTarget;
          note = forkTarget === "main" ? " (forked from your conversation)" : ` (forked from "${forkTarget}")`;
        }
      }
      const subagents = ctx.get("subagents");
      if (subagents === undefined || subagents === null) {
        return { ...fail("the subagent registry is unavailable"), text: "" };
      }
      // 复用（旧 kaz 的强制复用机制）：先在本对话的 continuable 子代理里按 label
      // （= 角色名）找同角色、且当前不在忙的那个 → 把新任务 sendMessage 给它；
      // 都在忙就先别派（等它报告）；找不到才新开一个。
      const agents = ctx.get("agents");
      const agentOf = (id) =>
        agents !== undefined && agents !== null && typeof agents.get === "function" ? agents.get(id) : undefined;
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
      if (reusableId.length > 0 && typeof subagents.sendMessage === "function") {
        try {
          await subagents.sendMessage(exec.agent, reusableId, [{ type: "text", text: entry.task }], { signal: exec.signal });
        } catch (error) {
          return { ...fail(`continue failed: ${reason(error)}${skippedNote}`), text: "" };
        }
        const continued = await patchEntryAt(sessionCwdOf(exec), sessionId, index, { id: reusableId, status: "running" });
        store.setEntries(sessionId, continued);
        return { ok: true, message: `continued ${label} as ${reusableId} (reused, no new subagent)`, text: `subagent id: ${reusableId}` };
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

export function whaleReportTool({ store }) {
  return defineTool({
    name: "whale_report",
    description:
      "Advance the main agent's workflow stage. Targets: idle, arrange_agent.",
    parameters: {
      stage: { type: "string", required: true, enum: [...STAGES], description: "Target stage." },
    },
    output: { schema: RESULT_SCHEMA, render: RESULT_RENDER },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec);
      if (sessionId === undefined) return fail("this agent has no session");
      const target = String(args?.stage ?? "").trim();
      if (!STAGES.includes(target)) return fail(`unknown stage "${target}"; known stages: ${STAGES.join(", ")}`);
      const current = store.getStage(sessionId);
      if (target !== current && !LEGAL_TRANSITIONS[current].includes(target)) {
        return fail(`cannot go from ${current} to ${target}; legal from ${current}: ${LEGAL_TRANSITIONS[current].join(", ")}`);
      }
      store.setStage(sessionId, target);
      return ok(`stage: ${target}`);
    },
  });
}
