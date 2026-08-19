/**
 * dsh-deepseek-balance — Node half.
 *
 * Host-side responsibilities:
 *   - read the DeepSeek API key from `DEEPSEEK_API_KEY` or `~/.dsh/.credentials.yaml`
 *   - expose one local JSON route `/dsh-deepseek-balance/balance`
 *   - call DeepSeek `/user/balance` on the server, so the browser never sees the API key
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'deepseek-balance'
export const inject = ['webServer']

export const ROUTE_PREFIX = '/dsh-deepseek-balance'
export const BALANCE_PATH = `${ROUTE_PREFIX}/balance`

const DEEPSEEK_BALANCE_API = 'https://api.deepseek.com/user/balance'
const REQUEST_TIMEOUT_MS = 10000

function credentialsFile() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.credentials.yaml')
}

/** Minimal YAML scalar reader: enough for `DEEPSEEK_API_KEY: sk-...`. */
function readYamlScalar(text, wanted) {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/)
    if (match === null || match[1] !== wanted) continue
    let value = match[2].trim()
    // strip trailing YAML comment when the value has no quoted spaces
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
  return ''
}

/** Resolve the API key: plugin config > environment > ~/.dsh/.credentials.yaml. */
export function readApiKey(config = {}) {
  if (typeof config.apiKey === 'string' && config.apiKey.trim() !== '') {
    return config.apiKey.trim()
  }
  if (typeof process.env.DEEPSEEK_API_KEY === 'string' && process.env.DEEPSEEK_API_KEY.trim() !== '') {
    return process.env.DEEPSEEK_API_KEY.trim()
  }
  try {
    const text = readFileSync(credentialsFile(), 'utf8')
    const key = readYamlScalar(text, 'DEEPSEEK_API_KEY')
    if (key !== '') return key
  } catch {
    // file missing/unreadable — handled by caller
  }
  return ''
}

function json(res, status, body, extra = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extra,
  })
  res.end(JSON.stringify(body))
}

function sanitizeBalance(payload) {
  const infos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : []
  return {
    isAvailable: payload?.is_available === true,
    balanceInfos: infos
      .filter((item) => item !== null && typeof item === 'object')
      .map((item) => ({
        currency: typeof item.currency === 'string' ? item.currency : '',
        totalBalance: typeof item.total_balance === 'string' ? item.total_balance : String(item.total_balance ?? ''),
        grantedBalance: typeof item.granted_balance === 'string' ? item.granted_balance : String(item.granted_balance ?? ''),
        toppedUpBalance: typeof item.topped_up_balance === 'string' ? item.topped_up_balance : String(item.topped_up_balance ?? ''),
      })),
  }
}

async function queryBalance(apiKey) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(DEEPSEEK_BALANCE_API, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    })
    if (!response.ok) {
      let detail = ''
      try {
        const raw = await response.text()
        detail = raw.slice(0, 300)
      } catch {
        // ignore body read failure
      }
      return {
        ok: false,
        error: 'http-error',
        status: response.status,
        message: `DeepSeek API 返回 ${response.status}${detail ? `：${detail}` : ''}`,
      }
    }
    const payload = await response.json()
    return { ok: true, ...sanitizeBalance(payload), fetchedAt: Date.now() }
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

export function apply(ctx, config = {}) {
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (webServer === undefined) {
    ctx.logger?.warn?.('[dsh-deepseek-balance] webServer 不可用，无法注册余额路由')
    return
  }

  ctx.effect(() => {
    const dispose = webServer.register({
      kind: 'exact',
      path: BALANCE_PATH,
      handler: async (req, res) => {
        try {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            json(res, 405, { ok: false, error: 'method-not-allowed', message: '仅支持 GET' }, { allow: 'GET' })
            return
          }
          const apiKey = readApiKey(config)
          if (apiKey === '') {
            json(res, 200, {
              ok: false,
              error: 'no-api-key',
              message: '未配置 DeepSeek API Key：请设置 DEEPSEEK_API_KEY 或在 ~/.dsh/.credentials.yaml 中填写 DEEPSEEK_API_KEY。',
            })
            return
          }
          const result = await queryBalance(apiKey)
          if (req.method === 'HEAD') {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end()
            return
          }
          json(res, 200, result)
        } catch (error) {
          json(res, 500, {
            ok: false,
            error: 'internal',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      },
    })
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  }, 'dsh-deepseek-balance: balance route')
}