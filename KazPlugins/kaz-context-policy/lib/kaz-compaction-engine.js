// kaz-context-policy M3 —— Kaz 压缩 provider：M1 自定义选区 + 官方 compaction 事务
// ===========================================================================
// 在 BasicCompactionEngine 的自动兜底语义之上，把 M1 selectCompressRange 的
// 缓存友好选区接入真实 session/tokenMeter 形状：
//   - units 由 session-context-adapter.buildCompressUnits 按当前 surface 生成；
//   - 可选（默认开）用 ctx.tokenMeter.measure(session).nodes 把每个 unit 的
//     tokens 换成真实 meter 价格，再交给 M1 预算；
//   - compactIfNeeded 保留官方 threshold / toolResultPruner / retry /
//     context-overflow 语义，但自动选区改为 Kaz 分层预算；
//   - compactRegion 沿用父类（BasicCompactionEngine）的持久事务与摘要缝。
//
// 本文件 import DSH 包；运行/加载时必须在能解析 @deepseek-ai/* 的环境
// （例如 ~/.dsh/profiles/web 安装副本）。不改 DSH 核心、不挂 live。
// ===========================================================================

import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import {
  DEFAULT_MAX_FOLD_TOKENS,
  DEFAULT_PRESERVE_PREFIX_TOKENS,
  DEFAULT_PRESERVE_TAIL_TOKENS,
  LAYERS,
  LAYER_PRIORITY_DEFAULT,
  selectCompressRange,
} from "./select-compress-range.js";
import { buildCompressUnits, foldSurfaceNodes } from "./session-context-adapter.js";

export const BASIC_CONFIG_KEYS = Object.freeze([
  "thresholdRatio",
  "retainRatio",
  "retainTokens",
  "summarizationProvider",
  "summarizationModel",
  "maxTokens",
  "compactionRetries",
  "maxOverflowRetries",
  "modelPolicies",
  "auto",
]);

export const KAZ_CONFIG_KEYS = Object.freeze([
  "preservePrefixTokens",
  "preserveTailTokens",
  "maxFoldTokens",
  "layerPriority",
  "protectedUnitIds",
  "useMeterTokens",
  "overflowFallback",
]);

export const ALL_CONFIG_KEYS = Object.freeze([
  ...BASIC_CONFIG_KEYS,
  ...KAZ_CONFIG_KEYS,
]);

export const KAZ_CONFIG_DEFAULTS = Object.freeze({
  preservePrefixTokens: DEFAULT_PRESERVE_PREFIX_TOKENS,
  preserveTailTokens: DEFAULT_PRESERVE_TAIL_TOKENS,
  maxFoldTokens: DEFAULT_MAX_FOLD_TOKENS,
  layerPriority: LAYER_PRIORITY_DEFAULT,
  protectedUnitIds: [],
  useMeterTokens: true,
  overflowFallback: true,
});

const LAYER_SET = new Set(LAYERS);
const BASIC_CONFIG_SET = new Set(BASIC_CONFIG_KEYS);
const ALL_CONFIG_SET = new Set(ALL_CONFIG_KEYS);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function kazError(message) {
  return new Error(`kaz-context-policy: ${message}`);
}

function validateConfigKeys(config) {
  if (config === undefined) return {};
  if (!isPlainObject(config)) throw kazError("config must be a plain object or undefined");
  for (const key of Object.keys(config)) {
    if (!ALL_CONFIG_SET.has(key)) {
      throw kazError(`unknown key "${key}" (allowed: ${ALL_CONFIG_KEYS.join(", ")})`);
    }
  }
  return config;
}

