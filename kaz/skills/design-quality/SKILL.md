---
name: design-quality
description: Use when building or reviewing anything a person looks at - a page, component, form, dashboard, email or document layout, or an icon set, symbol set or pictogram - to make it look deliberate rather than generated, to make a set of icons match each other, and when a layout is technically working but reads as unfinished or cramped.
user-invocable: false
---

# Design quality

A page and an icon set look unfinished for the same reason: **one value per set**. One spacing unit and
its multiples, one type scale of three sizes, one stroke width, one corner-radius family - pick each value
once, then spend it; an off-scale number is one nobody can reproduce from the scale. Read the half you are
making: **interfaces** for a page, component, form, dashboard, email or document layout; **icons** for a
set of icons, symbols, pictograms.

## Interfaces: spacing, type, color, hierarchy, states

Interfaces look unfinished for a few repeatable reasons: no spacing system, too many type sizes, one flat
level of hierarchy, missing states, default colors used unchanged. Every rule below is checkable.

### Spacing: pick a scale and stay on it

- Choose one unit and use only its multiples: 4px or 8px - every margin and gap is one of
  `4 / 8 / 12 / 16 / 24 / 32 / 48 / 64`. An off-scale value such as `13px` is one nobody can reproduce
  from the scale, which makes a layout look assembled.
- Space is what groups: more space *between* groups than *inside* them. A heading as close to the previous
  block as to its own text leaves the reader unable to tell which block it belongs to, so the distances
  have to disagree for the grouping to be readable.
- Related controls sit closer to each other than to unrelated ones; a label belongs to its field more
  tightly than to the field above. One page margin and one content width throughout: text running the full
  width of a wide screen is the most common case of a page with no designed measure.

### Type: fewer sizes, more contrast between them

- Three sizes is usually enough: a title, a body, a small. Four is the practical maximum on a page; ten
  sizes means nobody decided.
- Create hierarchy with **weight and color** as well as size; jumping 12px to 36px is harder to read than
  16px to 20px with a weight change.
- Line height: about 1.5 for body text, 1.2 for headings. Text set solid is unreadable at length.
- Body measure: 45-75 characters per line, from a max-width on the text container, not a wider window.
- One font family for the interface, and a monospace only for code, ids, and numbers that must line up.

### Color: restrained, and built from tokens

- Two or three colors plus neutrals; one accent used for exactly one purpose, the primary action.
- Never pure black on pure white: use a near-black, a near-white, and a gray scale of three to five steps
  instead of many ad-hoc grays.
- Contrast is measurable: body text at least 4.5:1, large text and interface borders at least 3:1. Compute
  it rather than judging by eye - a light gray on white usually fails.
- Do not encode meaning in color alone; pair it with text, an icon, or a shape.
- Support both light and dark where the product does; test the pair, not just the one you designed.

### Hierarchy and rhythm

- Every screen answers, in order: what is this, what is most important here, what do I do next; if three
  elements compete at one weight, none is the answer. One primary action per view: secondary actions are
  quieter, destructive ones separated from the rest.
- Align to a shared grid. Pick left edges and keep them: mixed alignment inside a card or form leaves a
  left edge that moves from row to row, which the eye reads as a defect before it can name it.
- Use whitespace to separate before reaching for a border, and a border before a shadow. Layered shadows
  with no border, on a plain background, look like a template.

### States: the difference between a demo and a product

Every interactive element and every data view needs these, checked in: default, hover, focus, active,
disabled, loading, empty, error. Without an error state and an empty state it is a demo. Focus must stay
visible for keyboard use - removing the focus ring without replacing it is a bug, not a style.

### The self-review pass

Do this before calling a layout finished:

1. **Zoom to 200% and look at the edges** - misalignment invisible at 100% is obvious here.
2. **Squint, or blur the screen.** The hierarchy should still read as blocks of emphasis; if everything
   greys out equally, there is no hierarchy.
