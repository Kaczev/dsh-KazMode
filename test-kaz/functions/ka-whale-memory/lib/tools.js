// ka-whale-memory —— 记忆六工具。
// 输入 / 处理 / 输出按《Kaz8.0设计.md》§3.1–3.6；工具面文案一律英文。
// 输出只给 name（不含 id）；name 全局唯一（跨种类、跨库），按名字即唯一命中。
//
//   memory_search  BM25 相关度检索（global + local 一起排名）
//   memory_detail  按名字打开一条记忆的正文
//   memory_list    按时间（新→旧）列出记忆
//   memory_save    新建一条记忆（重名拒绝）
//   memory_update  替换一条记忆的正文（不改名字、不换类型）
//   memory_forget  按名字删除一条记忆

import { defineTool } from "@deepseek-ai/dsh-tools";
import { scoreBM25 } from "./bm25.js";
import { DEFAULT_ENVIRONMENT_NAME, KINDS } from "./paths.js";
import { findByName, listMemories, readMemoryFile, removeMemory, writeMemory } from "./store.js";
import { readEnvironment, writeEnvironment } from "./environment-store.js";

const ALL_LOCATIONS = ["global", "local"];

/**
 * 字段尺寸上限（UTF-8 **字节**，不是字符数）——字节即"体积"：一个汉字 3 字节、
 * 一个英文字母 1 字节，所以同一套上限对中英混写都成立（英文能写更多字）。
 * 依据：summary 每次检索都会随结果返回（memory_search 默认 10 条、memory_list
 * 默认 16 条），所以它必须比正文紧得多；正文只在 memory_detail 打开那一条时才进上下文。
 * environment 另有一个更紧的上限（1024）且必须纯英文：它会被 `kaz-environment`
 * 注入**每一次**系统提示（persona 之下、官方工具提示之上），是常驻开销。
 * 超限一律**报错拒绝**，绝不静默截断——截断会让人以为整条存进去了。
 * 只对新写入生效：加限制之前存下的超额条目原样保留。
 */
export const SIZE_LIMITS = Object.freeze({ name: 64, summary: 128, body: 4096, environment: 1024 });

const utf8 = new TextEncoder();

/** 文本的 UTF-8 字节数（非字符串按空串计）。 */
export function byteSize(value) {
  return utf8.encode(typeof value === "string" ? value : "").length;
}

/** environment 的**英文限制**：只允许 ASCII（0x20–0x7E 可打印字符 + 换行/制表）。
 *  理由：它会被注入系统提示，且按设计只用英文写——出现任何非 ASCII 字符即拒绝。 */
export function englishProblem(value) {
  if (typeof value !== "string") return null;
  const bad = [...new Set([...value].filter((ch) => ch.codePointAt(0) > 0x7e))].slice(0, 8).join("");
  return bad.length === 0 ? null : `environment must be written in English (ASCII) only — remove these characters: ${bad}`;
}

/** 一条记忆的最终字段尺寸；@returns {string|null} 超限时的英文拒绝原因，合规返回 null。 */
export function sizeProblem(fields) {
  const byKind =
    fields.bodyLabel === "environment"
      ? ["environment", fields.body, SIZE_LIMITS.environment]
      : [fields.bodyLabel ?? "body", fields.body, SIZE_LIMITS.body];
  const checks = [
    ["name", fields.name, SIZE_LIMITS.name],
    ["summary", fields.summary, SIZE_LIMITS.summary],
    byKind,
  ];
  for (const [label, value, limit] of checks) {
    const size = byteSize(value);
    if (size > limit) return `${label} is ${size} bytes (limit ${limit}) — shorten it`;
  }
  return null;
}

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

/** 把一处记忆说成人话：`global context "名称"`。 */
const describe = (entry) => `${entry.location} ${entry.kind} "${entry.name}"`;

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
        if (body !== null) {
          const summary = typeof entry.data?.summary === "string" ? entry.data.summary : "";
          docs.push({ name: entry.name, text: indexTextOf(entry, body), summary });
        }
      }
    }
  }
  return docs;
}

