// ka-whale-memory —— 记忆文件的读写。
//
// 每个记忆一个 JSON：
//   内容记忆 { location, name, context, summary?, keywords?, updatedAt }
//   路径记忆 { location, name, paths,   summary?, keywords?, updatedAt }
// summary / keywords / updatedAt 是给 BM25 检索与排序用的附属字段（可缺省）。
// 写盘用临时文件 + rename（原子替换）。

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { KINDS, kindDir, memoryFile } from "./paths.js";

/** 记忆库根目录下的所有文件（某个 location + kind）。读不到目录时返回空。 */
export async function listMemories(location, kind, cwd) {
  const dir = kindDir(location, kind, cwd);
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const file = join(dir, entry);
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      continue;
    }
    const data = await readMemoryFile(file);
    if (data === null) continue;
    const name = typeof data.name === "string" && data.name.length > 0 ? data.name : entry.slice(0, -5);
    const updatedAt =
      typeof data.updatedAt === "string" && data.updatedAt.length > 0 ? data.updatedAt : new Date(stat.mtimeMs).toISOString();
    out.push({ name, kind, location, file, mtimeMs: stat.mtimeMs, updatedAt, data });
  }
  return out;
}

/** 按名字在所有（或指定）库 / 种类里找记忆；返回全部匹配。 */
export async function findByName(name, cwd, kinds = KINDS, locations = ["global", "local"]) {
  const matches = [];
  for (const location of locations) {
    for (const kind of kinds) {
      for (const entry of await listMemories(location, kind, cwd)) {
        if (entry.name === name) matches.push(entry);
      }
    }
  }
  return matches;
}

/** 读一个记忆文件；缺失或损坏返回 null。 */
export async function readMemoryFile(file) {
  try {
    const text = await fs.readFile(file, "utf8");
    const data = JSON.parse(text);
    return data !== null && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

/** keywords 规范化：只留非空字符串，去重保序。 */
export function normalizeKeywords(value) {
  const out = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed.length === 0 || out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}

/**
 * 写一个记忆文件（原子替换）。
 * @param {string} location - global / local。
 * @param {string} kind - context / paths。
 * @param {string} name - 记忆名。
 * @param {string} body - 正文。
 * @param {string} cwd - 项目目录（local 库的根）。
 * @param {{summary?: string, keywords?: readonly string[]}} [extra] - BM25 附属字段。
 * @returns {Promise<string>} 写好的文件路径。
 */
export async function writeMemory(location, kind, name, body, cwd, extra = {}) {
  const file = memoryFile(location, kind, name, cwd);
  await fs.mkdir(dirname(file), { recursive: true });
  const summary = typeof extra.summary === "string" ? extra.summary.trim() : "";
  const keywords = normalizeKeywords(extra.keywords);
  const data = {
    location,
    name,
    ...(kind === "context" ? { context: body } : { paths: body }),
    ...(summary.length > 0 ? { summary } : {}),
    ...(keywords.length > 0 ? { keywords } : {}),
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, file);
  return file;
}

/** 删除一个记忆文件。 */
export async function removeMemory(file) {
  await fs.rm(file, { force: true });
}
