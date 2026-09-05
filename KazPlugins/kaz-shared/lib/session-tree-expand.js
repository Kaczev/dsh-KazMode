// kaz-shared —— Kaz7.0 M3 子步骤 A：whale_expand 纯读取模块（纯 ESM、零 I/O）
// ===========================================================================
// 依据：不入库文件/Kaz7.0更新规划/Kaz7.0-M3 whale_expand 设计报告.md
// 边界：
//   * 本模块只做只读 path 解析 / resolve / collect / paginate / expand；
//   * 不 import node:fs / node:crypto / node:path；不读写文件；
//   * 始终吃完整 Session，因此 hiddenRootIds 不影响展开；
//   * archive 不做隐式 fallback；archive 只经独立只读通道访问；
//   * 不注册 Stable Main / cordis / 工具面；session-tree.js 与 tool-lists.js
//     公共根本阶段不导出本模块；package.json 只增加纯模块子路径。
//   * 坏输入返回 { error: { code, message } }，不抛异常。
// 不设项：无 token 触发 / 保留预算字段写入 Session / store / archive；
//         返回体积保护默认 1000 单位不是常驻预算。
// ===========================================================================

import { validateSessionForStore } from "./session-tree-store-core.js";

/** 返回体积/分页保护默认值（单位 ≈ token；不是常驻预算）。 */
export const DEFAULT_WHALE_EXPAND_LIMIT = 1000;

const CURSOR_PREFIX = "k7e";
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function encodeCursor(offset) {
  return `${CURSOR_PREFIX}:${offset}`;
}

/**
 * 解析不透明续读令牌。为兼容最小化实现，同时接受本模块生成的
 * `k7e:<offset>` 与纯数字字符串；非法值返回 NaN。
 */
function decodeCursor(cursor) {
  if (typeof cursor !== "string" || cursor.length === 0) return NaN;
  const match = /^(?:k7e:)?(\d+)$/.exec(cursor);
  return match ? Number(match[1]) : NaN;
}

function joinPath(segments) {
  return segments.join("/");
}

