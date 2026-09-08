// ka-whale-workflow —— 7.4 P0 cost meter（纯 ESM，只存聚合计数，不存正文）
// ===========================================================================
// 存储（§7.2/§7.3）：
//   DSH_HOME/storages/ka-whale-workflow/cost-meter/<sessionId>-<runId>.json
//   - schema version 随文件走；旧文件缺字段按 0 计；
//   - 按 run 聚合、追加式合并写；失败只 warn，不影响主流程；
//   - aggregate-only：只存 sessionId/runId/计数/长度/派生值，绝不存
//     content / prompt / memory / report 正文。
// 热路径：调用方只做 O(1) 内存累加，落盘由 createCostMeterWriter 去抖异步执行。
// ===========================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** cost-meter 文件 schema version（v1：P0 五类计数器 + 派生字段）。 */
export const COST_METER_SCHEMA_VERSION = 1;

/** 默认 cost-meter 根目录：DSH_HOME/storages/ka-whale-workflow/cost-meter。 */
export function defaultCostMeterDirectory() {
  return join(
    process.env.DSH_HOME || join(homedir(), ".dsh"),
    "storages",
    "ka-whale-workflow",
    "cost-meter",
  );
}

/** 构造某 agent/run 的 meter 文件路径；非法 runId 按 0 计。 */
export function costMeterFileFor(directory, sessionId, runId) {
  const safeRunId = Number.isSafeInteger(runId) && runId > 0 ? runId : 0;
  return join(directory, `${String(sessionId)}-${safeRunId}.json`);
}

/** 读取单个非负计数；非法/缺失一律按 0。 */
function nonNegativeNumber(value, integerOnly = false) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return integerOnly ? Math.floor(number) : number;
}

/** 合法正整数 runId；缺失按传入兜底（通常 0）。 */
function safeRunId(value, fallback = 0) {
  const runId = Number(value);
  return Number.isSafeInteger(runId) && runId > 0 ? runId : fallback;
}

/** 空 meter 记录（所有字段显式零值）。 */
export function emptyCostMeter(sessionId = "", runId = 0) {
  return {
    version: COST_METER_SCHEMA_VERSION,
    sessionId: typeof sessionId === "string" ? sessionId : "",
    runId: safeRunId(runId),
    modelRequests: 0,
    turns: 0,
    injectedChars: 0,
    reportChars: 0,
    gatePassRate: 0,
    costPerDeliveredItem: 0,
  };
}

/**
 * 归一化任意旧/新 meter 原始对象：
 * - schema version 缺失/非法时按当前版本读取；
 * - 缺失字段一律按 0 计（§7.2）；
 * - 未知字段（含任何正文/内容键）不保留。
 */
export function normalizeCostMeter(raw, sessionId = "", runId = 0) {
  const source =
    raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const base = emptyCostMeter(sessionId, runId);
  return {
    ...base,
    version:
      Number.isSafeInteger(source.version) && source.version > 0
        ? source.version
        : COST_METER_SCHEMA_VERSION,
    sessionId:
      typeof source.sessionId === "string" && source.sessionId.length > 0
        ? source.sessionId
        : typeof sessionId === "string"
          ? sessionId
          : "",
    runId: safeRunId(source.runId, runId),
    modelRequests: nonNegativeNumber(source.modelRequests, true),
    turns: nonNegativeNumber(source.turns, true),
    injectedChars: nonNegativeNumber(source.injectedChars, true),
    reportChars: nonNegativeNumber(source.reportChars, true),
    gatePassRate: nonNegativeNumber(source.gatePassRate),
    costPerDeliveredItem: nonNegativeNumber(source.costPerDeliveredItem),
  };
}

/**
 * 派生字段（compute only，P0 不参与任何 gate）：
 * - gatePassRate = gatePasses / gateTotal（P3 前无分母 → 0）；
 * - costPerDeliveredItem = (modelRequests + injectedChars + reportChars)
 *   / deliveredItems（P0 无交付计数 → 0）。
 * 返回归一化新对象，不修改入参。
 */
export function deriveCostMeter(meter, context = {}) {
  const normalized = normalizeCostMeter(meter);
  const gateTotal = nonNegativeNumber(context?.gateTotal ?? normalized.gateTotal ?? 0);
  const gatePasses = nonNegativeNumber(context?.gatePasses ?? normalized.gatePasses ?? 0);
  const deliveredItems = nonNegativeNumber(context?.deliveredItems ?? normalized.deliveredItems ?? 0);
  const gatePassRate = gateTotal > 0 ? Math.min(1, gatePasses / gateTotal) : 0;
  const costPerDeliveredItem =
    deliveredItems > 0
      ? (normalized.modelRequests + normalized.injectedChars + normalized.reportChars) /
        deliveredItems
      : 0;
  return {
    ...normalized,
    gatePassRate,
    costPerDeliveredItem,
  };
}

