// kaz-shared —— Kaz7.0 M2 树 store 纯 core（纯 ESM、零 I/O、hash 注入）
// ===========================================================================
// 依据：不入库文件/Kaz7.0更新规划/Kaz7.0-M2树store设计报告.md
// 边界：
//   * 本模块不 import node:fs / node:crypto / node:path；不读写文件；
//   * checksum 所需 sha256 由 I/O adapter（或探针）注入 hash(text)->hex；
//   * Session 本体保持 M1 JSON 兼容，store 元数据只在 envelope，不混入 Session；
//   * 坏输入返回 { error: { code, message } }（normalize/validate 另按报告返回
//     { ok:false, errors: [] }），不抛异常。
// 不设项：无 token 预算 / MC / trigger 字段，无 DSH 核心改动，无 cordis 注册。
// ===========================================================================

const DEFAULT_ERROR = { code: "invalid-input", message: "invalid input" };

export const KAZ_CONTEXT_STORE_FORMAT = "kaz-context-store";
export const KAZ_CONTEXT_STORE_FORMAT_VERSION = 1;
export const KAZ_CONTEXT_SESSION_SCHEMA = "kaz-context-session/1";
export const KAZ_CONTEXT_ARCHIVE_FORMAT = "kaz-context-archive";
export const KAZ_CONTEXT_ARCHIVE_VERSION = 1;

const MESSAGE_KINDS = new Set([
  "user",
  "assistant",
  "tool",
  "injection",
  "subagent_report",
]);
const NATURAL_BOUNDARIES = new Set(["round", "planItem", "goal", "sublimed"]);
const SESSION_TOP_FIELDS = Object.freeze([
  "schemaVersion",
  "id",
  "nextSeq",
  "nextId",
  "rootChildren",
]);
const SESSION_STORE_FORBIDDEN = Object.freeze([
  "format",
  "formatVersion",
  "sessionSchema",
  "sessionId",
  "updatedAt",
  "archiveRefs",
  "checksum",
  "storeVersion",
  "removedAt",
  "removedFrom",
  "archiveId",
]);
const TOKEN_LIKE_PATTERN = /token|budget|mc_|trigger/i;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function errorResult(code, message) {
  return { error: { code, message } };
}

function tryCatch(fn) {
  try {
    return fn();
  } catch (err) {
    return errorResult(
      "internal-error",
      err instanceof Error ? err.message : String(err),
    );
  }
}

function isJsonSerializable(value, seen = new Set()) {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string" || type === "boolean") return true;
  if (type === "number") return Number.isFinite(value);
  if (type === "undefined" || type === "function" || type === "symbol" || type === "bigint") {
    return false;
  }
  if (type !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isJsonSerializable(item, seen)) return false;
    }
    seen.delete(value);
    return true;
  }
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (!isJsonSerializable(value[key], seen)) return false;
  }
  seen.delete(value);
  return true;
}

function hasForbiddenKeys(node) {
  const keys = Object.keys(node);
  return (
    keys.some((key) => SESSION_STORE_FORBIDDEN.includes(key)) ||
    keys.some((key) => TOKEN_LIKE_PATTERN.test(key))
  );
}

function stableSortDeep(value) {
  if (Array.isArray(value)) return value.map(stableSortDeep);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = stableSortDeep(value[key]);
    }
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
    if (key === "checksum") continue;
    out[key] = record[key];
  }
  return out;
}

function integerAtLeast(value, minimum) {
  return Number.isInteger(value) && value >= minimum;
}

// ---------------------------------------------------------------------------
// validateSessionForStore —— M1 Session 可序列化且不含 store 私有字段
// ---------------------------------------------------------------------------

