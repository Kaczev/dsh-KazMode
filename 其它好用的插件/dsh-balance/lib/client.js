window.__ModuleLoader__.load({
	id: "dsh-balance",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
/**
 * dsh-balance — browser half.
 *
 * A floating balance card on the DSH `shell.overlay` layer:
 *   - polls one local route (the host proxies DeepSeek, so no API key here)
 *   - slot-machine digits: the number physically rolls to its new value
 *   - a canvas sparkline of the last samples, with a ghost trail of past
 *     sweeps, and a colour ramp that reads how violent the change was
 *   - the card shakes and emits a ripple when the balance really drops
 *   - drag anywhere, release near an edge and it snaps there for good
 *
 * Only `react` and `react/jsx-runtime` are required; both are platform seed
 * modules of the DSH web shell.
 */

const React = require('react')

const {
  createElement: h,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} = React

/** Local JSON route served by this plugin's host half. */
const BALANCE_PATH = '/dsh-balance/balance'
/** One persisted slot in localStorage. */
const STORAGE_KEY = 'dsh-balance:v2'
const STYLE_TAG_ID = 'dsh-balance/styles'
const PLUGIN_ID = 'dsh-balance'

/** How often the widget asks the local route (the host serves a cache). */
const POLL_MS = 2500
/**
 * Sparkline capacity, in samples. At one sample per change this is roughly a
 * quarter hour of history — which is what lets the line show a shape instead of
 * a flat shelf.
 */
const HISTORY_LIMIT = 600
/** Two samples closer than this collapse into the newest one. */
const MIN_SAMPLE_GAP_MS = 600
/** Reel travel time for one digit, before stagger. */
const REEL_MS = 760
/** Extra travel added per reel position, so digits settle left to right. */
const REEL_STAGGER_MS = 95
/** Reel spin duration. */
const SPIN_MS = 560
/** Reel blur when the value moves faster than this many units per second. */
const BLUR_VELOCITY = 0.6
/** Reel glyph box height in px — must match the stylesheet. */
const REEL_STEP_PX = 24
/** Rendered card size in px — the fallback before the DOM can be measured. */
const CARD_WIDTH = 150
const CARD_HEIGHT = 66
/** No more than one drawn point per this many pixels: a dense chart is a smear. */
const MIN_PX_PER_SAMPLE = 5
/** A single drop worth shaking the card over. */
const NORMALIZED_VIOLENCE = 0.55
/** Edge distance, in px, inside which a released card snaps. */
const SNAP_THRESHOLD = 90
/** Card keep-out from the viewport edges. */
const EDGE_MARGIN = 14
/** Never normalise against less than this: a fraction of one API call's cost. */
const MIN_VIOLENCE_SCALE = 0.005
/** A move of this share of the balance is also "a lot", so the ramp scales up. */
const BIG_MOVE_FRACTION = 0.01
/** Digit glyphs, widest first so measurement never underestimates. */
const DIGIT_GLYPHS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '—']

//#region styles

const CSS = `
.dsb-root {
  position: fixed;
  z-index: 2147483000;
  pointer-events: auto;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
  font-family: var(--dsw-font-family, Inter, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif);
  color: var(--dsw-alias-label-primary, #1f2328);
  cursor: grab;
  --dsb-heat: #6b7280;
  --dsb-heat-soft: rgba(107, 114, 128, 0.28);
  --dsb-heat-glow: rgba(107, 114, 128, 0);
  --dsb-accent: var(--dsw-static-neutral-bluish-400, #4d6bfe);
}
.dsb-root[data-dragging="true"] { cursor: grabbing; }
.dsb-root[data-reduced="true"] * { animation: none !important; transition: none !important; }

.dsb-card {
  position: relative;
  box-sizing: border-box;
  width: 150px;
  height: 66px;
  padding: 7px 9px;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12));
  background: var(--dsw-alias-bg-overlay, rgba(255, 255, 255, 0.94));
  box-shadow: var(--dsw-elevation-prominent, 0 10px 32px rgba(0, 0, 0, 0.18), 0 2px 8px rgba(0, 0, 0, 0.08));
  -webkit-backdrop-filter: blur(14px) saturate(1.15);
  backdrop-filter: blur(14px) saturate(1.15);
  transition: box-shadow 220ms ease, border-color 220ms ease;
}
.dsb-root[data-dragging="true"] .dsb-card {
  box-shadow: var(--dsw-elevation-prominent, 0 16px 40px rgba(0, 0, 0, 0.26));
}
/* The chart is the card's backdrop: the line and the heat wash sit under the
   digits, faded so the number stays the thing you read first. */
.dsb-backdrop {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  overflow: hidden;
  pointer-events: none;
}
.dsb-spark {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  opacity: 0.5;
}
/* A soft scrim behind the text, so digits never fight the line for contrast. */
.dsb-scrim {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(120% 90% at 22% 52%, var(--dsw-alias-bg-overlay, rgba(255, 255, 255, 0.94)) 32%, transparent 78%),
    linear-gradient(180deg, var(--dsw-alias-bg-overlay, rgba(255, 255, 255, 0.94)) 4%, transparent 34%);
  opacity: 0.72;
}
.dsb-scrim::after {
  content: "";
  position: absolute;
  inset: 0;
  background: radial-gradient(60% 70% at 84% 4%, var(--dsb-heat-glow), transparent 74%);
  transition: background 400ms linear;
}
.dsb-content {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
}
.dsb-shake { animation: dsb-shake 420ms cubic-bezier(0.36, 0.07, 0.19, 0.97) both; }
@keyframes dsb-shake {
  10%, 90% { transform: translate3d(-1px, 0, 0) rotate(-0.25deg); }
  20%, 80% { transform: translate3d(2px, 0, 0) rotate(0.35deg); }
  30%, 50%, 70% { transform: translate3d(-3px, 1px, 0) rotate(-0.5deg); }
  40%, 60% { transform: translate3d(3px, -1px, 0) rotate(0.5deg); }
}
/* A drop ripples outward from the card, one wave per sample that hurt. */
.dsb-card.dsb-pulse::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  border: 1.5px solid var(--dsb-heat);
  animation: dsb-ripple 900ms cubic-bezier(0.2, 0.7, 0.3, 1) 1 both;
  pointer-events: none;
}
@keyframes dsb-ripple {
  0% { opacity: 0.7; transform: scale(1); }
  100% { opacity: 0; transform: scale(1.16); }
}
/* Low-balance warning: the whole card breathes red. */
.dsb-root[data-low="true"] .dsb-card { animation: dsb-breathe 2600ms ease-in-out infinite; }
@keyframes dsb-breathe {
  0%, 100% { box-shadow: var(--dsw-elevation-prominent, 0 10px 32px rgba(0, 0, 0, 0.18)), 0 0 0 0 rgba(239, 68, 68, 0); }
  50% { box-shadow: var(--dsw-elevation-prominent, 0 10px 32px rgba(0, 0, 0, 0.18)), 0 0 22px 2px rgba(239, 68, 68, 0.34); }
}

.dsb-head {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
.dsb-dot {
  width: 5px;
  height: 5px;
  flex: none;
  border-radius: 50%;
  background: #f59e0b;
  box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.16);
  transition: background 200ms ease, box-shadow 200ms ease;
}
.dsb-dot[data-state="ok"] { background: #22c55e; box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.16); }
.dsb-dot[data-state="bad"] { background: #ef4444; box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.16); }
.dsb-dot[data-state="stale"] { background: #f59e0b; box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.16); }
.dsb-label {
  flex: 1;
  min-width: 0;
  font-size: 9px;
  line-height: 11px;
  letter-spacing: 0.03em;
  color: var(--dsw-alias-label-tertiary, #9ca3af);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsb-actions { display: flex; align-items: center; gap: 0; flex: none; }
.dsb-icon {
  width: 14px;
  height: 14px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #9ca3af);
  font: inherit;
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
}
.dsb-icon:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06)); color: var(--dsw-alias-label-primary, #1f2328); }
.dsb-icon[data-spinning="true"] { animation: dsb-rotate 700ms linear infinite; }
@keyframes dsb-rotate { to { transform: rotate(360deg); } }
.dsb-collapse { font-size: 10px; }

.dsb-value {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  margin: auto 0;
}
.dsb-reels {
  display: flex;
  align-items: flex-end;
  font-variant-numeric: tabular-nums;
  font-size: 21px;
  font-weight: 650;
  line-height: 24px;
  letter-spacing: -0.01em;
  color: var(--dsw-alias-label-primary, #1f2328);
  text-shadow: 0 0 8px var(--dsw-alias-bg-overlay, #fff), 0 0 2px var(--dsw-alias-bg-overlay, #fff);
  transition: text-shadow 400ms linear, color 300ms ease;
}
.dsb-reel { display: inline-block; height: 24px; overflow: hidden; }
.dsb-reel-inner {
  display: block;
  transform: translate3d(0, 0, 0);
  backface-visibility: hidden;
  /* The strip is driven straight from rAF: keep it on its own compositor layer
     so a spin never triggers layout or paint of the rest of the card. */
  will-change: transform;
}
.dsb-reel-inner[data-spin="true"] { filter: blur(0.5px); }
.dsb-glyph { display: block; height: 24px; text-align: center; font-variant-numeric: tabular-nums; }
.dsb-glyph-dot { transform: translateY(-2px); }
.dsb-currency {
  padding-bottom: 3px;
  font-size: 9px;
  line-height: 11px;
  color: var(--dsw-alias-label-tertiary, #9ca3af);
  text-shadow: 0 0 6px var(--dsw-alias-bg-overlay, #fff);
}
.dsb-delta {
  margin-left: auto;
  padding-bottom: 2px;
  font-size: 9px;
  line-height: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--dsb-heat);
  white-space: nowrap;
  text-shadow: 0 0 6px var(--dsw-alias-bg-overlay, #fff);
  transition: color 300ms ease;
}
.dsb-foot {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
  font-size: 9px;
  line-height: 11px;
  color: var(--dsw-alias-label-tertiary, #9ca3af);
  white-space: nowrap;
}
.dsb-foot-item { display: inline-flex; gap: 2px; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.dsb-foot-value { color: var(--dsw-alias-label-secondary, #6b7280); font-variant-numeric: tabular-nums; }
.dsb-foot-time { margin-left: auto; flex: none; }
/* The hover readout replaces the footer row in place, with a fixed height, so
   hovering never moves the digits above it. */
.dsb-readout {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 11px;
  font-size: 9px;
  line-height: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary, #6b7280);
  white-space: nowrap;
}
.dsb-readout-value { color: var(--dsw-alias-label-primary, #1f2328); font-weight: 600; }
.dsb-readout-delta { margin-left: auto; color: var(--dsb-heat); }
/* Hints float OVER the card instead of pushing its contents. Native title
   bubbles are deliberately not used anywhere in this widget: they are the
   browser's black box, and they land on top of the digits. */
.dsb-hint {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  z-index: 1;
  padding: 3px 7px 5px;
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-overlay, rgba(255, 255, 255, 0.97)));
  border-bottom: 1px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.1));
  border-radius: inherit;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.1);
  font-size: 9px;
  line-height: 11px;
  color: var(--dsw-alias-label-secondary, #6b7280);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}

.dsb-msg {
  margin-top: 1px;
  font-size: 9px;
  line-height: 11px;
  color: var(--dsw-alias-label-tertiary, #9ca3af);
  white-space: normal;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.dsb-msg[data-error="true"] { color: #ef4444; }

/* Collapsed pill (click the chevron to fold the card away). */
.dsb-pill {
  display: flex;
  align-items: center;
  gap: 5px;
  width: auto;
  height: auto;
  padding: 5px 8px 5px 6px;
  cursor: grab;
}
.dsb-pill .dsb-reels { font-size: 13px; line-height: 17px; text-shadow: none; }
.dsb-pill .dsb-reel, .dsb-pill .dsb-glyph { height: 17px; }
.dsb-pill .dsb-currency { font-size: 9.5px; padding-bottom: 2px; }
`

/** Inject the plugin stylesheet once, tolerating HMR re-materialisation. */
function adoptStyles() {
  if (typeof document === 'undefined') return () => {}
  const existing = document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`)
  if (existing !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = PLUGIN_ID
  tag.dataset.pluginCss = STYLE_TAG_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
  return () => tag.remove()
}

//#endregion

//#region pure helpers

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value))
}

function easeOutCubic(t) {
  return 1 - (1 - t) ** 3
}

/** Shortest signed distance from `from` to `to` on the 0–9 digit loop. */
function reelSteps(from, to) {
  let delta = to - from
  if (delta > 5) delta -= 10
  if (delta < -5) delta += 10
  return delta
}

/**
 * Decide how a set of reels should move to a new amount.
 *
 * This is the decision the slot machine hinges on, and the one a remount used to
 * get wrong: reels may only travel when every strip is still the node that was
 * painted last time. A fresh DOM (the card folded to its pill and back) must
 * snap, because a strip that has never been positioned sits at translateY(0) —
 * which is the glyph `0`, and that is exactly the wrong number to show.
 *
 * @param {object} input - reel state.
 * @param {string | null} input.previousText - the amount the strips last showed, null when new.
 * @param {number[]} input.previousDigits - the digits those strips were left on.
 * @param {string} input.text - the amount to show now.
 * @param {number[]} input.nextDigits - the digits of that amount.
 * @param {boolean[]} input.mounted - whether each strip's DOM node is the painted one.
 * @param {boolean} input.animate - whether motion is allowed at all.
 * @returns {{snap: boolean, fresh: boolean, offsets: number[]}} travel per reel, or a snap instruction.
 */
function reelPlan({ previousText, previousDigits, text, nextDigits, mounted, animate }) {
  const fresh = mounted.length !== nextDigits.length || mounted.some((flag) => flag !== true)
  if (fresh) return { snap: true, fresh: true, offsets: nextDigits.map(() => 0) }
  const sameShape = previousText !== null && previousText.length === text.length
  if (!animate || !sameShape) return { snap: true, fresh: false, offsets: nextDigits.map(() => 0) }
  const offsets = nextDigits.map((digit, index) => reelSteps(previousDigits[index], digit))
  return { snap: offsets.every((steps) => steps === 0), fresh: false, offsets }
}

/**
 * Split a formatted amount into reel glyphs and plain separators.
 *
 * @param {string} text - e.g. `12.3456`.
 * @returns {Array<{kind: 'reel', value: number} | {kind: 'text', value: string}>} glyph plan.
 */
function glyphPlan(text) {
  const plan = []
  for (const char of text) {
    if (char >= '0' && char <= '9') plan.push({ kind: 'reel', value: Number(char) })
    else if (char === '.') plan.push({ kind: 'text', value: '.' })
    else plan.push({ kind: 'text', value: char })
  }
  return plan
}

/**
 * How violent one balance move was, normalised against a reference scale.
 *
 * @param {number} delta - signed change.
 * @param {number} scale - reference magnitude.
 * @returns {number} 0..1.
 */
function intensityOf(delta, scale) {
  const magnitude = Math.abs(delta)
  if (magnitude === 0) return 0
  const safeScale = scale > 0 ? scale : DEFAULT_VIOLENCE_SCALE
  return clamp(Math.log1p(magnitude / safeScale) / Math.log(1 + 10), 0, 1)
}

/**
 * Colour ramp from "barely moved" to "hemorrhaging". Muted grey for a flat
 * balance, then teal → green → amber → orange → red as the move gets bigger.
 *
 * @param {number} intensity - 0..1.
 * @returns {{line: string, soft: string, glow: string, bright: string, label: string}} CSS colours.
 */
function colorRamp(intensity) {
  const stops = [
    { at: 0, hue: 210, sat: 8, light: 58 },
    { at: 0.18, hue: 178, sat: 55, light: 46 },
    { at: 0.42, hue: 150, sat: 62, light: 42 },
    { at: 0.62, hue: 42, sat: 92, light: 50 },
    { at: 0.8, hue: 26, sat: 94, light: 52 },
    { at: 1, hue: 2, sat: 84, light: 52 },
  ]
  let lo = stops[0]
  let hi = stops[stops.length - 1]
  for (let index = 0; index < stops.length - 1; index += 1) {
    if (intensity >= stops[index].at && intensity <= stops[index + 1].at) {
      lo = stops[index]
      hi = stops[index + 1]
      break
    }
  }
  const span = hi.at - lo.at
  const t = span === 0 ? 0 : (intensity - lo.at) / span
  const hue = lo.hue + (hi.hue - lo.hue) * t
  const sat = lo.sat + (hi.sat - lo.sat) * t
  const light = lo.light + (hi.light - lo.light) * t
  return {
    line: `hsl(${hue.toFixed(1)}, ${sat.toFixed(1)}%, ${light.toFixed(1)}%)`,
    bright: `hsl(${hue.toFixed(1)}, ${Math.min(100, sat + 8).toFixed(1)}%, ${Math.max(24, light - 12).toFixed(1)}%)`,
    soft: `hsla(${hue.toFixed(1)}, ${sat.toFixed(1)}%, ${light.toFixed(1)}%, 0.18)`,
    glow: `hsla(${hue.toFixed(1)}, ${sat.toFixed(1)}%, ${light.toFixed(1)}%, ${(0.1 + intensity * 0.5).toFixed(3)})`,
    label: hue < 200 && hue > 160 ? 'flat' : intensity > 0.8 ? 'violent' : intensity > 0.55 ? 'strong' : 'mild',
  }
}

/**
 * Human amount: always two decimals — the widget should read as a number, not
 * as a measurement, and a fraction that changes width makes the reels jump.
 *
 * @param {number} value - parsed balance.
 * @returns {string} formatted amount.
 */
function formatAmount(value) {
  if (!Number.isFinite(value)) return '—'
  return value.toFixed(2)
}

/**
 * Shrink a series for drawing.
 *
 * Only as many points as the canvas has room for get a bezier: six hundred
 * samples across 150 px would be a smear, and each pair would cost a curve for
 * nothing. The newest sample is always kept.
 *
 * @param {Array<{t: number, v: number}>} samples - full history, oldest first.
 * @param {number} width - canvas width in CSS px.
 * @returns {Array<{t: number, v: number}>} the points to draw.
 */
function thinSamples(samples, width) {
  const room = Math.max(2, Math.floor(width / MIN_PX_PER_SAMPLE))
  if (samples.length <= room + 1) return samples
  const out = []
  for (let index = 0; index <= room; index += 1) {
    out.push(samples[Math.round(((samples.length - 1) * index) / room)])
  }
  return out
}

/**
 * Reference magnitude for the colour ramp: what counts as "a lot of money".
 *
 * Two things must both read as big, so the reference is the geometric mean of
 * them: an absolute floor (one API call costs cents, whatever the account
 * holds) and a fraction of the balance (losing a tenth of a small account is
 * dramatic even when the amount is tiny). The mean keeps the ramp sensitive on
 * a ¥5 account without letting a single huge drop normalise everything away on
 * a ¥5000 one — a plain percentile did exactly that, which is why it is gone.
 *
 * @param {Array<{v: number}>} samples - history, oldest first.
 * @returns {number} reference magnitude per movement.
 */
function violenceScale(samples) {
  const current = samples.length > 0 ? samples[samples.length - 1].v : NaN
  const relative = Number.isFinite(current) && current > 0 ? current * BIG_MOVE_FRACTION : MIN_VIOLENCE_SCALE
  return Math.max(MIN_VIOLENCE_SCALE, Math.sqrt(MIN_VIOLENCE_SCALE * relative))
}

function parseAmount(text) {
  const value = Number.parseFloat(text)
  return Number.isFinite(value) ? value : undefined
}

function relativeTime(ms) {
  if (ms < 1500) return '刚刚'
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒前`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟前`
  return `${Math.round(ms / 3_600_000)} 小时前`
}

function clockTime(ms) {
  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * "How much longer can this last" from the observed burn rate.
 *
 * @param {Array<{t: number, v: number}>} samples - history, oldest first.
 * @param {number} balance - current balance.
 * @param {() => number} now - clock.
 * @returns {{ratePerHour: number, hoursLeft: number} | null} estimate, or null when idle/short.
 */
function runwayEstimate(samples, balance, now) {
  if (samples.length < 3 || !Number.isFinite(balance)) return null
  const oldest = samples[0]
  const newest = samples[samples.length - 1]
  const elapsedHours = (newest.t - oldest.t) / 3_600_000
  if (elapsedHours <= 0.01) return null
  const spent = oldest.v - balance
  if (spent <= 0) return null
  const ratePerHour = spent / elapsedHours
  if (ratePerHour <= 0) return null
  return { ratePerHour, hoursLeft: balance / ratePerHour }
}

/** Compact currency amount for the readout row. */
function money(value, currency) {
  if (!Number.isFinite(value)) return '—'
  return `${currency === 'USD' ? '$' : '¥'}${value.toFixed(2)}`
}

function formatRunway(estimate) {
  if (estimate === null) return null
  const hours = estimate.hoursLeft
  if (!Number.isFinite(hours) || hours <= 0) return null
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} 分钟`
  if (hours < 48) return `${hours.toFixed(1)} 小时`
  return `${(hours / 24).toFixed(1)} 天`
}

function loadStore() {
  const fallback = { samples: [], startedAt: null, startBalance: null, x: null, y: null, collapsed: false }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return fallback
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return fallback
    const samples = Array.isArray(parsed.samples)
      ? parsed.samples
          .filter((item) => item !== null && typeof item === 'object'
            && Number.isFinite(item.t) && Number.isFinite(item.v))
          .slice(-HISTORY_LIMIT)
      : []
    return {
      samples,
      startedAt: Number.isFinite(parsed.startedAt) ? parsed.startedAt : null,
      startBalance: Number.isFinite(parsed.startBalance) ? parsed.startBalance : null,
      x: Number.isFinite(parsed.x) ? parsed.x : null,
      y: Number.isFinite(parsed.y) ? parsed.y : null,
      collapsed: parsed.collapsed === true,
    }
  } catch {
    return fallback
  }
}

