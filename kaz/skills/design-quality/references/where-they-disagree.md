# Where the two halves disagree

They disagree about how a value is held, and the difference is real. An interface works from one
closed system - three type sizes, a spacing scale whose steps are all multiples of one unit -
applied at every width. An icon set is redrawn per canvas: a 24x24 drawing is not scaled to 16x16,
because the counter closes and the detail turns to mud; the 16x16 icon is drawn again at that
canvas's own values for grid, silhouette and radius family.

That is also where two of the rules point in opposite directions on one case. One says a set keeps
one stroke width and the weight stays when the size changes; the other says a 2px stroke turns to
mud at 16x16. The reconciliations that suggest themselves - keep the weight where it fits, or hold
one value per variant - are in neither rule and are not settled here: decide it for the set you are
drawing, and say which you chose. What the two agree on is the part worth keeping: **never scale a
drawing to a new canvas and call the result the same set.**

## Where this reference stops

The interface rules are in `interface-craft.md`, the states and the finishing pass in
`states-and-review.md`, and the icon rules in `icon-craft.md` - this file only holds the comparison.

This file is short on purpose. Read it whole unless the file-read tool reports otherwise: a tool
result over 8192 code points loses its middle the next time compaction runs.
