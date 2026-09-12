/**
 * dsh-balance — host (Node) half.
 *
 * Responsibilities:
 *   1. Resolve the DeepSeek API key without ever sending it to the browser:
 *      plugin config → `ctx.credentials` (the DSH credential seam) →
 *      `DEEPSEEK_API_KEY` in the launching environment → `~/.dsh/.credentials.yaml`.
 *   2. Keep ONE cached, coalesced upstream reading so the widget can poll hard
 *      for near-real-time feedback without hammering `api.deepseek.com`.
 *   3. Expose that cache on a single local JSON route.
 *
 * The browser only ever sees local JSON: no key, no upstream call.
 *
 * @module dsh-balance
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'deepseek-balance'
export const inject = ['webServer']

/** Prefix of every route this plugin owns. */
export const ROUTE_PREFIX = '/dsh-balance'
/** The single JSON endpoint the widget polls. */
export const BALANCE_PATH = `${ROUTE_PREFIX}/balance`
/** Read-only counters, for diagnosing a widget that is not updating. */
export const STATS_PATH = `${ROUTE_PREFIX}/stats`

const UPSTREAM = 'https://api.deepseek.com/user/balance'
const REQUEST_TIMEOUT_MS = 10_000
/** Serve the cache without touching the network while it is this fresh. */
const DEFAULT_CACHE_TTL_MS = 8_000
/** How long a stale cache keeps answering after upstream failures. */
const DEFAULT_STALE_GRACE_MS = 120_000
/** Below this balance the widget switches to its low-balance warning look. */
const DEFAULT_LOW_BALANCE_THRESHOLD = 10

/**
 * Cordis plugin config.
 *
 * @typedef {object} BalanceConfig
 * @property {string} [apiKey]      - literal key (highest priority; avoid on shared machines)
 * @property {string} [apiKeyEnv]   - credential/env reference name, default `DEEPSEEK_API_KEY`
 * @property {number} [cacheTtlMs]  - upstream cache freshness window
 * @property {number} [staleGraceMs]- how long a failed refresh may serve the last good reading
 * @property {number} [lowBalanceThreshold] - warning threshold in the balance currency
 */

//#region credentials

/** The credentials file DSH's own local provider writes. */
function credentialsFile() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, '.credentials.yaml')
}

/**
 * Minimal YAML scalar reader — enough for `DEEPSEEK_API_KEY: sk-...` inside the
 * credentials file, without taking a YAML dependency.
 *
 * @param {string} text - raw file text.
 * @param {string} wanted - the top-level key to read.
 * @returns {string} the value, or an empty string when absent.
 */
function readYamlScalar(text, wanted) {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    // Only top-level keys: a nested `refs:` block is indented.
    if (/^\s/.test(rawLine)) continue
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/)
    if (match === null || match[1] !== wanted) continue
    let value = match[2].trim()
    if (!value.startsWith('"') && !value.startsWith("'")) {
      value = value.replace(/\s+#.*$/, '').trim()
    }
    if (value.length >= 2) {
      const quote = value[0]
      if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
        value = value.slice(1, -1)
      }
    }
    return value
  }
  // `refs:`-style nested block: accept a one-level indented match as a fallback.
  for (const rawLine of text.split(/\r?\n/)) {
    const match = rawLine.match(/^\s+([A-Za-z0-9_.-]+)\s*:\s*(\S.*)$/)
    if (match === null || match[1] !== wanted) continue
    const value = match[2].trim().replace(/\s+#.*$/, '').trim()
    if (value.startsWith('sk-') || value.length >= 8) return value
  }
  return ''
}

/**
 * Resolve the API key from every available source.
 *
 * The credential seam is consulted first when the composed host exposes it, so
 * a key edited on the DSH Models page is picked up without a restart.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {BalanceConfig} config - plugin config.
 * @returns {Promise<{ key: string, source: string }>} key plus a display-only source label.
 */
export async function resolveApiKey(ctx, config = {}) {
  if (typeof config.apiKey === 'string' && config.apiKey.trim() !== '') {
    return { key: config.apiKey.trim(), source: 'config' }
  }

  const refName = typeof config.apiKeyEnv === 'string' && config.apiKeyEnv.trim() !== ''
    ? config.apiKeyEnv.trim()
    : 'DEEPSEEK_API_KEY'

  const credentials = ctx.get?.('credentials')
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    try {
      const resolved = await credentials.resolve(refName)
      const value = resolved?.value
      if (typeof value === 'string' && value.trim() !== '') {
        return { key: value.trim(), source: `credential:${refName}` }
      }
    } catch {
      // Seam present but unhappy (unknown reference, storage error): fall through.
    }
  }

  const fromEnv = process.env[refName]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return { key: fromEnv.trim(), source: `env:${refName}` }
  }

  try {
    const key = readYamlScalar(readFileSync(credentialsFile(), 'utf8'), refName)
    if (key !== '') return { key, source: 'credentials-file' }
  } catch {
    // Missing or unreadable file: reported by the caller as "no key".
  }

  return { key: '', source: 'none' }
}

