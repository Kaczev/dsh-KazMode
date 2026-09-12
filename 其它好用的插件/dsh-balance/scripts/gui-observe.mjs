/**
 * End-to-end probe: watch the widget from inside the browser.
 *
 * The DevTools socket never answers for the DSH app page on this host, so this
 * serves the real `index.html` through a local proxy with one extra script that
 * wraps `fetch`, watches the widget, and POSTs its findings back. The verdict
 * therefore comes from the running application, not from a test double.
 *
 * It checks the four things that make the widget a widget:
 *   1. the browser really asked the balance route, repeatedly;
 *   2. those requests were answered 200 with a full body;
 *   3. the visible digits (read by inverting the reel transforms) match the
 *      balance the route reports;
 *   4. history accumulates in localStorage, so the chart has something to draw.
 *
 *   node scripts/observe-probe.mjs [port] [seconds]
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = Number(process.argv[2] ?? 3270)
const seconds = Number(process.argv[3] ?? 20)
const BALANCE_PATH = '/dsh-balance/balance'

const browsers = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
]
const browser = browsers.find((path) => existsSync(path))
if (browser === undefined) {
  console.error('observe-probe: no browser found')
  process.exit(1)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` 鈥?${detail}`}`)
}

let latest = null
/** The app's access token, needed to keep its redirects usable. */
let accessToken = ''

/** Keep the newest observation; the verdict is made once, after the run. */
function collect(payload) {
  latest = payload
}

/**
 * Injected before the app: records every fetch to the balance route, watches
 * the widget's text, and ships the whole story back in one POST.
 */