function saveStore(store) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...store, samples: store.samples.slice(-HISTORY_LIMIT) }))
  } catch {
    // private mode / quota: the widget simply forgets between reloads
  }
}

/**
 * Where an unplaced card rests: clear of the corner, by the edge.
 *
 * @param {() => {width: number, height: number}} measure - the card's own size.
 * @returns {{x: number, y: number, placed: boolean}} rest position.
 */
function restPositionFor(measure) {
  const { width, height } = measure()
  return {
    x: Math.max(EDGE_MARGIN, window.innerWidth - width - 24),
    y: Math.max(EDGE_MARGIN, window.innerHeight - height - 24),
    placed: true,
  }
}

//#endregion

//#region hooks

/**
 * Slot-machine reel hook.
 *
 * Each digit owns a strip of ten glyphs that physically rotates to bring the
 * new value into the window, taking the short way round the loop and settling
 * left reel first. The strip transform is driven straight from rAF — the React
 * value updates once per reel, when the animation lands — so a step never
 * re-renders the whole card.
 *
 * The DOM is replaced whenever the card folds into its pill and back, while this
 * hook's state survives. "Do I have an element?" is therefore not the question —
 * the question is "is the element I have the one I painted?", and a strip that
 * was never painted sits at translateY(0), which reads as the glyph 0.
 *
 * @param {string} text - the target formatted amount.
 * @param {boolean} animate - false to snap (first paint, reduced motion).
 * @returns {{bind: (index: number, el: HTMLElement | null) => void | (() => void), spinning: boolean, blurred: boolean}} reel binding.
 */
