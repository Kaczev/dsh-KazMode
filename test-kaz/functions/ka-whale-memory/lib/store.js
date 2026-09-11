// ka-whale-memory —— 记忆文件的读写。
//
// 每个记忆一个 JSON：内容记忆 { location, name, context }；
// 路径记忆 { location, name, paths }。写盘用临时文件 + rename（原子替换）。

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { KINDS, kindDir, makeId, memoryFile } from "./paths.js";

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
    out.push({ id: makeId(location, kind, name), name, kind, location, file, mtimeMs: stat.mtimeMs });
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

/** 目标文件是否已存在（同名同库同类的判重）。 */
export async function memoryExists(location, kind, name, cwd) {
  try {
    await fs.access(memoryFile(location, kind, name, cwd));
    return true;
  } catch {
    return false;
  }
}

/** 写一个记忆文件（原子替换）。 */
export async function writeMemory(location, kind, name, body, cwd) {
  const file = memoryFile(location, kind, name, cwd);
  await fs.mkdir(dirname(file), { recursive: true });
  const data = kind === "context" ? { location, name, context: body } : { location, name, paths: body };
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, file);
  return file;
}

/** 删除一个记忆文件。 */
export async function removeMemory(file) {
  await fs.rm(file, { force: true });
}
