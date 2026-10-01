# Files on disk: editing text, and what links and junctions do

Two things PowerShell does badly and quietly: changing the contents of a file, and telling a link
apart from what it points at. The first section is the editing rules, the second is links.

## Do text surgery with the right tool

PowerShell is a poor text editor, and its failure mode is invisible.

- **Do not reorder or rewrite a document by line number.** Collecting line numbers and then writing
  back to the same file drifts: earlier edits invalidate later line numbers. The symptom is a
  duplicated section or a silently deleted one, with no error.
- Prefer targeted edits: replace a specific unique string, one change at a time, reading the file
  first. For a large restructure, back up first and still make one replacement per pass.
- For batch replacements in a generated or structured file, use a scripted approach that **asserts
  each pattern occurs exactly once** and aborts otherwise. A silent no-match is how edits land in the
  wrong place or nowhere.
- For structured data, serialise with the library that will read it. A PowerShell JSON serialiser
  may choose different indentation and line endings than the application's own writer, which shows up
  as a byte-count mismatch when nothing is actually wrong.
- Judging a whole file by counting bytes is fragile until you have normalised and reported line
  endings. A few bytes of difference is usually `\r`.

## Files, links, and junctions

- **To read link metadata, just ask for it.** `Get-Item` populates `LinkType` and `Target` on a
  junction or symlink with or without `-Force`. What `-Force` decides is whether a **hidden** item is
  returned at all - without it you get no item rather than an item without metadata. Measured on this
  machine with a real junction, hiding each end in turn: hiding the **target** leaves the link returned
  and readable (`Target` is still populated); hiding the **link** itself - the attribute then sits on
  the reparse point - makes it **not returned** without `-Force`, exactly like a plain hidden
  directory. So the link's own visibility is what decides, and a hidden link is invisible to a listing
  that omits hidden entries while the directory it points at is not.
- A link target may be an array. Take the first element and normalise it to a full path before
  comparing paths; also trim trailing separators on both sides before an equality test.
- **To remove a link, delete the link, not the tree.** A recursive delete that follows a link can
  walk into the target. Remove a directory link with the command that only unlinks.
- **A link that resolves to nothing is still a link.** Existence checks can report false for a
  dangling link, so probe the link metadata rather than the resolved path.
- Never let a broad cleaning command run in a tree whose directories are links: it writes through
  them. That applies to forced cleanups and forced checkouts.
- **Force the pipeline into an array before it reaches a consumer that distinguishes shape.** `.Count`
  does not need this - it returns `1` on a single item on both 7 and 5.1 - but a serialiser and an
  indexer do: `ConvertTo-Json` of a single item starts `{` where `@($one)` starts `[`, and a caller that
  expects an array breaks on the object.
- Directory listings omit hidden entries unless you ask for them, so "empty" can be wrong. Patterns
  with more than one extension need the recursive file form; a single filter takes one pattern.
