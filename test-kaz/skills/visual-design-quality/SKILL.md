---
name: visual-design-quality
description: Use when building or reviewing any user-visible interface - pages, components, forms, dashboards, email or document layouts - to make it look deliberate rather than generated, and when a layout is technically working but reads as unfinished or cramped.
---

# Visual design quality

Interfaces look unfinished for a small number of repeatable reasons: no spacing system, too many
type sizes, one flat level of hierarchy, missing states, and default colors used unchanged. Every
rule below is checkable; none of it needs taste to apply.

## Spacing: pick a scale and stay on it

- Choose one unit and use only its multiples: 4px or 8px. Every margin and gap is one of
  `4 / 8 / 12 / 16 / 24 / 32 / 48 / 64`. An off-scale value such as `13px` is a number nobody can
  reproduce from the scale, which is what makes a layout look assembled rather than designed.
- Space is what groups: put more space *between* groups than *inside* them. If a heading is as close
  to the previous block as to its own text, the reader cannot tell which block the heading belongs
  to - the distances have to disagree for the grouping to be readable.
- Related controls sit closer to each other than to unrelated ones; a label belongs to its field more
  tightly than to the field above.
- Use one consistent page margin and one consistent content width. Text that runs the full width of a
  wide screen is the most common case of a page with no designed measure.

## Type: fewer sizes, more contrast between them

- Three sizes is usually enough: a title, a body, and a small. Four is the practical maximum on a
  page. Ten sizes means nobody decided.
- Create hierarchy with **weight and color** as well as size; jumping 12px to 36px is harder to read
  than 16px to 20px with a weight change.
- Line height: about 1.5 for body text, 1.2 for headings. Text set solid is unreadable at length.
- Body measure: 45-75 characters per line. Achieve it with a max-width on the text container, not by
  widening the window.
- Set one font family for the interface, and use a monospace only for code, ids, and numbers that
  need to line up.

## Color: restrained, and built from tokens

- Two or three colors plus neutrals. One accent used for exactly one purpose: the primary action.
- Never pure black on pure white; use a near-black and a near-white. Use a gray scale of three to
  five steps instead of many ad-hoc grays.
- Contrast is measurable: body text at least 4.5:1, large text and interface borders at least 3:1.
  Compute it rather than judging by eye - a light gray on white usually fails.
- Do not encode meaning in color alone; pair it with text, an icon, or a shape.
- Support both light and dark where the product does; test the pair, not just the one you designed.

## Hierarchy and rhythm

- Every screen answers, in order: what is this, what is the most important thing here, what do I do
  next. If three elements compete at the same visual weight, none of them is the answer.
- One primary action per view. Secondary actions are visually quieter; destructive ones are separated
  from the rest.
- Align to a shared grid. Pick left edges and keep them: mixed alignment inside a card or a form
  leaves a left edge that moves from row to row, which the eye reads as a defect before it can name it.
- Use whitespace to separate before reaching for a border, and a border before reaching for a shadow.
  Layered shadows with no border, on a plain background, look like a template.

## States: the difference between a demo and a product

Every interactive element and every data view needs, and must be checked in: default, hover, focus,
active, disabled, loading, empty, error. An interface without an empty state and an error state is a
demo. Focus must be visible for keyboard use - removing the focus ring without replacing it is a bug,
not a style.

## The self-review pass

Do this before calling a layout finished:

1. **Zoom to 200% and look at the edges.** Misalignment that is invisible at 100% is obvious here.
2. **Squint, or blur the screen.** The hierarchy should still be legible as blocks of emphasis; if
   everything greys out equally, there is no hierarchy.
3. **Shrink the window to a narrow width.** Text should reflow instead of overflowing, truncating
   mid-word, or requiring horizontal scrolling.
4. **Count the type sizes and the colors.** If you cannot list them from memory, there are too many.
5. **Tab through the whole thing.** Focus visible everywhere, in a sensible order.
6. **Force the empty, loading, and error states** and look at them. They are usually the ugliest
   screens in an application, and the ones users see when something is wrong.
7. **Check contrast numerically** for body text and any text over an image or a colored block.
8. **Look at it with real content**, not `lorem ipsum` and not `Item 1`: long names, long numbers,
   missing avatars, and text that wraps to three lines.
