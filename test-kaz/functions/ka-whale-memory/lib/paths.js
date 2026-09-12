// ka-whale-memory —— 记忆库路径与文件命名。
//
// 布局（每个记忆一个 JSON 文件）：
//   global：<dsh home>/storages/ka-whale-memory/<context|paths>/<文件>.json
//   local ：<会话 cwd>/.dsh/storages/ka-whale-memory/<context|paths>/<文件>.json
//
// environment 是例外（第三种 kind）：**固定文件名**，不分目录、不按 name 命名——
//   global：<dsh home>/storages/ka-whale-memory/environment.json
//   local ：<会话 cwd>/.dsh/storages/ka-whale-memory/environment.json
// 所以它**不在 KINDS 里**（KINDS 的语义是"有目录的 kind"），走 environmentFilePath()。
//
// 文件名由 name 决定（确定性）：name 本身安全时直接用；被安全化改动过
// （替换非法字符 / 截断 / 保留设备名）时附加 name 的短哈希防碰撞。

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 有目录的记忆种类：内容记忆 context / 路径记忆 paths。environment 另走一条路，见下。 */
export const KINDS = Object.freeze(["context", "paths"]);

/** environment 记忆的 kind 名（第三种）。 */
export const ENVIRONMENT_KIND = "environment";

/** environment 记忆的固定文件名与默认 name。 */
export const ENVIRONMENT_FILE_NAME = "environment.json";
export const DEFAULT_ENVIRONMENT_NAME = "environment";

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

/**
 * 项目根（= 会话 cwd，local 库的根）：从本文件一路向上，找出**祖先里名字恰好为 `.dsh` 的那一层**，
 * 返回它的父目录。取"最高的那个 .dsh"（而不是第一个遇到的），这样两层布局都对：
 *   主区：`<项目>\.dsh\.agent-presets\kaz\functions\ka-whale-memory\lib\` → `<项目>\.dsh` → `<项目>`
 *   仓库里的测试副本：`<home>\.agent-presets\kaz\functions\ka-whale-memory\lib\` → 祖先里没有 `.dsh` → 返回 home
 * 不用固定层数（两种布局深度不同，写死会错），也不用"找第一个不含 .agent-presets 的祖先"
 * （在测试机上那样会提前命中 `.dsh-test` 这个 home）。
 */
export function projectRoot() {
  const fallback = fileURLToPath(new URL("..", import.meta.url));
  let highest = "";
  let dir = fallback;
  for (let i = 0; i < 24; i += 1) {
    const parent = dirname(dir);
    if (parent === dir) break; // 到盘根
    if (basename(parent) === ".dsh") highest = parent;
    dir = parent;
  }
  return highest === "" ? fallback : dirname(highest);
}

/**
 * environment 记忆的文件路径：一个 location 固定一个文件，没有 kind 子目录。
 * @param {string} location - global / local。
 * @param {string} cwd - 会话工作目录（local 库的根）。
 */
export function environmentFilePath(location, cwd) {
  if (location === "global") return join(dshHome(), "storages", MEMORY_DIR_NAME, ENVIRONMENT_FILE_NAME);
  if (location === "local") return join(cwd, ".dsh", "storages", MEMORY_DIR_NAME, ENVIRONMENT_FILE_NAME);
  throw new Error(`unknown memory location: ${String(location)}`);
}
