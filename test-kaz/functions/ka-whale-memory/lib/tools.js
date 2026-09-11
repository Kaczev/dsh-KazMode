// ka-whale-memory —— 记忆六工具。
// 输入 / 处理 / 输出按《Kaz8.0设计.md》§3.1–3.6；工具面文案一律英文。
// 输出只给 name——name 就是标识（不含 id）。
//
//   memory_search  BM25 相关度检索（global + local 一起排名）
//   memory_detail  按名字打开一条记忆的正文
//   memory_list    按时间（新→旧）列出记忆
//   memory_save    新建一条记忆（同类同库不允许重名）
//   memory_update  替换一条记忆的正文（不改名字、不换类型）
//   memory_forget  按名字删除一条记忆

import { defineTool } from "@deepseek-ai/dsh-tools";
import { scoreBM25 } from "./bm25.js";
import { KINDS } from "./paths.js";
import { findByName, listMemories, memoryExists, readMemoryFile, removeMemory, writeMemory } from "./store.js";

const ALL_LOCATIONS = ["global", "local"];

const renderText = (value) => [{ type: "text", text: value }];

/** 会话工作目录（local 库的根）：agent 会话 header 的 cwd。 */
function cwdOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
}

function locationsOf(value) {
  return value === "global" || value === "local" ? [value] : [...ALL_LOCATIONS];
}

function kindsOf(value) {
  return value === "context" || value === "paths" ? [value] : [...KINDS];
}

function clampInt(value, fallback, min, max) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 把一处匹配说成人话：`global context "名称"`。 */
const describe = (entry) => `${entry.location} ${entry.kind} "${entry.name}"`;

/** 把多处匹配说成人话：`global context, local paths`。 */
const describeAll = (entries) => entries.map((entry) => `${entry.location} ${entry.kind}`).join(", ");

/** 读出记忆正文：内容记忆 → context，路径记忆 → paths。 */
async function bodyOf(entry) {
  const data = await readMemoryFile(entry.file);
  if (data === null) return null;
  const body = entry.kind === "context" ? data.context : data.paths;
  return typeof body === "string" ? body : null;
}

async function collectDocs(kinds, locations, cwd) {
  const docs = [];
  for (const location of locations) {
    for (const kind of kinds) {
      for (const entry of await listMemories(location, kind, cwd)) {
        const body = await bodyOf(entry);
        if (body !== null) docs.push({ name: entry.name, text: body });
      }
    }
  }
  return docs;
}

const ok = (message) => ({ ok: true, message });
const fail = (message) => ({ ok: false, message });

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean", required: true },
    message: { type: "string", required: true },
  },
};

const RESULT_RENDER = (_args, value) => renderText(value.ok ? "success" : `failure: ${value.message}`);

/** 只输出 name 的列表结果。 */
const NAMES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      required: true,
      items: { type: "string" },
    },
  },
};

const namesRender = (_args, value) => renderText(value.items.length > 0 ? JSON.stringify(value.items) : "no memories matched");

const present = (title, rawInput) => ({ card: "generic", title, kind: "other", rawInput });

export function memorySearchTool() {
  return defineTool({
    name: "memory_search",
    description:
      "Search memories by BM25 relevance over their bodies; global and local memories are ranked together. Read-only. Returns up to `limit` memory names, most relevant first; open one with memory_detail.",
    parameters: {
      keywords: { type: "string", required: true, description: "Keywords to search for." },
      kind: { type: "string", enum: ["context", "paths"], description: "Which kind to search; omit to search both." },
      location: { type: "string", enum: ["global", "local", "both"], description: "Which store to search: global, local, or both (default)." },
      limit: { type: "integer", description: "Maximum number of results (default 10, max 16)." },
    },
    output: {
      schema: NAMES_SCHEMA,
      render: namesRender,
    },
    async execute(args, exec) {
      const cwd = cwdOf(exec);
      const limit = clampInt(args.limit, 10, 1, 16);
      const docs = await collectDocs(kindsOf(args.kind), locationsOf(args.location), cwd);
      const ranked = scoreBM25(String(args.keywords ?? ""), docs);
      return { items: ranked.slice(0, limit).map((hit) => hit.name) };
    },
    presentCall: (args) => present("Search memories", args),
  });
}

export function memoryDetailTool() {
  return defineTool({
    name: "memory_detail",
    description:
      "Open a memory by name and return its body: the context of a content memory or the paths of a path memory. Read-only. When the name matches more than one memory, every match is returned with its kind and store.",
    parameters: {
      name: { type: "string", required: true, description: "Exact memory name." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          found: { type: "boolean", required: true },
          matches: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string", required: true },
                kind: { type: "string", required: true },
                location: { type: "string", required: true },
                body: { type: "string", required: true },
              },
            },
          },
        },
      },
      render: (args, value) => {
        if (!value.found) return renderText(`failure: no memory named "${String(args.name ?? "")}"`);
        if (value.matches.length === 1) return renderText(value.matches[0].body);
        return renderText(JSON.stringify(value.matches));
      },
    },
    async execute(args, exec) {
      const cwd = cwdOf(exec);
      const name = String(args.name ?? "").trim();
      const matches = [];
      if (name.length > 0) {
        for (const entry of await findByName(name, cwd)) {
          const body = await bodyOf(entry);
          if (body !== null) {
            matches.push({ name: entry.name, kind: entry.kind, location: entry.location, body });
          }
        }
      }
      return { found: matches.length > 0, matches };
    },
    presentCall: (args) => present("Open memory", args),
  });
}