const OBSERVER = `<script>
(function () {
  var events = [];
  var fetches = [];
  var started = Date.now();
  var original = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var record = { at: Date.now() - started, url: String(url).slice(0, 120), status: 0, error: null, bodyBytes: 0 };
    if (String(url).indexOf('/dsh-balance/') === 0) fetches.push(record);
    var promise;
    try {
      promise = original.apply(this, arguments);
    } catch (error) {
      record.error = String(error && error.message ? error.message : error);
      throw error;
    }
    if (record.url.indexOf('/dsh-balance/') === 0) {
      promise.then(function (response) {
        record.status = response.status;
        response.clone().text().then(function (text) { record.bodyBytes = text.length; }).catch(function () {});
      }, function (error) {
        record.error = String(error && error.message ? error.message : error);
      });
    }
    return promise;
  };
  window.addEventListener('error', function (event) {
    events.push({ at: Date.now() - started, kind: 'error', text: String(event.message).slice(0, 200) });
  });
  window.addEventListener('unhandledrejection', function (event) {
    events.push({ at: Date.now() - started, kind: 'rejection', text: String(event.reason && event.reason.message ? event.reason.message : event.reason).slice(0, 200) });
  });
  var samples = [];
  var GLYPHS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '鈥?];
  var visibleAmount = function () {
    // Every strip carries all ten glyphs, so the DOM text says nothing about
    // what is on screen: invert the strip transform instead.
    var out = '';
    var strips = document.querySelectorAll('.dsb-reel-inner');
    for (var index = 0; index < strips.length; index += 1) {
      var matrix = getComputedStyle(strips[index]).transform;
      var match = /matrix\\(1, 0, 0, 1, 0, (-?[\\d.]+)\\)/.exec(matrix);
      var offset = match === null ? 0 : Math.abs(Number(match[1]));
      out += GLYPHS[Math.round(offset / 30) % GLYPHS.length];
    }
    // The separators live as plain text, so read them from the value row.
    var row = document.querySelector('.dsb-value');
    var currency = document.querySelector('.dsb-currency');
    return {
      digits: out,
      rowText: row ? (row.innerText || '').replace(/\\s+/g, ' ').slice(0, 30) : null,
      currency: currency ? currency.textContent : null,
    };
  };
  var timer = setInterval(function () {
    var root = document.querySelector('.dsb-root');
    samples.push({
      at: Date.now() - started,
      widgets: document.querySelectorAll('.dsb-root').length,
      reels: document.querySelectorAll('.dsb-reel').length,
      visible: visibleAmount(),
      status: root ? root.getAttribute('data-low') : null,
      stored: (function () { try { var raw = localStorage.getItem('dsh-balance:v2'); return raw ? (JSON.parse(raw).samples || []).length : -1; } catch (error) { return -2; } })(),
    });
  }, 1000);
  setInterval(function () {
    original.call(window, '/__observe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fetches: fetches, events: events, samples: samples.slice(-8), intervalTicks: samples.length }),
    }).catch(function () {});
  }, 4000);
})();
</script>`

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/__observe') {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      collect(payload)
      res.writeHead(204).end()
    })
    return
  }

  // Everything else is the real app, with the observer prepended.
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const body = ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : Buffer.concat(chunks)
    // A raw http request, not fetch: fetch would follow the app's own redirect
    // and drop the access token that lives in the query string.
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: port + 1,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `127.0.0.1:${port + 1}` },
    }, (upstreamRes) => {
      const headers = { ...upstreamRes.headers }
      // A redirect must carry a *single* valid token: appending one to a
      // Location that already has one produces `?token=&token=`, and the app
      // answers 401 — so replace rather than append.
      const location = headers.location
      if (location !== undefined) {
        const [beforeHash, hash] = location.split('#')
        const [path, query = ''] = beforeHash.split('?')
        const params = new URLSearchParams(query)
        params.set('token', accessToken)
        headers.location = `${path}?${params.toString()}${hash === undefined ? '' : `#${hash}`}`
      }
      const isHtml = String(headers['content-type'] ?? '').includes('text/html')
      if (!isHtml) {
        res.writeHead(upstreamRes.statusCode ?? 502, headers)
        upstreamRes.pipe(res)
        return
      }
      // HTML: buffer it so the observer script can be injected. Match the head
      // tag with attributes, not just the bare `<head>`, or the injection
      // silently does nothing.
      const parts = []
      upstreamRes.on('data', (chunk) => parts.push(chunk))
      upstreamRes.on('end', () => {
        delete headers['content-length']
        const original = Buffer.concat(parts).toString('utf8')
        const injected = original.replace(/<head([^>]*)>/i, `<head$1>${OBSERVER}`)
        if (injected === original) {
          console.error(`observe-probe: could not inject the observer into ${original.length} B of HTML`)
        }
        res.writeHead(upstreamRes.statusCode ?? 502, headers).end(injected)
      })
    })
    upstream.on('error', () => {
      res.writeHead(502).end('proxy error')
    })
    if (body !== undefined) upstream.write(body)
    upstream.end()
  })
})

let instance = null
const profile = mkdtempSync(join(tmpdir(), 'dsb-obs-'))

