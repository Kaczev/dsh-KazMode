# Icon craft: grid, weight, consistency, sizing

Icons are judged in a row, not alone. One icon can look fine by itself and ruin a set because its
weight, corner radius, or optical size disagrees with its neighbours: design the set, then the icon.

## Start from a grid

- Pick a canvas and keep it: 24x24 is the common default, with a **20x20 live area** so shapes never
  touch the edge. At 16x16 the live area is about 12x12.
- Draw on whole or half pixels. Coordinates like `7.5` are deliberate; `7.31` is noise.
- Align to a meaningful subset of the grid: 2px steps for edges, 1px for details - consistent
  alignment is what makes a set look drawn by one hand.
- Square shapes should be optically *larger* than circles, since a circle inscribed in a square
  reads smaller. Overshoot circles by roughly half a pixel, and triangles and diamonds the same.

## Weight

- One stroke width per set: 1.5px or 2px at 24x24. At 16x16, use 1.5px; a 2px stroke closes small
  counters and turns detail into mud.
- One value per variant: inside a set drawn for one canvas, never change stroke width between icons,
  or between the sizes you render that set at - scale the drawing, keep the weight.
- Keep a minimum interior gap of one stroke width. When two strokes come closer, the shape reads as
  a smudge at small sizes.
- Filled and outlined styles are two sets, not one; mixing them in a row is the most visible icon
  defect there is. If both exist, they must share the same grid, silhouette, and optical size.

## Consistency across a set

- One corner radius family (e.g. 2px on 24x24) wherever there is a corner; caps and joins all the
  same way - all round or all butt/square.
- Detail budget: an icon of twelve shapes next to icons of three reads as another drawing style,
  whatever its grid. Simplify the complex one rather than complicating the rest.
- Metaphor: one visual language. Do not put a physical object, a geometric abstraction, and a letter
  in one row. Equal pixel size does not look equal: round shapes need overshoot, dense ones may need
  to be slightly smaller, so the set reads as one weight.

## Sizing

- Design at the size it will be used. A 24x24 icon scaled to 16 loses its detail; redraw that detail
  away rather than scaling down. Keep the same silhouette across sizes so the icon stays
  recognisable.
- On high-density screens keep whole-pixel positions for lines that read as hairlines; fractional
  positions turn a 1px line into two grey ones.

## When you cannot see the result

Without a rendering step you are drawing blind: geometry is guaranteed, appearance is not.

- Verify what is checkable without eyes: coordinates land on the grid, stroke widths are one value,
  every path stays inside the live area, the file parses, and a render of the set exists.
- State that limitation instead of claiming polish. What you verified is geometry; what you could
  not see is appearance, and the two are not the same claim.
- Prefer a render loop when one is available: draw the set at 16, 24, and 32px in light and dark,
  look at it, and fix what you see. A row of icons at three sizes is the only honest acceptance
  test.
- Check the set as a row, at real size, on the real background; zoomed icons hide the defects that
  matter.

## Where this reference stops

The half of this skill that decides a page - spacing, type, color, hierarchy - is in
`interface-craft.md`. The states and the finishing pass are in `states-and-review.md`, and the case
where an icon rule and an interface rule want different things is in `where-they-disagree.md`.

This file is short on purpose. Read it whole unless the file-read tool reports otherwise: a tool
result over 8192 code points loses its middle the next time compaction runs.