function readBudget(value, fallback, label) {
  if (value === undefined) return fallback;
  if (!isNonNegativeSafeInteger(value)) {
    throw kazError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function readLayerPriority(value) {
  if (value === undefined) return LAYER_PRIORITY_DEFAULT.slice();
  if (!Array.isArray(value) || value.length === 0) {
    throw kazError("layerPriority must be a non-empty array");
  }
  const seen = new Set();
  for (let i = 0; i < value.length; i += 1) {
    const layer = value[i];
    if (!LAYER_SET.has(layer)) {
      throw kazError(`layerPriority[${i}] must be one of ${LAYERS.join("|")}`);
    }
    if (seen.has(layer)) {
      throw kazError(`layerPriority contains duplicate layer ${layer}`);
    }
    seen.add(layer);
  }
  return value.slice();
}

function readProtectedUnitIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw kazError("protectedUnitIds must be an array");
  const ids = [];
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    if (typeof entry !== "string" && typeof entry !== "number") {
      throw kazError(`protectedUnitIds[${i}] must be a string or number`);
    }
    const key = String(entry).trim();
    if (key.length === 0) {
      throw kazError(`protectedUnitIds[${i}] must not be empty`);
    }
    ids.push(key);
  }
  return ids;
}

/**
 * 校验并规范化 Kaz 扩展配置。Basic 字段会透传给父类，这里只处理 Kaz 字段。
 * @returns 冻结的 kaz 配置对象
 */
export function normalizeKazConfig(config) {
  const source = validateConfigKeys(config);
  const preservePrefixTokens = readBudget(
    source.preservePrefixTokens,
    KAZ_CONFIG_DEFAULTS.preservePrefixTokens,
    "preservePrefixTokens",
  );
  const preserveTailTokens = readBudget(
    source.preserveTailTokens,
    KAZ_CONFIG_DEFAULTS.preserveTailTokens,
    "preserveTailTokens",
  );
  let maxFoldTokens = KAZ_CONFIG_DEFAULTS.maxFoldTokens;
  if (source.maxFoldTokens !== undefined) {
    if (!isPositiveSafeInteger(source.maxFoldTokens)) {
      throw kazError("maxFoldTokens must be a positive safe integer");
    }
    maxFoldTokens = source.maxFoldTokens;
  }
  const layerPriority = readLayerPriority(source.layerPriority);
  const protectedUnitIds = readProtectedUnitIds(source.protectedUnitIds);
  let useMeterTokens = KAZ_CONFIG_DEFAULTS.useMeterTokens;
  if (source.useMeterTokens !== undefined) {
    if (typeof source.useMeterTokens !== "boolean") {
      throw kazError("useMeterTokens must be a boolean");
    }
    useMeterTokens = source.useMeterTokens;
  }
  let overflowFallback = KAZ_CONFIG_DEFAULTS.overflowFallback;
  if (source.overflowFallback !== undefined) {
    if (typeof source.overflowFallback !== "boolean") {
      throw kazError("overflowFallback must be a boolean");
    }
    overflowFallback = source.overflowFallback;
  }
  return Object.freeze({
    preservePrefixTokens,
    preserveTailTokens,
    maxFoldTokens,
    layerPriority,
    protectedUnitIds,
    useMeterTokens,
    overflowFallback,
  });
}

/** 从完整配置里挑出父类（BasicCompactionEngine）认识的字段。 */
export function pickBasicConfig(config) {
  validateConfigKeys(config);
  const basic = {};
  for (const key of BASIC_CONFIG_KEYS) {
    if (config !== undefined && Object.prototype.hasOwnProperty.call(config, key)) {
      basic[key] = config[key];
    }
  }
  return basic;
}

function sumRange(nodes, startIndex, endIndex) {
  let total = 0;
  for (let i = startIndex; i <= endIndex; i += 1) total += nodes[i].tokens;
  return total;
}

/** surface 位置序 → seq 的映射；优先 session.surface，缺省回退 fold。 */
function surfaceNodesOfSession(session) {
  if (session && isPlainObject(session.surface) && Array.isArray(session.surface.nodes)) {
    return session.surface.nodes.slice();
  }
  if (session && Array.isArray(session.events)) return foldSurfaceNodes(session.events);
  throw kazError("selectKazRange requires session.surface.nodes or session.events");
}

/**
 * 把 adapter 生成的 unit tokens 替换成 tokenMeter 对同一 surface 范围的实测
 * tokens。unit.seqStart..seqEnd 对应 surface 上的连续位置（M3.1 契约）。
 */
