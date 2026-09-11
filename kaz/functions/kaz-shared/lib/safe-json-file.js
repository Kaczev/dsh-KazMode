// kaz-shared —— 安全 JSON 文件写入小工具（供生命周期执行器等 I/O 层复用）
// ===========================================================================
// 语义与 safe-json-write 技能一致（但不依赖该私有工具，避免执行器自举递归）：
//   1) UTF-8 无 BOM；
//   2) 覆盖前先备份（可指定 backupDir）；
//   3) 写临时文件后原子 rename，失败自动回滚；
//   4) 返回 { ok, target, bytes, backup, rolledBack }，异常也归一化为 ok:false。
// 纯函数模块上层（skill-lifecycle.js）不 import 本文件，保持 audit 决策可离线。
// ===========================================================================

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

function safeMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 安全写一个 JSON 文件。
 * @param {string} file 目标路径
 * @param {unknown} data JSON 可序列化值
 * @param {{ backupDir?: string|null, space?: number }} [options]
 */
export function writeJsonFileSafe(file, data, options = {}) {
  if (typeof file !== "string" || file.trim().length === 0) {
    return { ok: false, error: "invalid target path" };
  }
  const backupDir =
    options?.backupDir !== undefined && options?.backupDir !== null && String(options.backupDir).trim().length > 0
      ? String(options.backupDir).trim()
      : null;
  const space = Number.isInteger(options?.space) && options.space >= 0 ? options.space : 2;
  let backup = null;
  try {
    let text;
    try {
      text = JSON.stringify(data, null, space) + String.fromCharCode(10);
    } catch (error) {
      return { ok: false, error: "json stringify failed: " + safeMessage(error) };
    }
    const dir = dirname(file);
    mkdirSync(dir, { recursive: true });
    if (existsSync(file)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const name = file.includes("/") || file.includes("\\") ? file.split(/[\\/]/).pop() : file;
      const backupPath = backupDir !== null ? join(backupDir, `${name}.${stamp}.bak`) : `${file}.${stamp}.bak`;
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(file, backupPath);
      backup = backupPath;
    }
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, text, { encoding: "utf8", flag: "w" });
    renameSync(temp, file);
    return {
      ok: true,
      target: file,
      bytes: Buffer.byteLength(text, "utf8"),
      backup,
      rolledBack: false,
    };
  } catch (error) {
    // 尽力回滚：删除临时文件；若已有备份且目标被改写/缺失，则恢复备份。
    try {
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
      if (existsSync(temp)) rmSync(temp, { force: true });
    } catch {
      // best-effort
    }
    let rolledBack = false;
    if (backup !== null && existsSync(backup)) {
      try {
        copyFileSync(backup, file);
        rolledBack = true;
      } catch {
        rolledBack = false;
      }
    }
    return { ok: false, error: safeMessage(error), backup, rolledBack };
  }
}

/** 读 JSON 文件（去 BOM）；缺失/损坏返回 { ok:false }。 */
export function readJsonFileSafe(file) {
  if (typeof file !== "string" || file.length === 0) return { ok: false, error: "invalid path" };
  try {
    if (!existsSync(file)) return { ok: false, error: "not found" };
    let raw = readFileSync(file, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return { ok: true, data: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, error: safeMessage(error) };
  }
}
