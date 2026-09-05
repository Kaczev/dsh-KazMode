// kaz-shared —— Kaz7.0 M5 纯证据打包模块（纯 ESM、零 I/O）
// ===========================================================================
// 依据：不入库文件/Kaz7.0更新规划/Kaz7.0-M5 memory-maintenance 收口设计报告.md
//       （D3/D4/D5/D6/D9 + §5.2–5.6）
// 边界：
//   * 本模块只吃已加载对象/引用，不 import node:fs / node:crypto / node:path，
//     不读写 ka-whale-memory / store / archive / raw 文件；
//   * 不注册 cordis / Stable Main / 工具面；不进 tool-lists.js 公共根；
//   * 不做记忆去重（归 memoryMaintainer memory_search 判断）；
//   * 无 token 预算 / MC / trigger 字段；无运行时注册。
//   * 坏输入返回 { error: { code, message } }，不抛异常；
//     validateMemoryCandidateDraft 按报告返回 { ok, errors }。
// 分组约定（报告开放点 3 的最小固定实现）：
//   * block ref 是证据组种子；ref.path 位于该 block 路径下的 leaf ref 并入同组；
//   * 无 block 覆盖的 leaf、raw、archive 各自独立成组；
//   * raw 只按 seq 引用，不猜测其树内归属。
// ===========================================================================

import { validateSessionForStore } from "./session-tree-store-core.js";
import { parseWhalePath, resolveWhalePath } from "./session-tree-expand.js";

const REF_KINDS = new Set(["block", "leaf", "raw", "archive"]);
const TYPE_VALUES = new Set([
  "success_pattern",
  "error_pattern",
  "insight",
  "design",
  "reference",
]);
const CONFIDENCE_VALUES = new Set(["unknown", "low", "medium", "high"]);
const NAMESPACE_VALUES = new Set(["global", "project"]);
const PATH_PURPOSE_DEFAULT = "evidence-file";
const PATH_PURPOSE_SOURCE_REF = "source-ref";
const MAX_NAME_LENGTH = 80;
const MAX_PATH_COUNT = 8;
const MAX_KEYWORDS = 8;
const MAX_FACT_SNIPPET = 600;

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

function trimLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function shorten(text, maxLength = MAX_NAME_LENGTH) {
  const clean = trimLine(text);
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1)}…`;
}

function isBlankValue(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

function jsonFact(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function snippet(value, maxLength = MAX_FACT_SNIPPET) {
  const text = trimLine(jsonFact(value));
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const key = value.trim();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function parsePathText(pathText) {
  const parsed = parseWhalePath(pathText);
  if (parsed.error) return null;
  if (parsed.isRoot || parsed.segments.length === 0) return null;
  return parsed.segments;
}

function pathIsUnder(childPath, parentPath) {
  const parent = parsePathText(parentPath);
  const child = parsePathText(childPath);
  if (!parent || !child) return false;
  if (parent.length >= child.length) return false;
  return parent.every((segment, index) => segment === child[index]);
}

function samePath(a, b) {
  const left = parsePathText(a);
  const right = parsePathText(b);
  if (!left || !right) return false;
  return left.length === right.length && left.every((s, i) => s === right[i]);
}

function isHiddenId(id, hiddenRootIds) {
  return Array.isArray(hiddenRootIds) && hiddenRootIds.includes(id);
}

// ---------------------------------------------------------------------------
// 校验 / 归一化
// ---------------------------------------------------------------------------

function validateRef(ref, index) {
  if (!isPlainObject(ref)) {
    return errorResult(
      "invalid-ref",
      `refs[${index}] must be a plain object`,
    );
  }
  if (!REF_KINDS.has(ref.kind)) {
    return errorResult(
      "invalid-ref",
      `refs[${index}].kind must be one of: ${[...REF_KINDS].join(", ")}`,
    );
  }
  if (ref.reason !== undefined && typeof ref.reason !== "string") {
    return errorResult(
      "invalid-ref",
      `refs[${index}].reason must be a string when provided`,
    );
  }
  const normalized = { kind: ref.kind };
  if (typeof ref.reason === "string" && ref.reason.trim().length > 0) {
    normalized.reason = ref.reason.trim();
  }
  if (ref.kind === "block" || ref.kind === "leaf") {
    if (!isNonEmptyString(ref.id)) {
      return errorResult(
        "invalid-ref",
        `refs[${index}].id must be a non-empty string for kind "${ref.kind}"`,
      );
    }
    if (!isNonEmptyString(ref.path)) {
      return errorResult(
        "invalid-ref",
        `refs[${index}].path must be a non-empty string for kind "${ref.kind}"`,
      );
    }
    const parsed = parsePathText(ref.path);
    if (!parsed) {
      return errorResult(
        "invalid-ref",
        `refs[${index}].path must be a valid tree path`,
      );
    }
    normalized.id = ref.id;
    normalized.path = ref.path;
    if (ref.kind === "leaf") {
      if (!Number.isInteger(ref.seq) || ref.seq < 1) {
        return errorResult(
          "invalid-ref",
          `refs[${index}].seq must be a positive integer for kind "leaf"`,
        );
      }
      normalized.seq = ref.seq;
    }
    return { ok: true, ref: normalized };
  }
  if (ref.kind === "raw") {
    if (!Number.isInteger(ref.seq) || ref.seq < 1) {
      return errorResult(
        "invalid-ref",
        `refs[${index}].seq must be a positive integer for kind "raw"`,
      );
    }
    normalized.seq = ref.seq;
    if (ref.line !== undefined) {
      if (!Number.isInteger(ref.line) || ref.line < 1) {
        return errorResult(
          "invalid-ref",
          `refs[${index}].line must be a positive integer when provided`,
        );
      }
      normalized.line = ref.line;
    }
    return { ok: true, ref: normalized };
  }
  if (ref.kind === "archive") {
    if (!isNonEmptyString(ref.archiveId)) {
      return errorResult(
        "invalid-ref",
        `refs[${index}].archiveId must be a non-empty string for kind "archive"`,
      );
    }
    normalized.archiveId = ref.archiveId;
    return { ok: true, ref: normalized };
  }
  return errorResult("invalid-ref", `unsupported ref kind: ${String(ref.kind)}`);
}

function validateHiddenRootIds(value) {
  if (value === undefined || value === null) return { ok: true, ids: [] };
  if (!Array.isArray(value)) {
    return errorResult(
      "invalid-hidden-root-ids",
      "hiddenRootIds must be an array of unique non-empty strings",
    );
  }
  for (let i = 0; i < value.length; i += 1) {
    if (!isNonEmptyString(value[i])) {
      return errorResult(
        "invalid-hidden-root-ids",
        `hiddenRootIds[${i}] must be a non-empty string`,
      );
    }
  }
  if (new Set(value).size !== value.length) {
    return errorResult(
      "invalid-hidden-root-ids",
      "hiddenRootIds must not contain duplicates",
    );
  }
  return { ok: true, ids: [...value] };
}

function validateOptions(opts) {
  if (opts === undefined || opts === null) return { ok: true, opts: {} };
  if (!isPlainObject(opts)) {
    return errorResult("invalid-options", "opts must be an object");
  }
  const clean = {};
  if (opts.maxCandidatesPerGroup !== undefined) {
    if (!Number.isInteger(opts.maxCandidatesPerGroup) || opts.maxCandidatesPerGroup < 1) {
      return errorResult(
        "invalid-options",
        "opts.maxCandidatesPerGroup must be a positive integer",
      );
    }
    clean.maxCandidatesPerGroup = opts.maxCandidatesPerGroup;
  }
  if (opts.includeRawExact !== undefined) {
    if (typeof opts.includeRawExact !== "boolean") {
      return errorResult(
        "invalid-options",
        "opts.includeRawExact must be a boolean",
      );
    }
    clean.includeRawExact = opts.includeRawExact;
  }
  if (opts.namespaceHint !== undefined) {
    if (!NAMESPACE_VALUES.has(opts.namespaceHint)) {
      return errorResult(
        "invalid-options",
        "opts.namespaceHint must be \"global\" or \"project\"",
      );
    }
    clean.namespaceHint = opts.namespaceHint;
  }
  for (const field of ["storePath", "sessionDirId"]) {
    if (opts[field] !== undefined) {
      if (typeof opts[field] !== "string" || opts[field].length === 0) {
        return errorResult(
          "invalid-options",
          `opts.${field} must be a non-empty string`,
        );
      }
      clean[field] = opts[field];
    }
  }
  return { ok: true, opts: clean };
}

function validateArchiveRecords(value) {
  if (value === undefined || value === null) {
    return { ok: true, map: new Map(), records: [] };
  }
  if (!Array.isArray(value)) {
    return errorResult(
      "invalid-archive-records",
      "archiveRecords must be an array",
    );
  }
  const map = new Map();
  for (let i = 0; i < value.length; i += 1) {
    const record = value[i];
    if (!isPlainObject(record) || !isNonEmptyString(record.archiveId)) {
      return errorResult(
        "invalid-archive-records",
        `archiveRecords[${i}] must be an object with non-empty archiveId`,
      );
    }
    if (map.has(record.archiveId)) {
      return errorResult(
        "invalid-archive-records",
        `duplicate archiveId in archiveRecords: ${record.archiveId}`,
      );
    }
    map.set(record.archiveId, record);
  }
  return { ok: true, map, records: value };
}

function rawEventMapFrom(value) {
  if (value === undefined || value === null) {
    return { ok: true, get: () => undefined };
  }
  if (value instanceof Map) {
    return {
      ok: true,
      get: (seq) => value.get(seq),
    };
  }
  if (isPlainObject(value)) {
    return {
      ok: true,
      get: (seq) => value[String(seq)],
    };
  }
  return errorResult(
    "invalid-raw-event-by-seq",
    "rawEventBySeq must be a Map<number, RawEvent> or plain object",
  );
}

function prepareInput(input) {
  if (!isPlainObject(input)) {
    return errorResult("invalid-input", "MemoryEvidenceInput must be an object");
  }
  if (!Array.isArray(input.refs)) {
    return errorResult("invalid-refs", "refs must be an array");
  }
  const refs = [];
  for (let i = 0; i < input.refs.length; i += 1) {
    const validated = validateRef(input.refs[i], i);
    if (validated.error) return validated;
    refs.push(validated.ref);
  }
  if (input.session !== undefined && input.session !== null) {
    const sessionCheck = validateSessionForStore(input.session);
    if (!sessionCheck.ok) {
      return errorResult(
        "invalid-session",
        `session is invalid: ${sessionCheck.errors.join("; ")}`,
      );
    }
  }
  const hidden = validateHiddenRootIds(input.hiddenRootIds);
  if (hidden.error) return hidden;
  const options = validateOptions(input.opts);
  if (options.error) return options;
  const archives = validateArchiveRecords(input.archiveRecords);
  if (archives.error) return archives;
  const raws = rawEventMapFrom(input.rawEventBySeq);
  if (raws.error) return raws;
  return {
    ok: true,
    session: isPlainObject(input.session) ? input.session : undefined,
    refs,
    hiddenRootIds: hidden.ids,
    opts: options.opts,
    archiveMap: archives.map,
    rawGet: raws.get,
  };
}

// ---------------------------------------------------------------------------
// 解析单个 MemoryEvidenceRef
// ---------------------------------------------------------------------------

function resolveRef(prepared, ref) {
  const hidden = isHiddenId(ref.id, prepared.hiddenRootIds);
  if (ref.kind === "block") {
    if (!prepared.session) return null;
    const resolved = resolveWhalePath(prepared.session, ref.path);
    if (resolved.error || resolved.kind !== "block") return null;
    const node = resolved.node;
    if (!node || node.id !== ref.id || node.state !== "closed") return null;
    return {
      kind: "block",
      ref,
      id: node.id,
      path: ref.path,
      node,
      summary: typeof node.summary === "string" ? node.summary : "",
      sessionId: prepared.session.id,
      hidden,
      archiveRefs: Array.isArray(node.archiveRefs) ? node.archiveRefs : [],
      leafIds: Array.isArray(node.leafIds) ? node.leafIds : [],
    };
  }
  if (ref.kind === "leaf") {
    if (!prepared.session) return null;
    const resolved = resolveWhalePath(prepared.session, ref.path);
    if (resolved.error || resolved.kind !== "leaf") return null;
    const node = resolved.node;
    if (
      !node ||
      node.id !== ref.id ||
      node.seq !== ref.seq ||
      isBlankValue(node.content)
    ) {
      return null;
    }
    return {
      kind: "leaf",
      ref,
      id: node.id,
      path: ref.path,
      seq: node.seq,
      node,
      content: node.content,
      sourceRef: typeof node.sourceRef === "string" ? node.sourceRef : undefined,
      meta: isPlainObject(node.meta) ? node.meta : undefined,
      sessionId: prepared.session.id,
      hidden,
    };
  }
  if (ref.kind === "raw") {
    const raw = prepared.rawGet(ref.seq);
    if (!isPlainObject(raw)) return null;
    if (raw.type !== undefined && raw.type !== "raw") return null;
    if (raw.seq !== undefined && raw.seq !== ref.seq) return null;
    if (isBlankValue(raw.content)) return null;
    return {
      kind: "raw",
      ref,
      seq: ref.seq,
      raw,
      content: raw.content,
      sourceRef: typeof raw.sourceRef === "string" ? raw.sourceRef : undefined,
      meta: isPlainObject(raw.meta) ? raw.meta : undefined,
    };
  }
  if (ref.kind === "archive") {
    const record = prepared.archiveMap.get(ref.archiveId);
    if (!isPlainObject(record)) return null;
    if (!isPlainObject(record.block) || !isNonEmptyString(record.path)) return null;
    return {
      kind: "archive",
      ref,
      archiveId: ref.archiveId,
      record,
      block: record.block,
      path: record.path,
      removedAt: typeof record.removedAt === "string" ? record.removedAt : undefined,
      reason: typeof record.reason === "string" ? record.reason : undefined,
      summary:
        isPlainObject(record.block) && typeof record.block.summary === "string"
          ? record.block.summary
          : "",
      sourceRefs: Array.isArray(record.sourceRefs) ? record.sourceRefs : [],
      leafIds: Array.isArray(record.leafIds) ? record.leafIds : [],
    };
  }
  return null;
}

function collectResolved(prepared) {
  const nodes = [];
  const missing = [];
  for (const ref of prepared.refs) {
    const node = resolveRef(prepared, ref);
    if (node) {
      nodes.push(node);
    } else {
      missing.push({ ref, reason: "no-source" });
    }
  }
  return { nodes, missing };
}

// ---------------------------------------------------------------------------
// 分组：一个证据组 = 一个候选
// ---------------------------------------------------------------------------

function findNearestBlockGroup(leafNode, blockGroups) {
  let best = null;
  let bestDepth = -1;
  for (const group of blockGroups) {
    const primary = group.primary;
    const blockPath = primary.path;
    if (!pathIsUnder(leafNode.path, blockPath)) continue;
    const depth = parsePathText(blockPath)?.length ?? -1;
    if (depth > bestDepth) {
      best = group;
      bestDepth = depth;
    }
  }
  return best;
}

function groupNodes(nodes) {
  const blockGroups = [];
  const blockGroupByNodeIndex = new Map();
  nodes.forEach((node, index) => {
    if (node.kind === "block") {
      const group = {
        primary: node,
        members: [],
        firstIndex: index,
        refs: [node.ref],
      };
      blockGroups.push(group);
      blockGroupByNodeIndex.set(index, group);
    }
  });

  const usedLeaf = new Set();
  nodes.forEach((node, index) => {
    if (node.kind !== "leaf") return;
    const group = findNearestBlockGroup(node, blockGroups);
    if (group) {
      group.members.push(node);
      group.refs.push(node.ref);
      group.firstIndex = Math.min(group.firstIndex, index);
      usedLeaf.add(index);
    }
  });

  const groups = [];
  nodes.forEach((node, index) => {
    if (node.kind === "block") {
      const group = blockGroupByNodeIndex.get(index);
      if (!groups.includes(group)) groups.push(group);
      return;
    }
    if (node.kind === "leaf") {
      if (usedLeaf.has(index)) return;
      groups.push({ primary: node, members: [], firstIndex: index, refs: [node.ref] });
      return;
    }
    groups.push({ primary: node, members: [], firstIndex: index, refs: [node.ref] });
  });

  groups.sort((a, b) => a.firstIndex - b.firstIndex);
  return groups;
}

// ---------------------------------------------------------------------------
// evidence/context/keywords/paths 生成
// ---------------------------------------------------------------------------

function storeLabel(prepared) {
  if (typeof prepared.opts.storePath === "string") return prepared.opts.storePath;
  if (typeof prepared.opts.sessionDirId === "string") return prepared.opts.sessionDirId;
  if (typeof prepared.session?.id === "string") return `session:${prepared.session.id}`;
  return "unknown";
}

function sourceLabelsForGroup(group) {
  const labels = [];
  const primary = group.primary;
  if (primary.kind === "block") labels.push(`tree-block:${primary.path}`);
  if (primary.kind === "leaf") labels.push(`tree-leaf:${primary.path}(seq ${primary.seq})`);
  if (primary.kind === "raw") {
    const lineText = Number.isInteger(primary.ref.line) ? `; line ${primary.ref.line}` : "";
    labels.push(`raw:${primary.seq}${lineText}`);
  }
  if (primary.kind === "archive") labels.push(`archive:${primary.archiveId}`);
  for (const member of group.members) {
    if (member.kind === "leaf") labels.push(`leaf:${member.path}(seq ${member.seq})`);
  }
  return uniqueStrings(labels);
}

function reasonForGroup(group) {
  const reasons = [];
  for (const ref of group.refs) {
    if (typeof ref.reason === "string" && ref.reason.trim().length > 0) {
      reasons.push(ref.reason.trim());
    }
  }
  return uniqueStrings(reasons).join("; ");
}

function factsForGroup(group, prepared) {
  const facts = [];
  const primary = group.primary;
  if (primary.kind === "leaf") {
    facts.push(snippet(primary.content));
  } else if (primary.kind === "raw") {
    if (prepared.opts.includeRawExact !== false) {
      facts.push(snippet(primary.content));
    }
  } else if (primary.kind === "archive") {
    if (primary.sourceRefs.length > 0) {
      facts.push(`归档 sourceRefs：${primary.sourceRefs.join(", ")}`);
    }
  }
  for (const member of group.members) {
    if (member.kind === "leaf") {
      facts.push(`${member.path}（seq ${member.seq}）：${snippet(member.content)}`);
    }
  }
  return uniqueStrings(facts);
}

function conclusionForGroup(group) {
  const primary = group.primary;
  if (primary.kind === "block") return primary.summary;
  if (primary.kind === "archive") {
    if (isPlainObject(primary.block) && typeof primary.block.summary === "string") {
      return primary.block.summary;
    }
  }
  return "";
}

function contentTextForGroup(group, prepared, draftName) {
  const parts = [`# ${draftName}`];
  const reason = reasonForGroup(group);
  if (reason.length > 0) parts.push(`- 上下文：${reason}`);
  const facts = factsForGroup(group, prepared);
  const conclusion = conclusionForGroup(group);
  if (facts.length > 0) {
    parts.push("- 精确事实：");
    for (const fact of facts) parts.push(`  - ${fact}`);
  }
  if (conclusion.trim().length > 0) {
    parts.push(`- 摘要/结论：${conclusion.trim()}`);
  }
  if (primaryArchiveRemovedAt(group)) {
    parts.push(`- 归档时刻：${primaryArchiveRemovedAt(group)}`);
  }
  if (facts.length === 0 && conclusion.trim().length === 0) return "";
  return parts.join("\n");
}