/**
 * BM25 文档文本：正文 + summary + keywords。keywords 计两遍（轻度加权）——
 * 显式写下的关键词，比正文里偶然出现的同一个词更值得被检索命中。
 */
function indexTextOf(entry, body) {
  const summary = typeof entry.data?.summary === "string" ? entry.data.summary : "";
  const keywords = Array.isArray(entry.data?.keywords)
    ? entry.data.keywords.filter((word) => typeof word === "string" && word.length > 0)
    : [];
  const parts = [body];
  if (summary.length > 0) parts.push(summary);
  if (keywords.length > 0) {
    const joined = keywords.join(" ");
    parts.push(joined, joined);
  }
  return parts.join("\n");
}

/** 排序用的时间：优先文件里的 updatedAt，缺失/非法回退 mtime。 */
function timeOf(entry) {
  const parsed = Date.parse(entry.updatedAt);
  return Number.isFinite(parsed) ? parsed : entry.mtimeMs;
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

/** 列表结果：每条给出 name + summary（summary 没有就是空串）。 */
const NAMES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      required: true,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", required: true },
          summary: { type: "string", required: true },
        },
      },
    },
  },
};

const namesRender = (_args, value) => renderText(value.items.length > 0 ? JSON.stringify(value.items) : "no memories matched");

/** 列表项：name + summary。 */
const itemOf = (name, summary) => ({
  name,
  summary: typeof summary === "string" ? summary : "",
});

const present = (title, rawInput) => ({ card: "generic", title, kind: "other", rawInput });

export function memorySearchTool() {
  return defineTool({
    name: "memory_search",
    description:
      "Search memories by BM25 relevance over their bodies, summaries, and keywords; global and local memories are ranked together. Read-only. Returns up to `limit` memories as name + summary, most relevant first; open one with memory_detail.",
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
      const summaryByName = new Map(docs.map((doc) => [doc.name, doc.summary]));
      return { items: ranked.slice(0, limit).map((hit) => itemOf(hit.name, summaryByName.get(hit.name))) };
    },
    presentCall: (args) => present("Search memories", args),
  });
}

export function memoryDetailTool() {
  return defineTool({
    name: "memory_detail",
    description:
      "Open a memory by name and return its body: the context of a content memory or the paths of a path memory. Read-only. Names are unique, so a name identifies exactly one memory.",
    parameters: {
      name: { type: "string", required: true, description: "Exact memory name." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          found: { type: "boolean", required: true },
          body: { type: "string", required: true },
        },
      },
      render: (args, value) => (value.found ? renderText(value.body) : renderText(`failure: no memory named "${String(args.name ?? "")}"`)),
    },
    async execute(args, exec) {
      const cwd = cwdOf(exec);
      const name = String(args.name ?? "").trim();
      if (name.length === 0) return { found: false, body: "" };
      const matches = await findByName(name, cwd);
      if (matches.length === 0) {
        // environment 记忆不经记忆工具读取：它只由 kaz-environment 注入系统提示。
        const environment = (await Promise.all(ALL_LOCATIONS.map((location) => readEnvironment(location, cwd))))
          .filter((entry) => entry !== null)
          .find((entry) => entry.name === name);
        if (environment !== undefined) {
          return {
            found: false,
            body: `failure: "${name}" is an environment memory (${environment.location}) — its content is injected into the system prompt every turn and is not readable through memory tools`,
          };
        }
        return { found: false, body: "" };
      }
      const body = await bodyOf(matches[0]);
      if (body === null) return { found: false, body: "" };
      return { found: true, body };
    },
    presentCall: (args) => present("Open memory", args),
  });
}