3. **Shrink the window to a narrow width.** Text should reflow, not overflow or truncate mid-word.
4. **Count the type sizes and the colors.** If you cannot list them from memory, there are too many.
5. **Tab through the whole thing** - focus visible everywhere, in a sensible order.
6. **Force the empty, loading, and error states** and look at them - usually the ugliest screens in an app.
7. **Check contrast numerically** for body text and for any text over a color or an image.
8. **Look at it with long content**, not `lorem ipsum` or `Item 1`: long names, long numbers, missing
   avatars, text that wraps to three lines.

## Icons: grid, weight, consistency, sizing

Icons are judged in a row, not alone. One icon can look fine by itself and ruin a set because its weight,
corner radius, or optical size disagrees with its neighbours: design the set, then the icon.

### Start from a grid

- Pick a canvas and keep it: 24x24 is the common default, with a **20x20 live area** so shapes never touch
  the edge. At 16x16 the live area is about 12x12.
- Draw on whole or half pixels. Coordinates like `7.5` are deliberate; `7.31` is noise.
- Align to a meaningful subset of the grid: 2px steps for edges, 1px for details - consistent alignment is
  what makes a set look drawn by one hand.
- Square shapes should be optically *larger* than circles, since a circle inscribed in a square reads
  smaller. Overshoot circles by roughly half a pixel, and triangles and diamonds the same.

### Weight

- One stroke width per set: 1.5px or 2px at 24x24. At 16x16, use 1.5px; a 2px stroke closes small counters
  and turns detail into mud.
- One value per variant: inside a set drawn for one canvas, never change stroke width between icons, or
  between the sizes you render that set at - scale the drawing, keep the weight.
- Keep a minimum interior gap of one stroke width. When two strokes come closer, the shape reads as a
  smudge at small sizes.
- Filled and outlined styles are two sets, not one; mixing them in a row is the most visible icon defect
  there is. If both exist, they must share the same grid, silhouette, and optical size.

### Consistency across a set

- One corner radius family (e.g. 2px on 24x24) wherever there is a corner; caps and joins all the same
  way - all round or all butt/square.
- Detail budget: an icon of twelve shapes next to icons of three reads as another drawing style, whatever
  its grid. Simplify the complex one rather than complicating the rest.
- Metaphor: one visual language. Do not put a physical object, a geometric abstraction, and a letter in one
  row. Equal pixel size does not look equal: round shapes need overshoot, dense ones may need to be slightly
  smaller, so the set reads as one weight.

### Sizing

- Design at the size it will be used. A 24x24 icon scaled to 16 loses its detail; redraw that detail away
  rather than scaling down. Keep the same silhouette across sizes so the icon stays recognisable.
- On high-density screens keep whole-pixel positions for lines that read as hairlines; fractional positions
  turn a 1px line into two grey ones.

### When you cannot see the result

Without a rendering step you are drawing blind: geometry is guaranteed, appearance is not.

- Verify what is checkable without eyes: coordinates land on the grid, stroke widths are one value, every
  path stays inside the live area, the file parses, and a render of the set exists.
- State that limitation instead of claiming polish. What you verified is geometry; what you could not see
  is appearance, and the two are not the same claim.
- Prefer a render loop when one is available: draw the set at 16, 24, and 32px in light and dark, look at
  it, and fix what you see. A row of icons at three sizes is the only honest acceptance test.
- Check the set as a row, at real size, on the real background; zoomed icons hide the defects that matter.

## Where the two halves disagree

They disagree about how a value is held, and the difference is real. An interface works from one closed
system - three type sizes, a spacing scale whose steps are all multiples of one unit - applied at every
width. An icon set is redrawn per canvas: a 24x24 drawing is not scaled to 16x16, because the counter closes
and the detail turns to mud; the 16x16 icon is drawn again at that canvas's own values for grid, silhouette
and radius family.

That is also where two of the rules above point in opposite directions on one case. One says
a set keeps one stroke width and the weight stays when the size changes; the other says a 2px stroke turns to
mud at 16x16. The reconciliations that suggest themselves - keep the weight where it fits, or hold one value
per variant - are in neither rule and are not settled here: decide it for the set you are drawing, and
say which you chose. What the two agree on is the part worth keeping: never scale a drawing to a new
canvas and call the result the same set.