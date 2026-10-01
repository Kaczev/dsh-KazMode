---
name: cleaning-up-slop
description: Use when code carries noise that was generated rather than decided - code kept alive behind a condition that never fires, comments narrating what the code used to be, commented-out code, exports or helpers with no consumer, layers built for one caller - and when the user asks to clean up, de-slop or condense a codebase. Not for moving many things (moving-or-upgrading-a-thing) or fixing one broken behaviour (repairing-something-broken).
user-invocable: false
---

# Cleaning up slop

Removing slop from code that already exists is a different job from not writing it in the first
place. Our own persona governs what we write; this file governs what we take out of someone
else's code, usually the user's live code, where a wrong deletion costs real behaviour.

Two things make it dangerous, and both have a cheap answer. **It changes code someone depends on,
while feeling like tidying**, so it is dispatched, scoped, and proven, never folded into whatever
else this round is doing. **The reader of the code is not in the room**, so every finding carries
evidence, and the two of us decide what is worth doing before any of it is deleted.

**For the main agent.** This file is registered main-agent-only in
`functions/kaz-shared/lib/skill-visibility.js`; the entry below is an input to
`write_arrangement`, not text addressed to anyone.

The dispatching mechanics, and what a dispatch is worth, are in `kaz-dispatch`. What follows is
only what this work type adds.

## Read the matching reference

| Question | File |
|---|---|
| Which rows count as slop, and what proves one, mechanically or not? | `references/slop-classes.md` |
| What goes in the cleaner's task, and what comes back? | `references/cleaner-dispatch.md` |

Read one with the file-read tool, and read it in windows: a tool result over 8192 code points is
trimmed to its first 4096 plus its last 1024 the next time compaction runs, so a long file read
whole loses its middle. Both references are short enough to read whole today; if either grows past
around 200 lines, read it with `offset` and `limit` instead. This file stays short for the same
reason.

## What we keep for ourselves

We keep these; they cannot be delegated.

- **Deciding what counts as slop for this artifact.** The cleaner classifies against the task text
  we wrote, so a wrong class sends it to delete live code, and it cannot tell.
- **Deciding whether anything changes at all.** Findings-only is the default; permission to change
  code is ours to grant, in words.
- **Accepting the result.** The cleaner's report is a lead, not a verdict, and the deletions that
  matter are ours to check.

## Whether to dispatch at all

A stale comment is not a cleanup. The cleaner earns its dispatch when the noise is **accumulated,
scoped, and verifiable**: the user asked for a cleanup, a whole directory or class of noise needs
sweeping, deciding whether something is dead needs reading outside the current file (callers,
configs, docs, live data), or the same noise must be found and removed in many files. It does not
earn one for a handful of lines you can fix in place, for cosmetic preferences, or for code the
user has in flight - their uncommitted work gets excluded by name, not cleaned.

**The honest ceiling**: a cleanup pass without a way to check the result is a rewrite. If neither
the project's checks nor a read-only probe can tell that behaviour survived, the cleaner audits
and reports, and nobody deletes anything.

## How to dispatch it

One entry, one class from the table. **Judge the artifact, not the style**: is a thing here
because someone decided it, or because something generated it? **A branch that never fires is the
expensive one** - no dead-code tool reports it, because the code is still referenced - so decide
every class you can decide mechanically before spending a subagent: a constant-condition check, a
count derived from the tree rather than written down, a grep for consumers.

Everything generic about recording and dispatching the entry - the two hops, the entry shape, the
`memoryMaintainer` entry, the plan-replacement rule, the reuse key - is in `kaz-dispatch`. What is
left here is the cleaner's own:

- Write the entry as the reserved value `persona: "slopCleaner"`, exactly, as a bare string. An
  array form like `["slopCleaner", "..."]` also reaches the cleaner (the dispatcher keys on the
  role name, so the array's first element counts), but write the bare string anyway: it is what
  the validator, this file and the dispatcher all agree on, and a reader cannot tell the two apart
  later.
- The cleaner's tool face is fixed by the reserved value, so a `blacklist` written on its entry
  does nothing - and the validator rejects such an entry rather than ignoring it silently. Do not
  try to widen or narrow the tool face per dispatch.
- Re-dispatching `slopCleaner` continues the cleaner that is already loaded with the right context
  - it does not create a fresh role. Queue the work rather than expecting fresh eyes.
- To check the cleaner's work, dispatch a **different** name (a `[role, description]` pair is
  fine) and never `fork` from the cleaner: forking or re-dispatching `slopCleaner` hands the
  verification to the agent that produced the findings, which is the one reviewer that cannot be
  independent.

Name five things in the task text - the scope and what is out, the class and its evidence bar, the
command that proves behaviour survived or that there is none, findings-only or permission to
change, and what must come back. Both copy-ready task forms, and the constraints that are the whole
safety story, are in `references/cleaner-dispatch.md`.

## After the report

- **Take the report as a lead, not a verdict.** The tree may have moved since it was written, and a
  stale finding applied verbatim writes a new lie. Re-check the cheap half of every claim ourselves
  before acting on it - does the symbol really have no consumer, can that branch really not fire.
- **Check the deletions that matter yourself, against the artifact and the intent**: read the
  claims, run the command, compare the two sides. The cleanest case is a change that can be shown
  to alter no behaviour; if it cannot be shown, the honest report says the leftover is unverified.
- **Keep the ledger, not the transcript.** What was cleaned, what was found and left, and what was
  refused belongs in a file (see `planning-with-files`), because the next pass should not
  re-derive it. Restated reasoning and per-file narration belong nowhere.

## Where other work types take over

`moving-or-upgrading-a-thing` when the target is fixed by a source or a version and the job is
completeness. `repairing-something-broken` when behaviour is wrong and the goal is the fix.
Anything the user has not asked for stays a finding in the report, whatever it is.
