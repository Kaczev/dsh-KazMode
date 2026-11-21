#!/usr/bin/env node
/*
  icon-craft scripts/icons.mjs - real brand, file-type, and interface SVG icon resolver.
  Adapted from Leonxlnx/taste-skill (MIT License) for DeepSeek Harness & KazMode.

  Every icon comes from a pinned source on cdn.jsdelivr.net, is cached in the OS temp folder, and is either:
  - emitted directly as self-contained HTML markup with `--inline` (ideal for single-file HTML proposals), or
  - written as local SVG files into `--out <dir>` with an `icons-credits.json` manifest beside them.

  Commands:
    node <skill>/scripts/icons.mjs find google docs
    node <skill>/scripts/icons.mjs apps [--tag storage]
    node <skill>/scripts/icons.mjs list [--set logos|si|file|ui] [--tag storage] [--tags]
    node <skill>/scripts/icons.mjs fetch google-docs slack file:pdf2 ui:arrow-right --inline [--tile] [--size 24]
    node <skill>/scripts/icons.mjs fetch google-docs slack file:pdf2 ui:arrow-right --out assets/icons [--base assets/icons]
    node <skill>/scripts/icons.mjs scan index.html --out assets/icons
    node <skill>/scripts/icons.mjs check

  Sets (all pinned):
    logos  Gil Barbara's SVG Logos (CC0-1.0), ~1,500 full-colour brand marks (first choice)
    si     Simple Icons 16.30.0 (CC0-1.0), single-colour marks in brand hex (fallback where no colour mark exists)
    file   Iconify vscode-icons 1.2.30 (MIT), full-colour document and file-type icons
    ui     Iconify lucide 1.2.100 (ISC), clean single-weight interface line glyphs in currentColor

  Single-process Node execution only (no child processes or named pipes), compatible with confined Windows sandboxes.
*/
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.resolve(HERE, '..', 'assets', 'index.json');
const LOGOS_SHA = 'd6960edc1b7309d392c76e40d3a320df7f9ff85c';
const CDN = 'https://cdn.jsdelivr.net/npm/';
const GH = 'https://cdn.jsdelivr.net/gh/gilbarbara/logos@' + LOGOS_SHA + '/';
const SETS = {
  logos: {
    pkg: 'gilbarbara/logos',
    ver: LOGOS_SHA,
    label: 'SVG Logos (Gil Barbara)',
    kind: 'colour',
    licence: 'CC0-1.0',
    author: 'Gil Barbara',
    url: 'https://github.com/gilbarbara/logos',
    terms: 'CC0 covers the drawings as collected (LICENSE.txt at the pinned commit). Each mark remains the trademark of its owner: nominative use only, never to imply endorsement.',
  },
  file: {
    pkg: '@iconify-json/vscode-icons',
    ver: '1.2.30',
    label: 'VSCode Icons',
    kind: 'colour',
    licence: 'MIT',
    author: 'Roberto Huertas',
    url: 'https://github.com/vscode-icons/vscode-icons',
    prefixes: ['file-type-', 'default-', 'folder-type-'],
  },
  ui: {
    pkg: '@iconify-json/lucide',
    ver: '1.2.100',
    label: 'Lucide',
    kind: 'line',
    licence: 'ISC',
    author: 'Lucide Contributors',
    url: 'https://github.com/lucide-icons/lucide',
  },
  si: {
    pkg: 'simple-icons',
    ver: '16.30.0',
    label: 'Simple Icons',
    kind: 'mono',
    licence: 'CC0-1.0',
    author: 'Simple Icons Collaborators',
    url: 'https://github.com/simple-icons/simple-icons',
    terms: 'CC0 covers the drawings. Single-colour mark painted in the brand hex, used only where no full-colour mark exists. Nominative trademark use only.',
  },
};
const ALIAS = { vscode: 'file', lucide: 'ui', logo: 'logos', gilbarbara: 'logos', simple: 'si' };
const REMOVED = ['brands', 'brand', 'thesvg'];
const logoListUrl = () => GH + 'logos.json';
const logoFileUrl = (n) => GH + 'logos/' + n + '.svg';
const siData = () => `${CDN}simple-icons@${SETS.si.ver}/data/simple-icons.json`;
const siIcon = (s) => `${CDN}simple-icons@${SETS.si.ver}/icons/${s}.svg`;
const setJson = (s) => `${CDN}${SETS[s].pkg}@${SETS[s].ver}/icons.json`;

