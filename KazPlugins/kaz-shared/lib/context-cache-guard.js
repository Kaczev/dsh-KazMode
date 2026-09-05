// kaz-shared —— Kaz7.0 M4 子步骤 A：缓存与稳定前缀纯测量/守卫模块（纯 ESM，零 I/O）
// ===========================================================================
// 依据：不入库文件/Kaz7.0更新规划/Kaz7.0-M4缓存与稳定前缀设计报告.md
// 职责（只做测量/守卫，绝不读写文件、不注册 cordis、不注入请求）：
//   * classifyTransition / prefixStableAfter / invalidationCount；
//   * systemToolsHashStable / surfaceHashStable；
//   * renderStableAcrossAppend / windowStableAfterHidden；
//   * evaluateCacheSample / stablePeriodMedianH / m4Verdict；
//   * 复用 context-compress.js 的 classifyCacheScenario / cacheMeasurementMode /
//     hFull / hReadProxy / renderOrderValid，以及 M1–M3 纯模块的只读能力。
// 边界：
//   * 不 import node:fs / node:crypto / node:path；
//   * hash 为内置确定性 FNV-1a（也可由 opts.hash 注入），不依赖 node:crypto；
//   * 坏输入返回 { error: { code, message } }，不抛异常；
//   * 校验失败（hash 变化 / 前缀不匹配 / 断言不成立）用 ok:false + code 表达；
//   * 无 token 触发 / 保留预算 / MC 字段；无 DSH 核心改动。
// ===========================================================================

import {
  normalizeCacheScenario,
  classifyCacheScenario,
  cacheMeasurementMode,
  hFull,
  hReadProxy,
  renderOrderValid,
} from "./context-compress.js";
import { render } from "./session-tree.js";
import {
  renderWindowSession,
  validateSessionForStore,
} from "./session-tree-store-core.js";
import { expand } from "./session-tree-expand.js";

// ---------------------------------------------------------------------------
// 小工具 / 错误约定
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

function isSessionShape(value) {
  return (
    isPlainObject(value) &&
    typeof value.schemaVersion === "string" &&
    Array.isArray(value.rootChildren)
  );
}

function isJsonValue(value, seen = new Set()) {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string" || type === "boolean") return true;
  if (type === "number") return Number.isFinite(value);
  if (type === "undefined" || type === "function" || type === "symbol" || type === "bigint") {
    return false;
  }
  if (type !== "object" || seen.has(value)) return false;
  seen.add(value);
  let ok = true;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isJsonValue(item, seen)) {
        ok = false;
        break;
      }
    }
  } else if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (!isJsonValue(value[key], seen)) {
        ok = false;
        break;
      }
    }
  } else {
    ok = false;
  }
  seen.delete(value);
  return ok;
}

function stableSortDeep(value, seen = new Set()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("circular reference");
    seen.add(value);
    const out = value.map((item) => stableSortDeep(item, seen));
    seen.delete(value);
    return out;
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) throw new Error("circular reference");
    seen.add(value);
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = stableSortDeep(value[key], seen);
    }
    seen.delete(value);
    return out;
  }
  return value;
}

/**
 * 稳定序列化纯工具：数组顺序保留、对象键排序。
 * 有效 JSON 输入返回规范文本；不可序列化/循环输入按坏输入返回 { error }。
 */