export function memoryListTool() {
  return defineTool({
    name: "memory_list",
    description: "List memories as name + summary across the selected stores, newest first. Read-only.",
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
      all.sort((a, b) => timeOf(b) - timeOf(a));
      return {
        items: all.slice(0, limit).map((entry) => itemOf(entry.name, typeof entry.data?.summary === "string" ? entry.data.summary : "")),
      };
    },
    presentCall: (args) => present("List memories", args),
  });
}

export function memorySaveTool() {
  return defineTool({
    name: "memory_save",
    description:
      "Save a new memory as its own file. Provide exactly one of `context` (a content memory), `paths` (a path memory) or `environment` (machine/environment facts injected into the system prompt every turn — English only, one per store). Names are unique across both kinds and both stores, so an existing name is rejected — use memory_update to replace its body. Size caps (UTF-8 bytes): name 64, summary 128, body 4096, environment 1024 — oversize input is rejected, so summarize rather than paste.",
    parameters: {
      location: { type: "string", required: true, enum: ["global", "local"], description: "Which store to write: global or local." },
      name: { type: "string", required: true, description: "Memory name (also its file name); unique across all memories. For an environment memory use `environment`." },
      context: { type: "string", description: "Content-memory body. Mutually exclusive with `paths` and `environment`." },
      paths: { type: "string", description: "Path-memory body. Mutually exclusive with `context` and `environment`." },
      environment: { type: "string", description: "Environment-memory body: machine/environment facts injected into the system prompt every turn. Must be English (ASCII only) and at most 1024 bytes. Mutually exclusive with `context` and `paths`; one per store." },
      summary: { type: "string", description: "Optional one-line summary; indexed by search. Keep it short: it comes back with every search hit." },
      keywords: { type: "array", items: { type: "string" }, description: "Optional keywords; indexed with extra weight by search." },
    },
    output: { schema: RESULT_SCHEMA, render: RESULT_RENDER },
    async execute(args, exec) {
      const cwd = cwdOf(exec);
      const location = args.location;
      const name = String(args.name ?? "").trim();
      const hasContext = typeof args.context === "string" && args.context.length > 0;
      const hasPaths = typeof args.paths === "string" && args.paths.length > 0;
      const hasEnvironment = typeof args.environment === "string" && args.environment.length > 0;
      if (location !== "global" && location !== "local") return fail("location must be global or local");
      if (name.length === 0) return fail("name must be a non-empty string");
      const given = [hasContext, hasPaths, hasEnvironment].filter(Boolean).length;
      if (given > 1) return fail("context, paths and environment are mutually exclusive — give exactly one");
      if (given === 0) return fail("give exactly one of context, paths or environment");
      if (hasEnvironment) {
        const problem = englishProblem(args.environment) ?? sizeProblem({ name, body: args.environment, bodyLabel: "environment", summary: "" });
        if (problem !== null) return fail(problem);
        const current = await readEnvironment(location, cwd);
        if (current !== null) {
          return fail(`the ${location} environment memory already exists (name "${current.name}") — use memory_update to replace its body`);
        }
        await writeEnvironment(location, name, args.environment, cwd);
        return ok(`saved ${location} environment "${name}"`);
      }
      const kind = hasContext ? "context" : "paths";
      const body = hasContext ? args.context : args.paths;
      const problem = sizeProblem({
        name,
        body,
        bodyLabel: kind,
        summary: typeof args.summary === "string" ? args.summary : "",
      });
      if (problem !== null) return fail(problem);
      const existing = await findByName(name, cwd);
      if (existing.length > 0) {
        return fail(`"${name}" already exists as ${describe(existing[0])} — use memory_update to replace its body`);
      }
      await writeMemory(location, kind, name, body, cwd, { summary: args.summary, keywords: args.keywords });
      return ok(`saved ${location} ${kind} "${name}"`);
    },
    presentCall: (args) => present("Save memory", args),
  });
}

