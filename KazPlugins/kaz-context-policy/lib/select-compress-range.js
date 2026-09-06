// kaz-context-policy M1 —— 离线纯函数原型：压缩选区选择器
// ===========================================================================
// 纯 ESM、零 I/O、零依赖：不 import node:*、cordis 或 DSH 模块。
// 不改 DSH 核心 / 不改 preset / 不注册工具 / 不碰 tool-lists。
//
// 输入 units（prepare 排序后再计算）：
//   [{ id?:string, position?:number, seqStart:number, seqEnd:number,
//      tokens:number, layer:string }]
//   layer ∈ core-task | active-detail | detail | noise
//   id 若提供则必须是 trim 后非空 string，否则校验报错 invalid-unit-id。
//   position 若提供则必须是非负安全整数且彼此唯一；它显式表达 surface 顺序，
//   排序时优先于 seqStart（无 position 的 unit 回退按 seqStart 排序，旧行为不变）。
//
// opts（缺省见 DEFAULT_*）：
//   { preservePrefixTokens, preserveTailTokens, maxFoldTokens,
//     layerPriority, protectedUnitIds, fillToBudget }
//
// protectedUnitIds 的匹配规则：
//   1) unit 提供 id 时，只按 String(unit.id) 匹配；
//   2) unit 缺 id 时，回退为 prepare 排序（position，否则 seqStart）后
//      0-based index 的字符串匹配；
//      （不再按 seqStart 作身份。）
//
// 选择语义：
//   - 前缀保护：从最前开始累计 tokens，能完整放入 preservePrefixTokens 的整 unit
//     才视为受保护（不切割 unit）。
//   - 尾部保护：从最后开始累计 tokens，规则同上。
//   - protectedUnitIds 强制保护，永不进入压缩区。
//   - 可压区 = 保护前缀之后、保护尾之前、且未被强制保护的 units。
//   - 层优先级：layerPriority 靠前 = 越优先压缩；默认 noise 先于 detail。
//   - 同一层内：选最靠右的连续 run；若 run 超过 maxFoldTokens，则一次只压该 run
//     最右侧且累计不超过预算的后缀（staged fold，先小压，后续再压更左部分）。
//   - fillToBudget=true：改走连续预算填充。忽略 layerPriority 的 run 切片，从
//     可压区最右侧 unit 开始向左累计；允许跨 layer/跨 run，连续闭区间不包含
//     强制保护单位（遇到 protected 停在其右边界）。累计不超过 maxFoldTokens；
//     若首个（最右）单 unit 已超预算，仍整条压（singleOversized 语义）。
// ===========================================================================

export const LAYERS = Object.freeze([
  "core-task",
  "active-detail",
  "detail",
  "noise",
]);
export const LAYER_PRIORITY_DEFAULT = Object.freeze([
  "noise",
  "detail",
  "active-detail",
  "core-task",
]);
export const DEFAULT_PRESERVE_PREFIX_TOKENS = 4096;
export const DEFAULT_PRESERVE_TAIL_TOKENS = 8192;
export const DEFAULT_MAX_FOLD_TOKENS = 8192;

const LAYER_SET = new Set(LAYERS);
const REASON_NO_COMPRESSIBLE_RANGE =
  "no compressible unit range after prefix/tail protection, protected ids, and maxFoldTokens";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function failure(code, reason) {
  return { ok: false, code, reason };
}

function sumTokens(units, start, end) {
  let total = 0;
  for (let i = start; i <= end; i += 1) total += units[i].tokens;
  return total;
}

/** prepare 排序后 units 的 unit 身份键：有 id 时用 String(unit.id)，无 id 返回 null。 */
function protectedKeyOf(unit) {
  if (
    Object.prototype.hasOwnProperty.call(unit, "id") &&
    unit.id !== undefined &&
    unit.id !== null
  ) {
    return String(unit.id);
  }
  return null;
}

function isProtected(unit, sortedIndex, idSet) {
  const key = protectedKeyOf(unit);
  if (key !== null) return idSet.has(key);
  // 缺 id：排序后 0-based index 作为保护键。
  return idSet.has(String(sortedIndex));
}

