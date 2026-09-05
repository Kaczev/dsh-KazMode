// kaz-shared 探针：Kaz7.0 M2 树 store（lib/session-tree-store-core.js + io adapter）。
// ===========================================================================
// 依据：不入库文件/Kaz7.0更新规划/Kaz7.0-M2树store设计报告.md（D1-D20 验收清单）。
// 覆盖：
//   D1  路径/Kaz 私有 storages/kaz-context；内存 rootDir 下不写源码树；
//   D2  store.json envelope 字段与 Session 分离；
//   D3  serialize/parse 后 Session 可继续 M1 reducer，renderOrderValid 保持；
//   D4  checksum 覆盖非 checksum 全包；篡改/未知扩展可检出；
//   D5  原子写：临时+fsync+rename+写前备份；rename 失败不产生半截快照；
//   D6  重启/resume：快照恢复、继续 append，seq/id 不重不漏；
//   D7  store.json 损坏回退：op-replay / raw-only 可继续；
//   D8  raw/op append-only；树操作/归档不改已有行；
//   D9  归档记录完整：path/leafIds/summarySourceIds/checksum/block 全量；
//   D10 归档不丢：raw/op 不变、archive 可完整找回被移除 block 的 leaf；
//   D11 1M 兜底选择顺序 oldest → highest-level → nearest-root，只选渲染可见最外层；
//   D12 fallbackTrim 先归档→移除→审计→快照；移除后 renderOrderValid 保持；
//   D13 审计含 boundaryType/blockIds/archiveIds/reason；
//   D14 树 store 侧零自动 memory 写入/删除；
//   D15 session-tree.js/tool-lists 公共出口无 persist/archive/load/save store API；
//   D16 Session/store/archive/探针导出无 token/budget/MC/trigger；
//   D17 无 cordis/register/DSH 核心改动导出；
//   D18 纯 store core 无 node:fs/node:crypto import；
//   D19 内存 io/假 hash 注入；PASS/FAIL、SESSION-TREE-STORE PROBE OK、退出码；
//   D20 archive 无默认自动 TTL、无自动清理 API；重开 store 后仍可读。
// 运行：node KazPlugins/kaz-shared/probe-session-tree-store.mjs
// ===========================================================================

import { createSession, append, open, close, render } from "./lib/session-tree.js";
import { renderOrderValid } from "./lib/context-compress.js";
import * as core from "./lib/session-tree-store-core.js";
import {
  KAZ_CONTEXT_STORE_ROOT,
  sessionDirIdOf,
  createSessionTreeStore,
} from "./lib/session-tree-store-io.js";
import { readFileSync } from "node:fs";

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

function run(result) {
  if (result?.error) {
    throw new Error(`unexpected error ${result.error.code}: ${result.error.message}`);
  }
  return result;
}