export function memoryUpdateTool() {
  return defineTool({
    name: "memory_update",
    description:
      "Replace the body of an existing memory. Provide exactly one of `context`, `paths` or `environment`, matching the memory's kind; its name, kind, and store stay unchanged. Size caps (UTF-8 bytes): summary 128, body 4096, environment 1024 — oversize input is rejected.",
    parameters: {
      name: { type: "string", required: true, description: "Exact memory name." },
      context: { type: "string", description: "New body for a content memory. Mutually exclusive with `paths` and `environment`." },
      paths: { type: "string", description: "New body for a path memory. Mutually exclusive with `context` and `environment`." },
      environment: { type: "string", description: "New body for the environment memory (injected into the system prompt; English/ASCII only, at most 1024 bytes). Mutually exclusive with `context` and `paths`." },
      summary: { type: "string", description: "Optional new one-line summary; omit to keep the current one." },
      keywords: { type: "array", items: { type: "string" }, description: "Optional new keywords; omit to keep the current ones." },
    },
    output: { schema: RESULT_SCHEMA, render: RESULT_RENDER },
    async execute(args, exec) {
      const cwd = cwdOf(exec);
      const name = String(args.name ?? "").trim();
      const hasContext = typeof args.context === "string" && args.context.length > 0;
      const hasPaths = typeof args.paths === "string" && args.paths.length > 0;
      const hasEnvironment = typeof args.environment === "string" && args.environment.length > 0;
      if (name.length === 0) return fail("name must be a non-empty string");
      const given = [hasContext, hasPaths, hasEnvironment].filter(Boolean).length;
      if (given !== 1) return fail("give exactly one of context, paths or environment");
      const kind = hasContext ? "context" : hasPaths ? "paths" : "environment";
      const body = hasContext ? args.context : hasPaths ? args.paths : args.environment;
      if (kind === "environment") {
        const problem = englishProblem(body) ?? sizeProblem({ name, body, bodyLabel: "environment", summary: "" });
        if (problem !== null) return fail(problem);
        // environment 每个 location 只有一条：按 name 定位它存在哪个库，再原地替换。
        const existing = (await Promise.all(ALL_LOCATIONS.map((location) => readEnvironment(location, cwd))))
          .filter((entry) => entry !== null);
        const hit = existing.find((entry) => entry.name === name);
        if (hit === undefined) {
          return fail(`no environment memory named "${name}" to update — create it with memory_save (kind environment)`);
        }
        await writeEnvironment(hit.location, name, body, cwd);
        return ok(`updated ${hit.location} environment "${name}"`);
      }
      const matches = await findByName(name, cwd);
      if (matches.length === 0) return fail(`no memory named "${name}" to update`);
      const memory = matches[0];
      if (memory.kind !== kind) {
        return fail(`"${name}" is a ${memory.location} ${memory.kind} memory — give the matching body field`);
      }
      const current = await readMemoryFile(memory.file);
      const summary = typeof args.summary === "string" ? args.summary : typeof current?.summary === "string" ? current.summary : "";
      const keywords = Array.isArray(args.keywords) ? args.keywords : Array.isArray(current?.keywords) ? current.keywords : [];
      // 校验的是"改完之后"的结果：name 不能改，summary 省略即沿用旧值。
      const problem = sizeProblem({ name: memory.name, body, bodyLabel: memory.kind, summary });
      if (problem !== null) return fail(problem);
      await writeMemory(memory.location, memory.kind, memory.name, body, cwd, { summary, keywords });
      return ok(`updated ${describe(memory)}`);
    },
    presentCall: (args) => present("Update memory", args),
  });
}

export function memoryForgetTool() {
  return defineTool({
    name: "memory_forget",
    description: "Permanently delete a memory by name. Fails when nothing matches.",
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
      await removeMemory(matches[0].file);
      return ok(`forgot ${describe(matches[0])}`);
    },
    presentCall: (args) => present("Forget memory", args),
  });
}