function validateUnits(units) {
  if (!Array.isArray(units)) {
    return failure("invalid-units", "units must be an array");
  }
  if (units.length === 0) {
    return failure("invalid-units", "units must not be empty");
  }
  const seenSeqStart = new Set();
  const seenPositions = new Set();
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];
    if (!isPlainObject(unit)) {
      return failure("invalid-unit", `units[${i}] must be a plain object`);
    }
    const { id, position, seqStart, seqEnd, tokens, layer } = unit;
    if (id !== undefined) {
      if (typeof id !== "string" || id.trim().length === 0) {
        return failure(
          "invalid-unit-id",
          `units[${i}].id must be a string with non-empty trimmed value when provided`,
        );
      }
    }
    if (position !== undefined && !isNonNegativeSafeInteger(position)) {
      return failure(
        "invalid-position",
        `units[${i}].position must be a non-negative safe integer when provided`,
      );
    }
    if (position !== undefined && seenPositions.has(position)) {
      return failure(
        "duplicate-position",
        `duplicate position ${position}; position must be unique`,
      );
    }
    if (position !== undefined) seenPositions.add(position);
    if (!isNonNegativeSafeInteger(seqStart)) {
      return failure(
        "invalid-seq",
        `units[${i}].seqStart must be a non-negative safe integer`,
      );
    }
    if (!isNonNegativeSafeInteger(seqEnd)) {
      return failure(
        "invalid-seq",
        `units[${i}].seqEnd must be a non-negative safe integer`,
      );
    }
    if (seqEnd < seqStart) {
      return failure(
        "invalid-seq",
        `units[${i}].seqEnd (${seqEnd}) must be >= seqStart (${seqStart})`,
      );
    }
    if (tokens < 0) {
      return failure(
        "negative-token",
        `units[${i}].tokens must not be negative`,
      );
    }
    if (!Number.isSafeInteger(tokens)) {
      return failure(
        "invalid-token",
        `units[${i}].tokens must be a safe integer`,
      );
    }
    if (!LAYER_SET.has(layer)) {
      return failure(
        "invalid-layer",
        `units[${i}].layer must be one of ${LAYERS.join("|")}`,
      );
    }
    if (seenSeqStart.has(seqStart)) {
      return failure(
        "duplicate-seq",
        `duplicate seqStart ${seqStart}; seqStart must be unique`,
      );
    }
    seenSeqStart.add(seqStart);
  }
  return { ok: true };
}

function validateProtectedUnitIds(value) {
  if (value === undefined) return { ok: true, ids: [] };
  if (!Array.isArray(value)) {
    return failure("invalid-protected-unit-id", "protectedUnitIds must be an array");
  }
  const ids = [];
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    if (typeof entry !== "string" && typeof entry !== "number") {
      return failure(
        "invalid-protected-unit-id",
        `protectedUnitIds[${i}] must be a string or number`,
      );
    }
    const key = String(entry).trim();
    if (key.length === 0) {
      return failure(
        "invalid-protected-unit-id",
        `protectedUnitIds[${i}] must not be empty`,
      );
    }
    ids.push(key);
  }
  return { ok: true, ids };
}

function normalizeOpts(rawOpts) {
  if (rawOpts === undefined) rawOpts = {};
  if (!isPlainObject(rawOpts)) {
    return failure("invalid-opts", "opts must be a plain object or undefined");
  }

  const readBudget = (value, fallback, code) => {
    if (value === undefined) return fallback;
    if (!isNonNegativeSafeInteger(value)) {
      return failure(code, "value must be a non-negative safe integer");
    }
    return value;
  };

  const prefix = readBudget(
    rawOpts.preservePrefixTokens,
    DEFAULT_PRESERVE_PREFIX_TOKENS,
    "invalid-prefix-budget",
  );
  if (typeof prefix === "object") return prefix;

  const tail = readBudget(
    rawOpts.preserveTailTokens,
    DEFAULT_PRESERVE_TAIL_TOKENS,
    "invalid-tail-budget",
  );
  if (typeof tail === "object") return tail;

  if (rawOpts.maxFoldTokens === undefined) {
    var maxFold = DEFAULT_MAX_FOLD_TOKENS;
  } else if (
    !Number.isSafeInteger(rawOpts.maxFoldTokens) ||
    rawOpts.maxFoldTokens <= 0
  ) {
    return failure(
      "invalid-max-fold",
      "maxFoldTokens must be a positive safe integer",
    );
  } else {
    var maxFold = rawOpts.maxFoldTokens;
  }

  let layerPriority = LAYER_PRIORITY_DEFAULT;
  if (rawOpts.layerPriority !== undefined) {
    const candidate = rawOpts.layerPriority;
    if (!Array.isArray(candidate) || candidate.length === 0) {
      return failure(
        "invalid-layer-priority",
        "layerPriority must be a non-empty array",
      );
    }
    const seen = new Set();
    for (let i = 0; i < candidate.length; i += 1) {
      const layer = candidate[i];
      if (!LAYER_SET.has(layer)) {
        return failure(
          "invalid-layer-priority",
          `layerPriority[${i}] must be one of ${LAYERS.join("|")}`,
        );
      }
      if (seen.has(layer)) {
        return failure(
          "invalid-layer-priority",
          `layerPriority contains duplicate layer ${layer}`,
        );
      }
      seen.add(layer);
    }
    layerPriority = candidate.slice();
  }

  const protectedResult = validateProtectedUnitIds(rawOpts.protectedUnitIds);
  if (!protectedResult.ok) return protectedResult;

  let fillToBudget = false;
  if (rawOpts.fillToBudget !== undefined) {
    if (typeof rawOpts.fillToBudget !== "boolean") {
      return failure(
        "invalid-fill-to-budget",
        "fillToBudget must be a boolean when provided",
      );
    }
    fillToBudget = rawOpts.fillToBudget;
  }

  return {
    ok: true,
    opts: {
      preservePrefixTokens: prefix,
      preserveTailTokens: tail,
      maxFoldTokens: maxFold,
      layerPriority,
      protectedIds: new Set(protectedResult.ids),
      fillToBudget,
    },
  };
}

