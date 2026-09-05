// kaz-shared —— Kaz7.0 M2 树 store thin I/O adapter（node:fs / node:crypto 只在本层）
// ===========================================================================
// 依据：不入库文件/Kaz7.0更新规划/Kaz7.0开放点冻结决议.md
//       （权威最终基准 v1.2 §6.2：1M 兜底 = hiddenRootIds 渲染窗口）
// 边界：
//   * 纯逻辑在 lib/session-tree-store-core.js；本模块只负责目录/文件/checksum 注入；
//   * 快照 = 同目录临时文件 + fsync + rename；替换前先备份到 backups/；
//   * 写顺序 = 日志（raw/op/audit）先写，store.json 快照后写；
//   * 损坏回退 = op-replay → raw-only → 显式失败（missing-logs）；
//   * 1M fallback = 计算并持久化 state.hiddenRootIds；节点保留不删除、不归档移动；
//   * archive 读写能力保留供 M3 历史检索（可选）；fallbackTrim 不再写 archive；
//   * archive 默认无 TTL、本模块不提供自动删除；
//   * 不注册 cordis、不改 DSH 核心、不设 token 预算/触发字段。
// ===========================================================================

import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createSession, append, open, close, promote } from "./session-tree.js";
import { KAZ_CONTEXT_NATIVE_FALLBACK_STRATEGY } from "./context-compress.js";
import {
  KAZ_CONTEXT_ARCHIVE_FORMAT,
  KAZ_CONTEXT_ARCHIVE_VERSION,
  KAZ_CONTEXT_SESSION_SCHEMA,
  KAZ_CONTEXT_STORE_FORMAT,
  KAZ_CONTEXT_STORE_FORMAT_VERSION,
  canonicalStoreBody,
  normalizeStoreRecord,
  selectHiddenRootIds,
  validateSessionForStore,
  verifyStoreRecord,
} from "./session-tree-store-core.js";

// ---------------------------------------------------------------------------
// 常量 / 默认注入
// ---------------------------------------------------------------------------

const OP_TYPES = new Set(["append", "open", "close", "promote", "create"]);

function defaultSha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function defaultNow() {
  return new Date().toISOString();
}

