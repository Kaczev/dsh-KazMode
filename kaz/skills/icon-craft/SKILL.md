---
name: icon-craft
description: Governs brand, file-type, and interface icon selection, sizing, ground adaptation, and provides a bundled SVG icon resolver; load when an HTML proposal, UI component, or web page renders interface glyphs, file cards, or real product and brand logos. Reuse while in context.
---

# Icon craft and SVG resolver

Use real, properly proportioned SVG icons for interface controls, document types, and third-party products. Never substitute emojis for UI icons, never hand-draw approximate brand logos, and never put a single letter inside a coloured circle when a real icon exists.

## 1. Selection rules

1. **Interface glyphs (`ui:`):** Use a single line-icon set across the entire view (`@iconify-json/lucide`, `stroke-width="2"`, rendered inline in `currentColor`). Never mix outline icons from multiple stroke weights or packs on the same screen. When extending an application that already bundles Lucide or its own icon component, use that native component first; otherwise fetch inline SVGs with the bundled resolver.
2. **Real brand marks (`logos:` first, `si:` fallback):** Show third-party tools and integrations in their authentic brand colours (`logos:` full-colour CC0 SVGs first; `si:` Simple Icons brand-hex marks only when no full-colour mark exists, such as Google Docs/Sheets/Slides). Never recolour a real logo to match your page accent. Keep violet brand logos (such as Stripe, Twitch, or Sentry) at tile or chip scale—never expand them into large violet banners. Use `--mono` only for uniform customer-logo strips or quiet footer rows; multi-tone logos automatically preserve paper cut-outs instead of turning into solid blobs.
3. **Document and file types (`file:`):** Represent file formats (`pdf`, `docx`, `xlsx`, `pptx`, `markdown`, `zip`, code files) with `file:` icons (`@iconify-json/vscode-icons`), never brand logos for generic files. If a proprietary brand mark is absent from permitted CC0/MIT/ISC sets (for example Xbox, Nintendo, or Microsoft corporate marks), write the name in plain text or use the document-type icon rather than inventing an unlicensed or hand-drawn SVG.
4. **Fictional or new product marks:** Design a clean geometric `<svg>` mark in `--ink` or `--accent`; never borrow an existing company's trademark.
5. **Nominative trademark notice:** Name and show third-party marks only for tools the workflow genuinely integrates with, never to imply endorsement. When shipping local icon files in a project, keep the generated `icons-credits.json` manifest and include `"Product names and logos are trademarks of their owners"` in documentation or footer credits where appropriate.

## 2. Bundled resolver (`scripts/icons.mjs`)

Resolve `<skill-dir>` from this skill's directory path (shown in `<skill_content>` when loaded). Run `scripts/icons.mjs` with Node (`node "<skill-dir>/scripts/icons.mjs" ...`; in environments without `node` on `PATH`, run `$env:ELECTRON_RUN_AS_NODE='1'; & $env:DSH_NODE_EXECUTABLE "<skill-dir>/scripts/icons.mjs" ...` in PowerShell). All runtime commands execute in a single Node process with zero npm dependencies, caching fetched sets in the OS temp directory (`ICON_CRAFT_CACHE` overrides the cache path) and never opening runtime CDN requests from the rendered page.

- **Search across all sets:**
  `node "<skill-dir>/scripts/icons.mjs" find github slack pdf arrow`
- **Browse curated short names and tags (458 apps, 38 file types, 435 UI glyphs):**
  `node "<skill-dir>/scripts/icons.mjs" list --tags`
  `node "<skill-dir>/scripts/icons.mjs" apps --tag ai`
  `node "<skill-dir>/scripts/icons.mjs" list --set ui --tag dev`
- **Emit self-contained markup for single-file HTML proposals (`--inline`):**
  `node "<skill-dir>/scripts/icons.mjs" fetch github slack pdf ui:arrow-right --inline --tile --size 32`
  Prints ready-to-paste HTML lines (`<svg class="ic ic-svg ...">` for `ui:` / `--mono`, and `data:image/svg+xml` `<img>` tags for full-colour marks) without writing external `.svg` files.
- **Write local SVG files + `icons-credits.json` for multi-file projects (`--out`):**
  `node "<skill-dir>/scripts/icons.mjs" fetch github slack file:pdf2 ui:check --out assets/icons --base assets/icons`
- **Scan an HTML or JSON file and fetch every referenced `data-icon` or `icons/<name>.svg`:**
  `node "<skill-dir>/scripts/icons.mjs" scan index.html --out assets/icons`

## 3. Ground, tile, and proportion discipline (`assets/icon.css`)

Include or adapt rules from `<skill-dir>/assets/icon.css` when rendering icon tiles, chips, file cards, or integration grids:

1. **Optical cropping and aspect classes:** `icons.mjs` crops brand marks to their pre-measured drawn bounds (`assets/index.json`) and assigns shape classes automatically:
   - Square marks (`0.8 <= w/h <= 1.25`): standard `.ic` sizing (`16, 20, 24, 28, 32, 36, 40, 48, 56`).
   - Landscape (`ic-land`, `w/h > 1.25`, e.g. AWS, Salesforce) and portrait (`ic-tall`, `w/h < 0.8`, e.g. Figma, Google Docs): scaled along their long axis inside `.ic-tile` so a row of mixed logos carries equal visual weight.
   - Wordmarks (`ic-wide`, `w/h > 1.8`, e.g. Stripe, Visa): always pass `--tile` so the mark sits in a wide `.ic-tile--wide` container (`2.4x` tile width) instead of shrinking into an illegible sliver.
2. **Dark grounds and monochrome marks:**
   - Near-black marks (GitHub, Apple, X) carry `.ic-ink`; near-white marks carry `.ic-paper`.
   - On dark surfaces (`.ground-inverse` or `.ic-dark`), bare `.ic-ink` marks invert automatically to light, while `.ic-tile` renders a soft light plate (`94%` ink on dark ground) so dark-blue, black, and multi-colour brand logos remain crisp without recolouring.
   - For interface glyphs in tiles, `.ic-tile--glyph` uses a quiet `5%–9%` ink tint in `currentColor` with no drop shadow.
3. **Sizing restraint:** Keep inline button and input icons at `16px–20px`, list/chip icons at `18px–24px`, and feature/integration tiles at `32px–48px`. Give decorative icons beside visible labels `aria-hidden="true"` or empty `alt=""` to avoid duplicate screen-reader announcements, and give standalone icon controls an explicit `aria-label`.