function prepare(units, rawOpts) {
  const unitResult = validateUnits(units);
  if (!unitResult.ok) return unitResult;

  const optResult = normalizeOpts(rawOpts);
  if (!optResult.ok) return optResult;

  const sorted = units
    .map((unit, originalIndex) => ({ ...unit, __originalIndex: originalIndex }))
    .sort((a, b) => {
      // 显式 surface 顺序：有 position 用 position，否则回退 seqStart（旧行为）。
      const aKey = a.position !== undefined ? a.position : a.seqStart;
      const bKey = b.position !== undefined ? b.position : b.seqStart;
      return aKey - bKey || (a.__originalIndex < b.__originalIndex ? -1 : 1);
    });

  return { ok: true, units: sorted, opts: optResult.opts };
}

/** 前缀整 unit 累计：返回第一个未被前缀保护的索引。 */
function prefixProtectedEnd(units, budget) {
  let used = 0;
  let index = 0;
  while (
    index < units.length &&
    used + units[index].tokens <= budget
  ) {
    used += units[index].tokens;
    index += 1;
  }
  return index;
}

/** 尾部整 unit 累计：返回尾部保护开始索引（含）。 */
function tailProtectedStart(units, budget) {
  let used = 0;
  let index = units.length;
  while (
    index > 0 &&
    used + units[index - 1].tokens <= budget
  ) {
    used += units[index - 1].tokens;
    index -= 1;
  }
  return index;
}

/** 收集 [prefixEnd, tailStart) 内未被强制保护的可压索引。 */
function collectCandidateIndices(units, prefixEnd, tailStart, idSet) {
  const candidates = [];
  for (let i = prefixEnd; i < tailStart; i += 1) {
    if (!isProtected(units[i], i, idSet)) candidates.push(i);
  }
  return candidates;
}

/** 在候选索引中，把相邻且同 layer 的连续索引切成 run。 */
function collectRunsForLayer(candidates, units, layer) {
  const runs = [];
  let open = null;
  const close = () => {
    if (open) runs.push(open);
    open = null;
  };
  for (const index of candidates) {
    if (units[index].layer !== layer) {
      close();
      continue;
    }
    if (!open) {
      open = { start: index, end: index };
    } else if (index === open.end + 1) {
      open.end = index;
    } else {
      // 中间被 protected/其它层隔开：同层也要另起一段。
      close();
      open = { start: index, end: index };
    }
  }
  close();
  return runs;
}

/**
 * 在一个同层 run 内找“最靠右、且不超 maxFoldTokens”的连续子区。
 * 逐 b（结束索引）从右往左；找到第一个可行结束点后，再从它向左尽量多取
 * 整 unit（staged fold：单次尽量接近预算但绝不超预算）。
 */
function rightmostFeasibleSliceInRun(units, run, maxFoldTokens) {
  for (let end = run.end; end >= run.start; end -= 1) {
    let used = 0;
    let start = end + 1;
    for (let i = end; i >= run.start; i -= 1) {
      if (used + units[i].tokens <= maxFoldTokens) {
        used += units[i].tokens;
        start = i;
      } else {
        break;
      }
    }
    if (start <= end && used > 0) {
      return { start, end };
    }
  }
  return null;
}

/**
 * 连续预算填充（fillToBudget=true）。
 * 从可压区最右侧未强保 unit 开始向左累计：允许跨 layer/跨 run，但只返回
 * 排序索引上的连续闭区间，因此遇到 protected/前缀边界就停止；累计不超过
 * maxFoldTokens。若最右侧首个单 unit 本身已超预算，仍整条压（singleOversized）。
 */