function useReels(text, animate) {
  const elements = useRef([])
  /** The exact strip nodes the last paint wrote to, by reel index. */
  const painted = useRef([])
  const state = useRef({ text: null, digits: [], raf: 0 })
  const [spinning, setSpinning] = useState(false)
  const [blurred, setBlurred] = useState(false)

  useLayoutEffect(() => {
    const current = state.current
    const nextDigits = glyphPlan(text).filter((item) => item.kind === 'reel').map((item) => item.value)
    const previousText = current.text
    const previousDigits = current.digits

    const cancel = () => {
      if (current.raf !== 0) {
        window.cancelAnimationFrame(current.raf)
        current.raf = 0
      }
    }

    // Positions whatever strips the ref callback has handed over, and records
    // exactly which nodes those were so the next run can tell whether they are
    // still the same DOM.
    const paint = (positions) => {
      for (let index = 0; index < positions.length; index += 1) {
        const element = elements.current[index]
        if (element === null || element === undefined) continue
        // The strip holds exactly ten glyphs, so the rotation wraps seamlessly.
        element.style.transform = `translate3d(0, ${(-positions[index] * REEL_STEP_PX).toFixed(2)}px, 0)`
        painted.current[index] = element
      }
    }

    const settle = (fresh = false) => {
      cancel()
      current.text = text
      current.digits = nextDigits
      for (const element of elements.current.slice(0, nextDigits.length)) {
        if (element === null || element === undefined) continue
        element.style.transition = fresh ? 'none' : ''
      }
      paint(nextDigits)
      setSpinning(false)
      setBlurred(false)
    }

    // Travel is allowed only when every strip is the very node that was painted
    // last time: any other node has never been positioned and must be snapped
    // (and painted with the transition off) or it will show 0.
    const current0 = elements.current
    const painted0 = painted.current
    const sameNodes = nextDigits.length > 0 && current0.length >= nextDigits.length
      && nextDigits.every((_, index) => current0[index] !== null && current0[index] !== undefined
        && current0[index] === painted0[index])
    const plan = reelPlan({
      previousText,
      previousDigits,
      text,
      nextDigits,
      mounted: nextDigits.map(() => sameNodes),
      animate,
    })

    if (plan.snap) {
      // A freshly mounted strip must land on its glyph in the same frame, with
      // no transition: the transform also backs the `transition` in the
      // stylesheet, so writing it before paint is what avoids a visible roll
      // from zero when the card is expanded again.
      settle(plan.fresh)
      return cancel
    }
    const offsets = plan.offsets

    cancel()
    current.text = text
    current.digits = nextDigits
    setSpinning(true)
    setBlurred(false)

    // The travel starts from the position the settled strip is really at, read
    // back from the DOM: entering the target digit plus the signed distance it
    // still has to travel lands exactly there, with no layout guess.
    const startPositions = nextDigits.map((digit, index) => digit - offsets[index])
    let previousPositions = [...startPositions]
    let blurState = false
    const started = performance.now()
    const longest = REEL_MS + REEL_STAGGER_MS * Math.max(0, nextDigits.length - 1) + SPIN_MS

    const tick = (now) => {
      const elapsed = now - started
      const positions = nextDigits.map((digit, index) => {
        const from = startPositions[index]
        const travel = REEL_MS + REEL_STAGGER_MS * index
        const main = from + offsets[index] * easeOutCubic(clamp(elapsed / travel, 0, 1))
        // Spin past the target, then ease back — the mechanical overshoot.
        const spin = clamp((elapsed - travel) / SPIN_MS, 0, 1)
        const overshoot = (1 - easeOutCubic(spin)) * -Math.sign(offsets[index] || 1) * 0.34
        return main + overshoot
      })
      let travelled = 0
      for (let index = 0; index < positions.length; index += 1) {
        travelled += Math.abs(positions[index] - previousPositions[index])
      }
      previousPositions = positions
      // Only touch React when the blur state really flips: a setState per frame
      // is what made the spin stutter.
      const nextBlur = travelled * 60 > BLUR_VELOCITY * 3
      if (nextBlur !== blurState) {
        blurState = nextBlur
        setBlurred(nextBlur)
      }
      paint(positions)
      if (elapsed < longest) {
        current.raf = window.requestAnimationFrame(tick)
      } else {
        settle()
      }
    }
    current.raf = window.requestAnimationFrame(tick)
    return cancel
  }, [text, animate])

  // The ref callback keeps its own cleanup hook: React calls it when this exact
  // node detaches, which is the only moment we know the recorded node is gone.
  // (Identity is checked anyway, so a cleanup that runs after a newer node was
  // recorded cannot wipe the good one.)
  const cleaners = useRef([])
  const bind = useCallback((index, element) => {
    if (element === null || element === undefined) {
      elements.current[index] = null
      if (painted.current[index] !== null && painted.current[index] !== undefined) {
        // Detached before the cleaner could run: treat as never painted.
        painted.current[index] = null
      }
      return undefined
    }
    elements.current[index] = element
    const cleanup = () => {
      if (elements.current[index] === element) elements.current[index] = null
      if (painted.current[index] === element) painted.current[index] = null
    }
    cleaners.current[index] = cleanup
    return cleanup
  }, [])

  return { bind, spinning, blurred }
}