export function applyMeterTokens(units, session, measurement) {
  if (!Array.isArray(measurement) && !(measurement && Array.isArray(measurement.nodes))) {
    return units;
  }
  const meterNodes = Array.isArray(measurement) ? measurement : measurement.nodes;
  const surfaceNodes = surfaceNodesOfSession(session);
  if (surfaceNodes.length !== meterNodes.length) {
    throw kazError(
      `tokenMeter surface length ${meterNodes.length} does not match session surface length ${surfaceNodes.length}`,
    );
  }
  for (let i = 0; i < surfaceNodes.length; i += 1) {
    if (meterNodes[i] == null || meterNodes[i].seq !== surfaceNodes[i]) {
      throw kazError(
        `tokenMeter node[${i}] seq ${meterNodes[i]?.seq} does not match session surface seq ${surfaceNodes[i]}`,
      );
    }
  }
  const indexBySeq = new Map();
  for (let i = 0; i < surfaceNodes.length; i += 1) indexBySeq.set(surfaceNodes[i], i);
  return units.map((unit) => {
    const startIndex = indexBySeq.get(unit.seqStart);
    const endIndex = indexBySeq.get(unit.seqEnd);
    if (startIndex === undefined || endIndex === undefined || startIndex > endIndex) {
      throw kazError(
        `unit ${unit.seqStart}..${unit.seqEnd} is not a contiguous surface position (corrupt adapter output)`,
      );
    }
    return { ...unit, tokens: sumRange(meterNodes, startIndex, endIndex) };
  });
}

function selectionOptionsFrom(rawOptions) {
  const options = rawOptions === undefined ? {} : rawOptions;
  return {
    preservePrefixTokens: readBudget(
      options.preservePrefixTokens,
      KAZ_CONFIG_DEFAULTS.preservePrefixTokens,
      "preservePrefixTokens",
    ),
    preserveTailTokens: readBudget(
      options.preserveTailTokens,
      KAZ_CONFIG_DEFAULTS.preserveTailTokens,
      "preserveTailTokens",
    ),
    maxFoldTokens:
      options.maxFoldTokens === undefined
        ? KAZ_CONFIG_DEFAULTS.maxFoldTokens
        : (() => {
            if (!isPositiveSafeInteger(options.maxFoldTokens)) {
              throw kazError("maxFoldTokens must be a positive safe integer");
            }
            return options.maxFoldTokens;
          })(),
    layerPriority: readLayerPriority(options.layerPriority),
    protectedUnitIds: readProtectedUnitIds(options.protectedUnitIds),
    useMeterTokens:
      options.useMeterTokens === undefined ? true : options.useMeterTokens,
    adapterOptions: options.adapterOptions,
  };
}

/**
 * M1 选区 + 真实 session/tokenMeter 形状的离线入口。
 *
 * @param session DshLike session（events/surface）
 * @param measurement tokenMeter.measure(session) 的结果；缺省时保留 adapter 的粗估 tokens
 * @param rawOptions 支持 M1 四个配置 + protectedUnitIds/useMeterTokens/adapterOptions
 * @returns selectCompressRange 的结果，失败也原样返回 { ok:false, code, reason }
 */
export function selectKazRange(session, measurement, rawOptions) {
  const opts = selectionOptionsFrom(rawOptions);
  const units = buildCompressUnits(session, opts.adapterOptions);
  const pricedUnits =
    opts.useMeterTokens && measurement !== undefined && measurement !== null
      ? applyMeterTokens(units, session, measurement)
      : units;
  const result = selectCompressRange(pricedUnits, {
    preservePrefixTokens: opts.preservePrefixTokens,
    preserveTailTokens: opts.preserveTailTokens,
    maxFoldTokens: opts.maxFoldTokens,
    layerPriority: opts.layerPriority,
    ...(opts.protectedUnitIds.length > 0 ? { protectedUnitIds: opts.protectedUnitIds } : {}),
  });
  if (!result.ok) return result;
  return {
    ...result,
    units: pricedUnits,
    useMeterTokens: opts.useMeterTokens,
  };
}

function routedTarget(session) {
  const header =
    session && typeof session.requestHeader === "function"
      ? session.requestHeader()
      : session && session.requestHeader;
  const config = header && header.config;
  if (
    config &&
    typeof config.provider === "string" &&
    config.provider.length > 0 &&
    typeof config.model === "string" &&
    config.model.length > 0
  ) {
    return { provider: config.provider, model: config.model };
  }
  return undefined;
}