export function stableCanonicalText(value) {
  return tryCatch(() => {
    if (!isJsonValue(value)) {
      return errorResult(
        "invalid-value",
        "stableCanonicalText requires a JSON-serializable value without cycles",
      );
    }
    return JSON.stringify(stableSortDeep(value));
  });
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    hash ^= code & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= (code >>> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function applyHash(text, opts) {
  if (typeof opts?.hash === "function") {
    const result = opts.hash(text);
    if (typeof result !== "string" || result.length === 0) {
      return errorResult(
        "invalid-hash",
        "opts.hash must return a non-empty string",
      );
    }
    return { ok: true, hash: result };
  }
  return { ok: true, hash: fnv1a(text) };
}

function normalizeOptionsObject(opts, label = "options") {
  if (opts === undefined || opts === null) return { ok: true, options: {} };
  if (!isPlainObject(opts)) {
    return {
      error: errorResult("invalid-options", `${label} must be an object`),
    };
  }
  return { ok: true, options: opts };
}

function canonicalEntryText(entry) {
  const canonical = stableCanonicalText(entry);
  if (canonical?.error) return canonical;
  return { ok: true, text: canonical };
}

// ---------------------------------------------------------------------------
// prefixStableAfter —— append-only 稳定前缀断言
// ---------------------------------------------------------------------------

/**
 * prevEntries 是 nextEntries 的逐项 JSON 前缀即稳定（相等也算稳定）。
 * 返回 { ok, prefixStable, commonPrefixCount, nextTotal }；坏输入返回 { error }。
 */
export function prefixStableAfter(prevEntries, nextEntries) {
  return tryCatch(() => {
    if (!Array.isArray(prevEntries) || !Array.isArray(nextEntries)) {
      return errorResult(
        "invalid-entries",
        "prefixStableAfter requires prevEntries and nextEntries arrays",
      );
    }
    const prevText = [];
    const nextText = [];
    for (let i = 0; i < prevEntries.length; i += 1) {
      const text = canonicalEntryText(prevEntries[i]);
      if (text.error) {
        return errorResult(
          "invalid-prev-entry",
          `prevEntries[${i}] is not JSON-serializable`,
        );
      }
      prevText.push(text.text);
    }
    for (let i = 0; i < nextEntries.length; i += 1) {
      const text = canonicalEntryText(nextEntries[i]);
      if (text.error) {
        return errorResult(
          "invalid-next-entry",
          `nextEntries[${i}] is not JSON-serializable`,
        );
      }
      nextText.push(text.text);
    }
    let common = 0;
    const max = Math.min(prevText.length, nextText.length);
    while (common < max && prevText[common] === nextText[common]) common += 1;
    const prefixStable = common === prevText.length;
    return {
      ok: true,
      prefixStable,
      commonPrefixCount: common,
      nextTotal: nextText.length,
    };
  });
}

// ---------------------------------------------------------------------------
// entries 解析 / changes 失效语义
// ---------------------------------------------------------------------------

function resolveEntries(value, label) {
  if (isPlainObject(value) && Array.isArray(value.entries)) {
    return { ok: true, entries: value.entries };
  }
  if (isPlainObject(value) && isPlainObject(value.session) && Array.isArray(value.session.rootChildren)) {
    if (Array.isArray(value.entries)) return { ok: true, entries: value.entries };
    return errorResult(
      "invalid-entries",
      `${label} must expose an entries array`,
    );
  }
  if (isSessionShape(value)) {
    const rendered = render(value);
    if (rendered?.error) return rendered;
    return { ok: true, entries: rendered.entries };
  }
  return errorResult(
    "invalid-session-or-entries",
    `${label} must be a valid session, a render result with entries, or an object exposing entries`,
  );
}

function isSystemToolsSnapshot(value) {
  return (
    isPlainObject(value) &&
    (typeof value.systemText === "string" || Array.isArray(value.tools))
  );
}

function plannedInvalidationFromChanges(changes) {
  if (!Array.isArray(changes)) return { has: false };
  let sawClose = false;
  let sawPromote = false;
  let sawFallbackHide = false;
  for (const change of changes) {
    if (!isPlainObject(change)) continue;
    const type = typeof change.type === "string"
      ? change.type
      : typeof change.kind === "string"
        ? change.kind
        : "";
    if (type === "close") sawClose = true;
    else if (type === "promote") sawPromote = true;
    else if (type === "sublime" && !sawClose) sawPromote = true;
    else if (type === "fallback-hide") sawFallbackHide = true;
  }
  if (sawFallbackHide) {
    return { has: true, kind: "fallback-hide", subtype: "hidden-window" };
  }
  if (sawClose) return { has: true, kind: "close" };
  if (sawPromote) return { has: true, kind: "promote" };
  return { has: false };
}

// ---------------------------------------------------------------------------
// systemToolsHashStable / surfaceHashStable
// ---------------------------------------------------------------------------

function systemToolsSnapshotResult(value, label) {
  if (!isPlainObject(value)) {
    return { error: errorResult("invalid-snapshot", `${label} must be an object`) };
  }
  const hasSystem = typeof value.systemText === "string";
  if (value.systemText !== undefined && !hasSystem) {
    return {
      error: errorResult("invalid-system-text", `${label}.systemText must be a string`),
    };
  }
  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools)) {
      return {
        error: errorResult("invalid-tools", `${label}.tools must be an array`),
      };
    }
    for (let i = 0; i < value.tools.length; i += 1) {
      if (!isPlainObject(value.tools[i])) {
        return {
          error: errorResult(
            "invalid-tools",
            `${label}.tools[${i}] must be an object`,
          ),
        };
      }
    }
  }
  if (!isJsonValue(value)) {
    return {
      error: errorResult(
        "invalid-snapshot",
        `${label} must be JSON-serializable`,
      ),
    };
  }
  return { ok: true, snapshot: value };
}

