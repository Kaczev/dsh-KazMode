---
name: icon-craft
description: Governs how a product, plugin, or interface icon is composed — the square it owns, its ground, subject, weight and colour at 16–56px — and how real brand, file-type and UI marks are resolved; load when drawing an app or plugin icon, or when an HTML proposal or UI renders interface glyphs, file cards, or real product logos. Reuse while in context.
---

# Icon craft

An icon is either an identity that owns its square, or a glyph sitting inside a ground someone else drew. Decide which of the two you are making before you draw. A hairline outline on a transparent canvas is correct for a toolbar and wrong for a product: at row size it shrinks into a stray grey mark, however carefully the paths were traced.

## 1. Three jobs

| Job | Seen as | Ground | Where |
| --- | --- | --- | --- |
| Identity: app, plugin, product | one icon beside other products, 24–64px | the icon owns a full square | §2, draw it |
| Interface glyph | toolbar, button, menu, row lead | none; inherits `currentColor` | §3, resolve it |
| Brand or file mark | logo wall, integration tile, file card | the host's tile from `icon.css` | §4, resolve it only |

No emoji where an interface glyph belongs, no hand-drawn approximation of a real brand mark, no lone initial in a coloured circle while a real mark exists.

## 2. Identity: own the square

Draw one object that fills the square, not a glyph with empty space around it. These numbers, not judgement, separate a product icon from a magnified toolbar glyph.

- **Canvas.** `viewBox="0 0 64 64"`, exported as SVG; a 512px PNG only when the artwork needs texture SVG cannot carry. DSH accepts SVG, PNG, JPEG, and WebP up to 256 KiB.
- **Ground.** A flat tone or a two-stop vertical gradient filling the whole square, plus an inset hairline so the edge stays crisp on a light page; the frame below carries the exact geometry. No drop shadow, bevel, or glow outside the tile.
- **Mark box.** 30–46 units on its longest side, optically centred, at least 8 units from every edge. The tile carries the mass, so the subject may stay modest: 33 of 64 units is enough on a dark plate.
- **Weight.** 6–8 units (9–13% of the square), as filled shapes or round-capped strokes with round joins. Below 5 units a stroke greys out at 24px whatever its colour.
- **Colour.** Ground, one mark hue, at most one accent. Saturation belongs to the mark rather than the ground; keep mark-to-ground luminance contrast at 3:1 or more; two stops of one hue beat a rainbow.
- **Counterweight (optional).** If the composition needs balance, add one small detail — a dot, a tick, or a 3–5-unit four-point sparkle in the empty quadrant. Keep it subordinate to the main subject.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Plugin name">
  <defs>
    <linearGradient id="tile-name" x1="0" y1="0" x2="0" y2="64" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="GROUND_TOP"/><stop offset="1" stop-color="GROUND_BOTTOM"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="16" fill="url(#tile-name)"/>
  <rect x="0.6" y="0.6" width="62.8" height="62.8" rx="15.6" fill="none" stroke="#fff" stroke-opacity="0.11" stroke-width="1.2"/>
  <!-- the mark: 30–46 units, 6–8-unit round strokes or filled shapes, one accent -->
