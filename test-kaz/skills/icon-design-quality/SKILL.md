---
name: icon-design-quality
description: Use when drawing or reviewing icons, symbol sets, or pictograms - choosing stroke weight and grid, making icons match each other, sizing a set for 16/24/32px, or when icons look hand-drawn and inconsistent next to each other.
---

# Icon design quality

Icons are judged in a row, not alone. One icon can look fine by itself and ruin a set because its
weight, corner radius, or optical size disagrees with its neighbours. Design the set, then the icon.

## Start from a grid

- Pick a canvas and keep it: 24x24 is the common default, with a **20x20 live area** so shapes never
  touch the edge. At 16x16, the live area is about 12x12.
- Draw on whole or half pixels. Coordinates like `7.5` are deliberate; `7.31` is noise.
- Align to a meaningful subset of the grid: 2px steps for edges, 1px for details. Consistent
  alignment is what makes a set look drawn by one hand.
- Square shapes should be optically *larger* than circles: a circle inscribed in a square reads
  smaller. Overshoot the circle by roughly half a pixel, and the same for triangles and diamonds.

## Weight

- One stroke width per set: 1.5px or 2px at 24x24. At 16x16, use 1.5px; a 2px stroke closes small
  counters and turns detail into mud.
- Stroke width must not change with size in the same icon - scale the drawing, keep the weight.
- Keep a minimum interior gap of one stroke width. When two strokes come closer, the shape reads as
  a smudge at small sizes.
- Filled and outlined styles are two sets, not one. Mixing them in a single row is the most visible
  icon defect there is; if both exist, they must share the same grid, silhouette, and optical size.

## Consistency across a set

- Radius: one corner radius family (e.g. 2px on 24x24) used everywhere that has a corner.
- Terminals: line caps and joins are all the same - either all round or all butt/square.
- Detail budget: an icon that needs twelve shapes next to icons made of three looks foreign. Simplify
  the complex one rather than complicating the rest.
- Metaphor: one visual language. Do not mix a physical object, a geometric abstraction, and a letter
  in the same row.
- Optical balance: glyphs of equal pixel size do not look equal. Round shapes need overshoot; dense
  shapes may need to be slightly smaller so the set reads as one weight.

## Sizing

- Design at the size it will be used. A 24x24 icon scaled to 16 loses its detail; redraw the detail
  away instead of scaling down.
- Keep the same silhouette across sizes so an icon stays recognisable when its size changes.
- For lines that read as hairlines on high-density screens, keep whole-pixel positions; fractional
  positions turn a 1px line into two grey ones.

## When you cannot see the result

Without a rendering step you are drawing blind: you can guarantee geometry, not appearance. State
that limitation instead of claiming polish.

- Verify what is checkable without eyes: coordinates land on the grid, stroke widths are one value,
  every path stays inside the live area, the file parses, and a render of the set exists.
- Prefer a render loop when one is available: draw the set into a page or a canvas at 16, 24, and
  32px in both light and dark, look at it, and fix what you see. A row of icons at three sizes is the
  only honest acceptance test.
- Check the set as a row, at real size, on the real background. Zoomed individual icons hide exactly
  the defects that matter.