function hashCompare(before, after, label, code, opts) {
  const beforeCanonical = stableCanonicalText(before);
  if (beforeCanonical?.error) {
    return errorResult("invalid-before", `${label} before is not canonicalizable`);
  }
  const afterCanonical = stableCanonicalText(after);
  if (afterCanonical?.error) {
    return errorResult("invalid-after", `${label} after is not canonicalizable`);
  }
  const beforeHashResult = applyHash(beforeCanonical, opts);
  if (beforeHashResult.error) return beforeHashResult.error;
  const afterHashResult = applyHash(afterCanonical, opts);
  if (afterHashResult.error) return afterHashResult.error;
  const stable = beforeHashResult.hash === afterHashResult.hash;
  if (stable) {
    return { ok: true, stable: true, hash: beforeHashResult.hash };
  }
  return {
    ok: false,
    stable: false,
    code,
    beforeHash: beforeHashResult.hash,
    afterHash: afterHashResult.hash,
  };
}

/**
 * S1/S2/C3：system/tools 逐 token/逐 schema 稳定。
 * before/after: { systemText, tools }（tools 顺序敏感）。
 * 返回 { ok:true, stable:true, hash } 或 { ok:false, code:"system-or-tools-hash-changed", ... }；
 * 坏输入返回 { error }。
 */
export function systemToolsHashStable(before, after, opts = {}) {
  return tryCatch(() => {
    const options = normalizeOptionsObject(opts);
    if (options.error) return options.error;
    const beforeCheck = systemToolsSnapshotResult(before, "before");
    const afterCheck = systemToolsSnapshotResult(after, "after");
    if (beforeCheck.error) return beforeCheck.error;
    if (afterCheck.error) return afterCheck.error;
    return hashCompare(
      before,
      after,
      "system/tools",
      "system-or-tools-hash-changed",
      options.options,
    );
  });
}

/**
 * S3/C8：Persona / Stable Main / Sub Surface / 软闸门快照不被压缩改写。
 * 返回 { ok:true, stable:true, hash } 或 { ok:false, code:"surface-hash-changed", ... }。
 */
export function surfaceHashStable(before, after, opts = {}) {
  return tryCatch(() => {
    const options = normalizeOptionsObject(opts);
    if (options.error) return options.error;
    if (!isJsonValue(before) || !isJsonValue(after)) {
      return errorResult(
        "invalid-surface-snapshot",
        "surface snapshots must be JSON-serializable",
      );
    }
    return hashCompare(
      before,
      after,
      "surface",
      "surface-hash-changed",
      options.options,
    );
  });
}

// ---------------------------------------------------------------------------
// classifyTransition —— 相邻请求过渡分类
// ---------------------------------------------------------------------------

function classifyResult(type, extra) {
  return { ok: true, type, classification: type, ...extra };
}

function classifySystemSnapshot(value, explicit) {
  if (explicit !== undefined && explicit !== null) return explicit;
  if (isSystemToolsSnapshot(value)) return value;
  if (isPlainObject(value) && isSystemToolsSnapshot(value.systemTools)) {
    return value.systemTools;
  }
  return null;
}

/**
 * classifyTransition(prev, next, opts)
 * prev/next 可为 Session、render 结果（含 entries）或 { entries } 快照。
 * opts:
 *   changes?: Change[]               —— reducer changes 或 store audit 行
 *   versionBoundary?: boolean
 *   hiddenRootIdsChanged?: boolean
 *   systemToolsBefore?/systemToolsAfter? —— 也可直接嵌在 prev/next 上
 * 返回 { ok, type, subtype?, prefixStable?, ... }；坏输入返回 { error }。
 */
