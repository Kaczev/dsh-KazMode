/**
 * Build a self-contained preview page for the widget's visual halves, using the
 * REAL shipped code: the stylesheet is lifted from `lib/client.js` and the
 * canvas painter is serialised from the same bundle and run against a genuine
 * `<canvas>` in the browser.
 *
 *   node scripts/preview.mjs && msedge --headless --screenshot=...
 *
 * Output (git-ignored): dev/preview.html
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

/** Pull one top-level declaration out of the bundle by brace matching. */
function extract(needle) {
  const start = source.indexOf(needle)
  if (start === -1) throw new Error(`preview: could not find ${needle}`)
  let depth = 0
  let index = source.indexOf('{', start)
  for (; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`preview: unbalanced braces for ${needle}`)
}

/** Pull a top-level `const NAME = <literal>` out of the bundle. */
function extractConst(name) {
  const match = source.match(new RegExp(`^const ${name} = [^\\n]+$`, 'm'))
  if (match === null) throw new Error(`preview: could not find const ${name}`)
  return match[0]
}

const constants = ['MIN_VIOLENCE_SCALE', 'BIG_MOVE_FRACTION', 'MIN_PX_PER_SAMPLE', 'DIGIT_GLYPHS'].map(extractConst)

const cssMatch = source.match(/const CSS = `([\s\S]*?)`\n/)
if (cssMatch === null) throw new Error('preview: the CSS template literal moved')

const painterNames = [
  'function clamp(',
  'function easeOutCubic(',
  'function intensityOf(',
  'function colorRamp(',
  'function violenceScale(',
  'function thinSamples(',
  'function drawSpark(',
]
const painterSource = [...constants, ...painterNames.map((name) => extract(name))].join('\n\n')

const scene = (name, samples, note) => ({ name, note, samples })
const now = Date.now()
const series = (start, drops) => {
  const out = []
  let value = start
  for (let index = 0; index < 60; index += 1) {
    const step = drops[index] ?? 0
    value = Number((value - step).toFixed(4))
    out.push({ t: now - (60 - index) * 2400, v: value })
  }
  return out
}

const scenes = [
  scene('平稳（灰色 / 青绿）', series(47.05, Array.from({ length: 60 }, (_, index) => (index > 40 ? 0.002 : 0))),
    '几乎不动时折线收敛成低饱和冷色'),
  scene('正常消耗（绿色）', series(47.05, Array.from({ length: 60 }, (_, index) => (index > 20 ? 0.01 : 0))),
    '小幅下降是绿色，阶梯处有下降标记'),
  scene('明显消耗（琥珀 → 橙）', series(47.05, Array.from({ length: 60 }, (_, index) => (index > 30 && index % 6 === 0 ? 0.18 : 0))),
    '中等幅度变琥珀色，越猛越偏橙红'),
  scene('剧烈消耗（红色，会抖动）', series(47.05, Array.from({ length: 60 }, (_, index) => {
    if (index === 57) return 1.9
    if (index === 58) return 2.6
    if (index === 59) return 3.4
    if (index > 40 && index % 5 === 0) return 0.4
    return 0
  })), '最近三次猛掉：整卡抖动 + 水波纹 + 曲线发红光'),
  scene('余额偏低（呼吸红光）', series(6.4, Array.from({ length: 60 }, (_, index) => (index > 45 ? 0.03 : 0))),
    '低于阈值时整卡呼吸式红晕'),
]

