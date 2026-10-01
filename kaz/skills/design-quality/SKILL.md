---
name: design-quality
description: Use when building or reviewing anything a person looks at - a page, component, form, dashboard, email or document layout, or an icon set, symbol set or pictogram - to make it look deliberate rather than generated, to make a set of icons match each other, and when a layout is technically working but reads as unfinished or cramped.
user-invocable: false
---

# Design quality

A page and an icon set look unfinished for the same reason: **one value per set**. One spacing unit
and its multiples, one type scale of three sizes, one stroke width, one corner-radius family - pick
each value once, then spend it; an off-scale number is one nobody can reproduce from the scale.

Read the half you are making: **interfaces** for a page, component, form, dashboard, email or
document layout; **icons** for a set of icons, symbols, pictograms.

## Read the matching reference

| Question | File |
|---|---|
| The spacing, type, color and hierarchy rules for a page or a layout | `references/interface-craft.md` |
| Which states every interactive element and data view needs | `references/states-and-review.md` |
| Grid, stroke weight, consistency and sizing for a set of icons | `references/icon-craft.md` |
| Where the interface rules and the icon rules disagree, and the one rule both keep | `references/where-they-disagree.md` |

Read one with the file-read tool, and read it in windows: a tool result over 8192 code points is
trimmed to its first 4096 plus its last 1024 the next time compaction runs, so a long file read
whole loses its middle. This file stays short for the same reason, and so should every `SKILL.md`
you write. All four references here are short enough to read whole.

## Facts that decide the shape before you read further

- **Spacing is the system, not a preference.** Choose one unit - 4px or 8px - and use only its
  multiples: `4 / 8 / 12 / 16 / 24 / 32 / 48 / 64`. An off-scale `13px` is a value nobody can
  reproduce from the scale, which is what makes a layout look assembled rather than designed.
  Detail in `references/interface-craft.md`.
- **Space is what groups.** More space *between* groups than *inside* them: a heading as close to
  the previous block as to its own text leaves the reader unable to tell which block it belongs
  to. Detail in `references/interface-craft.md`.
- **Three type sizes are usually enough** - a title, a body, a small - and four is the practical
  maximum. Ten sizes means nobody decided. Detail in `references/interface-craft.md`.
- **Restraint is the rule for color**: two or three colors plus neutrals, one accent used for
  exactly one purpose. Contrast is measurable, not a judgement: body text at least 4.5:1, large
  text and interface borders at least 3:1. A light gray on white usually fails. Detail in
  `references/interface-craft.md`.
- **Never encode meaning in color alone**; pair it with text, an icon, or a shape. Support light
  and dark only where the product does, and test the pair rather than the one you designed in.
  Detail in `references/interface-craft.md`.

## The icon half

One icon can look fine by itself and ruin a set, because its weight, corner radius, or optical size
disagrees with its neighbours: design the set, then the icon.

- One stroke width per set, 1.5px or 2px at 24x24, and never change it between the icons of a set
  or between the sizes that set is rendered at. Keep a minimum interior gap of one stroke width:
  when two strokes come closer, the shape reads as a smudge at small sizes.
- Draw on whole or half pixels. A coordinate like `7.5` is deliberate; `7.31` is noise.
- Design at the size it will be used. A 24x24 icon scaled to 16 loses its detail - redraw that
  detail away rather than scaling it down, and keep the silhouette so the icon stays recognisable.
- Without a rendering step you are drawing blind: state what you verified as geometry (the grid,
  one stroke width, the live area, the file parsing) and never present it as the appearance you
  could not see.

Depth for all four points is in `references/icon-craft.md`.

## Where the two halves disagree

An interface works from one closed system - three type sizes, a spacing scale whose steps are all
multiples of one unit - applied at every width. An icon set is redrawn per canvas: a 24x24 drawing
is not scaled to 16x16, because the counter closes and the detail turns to mud; the 16x16 icon is
drawn again at that canvas's own values for grid, silhouette and radius family.

The two halves do agree on the part worth keeping: **never scale a drawing to a new canvas and call
the result the same set.** The one case where a rule of each points the other way, and the
reconciliations that do not settle it, are in `references/where-they-disagree.md`.

## The pass before you call it finished

Every interactive element and every data view needs all eight states, checked in: default, hover,
focus, active, disabled, loading, empty, error. Without an error state and an empty state it is a
demo, not a product. Focus must stay visible for keyboard use - removing the focus ring without
replacing it is a bug, not a style.

There is also a short review to run last, and it catches what the eye misses. Both are in
`references/states-and-review.md`.

If the work is not how a thing looks but how it reads, the neighbouring skill for that is
`auditing-words`.
