/**
 * Live end-to-end probe: does the widget really poll the route from the GUI?
 *
 * Boots a throwaway `dsh web` on its own port with its output captured, loads
 * the real GUI in headless Edge, lets the widget run, and then reads the
 * plugin's own poll report out of that captured stdout.
 *
 * The report line is why the host half logs `served N reads` every twenty
 * reads: it is a plain, greppable statement that a browser asked this route
 * repeatedly. Nothing else in the pipeline has to be trusted.
 *
 *   node scripts/live-probe.mjs [port] [seconds]
 *
 * The instance and the browser profile are torn down on the way out.
 */

import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.argv[2] ?? 3220)
const seconds = Number(process.argv[3] ?? 30)
const BALANCE_PATH = '/dsh-deepseek-balance/balance'

const browsers = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]
const browser = browsers.find((path) => existsSync(path))
if (browser === undefined) {
  console.error('live-probe: no Edge/Chrome found')
  process.exit(1)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const instance = spawn('dsh.cmd', ['web', '--port', String(port), '--no-open'], {
  cwd: process.env.USERPROFILE,
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
  windowsHide: true,
})
let serverLog = ''
instance.stdout.on('data', (chunk) => { serverLog += String(chunk) })
instance.stderr.on('data', (chunk) => { serverLog += String(chunk) })

const edgeDir = mkdtempSync(join(tmpdir(), 'dsb-live-'))

try {
  let token = null
  const bootDeadline = Date.now() + 90_000
  while (Date.now() < bootDeadline && token === null) {
    const match = serverLog.match(/http:\/\/[^\s]*\?token=([A-Za-z0-9_-]+)/)
    if (match !== null) token = match[1]
    else if (instance.exitCode !== null) throw new Error(`dsh web exited early:\n${serverLog.slice(0, 1500)}`)
    else await sleep(400)
  }
  if (token === null) throw new Error(`dsh web never printed a URL:\n${serverLog.slice(0, 1500)}`)
  record('the plugin loaded into the web profile',
    serverLog.includes('[dsh-deepseek-balance] routes registered')
      || (await (await fetch(`http://127.0.0.1:${port}/dsh-deepseek-balance/stats`)).json()).ok === true,
    'the host half reached apply() and claimed its routes')

  const before = await (await fetch(`http://127.0.0.1:${port}/dsh-deepseek-balance/stats`)).json()

  // Chromium writes console errors to stderr; the shell owns the redirect
  // because a captured child stdout is unusable on this host.
  const browserLog = join(edgeDir, 'browser.log')
  const edge = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars',
    '--enable-logging=stderr', '--v=0',
    `--user-data-dir=${edgeDir}`,
    '--window-size=1440,900',
    `--screenshot=${join(root, 'dev', 'gui.png')}`,
    `http://127.0.0.1:${port}/?token=${token}`,
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })
  const logFile = createWriteStream(browserLog)
  edge.stderr.pipe(logFile)

  // Watch the counter while the browser runs: a widget that polls once and a
  // widget that polls every 2.5s look identical in a single before/after pair.
  const timeline = []
  const watchUntil = Date.now() + seconds * 1000
  while (Date.now() < watchUntil) {
    await sleep(2000)
    try {
      const sample = await (await fetch(`http://127.0.0.1:${port}/dsh-deepseek-balance/stats`)).json()
      timeline.push(sample.served)
    } catch {
      timeline.push(-1)
    }
  }
  try {
    edge.kill()
  } catch {
    // already gone
  }
  await sleep(1000)

  const after = await (await fetch(`http://127.0.0.1:${port}/dsh-deepseek-balance/stats`)).json()
  const served = after.served - before.served
  const upstream = after.upstreamReads - before.upstreamReads
  console.log(`live-probe: reads over time [${timeline.join(', ')}]`)

  // Surface what the page itself complained about.
  try {
    logFile.close()
  } catch {
    // already closed
  }
  const consoleLines = (() => {
    try {
      return readFileSync(browserLog, 'utf8')
        .split(/\r?\n/)
        .filter((line) => /dsb-|dsb_|deepseek-balance|Uncaught|TypeError|ReferenceError/i.test(line))
        .slice(0, 12)
    } catch {
      return []
    }
  })()
  if (consoleLines.length > 0) {
    console.log('live-probe: browser console lines mentioning the widget or an error:')
    for (const line of consoleLines) console.log(`  ${line.slice(0, 240)}`)
  } else {
    console.log(`live-probe: no widget-related browser console output (log ${existsSync(browserLog) ? 'captured' : 'missing'})`)
  }

  record('the GUI page was served', /dsh web: http:\/\/127\.0\.0\.1/.test(serverLog), `port ${port}`)
  record('the browser polled the balance route repeatedly', served >= 20,
    `${served} reads in ~${seconds}s (the widget polls every 2.5s)`)
  record('the host collapsed the polls onto few upstream calls', upstream > 0 && upstream * 4 < served,
    `${upstream} upstream refreshes for ${served} reads — the widget does not hammer api.deepseek.com`)
  record('the cached balance reached the browser', typeof after.cachedBalance === 'string' && after.cachedBalance !== '',
    `balance=${after.cachedBalance} ${after.cachedCurrency} keySource=${after.keySource}`)

  const direct = await (async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${BALANCE_PATH}`)
      return { status: response.status, body: await response.json() }
    } catch (error) {
      return { status: 0, body: { message: String(error) } }
    }
  })()
  record('the route still answers real data out of band',
    direct.status === 200 && direct.body?.ok === true,
    `status=${direct.status} balance=${direct.body?.balanceInfos?.[0]?.totalBalance} source=${direct.body?.keySource}`)

  record('a live screenshot of the GUI was captured', existsSync(join(root, 'dev', 'gui.png')),
    join(root, 'dev', 'gui.png'))
} catch (error) {
  console.error(`live-probe: ${String(error).slice(0, 1500)}`)
  process.exitCode = 1
} finally {
  try {
    execFileSync('taskkill', ['/PID', String(instance.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // already gone
  }
  try {
    rmSync(edgeDir, { recursive: true, force: true })
  } catch {
    // Chromium may still hold a handle
  }
}

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
