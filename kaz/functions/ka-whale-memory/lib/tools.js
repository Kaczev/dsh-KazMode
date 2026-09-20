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
import { clampInt } from "../../kaz-shared/lib/clamp-int.js";
import { boundedShown } from "../../kaz-shared/lib/echo.js";
import { scoreBM25 } from "./bm25.js";
import { KINDS } from "./paths.js";
import { findByName, listMemories, readMemoryFile, removeMemory, writeMemory } from "./store.js";

const ALL_LOCATIONS = ["global", "local"];

/**
 * 字段尺寸上限（UTF-8 **字节**，不是字符数）——字节即"体积"：一个汉字 3 字节、
 * 一个英文字母 1 字节，所以同一套上限对中英混写都成立（英文能写更多字）。
 * 依据：summary 每次检索都会随结果返回（memory_search 默认 10 条、memory_list
 * 默认 16 条），所以它必须比正文紧得多；正文只在 memory_detail 打开那一条时才进上下文。
 * 超限一律**报错拒绝**，绝不静默截断——截断会让人以为整条存进去了。
 * 只对新写入生效：加限制之前存下的超额条目原样保留。
 *
 * ⚠ **公布值与真实门禁是两个数**（别当成 bug 去"修正"，这是有意设计）：
 *   - `SIZE_LIMITS`（这份）是**公布值**，写在 memory_save / memory_update 的工具描述里，
 *     也是超限报错里报出来的数——**模型看到的、以及它照着优化的，都是这个**。
 *   - `GATE_LIMITS` 是**真实门禁**，为公布值的 1.2 倍。
 * 动因（实测）：写入者常"超一点点"，而为抹掉这一点点会**反复重写好几轮**（每次都要重算
 * 字节数、改措辞、再试）。留出 20% 余量后，这类轻微超限一次过；同时因为描述没变，
 * 模型的目标仍然是紧的，不会反过来把记忆写胖。
 * 报错也报**公布值**：若错误信息说 "limit 4096" 而实际放到 4915，那是自相矛盾，
 * 会让人以为门禁坏了。两者差值就是"缓冲区"，不对外表达。
 */
export const SIZE_LIMITS = Object.freeze({ name: 64, summary: 128, body: 4096 });

/**
 * 真实门禁 = 公布值 × 该系数。改动这里等于改"缓冲垫厚度"；
 * 想改对外口径请改 SIZE_LIMITS（并同步两份工具描述里的数字）。
 */
export const SIZE_LIMIT_SLACK = 1.2;

/** 真实门禁（字节）。写入校验用这个，报错文案报 SIZE_LIMITS。 */
export const GATE_LIMITS = Object.freeze({
  name: Math.round(SIZE_LIMITS.name * SIZE_LIMIT_SLACK),
  summary: Math.round(SIZE_LIMITS.summary * SIZE_LIMIT_SLACK),
  body: Math.round(SIZE_LIMITS.body * SIZE_LIMIT_SLACK),
});

const utf8 = new TextEncoder();

/** 文本的 UTF-8 字节数（非字符串按空串计）。 */
export function byteSize(value) {
  return utf8.encode(typeof value === "string" ? value : "").length;
}

/**
 * 一条记忆的最终字段尺寸。
 * 判定用 GATE_LIMITS（真实门禁，带 20% 缓冲），**报错文案报 SIZE_LIMITS（公布值）**——
 * 理由见文件上方 SIZE_LIMITS 的说明：报出来的数必须与工具描述里的数一致。
 * @returns {string|null} 超限时的英文拒绝原因，合规返回 null。
 */