//#endregion

//#region upstream

/** Coerce anything the API may send into a plain display string. */
function asText(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/**
 * Reduce the DeepSeek payload to the exact fields the widget renders, dropping
 * anything unexpected instead of forwarding the raw body.
 *
 * @param {unknown} payload - parsed `/user/balance` response.
 * @returns {{ isAvailable: boolean, balanceInfos: Array<{currency: string, totalBalance: string, grantedBalance: string, toppedUpBalance: string}> }}
 */
export function sanitizeBalance(payload) {
  const source = payload !== null && typeof payload === 'object' ? payload : {}
  const infos = Array.isArray(source.balance_infos) ? source.balance_infos : []
  return {
    isAvailable: source.is_available === true,
    balanceInfos: infos
      .filter((item) => item !== null && typeof item === 'object')
      .map((item) => ({
        currency: asText(item.currency),
        totalBalance: asText(item.total_balance),
        grantedBalance: asText(item.granted_balance),
        toppedUpBalance: asText(item.topped_up_balance),
      })),
  }
}

/**
 * One upstream reading.
 *
 * @param {string} apiKey - DeepSeek API key.
 * @param {typeof globalThis.fetch} [fetchImpl] - injectable for probes/tests.
 * @returns {Promise<{ok: true, isAvailable: boolean, balanceInfos: object[]} | {ok: false, error: string, status?: number, message: string}>}
 */
export async function queryBalance(apiKey, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') {
    return { ok: false, error: 'no-fetch', message: 'Node 运行时没有可用的 fetch()' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetchImpl(UPSTREAM, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      let detail = ''
      try {
        detail = (await response.text()).slice(0, 300)
      } catch {
        // body unreadable — status alone is enough
      }
      return {
        ok: false,
        error: 'http-error',
        status: response.status,
        message: `api.deepseek.com 返回 ${response.status}${detail === '' ? '' : `：${detail}`}`,
      }
    }
    return { ok: true, ...sanitizeBalance(await response.json()) }
  } catch (error) {
    return {
      ok: false,
      error: 'request-failed',
      message: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timer)
  }
}

//#endregion

//#region cache

/**
 * Cache + in-flight coalescing around the upstream reading.
 *
 * Pollers never queue up: within the TTL every caller shares one reading, and
 * concurrent refreshes await the same promise.
 */
export class BalanceCache {
  /**
   * @param {object} options - cache tuning.
   * @param {number} [options.ttlMs] - freshness window.
   * @param {number} [options.staleGraceMs] - how long a failed refresh serves the last reading.
   * @param {() => Promise<{key: string, source: string}>} options.readKey - key resolver.
   * @param {typeof queryBalance} [options.query] - upstream caller (injectable).
   * @param {() => number} [options.now] - clock (injectable).
   */
  constructor({ ttlMs, staleGraceMs, readKey, query = queryBalance, now = Date.now }) {
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : DEFAULT_CACHE_TTL_MS
    this.staleGraceMs = Number.isFinite(staleGraceMs) && staleGraceMs >= 0
      ? staleGraceMs
      : DEFAULT_STALE_GRACE_MS
    this.readKey = readKey
    this.query = query
    this.now = now
    /** @type {{ok: true, isAvailable: boolean, balanceInfos: object[], fetchedAt: number, keySource: string} | null} */
    this.good = null
    /** @type {{ok: false, error: string, message: string, status?: number} | null} */
    this.failure = null
    /** @type {Promise<unknown> | null} */
    this.inflight = null
  }

  /** @returns {boolean} whether the cached reading is still fresh. */
  isFresh() {
    return this.good !== null && this.now() - this.good.fetchedAt < this.ttlMs
  }

  /**
   * Read through the cache. Never recurses: each call performs at most one
   * upstream refresh, so a zero TTL cannot spin.
   *
   * @returns {Promise<object>} the wire payload for the route.
   */
  async read() {
    if (this.isFresh()) return this.payload(this.good, false)
    let stale = false
    if (this.inflight !== null) {
      // A refresh is already running: share it instead of queueing another.
      try {
        await this.inflight
      } catch {
        stale = true
      }
      return this.payload(this.good, stale)
    }
    this.inflight = this.refresh()
    try {
      await this.inflight
    } catch (error) {
      stale = true
      this.failure = {
        ok: false,
        error: 'internal',
        message: error instanceof Error ? error.message : String(error),
      }
    } finally {
      this.inflight = null
    }
    // A refresh ran and the cache is still not fresh: say so, so a reading that
    // could not be renewed is never presented as current.
    return this.payload(this.good, stale || !this.isFresh())
  }

  /** Perform one real refresh and fold the outcome into the cache. */
  async refresh() {
    const { key, source } = await this.readKey()
    if (key === '') {
      this.failure = {
        ok: false,
        error: 'no-api-key',
        message: '未找到 DeepSeek API Key：可在 web profile 的 cordis.patch.yml 里给本插件加 config.apiKey，'
          + '或设置环境变量 DEEPSEEK_API_KEY，或写进 ~/.dsh/.credentials.yaml。',
      }
      return
    }
    const result = await this.query(key)
    if (result.ok === true) {
      this.good = {
        ok: true,
        isAvailable: result.isAvailable,
        balanceInfos: result.balanceInfos,
        fetchedAt: this.now(),
        keySource: source,
      }
      this.failure = null
      return
    }
    this.failure = { ok: false, error: result.error, status: result.status, message: result.message }
  }

  /**
   * Shape the wire payload. A failed refresh inside the stale grace window
   * still answers with the last good reading, flagged `stale`, so a blip in
   * the upstream never blanks the widget.
   *
   * @param {object | null} good - last successful reading.
   * @param {boolean} stale - whether the caller knows the refresh failed.
   * @returns {object} JSON body.
   */
  payload(good, stale) {
    const now = this.now()
    if (good !== null) {
      const age = now - good.fetchedAt
      const withinGrace = age <= this.staleGraceMs
      if (stale && !withinGrace) {
        return {
          ok: false,
          error: this.failure?.error ?? 'stale',
          message: this.failure?.message ?? '余额数据已过期，且最近一次刷新失败。',
          fetchedAt: good.fetchedAt,
        }
      }
      return {
        ok: true,
        isAvailable: good.isAvailable,
        balanceInfos: good.balanceInfos,
        keySource: good.keySource,
        fetchedAt: good.fetchedAt,
        servedAt: now,
        stale: stale || age >= this.ttlMs,
      }
    }
    const failure = this.failure ?? { ok: false, error: 'unknown', message: '余额暂不可用。' }
    return { ok: false, error: failure.error, status: failure.status, message: failure.message }
  }
}

//#endregion

//#region route

/**
 * Write one JSON response.
 *
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {object} body - JSON body.
 * @param {Record<string, string>} [extra] - extra headers.
 */
function json(res, status, body, extra = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extra,
  })
  res.end(JSON.stringify(body))
}