export function memoryListTool() {
  return defineTool({
    name: "memory_list",
    description: "List memory names across the selected stores, newest first. Read-only.",
    parameters: {
      location: { type: "string", enum: ["global", "local", "both"], description: "Which store to list: global, local, or both (default)." },
      limit: { type: "integer", description: "Maximum number of entries (default 16, max 32)." },
    },
    output: {
      schema: NAMES_SCHEMA,
      render: namesRender,
    },
    async execute(args, exec) {
      const cwd = cwdOf(exec);
      const limit = clampInt(args.limit, 16, 1, 32);
      const all = [];
      for (const location of locationsOf(args.location)) {
        for (const kind of KINDS) all.push(...(await listMemories(location, kind, cwd)));
      }
      all.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return { items: all.slice(0, limit).map((entry) => entry.name) };
    },
    presentCall: (args) => present("List memories", args),
  });
}

export function memorySaveTool() {
  return defineTool({
    name: "memory_save",
    description:
      "Save a new memory as its own file. Provide exactly one of `context` (a content memory) or `paths` (a path memory). A same-kind memory with the same name in the same store is rejected — use memory_update to replace an existing body.",
    parameters: {
      location: { type: "string", required: true, enum: ["global", "local"], description: "Which store to write: global or local." },
      name: { type: "string", required: true, description: "Memory name (also its file name); unique per store and kind." },
      context: { type: "string", description: "Content-memory body. Mutually exclusive with `paths`." },
      paths: { type: "string", description: "Path-memory body. Mutually exclusive with `context`." },
    },
    output: { schema: RESULT_SCHEMA, render: RESULT_RENDER },
    async execute(args, exec) {
      const cwd = cwdOf(exec);
      const location = args.location;
      const name = String(args.name ?? "").trim();
      const hasContext = typeof args.context === "string" && args.context.length > 0;
      const hasPaths = typeof args.paths === "string" && args.paths.length > 0;
      if (location !== "global" && location !== "local") return fail("location must be global or local");
      if (name.length === 0) return fail("name must be a non-empty string");
      if (hasContext && hasPaths) return fail("context and paths cannot both be given");
      if (!hasContext && !hasPaths) return fail("give exactly one of context or paths");
      const kind = hasContext ? "context" : "paths";
      const body = hasContext ? args.context : args.paths;
      if (await memoryExists(location, kind, name, cwd)) {
        return fail(`${location} ${kind} memory "${name}" already exists — use memory_update to replace its body`);
      }
      await writeMemory(location, kind, name, body, cwd);
      return ok(`saved ${location} ${kind} "${name}"`);
    },
    presentCall: (args) => present("Save memory", args),
  });
}

export function memoryUpdateTool() {
  return defineTool({
    name: "memory_update",
    description:
      "Replace the body of an existing memory. Provide exactly one of `context` or `paths`, matching the memory's kind; its name, kind, and store stay unchanged.",
    parameters: {
      name: { type: "string", required: true, description: "Exact memory name." },
      context: { type: "string", description: "New body for a content memory. Mutually exclusive with `paths`." },
      paths: { type: "string", description: "New body for a path memory. Mutually exclusive with `context`." },
    },
    output: { schema: RESULT_SCHEMA, render: RESULT_RENDER },
    async execute(args, exec) {
      const cwd = cwdOf(exec);
      const name = String(args.name ?? "").trim();
      const hasContext = typeof args.context === "string" && args.context.length > 0;
      const hasPaths = typeof args.paths === "string" && args.paths.length > 0;
      if (name.length === 0) return fail("name must be a non-empty string");
      if (hasContext === hasPaths) return fail("give exactly one of context or paths");
      const kind = hasContext ? "context" : "paths";
      const body = hasContext ? args.context : args.paths;
      const matches = await findByName(name, cwd, [kind]);
      if (matches.length === 0) {
        const otherKind = await findByName(name, cwd);
        if (otherKind.length > 0) {
          return fail(`"${name}" exists as ${describeAll(otherKind)} — give the matching body field`);
        }
        return fail(`no memory named "${name}" to update`);
      }
      if (matches.length > 1) {
        return fail(`"${name}" is ambiguous: it exists as ${describeAll(matches)}`);
      }
      await writeMemory(matches[0].location, matches[0].kind, matches[0].name, body, cwd);
      return ok(`updated ${describe(matches[0])}`);
    },
    presentCall: (args) => present("Update memory", args),
  });
}

export function memoryForgetTool() {
  return defineTool({
    name: "memory_forget",
    description:
      "Permanently delete a memory by name. Fails when nothing matches, and when the name is ambiguous (the matches are reported with their kind and store).",
    parameters: {
      name: { type: "string", required: true, description: "Exact memory name." },
    },
    output: { schema: RESULT_SCHEMA, render: RESULT_RENDER },
    async execute(args, exec) {
      const cwd = cwdOf(exec);
      const name = String(args.name ?? "").trim();
      if (name.length === 0) return fail("name must be a non-empty string");
      const matches = await findByName(name, cwd);
      if (matches.length === 0) return fail(`no memory named "${name}"`);
      if (matches.length > 1) {
        return fail(`"${name}" is ambiguous: it exists as ${describeAll(matches)}`);
      }
      await removeMemory(matches[0].file);
      return ok(`forgot ${describe(matches[0])}`);
    },
    presentCall: (args) => present("Forget memory", args),
  });
}