export function classifyTransition(prev, next, opts = {}) {
  return tryCatch(() => {
    const options = normalizeOptionsObject(opts, "opts");
    if (options.error) return options.error;
    const { options: settings } = options;

    const prevResolved = resolveEntries(prev, "prev");
    if (prevResolved.error) return prevResolved.error;
    const nextResolved = resolveEntries(next, "next");
    if (nextResolved.error) return nextResolved.error;

    if (
      settings.changes !== undefined &&
      !Array.isArray(settings.changes)
    ) {
      return errorResult("invalid-changes", "opts.changes must be an array");
    }

    const versionBoundary = settings.versionBoundary === true;
    const hiddenRootIdsChanged = settings.hiddenRootIdsChanged === true;

    const sysBefore = classifySystemSnapshot(prev, settings.systemToolsBefore);
    const sysAfter = classifySystemSnapshot(next, settings.systemToolsAfter);
    let systemToolsStable = true;
    let systemToolsChecked = false;
    if (sysBefore !== null && sysAfter !== null) {
      const sysResult = systemToolsHashStable(sysBefore, sysAfter, settings);
      if (sysResult?.error) return sysResult.error;
      systemToolsStable = sysResult.stable;
      systemToolsChecked = true;
    }

    if (versionBoundary) {
      return classifyResult("version-boundary", {
        systemToolsChecked,
        systemToolsStable,
      });
    }
    if (systemToolsChecked && !systemToolsStable) {
      return classifyResult("prefix-violation", {
        reason: "system-or-tools-hash-changed",
        systemToolsChecked,
        systemToolsStable,
      });
    }

    const invalidation = plannedInvalidationFromChanges(settings.changes ?? []);
    if (invalidation.has || hiddenRootIdsChanged) {
      const extra = {
        systemToolsChecked,
        systemToolsStable,
        plannedKind: invalidation.has ? invalidation.kind : "fallback-hide",
        subtype: hiddenRootIdsChanged || invalidation.subtype
          ? invalidation.subtype || "hidden-window"
          : undefined,
      };
      return classifyResult("planned-invalidation", extra);
    }

    const prefix = prefixStableAfter(
      prevResolved.entries,
      nextResolved.entries,
    );
    if (prefix.error) return prefix.error;
    if (prefix.prefixStable) {
      return classifyResult("append-only", {
        systemToolsChecked,
        systemToolsStable,
        prefixStable: true,
        commonPrefixCount: prefix.commonPrefixCount,
        nextTotal: prefix.nextTotal,
      });
    }
    return classifyResult("prefix-violation", {
      systemToolsChecked,
      systemToolsStable,
      prefixStable: false,
      commonPrefixCount: prefix.commonPrefixCount,
      nextTotal: prefix.nextTotal,
      reason: "entries-prefix-broken",
    });
  });
}

// ---------------------------------------------------------------------------
// invalidationCount —— 计划内失效边界计数 / 对账
// ---------------------------------------------------------------------------

function countOneGroup(item) {
  if (!isPlainObject(item)) return null;
  const kind =
    typeof item.kind === "string"
      ? item.kind
      : typeof item.type === "string"
        ? item.type
        : "";
  const normalized = kind.trim().toLowerCase();
  if (normalized === "close") return "close";
  if (normalized === "promote" || normalized === "sublime") return "promote";
  if (normalized === "fallback-hide" || normalized === "fallbackhide") {
    return "fallback-hide";
  }
  // 支持 { kind?, changes: [...] } 的失效组对象。
  if (Array.isArray(item.changes) && item.changes.length > 0) {
    const planned = plannedInvalidationFromChanges(item.changes);
    if (planned.has) return planned.kind;
  }
  return null;
}

/**
 * invalidationCount(groups)
 * groups 可为“失效组”对象数组，也可兼容扁平 changes（close+sublime 同组不重复计）。
 * 返回 { ok, count, kinds: { close, promote, fallbackHide }, unclassified }。
 */
export function invalidationCount(groups) {
  return tryCatch(() => {
    if (!Array.isArray(groups)) {
      return errorResult("invalid-groups", "groups must be an array");
    }
    const counts = { close: 0, promote: 0, fallbackHide: 0 };
    const unclassified = [];
    for (let i = 0; i < groups.length; i += 1) {
      const item = groups[i];
      if (!isPlainObject(item)) {
        unclassified.push({ index: i, reason: "not-an-object" });
        continue;
      }
      // 扁平 change 列表里 close 之后的自动 sublime 应合并到该 close，不重复计。
      if (item.type === "sublime") {
        const earlierClose = groups
          .slice(0, i)
          .some((earlier) => isPlainObject(earlier) && earlier.type === "close");
        if (earlierClose) continue;
      }
      const kind = countOneGroup(item);
      if (kind === null) {
        unclassified.push({ index: i, item, reason: "unknown-group-kind" });
        continue;
      }
      if (kind === "close") counts.close += 1;
      else if (kind === "promote") counts.promote += 1;
      else if (kind === "fallback-hide") counts.fallbackHide += 1;
    }
    const count = counts.close + counts.promote + counts.fallbackHide;
    return { ok: true, count, kinds: counts, unclassified };
  });
}

// ---------------------------------------------------------------------------
// renderStableAcrossAppend —— S8/S9 渲染稳定断言
// ---------------------------------------------------------------------------