const CACHE = path.resolve(
  process.env.ICON_CRAFT_CACHE || process.env.TASTE_SKILL_ICON_CACHE || path.join(os.tmpdir(), 'kaz-icon-craft-cache'),
);
const argv = process.argv.slice(2);
const valueFlags = new Set(['out', 'set', 'tag', 'size', 'limit', 'base']);
const flag = (k) => argv.includes('--' + k);
const opt = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const positional = () =>
  argv
    .slice(1)
    .filter((a, i, arr) => !a.startsWith('--') && !valueFlags.has((arr[i - 1] || '').replace(/^--/, '')));

async function fetchCached(url) {
  fs.mkdirSync(CACHE, { recursive: true });
  const f = path.join(CACHE, url.replace(/^https:\/\//, '').replace(/[^a-z0-9.@-]+/gi, '_'));
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const t = await r.text();
  fs.writeFileSync(f, t);
  return t;
}

let noCrop = false;
const memo = {};
const loadIndex = () => JSON.parse(fs.readFileSync(INDEX, 'utf8'));
const loadBoxes = () => (memo.boxes ||= (() => { try { return loadIndex().boxes || {}; } catch { return {}; } })());
const iconify = async (s) => (memo[s] ||= JSON.parse(await fetchCached(setJson(s))));
const logoIndex = async () => (memo.logos ||= JSON.parse(await fetchCached(logoListUrl())));
const logoNames = async () =>
  (memo.logoNames ||= (await logoIndex()).flatMap((b) => b.files.map((f) => ({ key: f.replace(/\.svg$/, ''), brand: b }))));

function rawLogo(text) {
  const t = text
    .replace(/<\?xml[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->|<metadata[\s\S]*?<\/metadata>|<title>[\s\S]*?<\/title>|<desc>[\s\S]*?<\/desc>/gi, '')
    .trim();
  const root = t.match(/<svg\b([^>]*)>/i);
  if (!root) throw new Error('not an svg');
  const num = (k) => {
    const m = root[1].match(new RegExp('\\s' + k + '="\\s*([-\\d.]+)'));
    return m ? +m[1] : null;
  };
  const vbm = root[1].match(/viewBox="([^"]+)"/i);
  let vb = vbm ? vbm[1].trim().split(/[\s,]+/).map(Number) : null;
  if (!vb || vb.length !== 4 || vb.some((n) => !isFinite(n))) vb = [0, 0, num('width') || 24, num('height') || 24];
  const body = t.slice(root.index + root[0].length, t.lastIndexOf('</svg>')).trim();
  return { body, width: vb[2], height: vb[3], left: vb[0], top: vb[1], xlink: /xlink:/.test(body) };
}

const siList = async () => (memo.si ||= ((j) => (Array.isArray(j) ? j : j.icons))(JSON.parse(await fetchCached(siData()))));
const siSlug = (t) =>
  t.slug ||
  t.title
    .toLowerCase()
    .replace(/\+/g, 'plus')
    .replace(/\./g, 'dot')
    .replace(/&/g, 'and')
    .normalize('NFD')
    .replace(/[^a-z0-9]/g, '');
const clean = (s) => s.replace(/[^a-z0-9._-]/gi, '');

function iconifyKey(set, j, name) {
  const cands = [name, ...(SETS[set].prefixes || []).map((p) => (name.startsWith(p) ? name : p + name))];
  for (const k of cands) {
    if (j.icons[k]) return { key: k, icon: j.icons[k] };
    const parent = j.aliases?.[k]?.parent;
    if (parent && j.icons[parent]) return { key: parent, icon: j.icons[parent] };
  }
  return null;
}

function colours(body) {
  const out = [];
  for (const m of body.matchAll(/(?:fill|stroke|stop-color)\s*[=:]\s*["']?\s*(#[0-9a-f]{3,8}|[a-z]+)/gi)) out.push(m[1].toLowerCase());
  return out;
}

const rgb = (h) => {
  const n = { white: 'ffffff', black: '000000' }[h] || h.replace('#', '');
  if (!/^[0-9a-f]{3,8}$/.test(n)) return null;
  const f = n.length <= 4 ? n.split('').slice(0, 3).map((c) => c + c).join('') : n.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16));
};

function tone(body) {
  if (/gradient|<image|<filter/i.test(body)) return '';
  const raw = colours(body).filter((c) => c !== 'none' && c !== 'currentcolor' && c !== 'url');
  const cs = raw.map(rgb);
  if (cs.some((c) => !c)) return '';
  if (!cs.length) return /<path|<rect|<circle/.test(body) && !/fill="none"/.test(body) ? 'ink' : '';
  const grey = (c) => Math.max(...c) - Math.min(...c) < 36;
  if (cs.every((c) => grey(c) && Math.max(...c) < 90)) return 'ink';
  if (cs.every((c) => grey(c) && Math.min(...c) > 225)) return 'paper';
  return '';
}

function violetShare(body) {
  const cs = colours(body).map(rgb).filter((c) => c && Math.max(...c) - Math.min(...c) >= 36);
  if (!cs.length) return 0;
  const isV = ([r, g, b]) => {
    const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255, d = mx - mn, l = (mx + mn) / 2;
    if (!d) return false;
    const sat = d / (1 - Math.abs(2 * l - 1));
    const h =
      mx * 255 === r
        ? ((g - b) / 255 / d + (g < b ? 6 : 0)) * 60
        : mx * 255 === g
          ? ((b - r) / 255 / d + 2) * 60
          : ((r - g) / 255 / d + 4) * 60;
    return h >= 240 && h <= 312 && sat > 0.25 && l > 0.3 && l < 0.88;
  };
  return cs.filter(isV).length / cs.length;
}
const violet = (body) => violetShare(body) >= 0.5;
const isPaper = (v) => {
  const c = rgb(String(v).trim().toLowerCase());
  return !!c && Math.min(...c) >= 235;
};
const hasPaper = (svg) => [...svg.matchAll(/\sfill="([^"]*)"/gi)].some((m) => isPaper(m[1]));
const hasInk = (svg) => [...svg.matchAll(/\sfill="([^"]*)"/gi)].some((m) => !/^(none|currentcolor)$/i.test(m[1]) && !isPaper(m[1]));
const lum = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;

function paperTest(svg) {
  const first = [...svg.matchAll(/\sfill="([^"]*)"/gi)].map((m) => rgb(m[1].trim().toLowerCase())).find(Boolean);
  const dark = first && lum(first) <= 0.15;
  return (v) => {
    if (isPaper(v)) return true;
    const c = dark && rgb(String(v).trim().toLowerCase());
    return !!c && lum(c) >= 0.45;
  };
}

function monoSvg(svg, key = 'm') {
  if (/<mask|<filter|<image|<style|\sstyle="(?![^"]*fill)/i.test(svg)) return null;
  let s = svg.replace(/\sstyle="[^"]*"/gi, '');
  const paper = paperTest(s);
  const knocks = [...s.matchAll(/\sfill="([^"]*)"/gi)].map((m) => m[1]);
  if (knocks.some(paper) && knocks.some((v) => !/^(none|currentcolor)$/i.test(v) && !paper(v))) {
    const root = s.match(/^<svg[^>]*>/)[0];
    const vb = (root.match(/viewBox="([^"]+)"/) || [])[1];
    if (!vb) return null;
    const [x, y, w, h] = vb.split(/[\s,]+/).map(Number);
    const inner = s
      .slice(root.length, s.lastIndexOf('</svg>'))
      .replace(/\s(fill|stroke)="([^"]*)"/gi, (m, k, v) => (/^none$/i.test(v) ? m : ' ' + k + '="' + (paper(v) ? '#000' : '#fff') + '"'));
    const id = 'k-' + String(key).replace(/[^a-z0-9]/gi, '');
    const root2 = root.replace(/\sfill="[^"]*"/, '');
    return (
      root2 +
      '<defs><mask id="' + id + '" maskUnits="userSpaceOnUse" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '"><g fill="#fff">' +
      inner +
      '</g></mask></defs><rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="currentColor" mask="url(#' + id + ')"/></svg>'
    );
  }
  s = s.replace(/\s(fill|stroke)="(?!none")[^"]*"/gi, (m, k) => ` ${k}="currentColor"`);
  if (!/^<svg[^>]*\sfill=/.test(s)) s = s.replace(/^<svg /, '<svg fill="currentColor" ');
  return s;
}