function primaryArchiveRemovedAt(group) {
  return group.primary.kind === "archive" && typeof group.primary.removedAt === "string"
    ? group.primary.removedAt
    : "";
}

function draftNameForGroup(group, prepared) {
  const reason = reasonForGroup(group);
  if (reason.length > 0) return shorten(reason);
  const conclusion = conclusionForGroup(group);
  if (conclusion.trim().length > 0) return shorten(conclusion);
  const facts = factsForGroup(group, prepared);
  if (facts.length > 0) return shorten(facts[0].replace(/^[^：:]*[：:]\s*/, ""));
  const labels = sourceLabelsForGroup(group);
  return shorten(labels[0] ?? "memory-evidence");
}

function sourceRefStringsForNode(node) {
  const out = [];
  if (typeof node.sourceRef === "string" && node.sourceRef.trim().length > 0) {
    out.push(node.sourceRef.trim());
  }
  if (isPlainObject(node.meta)) {
    collectStrings(node.meta, out, 200);
  }
  return uniqueStrings(out);
}

function collectStrings(value, out, limit) {
  if (out.length >= limit) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, limit);
    return;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (key === "content" && typeof value[key] === "string") continue;
      collectStrings(value[key], out, limit);
    }
  }
}

function looksLikeFilePath(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  if (/^[A-Za-z]:[\\/]/.test(text)) return true;
  if (/^(?:\.{0,2}[\\/])?(?:[\w.-]+[\\/])+[\w.-]+(?:\.[A-Za-z0-9]{1,8})?$/.test(text)) {
    return /[\\/]/.test(text) || /\.[A-Za-z0-9]{1,8}$/.test(text);
  }
  return false;
}

