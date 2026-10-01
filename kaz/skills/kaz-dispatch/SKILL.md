---
name: kaz-dispatch
description: Use when the dispatch mechanics are what is in question, not the work, or before the first arrangement of a session is recorded - the two hops, the entry shape, the memoryMaintainer entry, reserved personas, and the visibility gate.
user-invocable: false
---

# Dispatching in the Kaz preset

This file owns the mechanics of handing work to a subagent, and says them once. The seven orchestration
skills listed above decide **when** a dispatch is warranted and **who** does the work.

## Read the matching reference

| Question | File |
|---|---|
| What do I write into each field of an entry, is a skill visible to the role? | `references/entries.md` |
| What can a name be, what does reuse do, what must the plan carry? | `references/reserved-and-reuse.md` |
| How do I read back what a dispatch did? | `references/results.md` |

Read one with the file-read tool, whole: a tool result over 8,192 code points is trimmed to its first
4,096 plus its last 1,024. This file stays short for that same reason, and so should every `SKILL.md`.

## The two hops

Dispatching is two tool calls in two stages, with a stage move between them.

```
whale_report(arrange_agent)   # hop 1: enter the arrangement stage
write_arrangement(entries)    # record the whole round's plan
whale_report(idle)            # hop 2: get out; the entries are now recorded
ka_sub_whale(persona)         # dispatch one entry, by role name
```

- `write_arrangement` works **only** in `arrange_agent`; every other stage fails it. `idle` is the
  only legal target out of that stage.
- `ka_sub_whale` takes the role name and nothing else; the blacklist, the task and the fork come from
  the recorded entry, and the entry's `task` is the subagent's first message.
- It does not check the stage, so dispatch from `idle` by convention: the arrangement is written on
  the way in, the dispatching on the way out.
- Independent entries go out in the same round. At most five subagents may be **running** at once; one
  that is loaded but between turns does not count against that.

## What a dispatch buys

Lookup and verification are ours. Reading a file, grepping for a consumer, re-running a command, pricing a
finding, checking a claim against the artifact it is about: we do these in our own hands. They are
sequential, they are cheap, and their result is useful to us and no one else - a role sent to find something
out reports back what we could have read.

A dispatch buys one of exactly three things:

- work that runs **beside** ours, so the round is shorter than doing both in order;
- work that must **not inherit our reasoning** - an adversarial check, a fresh read - where a child seeded
  with our conclusion would be checking its own homework;
- work that needs **context we cannot hand over in a task**: a large artifact, a long history.

A part qualifies only if it has a goal we can verify on its own *and* it needs one of those three.
Verifiable alone is not enough: "go and find out X" is verifiable and costs more than reading X.

**At most one checking role per round**, and only when a wrong answer would be expensive and we cannot check
it ourselves. Re-reading a claim we can read, re-running a command we can run, and asking a second role to
agree with the first are the same work done twice.

## When a fork is worth it

A `fork` gives the child a prefix of the source's log - every closed turn up to the source's last `turn/end`
- and the child pays for that prefix on every step of its own work. So a fork is for one situation only:
**handing over finished work whose context would be long, lossy, or both to retell.**

- Write `fork: "main"` when the child continues work this conversation has already established, and its task
  would otherwise have to restate that context at length.
- **Never fork to look something up, to check a claim, or to get a second opinion on something we can read
  ourselves.** A lookup does not need our history, and a verifier that inherits our reasoning is not
  verifying.
- **`"none"`, or leaving the field out, is the default** for anything small, anything self-contained, and
  anything that must be independent. Writing `"none"` explicitly is never wrong, and records that the fork
  was considered rather than forgotten. `"none"` and an absent field store the same entry.
- Two facts decide whether a target can seed anything at all, and both must hold at dispatch time: the target
  must still resolve as a live session, and its log must already contain a completed turn. A target that is
  still running has no closed turn; one that has finished may no longer resolve; and a **reused** role name
  bypasses the fork entirely, however the entry is written. When any of those fails the child starts fresh
  and the receipt says so - it never claims history it did not inherit.

## Filling in a role block

Text in `<angle brackets>` is ours to fill in: name the concrete thing, not the category - a pronoun
is not a fill. Everything outside the brackets is the boundary that makes the role useful; keep it.

A block may also mark a bracket as one **not** to write, and that marking is the one thing the
surrounding text cannot tell you: a bracket a block explicitly marks as not-to-write stays as written.

## The entry

```text
{ persona: [...], blacklist: [...], task: "...", fork: "..." }
```

The field-by-field rules and the visibility gate are in `references/entries.md`; these hold while
writing:

- `persona` is a reserved string or `[role, description]` - exactly two non-empty strings. The role
  name is also the identity the program keys on, so two entries must never share one.
- `task` is required and hard-checked - an empty one is rejected - and is the subagent's first
  message, so write the ask, the scope and what counts as done into it.
- **Do not open a task with a holding instruction.** Because the `task` *is* the first message, "stand
  by, you will be dispatched later" is taken literally: the role reads it as its whole assignment and
  sits idle until someone messages it again. Write the actual ask from the first word, and queue later
  work by messaging the role once it has reported.
- `blacklist` names tools the entry denies; the preset appends its own 9-tool default deny list, so
  adding names narrows the role and an empty list adds nothing back.
- `fork` is `"main"`, `"none"` or a subagent id.
- `id`, `status` and `summary` belong to the program. `summary` is kept to its first line at 200
  characters, which is why a subagent's closing message must lead with its verdict.

## What this file does not decide

Whether the work should be dispatched at all, and which role should do it: that is the orchestration
skill for the work type. What the role's instructions and boundaries are: the `persona` description
on the entry. What the subagent is told it must not be told: the `task`.
