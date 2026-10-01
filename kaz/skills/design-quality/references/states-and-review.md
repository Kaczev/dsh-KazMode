# States, and the pass before you call it finished

## States: the difference between a demo and a product

Every interactive element and every data view needs these, checked in: default, hover, focus,
active, disabled, loading, empty, error. Without an error state and an empty state it is a demo.
Focus must stay visible for keyboard use - removing the focus ring without replacing it is a bug,
not a style.

## The self-review pass

Do this before calling a layout finished:

1. **Zoom to 200% and look at the edges** - misalignment invisible at 100% is obvious here.
2. **Squint, or blur the screen.** The hierarchy should still read as blocks of emphasis; if
   everything greys out equally, there is no hierarchy.
3. **Shrink the window to a narrow width.** Text should reflow, not overflow or truncate mid-word.
4. **Count the type sizes and the colors.** If you cannot list them from memory, there are too many.
5. **Tab through the whole thing** - focus visible everywhere, in a sensible order.
6. **Force the empty, loading, and error states** and look at them - usually the ugliest screens in
   an app.
7. **Check contrast numerically** for body text and for any text over a color or an image.
8. **Look at it with long content**, not `lorem ipsum` or `Item 1`: long names, long numbers, missing
   avatars, text that wraps to three lines.

## Where this reference stops

The values an interface is built from are in `interface-craft.md`; the icon half is `icon-craft.md`,
and the one case where the two halves pull apart is in `where-they-disagree.md`.

This file is short on purpose. Read it whole unless the file-read tool reports otherwise: a tool
result over 8192 code points loses its middle the next time compaction runs.