function commitOp(store, result) {
  if (result?.error) {
    throw new Error(`reducer error ${result.error.code}: ${result.error.message}`);
  }
  const saved = store.commitReducerResult(result);
  if (!saved?.ok) {
    throw new Error(`store commit failed ${saved?.code ?? ""}: ${saved?.error ?? ""}`);
  }
  return result.session;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function collectLeafNodes(session) {
  const leaves = [];
  const walk = (children) => {
    for (const node of children ?? []) {
      if (!node || typeof node !== "object") continue;
      if (node.nodeType === "leaf") leaves.push(node);
      if (Array.isArray(node.children)) walk(node.children);
    }
  };
  walk(session?.rootChildren);
  return leaves;
}

// ---------------------------------------------------------------------------
// 内存 filesystem：Map + 目录 + 操作日志（可验证 temp→fsync→rename 与 append-only）
// ---------------------------------------------------------------------------

function createMemoryFs() {
  const files = new Map();
  const dirs = new Set();
  const ops = [];
  const norm = (p) => String(p).replace(/\\/g, "/");
  const addDirs = (p) => {
    const parts = p.split("/");
    let cur = "";
    for (let i = 0; i < parts.length - 1; i += 1) {
      cur = cur.length === 0 ? parts[i] : `${cur}/${parts[i]}`;
      if (cur.length > 0) dirs.add(cur);
    }
  };
  const io = {
    exists(p) {
      const k = norm(p);
      return files.has(k) || dirs.has(k);
    },
    mkdir(p) {
      dirs.add(norm(p));
    },
    readFile(p) {
      const k = norm(p);
      if (!files.has(k)) throw new Error(`ENOENT: ${k}`);
      return files.get(k);
    },
    writeFile(p, text) {
      const k = norm(p);
      files.set(k, String(text));
      addDirs(k);
      ops.push({ kind: "write", path: k });
    },
    appendFile(p, text) {
      const k = norm(p);
      files.set(k, (files.get(k) ?? "") + String(text));
      addDirs(k);
      ops.push({ kind: "append", path: k });
    },
    rename(from, to) {
      const a = norm(from);
      const b = norm(to);
      if (!files.has(a)) throw new Error(`ENOENT: ${a}`);
      files.set(b, files.get(a));
      files.delete(a);
      addDirs(b);
      ops.push({ kind: "rename", from: a, to: b });
    },
    copyFile(from, to) {
      const a = norm(from);
      const b = norm(to);
      if (!files.has(a)) throw new Error(`ENOENT: ${a}`);
      files.set(b, files.get(a));
      addDirs(b);
      ops.push({ kind: "copy", from: a, to: b });
    },
    readdir(p) {
      const k = norm(p);
      const prefix = k.endsWith("/") ? k : `${k}/`;
      const names = new Set();
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split("/")[0]);
      }
      for (const d of dirs) {
        if (d.startsWith(prefix) && d !== k) {
          names.add(d.slice(prefix.length).split("/")[0]);
        }
      }
      return [...names];
    },
    rm(p) {
      const k = norm(p);
      files.delete(k);
      ops.push({ kind: "rm", path: k });
    },
    fsync(p) {
      ops.push({ kind: "fsync", path: norm(p) });
    },
  };
  return {
    io,
    files,
    dirs,
    ops,
    norm,
    read(p) {
      return files.get(norm(p));
    },
    has(p) {
      return files.has(norm(p));
    },
    write(p, text) {
      const k = norm(p);
      files.set(k, String(text));
      addDirs(k);
      ops.push({ kind: "test-write", path: k });
    },
    delete(p) {
      const k = norm(p);
      files.delete(k);
      ops.push({ kind: "test-delete", path: k });
    },
    keys() {
      return [...files.keys()];
    },
    findFile(suffix) {
      return this.keys().find((k) => k.endsWith(suffix)) ?? null;
    },
  };
}