function pickFillRange(units, opts) {
  const prefixEnd = prefixProtectedEnd(units, opts.preservePrefixTokens);
  const tailStart = tailProtectedStart(units, opts.preserveTailTokens);

  if (prefixEnd >= tailStart) return null;

  let end = tailStart - 1;
  while (end >= prefixEnd && isProtected(units[end], end, opts.protectedIds)) {
    end -= 1;
  }
  if (end < prefixEnd) return null;

  let used = 0;
  let start = end + 1;
  for (let i = end; i >= prefixEnd; i -= 1) {
    if (isProtected(units[i], i, opts.protectedIds)) break;
    const nextTotal = used + units[i].tokens;
    if (nextTotal <= opts.maxFoldTokens) {
      used += units[i].tokens;
      start = i;
      continue;
    }
    // 预算已满：不再向左取（闭区间保持连续）。
    // 若这是最右首个 unit，说明单 unit 超预算 → 仍整条压。
    if (start === end + 1) return { start: i, end: i };
    break;
  }

  if (start <= end) return { start, end };
  return null;
}

/**
 * 核心决策：返回 { start, end }（排序后索引，闭区间），或 null。
 */
function pickRange(units, opts) {
  if (opts.fillToBudget) return pickFillRange(units, opts);

  const prefixEnd = prefixProtectedEnd(units, opts.preservePrefixTokens);
  const tailStart = tailProtectedStart(units, opts.preserveTailTokens);

  if (prefixEnd >= tailStart) return null;

  const candidates = collectCandidateIndices(
    units,
    prefixEnd,
    tailStart,
    opts.protectedIds,
  );
  if (candidates.length === 0) return null;

  for (const layer of opts.layerPriority) {
    const runs = collectRunsForLayer(candidates, units, layer);
    for (let r = runs.length - 1; r >= 0; r -= 1) {
      const slice = rightmostFeasibleSliceInRun(
        units,
        runs[r],
        opts.maxFoldTokens,
      );
      if (slice) return slice;
    }
  }
  return null;
}

function buildIndexResult(units, range) {
  return {
    ok: true,
    unitStart: range.start,
    unitEnd: range.end,
  };
}

function buildSelectResult(units, range) {
  const { start, end } = range;
  return {
    ok: true,
    unitStart: start,
    unitEnd: end,
    startSeq: units[start].seqStart,
    endSeq: units[end].seqEnd,
    shadowedTokens: sumTokens(units, start, end),
    cachePreservedTokens: sumTokens(units, 0, start - 1),
    tailPreservedTokens: sumTokens(units, end + 1, units.length - 1),
  };
}

/**
 * 找出本次应压缩的索引闭区间。
 * 返回 { ok:true, unitStart, unitEnd } 或 { ok:false, code, reason }。
 */
export function findCompressibleIndexRange(units, opts) {
  const prepared = prepare(units, opts);
  if (!prepared.ok) return prepared;
  const range = pickRange(prepared.units, prepared.opts);
  if (!range) {
    return failure("no-compressible-range", REASON_NO_COMPRESSIBLE_RANGE);
  }
  return buildIndexResult(prepared.units, range);
}

/**
 * 主入口：返回压缩选区与 token 估算。
 * 成功：{ ok:true, unitStart, unitEnd, startSeq, endSeq,
 *        shadowedTokens, cachePreservedTokens, tailPreservedTokens }
 * 失败：{ ok:false, code, reason }
 */
export function selectCompressRange(units, opts) {
  const prepared = prepare(units, opts);
  if (!prepared.ok) return prepared;
  const range = pickRange(prepared.units, prepared.opts);
  if (!range) {
    return failure("no-compressible-range", REASON_NO_COMPRESSIBLE_RANGE);
  }
  return buildSelectResult(prepared.units, range);
}

/** 估算被压缩（shadowed）区间的 tokens：闭区间 [rangeStart, rangeEnd] 的 tokens 和。 */
export function estimateShadowedTokens(units, rangeStart, rangeEnd) {
  if (
    !Array.isArray(units) ||
    !Number.isSafeInteger(rangeStart) ||
    !Number.isSafeInteger(rangeEnd) ||
    rangeStart < 0 ||
    rangeEnd < rangeStart ||
    rangeEnd >= units.length
  ) {
    throw new TypeError(
      "estimateShadowedTokens(units, rangeStart, rangeEnd): invalid range",
    );
  }
  return sumTokens(units, rangeStart, rangeEnd);
}

/** 估算压缩后仍保留在缓存前缀中的 tokens：rangeStart 左侧（不含）累计 tokens。 */
export function estimateCachePreservedTokens(units, rangeStart, rangeEnd) {
  if (
    !Array.isArray(units) ||
    !Number.isSafeInteger(rangeStart) ||
    !Number.isSafeInteger(rangeEnd) ||
    rangeStart < 0 ||
    rangeEnd < rangeStart ||
    rangeEnd >= units.length
  ) {
    throw new TypeError(
      "estimateCachePreservedTokens(units, rangeStart, rangeEnd): invalid range",
    );
  }
  return sumTokens(units, 0, rangeStart - 1);
}
