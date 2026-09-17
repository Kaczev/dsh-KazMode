---
name: moving-or-upgrading-a-thing
description: Use when changing many things the same way, or moving one thing to a new place or version - mirroring a directory, promoting a staging copy, upgrading a dependency, renaming across a repository, or applying one edit to many files. Not for building what does not exist (that is building) and not for fixing one broken behaviour (that is repairing).
user-invocable: false
---

One work type: the target is not ours to design — it is fixed by a source, a version, or a rule. The
work is doing it completely and being able to show that it is complete.

**For the main agent.** This file is registered main-agent-only in
`functions/kaz-shared/lib/skill-visibility.js`. The role blocks below are inputs to
`write_arrangement`, not text addressed to anyone.

## Workflow

1. Capture the target's state **before** touching it — a backup, a hash list, a file count. Without
   it, "nothing was lost" is an opinion.
The hash list and the diff result live in files, not in this conversation — an artifact that never
existed as a file cannot be reported (see `planning-with-files`). How each command is written is
`powershell-scripting`'s business — link semantics, encodings, line endings, exit codes; this file
decides who does what and what counts as done.

2. Say what the target will be, and where that is fixed from: a source directory, a version number,
   a rule. If the rule does not cover a case, stop and ask — this is not the work type for inventing
   one.
3. Do it in a way that can be repeated: one command, one script, one run. Hand-editing many things
   is the failure mode this skill exists to prevent.
4. Compare per file **by content where both sides are readable**. Where they are not - binaries,
   archives, images, generated artifacts, anything you cannot open on both sides - compare a per-file
   hash, and say which method each comparison used. Validate the hash method on a readable sample by
   content first, then use hashes for the rest. Never substitute a count for the comparison; report
   counts of what was compared. Byte inequality is not content difference: normalise line endings
   before calling a text file different.
5. Check what should be *absent* as carefully as what should be present. A mirror that never deletes
   leaves the old version behind in the gaps.
6. Treat a half-finished run as an unfinished state to finish or roll back, not as progress: say which part landed, which did
   not, and whether the target is now valid at all.
7. Report the comparison result, the backup location, and what was not compared. **Lead the
   closing message with the verdict** - the arrangement ledger keeps only its first line, truncated
   at 200 characters.

The dispatching mechanics are the same for every work type; they are in `kaz-dispatch`. What follows
is only what this work type adds.

## Our work

We keep these; they cannot be delegated to a subagent. A subagent reading this list should treat it
as out of scope for itself.

- **Deciding what the target should be** when the rule leaves a gap — and deciding to stop instead.
- **Deciding that a difference is acceptable.** Every mirror has cosmetic differences; which ones
  matter is a judgement about what the thing is for.
- **Declaring the move complete**, since that is the claim the comparison either supports or not.
- **Talking to the user** when the move would lose something they wrote.
- **The backup decision**: what to keep, where, and for how long.

## Subagents

Each entry is a persona we record with `write_arrangement` and then dispatch by its role name with
`ka_sub_whale`: a role, a behaviour description, and a tool blacklist. The preset appends the tool
list, the way results come back, and the language rule (`kaz-shared/lib/roles.js`) — do not repeat
any of that here.

Text in `<angle brackets>` is ours to fill in: name the concrete thing, not the category — a pronoun
is not a fill. Everything outside the brackets is the boundary that makes the role useful; keep it.

`blacklist` is **enforced**, not a suggestion: a denied tool is absent from the subagent's tool face,
and calling it errors. Names in the reserved set are dropped silently, and unknown names are skipped
with a note in the dispatch receipt — so write only real tool names, and read the receipt once.
An empty list adds nothing back. Nine tools are denied to every subagent we dispatch
regardless: send_message, interrupt_agent, ka_sub_whale, write_arrangement, whale_report, the three
memory-write tools, and ask_user_question. Write a list of what is *additionally* forbidden — a role
that must not write is a role you must deny writing.

A `task` is required for every entry and is hard-checked: an empty one is rejected.

An entry to copy:

    { persona: ["comparer", "We compare <the target> against <the source> file by file, by content,
        and report every difference with both sides quoted. We check for what should be absent as
        carefully as for what should be present, because a mirror that never deletes leaves the old
        version in the gaps. We do not fix differences we find."],
      blacklist: ["write", "edit", "present"],
      task: "Compare <target path> against <source path>. Done = a per-file diff result and an
        explicit list of files present on one side only, each with the method used. Counts of equal,
        differing and one-sided files are a receipt for that work, never a substitute for it." }

### state-surveyor — what is there before we touch it

```
role: surveyor that records <the target> as it stands before anything changes
description: We record <the target>'s current state - the file list, the version, the counts, and
  whatever identifying detail makes it recognisable later - and we report the record in full in our
  closing message, writing no files; the main agent stores it at <the record path>. We do not start
  the move: our output is the record someone can check the result against.
blacklist: write, edit, pwsh, present
```

### comparer — file by file, by content

```
role: comparer that checks <the target> against <the source> file by file
description: We compare <the target> against <the source> by content and report every difference with
  both sides quoted. We check for what should be absent as carefully as for what should be present,
  because a mirror that never deletes leaves the old version in the gaps. We do not fix differences
  we find: we list them.
blacklist: write, edit, pwsh, present
```

### orphan-finder — what survived that should not have

```
role: finder of what is in <the target> and has no counterpart in <the source>
description: We list everything present in <the target> that <the source> does not contain, and
  separate the harmless from the dangerous - a leftover of the previous version, a locally written
  file that is about to be lost, or a link pointing at the wrong place. We do not delete anything.
blacklist: write, edit, pwsh, present
```

### dry-runner — do it once without doing it

```
role: runner that rehearses <the change> and reports what it would touch
description: We run <the change> in its dry or reporting mode and list exactly what it would modify,
  create, and delete. Where no dry mode exists, we run it against <a copy of the target> instead and
  report the result of that. We do not run it against the real target.
blacklist: write, edit, pwsh, present
```