// 确定性假 hash（64 hex；与 node:crypto 无关，仅验证校验逻辑）。
function fakeHash(text) {
  let a = 0x9e3779b9;
  let b = 0x85ebca6b;
  const input = String(text);
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    a = Math.imul(a ^ code, 0x85ebca6b);
    b = Math.imul(b ^ code, 0xc2b2ae3d);
  }
  a >>>= 0;
  b >>>= 0;
  const hex = `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
  return hex.repeat(4).slice(0, 64);
}

const MEM_ROOT = "virtual-kaz-context";
function makeNow() {
  let n = 0;
  return () => new Date(Date.UTC(2026, 8, 5, 0, 0, 0) + n++).toISOString();
}

function makeStore(fs, sessionId, extra = {}) {
  return createSessionTreeStore({
    rootDir: MEM_ROOT,
    sessionId,
    io: fs.io,
    hash: fakeHash,
    now: makeNow(),
    ...extra,
  });
}

function opened(session, level, boundary, id) {
  return run(open(session, { level, boundary, id }));
}

function appended(session, kind, content) {
  return run(append(session, { kind, content }));
}

function closed(session, summary) {
  return run(close(session, { summary }));
}

function newLeaf(id, seq, content = "x", kind = "user") {
  return { nodeType: "leaf", id, seq, kind, content };
}

function newBlock(id, level, children = [], { orderSeq = 1, boundary = "sublimed" } = {}) {
  const summarySourceIds = children.filter((c) => c?.id).map((c) => c.id);
  return {
    nodeType: "block",
    id,
    level,
    boundary,
    state: "closed",
    summary: `summary ${id}`,
    summarySourceIds,
    children,
    openedSeq: Math.max(1, orderSeq - 1),
    closedSeq: orderSeq,
    orderSeq,
    fingerprint: `fp:${id}:${level}:${orderSeq}`,
  };
}

function newScope(id, level, children = []) {
  const boundary = level === 1 ? "round" : level === 2 ? "planItem" : "goal";
  return { nodeType: "scope", id, level, boundary, children, openedSeq: 1 };
}

function manualSession(rootChildren) {
  return {
    schemaVersion: "kaz-context-session/1",
    id: "order-manual",
    nextSeq: 100,
    nextId: 100,
    rootChildren,
  };
}

function buildRichSession(sessionId) {
  let s = run(createSession({ id: sessionId })).session;
  // 根直出 level1/2/3 closed block（由显式 close 产生）。
  let r = opened(s, 1, "round", "r1");
  s = r.session;
  r = appended(s, "user", "u-r1");
  s = r.session;
  r = closed(s, "r1 summary");
  s = r.session;

  r = opened(s, 2, "planItem", "p2");
  s = r.session;
  r = appended(s, "user", "u-p2");
  s = r.session;
  r = closed(s, "p2 summary");
  s = r.session;

  r = opened(s, 3, "goal", "g3");
  s = r.session;
  r = appended(s, "user", "u-g3");
  s = r.session;
  r = closed(s, "g3 summary");
  s = r.session;

  // 一个仍 open 的 goal scope，内含已 closed 的 level2/level1 block（渲染可见最外层）。
  r = opened(s, 3, "goal", "outer-goal");
  s = r.session;
  r = opened(s, 2, "planItem", "inner-plan");
  s = r.session;
  r = appended(s, "user", "u-inner-plan");
  s = r.session;
  r = closed(s, "inner-plan summary");
  s = r.session;
  r = opened(s, 1, "round", "inner-round");
  s = r.session;
  r = appended(s, "user", "u-inner-round");
  s = r.session;
  r = closed(s, "inner-round summary");
  s = r.session;
  r = appended(s, "user", "open-tail");
  return r.session;
}

function buildRichStore(fs, sessionId = "rich") {
  const store = makeStore(fs, sessionId);
  let s = run(createSession({ id: sessionId })).session;
  s = commitOp(store, { session: s, changes: [{ type: "create", sessionId }] });

  let r = opened(s, 1, "round", "r1");
  s = commitOp(store, r);
  r = appended(s, "user", "u-r1");
  s = commitOp(store, r);
  r = closed(s, "r1 summary");
  s = commitOp(store, r);

  r = opened(s, 2, "planItem", "p2");
  s = commitOp(store, r);
  r = appended(s, "user", "u-p2");
  s = commitOp(store, r);
  r = closed(s, "p2 summary");
  s = commitOp(store, r);

  r = opened(s, 3, "goal", "g3");
  s = commitOp(store, r);
  r = appended(s, "user", "u-g3");
  s = commitOp(store, r);
  r = closed(s, "g3 summary");
  s = commitOp(store, r);

  r = opened(s, 3, "goal", "outer-goal");
  s = commitOp(store, r);
  r = opened(s, 2, "planItem", "inner-plan");
  s = commitOp(store, r);
  r = appended(s, "user", "u-inner-plan");
  s = commitOp(store, r);
  r = closed(s, "inner-plan summary");
  s = commitOp(store, r);
  r = opened(s, 1, "round", "inner-round");
  s = commitOp(store, r);
  r = appended(s, "user", "u-inner-round");
  s = commitOp(store, r);
  r = closed(s, "inner-round summary");
  s = commitOp(store, r);
  r = appended(s, "user", "open-tail");
  s = commitOp(store, r);
  return { store, session: s };
}

function noForbiddenKeysDeep(value, forbidden = /token|budget|mc_|trigger/i) {
  if (Array.isArray(value)) return value.every((item) => noForbiddenKeysDeep(item, forbidden));
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    return keys.every((key) => !forbidden.test(key)) &&
      keys.every((key) => noForbiddenKeysDeep(value[key], forbidden));
  }
  return true;
}

// ---------------------------------------------------------------------------
// D1：路径常量与内存 root 边界
// ---------------------------------------------------------------------------
{
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = "C:/virtual-dsh-home";
  let homeRoot = "";
  try {
    homeRoot = KAZ_CONTEXT_STORE_ROOT();
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
  }
  const normHome = homeRoot.replace(/\\/g, "/");
  check(
    "D1 KAZ_CONTEXT_STORE_ROOT 指向 <DSH_HOME>/storages/kaz-context",
    normHome.endsWith("/storages/kaz-context"),
  );
  const dirId = sessionDirIdOf("session-path-test", fakeHash);
  check(
    "D1 sessionDirIdOf 是 session-<hash前16>，不直接使用原始 sessionId",
    dirId === `session-${fakeHash("session-path-test").slice(0, 16)}` && dirId.startsWith("session-"),
  );
  const fsD1 = createMemoryFs();
  const storeD1 = makeStore(fsD1, "d1-boundary");
  let sD1 = run(createSession({ id: "d1-boundary" })).session;
  sD1 = commitOp(storeD1, append(sD1, { kind: "user", content: "u" }));
  const allKeys = fsD1.keys();
  const prefix = fsD1.norm(MEM_ROOT) + "/";
  check(
    "D1 内存 io 写入全部位于注入的 kaz-context root，不在 KazPlugins 源码树/真实 storages",
    allKeys.length > 0 && allKeys.every((k) => k.startsWith(prefix)),
  );
}

// ---------------------------------------------------------------------------
// D2/D4：store envelope 与 checksum
// ---------------------------------------------------------------------------
{
  const fs = createMemoryFs();
  const store = makeStore(fs, "envelope");
  let s = run(createSession({ id: "envelope" })).session;
  const result = commitOp(store, append(s, { kind: "user", content: "hello" }));
  s = result;
  // 从最新 store 快照取当前 record（commitReducerResult 不直接暴露 record）。
  const loaded = makeStore(fs, "envelope");
  const saved = loaded.save(s, []);
  check(
    "D2 store.json envelope 含 format/formatVersion/sessionSchema/state/session/archiveRefs/checksum",
    saved?.ok === true &&
      saved.store.format === core.KAZ_CONTEXT_STORE_FORMAT &&
      saved.store.formatVersion === core.KAZ_CONTEXT_STORE_FORMAT_VERSION &&
      saved.store.sessionSchema === core.KAZ_CONTEXT_SESSION_SCHEMA &&
      typeof saved.store.updatedAt === "string" &&
      saved.store.state && typeof saved.store.state === "object" &&
      Array.isArray(saved.store.archiveRefs) &&
      saved.store.checksum?.algorithm === "sha256" &&
      typeof saved.store.checksum?.hex === "string" &&
      saved.store.checksum.hex.length > 0,
  );
  const record = saved.store;
  const sessionKeys = Object.keys(record.session).sort().join(",");
  check(
    "D2 store 元数据不混入 M1 Session；Session 只保留 M1 五个顶层字段",
    sessionKeys === "id,nextId,nextSeq,rootChildren,schemaVersion",
  );
  const norm = core.normalizeStoreRecord(record);
  const body = core.canonicalStoreBody(record);
  const verifyOk = core.verifyStoreRecord(record, fakeHash);
  const tampered = JSON.parse(JSON.stringify(record));
  tampered.updatedAt = "tampered-timestamp";
  const verifyTamper = core.verifyStoreRecord(tampered, fakeHash);
  const tamperedState = JSON.parse(JSON.stringify(record));
  tamperedState.state.lastRawSeq = 999;
  const verifyState = core.verifyStoreRecord(tamperedState, fakeHash);
  check(
    "D4 canonical 稳定、checksum 覆盖除自身外全包；篡改 updatedAt/state 均可检出",
    norm.ok === true &&
      typeof body === "string" &&
      body === core.canonicalStoreBody(record) &&
      record.checksum.hex === fakeHash(body) &&
      verifyOk?.ok === true &&
      verifyTamper?.error?.code === "corrupt-store" &&
      verifyState?.error?.code === "corrupt-store",
  );
  const extended = JSON.parse(JSON.stringify(record));
  extended.xForwardExt = { keep: true };
  const extBody = core.canonicalStoreBody(extended);
  const extVerify = core.verifyStoreRecord({ ...extended, checksum: { algorithm: "sha256", hex: fakeHash(extBody) } }, fakeHash);
  const extNorm = core.normalizeStoreRecord({ ...extended, checksum: { algorithm: "sha256", hex: fakeHash(extBody) } });
  check(
    "D4/5.x 未知扩展字段保留且被 checksum 覆盖",
    extVerify?.ok === true && extNorm.ok === true && extNorm.record.xForwardExt?.keep === true,
  );
}

// ---------------------------------------------------------------------------
// D3：Session 序列化兼容（可继续 M1 reducer）
// ---------------------------------------------------------------------------
{
  const original = buildRichSession("compat-session");
  const serialized = core.serializeSession(original);
  const parsed = core.parseSession(serialized.text);
  const s1 = append(original, { kind: "tool", content: { after: 1 } }).session;
  const s2 = append(parsed.session, { kind: "tool", content: { after: 1 } }).session;
  const renderOriginal = run(render(original, { mode: "entries" }));
  const renderParsed = run(render(parsed.session, { mode: "entries" }));
  check(
    "D3 serialize/parse 后 Session 与 M1 原 Session 完全兼容（五顶层字段/树）",
    serialized.ok === true &&
      parsed.ok === true &&
      deepEqual(parsed.session, original) &&
      deepEqual(s1, s2) &&
      renderParsed.orderValid === true &&
      renderOriginal.orderValid === true &&
      renderOrderValid(renderParsed.entries) === true,
  );
  const storeValidation = core.validateSessionForStore(original);
  const forbidden = /token|budget|mc_|trigger/i;
  check(
    "D3/S4 序列化 Session 无 store 私有字段且无 token/budget/mc/trigger 字段",
    storeValidation.ok === true &&
      noForbiddenKeysDeep(original, forbidden) &&
      noForbiddenKeysDeep(parsed.session, forbidden),
  );
}

// ---------------------------------------------------------------------------
// D5：原子写——temp+fsync+rename+备份；rename 失败旧快照不损坏
// ---------------------------------------------------------------------------
{
  const fs = createMemoryFs();
  const store = makeStore(fs, "atomic");
  let s = run(createSession({ id: "atomic" })).session;
  s = commitOp(store, append(s, { kind: "user", content: "one" }));
  // 第二次提交让“替换前先备份”真正发生；观察两次 store.json 原子写。
  s = commitOp(store, append(s, { kind: "assistant", content: "pre-two" }));
  const storeFile = fs.findFile("/store.json");
  const beforeText = fs.read(storeFile);
  const writeOps = fs.ops.filter((op) => op.path?.includes("/store.json") || op.to?.includes("/store.json"));
  const hasTemp = writeOps.some((op) => op.path.endsWith(".tmp"));
  const hasRename = writeOps.some((op) => op.kind === "rename" && op.to.endsWith("/store.json"));
  const hasBackup = fs.keys().some((k) => k.includes("/backups/") && k.endsWith(".bak"));
  check(
    "D5 快照写路径包含同目录临时文件+fsync+rename，且替换前有备份",
    hasTemp && hasRename && hasBackup &&
      writeOps.some((op) => op.kind === "fsync" && op.path.endsWith(".tmp")),
  );

  let failStoreRename = true;
  const crashIo = {
    ...fs.io,
    rename(from, to) {
      const b = fs.norm(to);
      if (failStoreRename && b.endsWith("/store.json")) {
        throw new Error("simulated rename crash");
      }
      return fs.io.rename(from, to);
    },
  };
  const crashStore = createSessionTreeStore({
    rootDir: MEM_ROOT,
    sessionId: "atomic",
    io: crashIo,
    hash: fakeHash,
    now: makeNow(),
  });
  const appendResult = append(s, { kind: "assistant", content: "two" });
  const failedSave = crashStore.commitReducerResult(appendResult);
  check(
    "D5 rename 失败返回错误；store.json 仍为旧完整快照（不会出现半截文件）",
    failedSave?.ok === false && fs.read(storeFile) === beforeText,
  );
}

// ---------------------------------------------------------------------------
// D6：进程重启 / session resume
// ---------------------------------------------------------------------------
{
  const fs = createMemoryFs();
  const store1 = makeStore(fs, "resume-session");
  let s = run(createSession({ id: "resume-session" })).session;
  s = commitOp(store1, append(s, { kind: "user", content: "u1" }));
  s = commitOp(store1, append(s, { kind: "assistant", content: "a1" }));
  const before = JSON.parse(JSON.stringify(s));
  const store2 = makeStore(fs, "resume-session");
  const loaded = store2.load();
  const next = append(loaded.session, { kind: "user", content: "u2" });
  const saved = store2.commitReducerResult(next);
  const store3 = makeStore(fs, "resume-session");
  const loaded3 = store3.load();
  const ids = [];
  const walkIds = (nodes) => {
    for (const node of nodes) {
      if (!node) continue;
      ids.push(node.id);
      if (node.children) walkIds(node.children);
    }
  };
  walkIds(loaded3.session.rootChildren);
  check(
    "D6 快照恢复可继续追加；seq/id 不重不漏（source snapshot+replay）",
    loaded.ok === true &&
      loaded.source === "snapshot+replay" &&
      deepEqual(loaded.session, before) &&
      saved.ok === true &&
      loaded3.ok === true &&
      loaded3.session.rootChildren.length === 3 &&
      new Set(ids).size === ids.length &&
      loaded3.session.nextSeq === before.nextSeq + 1,
  );
}

// ---------------------------------------------------------------------------
// D7：损坏回退 op-replay 与 raw-only
// ---------------------------------------------------------------------------
{
  // op-replay：保留 raw+op，损坏 store.json。
  const fs = createMemoryFs();
  const built = buildRichStore(fs, "corrupt-op");
  const richSession = built.session;
  const storeFile = fs.findFile("/store.json");
  fs.write(storeFile, "{ definitely broken json");
  const recoveredStore = makeStore(fs, "corrupt-op");
  const recovered = recoveredStore.load();
  const auditLines = (fs.read(fs.findFile("/audit.jsonl")) ?? "").trim().split("\n").filter(Boolean);
  check(
    "D7 store.json 损坏后 op-replay 全量恢复结构化 Session 并写 audit",
    recovered.ok === true &&
      recovered.source === "op-replay" &&
      deepEqual(recovered.session, richSession) &&
      auditLines.some((line) => line.includes('"store-recover"') && line.includes('"op-replay"')),
  );
  const continueAfterOp = commitOp(recoveredStore, append(recovered.session, { kind: "user", content: "after-corruption" }));
  const checkOp = makeStore(fs, "corrupt-op").load();
  check(
    "D7 op-replay 后 Session 可继续 append/open/close，无 seq/id 冲突",
    continueAfterOp.nextSeq === richSession.nextSeq + 1 && checkOp.ok === true && checkOp.session.nextSeq === richSession.nextSeq + 1,
  );

  // raw-only：删除 store.json 与 ops.jsonl，保留 raw 日志。
  const fsRaw = createMemoryFs();
  const storeRaw = makeStore(fsRaw, "raw-fallback");
  let rawS = run(createSession({ id: "raw-fallback" })).session;
  rawS = commitOp(storeRaw, append(rawS, { kind: "user", content: "raw-one" }));
  rawS = commitOp(storeRaw, append(rawS, { kind: "assistant", content: "raw-two" }));
  fsRaw.delete(fsRaw.findFile("/store.json"));
  fsRaw.delete(fsRaw.findFile("/ops.jsonl"));
  const rawRecover = makeStore(fsRaw, "raw-fallback").load();
  const rawLeaves = rawRecover.session?.rootChildren?.filter((n) => n.nodeType === "leaf") ?? [];
  check(
    "D7 仅 raw 时 raw-only 降级恢复原始事实并可继续",
    rawRecover.ok === true &&
      rawRecover.source === "raw-only" &&
      rawLeaves.length === 2 &&
      rawLeaves.map((n) => n.content).join("|") === "raw-one|raw-two" &&
      Array.isArray(rawRecover.warnings) &&
      rawRecover.warnings.some((w) => /degraded|structure/i.test(w)),
  );
  const rawContinue = commitOp(makeStore(fsRaw, "raw-fallback"), append(rawRecover.session, { kind: "user", content: "raw-three" }));
  check(
    "D7 raw-only 会话继续 append 后无重复 id",
    rawContinue.rootChildren.filter((n) => n.nodeType === "leaf").length === 3 &&
      new Set(rawContinue.rootChildren.map((n) => n.id)).size === 3,
  );
}

// ---------------------------------------------------------------------------
// D8/D9/D10/D12/D13/D20：fallbackTrim、归档与审计
// ---------------------------------------------------------------------------
{
  const fs = createMemoryFs();
  const { store, session } = buildRichStore(fs, "trim-demo");
  const rawFile = fs.findFile("/raw-events.jsonl");
  const opFile = fs.findFile("/ops.jsonl");
  const rawBefore = fs.read(rawFile);
  const opBefore = fs.read(opFile);
  const renderBefore = run(render(session));
  fs.ops.length = 0; // 只观察 fallbackTrim 的 IO 顺序
  const trimmed = store.fallbackTrim({ count: 2, reason: "native-window-emergency" });
  check(
    "D12 fallbackTrim 返回 removed/candidatesLeft/archiveRefs",
    trimmed.ok === true &&
      trimmed.removed === 2 &&
      Number.isInteger(trimmed.candidatesLeft) &&
      trimmed.archiveRefs.length === 2,
  );
  check(
    "D8/D10 fallbackTrim 不改写 raw/op 已有完整行",
    fs.read(rawFile) === rawBefore && fs.read(opFile) === opBefore,
  );
  const ioOps = fs.ops;
  const archive1Rename = ioOps.findIndex((op) => op.kind === "rename" && op.to.includes("/archive/arc-000001.json"));
  const archive2Rename = ioOps.findIndex((op) => op.kind === "rename" && op.to.includes("/archive/arc-000002.json"));
  const auditAppend = ioOps.findIndex((op) => op.kind === "append" && op.path.endsWith("/audit.jsonl"));
  const storeTemp = ioOps.findIndex((op) => op.kind === "write" && /\/store\.json\.\d+\.\d+\.tmp$/.test(op.path));
  const storeRename = ioOps.findIndex((op) => op.kind === "rename" && op.to.endsWith("/store.json"));
  check(
    "D12 IO 顺序：两个 archive 落盘 → audit → 快照临时写 → 快照 rename",
    archive1Rename >= 0 && archive2Rename > archive1Rename &&
      auditAppend > archive2Rename && storeTemp > auditAppend && storeRename > storeTemp,
  );
  const refs = store.listArchiveRefs();
  const arc1 = store.readArchive(refs[0].archiveId);
  const arc2 = store.readArchive(refs[1].archiveId);
  check(
    "D9 归档记录完整：format/version/block/path/leafIds/summarySourceIds/sourceRefs/seqRange/checksum",
    refs.length === 2 &&
      arc1?.format === core.KAZ_CONTEXT_ARCHIVE_FORMAT &&
      arc1?.version === core.KAZ_CONTEXT_ARCHIVE_VERSION &&
      typeof arc1.block?.id === "string" &&
      Array.isArray(arc1.block.children) &&
      typeof arc1.path === "string" &&
      typeof arc1.removedFrom === "string" &&
      Array.isArray(arc1.leafIds) &&
      Array.isArray(arc1.summarySourceIds) &&
      Array.isArray(arc1.sourceRefs) &&
      arc1.seqRange && Number.isInteger(arc1.seqRange.closedSeq) &&
      arc1.checksum?.algorithm === "sha256" &&
      typeof arc1.checksum?.hex === "string" &&
      arc2?.format === core.KAZ_CONTEXT_ARCHIVE_FORMAT,
  );
  const rawText = fs.read(rawFile);
  const rawLines = rawText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const rawRows = rawLines.map((l) => JSON.parse(l));
  const allArchives = [arc1, arc2];
  check(
    "D10 archive 中每个 leafId 都能在 raw 日志找回（归档不丢原始事实）",
    allArchives.every((arc) => arc.leafIds.every((leafId) => rawRows.some((row) => row.id === leafId || row.id === undefined))),
  );
  const auditText = fs.read(fs.findFile("/audit.jsonl")) ?? "";
  const auditRows = auditText.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const fallbackAudit = auditRows.find((row) => row.type === "fallback-archive");
  check(
    "D13 fallback 审计含 boundaryType=planned-invalidation/blockIds/archiveIds/reason/count",
    !!fallbackAudit &&
      fallbackAudit.boundaryType === "planned-invalidation" &&
      Array.isArray(fallbackAudit.blockIds) && fallbackAudit.blockIds.length === 2 &&
      Array.isArray(fallbackAudit.archiveIds) && fallbackAudit.archiveIds.length === 2 &&
      fallbackAudit.reason === "native-window-emergency" &&
      fallbackAudit.count === 2,
  );
  const reopened = makeStore(fs, "trim-demo").load();
  const renderAfter = reopened.ok ? run(render(reopened.session)) : null;
  check(
    "D12 移除后快照加载成功、常驻最外层减少且 renderOrderValid 保持",
    reopened.ok === true &&
      renderAfter?.stats.outermostBlockCount < renderBefore.stats.outermostBlockCount &&
      renderAfter?.orderValid === true &&
      renderOrderValid(renderAfter.entries) === true,
  );
  const afterAppendRaw = commitOp(makeStore(fs, "trim-demo"), append(reopened.session, { kind: "user", content: "after-trim" }));
  check(
    "D10/D20 归档后可继续 append；archive 在新 store 重开/追加后仍存在且无自动 TTL 字段",
    collectLeafNodes(afterAppendRaw).some((n) => n.content === "after-trim") &&
      makeStore(fs, "trim-demo").readArchive(refs[0].archiveId)?.archiveId === refs[0].archiveId &&
      arc1.ttl === undefined &&
      Object.keys(store).every((k) => !/delete|cleanup|purge|prune|ttl/i.test(k)),
  );
  const allKeysTrim = fs.keys();
  const memLike = allKeysTrim.filter((k) => /(^|\/)(ka-whale-memory|kaz-memory)(\/|$)|memory/i.test(k));
  check(
    "D14 树 store 侧零 memory 自动写入/删除（文件只落在 kaz-context root）",
    allKeysTrim.every((k) => k.startsWith(fs.norm(MEM_ROOT) + "/")) && memLike.length === 0,
  );
}

// ---------------------------------------------------------------------------
// D11：1M 兜底候选顺序（oldest → highest-level → nearest-root）与最外层限定
// ---------------------------------------------------------------------------
{
  const hidden = newBlock("hidden-inner", 1, [newLeaf("hl1", 1)], { orderSeq: 1 });
  const container = newBlock("container", 2, [newLeaf("c1", 50), hidden], { orderSeq: 50 });
  const session = manualSession([
    newBlock("a-root", 1, [newLeaf("al1", 1)], { orderSeq: 10 }),
    newBlock("c-root", 2, [newLeaf("cl1", 2)], { orderSeq: 10 }),
    newBlock("d-root", 1, [newLeaf("dl1", 3)], { orderSeq: 20 }),
    newScope("s-live", 3, [
      newBlock("b-scope", 2, [newLeaf("bl1", 4)], { orderSeq: 10 }),
      newBlock("e-scope", 2, [newLeaf("el1", 5)], { orderSeq: 20 }),
    ]),
    container,
  ]);
  const validation = core.validateSessionForStore(session);
  const selected = core.selectFallbackBlocks(session, 100);
  const ids = selected.ok ? selected.candidates.map((c) => c.id) : [];
  check(
    "D11 候选会话可校验；只返回渲染可见最外层 closed block（不含 closed block 内部）",
    validation.ok === true && selected.ok === true && ids.includes("container") && !ids.includes("hidden-inner"),
  );
  check(
    "D11 排序严格 oldest→highest-level→nearest-root（c-root,b-scope,a-root,e-scope,d-root,container）",
    ids.join(",") === "c-root,b-scope,a-root,e-scope,d-root,container",
  );
}

// ---------------------------------------------------------------------------
// D15/D16/D17：导出面冻结
// ---------------------------------------------------------------------------
{
  const directNs = await import("./lib/session-tree.js");
  const publicNs = await import("./lib/tool-lists.js");
  const storeCoreNs = await import("./lib/session-tree-store-core.js");
  const storeIoNs = await import("./lib/session-tree-store-io.js");
  const M1_EXPORTS = ["createSession", "append", "open", "close", "promote", "render"];
  const FORBIDDEN_PERSIST = [
    "persist", "archive", "loadSession", "saveSession",
    "createSessionTreeStore", "normalizeStoreRecord", "verifyStoreRecord",
    "canonicalStoreBody", "serializeSession", "parseSession",
    "selectFallbackBlocks", "removeOutermostBlocks", "fallbackTrim",
    "listArchiveRefs", "readArchive", "KAZ_CONTEXT_STORE_ROOT",
  ];
  check(
    "D15 session-tree.js 命名空间仍是六个 M1 纯函数，无 store/persist/archive API",
    Object.keys(directNs).length === 6 &&
      M1_EXPORTS.every((name) => Object.prototype.hasOwnProperty.call(directNs, name)) &&
      FORBIDDEN_PERSIST.every((name) => !Object.prototype.hasOwnProperty.call(directNs, name)),
  );
  check(
    "D15 tool-lists.js 公共根无 store API（M2 只走 lib 子路径）",
    FORBIDDEN_PERSIST.every((name) => !Object.prototype.hasOwnProperty.call(publicNs, name)),
  );
  const forbiddenToken = /token|budget|mc_|trigger/i;
  check(
    "D16 纯 core/I/O 命名空间与公共出口均无 token/budget/MC/trigger 导出",
    !Object.keys(storeCoreNs).some((k) => forbiddenToken.test(k)) &&
      !Object.keys(storeIoNs).some((k) => forbiddenToken.test(k)) &&
      !Object.keys(directNs).some((k) => forbiddenToken.test(k)) &&
      !Object.keys(publicNs).some((k) => forbiddenToken.test(k)),
  );
  const forbiddenRuntime = ["register", "unregister", "cordis", "inject", "whale_expand"];
  check(
    "D17 store core/I-O 命名空间与 session-tree/tool-lists 无 cordis/register/inject/whale_expand",
    forbiddenRuntime.every((name) => !Object.prototype.hasOwnProperty.call(storeCoreNs, name)) &&
      forbiddenRuntime.every((name) => !Object.prototype.hasOwnProperty.call(storeIoNs, name)) &&
      forbiddenRuntime.every((name) => !Object.prototype.hasOwnProperty.call(directNs, name)) &&
      forbiddenRuntime.every((name) => !Object.prototype.hasOwnProperty.call(publicNs, name)),
  );
}

// ---------------------------------------------------------------------------
// D18：纯 store core 零 node:fs / node:crypto
// ---------------------------------------------------------------------------
{
  const coreSource = readFileSync(new URL("./lib/session-tree-store-core.js", import.meta.url), "utf8");
  const hasFsOrCryptoImport =
    /\bfrom\s+["']node:(fs|crypto)["']/.test(coreSource) ||
    /\bimport\s*\(\s*["']node:(fs|crypto)["']/.test(coreSource);
  check(
    "D18 纯 store core 源码无 node:fs / node:crypto import",
    !hasFsOrCryptoImport,
  );
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
if (failures === 0) {
  console.log("\nSESSION-TREE-STORE PROBE OK");
  process.exit(0);
} else {
  console.error(`\nSESSION-TREE-STORE PROBE FAILED: ${failures}`);
  process.exit(1);
}