try {
  // The proxy must already be listening when the browser starts, or the very
  // first index request races past it and the page loads without the observer.
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))

  // The real instance on port+1; the observer proxy faces the browser on port.
  instance = spawn('dsh.cmd', ['web', '--port', String(port + 1), '--no-open'], {
    cwd: process.env.USERPROFILE,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    windowsHide: true,
  })
  let out = ''
  instance.stdout.on('data', (chunk) => { out += String(chunk) })
  instance.stderr.on('data', (chunk) => { out += String(chunk) })
  let token = null
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline && token === null) {
    const match = out.match(/http:\/\/[^\s]*\?token=([A-Za-z0-9_-]+)/)
    if (match !== null) token = match[1]
    else await sleep(400)
  }
  if (token === null) throw new Error('dsh web never printed a URL')
  accessToken = token

  console.log(`observe-probe: app on ${port + 1}, observer proxy on ${port}`)

  // Wait until the proxy can reach a live app before opening the browser: a
  // browser that meets a 502 while the app is still booting never recovers.
  const readyDeadline = Date.now() + 60_000
  let ready = false
  while (Date.now() < readyDeadline && !ready) {
    try {
      const probe = await fetch(`http://127.0.0.1:${port}/?token=${token}`)
      ready = probe.status === 200
      if (!ready) await sleep(700)
    } catch {
      await sleep(700)
    }
  }
  if (!ready) throw new Error('the app never answered through the observer proxy')
  console.log('observe-probe: app reachable, opening the browser')

  const edge = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars',
    `--user-data-dir=${profile}`,
    '--window-size=1440,900',
    `http://127.0.0.1:${port}/?token=${token}`,
  ], { stdio: 'ignore', windowsHide: true })

  await sleep(seconds * 1000)
  try {
    edge.kill()
  } catch {
    // already gone
  }
  // The last observation lands on the collector's clock, so give it a moment.
  await sleep(4500)
} catch (error) {
  console.error(`observe-probe: ${String(error).slice(0, 1200)}`)
  process.exitCode = 1
} finally {
  server.close()
  if (instance !== null) {
    try {
      execFileSync('taskkill', ['/PID', String(instance.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      // already gone
    }
  }
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    // handle still open
  }
}

if (latest === null) {
  console.error('observe-probe: the page never reported back')
  process.exitCode = 1
} else {
  const calls = latest.fetches ?? []
  const samples = latest.samples ?? []
  const lastSample = samples[samples.length - 1]
  const lastCall = calls[calls.length - 1]
  const digits = lastSample?.visible?.digits ?? ''

  console.log(`\nobserve-probe: ${calls.length} balance fetches, ${latest.intervalTicks} observer ticks`)
  for (const call of calls.slice(-3)) {
    console.log(`  +${call.at}ms ${call.url.replace(/\?.*/, '')} -> status=${call.status} bytes=${call.bodyBytes}${call.error === null ? '' : ` error=${call.error}`}`)
  }
  if (lastSample !== undefined) {
    console.log(`  widget: reels=${lastSample.reels} visible="${digits}" ${lastSample.visible?.currency} `
      + `storedSamples=${lastSample.stored}`)
    console.log(`  last observer sample at +${lastSample.at}ms (run was ${seconds}s)`)
  }
  for (const event of (latest.events ?? []).slice(0, 4)) {
    console.log(`  page ${event.kind} +${event.at}ms: ${event.text}`)
  }

  const nonzero = /^[0-9]/.test(digits)
  // The reels hold the digits only; the decimal point is a plain text node in
  // the same row, so compare digit sequences rather than formatted numbers.
  const hostBalance = (await (async () => {
    try {
      // Read the host's own reading through the app port, not the proxy.
      const stats = await (await fetch(`http://127.0.0.1:${port + 1}/dsh-balance/stats`)).json()
      return stats.cachedBalance
    } catch {
      return null
    }
  })())
  const expectedDigits = typeof hostBalance === 'string' ? hostBalance.replace(/\D/g, '') : null
  const matchesHost = expectedDigits !== null && expectedDigits.startsWith(digits.slice(0, 4))

  record('the page asked the balance route repeatedly', calls.length >= 4,
    `${calls.length} requests 鈥?the widget polls every 2.5s`)
  record('every request was answered with a full body',
    calls.length > 0 && calls.every((call) => call.status === 200 && call.bodyBytes > 100),
    `statuses=${[...new Set(calls.map((call) => call.status))].join(',')} bytes=${lastCall?.bodyBytes}`)
  record('the widget mounted and holds six reels',
    lastSample?.reels === 6 && lastSample?.widgets === 1,
    `reels=${lastSample?.reels} widgets=${lastSample?.widgets}`)
  record('the visible digits are the live balance', nonzero && matchesHost,
    `visible="${digits}" vs host=${hostBalance} (row also carries the decimal point as plain text)`)
  record('history accumulates for the chart', (lastSample?.stored ?? 0) >= 3,
    `${lastSample?.stored} samples in localStorage`)
  record('the page reported no uncaught errors', (latest.events ?? []).length === 0,
    `${(latest.events ?? []).length} errors`)

  const failed = results.filter((item) => !item.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) process.exitCode = 1
}
void BALANCE_PATH