/**
 * Plugin body: build the cache and register the one route it serves.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {BalanceConfig} [config] - plugin config.
 */
export function apply(ctx, config = {}) {
  const cache = new BalanceCache({
    ttlMs: config.cacheTtlMs,
    staleGraceMs: config.staleGraceMs,
    readKey: () => resolveApiKey(ctx, config),
  })

  const threshold = Number.isFinite(config.lowBalanceThreshold) && config.lowBalanceThreshold >= 0
    ? config.lowBalanceThreshold
    : DEFAULT_LOW_BALANCE_THRESHOLD

  // Counters behind `/stats`: a widget that never updates is almost always a
  // widget whose polls never arrive, and this is how that gets told apart from
  // a widget that polls and fails to render.
  let served = 0
  let upstreamReads = 0
  const startedAt = Date.now()

  ctx.effect(() => {
    const disposeBalance = ctx.webServer.register({
      kind: 'exact',
      path: BALANCE_PATH,
      handler: async (req, res) => {
        try {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            json(res, 405, { ok: false, error: 'method-not-allowed', message: '仅支持 GET' }, { allow: 'GET' })
            return
          }
          if (req.method === 'HEAD') {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end()
            return
          }
          const before = cache.good?.fetchedAt
          const body = await cache.read()
          if (cache.good?.fetchedAt !== before) upstreamReads += 1
          served += 1
          json(res, 200, { ...body, lowBalanceThreshold: threshold, currencyDefault: 'CNY' })
        } catch (error) {
          json(res, 500, {
            ok: false,
            error: 'internal',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      },
    })

    const disposeStats = ctx.webServer.register({
      kind: 'exact',
      path: STATS_PATH,
      handler: (req, res) => {
        json(res, 200, {
          ok: true,
          served,
          upstreamReads,
          cacheTtlMs: cache.ttlMs,
          staleGraceMs: cache.staleGraceMs,
          lowBalanceThreshold: threshold,
          cachedBalance: cache.good?.balanceInfos?.[0]?.totalBalance ?? null,
          cachedCurrency: cache.good?.balanceInfos?.[0]?.currency ?? null,
          cachedAt: cache.good?.fetchedAt ?? null,
          keySource: cache.good?.keySource ?? null,
          uptimeMs: Date.now() - startedAt,
        })
      },
    })

    ctx.logger?.info?.(`[dsh-balance] routes registered: ${BALANCE_PATH}, ${STATS_PATH}`)
    return () => {
      if (typeof disposeBalance === 'function') disposeBalance()
      if (typeof disposeStats === 'function') disposeStats()
    }
  }, 'dsh-balance: routes')
}

//#endregion