function contentBox(body) {
  if (/\stransform=|<use|<image|<text|<mask|<clipPath|<filter/i.test(body)) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
  const pt = (x, y) => {
    if (isFinite(x) && isFinite(y)) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      n++;
    }
  };
  const attr = (src, k) => +((src.match(new RegExp('\\s' + k + '="([-\\d.]+)"')) || [])[1] || 0);
  for (const m of body.matchAll(/<path\b[^>]*?\sd="([^"]+)"/g)) {
    let cx = 0, cy = 0, sx = 0, sy = 0;
    for (const seg of m[1].matchAll(/([a-zA-Z])([^a-zA-Z]*)/g)) {
      const c = seg[1], r = c === c.toLowerCase();
      const v = (seg[2].match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || []).map(Number);
      const L = c.toLowerCase();
      if (L === 'z') { cx = sx; cy = sy; continue; }
      const take = (k, f) => { for (let i = 0; i + k <= v.length; i += k) f(v.slice(i, i + k)); };
      if (L === 'm') take(2, (a) => { cx = r ? cx + a[0] : a[0]; cy = r ? cy + a[1] : a[1]; sx = cx; sy = cy; pt(cx, cy); });
      else if (L === 'l' || L === 't') take(2, (a) => { cx = r ? cx + a[0] : a[0]; cy = r ? cy + a[1] : a[1]; pt(cx, cy); });
      else if (L === 'h') take(1, (a) => { cx = r ? cx + a[0] : a[0]; pt(cx, cy); });
      else if (L === 'v') take(1, (a) => { cy = r ? cy + a[0] : a[0]; pt(cx, cy); });
      else if (L === 'c') take(6, (a) => { for (let i = 0; i < 6; i += 2) pt(r ? cx + a[i] : a[i], r ? cy + a[i + 1] : a[i + 1]); cx = r ? cx + a[4] : a[4]; cy = r ? cy + a[5] : a[5]; });
      else if (L === 's' || L === 'q') take(4, (a) => { for (let i = 0; i < 4; i += 2) pt(r ? cx + a[i] : a[i], r ? cy + a[i + 1] : a[i + 1]); cx = r ? cx + a[2] : a[2]; cy = r ? cy + a[3] : a[3]; });
      else if (L === 'a') take(7, (a) => { cx = r ? cx + a[5] : a[5]; cy = r ? cy + a[6] : a[6]; pt(cx, cy); });
    }
  }
  for (const m of body.matchAll(/<rect\b([^>]*)>/g)) { pt(attr(m[1], 'x'), attr(m[1], 'y')); pt(attr(m[1], 'x') + attr(m[1], 'width'), attr(m[1], 'y') + attr(m[1], 'height')); }
  for (const m of body.matchAll(/<circle\b([^>]*)>/g)) { const [cx, cy, r] = ['cx', 'cy', 'r'].map((k) => attr(m[1], k)); pt(cx - r, cy - r); pt(cx + r, cy + r); }
  for (const m of body.matchAll(/<(?:polygon|polyline)\b[^>]*?\spoints="([^"]+)"/g)) { const v = m[1].match(/-?[\d.]+/g).map(Number); for (let i = 0; i + 1 < v.length; i += 2) pt(v[i], v[i + 1]); }
  return n ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

