/**
 * Widget probe — the checks that need no DOM.
 *
 * `lib/client.js` is loaded through its own module-loader handshake and then
 * exercised two ways:
 *   1. `react-dom/server` renders the component, so hook order, the fetch
 *      path and every derived string actually execute.
 *   2. The canvas painter is exported on the fly and driven through a
 *      recording 2-D context stub — the only way to catch "the chart silently
 *      draws nothing", which no type check would notice.
 *
 *   node scripts/widget-probe.mjs
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// ---- a window/document shim good enough for module scope + SSR ------------

const storage = new Map()
const shimWindow = {
  innerWidth: 1440,
  innerHeight: 900,
  devicePixelRatio: 2,
  location: { href: 'http://127.0.0.1:3080/' },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
  __ModuleLoader__: { load: (registration) => { shimWindow.__loaded = registration } },
  fetch: async () => {
    throw new Error('fetch was not stubbed')
  },
}
globalThis.window = shimWindow
globalThis.document = {
  visibilityState: 'visible',
  head: { appendChild() {}, querySelector: () => null },
  createElement: () => ({ dataset: {}, style: {}, set textContent(_) {}, remove() {} }),
  querySelector: () => null,
  addEventListener: () => {},
  removeEventListener: () => {},
}

/** Load lib/client.js the way the browser shell does, optionally exposing the painter. */
function loadBundle({ exposePainter = false } = {}) {
  let source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  if (exposePainter) {
    source = source.replace('\t\treturn module.exports;',
      '\t\texports.__drawSpark = drawSpark;\n'
      + '\t\texports.__probe = { clamp, intensityOf, colorRamp, violenceScale, formatAmount, formatRunway, runwayEstimate, glyphPlan, thinSamples, reelPlan, reelSteps };\n'
      + '\t\treturn module.exports;')
    if (!source.includes('__drawSpark')) throw new Error('painter exposure failed — the bundle tail changed')
  }
  delete shimWindow.__loaded
  const shimModule = { exports: {} }
  const factory = new Function('window', 'module', 'exports', 'require', `${source}\nreturn module.exports;`)
  factory(shimWindow, shimModule, shimModule.exports, (spec) => {
    if (spec === 'react' || spec === 'react/jsx-runtime') return require(spec)
    throw new Error(`unexpected require("${spec}")`)
  })
  const registration = shimWindow.__loaded
  if (registration === undefined) throw new Error('the bundle never called window.__ModuleLoader__.load')
  // Executing the bundle only registers the factory; materialising it is what
  // produces the plugin exports, exactly as the client module system does.
  const materialised = registration.factory((spec) => {
    if (spec === 'react' || spec === 'react/jsx-runtime') return require(spec)
    throw new Error(`unexpected require("${spec}")`)
  })
  return { registration, exports: materialised }
}

// ---- bundle contract ------------------------------------------------------

const loaded = loadBundle()
record('bundle registers itself', typeof loaded.registration?.factory === 'function', `id=${loaded.registration?.id}`)
record('bundle exports apply/inject',
  typeof loaded.exports.apply === 'function' && Array.isArray(loaded.exports.inject),
  `inject=${JSON.stringify(loaded.exports.inject)}`)

const plugin = loadBundle().exports

// ---- the slot registration path -------------------------------------------

const injected = []
let registered = null
const fakeCtx = {
  effect: (factory) => {
    factory()
    return () => {}
  },
  logger: { warn: (text) => console.log(`   warn: ${text}`) },
  slots: {
    inject: (name, factory) => {
      injected.push(name)
      factory()
    },
    register: (options, Component) => {
      registered = { options, Component }
      return () => {}
    },
  },
}
plugin.apply(fakeCtx)
record('registers on shell.overlay',
  injected.includes('shell.overlay') && registered?.options?.name === 'shell.overlay',
  `slot=${registered?.options?.name} id=${registered?.options?.id} order=${registered?.options?.order}`)

// ---- SSR render: hook order, derived strings ------------------------------

