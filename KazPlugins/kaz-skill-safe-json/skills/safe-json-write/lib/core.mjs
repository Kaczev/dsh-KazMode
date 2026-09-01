// safe-json-write core — pure, testable JSON safe-write logic
// ===========================================================================
// Guarantees:
//   - UTF-8 WITHOUT BOM (BOM breaks JSON.parse on Windows tooling).
//   - Out-of-bounds rejection: target must stay inside `root`.
//   - Backup of the previous target before any write.
//   - Rollback to previous content if the write/rename fails.
// ===========================================================================

import fs from "node:fs";
import path from "node:path";

/** Default encoding: UTF-8 without BOM (Node's 'utf8' never writes a BOM). */
export const UTF8_NO_BOM = "utf8";

/** Resolve `target` inside `root`, rejecting any path that escapes `root`. */
export function resolveTarget(root, target) {
  const rootAbs = path.resolve(root);
  const targetAbs = path.resolve(rootAbs, target);
  const rel = path.relative(rootAbs, targetAbs);
  const inside =
    rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (!inside) {
    throw new Error(
      `OUT_OF_BOUNDS: target "${target}" escapes root "${rootAbs}"`,
    );
  }
  return targetAbs;
}

/** Serialize data as pretty JSON with a trailing newline, never a BOM. */
export function serializeJson(data, space = 2) {
  return `${JSON.stringify(data, null, space)}\n`;
}

/**
 * Safely write JSON to `target`.
 *
 * @param {object} options
 * @param {string} options.target target file path (absolute or relative to root)
 * @param {any} options.data JSON-serializable value (object/array/primitive)
 * @param {string} [options.root=process.cwd()] confinement root
 * @param {number} [options.space=2] pretty-print indentation
 * @param {string|null} [options.backupDir=null] optional backup directory
 * @param {object} [deps] injectable fs functions for testing (writeFile/readFile/
 *   mkdirSync/renameSync/existsSync/rmSync)
 * @returns {{ok: true, target: string, bytes: number, backup: string|null, rolledBack: false}}
 */
export function writeJsonSafe(options = {}, deps = {}) {
  const {
    target,
    data,
    root = process.cwd(),
    space = 2,
    backupDir = null,
  } = options;

  if (target === undefined || target === null || target === "") {
    throw new Error("SAFE_JSON_WRITE_MISSING_TARGET: target is required");
  }
  if (data === undefined) {
    throw new Error("SAFE_JSON_WRITE_MISSING_DATA: data is required");
  }

  // NOTE: sync variants on purpose — the write must be atomic and rollback-capable
  // inside one call; async would need callback/promise plumbing for no benefit here.
  const writeFile = deps.writeFile || fs.writeFileSync;
  const readFile = deps.readFile || fs.readFileSync;
  const mkdirSync = deps.mkdirSync || fs.mkdirSync;
  const renameSync = deps.renameSync || fs.renameSync;
  const existsSync = deps.existsSync || fs.existsSync;
  const rmSync = deps.rmSync || fs.rmSync;

  const targetAbs = resolveTarget(root, target);
  const jsonText = serializeJson(data, space);

  const previous = existsSync(targetAbs)
    ? readFile(targetAbs, UTF8_NO_BOM)
    : null;

  // 1) Backup BEFORE touching the target. If backup fails, abort without mutating.
  let backupPath = null;
  if (previous !== null) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    if (backupDir) {
      mkdirSync(backupDir, { recursive: true });
      backupPath = path.join(
        backupDir,
        `${path.basename(targetAbs)}.bak-${stamp}`,
      );
    } else {
      backupPath = `${targetAbs}.bak-${stamp}`;
    }
    try {
      writeFile(backupPath, previous, UTF8_NO_BOM);
    } catch (error) {
      throw new Error(
        `SAFE_JSON_WRITE_BACKUP_FAILED: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // 2) Atomic-ish write: temp file in same directory, then rename.
  const tmpPath = `${targetAbs}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFile(tmpPath, jsonText, UTF8_NO_BOM);
    renameSync(tmpPath, targetAbs);
  } catch (error) {
    try {
      if (existsSync(tmpPath)) rmSync(tmpPath, { force: true });
    } catch {
      // best-effort cleanup
    }
    let rollbackError = null;
    if (previous !== null) {
      try {
        writeFile(targetAbs, previous, UTF8_NO_BOM);
      } catch (rbError) {
        rollbackError =
          rbError instanceof Error ? rbError.message : String(rbError);
      }
    }
    const wrapped = new Error(
      `SAFE_JSON_WRITE_FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    wrapped.cause = error;
    wrapped.rollbackError = rollbackError;
    wrapped.target = targetAbs;
    throw wrapped;
  }

  return {
    ok: true,
    target: targetAbs,
    bytes: Buffer.byteLength(jsonText, UTF8_NO_BOM),
    backup: backupPath,
    rolledBack: false,
  };
}
