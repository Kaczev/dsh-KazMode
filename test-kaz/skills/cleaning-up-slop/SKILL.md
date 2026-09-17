---
name: cleaning-up-slop
description: Use when code carries noise that was generated rather than decided - code kept alive behind a condition that never fires, comments narrating what the code used to be, commented-out code, exports or helpers with no consumer, layers built for one caller - and when the user asks to clean up, de-slop or condense a codebase. Not for moving many things (moving-or-upgrading-a-thing) or fixing one broken behaviour (repairing-something-broken).
user-invocable: false
---

Removing slop from code that already exists is a different job from not writing it in the first place.
The rules in our own persona govern what we write; this file governs what we take out of someone
else's — usually the user's live code, where a wrong deletion costs real behaviour.

Two things make it dangerous, and both have a cheap answer:

- **It changes code someone depends on, while feeling like tidying.** So it is dispatched, scoped, and
  proven, never folded into whatever else this round is doing.
- **The reader of the code is not in the room.** So every finding carries evidence, and the two of us
  decide what is worth doing before any of it is deleted.

**For the main agent.** This file is registered as main-agent-only in
`functions/kaz-shared/lib/skill-visibility.js`. The cleaner carries its own instructions in its fixed
persona; what it needs from us is scope, classes, verification and permission, which is what this file
decides. Where a role block below appears, it is an input to `write_arrangement` — not text addressed
to the cleaner.

## What counts as slop

Judge the artifact, not the style: **is it here because someone decided it, or because something
generated it?** The classes, with the symptom we look for:

| class | symptom |
|---|---|
| kept-alive code | old code behind a condition that cannot be true, a flag, an early return, or a guard whose only job is to reject an old shape |
| commented-out code | executable lines living inside comments |
| narration comments | the comment says what the code does, what it used to do, or what a fix changed — instead of why |
| no consumer | exports, parameters, helpers, config keys, whole modules nothing reads |
| rewritten helper | a new function where the repository already had one |
| one-caller layer | an abstraction, registry, or knob built for a single caller |
| impossible guard | validation against a situation the call graph proves cannot occur |
| dead fallback | a second shape kept for data or a format that has no live producer |
| memorial test | a test asserting a mock, or written only to prove the old shape is rejected |
| removal scaffolding | fixtures, helpers, or flag definitions left behind where something was removed |
| drifted duplicate | two near-identical helpers that have quietly diverged |
| stale claim | a comment, count, or reference the code no longer matches |

**A branch that never fires is the expensive one**: no dead-code tool reports it, because the code is
still referenced. Where the class can be decided mechanically, decide it mechanically before spending a
subagent — a grep for consumers, a constant-condition check, a count derived from the tree rather than
written down.

**Not slop**, and a report that flags these is noise: the repository's own conventions, validation at a
trust boundary, deliberate non-ASCII, an ugly but load-bearing line, a comment whose subject is a real
constraint or the provenance of a bug that was paid for, and anything we cannot explain yet.

## Whether to dispatch at all

A stale comment is not a cleanup. The cleaner earns its dispatch when the noise is **accumulated,
scoped, and verifiable**:

- **Dispatch it** when the user asks for a cleanup; when a whole directory, module, or class of noise
  needs sweeping; when deciding whether something is dead needs reading outside the current file
  (callers, configs, docs, live data); or when the same noise must be found and removed in many files.
- **Do not dispatch it** for a handful of lines you can fix while you are already in the file, for
  cosmetic preferences, or for code the user has in flight — their uncommitted work gets excluded by
  name, not cleaned.
- **The honest ceiling**: a cleanup pass without a way to check the result is a rewrite. If neither the
  project's checks nor a read-only probe can tell that behaviour survived, the cleaner audits and
  reports, and nobody deletes anything.

## How to dispatch it

One entry, one pattern-class. Name these five things in the task text:

1. **Scope** — the paths, and what is explicitly out. Name the files that are dirty in the working
   tree so they are skipped rather than swept into someone's unfinished work.
2. **Class** — which rows of the table above, and the evidence bar for each.
3. **Verification** — the command that proves behaviour survived, and what to do when no such command
   exists. Name it concretely: existing tests or typecheck or lint; a probe script it writes and runs
   against real inputs; or nothing, in which case the run is read-only. Loudest available first.
4. **Audit or apply** — findings-only, or permission to change. Findings-only is the default and it is
   usually enough for a first pass; a later dispatch applies what the user picked.
5. **What must come back** — what was removed, what was only found, what it refused to touch and why,
   and what it could not verify.

Constraints to restate in the task, because they are the whole safety story: behaviour is preserved
absolutely, including error types and timing; a change with no proof is reverted rather than kept;
pre-existing code is removed only after one thought about why it is there; and anything that is a
real fix — a latent bug, a drifted duplicate, merging two behaviours — belongs in a separate change
with its own evidence, never inside a cleanup diff.

**The dispatcher's own rules**, which decide whether the dispatch happens at all:

- Write the entry as the reserved value `persona: "slopCleaner"`, exactly, as a bare string. An array
  form like `["slopCleaner", "…"]` is accepted by the arrangement validator but does not reach the
  cleaner's persona or its blacklist — it gets a generic subagent under a cleaner's name. If the
  reserved value is wrong, the dispatch is wrong and nothing else here matters.
- A blacklist written on a reserved entry is ignored: the cleaner's tool face is fixed. Do not try to
  widen or narrow it per dispatch.
- The plan must still carry its `memoryMaintainer` entry — `write_arrangement` replaces the whole plan,
  so writing this dispatch drops every entry not restated in the same call.
- Dispatching does not create a new role each time: the reuse key is the persona name, so a second
  `slopCleaner` dispatch in the same conversation continues the cleaner that is already loaded with
  the right context. Queue the work rather than expecting fresh eyes.
- To check the cleaner's work, dispatch a **different** name (a `[role, description]` pair is fine)
  and never `fork` from the cleaner: forking or re-dispatching `slopCleaner` hands the verification to
  the agent that produced the findings, which is the one reviewer that cannot be independent.

Template, to adapt rather than paste:

> Audit `<paths>` for `<classes from the table>` and change nothing. For each finding give
> `path:line — class — why it costs the reader — the evidence you ran — safe to fix — how you would
> prove it`. Exclude `<dirty files>`. Where a fix cannot be proven with `<the command>`, say so and
> leave the code. Report what you removed if you were authorised to remove, what you only found, what
> you refused to touch, and what you did not verify.

## After the report

- **Take the report as a lead, not a verdict.** The tree may have moved since it was written, and a
  stale finding applied verbatim writes a new lie. Re-check the cheap half of every claim ourselves —
  does the symbol really have no consumer, can that branch really not fire — before acting on it.
- **Verify the deletions that matter** with a second role — a separate dispatch that does not inherit
  the cleaner's findings as facts. The cleanest case is a change that can be shown to alter no
  behaviour; if it cannot be shown, the honest report says the leftover is unverified.
- **Keep the ledger, not the transcript.** What was cleaned, what was found and left, and what was
  refused belongs in a file (see `planning-with-files`), because this skill will be loaded again and
  the next pass should not re-derive it. Restated reasoning and per-file narration do not belong
  anywhere.

## Where other work types take over

`moving-or-upgrading-a-thing` when the target is fixed by a source or a version and the job is
completeness. `repairing-something-broken` when behaviour is wrong and the goal is the fix. Anything
the user has not asked for stays a finding in the report, whatever it is.
