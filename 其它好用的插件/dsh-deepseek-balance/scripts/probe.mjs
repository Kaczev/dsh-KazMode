/**
 * Host-half probe: proves the pieces the widget depends on actually work.
 *
 *   node scripts/probe.mjs
 *
 * It resolves the API key exactly as the plugin does, performs one real
 * upstream read, then drives the registered route handler through fake
 * request/response objects — including the cache-coalescing path.
 */

import { BALANCE_PATH, BalanceCache, STATS_PATH, apply, queryBalance, resolveApiKey } from '../lib/index.js'

const fakeContext = {
  get: () => undefined,
  logger: { debug: () => {}, warn: () => {} },
  effect: (factory) => {
    const dispose = factory()
    return () => dispose?.()
  },
}

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// 1. key resolution
const { key, source } = await resolveApiKey(fakeContext, {})
record('resolveApiKey', key !== '', `source=${source} length=${key.length}`)

// 2. one real upstream read
if (key !== '') {
  const read = await queryBalance(key)
  if (read.ok === true) {
    const first = read.balanceInfos[0]
    record('queryBalance', true, `available=${read.isAvailable} infos=${read.balanceInfos.length} first=${JSON.stringify(first)}`)
  } else {
    record('queryBalance', false, `${read.error}: ${read.message}`)
  }
}

// 3. the route handler, through a fake req/res
const routes = new Map()
const routeContext = {
  ...fakeContext,
  webServer: {
    register: (route) => {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
}
apply(routeContext, { cacheTtlMs: 5_000 })
record('apply() registered the balance route', routes.has(BALANCE_PATH),
  [...routes.keys()].join(', '))
record('apply() registered the stats route', routes.has(STATS_PATH), STATS_PATH)

function invoke(method = 'GET', path = BALANCE_PATH) {
  return new Promise((resolve) => {
    const headers = {}
    const res = {
      statusCode: 0,
      writeHead(status, extra) {
        this.statusCode = status
        Object.assign(headers, extra)
      },
      end(body) {
        let parsed
        try {
          parsed = body === undefined ? undefined : JSON.parse(body)
        } catch (error) {
          parsed = { parseError: String(error) }
        }
        resolve({ status: this.statusCode, headers, body: parsed })
      },
    }
    const route = routes.get(path)
    if (route === undefined) {
      resolve({ status: 0, headers, body: { error: `no route at ${path}` } })
      return
    }
    void route.handler({ method, url: path, headers: {} }, res)
  })
}

const first = await invoke()
record('GET /balance', first.status === 200 && first.body?.ok === true,
  `status=${first.status} ok=${first.body?.ok} stale=${first.body?.stale} threshold=${first.body?.lowBalanceThreshold}`)

const second = await invoke()
record('cached second read', second.body?.ok === true && second.body?.stale === false,
  `fetchedAt equal=${first.body?.fetchedAt === second.body?.fetchedAt}`)

const head = await invoke('HEAD')
record('HEAD /balance', head.status === 200, `status=${head.status}`)

const post = await invoke('POST')
record('POST rejected', post.status === 405, `status=${post.status}`)

const stats = await invoke('GET', STATS_PATH)
record('GET /stats counts what the widget did', stats.status === 200 && stats.body?.served === 2,
  `served=${stats.body?.served} (the two GETs above) upstreamReads=${stats.body?.upstreamReads} cached=${stats.body?.cachedBalance} ${stats.body?.cachedCurrency}`)
record('GET /stats never leaks the key', stats.body?.keySource?.startsWith('credential') === true
  || stats.body?.keySource === 'credentials-file' || stats.body?.keySource === 'env:DEEPSEEK_API_KEY',
  `keySource=${stats.body?.keySource}`)

// 4. cache behaviour in isolation: coalescing + stale grace
let calls = 0
const cache = new BalanceCache({
  ttlMs: 0,
  staleGraceMs: 60_000,
  readKey: async () => ({ key: 'sk-probe', source: 'probe' }),
  query: async () => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 25))
    return { ok: true, isAvailable: true, balanceInfos: [{ currency: 'CNY', totalBalance: '1.00', grantedBalance: '0', toppedUpBalance: '1.00' }] }
  },
})
const coalesced = await Promise.all([cache.read(), cache.read(), cache.read(), cache.read()])
record('in-flight coalescing', calls === 1 && coalesced.every((item) => item.ok === true), `upstream calls=${calls}`)

// One good reading must survive a later upstream failure inside the grace window.
let healthy = true
const failing = new BalanceCache({
  ttlMs: 0,
  staleGraceMs: 60_000,
  readKey: async () => ({ key: 'sk-probe', source: 'probe' }),
  query: async () => (healthy
    ? { ok: true, isAvailable: true, balanceInfos: [{ currency: 'CNY', totalBalance: '9.99', grantedBalance: '0', toppedUpBalance: '9.99' }] }
    : { ok: false, error: 'request-failed', message: 'network down' }),
})
const healthyBody = await failing.read()
healthy = false
const staleBody = await failing.read()
record('stale grace keeps serving', healthyBody.ok === true && staleBody.ok === true && staleBody.stale === true,
  `first=${healthyBody.ok} then ok=${staleBody.ok} stale=${staleBody.stale} balance=${staleBody.balanceInfos?.[0]?.totalBalance}`)

// Past the grace window the failure must surface instead of lying.
const expired = new BalanceCache({
  ttlMs: 20,
  staleGraceMs: 0,
  readKey: async () => ({ key: 'sk-probe', source: 'probe' }),
  query: async () => (healthy
    ? { ok: true, isAvailable: true, balanceInfos: [] }
    : { ok: false, error: 'request-failed', message: 'network down' }),
})
healthy = true
await expired.read()
await new Promise((resolve) => setTimeout(resolve, 40))
healthy = false
const expiredBody = await expired.read()
record('expired cache reports failure', expiredBody.ok === false && expiredBody.error === 'request-failed',
  `ok=${expiredBody.ok} error=${expiredBody.error}`)

const noKey = new BalanceCache({
  ttlMs: 0,
  readKey: async () => ({ key: '', source: 'none' }),
})
const noKeyBody = await noKey.read()
record('missing key reported', noKeyBody.ok === false && noKeyBody.error === 'no-api-key', noKeyBody.error)

const failures = results.filter((item) => !item.ok)
console.log(`\n${results.length - failures.length}/${results.length} checks passed`)
process.exitCode = failures.length === 0 ? 0 : 1