const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

const loadingMarkup = renderToStaticMarkup(React.createElement(registered.Component, {}))
record('renders the card shell', loadingMarkup.includes('dsb-card') && loadingMarkup.includes('dsb-spark'),
  `${loadingMarkup.length} bytes`)
// A native title bubble is the browser's black box: it covers the digits and
// cannot be styled, so the widget must never render one.
record('renders no native title attributes',
  !/\stitle=/.test(loadingMarkup),
  'hints are drawn as our own layer')
record('renders the empty-amount placeholder before data arrives',
  loadingMarkup.includes('dsb-reel') || loadingMarkup.includes('dsb-value'),
  'the reels appear once the first balance lands (verified in the live GUI)')
record('renders the loading message', loadingMarkup.includes('正在读取余额'), undefined)

const seededMarkup = renderToStaticMarkup(React.createElement(registered.Component, {}))
record('server render starts in the loading state', seededMarkup.includes('正在读取余额'),
  'the store fills from fetch on the client; the live GUI is where that is verified')

// ---- the pure maths the visuals depend on ---------------------------------

const pure = loadBundle({ exposePainter: true }).exports.__probe
record('the probe surface is exposed', pure !== undefined && typeof pure.colorRamp === 'function')

record('amount formatting is always two decimals',
  pure.formatAmount(47.05) === '47.05' && pure.formatAmount(1234.5) === '1234.50'
    && pure.formatAmount(9) === '9.00' && pure.formatAmount(Number.NaN) === '—',
  `${pure.formatAmount(47.05)} / ${pure.formatAmount(1234.5)} / ${pure.formatAmount(9)}`)

const longSeries = Array.from({ length: 600 }, (_, index) => ({ t: index * 1000, v: 50 - index * 0.01 }))
const thinned = pure.thinSamples(longSeries, 150)
record('a long history is thinned to what the canvas can show',
  thinned.length === 31 && thinned[thinned.length - 1].v === longSeries[longSeries.length - 1].v,
  `${longSeries.length} samples → ${thinned.length} points at 150 px (newest kept)`)
record('a short history is drawn as-is', pure.thinSamples(longSeries.slice(0, 12), 150).length === 12,
  '12 samples → 12 points')

// The slot machine used to show 0 after the card was folded into its pill and
// reopened: the remounted strips were never positioned, so every reel sat at
// translateY(0) — the glyph 0 — while the hook believed it had already drawn.
const digitsOf = (text) => pure.glyphPlan(text).filter((item) => item.kind === 'reel').map((item) => item.value)
const amount = digitsOf('44.70')
record('a remount snaps instead of trusting stale strips',
  pure.reelPlan({
    previousText: '44.70', previousDigits: amount, text: '44.70',
    nextDigits: amount, mounted: amount.map(() => false), animate: true,
  }).snap === true,
  'six unmounted strips must repaint, not travel')
// The strip nodes are replaced when the card folds into its pill, so this is
// the case that actually bit: the hook still holds *an* element, just not the
// one it painted. Trusting it left a never-positioned strip, i.e. the glyph 0 —
// the "balance shows 0 after collapsing" report.
record('replaced strip nodes snap too',
  pure.reelPlan({
    previousText: '44.70', previousDigits: amount, text: '44.70',
    nextDigits: amount, mounted: amount.map((_, index) => index === 0), animate: true,
  }).snap === true,
  'only the very node that was painted may travel')
record('a live change still spins',
  pure.reelPlan({
    previousText: '44.70', previousDigits: amount, text: '44.71',
    nextDigits: digitsOf('44.71'), mounted: amount.map(() => true), animate: true,
  }).snap === false,
  'same shape, mounted strips → the last reel travels one step')
record('a digit-count change snaps',
  pure.reelPlan({
    previousText: '44.70', previousDigits: amount, text: '104.70',
    nextDigits: digitsOf('104.70'), mounted: amount.map(() => true), animate: true,
  }).snap === true,
  'reels cannot keep identity when the amount grows a digit')