function validateSessionNode(node, errors, where, isBlockChildren) {
  if (!isPlainObject(node)) {
    errors.push(`${where}: node must be a plain object`);
    return;
  }
  if (hasForbiddenKeys(node)) {
    errors.push(`${where}: node must not contain store metadata/token fields`);
  }
  const kind = node.nodeType;
  if (kind === "leaf") {
    if (!isNonEmptyString(node.id)) errors.push(`${where}: leaf id must be a non-empty string`);
    if (!integerAtLeast(node.seq, 1)) errors.push(`${where}: leaf seq must be an integer >= 1`);
    if (!MESSAGE_KINDS.has(node.kind)) {
      errors.push(`${where}: invalid leaf kind ${String(node.kind)}`);
    }
    if (!("content" in node) || !isJsonSerializable(node.content)) {
      errors.push(`${where}: leaf content must be JSON-serializable`);
    }
    if (node.sourceRef !== undefined && typeof node.sourceRef !== "string") {
      errors.push(`${where}: leaf sourceRef must be a string`);
    }
    if (node.meta !== undefined && (!isPlainObject(node.meta) || !isJsonSerializable(node.meta))) {
      errors.push(`${where}: leaf meta must be a JSON-serializable object`);
    }
    return;
  }
  if (kind === "block") {
    if (!isNonEmptyString(node.id)) errors.push(`${where}: block id must be a non-empty string`);
    if (!integerAtLeast(node.level, 1)) errors.push(`${where}: block level must be an integer >= 1`);
    if (!NATURAL_BOUNDARIES.has(node.boundary)) {
      errors.push(`${where}: invalid block boundary ${String(node.boundary)}`);
    }
    if (node.state !== "closed") errors.push(`${where}: block state must be \"closed\"`);
    if (typeof node.summary !== "string") errors.push(`${where}: block summary must be a string`);
    if (!Array.isArray(node.summarySourceIds) || node.summarySourceIds.some((id) => typeof id !== "string")) {
      errors.push(`${where}: block summarySourceIds must be a string array`);
    }
    if (!Array.isArray(node.children)) {
      errors.push(`${where}: block children must be an array`);
    } else {
      node.children.forEach((child, i) => validateSessionNode(child, errors, `${where}.children[${i}]`, true));
    }
    if (!integerAtLeast(node.openedSeq, 1)) errors.push(`${where}: block openedSeq must be an integer >= 1`);
    if (!integerAtLeast(node.closedSeq, 1)) errors.push(`${where}: block closedSeq must be an integer >= 1`);
    if (!integerAtLeast(node.orderSeq, 1)) errors.push(`${where}: block orderSeq must be an integer >= 1`);
    if (typeof node.fingerprint !== "string") errors.push(`${where}: block fingerprint must be a string`);
    return;
  }
  if (kind === "scope") {
    if (!isNonEmptyString(node.id)) errors.push(`${where}: scope id must be a non-empty string`);
    if (!integerAtLeast(node.level, 1) || node.level > 3) {
      errors.push(`${where}: scope level must be an integer 1..3`);
    }
    if (!NATURAL_BOUNDARIES.has(node.boundary) || node.boundary === "sublimed") {
      errors.push(`${where}: invalid open scope boundary ${String(node.boundary)}`);
    }
    if (!Array.isArray(node.children)) {
      errors.push(`${where}: scope children must be an array`);
    } else {
      node.children.forEach((child, i) => validateSessionNode(child, errors, `${where}.children[${i}]`, false));
    }
    if (!integerAtLeast(node.openedSeq, 1)) errors.push(`${where}: scope openedSeq must be an integer >= 1`);
    if (node.meta !== undefined && (!isPlainObject(node.meta) || !isJsonSerializable(node.meta))) {
      errors.push(`${where}: scope meta must be a JSON-serializable object`);
    }
    return;
  }
  errors.push(`${where}: unsupported nodeType ${String(node.nodeType)}`);
}