export function sizeProblem(fields) {
  const checks = [
    ["name", fields.name, SIZE_LIMITS.name, GATE_LIMITS.name],
    ["summary", fields.summary, SIZE_LIMITS.summary, GATE_LIMITS.summary],
    [fields.bodyLabel ?? "body", fields.body, SIZE_LIMITS.body, GATE_LIMITS.body],
  ];
  for (const [label, value, advertised, gate] of checks) {
    const size = byteSize(value);
    if (size > gate) return `${label} is ${size} bytes (limit ${advertised}) — shorten it`;
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

/**
 * 把一处记忆说成人话：`global context "名称"`。
 *
 * 名字过 `boundedShown`：**写入**那条路有 `sizeProblem` 门禁（公布 64 / 真实 77 字节），但
 * 读取这条路没有——**工具在门上把关，库本身不把**（与安排文件同一个边界）。所以库里已经躺着
 * 一条超长名字的记忆时（早先版本写的、或手改的文件），`forgot … "HHH…×50000"` 这种回执会
 * 把整个名字印进模型上下文（2026-09-21 实测 **50,022** 字）。这里界一次，三个调用点一起受益。
 */
const describe = (entry) => `${entry.location} ${entry.kind} ${boundedShown(entry.name)}`;

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
      render: (args, value) => (value.found ? renderText(value.body) : renderText(`failure: no memory named ${boundedShown(String(args.name ?? ""))}`)),
    },
    async execute(args, exec) {
      const cwd = cwdOf(exec);
      const name = String(args.name ?? "").trim();
      if (name.length === 0) return { found: false, body: "" };
      const matches = await findByName(name, cwd);
      if (matches.length === 0) return { found: false, body: "" };
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
      "Save a new memory as its own file. Provide exactly one of `context` (a content memory) or `paths` (a path memory). Names are unique across both kinds and both stores, so an existing name is rejected — use memory_update to replace its body. Size caps (UTF-8 bytes): name 64, summary 128, body 4096 — oversize input is rejected, so summarize rather than paste.",
    parameters: {
      location: { type: "string", required: true, enum: ["global", "local"], description: "Which store to write: global or local." },
      name: { type: "string", required: true, description: "Memory name (also its file name); unique across all memories." },
      context: { type: "string", description: "Content-memory body. Mutually exclusive with `paths`." },
      paths: { type: "string", description: "Path-memory body. Mutually exclusive with `context`." },
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
      if (location !== "global" && location !== "local") return fail("location must be global or local");
      if (name.length === 0) return fail("name must be a non-empty string");
      if (hasContext && hasPaths) return fail("context and paths cannot both be given");
      if (!hasContext && !hasPaths) return fail("give exactly one of context or paths");
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
        return fail(`${boundedShown(name)} already exists as ${describe(existing[0])} — use memory_update to replace its body`);
      }
      await writeMemory(location, kind, name, body, cwd, { summary: args.summary, keywords: args.keywords });
      return ok(`saved ${location} ${kind} ${boundedShown(name)}`);
    },
    presentCall: (args) => present("Save memory", args),
  });
}

export function memoryUpdateTool() {
  return defineTool({
    name: "memory_update",
    description:
      "Replace the body of an existing memory. Provide exactly one of `context` or `paths`, matching the memory's kind; its name, kind, and store stay unchanged. Size caps (UTF-8 bytes): summary 128, body 4096 — oversize input is rejected.",
    parameters: {
      name: { type: "string", required: true, description: "Exact memory name." },
      context: { type: "string", description: "New body for a content memory. Mutually exclusive with `paths`." },
      paths: { type: "string", description: "New body for a path memory. Mutually exclusive with `context`." },
      summary: { type: "string", description: "Optional new one-line summary; omit to keep the current one." },
      keywords: { type: "array", items: { type: "string" }, description: "Optional new keywords; omit to keep the current ones." },
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
      const matches = await findByName(name, cwd);
      if (matches.length === 0) return fail(`no memory named ${boundedShown(name)} to update`);
      const memory = matches[0];
      if (memory.kind !== kind) {
        return fail(`${boundedShown(name)} is a ${memory.location} ${memory.kind} memory — give the matching body field`);
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
      if (matches.length === 0) return fail(`no memory named ${boundedShown(name)}`);
      await removeMemory(matches[0].file);
      return ok(`forgot ${describe(matches[0])}`);
    },
    presentCall: (args) => present("Forget memory", args),
  });
}