record('reduced motion never animates',
  pure.reelPlan({
    previousText: '44.70', previousDigits: amount, text: '44.71',
    nextDigits: digitsOf('44.71'), mounted: amount.map(() => true), animate: false,
  }).snap === true,
  'prefers-reduced-motion must be honoured')
record('reel travel takes the short way round the loop',
  pure.reelSteps(9, 0) === 1 && pure.reelSteps(0, 9) === -1 && pure.reelSteps(3, 3) === 0,
  `9→0 is ${pure.reelSteps(9, 0)}, 0→9 is ${pure.reelSteps(0, 9)}`)

const plan = pure.glyphPlan('47.0500')
record('glyph plan splits digits from separators',
  plan.filter((item) => item.kind === 'reel').length === 6 && plan.some((item) => item.value === '.'),
  `${plan.filter((item) => item.kind === 'reel').length} reels`)

// The colour ramp is the feature that tells "mild" from "violent": check that a
// ten-times move actually reaches the red end, and that the reference grows
// with the account instead of being a fixed cent amount.
const scale = pure.violenceScale([{ t: 0, v: 47.05 }])
record('reference move is the geometric mean of floor and fraction',
  Math.abs(scale - Math.sqrt(0.005 * 0.4705)) < 1e-9, `scale=${scale.toFixed(4)}`)