function itemText(item) {
  if (typeof item === "string") return item;
  try {
    return JSON.stringify(item);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// parseWhalePath —— 只做语法解析，不接触 Session / 文件系统
// ---------------------------------------------------------------------------

/**
 * path := "" | segment ("/" segment)*
 * segment := 非空字符串，不含 "/"、"\"、控制字符，且不是 "." 或 ".."。
 */
export function parseWhalePath(path) {
  return tryCatch(() => {
    if (typeof path !== "string") {
      return errorResult("invalid-path", "path must be a string");
    }
    if (path === "") {
      return { ok: true, segments: [], isRoot: true };
    }
    const segments = path.split("/");
    for (const segment of segments) {
      if (segment.length === 0) {
        return errorResult("invalid-path", "path must not contain empty segments");
      }
      if (segment === "." || segment === "..") {
        return errorResult("invalid-path", "path must not contain . or .. segments");
      }
      if (segment.includes("\\")) {
        return errorResult("invalid-path", "path must not contain backslashes");
      }
      if (CONTROL_CHAR_PATTERN.test(segment)) {
        return errorResult("invalid-path", "path must not contain control characters");
      }
    }
    return { ok: true, segments, isRoot: false };
  });
}

// ---------------------------------------------------------------------------
// resolveWhalePath —— 按当前树 id 祖先链解析
// ---------------------------------------------------------------------------

function validateSession(session) {
  const result = validateSessionForStore(session);
  if (!result.ok) {
    return errorResult("invalid-session", result.errors.join("; "));
  }
  return { ok: true };
}

/**
 * 从 session.rootChildren 开始逐层按 node.id 精确匹配。
 * 只接受完整 Session；不允许传入 renderWindowSession 过滤后的视图。
 */
export function resolveWhalePath(session, path) {
  return tryCatch(() => {
    const parsed = parseWhalePath(path);
    if (parsed.error) return parsed;

    const sessionCheck = validateSession(session);
    if (sessionCheck.error) return sessionCheck;

    const segments = parsed.segments;
    if (segments.length === 0) {
      return { ok: true, node: null, kind: "root", segments };
    }

    let current = null;
    let children = session.rootChildren;
    for (let i = 0; i < segments.length; i += 1) {
      if (current?.nodeType === "leaf") {
        return errorResult(
          "path-too-deep",
          `path reaches leaf "${current.id}" with remaining segments`,
        );
      }
      const node = children.find((child) => child && child.id === segments[i]);
      if (!node) {
        return errorResult(
          "path-not-found",
          `segment "${segments[i]}" not found under ${i === 0 ? "root" : `"${segments[i - 1]}"`}`,
        );
      }
      current = node;
      children = Array.isArray(current.children) ? current.children : [];
    }

    return {
      ok: true,
      node: current,
      kind: current.nodeType,
      segments,
    };
  });
}

// ---------------------------------------------------------------------------
// collectExpandItems —— 收集 block/scope 直接 children；leaf 返回完整原信息
// ---------------------------------------------------------------------------

function toExpandItem(node, parentSegments) {
  const sourceId = node.id;
  const sourcePath = joinPath([...parentSegments, sourceId]);
  if (node.nodeType === "block") {
    return {
      kind: "block",
      sourceId,
      sourcePath,
      level: node.level,
      boundary: node.boundary,
      summary: node.summary,
    };
  }
  if (node.nodeType === "scope") {
    return {
      kind: "scope",
      sourceId,
      sourcePath,
      level: node.level,
      boundary: node.boundary,
      childCount: Array.isArray(node.children) ? node.children.length : 0,
    };
  }
  // leaf：完整原信息收在 message（与 M1 render 的 raw entry 同一批字段）。
  return {
    kind: "leaf",
    sourceId,
    sourcePath,
    seq: node.seq,
    message: node,
  };
}

function collectForResolved(session, resolved) {
  if (resolved.kind === "root") {
    return {
      target: { kind: "root", path: "" },
      items: session.rootChildren.map((node) => toExpandItem(node, [])),
    };
  }
  const node = resolved.node;
  const segments = resolved.segments;
  const path = joinPath(segments);
  if (resolved.kind === "leaf") {
    return {
      target: { kind: "leaf", id: node.id, path },
      items: [toExpandItem(node, segments.slice(0, -1))],
    };
  }
  return {
    target: {
      kind: node.nodeType,
      id: node.id,
      path,
      level: node.level,
      boundary: node.boundary,
    },
    items: node.children.map((child) => toExpandItem(child, segments)),
  };
}

/**
 * 源顺序（老 → 新）收集目标节点的直接 children；leaf 展开为单条完整原信息。
 * 返回 { ok, target, items, itemCount }。
 */
export function collectExpandItems(session, path) {
  return tryCatch(() => {
    const resolved = resolveWhalePath(session, path);
    if (resolved.error) return resolved;
    const collected = collectForResolved(session, resolved);
    return {
      ok: true,
      target: collected.target,
      items: collected.items,
      itemCount: collected.items.length,
    };
  });
}

// ---------------------------------------------------------------------------
// estimateExpandReturnTokens —— 4 字符 ≈ 1 token 启发式
// ---------------------------------------------------------------------------

/** 文本 token 估算：Math.ceil(text.length / 4)；非字符串视为 0。 */
export function estimateExpandReturnTokens(text) {
  if (typeof text !== "string") return 0;
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// paginateExpandItems —— 同层分页 / 返回体积保护
// ---------------------------------------------------------------------------

function normalizePaginationOptions(opts) {
  if (opts === undefined || opts === null) return { options: {} };
  if (!isPlainObject(opts)) {
    return { error: errorResult("invalid-options", "pagination options must be an object") };
  }
  return { options: opts };
}

/**
 * 从 cursor/offset 开始逐项把序列化文本加入估算体积；单条超限不截断并标记
 * singleOversized。limit 必须是正整数，缺省 DEFAULT_WHALE_EXPAND_LIMIT。
 */
export function paginateExpandItems(items, opts) {
  return tryCatch(() => {
    const normalized = normalizePaginationOptions(opts);
    if (normalized.error) return normalized.error;
    const options = normalized.options;

    if (!Array.isArray(items)) {
      return errorResult("invalid-items", "items must be an array");
    }

    const limit =
      options.limit === undefined
        ? DEFAULT_WHALE_EXPAND_LIMIT
        : options.limit;
    if (!Number.isInteger(limit) || limit <= 0) {
      return errorResult("invalid-limit", "limit must be a positive integer");
    }

    const total = items.length;
    let offset = 0;
    if (options.cursor !== undefined && options.cursor !== null) {
      offset = decodeCursor(options.cursor);
      if (!Number.isInteger(offset) || offset < 0 || offset > total) {
        return errorResult(
          "invalid-cursor",
          "cursor does not identify a valid continuation offset",
        );
      }
    }

    const page = [];
    let budgetUsed = 0;
    let includedEnd = offset;
    let singleOversized = false;

    for (let i = offset; i < total; i += 1) {
      const text = itemText(items[i]);
      if (text === null) {
        return errorResult("invalid-items", "item must be JSON-serializable");
      }
      const cost = estimateExpandReturnTokens(text);
      if (i === offset && cost > limit) {
        // 精确召回优先：单条超长整条返回，不截断内容。
        page.push(items[i]);
        budgetUsed += cost;
        singleOversized = true;
        includedEnd = i + 1;
        break;
      }
      if (budgetUsed + cost > limit) {
        break;
      }
      page.push(items[i]);
      budgetUsed += cost;
      includedEnd = i + 1;
    }

    const hasMore = includedEnd < total;
    return {
      ok: true,
      page,
      total,
      offset,
      hasMore,
      ...(hasMore ? { nextCursor: encodeCursor(includedEnd) } : {}),
      budgetUsed,
      singleOversized,
    };
  });
}

// ---------------------------------------------------------------------------
// expand —— 组合 resolve + collect + paginate 的只读结果
// ---------------------------------------------------------------------------

/**
 * 纯只读展开：不修改 Session、不写回树、不读 archive。
 * 成功返回 target + page/total/offset/hasMore/nextCursor/budgetUsed/singleOversized。
 */
export function expand(session, path, opts) {
  return tryCatch(() => {
    const collected = collectExpandItems(session, path);
    if (collected.error) return collected;
    const paginated = paginateExpandItems(collected.items, opts);
    if (paginated.error) return paginated;
    return {
      ok: true,
      target: collected.target,
      page: paginated.page,
      total: paginated.total,
      offset: paginated.offset,
      hasMore: paginated.hasMore,
      ...(paginated.nextCursor !== undefined ? { nextCursor: paginated.nextCursor } : {}),
      budgetUsed: paginated.budgetUsed,
      singleOversized: paginated.singleOversized,
    };
  });
}