</svg>
```

**Or draw bare** when the subject is a solid silhouette strong enough to stand alone: no ground, 42–52 units (66–81%), 7–9-unit strokes, mostly filled. Small is safe on a plate; small and bare is how an icon disappears.

Before exporting: shrink it to 24px and one solid object must survive; flatten it to two colours and it must still separate from its ground; place it on a light and a dark page and nothing may disappear. The ground tone, the subject, and the accent must come from this product, or every icon you ship becomes the same tile — read two or three icons installed beside it and borrow their mass and restraint, never their subject.

For a DSH bundle, the `dsh-doc` artwork reference owns the manifest side (`./icon` export or a top-level `icon`, self-contained geometry, no `<text>`, no `<image>`, unique gradient ids). Its bare 36×36 default is written for artwork that lives on the host's plate; this section owns the drawing.

## 3. Interface glyphs

1. One line set per view: `@iconify-json/lucide`, `stroke-width="2"` on a 24 viewBox, inline in `currentColor`. Never mix packs or stroke weights on one screen.
2. Use the application's own icon component first; otherwise resolve inline SVGs with `scripts/icons.mjs` (§5).
3. Size by role: 16–20px inline with text, 18–24px in rows and chips, 32–48px in feature tiles. Decorative glyphs take `aria-hidden="true"`; an icon-only control takes an explicit `aria-label`.

## 4. Brand and file marks

1. **Brand marks.** `logos:` full-colour CC0 marks first; `si:` brand-hex marks only where no full-colour mark exists (Google Docs, Sheets, Slides). Keep authentic colours — never recolour a real logo to match the page accent — and hold violet marks (Stripe, Twitch, Sentry) at tile or chip scale instead of expanding them into banners. `--mono` variants are for uniform customer-logo strips and quiet footer rows.
2. **File types.** `file:` marks (`@iconify-json/vscode-icons`) for pdf, docx, xlsx, pptx, markdown, zip, and code; never a brand logo for a generic file. A proprietary mark missing from permitted sets is written as plain text, never hand-drawn.
3. **A fictional product inside the page.** Draw a clean geometric mark in `--ink` or `--accent` and borrow no existing trademark. This is a mark in a UI, not the product's own app icon, which §2 covers.
4. **Nominative trademark notice.** Name and show third-party marks only for tools the product genuinely integrates with, never to imply endorsement. When local icon files ship, keep the generated `icons-credits.json` and carry "Product names and logos are trademarks of their owners" in the credits or documentation.

## 5. Resolver (`scripts/icons.mjs`)

Resolve `<skill-dir>` from this skill's directory path (shown in `<skill_content>` when loaded). Run `scripts/icons.mjs` with Node (`node "<skill-dir>/scripts/icons.mjs" ...`; without `node` on `PATH`, run `$env:ELECTRON_RUN_AS_NODE='1'; & $env:DSH_NODE_EXECUTABLE "<skill-dir>/scripts/icons.mjs" ...` in PowerShell). Every command runs in a single Node process with zero npm dependencies, caches fetched sets in the OS temp directory (`ICON_CRAFT_CACHE` overrides the path), and opens no runtime CDN request from the rendered page.

- **Find across all sets:** `find github slack pdf arrow`
- **Browse curated names and tags (458 apps, 38 file types, 435 UI glyphs):** `list --tags`, `apps --tag ai`, `list --set ui --tag dev`
- **Inline markup for a single-file HTML:** `fetch github slack pdf ui:arrow-right --inline --tile --size 32` prints `<svg class="ic ic-svg ...">` for `ui:` and `--mono`, and `data:image/svg+xml` `<img>` tags for full-colour marks.
- **Files for a multi-file project:** `fetch github slack file:pdf2 ui:check --out assets/icons --base assets/icons` writes the SVGs plus `icons-credits.json`.
- **Everything a page already references:** `scan index.html --out assets/icons` fetches each `data-icon` and `icons/<name>.svg`.

For a wordmark (`w/h > 1.8`), pass `--tile`; the resolver warns if it is omitted.

## 6. Placement (`assets/icon.css`)

Include or adapt `<skill-dir>/assets/icon.css` for tiles, chips, file cards, and integration grids:

1. **Dark grounds.** Near-black marks (GitHub, Apple, X) carry `.ic-ink`, near-white ones `.ic-paper`. On `.ground-inverse` or `.ic-dark` a bare ink mark inverts, while `.ic-tile` renders a soft light plate that keeps brand colour crisp without recolouring. An identity tile needs no special case: it carries its own ground in both themes.
2. **Tile modifiers.** `.ic-tile--glyph` sets a glyph on a quiet 5%–9% tint, `.ic-tile--ink` on a dark plate, `.ic-tile--brand` on a brand colour.
3. **Restraint.** Sizes follow §3. One tile size per row, and nothing above 72px outside an app-icon grid.