function retentionOf(policy) {
  if (policy.retainTokens !== undefined) return { retainTokens: policy.retainTokens };
  if (policy.retainRatio !== undefined) return { retainRatio: policy.retainRatio };
  return {};
}

function policyForTarget(serviceConfig, target) {
  const override = (serviceConfig.modelPolicies || []).find(
    (policy) =>
      policy.provider === target.provider && policy.model === target.model,
  );
  const retention =
    override === undefined
      ? retentionOf(serviceConfig)
      : override.retainTokens !== undefined
        ? { retainTokens: override.retainTokens }
        : override.retainRatio !== undefined
          ? { retainRatio: override.retainRatio }
          : retentionOf(serviceConfig);
  return {
    thresholdRatio: override?.thresholdRatio ?? serviceConfig.thresholdRatio,
    ...retention,
    summarizationProvider:
      override?.summarizationProvider ?? serviceConfig.summarizationProvider,
    summarizationModel:
      override?.summarizationModel ?? serviceConfig.summarizationModel,
    maxTokens: override?.maxTokens ?? serviceConfig.maxTokens,
    compactionRetries:
      override?.compactionRetries ?? serviceConfig.compactionRetries,
    maxOverflowRetries:
      override?.maxOverflowRetries ?? serviceConfig.maxOverflowRetries,
    target: { ...target },
  };
}

function compactSpecFor(policy, contextWindow) {
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    const error = new Error(
      `BasicCompactionConfig: contextWindow (${contextWindow}) must be a positive integer`,
    );
    error.targetKey = `${policy.target.provider}/${policy.target.model}`;
    throw error;
  }
  const thresholdTokens = Math.floor(contextWindow * policy.thresholdRatio);
  let retainTokens;
  if (policy.retainTokens !== undefined) {
    retainTokens = policy.retainTokens;
  } else if (policy.retainRatio !== undefined) {
    retainTokens = Math.floor(contextWindow * policy.retainRatio);
  } else {
    retainTokens = 0;
  }
  if (retainTokens >= thresholdTokens) {
    throw new Error(
      `BasicCompactionConfig: ${policy.target.provider}/${policy.target.model} retainTokens (${retainTokens}) must be less than threshold tokens ${thresholdTokens}`,
    );
  }
  return {
    target: { ...policy.target },
    contextWindow,
    thresholdRatio: policy.thresholdRatio,
    thresholdTokens,
    retainTokens,
    summarizationProvider: policy.summarizationProvider,
    summarizationModel: policy.summarizationModel,
    maxTokens: policy.maxTokens,
    compactionRetries: policy.compactionRetries,
    maxOverflowRetries: policy.maxOverflowRetries,
  };
}

function hasActiveCompaction(events) {
  if (!Array.isArray(events)) return false;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type === "compaction/start") return true;
    if (event.type === "compaction/end") return false;
  }
  return false;
}