function callRenderFn(session, renderFn, label) {
  if (typeof renderFn === "function") {
    const output = renderFn(session);
    if (output?.error) return output;
    if (Array.isArray(output)) {
      return {
        ok: true,
        entries: output,
        orderValid: renderOrderValid(output),
      };
    }
    if (isPlainObject(output) && Array.isArray(output.entries)) {
      return {
        ok: true,
        entries: output.entries,
        orderValid:
          typeof output.orderValid === "boolean"
            ? output.orderValid
            : renderOrderValid(output.entries),
      };
    }
    return errorResult(
      "invalid-render-fn",
      `${label}: renderFn must return entries array or render result with entries`,
    );
  }
  const rendered = render(session);
  if (rendered?.error) return rendered;
  return {
    ok: true,
    entries: rendered.entries,
    orderValid: rendered.orderValid,
  };
}

/**
 * renderStableAcrossAppend(sessionA, sessionB, opts)
 * opts.renderFn? 缺省复用 session-tree.render；
 * opts.changes? 传给 classifyTransition（区分 append-only 与 planned-invalidation）。
 */
export function renderStableAcrossAppend(sessionA, sessionB, opts = {}) {
  return tryCatch(() => {
    const options = normalizeOptionsObject(opts, "opts");
    if (options.error) return options.error;
    const { options: settings } = options;
    const before = callRenderFn(sessionA, settings.renderFn, "sessionA");
    if (before.error) return before.error;
    const after = callRenderFn(sessionB, settings.renderFn, "sessionB");
    if (after.error) return after.error;

    const transition = classifyTransition(
      { entries: before.entries },
      { entries: after.entries },
      { ...settings, changes: settings.changes ?? [] },
    );
    if (transition.error) return transition.error;

    const prefix = prefixStableAfter(before.entries, after.entries);
    if (prefix.error) return prefix.error;

    return {
      ok: true,
      prefixStable: prefix.prefixStable,
      commonPrefixCount: prefix.commonPrefixCount,
      nextTotal: prefix.nextTotal,
      entriesBefore: before.entries,
      entriesAfter: after.entries,
      orderValidBefore: before.orderValid,
      orderValidAfter: after.orderValid,
      transition: transition.type,
      transitionSubtype: transition.subtype,
    };
  });
}

// ---------------------------------------------------------------------------
// windowStableAfterHidden —— C1/v1.2 hiddenRootIds 渲染窗口断言
// ---------------------------------------------------------------------------

function isDirectRootClosedBlock(session, id) {
  return session.rootChildren.some(
    (node) =>
      node &&
      typeof node.id === "string" &&
      node.id === id &&
      node.nodeType === "block" &&
      node.state === "closed",
  );
}

function entriesEqualByCanonical(left, right) {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = stableCanonicalText(left[i]);
    const b = stableCanonicalText(right[i]);
    if (a?.error || b?.error || a !== b) return false;
  }
  return true;
}

/**
 * windowStableAfterHidden(session, hiddenRootIds, opts)
 * 校验：隐藏根合法、完整 Session 不变、窗口渲染确定且顺序合法、
 * 隐藏根只从窗口消失、expand 可读回完整 Session 的隐藏根。
 * expectedVisible 使用 path-prefix 过滤（e.path===id || startsWith(id+"/")）
 * 并保留 entry.id 兼容，以覆盖 newest-path 剖面下隐藏根内部块条目。
 * opts.expandFn? 缺省用 session-tree-expand.expand。
 */