const nodeIo = Object.freeze({
  exists: (file) => existsSync(file),
  mkdir: (dir) => mkdirSync(dir, { recursive: true }),
  readFile: (file) => readFileSync(file, "utf8"),
  writeFile: (file, text) => writeFileSync(file, text, { encoding: "utf8", flag: "w" }),
  appendFile: (file, text) => appendFileSync(file, text, { encoding: "utf8", flag: "a" }),
  rename: (from, to) => renameSync(from, to),
  copyFile: (from, to) => copyFileSync(from, to),
  readdir: (dir) => readdirSync(dir),
  rm: (file) => rmSync(file, { force: true }),
  fsync: (file) => {
    const fd = openSync(file, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
});

/** 默认 Kaz 私有 storages 根：<DSH_HOME|~/.dsh>/storages/kaz-context。 */
export function KAZ_CONTEXT_STORE_ROOT() {
  const homeBase = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(homeBase, "storages", "kaz-context");
}

/** 由真实 sessionId 生成安全会话目录 id：session-<sha256 前 16 hex>。 */
export function sessionDirIdOf(sessionId, hash = defaultSha256) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return "session-invalid";
  const hex = hash(sessionId);
  if (typeof hex !== "string" || hex.length === 0) return "session-invalid";
  return `session-${hex.slice(0, 16)}`;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function errorResult(code, message) {
  return { ok: false, code, error: message };
}

function okResult(extra) {
  return { ok: true, ...extra };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableSortDeep(value) {
  if (Array.isArray(value)) return value.map(stableSortDeep);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableSortDeep(value[key]);
    return out;
  }
  return value;
}

function stableJsonText(value) {
  return `${JSON.stringify(stableSortDeep(value), null, 2)}\n`;
}

function withoutChecksum(record) {
  const out = {};
  for (const key of Object.keys(record)) {
    if (key !== "checksum") out[key] = record[key];
  }
  return out;
}

function basename(file) {
  const parts = file.split(/[\\/]/);
  return parts[parts.length - 1];
}

function ioExists(io, file) {
  return typeof io.exists === "function" ? io.exists(file) : existsSync(file);
}

function ioMkdir(io, dir) {
  if (typeof io.mkdir === "function") io.mkdir(dir);
  else mkdirSync(dir, { recursive: true });
}

function ioReadFile(io, file) {
  if (typeof io.readFile === "function") return io.readFile(file);
  return readFileSync(file, "utf8");
}

function ioWriteFile(io, file, text) {
  if (typeof io.writeFile === "function") io.writeFile(file, text);
  else writeFileSync(file, text, { encoding: "utf8", flag: "w" });
}

function ioAppendFile(io, file, text) {
  if (typeof io.appendFile === "function") io.appendFile(file, text);
  else appendFileSync(file, text, { encoding: "utf8", flag: "a" });
}

function ioRename(io, from, to) {
  if (typeof io.rename === "function") io.rename(from, to);
  else renameSync(from, to);
}

function ioCopyFile(io, from, to) {
  if (typeof io.copyFile === "function") io.copyFile(from, to);
  else copyFileSync(from, to);
}

function ioReaddir(io, dir) {
  if (typeof io.readdir === "function") return io.readdir(dir);
  return readdirSync(dir);
}

function ioRm(io, file) {
  if (typeof io.rm === "function") io.rm(file);
  else rmSync(file, { force: true });
}

function ioFsync(io, file) {
  if (typeof io.fsync === "function") io.fsync(file);
}

// ---------------------------------------------------------------------------
// createSessionTreeStore
// ---------------------------------------------------------------------------

export function createSessionTreeStore(options = {}) {
  if (!isPlainObject(options)) {
    return {
      ...errorResult("invalid-options", "createSessionTreeStore options must be an object"),
      load: () => errorResult("invalid-options", "store not created"),
      save: () => errorResult("invalid-options", "store not created"),
      commitReducerResult: () => errorResult("invalid-options", "store not created"),
      fallbackTrim: () => errorResult("invalid-options", "store not created"),
      appendRaw: () => errorResult("invalid-options", "store not created"),
      appendOp: () => errorResult("invalid-options", "store not created"),
      listArchiveRefs: () => [],
      readArchive: () => null,
    };
  }
  if (typeof options.sessionId !== "string" || options.sessionId.length === 0) {
    return {
      ...errorResult("invalid-session-id", "sessionId must be a non-empty string"),
      load: () => errorResult("invalid-session-id", "store not created"),
      save: () => errorResult("invalid-session-id", "store not created"),
      commitReducerResult: () => errorResult("invalid-session-id", "store not created"),
      fallbackTrim: () => errorResult("invalid-session-id", "store not created"),
      appendRaw: () => errorResult("invalid-session-id", "store not created"),
      appendOp: () => errorResult("invalid-session-id", "store not created"),
      listArchiveRefs: () => [],
      readArchive: () => null,
    };
  }

  const sessionId = options.sessionId;
  const io = isPlainObject(options.io) ? options.io : nodeIo;
  const hash = typeof options.hash === "function" ? options.hash : defaultSha256;
  const now = typeof options.now === "function" ? options.now : defaultNow;
  const rootBase = typeof options.rootDir === "string" && options.rootDir.length > 0
    ? options.rootDir
    : KAZ_CONTEXT_STORE_ROOT();

  const sessionDirId = sessionDirIdOf(sessionId, hash);
  const sessionDir = join(rootBase, "sessions", sessionDirId);
  const storeFile = join(sessionDir, "store.json");
  const rawFile = join(sessionDir, "raw-events.jsonl");
  const opFile = join(sessionDir, "ops.jsonl");
  const archiveDir = join(sessionDir, "archive");
  const auditFile = join(sessionDir, "audit.jsonl");
  const backupsDir = join(sessionDir, "backups");

  let current = null; // { session, state, record }

  // --- low-level file helpers -------------------------------------------------

  function ensureSessionDir() {
    ioMkdir(io, sessionDir);
  }

  function readJsonLines(file) {
    if (!ioExists(io, file)) return { ok: true, entries: [], droppedTail: 0 };
    let text;
    try {
      text = ioReadFile(io, file);
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
    const entries = [];
    const rawLines = text.split(/\r?\n/);
    let droppedTail = 0;
    for (let i = 0; i < rawLines.length; i += 1) {
      const line = rawLines[i];
      if (line.trim().length === 0) continue;
      try {
        entries.push(JSON.parse(line));
      } catch (error) {
        // 最后一段（无后续行）视为崩溃半截尾行；更早的完整行损坏则标记。
        if (i === rawLines.length - 1) {
          droppedTail += 1;
        } else {
          return {
            ok: false,
            entries: [],
            corruptLine: i + 1,
            error: `invalid JSONL at line ${i + 1}: ${messageOf(error)}`,
          };
        }
      }
    }
    return { ok: true, entries, droppedTail };
  }

  function appendJsonLine(file, data) {
    ensureSessionDir();
    try {
      ioAppendFile(io, file, `${JSON.stringify(data)}\n`);
      return okResult();
    } catch (error) {
      return errorResult("io-error", `append ${basename(file)} failed: ${messageOf(error)}`);
    }
  }

  function appendAudit(entry) {
    const audit = {
      type: entry.type,
      at: now(),
      ...entry,
    };
    return appendJsonLine(auditFile, audit);
  }

  function writeJsonAtomic(file, data) {
    ensureSessionDir();
    ioMkdir(io, dirname(file));
    let backup = null;
    try {
      if (ioExists(io, file)) {
        ioMkdir(io, backupsDir);
        const stamp = now().replace(/[:.]/g, "-");
        backup = join(backupsDir, `${basename(file)}.${stamp}.bak`);
        ioCopyFile(io, file, backup);
      }
      const temp = join(dirname(file), `${basename(file)}.${process.pid}.${Date.now()}.tmp`);
      const text = typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`;
      ioWriteFile(io, temp, text);
      ioFsync(io, temp);
      ioRename(io, temp, file);
      return { ok: true, file, backup };
    } catch (error) {
      const temp = join(dirname(file), `${basename(file)}.${process.pid}.${Date.now()}.tmp`);
      try {
        if (ioExists(io, temp)) ioRm(io, temp);
      } catch {
        // best-effort cleanup
      }
      return { ok: false, error: messageOf(error), backup };
    }
  }

  function makeState(session, extra = {}) {
    return {
      lastRawSeq: 0,
      lastOpSeq: 0,
      lastAppliedOpSeq: 0,
      nextSessionSeq: session.nextSeq,
      nextSessionId: session.nextId,
      hiddenRootIds: [],
      ...extra,
    };
  }

  function makeStoreRecord(session, state, archiveRefs) {
    const base = {
      format: KAZ_CONTEXT_STORE_FORMAT,
      formatVersion: KAZ_CONTEXT_STORE_FORMAT_VERSION,
      sessionSchema: KAZ_CONTEXT_SESSION_SCHEMA,
      sessionId: session.id,
      updatedAt: now(),
      state,
      session,
      archiveRefs,
    };
    const body = canonicalStoreBody(base);
    if (typeof body !== "string") {
      return { ok: false, error: "canonicalStoreBody failed" };
    }
    return {
      ok: true,
      record: {
        ...base,
        checksum: { algorithm: "sha256", hex: hash(body) },
      },
    };
  }

  function writeStoreRecord(session, state, archiveRefs) {
    const made = makeStoreRecord(session, state, archiveRefs);
    if (!made.ok) return made;
    const written = writeJsonAtomic(storeFile, made.record);
    if (!written.ok) return written;
    return okResult({ record: made.record });
  }

  function readStoreRecord() {
    if (!ioExists(io, storeFile)) return { found: false };
    try {
      const text = ioReadFile(io, storeFile);
      const parsed = JSON.parse(text);
      return { found: true, parsed };
    } catch (error) {
      return { found: true, corrupt: messageOf(error) };
    }
  }

  function scanArchiveRefs() {
    if (!ioExists(io, archiveDir)) return [];
    const refs = [];
    let names;
    try {
      names = ioReaddir(io, archiveDir);
    } catch {
      return refs;
    }
    for (const name of names.filter((n) => /\.json$/i.test(n))) {
      const archiveId = name.replace(/\.json$/i, "");
      try {
        const text = ioReadFile(io, join(archiveDir, name));
        const record = JSON.parse(text);
        if (!isPlainObject(record)) continue;
        if (
          typeof record.archiveId !== "string" ||
          typeof record.blockId !== "string" ||
          typeof record.path !== "string" ||
          typeof record.removedAt !== "string" ||
          typeof record.reason !== "string"
        ) {
          continue;
        }
        refs.push({
          archiveId,
          blockId: typeof record.blockId === "string" ? record.blockId : "",
          path: typeof record.path === "string" ? record.path : "",
          removedAt: typeof record.removedAt === "string" ? record.removedAt : "",
          file: `archive/${name}`,
          reason: typeof record.reason === "string" ? record.reason : "",
        });
      } catch {
        // 单个损坏归档不阻塞其余引用列出
      }
    }
    return refs.sort((a, b) => a.archiveId.localeCompare(b.archiveId));
  }

  function nextArchiveNumber() {
    if (!ioExists(io, archiveDir)) return 1;
    let names;
    try {
      names = ioReaddir(io, archiveDir);
    } catch {
      return 1;
    }
    let max = 0;
    for (const name of names) {
      const match = /^arc-(\d+)\.json$/.exec(name);
      if (match) max = Math.max(max, Number(match[1]));
    }
    return max + 1;
  }

  // --- log / replay helpers ----------------------------------------------------

  function maxRawSeqFromFile() {
    const read = readJsonLines(rawFile);
    if (!read.ok) return 0;
    let max = 0;
    for (const entry of read.entries) {
      if (Number.isInteger(entry?.seq) && entry.seq > max) max = entry.seq;
    }
    return max;
  }

  function maxOpSeqFromFile() {
    const read = readJsonLines(opFile);
    if (!read.ok) return 0;
    let max = 0;
    for (const entry of read.entries) {
      if (Number.isInteger(entry?.opSeq) && entry.opSeq > max) max = entry.opSeq;
    }
    return max;
  }

  function replayOpRow(session, row) {
    if (!isPlainObject(row)) return errorResult("corrupt-op-log", "op row must be an object");
    switch (row.type) {
      case "append":
        return append(session, row.event);
      case "open":
        return open(session, row.spec);
      case "close":
        return close(session, row.opts);
      case "promote":
        return promote(session, row.spec);
      case "create":
        return createSession(row.options);
      default:
        return errorResult("corrupt-op-log", `unknown op type: ${String(row.type)}`);
    }
  }

  function emptySession() {
    const made = createSession({ id: sessionId });
    if (made.error) return null;
    return made.session;
  }

  function findNodeById(session, id) {
    const stack = [...session.rootChildren];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) continue;
      if (node.id === id) return node;
      if (Array.isArray(node.children)) {
        for (const child of node.children) stack.push(child);
      }
    }
    return undefined;
  }

  function rawRowFromLeaf(leaf) {
    const row = {
      type: "raw",
      seq: leaf.seq,
      kind: leaf.kind,
      content: leaf.content,
      id: leaf.id,
    };
    if (leaf.sourceRef !== undefined) row.sourceRef = leaf.sourceRef;
    if (leaf.meta !== undefined) row.meta = leaf.meta;
    return row;
  }

  function deriveLogRows(prevSession, nextSession, changes) {
    const rawRows = [];
    const opRows = [];
    const hasCloseBefore = (index) =>
      changes.slice(0, index).some((change) => change?.type === "close");
    for (let index = 0; index < changes.length; index += 1) {
      const change = changes[index];
      if (!change || typeof change !== "object") {
        return { error: `invalid change at index ${index}` };
      }
      if (change.type === "create") continue;
      if (change.type === "append") {
        const leaf = findNodeById(nextSession, change.leafId);
        if (!leaf || leaf.nodeType !== "leaf") {
          return { error: `append leaf not found: ${String(change.leafId)}` };
        }
        const autoGenerated =
          leaf.id === `ev-${String(prevSession.nextId).padStart(6, "0")}` &&
          nextSession.nextId === prevSession.nextId + 1;
        const event = {
          kind: leaf.kind,
          content: leaf.content,
        };
        if (leaf.sourceRef !== undefined) event.sourceRef = leaf.sourceRef;
        if (leaf.meta !== undefined) event.meta = leaf.meta;
        if (!autoGenerated) event.id = leaf.id;
        rawRows.push(rawRowFromLeaf(leaf));
        opRows.push({ type: "append", event });
      } else if (change.type === "open") {
        const scope = findNodeById(nextSession, change.scopeId);
        if (!scope || scope.nodeType !== "scope") {
          return { error: `open scope not found: ${String(change.scopeId)}` };
        }
        const autoGenerated =
          scope.id === `scope-${String(prevSession.nextId).padStart(6, "0")}` &&
          nextSession.nextId === prevSession.nextId + 1;
        const spec = { level: scope.level, boundary: scope.boundary };
        if (scope.meta !== undefined) spec.meta = scope.meta;
        if (!autoGenerated) spec.id = scope.id;
        opRows.push({ type: "open", spec });
      } else if (change.type === "close") {
        const block = findNodeById(nextSession, change.blockId);
        if (!block || block.nodeType !== "block") {
          return { error: `closed block not found: ${String(change.blockId)}` };
        }
        const opts = { summary: block.summary };
        // close 可能附带自动升华；为可重放，把第一个升华父块的 summary 一并记录。
        const firstAuto = changes
          .slice(index + 1)
          .find((later) => later?.type === "sublime");
        if (firstAuto?.parentBlockId) {
          const parentBlock = findNodeById(nextSession, firstAuto.parentBlockId);
          if (parentBlock && parentBlock.nodeType === "block") {
            opts.autoPromoteSummary = parentBlock.summary;
          }
        }
        opRows.push({ type: "close", opts });
      } else if (change.type === "sublime") {
        // 若同一 reducer 结果里前面有 close，则该 sublime 是 close 的自动升华，
        // 不应重复记录为 promote；否则视为显式 promote。
        if (!hasCloseBefore(index)) {
          const parentBlock = findNodeById(nextSession, change.parentBlockId);
          if (!parentBlock || parentBlock.nodeType !== "block") {
            return { error: `promote block not found: ${String(change.parentBlockId)}` };
          }
          const spec = {
            siblingIds: Array.isArray(change.childIds) ? change.childIds : [],
            summary: parentBlock.summary,
          };
          if (Array.isArray(parentBlock.summarySourceIds) && parentBlock.summarySourceIds.length > 0) {
            spec.summarySourceIds = parentBlock.summarySourceIds;
          }
          if (spec.siblingIds.length === 0) {
            return { error: "promote siblingIds missing" };
          }
          opRows.push({ type: "promote", spec });
        }
      } else if (change.type === "fallback-remove" || change.type === "fallback-hide") {
        // hiddenRootIds 是 envelope state 元数据，不走 reducer op / 快照写前日志。
        continue;
      } else {
        // 未知 change 类型不静默丢：交由调用方决定；此处忽略渲染类空 changes。
        // 为保守起见，无法还原 reducer 输入的 change 返回错误。
        return { error: `unsupported change type: ${String(change.type)}` };
      }
    }
    return { rawRows, opRows };
  }

  function replayFromOps(ops) {
    let session = emptySession();
    if (!session) return errorResult("missing-logs", "cannot create base session");
    let lastOpSeq = 0;
    for (const row of ops) {
      const result = replayOpRow(session, row);
      if (result.error) {
        return errorResult("corrupt-op-log", `replay failed at op: ${result.error?.code ?? "unknown"}`);
      }
      session = result.session;
      lastOpSeq = Number.isInteger(row.opSeq) ? row.opSeq : lastOpSeq + 1;
    }
    return okResult({ session, lastOpSeq });
  }

  function sessionFromRaw(rawRows) {
    let session = emptySession();
    if (!session) return errorResult("missing-logs", "cannot create base session");
    for (const row of rawRows) {
      if (!isPlainObject(row) || row.type !== "raw" || !Number.isInteger(row.seq)) {
        return errorResult("corrupt-raw-log", "raw row must be { type:\"raw\", seq, ... }");
      }
      const event = {
        id: typeof row.id === "string" && row.id.length > 0 ? row.id : undefined,
        kind: row.kind,
        content: row.content,
      };
      if (row.sourceRef !== undefined) event.sourceRef = row.sourceRef;
      if (row.meta !== undefined) event.meta = row.meta;
      const appended = append(session, event);
      if (appended.error) {
        return errorResult("corrupt-raw-log", `raw leaf append failed: ${appended.error?.message ?? ""}`);
      }
      session = appended.session;
      const leaf = findNodeById(session, appended.changes?.[0]?.leafId);
      if (!leaf) return errorResult("corrupt-raw-log", "raw leaf missing after append");
      if (row.id === undefined) {
        const leafNode = { ...leaf, seq: row.seq };
        session = replaceLeafNode(session, leaf.id, leafNode);
      } else {
        const leafNode = { ...leaf, seq: row.seq };
        session = replaceLeafNode(session, leaf.id, leafNode);
      }
    }
    let maxSeq = 1;
    let maxIdSuffix = 0;
    const stack = [...session.rootChildren];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) continue;
      if (Number.isInteger(node.seq)) maxSeq = Math.max(maxSeq, node.seq);
      const idMatch = /^(?:ev|scope|sublimed)-(\d+)$/.exec(typeof node.id === "string" ? node.id : "");
      if (idMatch) maxIdSuffix = Math.max(maxIdSuffix, Number(idMatch[1]));
      if (Array.isArray(node.children)) {
        for (const child of node.children) stack.push(child);
      }
    }
    return {
      ok: true,
      session: {
        ...session,
        nextSeq: maxSeq + 1,
        nextId: Math.max(session.nextId, maxIdSuffix + 1),
      },
    };
  }

  function replaceLeafNode(session, id, nextLeaf) {
    const mapChildren = (children) =>
      children.map((node) => {
        if (!node) return node;
        if (node.nodeType === "leaf") return node.id === id ? nextLeaf : node;
        if (Array.isArray(node.children)) return { ...node, children: mapChildren(node.children) };
        return node;
      });
    return { ...session, rootChildren: mapChildren(session.rootChildren) };
  }

  // --- recovery ---------------------------------------------------------------

  function recoverFromLogs(originalIssue) {
    const rawRead = readJsonLines(rawFile);
    const opRead = readJsonLines(opFile);
    const rawAvailable = rawRead.ok && rawRead.entries.length > 0;
    const opsAvailable = opRead.ok && opRead.entries.length > 0;

    if (opsAvailable) {
      const replayed = replayFromOps(opRead.entries);
      if (replayed.ok) {
        const state = makeState(replayed.session, {
          lastRawSeq: maxRawSeqFromFile(),
          lastOpSeq: replayed.lastOpSeq,
          lastAppliedOpSeq: replayed.lastOpSeq,
        });
        const audit = appendAudit({
          type: "store-recover",
          source: "op-replay",
          reason: originalIssue || "corrupt-store",
        });
        if (!audit.ok) return audit;
        const written = writeStoreRecord(replayed.session, state, scanArchiveRefs());
        if (!written.ok) return written;
        current = { session: replayed.session, state, record: written.record };
        return okResult({
          session: replayed.session,
          state,
          source: "op-replay",
          warnings: [],
        });
      }
    }
    if (rawAvailable) {
      const built = sessionFromRaw(rawRead.entries);
      if (built.ok) {
        const state = makeState(built.session, { lastRawSeq: maxRawSeqFromFile() });
        const audit = appendAudit({
          type: "store-recover",
          source: "raw-only",
          reason: originalIssue || "corrupt-store",
        });
        if (!audit.ok) return audit;
        const written = writeStoreRecord(built.session, state, scanArchiveRefs());
        if (!written.ok) return written;
        current = { session: built.session, state, record: written.record };
        return okResult({
          session: built.session,
          state,
          source: "raw-only",
          warnings: ["structure recovered without summaries; raw-only degraded session"],
        });
      }
      return errorResult(
        built.error?.code === "corrupt-raw-log" ? "corrupt-raw-log" : "corrupt-raw-log",
        built.error?.message || "raw log exists but cannot be rebuilt",
      );
    }
    if (!opsAvailable && !rawAvailable) {
      if (opRead && !opRead.ok) {
        return errorResult("corrupt-op-log", opRead.error || "ops.jsonl is corrupt");
      }
      if (rawRead && !rawRead.ok) {
        return errorResult("corrupt-raw-log", rawRead.error || "raw-events.jsonl is corrupt");
      }
      return errorResult(
        "missing-logs",
        "store is unavailable and no usable raw/op logs exist; refusing silent data loss",
      );
    }
    return errorResult(
      "missing-logs",
      "store is unavailable and logs cannot be replayed/rebuild; refusing silent data loss",
    );
  }

  // --- public-ish internal ------------------------------------------------------

  function setCurrent(session, state, record) {
    current = { session, state, record };
  }

  function loadInternal() {
    const read = readStoreRecord();
    if (read.found && !read.corrupt) {
      const normalized = normalizeStoreRecord(read.parsed);
      let record = normalized.ok ? normalized.record : null;
      let issue = normalized.ok ? null : normalized.errors.join("; ");
      if (record && record.sessionId !== sessionId) {
        record = null;
        issue = `session-id-mismatch: store belongs to ${String(record.sessionId)}`;
      }
      if (record) {
        const verified = verifyStoreRecord(record, hash);
        if (!verified.ok) {
          record = null;
          issue = verified.error?.message ?? "verify failed";
        }
      }
      if (record) {
        const state = { ...record.state };
        if (!Array.isArray(state.hiddenRootIds)) state.hiddenRootIds = [];
        let session = record.session;
        const opRead = readJsonLines(opFile);
        if (!opRead.ok) {
          return errorResult("corrupt-op-log", `ops.jsonl invalid: ${opRead.error}`);
        }
        const tail = opRead.entries.filter((entry) => Number.isInteger(entry?.opSeq) && entry.opSeq > state.lastAppliedOpSeq);
        for (const row of tail) {
          const replayed = replayOpRow(session, row);
          if (replayed.error) {
            return errorResult("corrupt-op-log", `tail op replay failed: ${replayed.error?.message ?? ""}`);
          }
          session = replayed.session;
          state.lastAppliedOpSeq = row.opSeq;
        }
        setCurrent(session, state, record);
        return okResult({
          session,
          state,
          source: "snapshot+replay",
          warnings: tail.length > 0 ? [`replayed ${tail.length} trailing op(s)`] : [],
        });
      }
      return recoverFromLogs(issue || "corrupt-store");
    }
    if (read.found) return recoverFromLogs(read.corrupt || "corrupt-store");
    return recoverFromLogs("not-found");
  }

  function ensureCurrentForWrite() {
    if (current) return okResult({ session: current.session });
    if (ioExists(io, storeFile) || ioExists(io, opFile) || ioExists(io, rawFile)) {
      const loaded = loadInternal();
      if (!loaded.ok) return loaded;
      return okResult({ session: loaded.session });
    }
    const base = emptySession();
    if (!base) return errorResult("missing-logs", "cannot create base session");
    setCurrent(base, makeState(base), null);
    return okResult({ session: base });
  }

  function archiveRefsFromCurrent() {
    if (current?.record && Array.isArray(current.record.archiveRefs)) {
      return JSON.parse(JSON.stringify(current.record.archiveRefs));
    }
    return scanArchiveRefs();
  }

  function hiddenRootIdsFromState(state) {
    return Array.isArray(state?.hiddenRootIds) ? [...state.hiddenRootIds] : [];
  }

  function buildArchiveRecord(payload, archiveId, reason) {
    const record = {
      format: KAZ_CONTEXT_ARCHIVE_FORMAT,
      version: KAZ_CONTEXT_ARCHIVE_VERSION,
      archiveId,
      sessionId,
      reason,
      removedAt: now(),
      block: payload.block,
      path: payload.path,
      removedFrom: payload.removedFrom,
      leafIds: payload.leafIds,
      summarySourceIds: payload.summarySourceIds,
      sourceRefs: payload.sourceRefs,
      seqRange: payload.seqRange,
    };
    const body = stableJsonText(withoutChecksum(record));
    return {
      ...record,
      checksum: { algorithm: "sha256", hex: hash(body) },
    };
  }

  // --- store facade --------------------------------------------------------------

  const facade = {
    load() {
      return loadInternal();
    },

    save(nextSession, changes = [], opts = {}) {
      const validation = validateSessionForStore(nextSession);
      if (!validation.ok) {
        return errorResult("invalid-session", validation.errors.join("; "));
      }
      if (nextSession.id !== sessionId) {
        return errorResult("session-id-mismatch", "session.id does not match store sessionId");
      }
      const ensured = ensureCurrentForWrite();
      if (!ensured.ok) return ensured;
      const prevSession = current.session;
      const derived = deriveLogRows(prevSession, nextSession, changes);
      if (derived.error) {
        return errorResult("invalid-changes", derived.error);
      }
      const nextState = makeState(nextSession, {
        lastRawSeq: Math.max(current.state.lastRawSeq, ...derived.rawRows.map((r) => r.seq)),
        lastOpSeq: current.state.lastOpSeq + derived.opRows.length,
        lastAppliedOpSeq: current.state.lastOpSeq + derived.opRows.length,
        hiddenRootIds: hiddenRootIdsFromState(current.state),
      });
      // 日志先写（raw → op），快照后写。
      for (const row of derived.rawRows) {
        const line = appendJsonLine(rawFile, row);
        if (!line.ok) return line;
      }
      let nextOpSeq = current.state.lastOpSeq;
      for (const row of derived.opRows) {
        nextOpSeq += 1;
        const opLine = appendJsonLine(opFile, { ...row, opSeq: nextOpSeq });
        if (!opLine.ok) return opLine;
      }
      nextState.lastOpSeq = nextOpSeq;
      nextState.lastAppliedOpSeq = nextOpSeq;
      const written = writeStoreRecord(nextSession, nextState, archiveRefsFromCurrent());
      if (!written.ok) return written;
      setCurrent(nextSession, nextState, written.record);
      return okResult({ session: nextSession, changes, store: written.record });
    },

    commitReducerResult(result) {
      if (!result || typeof result !== "object") {
        return errorResult("invalid-result", "commitReducerResult requires { session, changes }");
      }
      if (result.error) return result;
      return facade.save(result.session, Array.isArray(result.changes) ? result.changes : []);
    },

    fallbackTrim({ count, reason } = {}) {
      if (!Number.isInteger(count) || count < 0) {
        return errorResult("invalid-count", "count must be a non-negative integer");
      }
      if (typeof reason !== "string" || reason.trim().length === 0) {
        return errorResult("invalid-reason", "reason must be a non-empty string");
      }
      const ensured = ensureCurrentForWrite();
      if (!ensured.ok) return ensured;

      // 不删除、不归档移动：只计算应隐藏的最老根节点 id 并持久化到 state。
      const hiddenBefore = hiddenRootIdsFromState(current.state);
      const refs = archiveRefsFromCurrent();
      const selected = selectHiddenRootIds(current.session, hiddenBefore, count);
      if (!selected.ok) return selected;
      if (selected.rootIds.length === 0) {
        return okResult({
          hidden: 0,
          hiddenRootIds: hiddenBefore,
          candidatesLeft: selected.candidatesLeft,
          archiveRefs: refs,
          warning: "no-more-candidates",
        });
      }
      const warning =
        selected.candidates.length < count ? "no-more-candidates" : undefined;

      // 审计仍是日志：快照前写，记录计划内失效边界。
      const audit = appendAudit({
        type: "fallback-hide",
        boundaryType: KAZ_CONTEXT_NATIVE_FALLBACK_STRATEGY.boundaryType,
        reason,
        rootIds: selected.rootIds,
        hiddenRootIds: selected.hiddenRootIds,
        count: selected.rootIds.length,
      });
      if (!audit.ok) return audit;

      // Session 原样保留，只替换 envelope state（hiddenRootIds + 相同计数）。
      const state = makeState(current.session, {
        lastRawSeq: current.state.lastRawSeq,
        lastOpSeq: current.state.lastOpSeq,
        lastAppliedOpSeq: current.state.lastAppliedOpSeq,
        hiddenRootIds: selected.hiddenRootIds,
      });
      const written = writeStoreRecord(current.session, state, refs);
      if (!written.ok) return written;
      setCurrent(current.session, state, written.record);
      return okResult({
        hidden: selected.rootIds.length,
        hiddenRootIds: selected.hiddenRootIds,
        candidatesLeft: selected.candidatesLeft,
        archiveRefs: refs,
        ...(warning ? { warning } : {}),
      });
    },

    appendRaw(event) {
      if (!isPlainObject(event)) {
        return errorResult("invalid-raw", "appendRaw requires a raw event object");
      }
      const seq = Number.isInteger(event.seq) && event.seq > 0 ? event.seq : maxRawSeqFromFile() + 1;
      if (Number.isInteger(event.seq) && event.seq > 0 && event.seq <= maxRawSeqFromFile()) {
        return errorResult("duplicate-raw-seq", `raw seq already exists: ${event.seq}`);
      }
      const row = { type: "raw", ...event, seq };
      const written = appendJsonLine(rawFile, row);
      if (!written.ok) return written;
      if (current) current.state.lastRawSeq = Math.max(current.state.lastRawSeq, seq);
      return okResult({ seq });
    },

    appendOp(op) {
      if (!isPlainObject(op)) {
        return errorResult("invalid-op", "appendOp requires an op object");
      }
      if (!OP_TYPES.has(op.type)) {
        return errorResult("invalid-op-type", `unsupported op type: ${String(op.type)}`);
      }
      const opSeq = Number.isInteger(op.opSeq) && op.opSeq > 0 ? op.opSeq : maxOpSeqFromFile() + 1;
      if (Number.isInteger(op.opSeq) && op.opSeq > 0 && op.opSeq <= maxOpSeqFromFile()) {
        return errorResult("duplicate-op-seq", `op seq already exists: ${op.opSeq}`);
      }
      const row = { ...op, opSeq };
      const written = appendJsonLine(opFile, row);
      if (!written.ok) return written;
      if (current) {
        current.state.lastOpSeq = Math.max(current.state.lastOpSeq, opSeq);
        current.state.lastAppliedOpSeq = Math.max(current.state.lastAppliedOpSeq, opSeq);
      }
      return okResult({ opSeq });
    },

    listArchiveRefs() {
      return archiveRefsFromCurrent();
    },

    readArchive(archiveId) {
      if (typeof archiveId !== "string" || archiveId.length === 0 || /[\\/]/.test(archiveId)) {
        return null;
      }
      const file = join(archiveDir, `${archiveId}.json`);
      if (!ioExists(io, file)) return null;
      try {
        return JSON.parse(ioReadFile(io, file));
      } catch {
        return null;
      }
    },
  };

  return facade;
}
