# Slop classes, and what proves each one

The main file says to judge the artifact rather than the style and to decide mechanically whatever
can be decided mechanically. This is the class table that judgement runs on, the consumer question
that decides the hardest row, and the ceiling that stops a classification from becoming a rewrite.

## The class table

**Is it here because someone decided it, or because something generated it?** That is the whole
test. The classes, with the symptom we look for:

| class | symptom |
|---|---|
| kept-alive code | old code behind a condition that cannot be true, a flag, an early return, or a guard whose only job is to reject an old shape |
| commented-out code | executable lines living inside comments |
| narration comments | the comment says what the code does, what it used to do, or what a fix changed - instead of why |
| no consumer | exports, parameters, helpers, config keys, whole modules nothing reads |
| rewritten helper | a new function where the repository already had one |
| one-caller layer | an abstraction, registry, or knob built for a single caller |
| impossible guard | validation against a situation the call graph proves cannot occur |
| dead fallback | a second shape kept for data or a format that has no live producer |
| memorial test | a test asserting a mock, or written only to prove the old shape is rejected |
| removal scaffolding | fixtures, helpers, or flag definitions left behind where something was removed |
| drifted duplicate | two near-identical helpers that have quietly diverged |
| stale claim | a comment, count, or reference the code no longer matches |

**A branch that never fires is the expensive one**: no dead-code tool reports it, because the code
is still referenced. Where a class can be decided mechanically, decide it mechanically before
spending a subagent - a constant-condition check, a count derived from the tree rather than
written down, a grep for consumers - but read the consumer class honestly, below.

## "No consumer inside this tree" is rarely the same as "unused"

The `no consumer` row is the one that punishes a careless search, because a search settles it in
one direction only.

- When the module being audited ships as **part of a preset**, a name it exports sits on an
  entry-point surface whose consumers are outside the tree by construction: the preset is consumed
  from outside itself. So a search proves a finding only when the name is module-private (no
  `export`, not reachable from a composition row), or when a *call site* for the helper exists
  elsewhere in the tree.
- For an exported name in that situation, the honest verdict is **`unproven`**, and the finding is
  that it cannot be shown to have a consumer rather than that it has none.
- In a repository whose modules do **not** ship as a preset, an exported name with no caller is
  just an exported name with no caller.

The distinction that keeps this class worth hunting: what costs the reader is not a stale export,
it is a helper that *looks live* - a named function nothing reaches while the same work is done
inline nearby. Search for the identifier as a call, not just as a word, and look for the inline
copy; that pair is provable from inside the tree.

## Not slop

A report that flags these is noise: the repository's own conventions, validation at a trust
boundary, deliberate non-ASCII, an ugly but load-bearing line, a comment whose subject is a real
constraint or the provenance of a bug that was paid for, and anything we cannot explain yet.

## The honest ceiling

A cleanup pass without a way to check the result is a rewrite. If neither the project's checks nor
a read-only probe can tell that behaviour survived, the cleaner audits and reports, and nobody
deletes anything.