export function windowStableAfterHidden(session, hiddenRootIds, opts = {}) {
  return tryCatch(() => {
    const options = normalizeOptionsObject(opts, "opts");
    if (options.error) return options.error;
    const { options: settings } = options;

    const validation = validateSessionForStore(session);
    if (!validation.ok) {
      return errorResult(
        "invalid-session",
        validation.errors.join("; "),
      );
    }
    if (
      !Array.isArray(hiddenRootIds) ||
      hiddenRootIds.some((id) => !isNonEmptyString(id)) ||
      new Set(hiddenRootIds).size !== hiddenRootIds.length
    ) {
      return errorResult(
        "invalid-hidden-root-ids",
        "hiddenRootIds must be an array of unique non-empty strings",
      );
    }
    for (const id of hiddenRootIds) {
      if (!isDirectRootClosedBlock(session, id)) {
        return errorResult(
          "invalid-hidden-root-id",
          `hiddenRootIds entry is not a direct root closed block: ${id}`,
        );
      }
    }

    const sessionBeforeText = stableCanonicalText(session);
    if (sessionBeforeText?.error) {
      return errorResult("invalid-session", "session is not canonicalizable");
    }
    const windowResult = renderWindowSession(session, hiddenRootIds);
    if (windowResult?.error) return windowResult.error;
    const sessionAfterText = stableCanonicalText(session);
    if (sessionAfterText?.error) {
      return errorResult("invalid-session", "session changed into non-canonical state");
    }
    const sessionUnchanged = sessionBeforeText === sessionAfterText;

    const fullRender = render(session);
    if (fullRender?.error) return fullRender.error;
    const windowRender = render(windowResult.session);
    if (windowRender?.error) return windowRender.error;
    const secondWindowRender = render(windowResult.session);
    if (secondWindowRender?.error) return secondWindowRender.error;

    const orderValidBefore = fullRender.orderValid === true;
    const orderValidAfter = windowRender.orderValid === true;
    const renderStable = entriesEqualByCanonical(
      windowRender.entries,
      secondWindowRender.entries,
    );

    const expectedVisible = fullRender.entries.filter(
      (entry) =>
        !hiddenRootIds.some(
          (id) =>
            entry?.id === id ||
            (typeof entry?.path === "string" &&
              (entry.path === id || entry.path.startsWith(`${id}/`))),
        ),
    );
    const hiddenRemovedAndOrderPreserved = entriesEqualByCanonical(
      expectedVisible,
      windowRender.entries,
    );

    const expandFn =
      typeof settings.expandFn === "function" ? settings.expandFn : expand;
    const expandChecks = {};
    let allExpandReadable = true;
    for (const id of hiddenRootIds) {
      const expanded = expandFn(session, id, settings.expandOpts);
      const ok =
        isPlainObject(expanded)
          ? expanded.ok === true && !expanded.error
          : false;
      if (!ok) {
        allExpandReadable = false;
        expandChecks[id] = false;
      } else {
        expandChecks[id] = true;
      }
    }

    const plannedInvalidation = hiddenRootIds.length > 0;
    const checks = {
      sessionUnchanged,
      hiddenIdsValid: true,
      windowRenderDeterministic: renderStable,
      orderValidBefore,
      orderValidAfter,
      hiddenRemovedAndOrderPreserved,
      expandReadable: allExpandReadable,
      plannedInvalidation,
    };
    const allPass = Object.values(checks).every(Boolean);
    if (!allPass) {
      return { ok: false, code: "hidden-window-assertion-failed", checks };
    }
    return {
      ok: true,
      stable: true,
      checks,
      classification: plannedInvalidation
        ? "planned-invalidation"
        : "append-only",
      ...(plannedInvalidation ? { subtype: "hidden-window" } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// evaluateCacheSample —— A/B/C/D 与 H_full/H_read_proxy 组合
// ---------------------------------------------------------------------------

function sampleUsage(sample) {
  if (isPlainObject(sample?.usage)) return sample.usage;
  return sample;
}

function evaluateSampleCore(sample) {
  const usage = sampleUsage(sample);
  const explicitScenario = normalizeCacheScenario(sample.scenario);
  const scenario = explicitScenario || classifyCacheScenario(usage);

  if (scenario === "") {
    return {
      ok: true,
      scenario: "",
      measurement: "cache_unmeasurable",
      reason: "scenario-invalid",
      h: null,
    };
  }
  const measurement = cacheMeasurementMode(scenario);
  if (measurement === "cache_unmeasurable") {
    return {
      ok: true,
      scenario,
      measurement,
      reason: "scenario-unmeasurable",
      h: null,
    };
  }
  if (scenario === "A") {
    return {
      ok: true,
      scenario,
      measurement,
      h: hFull(usage),
      hFull: hFull(usage),
    };
  }
  if (scenario === "B") {
    return {
      ok: true,
      scenario,
      measurement,
      h: hReadProxy(usage),
      hReadProxy: hReadProxy(usage),
    };
  }
  return {
    ok: true,
    scenario: "",
    measurement: "cache_unmeasurable",
    reason: "scenario-invalid",
    h: null,
  };
}

/**
 * evaluateCacheSample(sample)
 * sample = { usage: { uncached, cacheRead, cacheWrite }, scenario?: "A"|"B"|"C"|"D" }
 * A → hFull；B → hReadProxy；C/D 与无效场景 → cache_unmeasurable。
 */
export function evaluateCacheSample(sample) {
  return tryCatch(() => {
    if (!isPlainObject(sample)) {
      return errorResult("invalid-sample", "sample must be an object");
    }
    if (
      sample.usage !== undefined &&
      !isPlainObject(sample.usage)
    ) {
      return errorResult("invalid-usage", "sample.usage must be an object");
    }
    const evaluated = evaluateSampleCore(sample);
    return {
      ...evaluated,
      usage: sampleUsage(sample),
    };
  });
}

// ---------------------------------------------------------------------------
// stablePeriodMedianH —— 计划内失效/版本边界后 ≥3 append-only 的中位命中
// ---------------------------------------------------------------------------

function medianOf(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function rowTransition(row) {
  if (typeof row.transition === "string") return row.transition;
  if (isPlainObject(row.transition) && typeof row.transition.type === "string") {
    return row.transition.type;
  }
  if (typeof row.type === "string") return row.type;
  if (isPlainObject(row.classification) && typeof row.classification.type === "string") {
    return row.classification.type;
  }
  if (typeof row.classification === "string") return row.classification;
  return "";
}

function rowPrefixStable(row) {
  if (typeof row.prefixStable === "boolean") return row.prefixStable;
  if (isPlainObject(row.prefixStableAfter)) {
    return row.prefixStableAfter.prefixStable === true;
  }
  if (isPlainObject(row.prefixCheck)) {
    return row.prefixCheck.prefixStable === true;
  }
  return null;
}

function rowSystemToolsStable(row) {
  if (typeof row.systemToolsStable === "boolean") return row.systemToolsStable;
  if (isPlainObject(row.systemToolsHashStable)) {
    const result = row.systemToolsHashStable;
    return result.stable === true || result.ok === true;
  }
  return null;
}

function rowH(row) {
  if (typeof row.h === "number" && Number.isFinite(row.h)) return row.h;
  if (typeof row.hFull === "number" && Number.isFinite(row.hFull)) return row.hFull;
  if (typeof row.hReadProxy === "number" && Number.isFinite(row.hReadProxy)) {
    return row.hReadProxy;
  }
  return null;
}

/**
 * stablePeriodMedianH(samples)
 * 只对 A 类样本的中位 H_full 作门禁；B 给代理中位；C/D 显式不可测。
 * samples 可为 evaluateCacheSample 输出，也可为附带 transition/prefix/systemTools 的行。
 */
export function stablePeriodMedianH(samples) {
  return tryCatch(() => {
    if (!Array.isArray(samples)) {
      return errorResult("invalid-samples", "samples must be an array");
    }
    const normalized = [];
    for (let i = 0; i < samples.length; i += 1) {
      const row = samples[i];
      if (!isPlainObject(row)) {
        return errorResult("invalid-sample-row", `samples[${i}] must be an object`);
      }
      const evaluated = evaluateSampleCore(row);
      const scenario = evaluated.scenario || "";
      const h = rowH(row) ?? evaluated.h;
      normalized.push({
        scenario,
        measurement: evaluated.measurement,
        h: h === null || h === undefined ? null : h,
        transition: rowTransition(row),
        prefixStable: rowPrefixStable(row),
        systemToolsStable: rowSystemToolsStable(row),
        reason: evaluated.reason ?? "",
      });
    }

    let appendOnlyCount = 0;
    let plannedInvalidationCount = 0;
    let versionBoundaryCount = 0;
    let prefixViolationCount = 0;
    let consecutiveAppendOnly = 0;
    let appendRunH = [];
    const aValuesInStableRuns = [];
    const bValues = [];
    const unmeasurable = [];
    const incomplete = [];

    for (const row of normalized) {
      const transition = row.transition || (row.prefixStable === false ? "prefix-violation" : "");
      if (transition === "planned-invalidation" || transition === "hidden-window") {
        plannedInvalidationCount += 1;
        consecutiveAppendOnly = 0;
        appendRunH = [];
        continue;
      }
      if (transition === "version-boundary") {
        versionBoundaryCount += 1;
        consecutiveAppendOnly = 0;
        appendRunH = [];
        continue;
      }
      if (transition === "prefix-violation") {
        prefixViolationCount += 1;
        consecutiveAppendOnly = 0;
        appendRunH = [];
        continue;
      }
      const isAppend =
        transition === "append-only" ||
        (transition === "" &&
          row.prefixStable !== false &&
          row.scenario !== "");
      if (!isAppend) {
        consecutiveAppendOnly = 0;
        appendRunH = [];
        continue;
      }
      appendOnlyCount += 1;
      consecutiveAppendOnly += 1;
      if (row.systemToolsStable === false || row.prefixStable === false) {
        incomplete.push(row);
        appendRunH = [];
        continue;
      }
      if (row.scenario === "C" || row.scenario === "D" || row.measurement === "cache_unmeasurable") {
        unmeasurable.push(row);
        continue;
      }
      if (row.scenario === "A") {
        if (row.h !== null) {
          appendRunH.push(row.h);
          if (consecutiveAppendOnly === 3) {
            aValuesInStableRuns.push(...appendRunH);
          } else if (consecutiveAppendOnly > 3) {
            aValuesInStableRuns.push(row.h);
          }
        }
      } else if (row.scenario === "B") {
        if (row.h !== null) bValues.push(row.h);
      } else if (row.systemToolsStable === null || row.prefixStable === null) {
        incomplete.push(row);
      }
    }

    const medianHFull = medianOf(aValuesInStableRuns);
    const medianHReadProxy = medianOf(bValues);
    return {
      ok: true,
      medianHFull,
      medianH: medianHFull,
      medianHReadProxy,
      bMedianHReadProxy: medianHReadProxy,
      stablePeriodCount: aValuesInStableRuns.length,
      appendOnlyCount,
      plannedInvalidationCount,
      versionBoundaryCount,
      prefixViolationCount,
      unmeasurableCount: unmeasurable.length,
      incompleteCount: incomplete.length,
      hFullValues: [...aValuesInStableRuns],
      hReadProxyValues: [...bValues],
      reasons: [],
    };
  });
}

// ---------------------------------------------------------------------------
// m4Verdict —— InvalidationEvents / 前缀违规 / A 门禁 / B/C/D 摘要
// ---------------------------------------------------------------------------

function recordScenario(record) {
  if (typeof record.scenario === "string" && record.scenario !== "") {
    return normalizeCacheScenario(record.scenario);
  }
  return "";
}

/**
 * m4Verdict(records)
 * records 为分类/失效/测量/前缀守卫结果的记录数组；输出验收摘要。
 * A 硬门禁按 H_full 中位 ≥ 0.90；B 只代理；C/D 显式 cache_unmeasurable。
 */
export function m4Verdict(records) {
  return tryCatch(() => {
    if (!Array.isArray(records)) {
      return errorResult("invalid-records", "records must be an array");
    }
    let invalidationEvents = 0;
    let prefixViolations = 0;
    let appendOnlyCount = 0;
    let plannedInvalidationCount = 0;
    const a = [];
    const b = [];
    let cCount = 0;
    let dCount = 0;
    const reasons = [];

    for (const record of records) {
      if (!isPlainObject(record)) {
        reasons.push("skipped non-object record");
        continue;
      }
      const transition =
        rowTransition(record) ||
        (record.prefixStable === false ? "prefix-violation" : "");
      if (transition === "prefix-violation") prefixViolations += 1;
      if (transition === "append-only") appendOnlyCount += 1;
      if (transition === "planned-invalidation") plannedInvalidationCount += 1;
      // invalidationCount 结果 / 失效组记录
      if (typeof record.count === "number" && isPlainObject(record.kinds)) {
        invalidationEvents += record.count;
      } else if (typeof record.kind === "string") {
        const kind = countOneGroup(record);
        if (kind !== null) invalidationEvents += 1;
      } else if (record.type === "planned-invalidation") {
        invalidationEvents += 1;
      }
      // A/B/C/D 测量
      const scenario = recordScenario(record);
      if (scenario === "A") {
        const h = rowH(record) ?? evaluateSampleCore(record).h;
        if (typeof h === "number" && Number.isFinite(h)) a.push(h);
      } else if (scenario === "B") {
        const h = rowH(record) ?? evaluateSampleCore(record).h;
        if (typeof h === "number" && Number.isFinite(h)) b.push(h);
      } else if (scenario === "C") {
        cCount += 1;
      } else if (scenario === "D") {
        dCount += 1;
      } else if (record.measurement === "cache_unmeasurable") {
        // 记录中无 scenario 但已显式不可测，不计 A/B。
      }
    }

    // 防止同一 classify 记录同时经 rowTransition 与 record.type 双计。
    // 兼容老式记录：上面的 record.type 分支只在无 transition 时补计。
    const medianA = medianOf(a);
    const medianB = medianOf(b);
    const aGatePassed = a.length === 0 ? null : medianA >= 0.9;
    if (prefixViolations > 0) reasons.push(`prefix violations: ${prefixViolations}`);
    if (a.length > 0 && medianA < 0.9) {
      reasons.push(`A median H_full ${medianA} below 0.90 gate`);
    }
    const verdict =
      prefixViolations > 0
        ? "FAIL"
        : a.length > 0 && medianA < 0.9
          ? "FAIL"
          : records.length === 0
            ? "INCONCLUSIVE"
            : "PASS";
    return {
      ok: true,
      invalidationEvents,
      prefixViolations,
      prefixViolationCount: prefixViolations,
      appendOnlyCount,
      plannedInvalidationCount,
      a: {
        count: a.length,
        medianHFull: medianA,
        gatePassed: aGatePassed,
      },
      aGatePassed,
      b: {
        count: b.length,
        medianHReadProxy: medianB,
        proxyOnly: true,
      },
      bMedianHReadProxy: medianB,
      c: { count: cCount, unmeasurable: true },
      d: { count: dCount, unmeasurable: true },
      unmeasurableCount: cCount + dCount,
      verdict,
      reasons,
    };
  });
}