/** 校验 Session 是否可安全进入 store（M1 形状 + 无 store 元数据/非 JSON 内容）。 */
export function validateSessionForStore(session) {
  const errors = [];
  if (!isPlainObject(session)) {
    return { ok: false, errors: ["session must be a plain object"] };
  }
  if (session.schemaVersion !== KAZ_CONTEXT_SESSION_SCHEMA) {
    errors.push(`session.schemaVersion must be "${KAZ_CONTEXT_SESSION_SCHEMA}"`);
  }
  if (!isNonEmptyString(session.id)) {
    errors.push("session.id must be a non-empty string");
  }
  if (!integerAtLeast(session.nextSeq, 1)) {
    errors.push("session.nextSeq must be an integer >= 1");
  }
  if (!integerAtLeast(session.nextId, 1)) {
    errors.push("session.nextId must be an integer >= 1");
  }
  if (!Array.isArray(session.rootChildren)) {
    errors.push("session.rootChildren must be an array");
  }
  const topKeys = Object.keys(session);
  if (topKeys.some((key) => !SESSION_TOP_FIELDS.includes(key))) {
    const extra = topKeys.filter((key) => !SESSION_TOP_FIELDS.includes(key)).join(", ");
    errors.push(`session must not carry store metadata/extension fields: ${extra}`);
  }
  if (topKeys.some((key) => TOKEN_LIKE_PATTERN.test(key))) {
    errors.push("session must not carry token/budget/mc/trigger fields");
  }
  if (Array.isArray(session.rootChildren)) {
    session.rootChildren.forEach((child, i) =>
      validateSessionNode(child, errors, `rootChildren[${i}]`, false),
    );
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [] };
}

// ---------------------------------------------------------------------------
// normalizeStoreRecord / canonicalStoreBody / verifyStoreRecord
// ---------------------------------------------------------------------------

function validateState(state, errors) {
  if (!isPlainObject(state)) {
    errors.push("state must be a plain object");
    return;
  }
  const integerFields = [
    ["lastRawSeq", 0],
    ["lastOpSeq", 0],
    ["lastAppliedOpSeq", 0],
    ["nextSessionSeq", 1],
    ["nextSessionId", 1],
  ];
  for (const [name, min] of integerFields) {
    if (!integerAtLeast(state[name], min)) {
      errors.push(`state.${name} must be an integer >= ${min}`);
    }
  }
  if (
    integerAtLeast(state.lastOpSeq, 0) &&
    integerAtLeast(state.lastAppliedOpSeq, 0) &&
    state.lastAppliedOpSeq > state.lastOpSeq
  ) {
    errors.push("state.lastAppliedOpSeq cannot exceed state.lastOpSeq");
  }
}

/** 归一化/校验一个 store envelope（用于读取与探针；未知顶层字段会保留）。 */
export function normalizeStoreRecord(raw) {
  const errors = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ["store record must be a plain object"] };
  }
  if (raw.format !== KAZ_CONTEXT_STORE_FORMAT) {
    errors.push(`format must be "${KAZ_CONTEXT_STORE_FORMAT}"`);
  }
  if (raw.formatVersion !== KAZ_CONTEXT_STORE_FORMAT_VERSION) {
    errors.push(`formatVersion must be ${KAZ_CONTEXT_STORE_FORMAT_VERSION}`);
  }
  if (raw.sessionSchema !== KAZ_CONTEXT_SESSION_SCHEMA) {
    errors.push(`sessionSchema must be "${KAZ_CONTEXT_SESSION_SCHEMA}"`);
  }
  if (!isNonEmptyString(raw.sessionId)) {
    errors.push("sessionId must be a non-empty string");
  }
  if (!isNonEmptyString(raw.updatedAt)) {
    errors.push("updatedAt must be a non-empty string");
  }
  const sessionValidation = isPlainObject(raw.session) ? validateSessionForStore(raw.session) : null;
  if (!sessionValidation) {
    errors.push("session must be a plain object");
  } else if (!sessionValidation.ok) {
    errors.push(...sessionValidation.errors.map((e) => `session: ${e}`));
  }
  if (sessionValidation?.ok) {
    if (raw.sessionSchema !== raw.session.schemaVersion) {
      errors.push("sessionSchema must equal session.schemaVersion");
    }
    if (raw.sessionId !== raw.session.id) {
      errors.push("sessionId must equal session.id");
    }
  }
  validateState(raw.state, errors);
  if (!Array.isArray(raw.archiveRefs)) {
    errors.push("archiveRefs must be an array");
  } else {
    raw.archiveRefs.forEach((ref, i) => {
      if (!isPlainObject(ref)) {
        errors.push(`archiveRefs[${i}] must be a plain object`);
        return;
      }
      for (const field of ["archiveId", "blockId", "path", "removedAt", "file", "reason"]) {
        if (!isNonEmptyString(ref[field])) {
          errors.push(`archiveRefs[${i}].${field} must be a non-empty string`);
        }
      }
    });
  }
  if (!isPlainObject(raw.checksum)) {
    errors.push("checksum must be a plain object");
  } else {
    if (raw.checksum.algorithm !== "sha256") errors.push("checksum.algorithm must be \"sha256\"");
    if (!isNonEmptyString(raw.checksum.hex)) errors.push("checksum.hex must be a non-empty string");
  }
  if (!isJsonSerializable(raw)) {
    errors.push("store record must be JSON-serializable");
  }
  if (errors.length > 0) return { ok: false, errors };
  const record = { ...raw };
  return { ok: true, record };
}

