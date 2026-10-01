# Interface craft: spacing, type, color, hierarchy

Interfaces look unfinished for a few repeatable reasons: no spacing system, too many type sizes, one
flat level of hierarchy, missing states, default colors used unchanged. Every rule below is
checkable.

## Spacing: pick a scale and stay on it

- Choose one unit and use only its multiples: 4px or 8px - every margin and gap is one of
  `4 / 8 / 12 / 16 / 24 / 32 / 48 / 64`. An off-scale value such as `13px` is one nobody can
  reproduce from the scale, which makes a layout look assembled.
- Space is what groups: more space *between* groups than *inside* them. A heading as close to the
  previous block as to its own text leaves the reader unable to tell which block it belongs to, so
  the distances have to disagree for the grouping to be readable.
- Related controls sit closer to each other than to unrelated ones; a label belongs to its field
  more tightly than to the field above. One page margin and one content width throughout: text
  running the full width of a wide screen is the most common case of a page with no designed
  measure.

## Type: fewer sizes, more contrast between them

- Three sizes is usually enough: a title, a body, a small. Four is the practical maximum on a page;
  ten sizes means nobody decided.
- Create hierarchy with **weight and color** as well as size; jumping 12px to 36px is harder to read
  than 16px to 20px with a weight change.
- Line height: about 1.5 for body text, 1.2 for headings. Text set solid is unreadable at length.
- Body measure: 45-75 characters per line, from a max-width on the text container, not a wider
  window.
- One font family for the interface, and a monospace only for code, ids, and numbers that must line
  up.

## Color: restrained, and built from tokens

- Two or three colors plus neutrals; one accent used for exactly one purpose, the primary action.
- Never pure black on pure white: use a near-black, a near-white, and a gray scale of three to five
  steps instead of many ad-hoc grays.
- Contrast is measurable: body text at least 4.5:1, large text and interface borders at least 3:1.
  Compute it rather than judging by eye - a light gray on white usually fails.
- Do not encode meaning in color alone; pair it with text, an icon, or a shape.
- Support both light and dark where the product does; test the pair, not just the one you designed.

## Hierarchy and rhythm

- Every screen answers, in order: what is this, what is most important here, what do I do next; if
  three elements compete at one weight, none is the answer. One primary action per view: secondary
  actions are quieter, destructive ones separated from the rest.
- Align to a shared grid. Pick left edges and keep them: mixed alignment inside a card or form
  leaves a left edge that moves from row to row, which the eye reads as a defect before it can name
  it.
- Use whitespace to separate before reaching for a border, and a border before a shadow. Layered
  shadows with no border, on a plain background, look like a template.

## Where this reference stops

The states an interface owes its reader, and the pass to run before calling a layout finished, are
in `states-and-review.md`. The icon half of this skill holds its own values and is in
`icon-craft.md`; what changes when the same page or set is judged both ways is in
`where-they-disagree.md`.

This file is short on purpose. Read it whole unless the file-read tool reports otherwise: a tool
result over 8192 code points loses its middle the next time compaction runs.
