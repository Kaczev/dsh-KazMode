---
name: moving-or-upgrading-a-thing
description: Use when changing many things the same way, or moving one thing to a new place or version - mirroring a directory, promoting a staging copy, upgrading a dependency, renaming across a repository, or applying one edit to many files. Not for building what does not exist (that is building) and not for fixing one broken behaviour (that is repairing).
user-invocable: false
---

# Moving or upgrading a thing

One work type: the target is not ours to design - it is fixed by a source, a version, or a rule. The
work is doing it completely and being able to show that it is complete.

**For the main agent.** This file is registered main-agent-only in
`functions/kaz-shared/lib/skill-visibility.js`; everything below is an input to `write_arrangement`,
not text addressed to anyone.

The dispatching mechanics, and what a dispatch is worth, are in `kaz-dispatch`. What follows is only
what this work type adds.

## Workflow

1. Capture the target's state **before** touching it - a backup, a hash list, a file count, and
   whatever detail makes it recognisable later. Without it, "nothing was lost" is an opinion. The
   hash list and the diff result live in files, not in this conversation; an artifact that never
   existed as a file cannot be reported (see `planning-with-files`). How each command is written is
   `powershell-scripting`'s business - link semantics, encodings, line endings, exit codes. This file
   decides who does what and what counts as done.
2. Say what the target will be, and where that is fixed from: a source directory, a version number,
   a rule. If the rule does not cover a case, stop and ask - this is not the work type for inventing
   one.
3. Rehearse it ourselves: run the change in its dry or reporting mode and list exactly what it would
   modify, create, and delete. That is the point of running it once without doing it - and it is never
   run against the real target, so where no dry mode exists it runs against a copy instead.
4. Do it in a way that can be repeated: one command, one script, one run. Hand-editing many things is
   the failure mode this skill exists to prevent.
5. Compare per file **by content where both sides are readable**. Where they are not - binaries,
   archives, images, generated artifacts, anything you cannot open on both sides - compare a per-file
   hash, and say which method each comparison used. Validate the hash method on a readable sample by
   content first, then use hashes for the rest. Never substitute a count for the comparison; report
   counts of what was compared. Byte inequality is not content difference: normalise line endings
   before calling a text file different.
6. Check what should be *absent* as carefully as what should be present. A mirror that never deletes
   leaves the old version behind in the gaps. Everything in the target with no counterpart in the
   source is either a leftover of the previous version, a locally written file about to be lost, or a
   link pointing at the wrong place - say which, and delete nothing yet.
7. Treat a half-finished run as an unfinished state to finish or roll back, not as progress: say which
   part landed, which did not, and whether the target is now valid at all.
8. Report the comparison result, the backup location, and what was not compared.

## What we keep for ourselves

We keep these; they cannot be delegated.

- **Deciding what the target should be** when the rule leaves a gap - and deciding to stop instead.
- **Deciding that a difference is acceptable.** Every mirror has cosmetic differences; which ones
  matter is a judgement about what the thing is for.
- **Declaring the move complete**, since that is the claim the comparison either supports or not.
- **Talking to the user** when the move would lose something they wrote.
- **The backup decision**: what to keep, where, and for how long.

## Reading the result

Check it yourself, against the artifact and the intent: read the claims, run the command, compare the
two sides.

A list of differences is a lead, not a verdict - open both sides where they are readable, re-run the
count where they are not, and hold what comes back against the target named in step 2 before anything
is called complete.

## Dispatching

The dispatching mechanics, and what a dispatch is worth, are in `kaz-dispatch`. What follows is only
what this work type adds: a dispatch earns its place here when the comparison is too large to hold in
our own context, or when it must not inherit what we already believe about which differences matter.
Otherwise the walk, the diff and the dry run are ours.