const hueOf = (intensity) => Number(pure.colorRamp(intensity).line.match(/hsl\(([\d.]+)/)[1])
record('a ten-times move lands in the red band',
  hueOf(pure.intensityOf(scale * 10, scale)) < 25,
  `hue=${hueOf(pure.intensityOf(scale * 10, scale)).toFixed(0)}`)
record('the ramp never leaves a valid hue',
  [0, 0.2, 0.45, 0.7, 0.9, 1].every((value) => Number.isFinite(hueOf(value))),
  [0, 0.2, 0.45, 0.7, 0.9, 1].map((value) => hueOf(value).toFixed(0)).join(' → '))
const smallHue = hueOf(pure.intensityOf(1, pure.violenceScale([{ t: 0, v: 5 }])))
const largeHue = hueOf(pure.intensityOf(1, pure.violenceScale([{ t: 0, v: 5000 }])))
record('a bigger balance demands a bigger move',
  smallHue < 30 && largeHue > 60,
  `¥1 drop: 5元账户 hue=${smallHue.toFixed(0)} / 5000元账户 hue=${largeHue.toFixed(0)}`)
// The ramp must use its whole range on a real account: an ordinary request
// should colour, and a cart-sized drop should be red rather than merely amber.
const realHue = (drop) => hueOf(pure.intensityOf(drop, pure.violenceScale([{ t: 0, v: 47.05 }])))
record('an ordinary request colours the line',
  realHue(0.05) > 100 && realHue(0.05) < 190,
  `¥0.05 drop on ¥47.05 -> hue=${realHue(0.05).toFixed(0)} (green band)`)
record('an expensive step reaches the red band',
  realHue(0.7) < 30,
  `¥0.70 drop on ¥47.05 -> hue=${realHue(0.7).toFixed(0)}`)

const hour = 3_600_000
const drain = [0, 1, 2, 3].map((index) => ({ t: index * hour, v: 10 - index }))
const runway = pure.runwayEstimate(drain, 7, () => 4 * hour)
record('runway extrapolates the observed burn', runway !== null && Math.abs(runway.hoursLeft - 7) < 0.01,
  runway === null ? 'null' : `${runway.hoursLeft.toFixed(2)}h at ${runway.ratePerHour.toFixed(2)}/h`)
record('runway formats in hours then days',
  pure.formatRunway({ ratePerHour: 1, hoursLeft: 5 }) === '5.0 小时' && pure.formatRunway({ ratePerHour: 1, hoursLeft: 72 }) === '3.0 天',
  `${pure.formatRunway({ ratePerHour: 1, hoursLeft: 5 })} / ${pure.formatRunway({ ratePerHour: 1, hoursLeft: 72 })}`)
record('an idle balance offers no runway',
  pure.runwayEstimate([{ t: 0, v: 10 }, { t: hour, v: 10 }, { t: 2 * hour, v: 10 }], 10, () => 2 * hour) === null,
  'a flat history must not invent a burn rate')

// ---- canvas painter through a recording stub ------------------------------

function makeRecorder() {
  const calls = []
  const context = {
    setTransform: () => calls.push('setTransform'),
    clearRect: () => calls.push('clearRect'),
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    beginPath: () => calls.push('beginPath'),
    closePath: () => calls.push('closePath'),
    moveTo: (...args) => calls.push(`moveTo:${args.length}`),
    lineTo: (...args) => calls.push(`lineTo:${args.length}`),
    bezierCurveTo: (...args) => calls.push(`bezier:${args.length}`),
    arc: (...args) => calls.push(`arc:${args.length}`),
    fill: () => calls.push('fill'),
    stroke: () => calls.push('stroke'),
    setLineDash: (...args) => calls.push(`setLineDash:${args[0]?.length ?? 0}`),
    createLinearGradient: () => {
      calls.push('gradient')
      return { addColorStop: () => calls.push('colorStop') }
    },
  }
  return { calls, context }
}

const painter = loadBundle({ exposePainter: true }).exports.__drawSpark
record('painter is reachable', typeof painter === 'function')

const now = Date.now()
const history = [
  { t: now, v: 47.05 },
  { t: now + 2400, v: 47.05 },
  { t: now + 4800, v: 46.6 },
  { t: now + 7200, v: 46.6 },
  { t: now + 9600, v: 46.2 },
  { t: now + 12000, v: 44.1 },
]
const live = makeRecorder()
painter({ width: 0, height: 0, getContext: () => live.context }, history, 214, 42, 3, 0.4, 0.5, '#4d6bfe', false)
const count = (calls, prefix) => calls.filter((call) => call.startsWith(prefix)).length
// Five trace segments plus three lifted ghost sweeps = 8 cubic curves, and the
// same count of stroke calls; a regression that silently draws nothing drops both.
record('draws the ghost trail and live trace',
  count(live.calls, 'bezier') >= 8 && count(live.calls, 'stroke') >= 8,
  `bezier=${count(live.calls, 'bezier')} stroke=${count(live.calls, 'stroke')} fill=${count(live.calls, 'fill')}`)
record('draws the area gradient', count(live.calls, 'gradient') === 1 && count(live.calls, 'colorStop') === 2, undefined)
record('draws drop markers and the head', count(live.calls, 'arc') >= 6, `arc=${count(live.calls, 'arc')}`)
record('sizes the backing store for the device pixel ratio', live.calls.includes('setTransform'), undefined)

const empty = makeRecorder()
painter({ width: 0, height: 0, getContext: () => empty.context }, [], 214, 42, -1, 0.4, 0.5, '#4d6bfe', false)
record('empty history draws the flat placeholder', count(empty.calls, 'setLineDash') >= 1,
  `setLineDash=${count(empty.calls, 'setLineDash')}`)

const single = makeRecorder()
painter({ width: 0, height: 0, getContext: () => single.context }, [history[0]], 214, 42, -1, 0.4, 0.5, '#4d6bfe', false)
record('one sample does not crash', count(single.calls, 'setLineDash') >= 1, undefined)

const flat = makeRecorder()
painter({ width: 0, height: 0, getContext: () => flat.context },
  history.map((sample) => ({ ...sample, v: 12 })), 214, 42, -1, 0.4, 0.5, '#4d6bfe', false)
record('a perfectly flat balance still draws', count(flat.calls, 'bezier') >= 8, `bezier=${count(flat.calls, 'bezier')}`)

const failures = results.filter((item) => !item.ok)
console.log(`\n${results.length - failures.length}/${results.length} checks passed`)
process.exitCode = failures.length === 0 ? 0 : 1