async function resolve(id, idx, cropOverride) {
  let set, name;
  const app = idx && (idx.apps.find((a) => a.id === id) || idx.files.find((a) => a.id === id) || idx.apps.find((a) => a.id === id.replace(/^app:/, '')));
  if (!id.includes(':') || id.startsWith('app:')) {
    if (!app) throw new Error(`"${id}" is not a curated app or file (try: icons.mjs find ${id.replace(/^app:/, '').slice(0, 6)})`);
    [set, name] = app.icon.split(':');
  } else [set, name] = id.split(':');
  set = ALIAS[set] || set;
  name = clean(name);
  if (REMOVED.includes(set)) throw new Error(`the "${set}" set (theSVG) is disallowed because per-mark licences are unverified. Use logos:<name> or si:<name> (icons.mjs find <name>).`);
  if (!SETS[set]) throw new Error(`unknown set "${set}" (${Object.keys(SETS).join(', ')})`);
  const meta = SETS[set];
  let j, hit, ic, brand = null, xlink = false, siT = null;
  if (set === 'si') {
    siT = (await siList()).find((x) => siSlug(x) === name);
    if (!siT) throw new Error(`si:${name} not found (try: icons.mjs find ${name.slice(0, 5)})`);
    ic = rawLogo(await fetchCached(siIcon(name)));
    hit = { key: name, icon: ic };
    j = { width: ic.width, height: ic.height };
  } else if (set === 'logos') {
    const known = (await logoNames()).find((x) => x.key === name);
    if (!known) throw new Error(`logos:${name} not found (try: icons.mjs find ${name.slice(0, 5)})`);
    brand = known.brand;
    ic = rawLogo(await fetchCached(logoFileUrl(name)));
    xlink = ic.xlink;
    hit = { key: name, icon: ic };
    j = { width: ic.width, height: ic.height };
  } else {
    j = await iconify(set);
    hit = iconifyKey(set, j, name);
    if (!hit) throw new Error(`${set}:${name} not found (try: icons.mjs find ${name.slice(0, 5)})`);
    ic = hit.icon;
  }
  const w = ic.width || j.width || 16, h = ic.height || j.height || 16;
  const left = ic.left || 0, top = ic.top || 0;
  let vb = [left, top, w, h], W2 = w, H2 = h;
  const known = set === 'ui' ? null : (loadBoxes()[`${set}:${hit.key}`] || null);
  const cb = set === 'ui' ? null : known ? { x: known[0], y: known[1], w: known[2], h: known[3] } : contentBox(ic.body);
  let cropped = false;
  const skipCrop = cropOverride === false || noCrop || flag('nocrop');
  const cut = (pad) => {
    vb = [cb.x - pad, cb.y - pad, cb.w + 2 * pad, cb.h + 2 * pad].map((n) => +n.toFixed(3));
    W2 = vb[2]; H2 = vb[3]; cropped = true;
  };
  if (!skipCrop && cb && cb.w > 0 && cb.h > 0) {
    if (cb.w / cb.h > 1.8 && w / h < 1.8 && cb.h < h * 0.7) cut(Math.max(cb.w, cb.h) * 0.01);
    else if (set === 'logos' || set === 'si') cut(Math.max(cb.w, cb.h) * (cb.w < w * 0.94 || cb.h < h * 0.94 ? 0.02 : 0));
    if (W2 === w && H2 === h) cropped = false;
  }
  const line =
    set === 'ui'
      ? ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
      : set === 'si'
        ? ` fill="#${siT.hex}"`
        : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"${xlink ? ' xmlns:xlink="http://www.w3.org/1999/xlink"' : ''} viewBox="${vb.join(' ')}" width="${+W2.toFixed(2)}" height="${+H2.toFixed(2)}"${line}>${ic.body}</svg>`;
  const nice = name
    .replace(/^(file-type-|default-|folder-type-)/, '')
    .replace(/-?\d+$/, '')
    .split('-')
    .filter((x) => x && x !== 'icon')
    .map((x) => x[0].toUpperCase() + x.slice(1))
    .join(' ');
  const colBody = set === 'si' ? svg : ic.body;
  return {
    set,
    name: hit.key,
    svg,
    title: app ? app.name : siT ? siT.title : nice,
    w: W2,
    h: H2,
    tone: set === 'ui' ? '' : tone(colBody),
    violet: set === 'ui' ? false : violet(colBody),
    violetShare: set === 'ui' ? 0 : violetShare(colBody),
    knock: set !== 'ui' && set !== 'si' && hasPaper(ic.body) && hasInk(ic.body),
    cropped,
    fill: cb ? +Math.max(cb.w / w, cb.h / h).toFixed(2) : null,
    kind: meta.kind,
    app,
    brand,
  };
}