/** 读取 meter 文件；缺失/损坏返回 null（调用方按空记录计）。 */
export function readCostMeterFile(file) {
  try {
    if (typeof file !== "string" || file.length === 0 || !existsSync(file)) return null;
    let raw = readFileSync(file, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 把聚合记录写入文件（best-effort；失败抛给调用方按 warn 处理）。 */
export function writeCostMeterFile(file, meter) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const derived = deriveCostMeter(meter);
    writeFileSync(
      file,
      JSON.stringify(
        {
          version: derived.version,
          sessionId: derived.sessionId,
          runId: derived.runId,
          modelRequests: derived.modelRequests,
          turns: derived.turns,
          injectedChars: derived.injectedChars,
          reportChars: derived.reportChars,
          gatePassRate: derived.gatePassRate,
          costPerDeliveredItem: derived.costPerDeliveredItem,
        },
        null,
        2,
      ) + String.fromCharCode(10),
      "utf8",
    );
    return true;
  } catch (error) {
    throw error;
  }
}

/**
 * 进程内 cost meter writer。
 * - recordAdd：计数增量（模型 request、注入 chars、report chars）；
 * - recordMax：取最大值（turns 镜像——每个用户轮只在 meter 里存一次最大值）；
 * - flush：立即落全部脏 key；writer 卸载前由插件 effect 调用。
 * 所有磁盘错误由 writer 捕获并交给 logger.warn；绝不向调用方抛。
 */
export function createCostMeterWriter({ directory, logger, debounceMs = 250 } = {}) {
  const dir = typeof directory === "string" && directory.trim().length > 0
    ? directory.trim()
    : defaultCostMeterDirectory();
  const log = logger ?? null;
  const meters = new Map();
  const dirtyKeys = new Set();
  let timer = null;

  function warn(message, error) {
    try {
      log?.warn?.(message + (error instanceof Error ? `：${error.message}` : `：${String(error)}`));
    } catch {
      // warn 自身失败也不影响主流程
    }
  }

  function keyOf(sessionId, runId) {
    return `${String(sessionId)}\u0000${safeRunId(runId)}`;
  }

  function ensureRecord(sessionId, runId) {
    const key = keyOf(sessionId, runId);
    let record = meters.get(key);
    if (record === undefined) {
      const file = costMeterFileFor(dir, sessionId, runId);
      const raw = readCostMeterFile(file);
      record = normalizeCostMeter(raw, sessionId, runId);
      meters.set(key, record);
    }
    return { key, record };
  }

  function schedule(key) {
    dirtyKeys.add(key);
    if (timer !== null) return;
    const delay = Number.isFinite(Number(debounceMs)) && Number(debounceMs) >= 0
      ? Number(debounceMs)
      : 250;
    timer = setTimeout(() => {
      timer = null;
      flushNow();
    }, delay);
  }

  function flushNow() {
    const keys = [...dirtyKeys];
    dirtyKeys.clear();
    for (const key of keys) {
      const record = meters.get(key);
      if (record === undefined) continue;
      const [sessionId, runIdText] = key.split("\u0000");
      const file = costMeterFileFor(dir, sessionId, Number(runIdText));
      try {
        writeCostMeterFile(file, record);
      } catch (error) {
        warn(`[ka-whale-workflow] cost-meter 落盘失败 (${file})`, error);
      }
    }
  }

  return {
    directory: dir,
    fileFor: (sessionId, runId) => costMeterFileFor(dir, sessionId, runId),
    /** 内存增量合并；磁盘失败只 warn。返回 false 仅当 key 非法。 */
    recordAdd(sessionId, runId, patch) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return false;
      const { key, record } = ensureRecord(sessionId, runId);
      for (const [field, value] of Object.entries(patch ?? {})) {
        if (!(field in record)) continue;
        const amount = nonNegativeNumber(value);
        if (amount <= 0) continue;
        if (field === "gatePassRate" || field === "costPerDeliveredItem") {
          record[field] = amount;
        } else {
          record[field] = Math.floor(record[field] + amount);
        }
      }
      schedule(key);
      return true;
    },
    /** 取最大值合并（turns 用）。 */
    recordMax(sessionId, runId, patch) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return false;
      const { key, record } = ensureRecord(sessionId, runId);
      for (const [field, value] of Object.entries(patch ?? {})) {
        if (!(field in record)) continue;
        const candidate = nonNegativeNumber(value);
        if (candidate > record[field]) record[field] = Math.floor(candidate);
      }
      schedule(key);
      return true;
    },
    /** 立即落盘所有脏 key（探针/卸载用）。 */
    flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      flushNow();
    },
    /** 读取当前内存/落盘聚合（读盘只发生在首个 key 或显式 read）。 */
    read(sessionId, runId) {
      const file = costMeterFileFor(dir, sessionId, runId);
      const raw = readCostMeterFile(file);
      return normalizeCostMeter(raw, sessionId, runId);
    },
  };
}
