/**
 * Render `dev/preview.html` and read back the page's own pixel verdict.
 *
 * The page decodes the canvases it just drew and POSTs the result to a local
 * collector, because Chromium's stdout cannot be captured on this host and a
 * screenshot cannot be judged by a script. This is what proves the chart really
 * paints, in the right width, across the full colour ramp.
 *
 *   node scripts/collect-preview.mjs [port]
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.argv[2] ?? 7799)
const page = join(root, 'dev', 'preview.html')
if (!existsSync(page)) {
  console.error('collect-preview: run `node scripts/preview.mjs` first')
  process.exit(1)
}
const html = readFileSync(page, 'utf8')

const browsers = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]
const browser = browsers.find((path) => existsSync(path))
if (browser === undefined) {
  console.error('collect-preview: no Edge/Chrome found')
  process.exit(1)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

let verdict = null
let settle = null
const arrived = new Promise((resolve) => { settle = resolve })

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/report') {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        verdict = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        verdict = null
      }
      res.writeHead(204).end()
      settle()
    })
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html)
})

const profileDir = mkdtempSync(join(tmpdir(), 'dsb-shot-'))
let edge = null

try {
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  edge = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--force-device-scale-factor=2',
    `--user-data-dir=${profileDir}`,
    '--window-size=1400,1000',
    `--screenshot=${join(root, 'dev', 'preview.png')}`,
    `http://127.0.0.1:${port}/`,
  ], { stdio: 'ignore', windowsHide: true })

  await Promise.race([arrived, sleep(45_000)])

  if (verdict === null) {
    record('the preview page reported its canvas pixels', false, 'no verdict arrived')
  } else {
    const scenes = verdict.scenes ?? []
    record('every demo scene painted most of its canvas',
      scenes.length === 5 && scenes.every((scene) => scene.width >= 200),
      scenes.map((scene) => `${scene.index}:${scene.width}px`).join(' '))
    record('the live trace spans the full height (an area gradient, not a flat line)',
      scenes.every((scene) => scene.vertical === 'gradient'),
      scenes.map((scene) => scene.vertical).join(','))
    const hues = scenes.map((scene) => scene.dominant.replace(/\(\d+\)/, ''))
    const warmest = (scene) => scene.bands?.warm ?? 0
    const coolest = (scene) => (scene.bands?.teal ?? 0) + (scene.bands?.green ?? 0)
    // A violent drop must paint hot pixels, and a calm one must not: comparing
    // the two ends is what shows the ramp is doing its job.
    record('the colour ramp reaches the warm end on a violent drop',
      warmest(scenes[3]) > 10_000 && warmest(scenes[3]) > warmest(scenes[0]) * 20,
      `warm pixels: calm=${warmest(scenes[0])} violent=${warmest(scenes[3])} (hues ${hues.join(' → ')})`)
    record('a calm balance stays in the cool bands',
      coolest(scenes[0]) > 0 && warmest(scenes[0]) === 0,
      `cool=${coolest(scenes[0])} warm=${warmest(scenes[0])}`)
    record('the page threw no errors while drawing', (verdict.errors ?? []).length === 0,
      `${(verdict.errors ?? []).length} errors`)
    console.log('\n--- per scene ---')
    for (const scene of scenes) {
      console.log(`  SCENE ${scene.index} painted=${scene.painted} bbox=${scene.bbox} `
        + `dominant=${scene.dominant} bands=${JSON.stringify(scene.bands)} — ${scene.name}`)
    }
  }
  record('a preview screenshot was written', existsSync(join(root, 'dev', 'preview.png')),
    join(root, 'dev', 'preview.png'))
} catch (error) {
  console.error(`collect-preview: ${String(error).slice(0, 800)}`)
  process.exitCode = 1
} finally {
  server.close()
  if (edge !== null) {
    try {
      edge.kill()
    } catch {
      // already gone
    }
    try {
      execFileSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      // already gone
    }
  }
  try {
    rmSync(profileDir, { recursive: true, force: true })
  } catch {
    // handle still open
  }
}

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
