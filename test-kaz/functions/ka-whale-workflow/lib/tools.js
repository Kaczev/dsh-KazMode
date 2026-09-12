// ka-whale-workflow —— 工作流四工具（《Kaz8.0设计.md》§3.9）。
//   write-arrangement  写安排（只在 arrange_agent 阶段）
//   get-arrangement    查看安排（只读，任何阶段）
//   ka_sub_whale       按安排派发子代理（含 memoryMaintainer 保留值）
//   whale_report       推进阶段
// 文案一律英文。

import { defineTool } from "@deepseek-ai/dsh-tools";
import { MEMORY_MAINTAINER_BLACKLIST, sanitizeBlacklist } from "../../kaz-shared/lib/blacklists.js";
import { MEMORY_MAINTAINER_PERSONA, renderSubagentPersona } from "../../kaz-shared/lib/roles.js";
import { normalizeEntry, patchEntryAt, writeArrangement } from "./arrangement.js";
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

/** persona 的匹配键：字符串本身，或 [角色, 描述] 的角色名。 */
function personaKey(persona) {
  return Array.isArray(persona) ? persona[0] : typeof persona === "string" ? persona : "";
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
      const entries = [];
      for (const item of raw) {
        const { entry, error } = normalizeEntry(item);
        if (error !== undefined) return fail(error);
        entries.push(entry);
      }
      await writeArrangement(sessionId, entries);
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
      'Dispatch one arrangement entry as a subagent. Input is only the persona (the reserved value "memoryMaintainer" is the memory keeper); blacklist / task / fork come from the arrangement, and the task becomes the subagent\'s first message.',
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
      const blacklist = isKeeper ? [...MEMORY_MAINTAINER_BLACKLIST] : sanitizeBlacklist(entry.blacklist);
      const label = isKeeper ? "memoryMaintainer" : entry.persona[0];
      const forkTarget = typeof entry.fork === "string" ? entry.fork : "";
      let provider = "spawn";
      let note = "";
      if (forkTarget === "main") {
        provider = "fork";
      } else if (forkTarget.length > 0) {
        note = ` (fork target "${forkTarget}" is not supported: the platform forks the dispatcher's own log only; started fresh instead — read that history with context_search companion="${forkTarget}")`;
      }
      const subagents = ctx.get("subagents");
      if (subagents === undefined || typeof subagents.startContinuable !== "function") {
        return { ...fail("the subagent registry is unavailable"), text: "" };
      }
      const request = {
        label,
        prompt: [{ type: "text", text: entry.task }],
        parent: exec.agent,
        persona: personaText,
        ...(blacklist.length > 0 ? { toolFilter: { deny: blacklist } } : {}),
      };
      let started;
      try {
        started = await subagents.startContinuable({ provider, label, request, signal: exec.signal });
      } catch (error) {
        return { ...fail(`dispatch failed: ${reason(error)}${note}`), text: "" };
      }
      const childId = started?.childId ?? "";
      const next = await patchEntryAt(sessionId, index, { id: childId, status: "running" });
      store.setEntries(sessionId, next);
      return { ok: true, message: `dispatched ${label} as ${childId} (${provider})${note}`, text: `subagent id: ${childId}` };
    },
  });
}

export function whaleReportTool({ store }) {
  return defineTool({
    name: "whale_report",
    description:
      "Advance the main agent's workflow stage and trigger the new stage's injection. Targets: idle, arrange_agent, memory.",
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