/**
 * checksum 的规范化 JSON：排除 checksum 自身，保留未知扩展字段，键序稳定。
 * 合法输入返回字符串；坏输入按统一错误约定返回 { error }。
 */
export function canonicalStoreBody(record) {
  return tryCatch(() => {
    if (!isPlainObject(record)) {
      return errorResult("invalid-store-record", "canonicalStoreBody requires a plain object");
    }
    if (!isJsonSerializable(record)) {
      return errorResult("invalid-store-record", "store record must be JSON-serializable");
    }
    return stableJsonText(withoutChecksum(record));
  });
}

/** 校验已归一化/待写 store record 的版本、计数、Session 与 checksum。 */
export function verifyStoreRecord(record, hash) {
  return tryCatch(() => {
    if (!isPlainObject(record)) {
      return errorResult("corrupt-store", "store record must be a plain object");
    }
    if (
      record.format !== KAZ_CONTEXT_STORE_FORMAT ||
      record.formatVersion !== KAZ_CONTEXT_STORE_FORMAT_VERSION ||
      record.sessionSchema !== KAZ_CONTEXT_SESSION_SCHEMA
    ) {
      return errorResult("incompatible-version", "store format/version/schema is not supported");
    }
    const normalized = normalizeStoreRecord(record);
    if (!normalized.ok) {
      return errorResult("corrupt-store", `invalid store envelope: ${normalized.errors.join("; ")}`);
    }
    if (record.sessionId !== record.session?.id) {
      return errorResult("session-id-mismatch", "sessionId does not match session.id");
    }
    const s = record.session;
    const st = record.state;
    if (st.nextSessionSeq !== s?.nextSeq || st.nextSessionId !== s?.nextId) {
      return errorResult("inconsistent-state", "state counters do not match session counters");
    }
    const sessionValidation = validateSessionForStore(s);
    if (!sessionValidation.ok) {
      return errorResult("invalid-session", sessionValidation.errors.join("; "));
    }
    if (typeof hash !== "function") {
      return errorResult("invalid-hash", "hash must be a function");
    }
    const body = stableJsonText(withoutChecksum(record));
    const expected = hash(body);
    if (
      !isPlainObject(record.checksum) ||
      record.checksum.algorithm !== "sha256" ||
      typeof record.checksum.hex !== "string" ||
      record.checksum.hex.length === 0
    ) {
      return errorResult("corrupt-store", "checksum is missing or malformed");
    }
    if (record.checksum.hex !== expected) {
      return errorResult("corrupt-store", "checksum mismatch");
    }
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// serializeSession / parseSession
// ---------------------------------------------------------------------------

/** 把 M1 Session 序列化为 UTF-8 无 BOM 语义的 JSON 文本（纯函数返回字符串）。 */
export function serializeSession(session) {
  return tryCatch(() => {
    const validation = validateSessionForStore(session);
    if (!validation.ok) {
      return errorResult("invalid-session", validation.errors.join("; "));
    }
    return { ok: true, text: `${JSON.stringify(session, null, 2)}\n` };
  });
}

/** 解析并校验 store.session 中的 Session 文本。 */
export function parseSession(text) {
  return tryCatch(() => {
    if (typeof text !== "string") {
      return errorResult("invalid-session-text", "parseSession requires a string");
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return errorResult("invalid-session-text", err instanceof Error ? err.message : String(err));
    }
    const validation = validateSessionForStore(parsed);
    if (!validation.ok) {
      return errorResult("invalid-session", validation.errors.join("; "));
    }
    return { ok: true, session: parsed };
  });
}

// ---------------------------------------------------------------------------
// 1M 兜底纯函数：渲染可见最外层 closed block
// ---------------------------------------------------------------------------

function collectVisibleBlockCandidates(session) {
  const candidates = [];
  const visit = (children, scopeIds, containerPath) => {
    children.forEach((node, index) => {
      if (node?.nodeType === "block") {
        if (node.state === "closed" && Number.isInteger(node.level) && node.level >= 1) {
          candidates.push({
            id: node.id,
            pathParts: [...scopeIds, node.id],
            path: [...scopeIds, node.id].join("/"),
            level: node.level,
            depth: scopeIds.length,
            orderSeq: node.orderSeq,
            closedSeq: node.closedSeq,
            openedSeq: node.openedSeq,
            node,
            containerPath,
            index,
          });
        }
        // closed block 内部不进入候选（内部已升华/落定内容不可单块移除）
        return;
      }
      if (node?.nodeType === "scope") {
        visit(node.children, [...scopeIds, node.id], [...containerPath, index]);
      }
    });
  };
  visit(session.rootChildren, [], []);
  return candidates;
}

function sortCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    const ta = a.orderSeq ?? a.closedSeq ?? a.openedSeq ?? Number.MAX_SAFE_INTEGER;
    const tb = b.orderSeq ?? b.closedSeq ?? b.openedSeq ?? Number.MAX_SAFE_INTEGER;
    return (
      (ta - tb) ||
      (b.level - a.level) ||
      (a.depth - b.depth) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
  });
}

/** 按 oldest → highest-level → nearest-root 选择渲染可见最外层 closed block。 */
export function selectFallbackBlocks(session, count) {
  return tryCatch(() => {
    const validation = validateSessionForStore(session);
    if (!validation.ok) {
      return errorResult("invalid-session", validation.errors.join("; "));
    }
    if (!Number.isInteger(count) || count < 0) {
      return errorResult("invalid-count", "count must be a non-negative integer");
    }
    const all = sortCandidates(collectVisibleBlockCandidates(session));
    const chosen = count === 0 ? [] : all.slice(0, count);
    return {
      ok: true,
      candidates: chosen.map(({ id, path, level, depth }) => ({ id, path, level, depth })),
    };
  });
}

function collectArchiveFacts(block) {
  const leafIds = [];
  const summarySourceIds = [];
  const sourceRefs = [];
  const walk = (children) => {
    for (const child of children) {
      if (!child) continue;
      if (child.nodeType === "leaf") {
        leafIds.push(child.id);
        if (typeof child.sourceRef === "string" && child.sourceRef.length > 0) {
          sourceRefs.push(child.sourceRef);
        }
      } else if (child.nodeType === "block") {
        if (Array.isArray(child.summarySourceIds)) {
          summarySourceIds.push(...child.summarySourceIds);
        }
        walk(child.children);
      }
    }
  };
  if (Array.isArray(block.summarySourceIds)) summarySourceIds.push(...block.summarySourceIds);
  walk(block.children || []);
  return {
    leafIds: [...new Set(leafIds)],
    summarySourceIds: [...new Set(summarySourceIds)],
    sourceRefs: [...new Set(sourceRefs)],
  };
}

function blockPayloadFromCandidate(candidate) {
  const facts = collectArchiveFacts(candidate.node);
  const block = JSON.parse(JSON.stringify(candidate.node));
  const removedFrom = candidate.depth === 0 ? "root" : candidate.pathParts[candidate.depth - 1];
  return {
    block,
    path: candidate.path,
    removedFrom,
    leafIds: facts.leafIds,
    summarySourceIds: facts.summarySourceIds,
    sourceRefs: facts.sourceRefs,
    seqRange: {
      openedSeq: candidate.node.openedSeq,
      closedSeq: candidate.node.closedSeq,
    },
  };
}

/** 为给定可见最外层 closed block 生成归档 payload（不含 archiveId/removedAt/checksum）。 */
export function archivePayloadForBlocks(session, blockIds) {
  return tryCatch(() => {
    const validation = validateSessionForStore(session);
    if (!validation.ok) {
      return errorResult("invalid-session", validation.errors.join("; "));
    }
    if (!Array.isArray(blockIds) || blockIds.length === 0 || blockIds.some((id) => typeof id !== "string")) {
      return errorResult("invalid-block-ids", "blockIds must be a non-empty array of strings");
    }
    if (new Set(blockIds).size !== blockIds.length) {
      return errorResult("duplicate-block-id", "blockIds must not contain duplicates");
    }
    const byId = new Map(collectVisibleBlockCandidates(session).map((c) => [c.id, c]));
    const payloads = [];
    for (const id of blockIds) {
      const candidate = byId.get(id);
      if (!candidate) {
        return errorResult("block-not-outermost", `block is not a render-visible outermost closed block: ${id}`);
      }
      payloads.push(blockPayloadFromCandidate(candidate));
    }
    return { ok: true, payloads };
  });
}

function removeNodesImmutable(children, containerPath, index) {
  if (containerPath.length === 0) {
    return children.filter((_, i) => i !== index);
  }
  const [head, ...rest] = containerPath;
  return children.map((child, i) => {
    if (i !== head || child?.nodeType !== "scope") return child;
    return { ...child, children: removeNodesImmutable(child.children, rest, index) };
  });
}

/** 移除渲染可见最外层 closed block（先由调用方完成归档落盘；不递归进 closed block）。 */
export function removeOutermostBlocks(session, blockIds) {
  return tryCatch(() => {
    const payloadResult = archivePayloadForBlocks(session, blockIds);
    if (!payloadResult.ok) return payloadResult;
    const byId = new Map(collectVisibleBlockCandidates(session).map((c) => [c.id, c]));
    const plans = [];
    for (const id of blockIds) {
      const candidate = byId.get(id);
      if (!candidate) {
        return errorResult("block-not-outermost", `block is not a render-visible outermost closed block: ${id}`);
      }
      plans.push(candidate);
    }
    const keyOf = (path) => path.join("/");
    const groups = new Map();
    for (const candidate of plans) {
      const key = keyOf(candidate.containerPath);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(candidate);
    }
    let nextRootChildren = session.rootChildren;
    const changes = [];
    for (const [pathText, group] of groups) {
      const containerPath = pathText.length === 0 ? [] : pathText.split("/").map(Number);
      const sorted = [...group].sort((a, b) => b.index - a.index);
      for (const candidate of sorted) {
        nextRootChildren = removeNodesImmutable(nextRootChildren, containerPath, candidate.index);
        changes.push({
          type: "fallback-remove",
          blockId: candidate.id,
          path: candidate.path,
          level: candidate.level,
          boundaryType: "planned-invalidation",
        });
      }
    }
    const nextSession = { ...session, rootChildren: nextRootChildren };
    return {
      ok: true,
      session: nextSession,
      changes,
      payloads: payloadResult.payloads,
    };
  });
}
