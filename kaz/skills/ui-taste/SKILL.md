---
name: ui-taste
description: Guides UI aesthetics, layout rhythm, colour restraint, typography, micro-interactions, and directly renderable HTML visual proposals; load when designing or styling HTML proposals, application interfaces, plugins, or web pages. Do not load for purely backend, CLI, or non-visual tasks; reuse while in context.
---

# UI taste and HTML proposals

Apply these rules whenever designing an HTML visual proposal, building an application or plugin interface, or styling a web page. Keep one coherent visual system per surface: one spacing scale, one type scale, one radius family, one hairline weight, and one primary button style.

## 1. Classify the surface before setting density

1. **HTML visual proposals:** Build a directly renderable, self-contained HTML file showing the proposed interface at realistic scale rather than formatting a prose plan as a web page. Include lightweight interactive state switches where they clarify behavior (for example: active/empty/loading/error states, tab switches, or light/dark preview) without implementing production backend logic. Mark mock data and unimplemented actions discreetly in a subtle top or footer banner or status pill so mock boundaries are unmistakable without breaking the visual layout.
2. **Application, workbench, and plugin UI:** Prioritize scannable information density, clear hierarchy, and alignment with the host environment. When extending an existing host or design system (such as DeepSeek Harness `--dsw-*` tokens or a project's established CSS variables), inherit its ground, surface, border, and typography tokens instead of inventing a competing palette. Never force full-viewport (`100svh`) poster sections onto operational tools, settings views, or dashboards.
3. **Showcase and landing pages:** Give each section one clear job, generous vertical rhythm, symmetric outer gutters, and low word count per screen (roughly 40–80 words outside live UI frames or data tables). Let real product views, data, or photography carry the visual interest instead of decorative chrome.

## 2. Colour and surface restraint

1. **Keep 90%–95% of the surface neutral.** Build grounds from three calm steps (`--bg`, `--surface`, `--card`) and set primary text in a warm or cool near-black (`--ink`, never stark `#000000` against `#ffffff`). Reserve `--muted` (`>= 4.5:1` contrast) for metadata, timestamps, secondary hints, and field descriptions—never for primary reading copy.
2. **Use at most one accent colour.** Keep filled accent usage under 3%–5% of the viewport: the single primary action per view, active focus rings, selected indicators, and key data highlights. Ensure `>= 4.5:1` contrast between button labels and their fill, and `>= 3:1` for active control boundaries.
3. **Reject AI-slop colour habits.** Unless explicitly mandated by an existing brand guideline, never choose arbitrary violet/indigo/lavender UI accents (`oklch` hue ~270–330), multi-stop neon hero gradients, glowing ambient blobs behind cards, or gratuitous frosted glassmorphism.
4. **Two container levels maximum (`ground -> card -> inset panel`).** Never nest a bordered card inside a patterned panel inside another card ("box-in-box-in-box"). Separate adjacent groups with whitespace or a crisp `1px` hairline (`color-mix(in oklab, var(--ink) 8%–14%, transparent)`) rather than heavy resting drop shadows. Keep cards flat at rest; reserve subtle elevation (`0 4px 20px` at `<= 10%` ink) for floating popovers, menus, dialogs, or hovered link cards.

## 3. Layout, typography, and microcopy

1. **Strict `4px / 8px` spatial scale.** Pick all gaps, paddings, and margins from `4, 8, 12, 16, 24, 32, 48, 64, 96`. Keep left and right container gutters equal, align elements along shared vertical axes, and match heights across cards in the same row.
2. **Readable type hierarchy.** Use `14px–16px` (`line-height: 1.5–1.65`) for body copy (`16px` minimum on standalone content pages; `13px–14px` permitted in dense workbench panels), `12px–13px` (`font-weight: 500`) in sentence case for labels, and tight negative tracking (`-0.02em` to `-0.03em`) only on large display headings. Avoid tracked ALL-CAPS eyebrows and sub-`12px` text. Cap reading measure at `62ch–68ch`, and apply `font-variant-numeric: tabular-nums` to all metrics, prices, timestamps, counters, and table columns.
3. **Concrete UI copy.** Write headings around specific nouns and claims, and write action buttons as `Verb + object` (`Save webhook`, `Export CSV`, `Run check`)—never vague labels like `Learn more`, `Explore`, `Click here`, or exclamation-mark puffery. Never leave `[placeholder]` brackets, `lorem ipsum`, or fake testimonials in rendered views; use realistic domain examples and explicitly flag assumed values where relevant.
4. **Accessible form controls.** Place a visible `<label for>` above every input (placeholders are never labels), size interactive click/tap targets to `36px–44px` height, validate on submit with inline field-level error messages (`aria-invalid` + `aria-describedby`), and give every icon-only control an `aria-label`.

## 4. Purposeful motion and interaction states

1. **Animate only `transform`, `opacity`, and colour tokens.** Never animate `width`, `height`, `top`, `left`, `margin`, or `padding`. Do not add scroll-jacking, text parallax, or staggered scroll-reveal fade-ins on rows and cards.
2. **Crisp feedback curves.** Use `150ms` hover-in, `120ms` hover-out, and `90ms` press with `cubic-bezier(0.2, 0.8, 0.2, 1)` (no bouncy overshoot). Limit hover lift to `1px–2px` on interactive cards or primary buttons under `@media (hover: hover) and (pointer: fine)`; static informational cards never lift on hover.
3. **Keyboard and reduced-motion parity.** Provide an immediate, high-contrast `2px` `:focus-visible` ring (`outline-offset: 2px`) on every interactive element, and honor `@media (prefers-reduced-motion: reduce)` so every view is complete and readable at rest.
4. **Icons:** When an interface or HTML proposal includes interface glyphs, file types, or real third-party brand marks, load `icon-craft` instead of drawing approximations, mixing icon packs, or substituting emojis.

## 5. Pre-delivery visual check

1. Verify that `<meta name="viewport" content="width=device-width, initial-scale=1">` and `*, *::before, *::after { box-sizing: border-box; }` are set on standalone HTML files, and check layout flow at both desktop (`1280px–1440px`) and narrow (`390px` or panel-split) widths without horizontal overflow.
2. Confirm there is exactly one primary filled call-to-action per view context, container nesting stays within two levels, contrast holds in every supported theme, and interactive demo controls in HTML proposals work without console errors.