//#endregion

//#region canvas sparkline

/**
 * Draw the balance line: a ghost trail of earlier sweeps behind it, the live
 * trace on top, and one coloured segment per sample step so intensity reads
 * at a glance.
 *
 * @param {object} options - draw inputs.
 * @param {HTMLCanvasElement} options.canvas - target canvas.
 * @param {Array<{t: number, v: number}>} options.samples - history, oldest first.
 * @param {number} options.width - CSS width.
 * @param {number} options.height - CSS height.
 * @param {number} options.hoverIndex - highlighted sample, or -1.
 * @param {number} options.phase - 0..1 animation phase for the heartbeat pulse.
 * @param {number} options.scale - reference magnitude for the colour ramp.
 * @param {number} options.accent - CSS colour for the hover band.
 * @param {boolean} options.reduced - skip glow/ghost work entirely.
 */
function drawSpark(canvas, samples, width, height, hoverIndex, phase, scale, accent, reduced) {
  const context = canvas.getContext('2d')
  if (context === null) return
  const dpr = clamp(window.devicePixelRatio || 1, 1, 2)
  const pixelWidth = Math.max(1, Math.round(width * dpr))
  const pixelHeight = Math.max(1, Math.round(height * dpr))
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth
    canvas.height = pixelHeight
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0)
  context.clearRect(0, 0, width, height)

  const padTop = 5
  const padBottom = 5
  const usable = Math.max(1, height - padTop - padBottom)

  if (samples.length < 2) {
    context.strokeStyle = 'rgba(127, 127, 127, 0.28)'
    context.lineWidth = 1
    context.setLineDash([3, 4])
    context.beginPath()
    context.moveTo(2, height / 2)
    context.lineTo(width - 2, height / 2)
    context.stroke()
    context.setLineDash([])
    return
  }

  let min = Infinity
  let max = -Infinity
  for (const sample of samples) {
    if (sample.v < min) min = sample.v
    if (sample.v > max) max = sample.v
  }
  const flat = max - min < 1e-9
  const span = flat ? 1 : max - min
  // A flat balance parks in the middle instead of collapsing to a hard line.
  const yOf = (value) => padTop + usable - ((value - min) / span) * usable * (flat ? 0 : 1) - (flat ? usable / 2 : 0)
  const stepX = width / (samples.length - 1)
  const xOf = (index) => index * stepX
  const points = samples.map((sample, index) => ({ x: xOf(index), y: yOf(sample.v) }))

  const ramp = colorRamp(intensityOf(samples[samples.length - 1].v - samples[samples.length - 2].v, scale))

  // 1. Ghost trail: earlier traces, older = fainter and higher.
  if (!reduced) {
    const ghosts = [0.72, 0.5, 0.3]
    const lift = [1.6, 3.1, 4.6]
    for (let ghost = 0; ghost < ghosts.length; ghost += 1) {
      context.save()
      context.globalAlpha = ghosts[ghost] * 0.5
      context.strokeStyle = ramp.line
      context.lineWidth = 1
      context.beginPath()
      context.moveTo(points[0].x, points[0].y - lift[ghost])
      for (let index = 1; index < points.length; index += 1) {
        const previous = points[index - 1]
        const point = points[index]
        const midX = (previous.x + point.x) / 2
        context.bezierCurveTo(midX, previous.y - lift[ghost], midX, point.y - lift[ghost], point.x, point.y - lift[ghost])
      }
      context.stroke()
      context.restore()
    }
  }

  // 2. Soft area under the live trace.
  const area = context.createLinearGradient(0, 0, 0, height)
  area.addColorStop(0, ramp.soft)
  area.addColorStop(1, 'rgba(0, 0, 0, 0)')
  context.beginPath()
  context.moveTo(points[0].x, height)
  context.lineTo(points[0].x, points[0].y)
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]
    const point = points[index]
    const midX = (previous.x + point.x) / 2
    context.bezierCurveTo(midX, previous.y, midX, point.y, point.x, point.y)
  }
  context.lineTo(points[points.length - 1].x, height)
  context.closePath()
  context.fillStyle = area
  context.fill()

  // 3. Live trace, one coloured segment per step; the newest heartbeat glows.
  const heartbeat = reduced ? 0 : (1 - phase) * 6
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]
    const point = points[index]
    const delta = samples[index].v - samples[index - 1].v
    const severity = intensityOf(delta, scale)
    const colour = colorRamp(severity)
    const isLast = index === points.length - 1
    context.save()
    context.strokeStyle = colour.line
    context.lineWidth = 1.15 + severity * 1.1
    context.lineCap = 'round'
    if (!reduced && (severity > 0.5 || isLast)) {
      context.shadowColor = colour.glow
      context.shadowBlur = (severity * 9) + (isLast ? heartbeat : 0)
    }
    const midX = (previous.x + point.x) / 2
    context.beginPath()
    context.moveTo(previous.x, previous.y)
    context.bezierCurveTo(midX, previous.y, midX, point.y, point.x, point.y)
    context.stroke()
    context.restore()

    // A drop is marked: a short tick above the step plus a bright node.
    if (delta < -1e-9) {
      const mark = colorRamp(clamp(severity + 0.18, 0, 1))
      context.save()
      context.strokeStyle = mark.line
      context.globalAlpha = 0.55 + severity * 0.45
      context.lineWidth = 1
      context.beginPath()
      context.moveTo(point.x, point.y - 1.5)
      context.lineTo(point.x, Math.max(1, point.y - 5 - severity * 3))
      context.stroke()
      context.globalAlpha = 0.9
      context.fillStyle = mark.bright
      context.beginPath()
      context.arc(point.x, point.y, 1.5 + severity * 1.2, 0, Math.PI * 2)
      context.fill()
      context.restore()
    }
  }

  // 4. Head marker: current value with its own pulse ring.
  const head = points[points.length - 1]
  context.save()
  context.fillStyle = ramp.bright
  context.shadowColor = ramp.glow
  context.shadowBlur = reduced ? 0 : 8
  context.beginPath()
  context.arc(head.x, head.y, 2.6, 0, Math.PI * 2)
  context.fill()
  context.restore()
  if (!reduced) {
    context.save()
    context.strokeStyle = ramp.line
    context.globalAlpha = 0.18 + (1 - phase) * 0.32
    context.lineWidth = 1
    context.beginPath()
    context.arc(head.x, head.y, 3.4 + (1 - phase) * 5.2, 0, Math.PI * 2)
    context.stroke()
    context.restore()
  }

  // 5. Hover band + node.
  if (hoverIndex >= 0 && hoverIndex < points.length) {
    const point = points[hoverIndex]
    context.save()
    context.strokeStyle = accent
    context.globalAlpha = 0.18
    context.lineWidth = 1
    context.beginPath()
    context.moveTo(point.x, 0)
    context.lineTo(point.x, height)
    context.stroke()
    context.globalAlpha = 1
    context.fillStyle = accent
    context.beginPath()
    context.arc(point.x, point.y, 2.8, 0, Math.PI * 2)
    context.fill()
    context.restore()
  }
}