function errWithCode(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * KazCompactionEngine：ctx.compaction provider。
 *
 * 配置可同时包含 BasicCompactionEngine 字段与 Kaz 扩展字段：
 *   thresholdRatio/retainRatio/retainTokens/modelPolicies/... （父类）
 *   preservePrefixTokens/preserveTailTokens/maxFoldTokens/layerPriority （M1）
 */
export class KazCompactionEngine extends BasicCompactionEngine {
  /** Kaz 扩展配置（冻结）。 */
  kazConfig;

  constructor(ctx, config = {}) {
    const normalized = normalizeKazConfig(config); // 先校验 Kaz 字段
    const basicConfig = pickBasicConfig(config);
    super(ctx, basicConfig);
    this.kazConfig = normalized;
  }

  /** 返回本次应交给 compactRegion 的 range（surface seq 闭区间），无候选时 null。 */
  selectRange(session, measurement, { overflow = false, force = false } = {}) {
    const base = this.kazConfig;
    const primaryOptions = {
      preservePrefixTokens: base.preservePrefixTokens,
      preserveTailTokens: overflow ? 0 : base.preserveTailTokens,
      maxFoldTokens: base.maxFoldTokens,
      layerPriority: base.layerPriority,
      protectedUnitIds: base.protectedUnitIds,
      useMeterTokens: base.useMeterTokens,
    };
    if (force) {
      primaryOptions.preservePrefixTokens = 0;
      primaryOptions.preserveTailTokens = 0;
      primaryOptions.maxFoldTokens = Number.MAX_SAFE_INTEGER;
    }
    let result = selectKazRange(session, measurement, primaryOptions);
    if (result.ok) {
      return {
        start: result.startSeq,
        end: result.endSeq,
        result,
      };
    }
    if (
      overflow &&
      base.overflowFallback &&
      result.code === "no-compressible-range"
    ) {
      const fallback = selectKazRange(session, measurement, {
        preservePrefixTokens: 0,
        preserveTailTokens: 0,
        maxFoldTokens: Number.MAX_SAFE_INTEGER,
        layerPriority: base.layerPriority,
        protectedUnitIds: base.protectedUnitIds,
        useMeterTokens: base.useMeterTokens,
      });
      if (fallback.ok) {
        return {
          start: fallback.startSeq,
          end: fallback.endSeq,
          result: fallback,
          overflowFallback: true,
        };
      }
    }
    return null;
  }

  /**
   * 自动兜底入口。保留父类压力阈值 / toolResultPruner / retry 与
   * context-overflow 恢复语义，但两处选区都换成 M1 selectCompressRange。
   */
  async compactIfNeeded(agent, trigger, signal) {
    const target = routedTarget(agent.session);
    if (target === undefined) return null;
    const meter = this.ctx.tokenMeter;
    if (!meter || typeof meter.measure !== "function") {
      throw errWithCode(
        "kaz-compaction-engine: ctx.tokenMeter.measure is required",
        "TOKEN_METER_MISSING",
      );
    }
    let measurement = meter.measure(agent.session);
    const getPruner = () =>
      this.ctx && typeof this.ctx.get === "function"
        ? this.ctx.get("toolResultPruner")
        : undefined;

    if (trigger === "context-overflow") {
      const pruner = getPruner();
      if (pruner && typeof pruner.pruneSession === "function") {
        pruner.pruneSession(agent.session);
        measurement = meter.measure(agent.session);
      }
      const range = this.selectRange(agent.session, measurement, { overflow: true });
      if (range === null) return null;
      return this.compactRegion(range.start, range.end, agent, signal);
    }

    if (trigger !== "pressure") {
      throw new Error(`kaz-compaction-engine: unknown trigger ${String(trigger)}`);
    }

    const policy = policyForTarget(this.config, target);
    const llm = this.ctx.llm;
    if (!llm || typeof llm.resolveModelInfo !== "function") {
      throw errWithCode(
        "kaz-compaction-engine: ctx.llm.resolveModelInfo is required for pressure compaction",
        "LLM_MISSING",
      );
    }
    const info = await llm.resolveModelInfo(target.provider, target.model, signal);
    const context = info && info.context;
    if (context === undefined || context === null) {
      throw new Error(
        `kaz-compaction-engine: no context capacity for ${target.provider}/${target.model}; configure contextWindow on that adapter model`,
      );
    }
    const spec = compactSpecFor(policy, context.contextWindow);
    if (measurement.totalTokens < spec.thresholdTokens) return null;

    const pruner = getPruner();
    if (pruner && typeof pruner.pruneSession === "function") {
      pruner.pruneSession(agent.session);
      measurement = meter.measure(agent.session);
      if (measurement.totalTokens < spec.thresholdTokens) return null;
    }

    let result = null;
    for (
      let attempt = 0;
      attempt <= spec.compactionRetries;
      attempt += 1
    ) {
      const range = this.selectRange(agent.session, measurement, {
        overflow: false,
      });
      if (range === null) {
        if (result === null) return null;
        break;
      }
      result = await this.compactRegion(range.start, range.end, agent, signal);
      measurement = meter.measure(agent.session);
      if (measurement.totalTokens < spec.thresholdTokens) return result;
    }
    throw new Error(
      `kaz-compaction-engine: still above threshold after ${spec.compactionRetries + 1} compaction attempts (${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`,
    );
  }
}

export default KazCompactionEngine;