function collectPathCandidatesFromText(text, out, limit) {
  if (typeof text !== "string" || text.length === 0) return;
  const patterns = [
    /[A-Za-z]:[\\/][^\s"'<>|;,:]+/g,
    /(?:^|[\s"'（(])((?:\.{0,2}[\\/])?(?:[\w.-]+[\\/])+[\w.-]+(?:\.[A-Za-z0-9]{1,8}))/g,
  ];
  for (const pattern of patterns) {
    let match;
    while (out.length < limit && (match = pattern.exec(text)) !== null) {
      const value = (match[1] ?? match[0]).trim();
      if (value.length > 0 && !/[<>|]/.test(value)) out.push(value);
    }
  }
}

function pathCandidatesForGroup(group, prepared) {
  const seen = new Map();
  const candidates = [];
  const addPath = (path, purpose) => {
    if (typeof path !== "string" || path.trim().length === 0) return;
    const clean = path.trim();
    if (!looksLikeFilePath(clean)) return;
    const existing = seen.get(clean);
    if (existing) {
      // 同一路径保留更具体的 source-ref 用途；不同用途不再重复占位。
      if (existing.purpose === PATH_PURPOSE_DEFAULT && purpose === PATH_PURPOSE_SOURCE_REF) {
        existing.purpose = purpose;
      }
      return;
    }
    const item = { path: clean, purpose };
    seen.set(clean, item);
    candidates.push(item);
  };

  const addNode = (node, fallbackPurpose) => {
    for (const sourceRef of sourceRefStringsForNode(node)) {
      addPath(sourceRef, PATH_PURPOSE_SOURCE_REF);
    }
    const texts = [];
    if (node.kind === "leaf" && !isBlankValue(node.content)) {
      texts.push(typeof node.content === "string" ? node.content : jsonFact(node.content));
    }
    if (node.kind === "raw" && !isBlankValue(node.content)) {
      texts.push(typeof node.content === "string" ? node.content : jsonFact(node.content));
    }
    for (const text of texts) {
      const found = [];
      collectPathCandidatesFromText(text, found, MAX_PATH_COUNT);
      for (const path of found) addPath(path, fallbackPurpose);
    }
  };

  addNode(group.primary, PATH_PURPOSE_DEFAULT);
  for (const member of group.members) addNode(member, PATH_PURPOSE_DEFAULT);

  if (group.primary.kind === "archive") {
    for (const ref of group.primary.sourceRefs) addPath(ref, PATH_PURPOSE_SOURCE_REF);
  }
  // 返回全部候选（有上限防失控）；由 build/truncate 或 pack 决定保留 ≤8 并记录溢出。
  return candidates.slice(0, 64);
}

function keywordsForGroup(group, prepared, draftName, draftContent, paths) {
  const set = new Set();
  const addTokens = (text) => {
    if (typeof text !== "string") return;
    const parts = text
      .toLowerCase()
      .split(/[\s,;:!?()[\]{}"'<>|，。；：！？（）“”‘’《》【】、…—·]+/u);
    for (const part of parts) {
      const token = part.trim().replace(/^[.:_\-\\/]+|[.:_\-\\/]+$/g, "");
      if (token.length >= 2 && !token.includes("/") && !token.includes("\\")) {
        set.add(token);
      }
    }
  };
  addTokens(reasonForGroup(group));
  for (const label of sourceLabelsForGroup(group)) {
    const treeMatch = /^tree-(?:block|leaf):([^;(]+)/.exec(label);
    if (treeMatch) {
      const segments = treeMatch[1].split("/").filter(Boolean);
      if (segments.length > 0) set.add(segments[0].toLowerCase());
    } else if (label.startsWith("archive:")) {
      const archiveId = label.slice("archive:".length).trim();
      if (archiveId.length > 0) set.add(archiveId.toLowerCase());
    }
  }
  for (const pathItem of paths) {
    const base = pathItem.path.split(/[\\/]/).filter(Boolean).pop();
    if (base) set.add(base.toLowerCase());
  }
  addTokens(draftName);
  addTokens(draftContent);
  if (set.size < 3) {
    const anchors = ["memory-evidence"];
    if (group.primary.kind === "block") anchors.push("tree-block");
    if (group.primary.kind === "leaf") anchors.push("tree-leaf");
    if (group.primary.kind === "raw") anchors.push("raw");
    if (group.primary.kind === "archive") anchors.push("archive");
    for (const anchor of anchors) set.add(anchor);
  }
  const stop = new Set([
    "the", "and", "for", "with", "from", "that", "this", "was", "are", "has",
    "had", "not", "but", "you", "your", "our", "all", "can", "will", "were",
    "been", "into", "out", "its", "it's", "per", "via", "when", "what", "which",
    "上下文", "精确事实", "摘要", "结论", "归档", "sourceRefs", "seq",
  ]);
  return [...set]
    .filter((token) => !stop.has(token) && !/^\d+$/.test(token))
    .slice(0, MAX_KEYWORDS);
}

function draftRefsForGroup(group, prepared) {
  const out = [];
  const add = (ref) => {
    const draftRef = { kind: ref.kind };
    if (ref.kind === "block" || ref.kind === "leaf") {
      draftRef.id = ref.id;
      draftRef.path = ref.path;
      if (ref.kind === "leaf") draftRef.seq = ref.seq;
    }
    if (ref.kind === "raw") {
      draftRef.seq = ref.seq;
      if (ref.line !== undefined) draftRef.line = ref.line;
    }
    if (ref.kind === "archive") {
      draftRef.archiveId = ref.archiveId;
    }
    if (typeof prepared.opts.storePath === "string") {
      draftRef.storePath = prepared.opts.storePath;
    }
    out.push(draftRef);
  };
  add(group.primary.ref);
  for (const member of group.members) add(member.ref);
  return out;
}

function evidenceTextForGroup(group, prepared) {
  const lines = [`source: ${sourceLabelsForGroup(group).join("; ")}`];
  lines.push(`store: ${storeLabel(prepared)}`);
  const reason = reasonForGroup(group);
  if (reason.length > 0) lines.push(`reason: ${reason}`);
  if (group.primary.kind === "archive" && typeof group.primary.removedAt === "string") {
    lines.push(`removedAt: ${group.primary.removedAt}`);
  }
  const facts = factsForGroup(group, prepared);
  for (const fact of facts) lines.push(`fact: ${fact}`);
  return lines.join("\n");
}

function buildGroupDraft(group, prepared) {
  const draftName = draftNameForGroup(group, prepared);
  const content = contentTextForGroup(group, prepared, draftName);
  if (content.trim().length === 0) return null;
  const paths = pathCandidatesForGroup(group, prepared).slice(0, MAX_PATH_COUNT);
  const evidence = evidenceTextForGroup(group, prepared);
  const draft = {
    name: draftName,
    keywords: keywordsForGroup(group, prepared, draftName, content, paths),
    summary: shorten(conclusionForGroup(group) || reasonForGroup(group) || snippet(group.primary.content ?? ""), 120),
    content,
    evidence,
    refs: draftRefsForGroup(group, prepared),
    paths,
    confidence: "unknown",
  };
  if (prepared.opts.namespaceHint !== undefined) {
    draft.namespace = prepared.opts.namespaceHint;
  }
  return draft;
}

// ---------------------------------------------------------------------------
// 导出：collectMemoryEvidenceRefs
// ---------------------------------------------------------------------------

/**
 * 校验输入并按 refs 逐个定位已加载的 block/leaf/raw/archive 证据。
 * 找不到来源的 ref 不进入 nodes（pack 会将其记入 dropped）。
 * 成功返回 { ok: true, nodes }；坏输入返回 { error: { code, message } }。
 */
export function collectMemoryEvidenceRefs(input) {
  return tryCatch(() => {
    const prepared = prepareInput(input);
    if (prepared.error) return prepared;
    const resolved = collectResolved(prepared);
    const nodes = groupNodes(resolved.nodes).map((group) => ({
      ...group.primary,
      members: group.members,
      groupRefs: group.refs,
    }));
    return { ok: true, nodes };
  });
}

// ---------------------------------------------------------------------------
// 导出：buildMemoryCandidateDraft
// ---------------------------------------------------------------------------

function buildPreparedForSource(source, opts) {
  const options = validateOptions(opts);
  if (options.error) return { error: options.error };
  const session =
    isPlainObject(source) && typeof source.sessionId === "string"
      ? { id: source.sessionId, rootChildren: [] }
      : undefined;
  return {
    ok: true,
    session,
    refs: [],
    hiddenRootIds: [],
    opts: options.opts,
    archiveMap: new Map(),
    rawGet: () => undefined,
  };
}

function asBuildContext(source, opts) {
  // source 可以是 collectMemoryEvidenceRefs 返回的单节点，也可以是 pack 内部
  // 使用的证据组 { primary, members, refs, firstIndex }。
  if (isPlainObject(source) && isPlainObject(source.primary)) {
    const prepared = buildPreparedForSource(source.primary, opts);
    if (prepared.error) return prepared;
    return { ok: true, group: source, prepared };
  }
  if (!isPlainObject(source) || !isPlainObject(source.ref) || !REF_KINDS.has(source.kind)) {
    return errorResult(
      "invalid-source",
      "buildMemoryCandidateDraft requires an EvidenceNode or EvidenceGroup",
    );
  }
  // EvidenceNode 已经携带定位后的对象，不需要重新 resolveWhalePath。
  const members = Array.isArray(source.members) ? source.members : [];
  const group = {
    primary: source,
    members,
    firstIndex: 0,
    refs: [source.ref, ...members.map((member) => member.ref)],
  };
  const prepared = buildPreparedForSource(source, opts);
  if (prepared.error) return prepared;
  return { ok: true, group, prepared };
}

/**
 * 由单个证据节点/证据组生成 MemoryCandidateDraft 初稿。
 * 成功返回 { ok: true, draft }；坏输入返回 { error: { code, message } }。
 */
export function buildMemoryCandidateDraft(source, opts) {
  return tryCatch(() => {
    const context = asBuildContext(source, opts);
    if (context.error) return context;
    const draft = buildGroupDraft(context.group, context.prepared);
    if (!draft) {
      return errorResult("empty-content", "evidence group produced no usable content");
    }
    return { ok: true, draft };
  });
}

// ---------------------------------------------------------------------------
// 导出：packMemoryCandidates
// ---------------------------------------------------------------------------

/**
 * 把 MemoryEvidenceInput 打包成候选数组。
 * 成功返回 { ok, candidates, dropped }；坏输入返回 { error: { code, message } }。
 * 丢弃语义：无来源 -> no-source；证据组无有效正文 -> empty-content；
 * paths 超限截断，被截断的路径记入 dropped（reason: paths-over-limit）。
 * 不做记忆去重。
 */
export function packMemoryCandidates(input) {
  return tryCatch(() => {
    const prepared = prepareInput(input);
    if (prepared.error) return prepared;
    const resolved = collectResolved(prepared);
    const dropped = resolved.missing.map((item) => ({
      ref: item.ref,
      reason: item.reason,
    }));
    const groups = groupNodes(resolved.nodes);
    const candidates = [];

    for (const group of groups) {
      const allPaths = pathCandidatesForGroup(group, prepared);
      let draft = buildGroupDraft(group, prepared);
      if (!draft) {
        dropped.push({ ref: group.refs[0], reason: "empty-content" });
        continue;
      }
      if (allPaths.length > draft.paths.length) {
        const excess = allPaths.slice(draft.paths.length);
        for (const item of excess) {
          dropped.push({
            ref: { path: item.path, purpose: item.purpose },
            reason: "paths-over-limit",
          });
        }
      }
      const validation = validateMemoryCandidateDraft(draft);
      if (!validation.ok) {
        return errorResult(
          "internal-error",
          `draft validation failed: ${validation.errors.join("; ")}`,
        );
      }
      candidates.push(draft);
    }
    return { ok: true, candidates, dropped };
  });
}

// ---------------------------------------------------------------------------
// 导出：validateMemoryCandidateDraft
// ---------------------------------------------------------------------------

function validateDraftFieldErrors(draft) {
  const errors = [];
  if (!isPlainObject(draft)) {
    return ["draft must be a plain object"];
  }
  if (!isNonEmptyString(draft.name)) {
    errors.push("name must be a non-empty string");
  } else if (draft.name.length > 80) {
    errors.push("name must not exceed 80 characters");
  }
  if (!Array.isArray(draft.keywords)) {
    errors.push("keywords must be an array");
  } else {
    if (draft.keywords.length === 0) {
      errors.push("keywords must not be empty");
    }
    draft.keywords.forEach((keyword, index) => {
      if (typeof keyword !== "string" || keyword.trim().length === 0) {
        errors.push(`keywords[${index}] must be a non-empty string`);
      } else if (keyword !== keyword.toLowerCase()) {
        errors.push(`keywords[${index}] must be lowercase`);
      }
    });
  }
  if (!isNonEmptyString(draft.summary)) {
    errors.push("summary must be a non-empty string");
  }
  if (!isNonEmptyString(draft.content)) {
    errors.push("content must be a non-empty string");
  }
  if (!isNonEmptyString(draft.evidence)) {
    errors.push("evidence must be a non-empty string");
  }
  if (!Array.isArray(draft.refs) || draft.refs.length === 0) {
    errors.push("refs must be a non-empty array");
  } else {
    draft.refs.forEach((ref, index) => {
      const validated = validateRef(ref, index);
      if (validated.error) {
        errors.push(validated.error.message);
      } else if (ref.kind === "block" || ref.kind === "leaf") {
        const segments = parsePathText(ref.path);
        if (!segments || segments[segments.length - 1] !== ref.id) {
          errors.push(`refs[${index}].path must end with refs[${index}].id`);
        }
      }
    });
  }
  if (!Array.isArray(draft.paths)) {
    errors.push("paths must be an array");
  } else {
    if (draft.paths.length > MAX_PATH_COUNT) {
      errors.push(`paths must not exceed ${MAX_PATH_COUNT} entries`);
    }
    draft.paths.forEach((item, index) => {
      if (!isPlainObject(item)) {
        errors.push(`paths[${index}] must be an object`);
        return;
      }
      if (!isNonEmptyString(item.path)) {
        errors.push(`paths[${index}].path must be a non-empty string`);
      }
      if (!isNonEmptyString(item.purpose)) {
        errors.push(`paths[${index}].purpose must be a non-empty string`);
      }
    });
  }
  if (draft.type !== undefined && !TYPE_VALUES.has(draft.type)) {
    errors.push(`type must be one of: ${[...TYPE_VALUES].join(", ")}`);
  }
  if (!CONFIDENCE_VALUES.has(draft.confidence)) {
    errors.push(`confidence must be one of: ${[...CONFIDENCE_VALUES].join(", ")}`);
  }
  if (draft.namespace !== undefined && !NAMESPACE_VALUES.has(draft.namespace)) {
    errors.push("namespace must be \"global\" or \"project\"");
  }
  return errors;
}

/**
 * 校验一个 MemoryCandidateDraft。
 * 返回 { ok: true, errors: [] } 或 { ok: false, errors: string[] }。
 */
export function validateMemoryCandidateDraft(draft) {
  const errors = validateDraftFieldErrors(draft);
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}