//#endregion

//#region widget

/**
 * The floating card itself.
 *
 * @param {{ sessionId?: string }} props - slot props; the session id is unused
 *   today but keeps the registration honest about which session it renders in.
 * @returns {import('react').ReactElement} the overlay element.
 */
function BalanceWidget(props) {
  void props
  const rootRef = useRef(null)
  const canvasRef = useRef(null)

  const initial = useMemo(loadStore, [])
  const [collapsed, setCollapsed] = useState(initial.collapsed)

  // Measure and clamping are plain closures created before any state: the
  // first-render placement below needs them, and a useCallback declared later
  // would still be in its temporal dead zone here.
  const measure = () => {
    const rect = rootRef.current?.getBoundingClientRect()
    return { width: rect?.width ?? (collapsed ? 110 : CARD_WIDTH), height: rect?.height ?? (collapsed ? 28 : CARD_HEIGHT) }
  }

  const clampToViewport = (x, y) => {
    const { width, height } = measure()
    const maxX = Math.max(EDGE_MARGIN, window.innerWidth - width - EDGE_MARGIN)
    const maxY = Math.max(EDGE_MARGIN, window.innerHeight - height - EDGE_MARGIN)
    return { x: clamp(x, EDGE_MARGIN, maxX), y: clamp(y, EDGE_MARGIN, maxY) }
  }

  const [store, setStore] = useState(initial)
  // Placement is decided on the very first render: a remembered spot, or the
  // bottom-right rest position. Waiting for a layout effect would flash an
  // empty frame on load.
  const [position, setPosition] = useState(() => (
    initial.x === null || initial.y === null
      ? restPositionFor(measure)
      : { x: initial.x, y: initial.y, placed: true }
  ))
  const [payload, setPayload] = useState(null)
  const [status, setStatus] = useState('loading')
  const [message, setMessage] = useState('正在读取余额…')
  const [dragging, setDragging] = useState(false)
  const [hover, setHover] = useState(-1)
  /** Which chip the pointer is over, for the floating hint instead of a title bubble. */
  const [hint, setHint] = useState(null)
  const [shake, setShake] = useState(0)
  const [pulse, setPulse] = useState(0)

  const dragRef = useRef(null)
  const shakeTimer = useRef(0)
  const pulseTimer = useRef(0)
  const lastViolence = useRef(0)
  const reduced = useMemo(() => (
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ), [])

  const samples = store.samples
  const scale = useMemo(() => violenceScale(samples), [samples])
  const current = samples.length > 0 ? samples[samples.length - 1].v : undefined
  const previous = samples.length > 1 ? samples[samples.length - 2].v : undefined
  const delta = current !== undefined && previous !== undefined ? current - previous : 0
  const intensity = intensityOf(delta, scale)
  const ramp = colorRamp(intensity)
  const currency = payload?.currency ?? 'CNY'
  const threshold = Number.isFinite(payload?.lowBalanceThreshold) ? payload.lowBalanceThreshold : 10
  const isLow = current !== undefined && current < threshold
  const amountText = current === undefined ? '—' : formatAmount(current)
  const { bind, spinning, blurred } = useReels(amountText, !reduced && status !== 'loading')

  // ---- polling ------------------------------------------------------------

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${BALANCE_PATH}?t=${Date.now()}`, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      })
      const body = await response.json()
      if (body === null || typeof body !== 'object' || body.ok !== true) {
        setStatus(body?.stale === true ? 'stale' : 'error')
        setMessage(typeof body?.message === 'string' ? body.message : '余额获取失败')
        return
      }
      const infos = Array.isArray(body.balanceInfos) ? body.balanceInfos : []
      const info = infos.find((item) => item.currency === 'CNY') ?? infos[0] ?? null
      const value = parseAmount(info?.totalBalance)
      setPayload({ ...body, info, currency: info?.currency ?? 'CNY', threshold })
      if (value === undefined) {
        setStatus('error')
        setMessage('接口没有返回可用的余额数字。')
        return
      }
      setStatus(body.stale === true ? 'stale' : 'ready')
      setMessage('')
      setStore((state) => {
        const last = state.samples[state.samples.length - 1]
        const now = Date.now()
        // Identical reading: keep the old sample, it carries the earlier time.
        if (last !== undefined && last.v === value) return state
        // Two readings closer than the pacing window replace one another, so a
        // burst of polls cannot flood the chart with near-duplicate points.
        if (last !== undefined && now - last.t < MIN_SAMPLE_GAP_MS) {
          const samples = state.samples.slice(0, -1)
          samples.push({ t: now, v: value })
          return { ...state, samples }
        }
        const samples = [...state.samples, { t: now, v: value }].slice(-HISTORY_LIMIT)
        return {
          ...state,
          samples,
          startedAt: state.startedAt ?? now,
          startBalance: state.startBalance ?? value,
        }
      })
    } catch (error) {
      setStatus('error')
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }, [threshold])

  useEffect(() => {
    let cancelled = false
    const run = () => {
      if (cancelled) return
      void refresh()
    }
    run()
    const timer = window.setInterval(run, POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') run()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  // ---- persistence --------------------------------------------------------

  useEffect(() => {
    saveStore({ ...store, x: position.x, y: position.y, collapsed })
  }, [store, position.x, position.y, collapsed])

  // ---- drop reaction ------------------------------------------------------

  useEffect(() => {
    if (status !== 'ready' || current === undefined || previous === undefined) return
    if (delta >= 0) {
      lastViolence.current = 0
      return
    }
    if (intensity < NORMALIZED_VIOLENCE || intensity <= lastViolence.current) return
    lastViolence.current = intensity
    if (reduced) return
    setShake((value) => value + 1)
    setPulse((value) => value + 1)
    window.clearTimeout(shakeTimer.current)
    shakeTimer.current = window.setTimeout(() => setShake(0), 460)
    window.clearTimeout(pulseTimer.current)
    pulseTimer.current = window.setTimeout(() => setPulse(0), 1400)
  }, [status, current, previous, delta, intensity, reduced])

  useEffect(() => () => {
    window.clearTimeout(shakeTimer.current)
    window.clearTimeout(pulseTimer.current)
  }, [])

  // ---- placement: first paint + resize ------------------------------------

  /** Where an unplaced card rests: clear of the corner, by the edge. */
  const restPosition = useCallback(() => restPositionFor(measure), [measure])

  useLayoutEffect(() => {
    setPosition((state) => {
      const next = clampToViewport(state.x, state.y)
      return next.x === state.x && next.y === state.y ? state : { ...next, placed: true }
    })
  }, [clampToViewport])

  useEffect(() => {
    const onResize = () => {
      setPosition((state) => {
        const next = clampToViewport(state.x, state.y)
        return next.x === state.x && next.y === state.y ? state : { ...next, placed: true }
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clampToViewport])

  // ---- drag + edge snapping ----------------------------------------------

  const onPointerDown = useCallback((event) => {
    const element = event.target
  if (element !== null && typeof element.closest === 'function' && element.closest('button') !== null) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const rect = rootRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: rect.left,
      originY: rect.top,
      moved: false,
    }
    setDragging(true)
    try {
      rootRef.current?.setPointerCapture(event.pointerId)
    } catch {
      // capture is best-effort
    }
  }, [])

  const onPointerMove = useCallback((event) => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
    const next = clampToViewport(drag.originX + dx, drag.originY + dy)
    setPosition({ ...next, placed: true })
  }, [clampToViewport])

  const endDrag = useCallback((event) => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    try {
      rootRef.current?.releasePointerCapture(event.pointerId)
    } catch {
      // already released
    }
    dragRef.current = null
    setDragging(false)
    const rect = rootRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    const distances = [
      { edge: 'left', distance: rect.left },
      { edge: 'right', distance: window.innerWidth - rect.right },
      { edge: 'top', distance: rect.top },
      { edge: 'bottom', distance: window.innerHeight - rect.bottom },
    ]
    const nearest = distances.reduce((best, item) => (item.distance < best.distance ? item : best))
    if (nearest.distance > SNAP_THRESHOLD) return
    let { x, y } = { x: rect.left, y: rect.top }
    if (nearest.edge === 'left') x = EDGE_MARGIN
    if (nearest.edge === 'right') x = window.innerWidth - rect.width - EDGE_MARGIN
    if (nearest.edge === 'top') y = EDGE_MARGIN
    if (nearest.edge === 'bottom') y = window.innerHeight - rect.height - EDGE_MARGIN
    const snapped = clampToViewport(x, y)
    setPosition({ ...snapped, placed: true })
  }, [clampToViewport])

  // ---- canvas animation ---------------------------------------------------

  const drawRef = useRef(() => {})
  drawRef.current = () => {
    const canvas = canvasRef.current
    if (canvas === null || collapsed) return
    // Measure instead of hardcoding: the compact card sizes the chart with CSS.
    const width = canvas.clientWidth || 150
    const height = canvas.clientHeight || 34
    const phase = reduced ? 1 : ((performance.now() % 1500) / 1500)
    // History can hold hundreds of samples; draw only what fits at a legible
    // density — the ghost trail is about shape, not about every point.
    drawSpark(canvas, thinSamples(samples, width), width, height, hover, phase, scale, ramp.line, reduced)
  }

  useEffect(() => {
    if (collapsed) return undefined
    let frame = 0
    const tick = () => {
      drawRef.current()
      // The chart is static between samples: a slow cadence keeps the idle
      // widget off the compositor instead of burning a frame every 16 ms.
      frame = window.setTimeout(tick, pulse > 0 ? 32 : 400)
    }
    tick()
    return () => window.clearTimeout(frame)
  }, [collapsed, pulse, samples, hover, scale, ramp.line, reduced])

  // ---- hover readout ------------------------------------------------------

  /**
   * Point the readout at the sample nearest a client x/y.
   *
   * @param {number} clientX - pointer x in client coordinates.
   * @param {number} clientY - pointer y in client coordinates.
   * @returns {boolean} true when the pointer is inside the chart's box.
   */
  const pointerToSample = useCallback((clientX, clientY) => {
    const canvas = canvasRef.current
    if (canvas === null) return false
    const rect = canvas.getBoundingClientRect()
    const inside = clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
    if (!inside || samples.length < 2) return false
    const ratio = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1)
    setHover(Math.round(ratio * (samples.length - 1)))
    return true
  }, [samples.length])

  const onCardMove = useCallback((event) => {
    if (!pointerToSample(event.clientX, event.clientY)) setHover(-1)
  }, [pointerToSample])

  const onCardLeave = useCallback(() => {
    setHover(-1)
    setHint(null)
  }, [])

  // ---- derived display ----------------------------------------------------

  const runway = runwayEstimate(samples, current, Date.now())
  const dotState = status === 'ready' ? (payload?.isAvailable === false ? 'bad' : 'ok') : status === 'stale' ? 'stale' : 'bad'
  const hovered = hover >= 0 && hover < samples.length ? samples[hover] : null
  const tipOnLeft = (position.x ?? 0) > window.innerWidth / 2
  const tipOnTop = (position.y ?? 0) > window.innerHeight / 2

  const reels = useMemo(() => {
    const nodes = []
    let reelIndex = 0
    for (const item of glyphPlan(amountText)) {
      if (item.kind === 'reel') {
        const index = reelIndex
        reelIndex += 1
        const glyphs = DIGIT_GLYPHS.map((glyph, glyphIndex) => h('span', {
          key: glyphIndex,
          className: 'dsb-glyph',
        }, glyph))
        const strip = h('span', {
          key: 'strip',
          className: 'dsb-reel-inner',
          'data-spin': blurred ? 'true' : 'false',
          ref: (element) => bind(index, element),
        }, glyphs)
        nodes.push(h('span', {
          key: `r${index}`,
          className: 'dsb-reel',
          style: { width: '0.62em' },
        }, strip))
      } else {
        nodes.push(h('span', {
          key: `t${nodes.length}`,
          className: item.value === '.' ? 'dsb-glyph-dot' : undefined,
        }, item.value))
      }
    }
    return nodes
  }, [amountText, bind, blurred])

  if (position.x === null) return null

  const rootStyle = { left: `${position.x}px`, top: `${position.y}px` }
  const rootDataset = {
    dragging: dragging ? 'true' : 'false',
    low: isLow ? 'true' : 'false',
    reduced: reduced ? 'true' : 'false',
  }
  const cardStyle = {
    '--dsb-heat': ramp.line,
    '--dsb-heat-soft': ramp.soft,
    '--dsb-heat-glow': ramp.glow,
  }

  const head = h('div', { className: 'dsb-head' }, [
    h('span', { key: 'dot', className: 'dsb-dot', 'data-state': dotState }),
    h('span', { key: 'label', className: 'dsb-label' },
      isLow ? 'DeepSeek 余额 · 偏低' : 'DeepSeek 余额'),
    h('div', { key: 'actions', className: 'dsb-actions' }, [
      h('button', {
        key: 'collapse',
        type: 'button',
        className: 'dsb-icon dsb-collapse',
        'aria-label': collapsed ? '展开余额卡片' : '收起为小胶囊',
        onClick: () => setCollapsed((value) => !value),
      }, collapsed ? '▴' : '▾'),
      h('button', {
        key: 'refresh',
        type: 'button',
        className: 'dsb-icon',
        'aria-label': '立即刷新余额',
        'data-spinning': status === 'loading' ? 'true' : 'false',
        onClick: () => {
          setStatus('loading')
          void refresh()
        },
      }, '↻'),
    ]),
  ])

  if (collapsed) {
    return h('div', {
      ref: rootRef,
      className: 'dsb-root',
      style: rootStyle,
      ...rootDataset,
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onPointerLeave: onCardLeave,
      'aria-label': 'DeepSeek 余额挂件',
    }, h('div', { className: 'dsb-card dsb-pill', style: cardStyle }, [
      h('span', { key: 'dot', className: 'dsb-dot', 'data-state': dotState }),
      h('span', { key: 'reels', className: 'dsb-reels' }, reels),
      h('span', { key: 'cur', className: 'dsb-currency' }, currency),
      h('button', {
        key: 'expand',
        type: 'button',
        className: 'dsb-icon dsb-collapse',
        'aria-label': '展开余额卡片',
        onClick: () => setCollapsed(false),
      }, '▴'),
    ]))
  }

  const cardClass = `dsb-card${shake > 0 ? ' dsb-shake' : ''}${pulse > 0 ? ' dsb-pulse' : ''}`

  // The chart is the card's background layer, so the digits sit on top of it
  // instead of being pushed around by it.
  const backdrop = h('div', { key: 'backdrop', className: 'dsb-backdrop' }, [
    h('canvas', {
      key: 'spark',
      ref: canvasRef,
      className: 'dsb-spark',
      'aria-label': '余额变化折线',
    }),
    h('div', { key: 'scrim', className: 'dsb-scrim' }),
  ])

  const foot = h('div', { className: 'dsb-foot' }, [
    runway !== null
      ? h('span', {
        key: 'runway',
        className: 'dsb-foot-item',
        onPointerEnter: () => setHint(`按最近观测的消耗速率 ¥${runway.ratePerHour.toFixed(4)}/小时 估算`),
        onPointerLeave: () => setHint(null),
      }, [
        h('span', { key: 'k' }, '还能撑'),
        h('span', { key: 'v', className: 'dsb-foot-value' }, formatRunway(runway) ?? '—'),
      ])
      : h('span', { key: 'idle', className: 'dsb-foot-item' }, '采样中…'),
    h('span', {
      key: 'time',
      className: 'dsb-foot-time',
      onPointerEnter: () => setHint(payload?.fetchedAt
        ? `上次成功读取：${clockTime(payload.fetchedAt)}`
        : '还没有成功读过余额'),
      onPointerLeave: () => setHint(null),
    }, status === 'ready'
      ? relativeTime(Date.now() - (payload?.fetchedAt ?? Date.now()))
      : status === 'stale' ? '数据滞后' : '离线'),
  ])

  // Over the chart the footer becomes a readout of the pointed-at sample, in
  // place and at a fixed height, so nothing above it moves.
  const readout = hovered === null
    ? foot
    : h('div', { className: 'dsb-readout' }, [
      h('span', { key: 'v', className: 'dsb-readout-value' }, formatAmount(hovered.v)),
      h('span', { key: 't' }, clockTime(hovered.t)),
      hover > 0
        ? h('span', { key: 'd', className: 'dsb-readout-delta' },
          `${hovered.v - samples[hover - 1].v >= 0 ? '+' : ''}${(hovered.v - samples[hover - 1].v).toFixed(2)}`)
        : null,
    ])

  const content = h('div', { key: 'content', className: 'dsb-content' }, [
    head,
    h('div', { key: 'value', className: 'dsb-value' }, [
      h('span', { key: 'reels', className: 'dsb-reels' }, reels),
      h('span', { key: 'cur', className: 'dsb-currency' }, currency),
      delta !== 0 && status === 'ready'
        ? h('span', { key: 'delta', className: 'dsb-delta' }, `${delta > 0 ? '+' : ''}${delta.toFixed(2)}`)
        : null,
    ]),
    message !== '' ? h('div', {
      key: 'msg',
      className: 'dsb-msg',
      'data-error': status === 'error' ? 'true' : 'false',
    }, message) : null,
    readout,
  ])

  // A hint is a layer over the card, never a native title bubble: those are
  // drawn by the browser, unstyleable, and land on the digits.
  const hintLayer = hint === null ? null : h('div', { key: 'hint', className: 'dsb-hint' }, hint)

  return h('div', {
    ref: rootRef,
    className: 'dsb-root',
    style: rootStyle,
    ...rootDataset,
    onPointerDown,
    onPointerMove: (event) => {
      onPointerMove(event)
      onCardMove(event)
    },
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onPointerLeave: onCardLeave,
    'aria-label': 'DeepSeek 账户余额挂件',
  }, [
    h('div', { key: 'card', className: cardClass, style: cardStyle }, [backdrop, content, hintLayer]),
  ])
}

//#endregion

/**
 * Client plugin body: claim one seat on the shell overlay layer.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - client root context.
 */
function apply(ctx) {
  const removeStyle = adoptStyles()
  ctx.effect(() => () => removeStyle(), 'dsh-balance: stylesheet')

  const slots = ctx.slots
  if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
    ctx.logger?.warn?.('[dsh-balance] slots 服务不可用，挂件未注册')
    return
  }

  ctx.effect(() => slots.inject('shell.overlay', () => slots.register({
    name: 'shell.overlay',
    id: PLUGIN_ID,
    order: 90,
    label: 'DeepSeek 余额',
  }, (props) => h(BalanceWidget, props))), 'dsh-balance: overlay registration')
}

const inject = ['slots']

exports.apply = apply;
exports.inject = inject;
exports.BalanceWidget = BalanceWidget;
		return module.exports;
	}
});
