// kaz-memory —— 记忆库路径与文件命名。
//
// 布局（每个记忆一个 JSON 文件）：
//   global：<dsh home>/storages/ka-whale-memory/<context|paths>/<文件>.json
//   local ：<会话 cwd>/.dsh/storages/ka-whale-memory/<context|paths>/<文件>.json
//
// 文件名由 name 决定（确定性）：name 本身安全时直接用；被安全化改动过
// （替换非法字符 / 截断 / 保留设备名）时附加 name 的短哈希防碰撞。

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

/** 记忆种类：内容记忆 context / 路径记忆 paths。 */
export const KINDS = Object.freeze(["context", "paths"]);

/** 记忆库目录名。 */
export const MEMORY_DIR_NAME = "ka-whale-memory";

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** dsh home：优先 DSH_HOME，否则 ~/.dsh。 */
export function dshHome() {
  const home = process.env.DSH_HOME;
  return typeof home === "string" && home.trim().length > 0 ? home.trim() : join(homedir(), ".dsh");
}

/** 某个 location 的记忆库根目录。 */
export function memoryRoot(location, cwd) {
  if (location === "global") return join(dshHome(), "storages", MEMORY_DIR_NAME);
  if (location === "local") return join(cwd, ".dsh", "storages", MEMORY_DIR_NAME);
  throw new Error(`unknown memory location: ${String(location)}`);
}

/** 某个 location + kind 的目录。 */
export function kindDir(location, kind, cwd) {
  return join(memoryRoot(location, cwd), kind);
}

/** name → 文件名（确定性、可逆性由文件内 name 字段保证）。 */
export function fileNameFor(name) {
  const safe = String(name)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  let base = safe.length > 0 ? safe.slice(0, 80) : "memory";
  if (WINDOWS_RESERVED.test(base)) base = `${base}_`;
  if (base === name) return base;
  const hash = createHash("sha1").update(String(name), "utf8").digest("hex").slice(0, 8);
  return `${base}~${hash}`;
}

/** 某个记忆的完整文件路径。 */
export function memoryFile(location, kind, name, cwd) {
  return join(kindDir(location, kind, cwd), `${fileNameFor(name)}.json`);
}

/** 记忆 id：`<location>:<kind>:<name>`。 */
export function makeId(location, kind, name) {
  return `${location}:${kind}:${name}`;
}