// The cards are assembled in the page, because the heat colour comes from the
// same colorRamp()/intensityOf() the widget uses — a hardcoded preview colour
// would hide the very thing the ramp exists to show.
const pillHtml = `
  <figure class="demo">
    <figcaption class="demo-cap"><b>收起胶囊</b><span>点 ▾ 折起来，只留数字和状态点</span></figcaption>
    <div class="dsb-root" style="left:0;top:0;position:relative">
      <div class="dsb-card dsb-pill" style="--dsb-heat:#22c55e">
        <span class="dsb-dot" data-state="ok"></span>
        <span class="dsb-reels">47.0500</span>
        <span class="dsb-currency">CNY</span>
        <button class="dsb-icon dsb-collapse" type="button">▴</button>
      </div>
    </div>
  </figure>`

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>dsh-deepseek-balance 预览</title>
<style>
  :root {
    --dsw-alias-bg-overlay: rgba(255,255,255,.94);
    --dsw-alias-label-primary: #1f2328;
    --dsw-alias-label-secondary: #6b7280;
    --dsw-alias-label-tertiary: #9ca3af;
    --dsw-alias-border-l2: rgba(0,0,0,.08);
    --dsw-alias-border-l3: rgba(0,0,0,.12);
    --dsw-alias-interactive-bg-hover: rgba(0,0,0,.06);
    --dsw-static-neutral-bluish-400: #4d6bfe;
    --dsw-font-family: Inter, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    --dsw-elevation-prominent: 0 10px 32px rgba(0,0,0,.16), 0 2px 8px rgba(0,0,0,.08);
    --dsw-specific-menu: rgba(255,255,255,.97);
  }
  body {
    margin: 0;
    padding: 28px 32px 40px;
    background: #f6f7f9;
    color: #1f2328;
    font-family: var(--dsw-font-family);
  }
  h1 { font-size: 16px; font-weight: 600; margin: 0 0 4px; }
  p.lede { margin: 0 0 22px; font-size: 12px; color: #6b7280; }
  .stage { display: flex; flex-wrap: wrap; gap: 18px; align-items: flex-start; }
  .demo { margin: 0; }
  .demo-cap { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; }
  .demo-cap b { font-size: 12px; font-weight: 600; }
  .demo-cap span { font-size: 11px; color: #6b7280; }
</style>
<style>${cssMatch[1]}</style>
</head>
<body>
<h1>dsh-deepseek-balance · 挂件外观预览</h1>
<p class="lede">这一页用的是插件真正发布的 CSS 与 canvas 绘制函数（从 lib/client.js 抽出），不是重画的示意稿。</p>
<div class="stage" id="stage">${pillHtml}</div>
<script>
const SCENES = ${JSON.stringify(scenes.map((item) => item.samples))};
const SCENE_NAMES = ${JSON.stringify(scenes.map((item) => item.name))};
${painterSource}

const pageErrors = [];
window.addEventListener('error', (event) => pageErrors.push(String(event.message)));

const SCENE_NOTES = ${JSON.stringify(scenes.map((item) => item.note))};
const DIGITS = '0123456789'.split('');

/** The card markup, holding the shipped class names and CSS variables. */
function cardHtml(item, index, ramp, isLow) {
  const last = item.samples[item.samples.length - 1];
  const previous = item.samples[item.samples.length - 2];
  const delta = last.v - previous.v;
  // Two decimals, exactly as the widget formats it.
  const reels = last.v.toFixed(2).split('').map((char) => (char >= '0' && char <= '9'
    ? '<span class="dsb-reel" style="width:.62em"><span class="dsb-reel-inner">'
      + DIGITS.map((glyph) => '<span class="dsb-glyph">' + glyph + '</span>').join('') + '</span></span>'
    : '<span class="' + (char === '.' ? 'dsb-glyph-dot' : '') + '">' + char + '</span>')).join('');
  return ''
    + '<figure class="demo">'
    + '<figcaption class="demo-cap"><b>' + item.name + '</b><span>' + SCENE_NOTES[index] + '</span></figcaption>'
    + '<div class="dsb-root" data-low="' + (isLow ? 'true' : 'false') + '" style="left:0;top:0;position:relative">'
    + '<div class="dsb-card" data-scene="' + index + '" style="--dsb-heat:' + ramp.line
    + ';--dsb-heat-soft:' + ramp.soft + ';--dsb-heat-glow:' + ramp.glow + '">'
    // The chart is the backdrop; the readout sits on top of it.
    + '<div class="dsb-backdrop"><canvas class="dsb-spark" data-scene="' + index + '"></canvas>'
    + '<div class="dsb-scrim"></div></div>'
    + '<div class="dsb-content">'
    + '<div class="dsb-head"><span class="dsb-dot" data-state="' + (isLow ? 'bad' : 'ok') + '"></span>'
    + '<span class="dsb-label">' + (isLow ? 'DeepSeek 余额 · 偏低' : 'DeepSeek 余额') + '</span>'
    + '<div class="dsb-actions"><button class="dsb-icon dsb-collapse" type="button">▾</button>'
    + '<button class="dsb-icon" type="button">↻</button></div></div>'
    + '<div class="dsb-value"><span class="dsb-reels">' + reels + '</span>'
    + '<span class="dsb-currency">CNY</span>'
    + (delta !== 0 ? '<span class="dsb-delta">' + (delta > 0 ? '+' : '') + delta.toFixed(2) + '</span>' : '')
    + '</div>'
    + '<div class="dsb-foot">'
    + '<span class="dsb-foot-item"><span>还能撑</span><span class="dsb-foot-value">'
    + (index === 0 ? '采样中…' : (3 + index * 1.7).toFixed(1) + ' 天') + '</span></span>'
    + '<span class="dsb-foot-time">3 秒前</span></div>'
    + '</div></div></div></figure>';
}

const stage = document.getElementById('stage');
for (let index = 0; index < SCENES.length; index += 1) {
  const samples = SCENES[index];
  const scale = violenceScale(samples);
  const last = samples[samples.length - 1];
  const ramp = colorRamp(intensityOf(last.v - samples[samples.length - 2].v, scale));
  stage.insertAdjacentHTML('beforeend', cardHtml({ name: SCENE_NAMES[index], samples }, index, ramp, last.v < 10));
}

const scenes = [];
for (const canvas of document.querySelectorAll('canvas[data-scene]')) {
  const index = Number(canvas.dataset.scene);
  const samples = SCENES[index];
  // Exactly what the widget does: normalise against the history's own moves,
  // and thin the series to the width this card actually has.
  const scale = violenceScale(samples);
  const cssWidth = canvas.clientWidth || 150;
  const cssHeight = canvas.clientHeight || 34;
  drawSpark(canvas, thinSamples(samples, cssWidth), cssWidth, cssHeight, -1, 0.35, scale, '#4d6bfe', false);

  // Decode what was actually painted: a chart that silently draws nothing, or
  // draws in the wrong colour band, must fail loudly instead of looking fine.
  const context = canvas.getContext('2d');
  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
  let painted = 0, minX = width, maxX = -1, minY = height, maxY = -1, top = 0, bottom = 0;
  const bands = { warm: 0, teal: 0, green: 0, other: 0 };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const alpha = data[at + 3];
      if (alpha < 12) continue;
      const r = data[at], g = data[at + 1], b = data[at + 2];
      painted += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (y < height / 2) top += 1; else bottom += 1;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      if (max - min < 18) continue;
      let hue;
      if (max === r) hue = ((g - b) / (max - min) + 6) % 6;
      else if (max === g) hue = (b - r) / (max - min) + 2;
      else hue = (r - g) / (max - min) + 4;
      hue *= 60;
      if (hue >= 300 || hue < 25) bands.warm += 1;
      else if (hue >= 160 && hue < 200) bands.teal += 1;
      else if (hue >= 100 && hue < 160) bands.green += 1;
      else bands.other += 1;
    }
  }
  const dominant = Object.entries(bands).sort((a, b) => b[1] - a[1])[0];
  scenes.push({
    index,
    name: SCENE_NAMES[index],
    painted,
    bbox: maxX < 0 ? 'none' : [minX, minY, maxX, maxY].join(','),
    width: maxX - minX + 1,
    canvasWidth: width,
    vertical: top > 0 && bottom > 0 ? 'gradient' : 'flat',
    dominant: dominant[0] + '(' + dominant[1] + ')',
    bands,
  });
}

// The verdict goes to a collector (Chromium's stdout is unusable here) and is
// also drawn on the page, so the screenshot carries it for a human glance.
document.body.insertAdjacentHTML('afterbegin',
  '<pre id="report" style="white-space:pre-wrap;font:11px/1.6 monospace;background:#0f172a;color:#e2e8f0;padding:14px 16px;border-radius:10px;margin:0 0 22px">'
  + scenes.map((scene) => ['SCENE ' + scene.index, 'painted=' + scene.painted, 'bbox=' + scene.bbox,
      'dominant=' + scene.dominant, 'bands=' + JSON.stringify(scene.bands), scene.name].join(' | ')).join('\\n')
  + '</pre>');

const payload = JSON.stringify({ scenes, errors: pageErrors, size: [window.innerWidth, window.innerHeight] });
const send = () => fetch('/report', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: payload,
}).catch(() => {});
// Sent immediately and again a moment later: a headless run may tear the page
// down before the first request leaves the browser.
send();
setTimeout(send, 1200);
</script>
</body>
</html>
`

mkdirSync(join(root, 'dev'), { recursive: true })
writeFileSync(join(root, 'dev', 'preview.html'), html)
console.log(`dsh-deepseek-balance: wrote dev/preview.html (${html.length} B)`)