function fileName(r, id, used) {
  const named = r.app && !id.includes(':');
  if (r.set === 'ui') return 'ui-' + r.name + '.svg';
  const base = named ? r.app.id : r.name.replace(/^(file-type-|default-)/, '');
  const taken = used[base] && used[base] !== `${r.set}:${r.name}`;
  return (taken ? `${r.set}-${base}` : base) + '.svg';
}

const SIZES = [16, 20, 24, 28, 32, 36, 40, 48, 56];
const TILES = [24, 32, 40, 48, 56, 72];
const fileCards = (idx, tag, set) =>
  [...idx.apps, ...idx.files].filter((a) => (!tag || a.tags.includes(tag)) && (!set || a.icon.startsWith(set + ':')));

const svgDataUri = (svg) => 'data:image/svg+xml,' + encodeURIComponent(svg).replace(/'/g, '%27');

export function renderIconMarkup(r, options = {}) {
  const tile = !!options.tile;
  const toMono = !!options.mono;
  const useMask = !!options.mask;
  const inline = !!options.inline;
  const glyph = toMono || r.set === 'ui';
  const size = +(options.size || ((r.set === 'ui' || toMono) && !tile ? 24 : 40));
  const k = r.w / r.h;
  const wide = k > 1.8 && r.set !== 'ui';
  const shape = r.set === 'ui' ? '' : wide ? ' ic-wide' : k > 1.25 ? ' ic-land' : k < 0.8 ? ' ic-tall' : '';
  const tileSize = TILES.includes(size) ? size : 40;
  const wrap = (t) =>
    tile
      ? `<span class="ic-tile ic-tile--${tileSize}${wide ? ' ic-tile--wide' : ''}${r.set === 'ui' ? ' ic-tile--glyph' : ''}">${t}</span>`
      : t;
  const mono = glyph && !useMask ? (r.set === 'ui' ? r.svg : monoSvg(r.svg, r.name)) : null;
  if (mono) {
    const root = mono.match(/^<svg[^>]*>/)[0];
    const root2 = root.replace(/ (width|height)="[^"]*"/g, '').replace(/^<svg /, `<svg class="ic ic-svg ic-${size}${shape}" role="img" aria-label="${r.title}" `);
    return wrap(root2 + mono.slice(root.length));
  }
  if (glyph) {
    const du = svgDataUri(r.svg);
    return wrap(`<span class="ic ic-${size} ic-mask" role="img" aria-label="${r.title}" style="-webkit-mask-image: url('${du}'); mask-image: url('${du}')"></span>`);
  }
  const W = k >= 1 ? size : Math.round(size * k);
  const H = k >= 1 ? Math.round(size / k) : size;
  const src = inline ? svgDataUri(r.svg) : options.src;
  return wrap(
    `<img class="ic ic-${size}${shape}${r.tone === 'ink' ? ' ic-ink' : r.tone === 'paper' ? ' ic-paper' : ''}" src="${src}" alt="${r.title}" width="${W}" height="${H}">`,
  );
}

async function fetchCmd(idsOverride, quiet) {
  const say = quiet ? () => {} : (t) => console.log(String(t).replace(/\s*\n\s*/g, ' '));
  const idx = loadIndex();
  const inline = flag('inline');
  const explicitOut = opt('out', null);
  const out = explicitOut || (inline ? null : 'assets/icons');
  const explicitBase = opt('base', null);
  let base = '';
  if (out) {
    let rel = out.replace(/\\/g, '/');
    if (path.isAbsolute(out)) {
      const fromCwd = path.relative(process.cwd(), path.resolve(out)).replace(/\\/g, '/');
      if (explicitBase) rel = explicitBase;
      else if (fromCwd && !fromCwd.startsWith('..') && !path.isAbsolute(fromCwd)) rel = fromCwd;
      else rel = path.basename(path.resolve(out));
    }
    base = (explicitBase || rel).replace(/\/+$/, '');
  }
  const tile = flag('tile');
  let ids = idsOverride || positional();
  const tag = opt('tag');
  if (flag('all')) ids = [...idx.apps.map((a) => a.id), ...idx.files.map((a) => a.id), ...idx.ui.map((u) => 'ui:' + u.id)];
  else if (tag && !ids.length) {
    ids = fileCards(idx, tag, opt('set') && (ALIAS[opt('set')] || opt('set'))).map((a) => a.id);
    if (tag && (!opt('set') || ALIAS[opt('set')] === 'ui' || opt('set') === 'ui')) {
      ids.push(...idx.ui.filter((u) => u.tags.includes(tag)).map((u) => 'ui:' + u.id));
    }
  }
  if (!ids.length) {
    console.error('icons: nothing to fetch (give ids, or --tag <tag>; icons.mjs list --tags shows tags)');
    process.exitCode = 1;
    return;
  }
  let credFile = null;
  let credits = [];
  if (out) {
    const o = path.resolve(out), c = path.resolve(CACHE), rl = path.relative(o, c);
    if (!rl || (!rl.startsWith('..') && !path.isAbsolute(rl))) {
      console.error(`icons: cache (${c}) is inside --out (${o}); set ICON_CRAFT_CACHE outside --out`);
      process.exitCode = 1;
      return;
    }
    fs.mkdirSync(out, { recursive: true });
    credFile = path.join(out, 'icons-credits.json');
    try { credits = JSON.parse(fs.readFileSync(credFile, 'utf8')); } catch {}
  }
  const used = Object.fromEntries(credits.map((c) => [c.file.replace(/\.svg$/, ''), c.icon]));
  let failed = 0, brandsNote = false;
  for (const id of ids) {
    try {
      const r = await resolve(id, idx);
      const file = fileName(r, id, used);
      used[file.replace(/\.svg$/, '')] = `${r.set}:${r.name}`;
      if (out) {
        const dataIc = r.set === 'ui' ? '' : r.violet && flag('mono') ? 'violet' : r.tone || '';
        fs.writeFileSync(path.join(out, file), dataIc ? r.svg.replace(/^<svg /, '<svg data-ic="' + dataIc + '" ') : r.svg);
        const m = SETS[r.set];
        credits = credits.filter((c) => c.file !== file);
        credits.push({
          file,
          icon: `${r.set}:${r.name}`,
          name: r.title,
          kind: r.kind,
          source: `${m.pkg}@${m.ver}`,
          author: m.author,
          licence: m.licence,
          url: m.url,
          trademark: r.set !== 'ui' && r.set !== 'file',
          ...(r.brand && r.brand.url ? { markUrl: r.brand.url } : {}),
          ...(r.set === 'si' ? { colour: 'one-colour fallback in the brand hex' } : {}),
        });
      }
      if (r.set === 'si' && !brandsNote) {
        brandsNote = true;
        console.error('icons: Simple Icons single-colour fallback used where no full-colour mark exists. Marks remain trademarks of their owners (nominative use only).');
      }
      const size = +opt('size', (r.set === 'ui' || flag('mono')) && !tile ? 24 : 40);
      if (!SIZES.includes(size) && !(tile && TILES.includes(size))) {
        console.error(`icons: size ${size} has no ic-${size} class in icon.css (${SIZES.join(' ')})`);
      }
      const k = r.w / r.h, wide = k > 1.8 && r.set !== 'ui';
      if (wide && !tile) console.error(`icons: ${r.title} is a wordmark (${k.toFixed(1)}:1); pass --tile so it gets a wide tile`);
      if (r.violet && !flag('mono')) console.error(`icons: ${r.title} uses brand violet; keep it tile-sized (nominative mark) or pass --mono for monochrome rows`);
      const src = out ? path.posix.join(base, file) : '';
      say(renderIconMarkup(r, { tile, mono: flag('mono'), mask: flag('mask'), inline, size, src }));
    } catch (e) {
      failed++;
      console.error(`icons: ${e.message}`);
    }
  }
  if (out && credFile) {
    credits.sort((a, b) => a.file.localeCompare(b.file));
    fs.writeFileSync(credFile, JSON.stringify(credits, null, 2) + '\n');
  }
  if (failed) process.exitCode = 1;
}

const words = (s) => s.toLowerCase().split(/[\s,]+/).filter(Boolean);
const rank = (name, ws) => {
  const n = name.toLowerCase(), flat = n.replace(/-/g, '');
  let best = 9;
  for (const w of ws) {
    const v = n === w ? 0 : n.startsWith(w + '-') || n.startsWith(w) ? 1 : n.includes('-' + w) ? 2 : n.includes(w) || flat.includes(w.replace(/-/g, '')) ? 3 : 99;
    if (v === 99) return 99;
    best = Math.min(best, v);
  }
  return best;
};

async function findCmd() {
  const ws = words(positional().join(' '));
  if (!ws.length) {
    console.error('usage: icons.mjs find <words> [--set logos|file|ui|si] [--limit 24]');
    process.exitCode = 1;
    return;
  }
  const limit = +opt('limit', 24), only = opt('set') && (ALIAS[opt('set')] || opt('set'));
  const idx = loadIndex();
  const apps = [...idx.apps, ...idx.files].filter(
    (a) => (!only || a.icon.startsWith(only + ':')) && rank(a.id + ' ' + a.name + ' ' + a.tags.join(' '), ws) < 99 && rank(a.id + '-' + a.name.replace(/ /g, '-'), ws) < 99,
  );
  if (apps.length) {
    console.log('curated (use the short name):');
    for (const a of apps.slice(0, 12)) console.log(`  ${a.id.padEnd(18)} ${a.name.padEnd(22)} -> ${a.icon}`);
  }
  for (const s of Object.keys(SETS)) {
    if (only && only !== s) continue;
    let names;
    if (s === 'si') names = (await siList()).map(siSlug);
    else if (s === 'logos') names = [...new Set((await logoNames()).map((x) => x.key))];
    else {
      const j = await iconify(s);
      names = [...Object.keys(j.icons), ...Object.keys(j.aliases || {})];
    }
    const hits = names
      .map((n) => [n, rank(n, ws)])
      .filter((x) => x[1] < 99)
      .sort((a, b) => a[1] - b[1] || a[0].length - b[0].length)
      .slice(0, limit)
      .map((x) => x[0]);
    const m = SETS[s];
    console.log(`${s} (${m.label}, ${m.kind}, ${m.licence}): ${hits.join(' ') || '-'}`);
  }
}

function listCmd() {
  const idx = loadIndex();
  const set = opt('set') && (ALIAS[opt('set')] || opt('set')), tag = opt('tag');
  if (flag('tags')) {
    const c = {};
    for (const a of [...idx.apps, ...idx.files]) for (const t of a.tags) c[t] = (c[t] || 0) + 1;
    console.log(Object.entries(c).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} (${n})`).join('  '));
    return;
  }
  if (set === 'ui') {
    const rows = idx.ui.filter((u) => !tag || u.tags.includes(tag));
    for (const u of rows) console.log(`${('ui:' + u.id).padEnd(30)} ${u.tags.join(' ')}`);
    return;
  }
  const rows = [...idx.apps, ...idx.files].filter((a) => (!set || a.icon.startsWith(set + ':')) && (!tag || a.tags.includes(tag)));
  for (const a of rows) {
    console.log(
      `${a.id.padEnd(18)} ${a.name.padEnd(22)} ${a.icon.padEnd(36)} ${(a.tags || []).join(' ')}${a.wide ? '  [wordmark: --tile]' : ''}${a.tone ? `  [${a.tone}]` : ''}${a.violet ? '  [violet]' : ''}${a.icon.startsWith('si:') ? '  [one-colour]' : ''}`,
    );
  }
  console.log(`${rows.length} icons`);
}

async function checkCmd() {
  const idx = loadIndex();
  let bad = 0, n = 0;
  const entries = [...idx.apps, ...idx.files];
  const seen = {};
  for (const a of entries) {
    if (seen[a.id]) { bad++; console.log(`DUPLICATE id "${a.id}": ${seen[a.id]} and ${a.icon}`); }
    seen[a.id] = a.icon;
  }
  const uiSeen = new Set();
  for (const u of idx.ui) {
    if (uiSeen.has(u.id)) { bad++; console.log(`DUPLICATE ui id "${u.id}"`); }
    uiSeen.add(u.id);
  }
  const all = [...entries.map((a) => ({ a, id: a.icon })), ...idx.ui.map((u) => ({ a: u, id: 'ui:' + u.id }))];
  for (const { a, id } of all) {
    n++;
    try { await resolve(id, idx); } catch (e) { bad++; console.log(`MISSING ${a.id}: ${e.message}`); }
  }
  console.log(`${n} entries checked, ${bad} problems`);
  if (bad) process.exitCode = 1;
}

async function scanCmd() {
  const files = positional().filter((x) => !x.startsWith('--'));
  if (!files.length) {
    console.error('usage: icons.mjs scan <page.html|spec.json> [more ...] --out assets/icons');
    process.exitCode = 1;
    return;
  }
  const ids = new Set();
  const take = (v) => {
    v = String(v || '').trim();
    if (!v || v.startsWith('text:') || /[/.]/.test(v) || /^(data|https?):/i.test(v)) return;
    if (/^[a-z0-9-]+$/i.test(v) || /^(logos|file|ui|si):[a-z0-9._-]+$/i.test(v)) ids.add(v);
  };
  const walk = (o) => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') for (const k in o) { if (k === 'icon') take(o[k]); else walk(o[k]); }
  };
  for (const file of files) {
    const t = fs.readFileSync(file, 'utf8');
    for (const m of t.matchAll(/"icon"\s*:\s*"([^"]+)"/g)) take(m[1]);
    for (const m of t.matchAll(/&quot;icon&quot;\s*:\s*&quot;([^&]+)&quot;/g)) take(m[1]);
    for (const m of t.matchAll(/\sdata-icon=(["'])([^"']+)\1/g)) take(m[2]);
    for (const m of t.matchAll(/<img\b[^>]*?\ssrc=(["'])(?:[^"']*\/)?icons\/([a-z0-9_-]+)\.svg(?:[?#][^"']*)?\1/gi)) take(m[2].replace(/^si-/, 'si:'));
    if (/\.json$/i.test(file)) { try { walk(JSON.parse(t)); } catch {} }
  }
  if (!ids.size) {
    console.error('icons: no icon ids found in ' + files.join(', '));
    return;
  }
  console.error('icons: scan found ' + [...ids].join(' '));
  return fetchCmd([...ids], true);
}

process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exitCode = 0; });

export async function resolveIcon(id, opts = {}) {
  return resolve(id, loadIndex(), opts.noCrop ? false : undefined);
}
export { loadIndex, SETS, LOGOS_SHA };

const here = (p) => { try { return fs.realpathSync(p).toLowerCase(); } catch { return String(p).toLowerCase(); } };
if (process.argv[1] && here(process.argv[1]) === here(fileURLToPath(import.meta.url))) {
  const cmd = argv[0];
  (async () => {
    if (cmd === 'fetch' || cmd === 'get') return fetchCmd();
    if (cmd === 'scan') return scanCmd();
    if (cmd === 'find') return findCmd();
    if (cmd === 'list' || cmd === 'apps') return listCmd();
    if (cmd === 'check') return checkCmd();
    console.log('usage: icons.mjs find <words> | apps [--tag t] | list [--set logos|file|ui|si] [--tag t] [--tags] | fetch <app|set:name ...> [--inline | --out <dir>] [--size 24] [--tile] [--mono] [--base assets/icons] | scan <page.html ...> --out <dir> | check');
  })().catch((e) => {
    console.error('icons:', e.message);
    process.exitCode = 1;
  });
}
