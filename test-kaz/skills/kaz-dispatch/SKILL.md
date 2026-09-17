---
name: kaz-dispatch
description: Use when the dispatch mechanics are what is in question, not the work, or before the first arrangement of a session is recorded - the two hops, the entry shape, the memoryMaintainer entry, reserved personas, and the visibility gate.
user-invocable: false
---

# Dispatching in the Kaz preset

This file owns the mechanics of handing work to a subagent. The orchestration skills
(`repairing-something-broken`, `building-something-new`, `working-from-a-plan`,
`moving-or-upgrading-a-thing`, `reviewing-someone-elses-work`, `getting-unstuck`, `cleaning-up-slop`) decide
**when** a dispatch is warranted and **who** does the work. They do not restate how the arrangement is
recorded, shaped, or dispatched - this file does, once.

## The two hops

Dispatching is two tool calls in two stages, plus the stage moves between them.

```
whale_report(arrange_agent)   # hop 1: enter the arrangement stage
write_arrangement(entries)    # record the whole round's plan
whale_report(idle)            # hop 2: get out; the entries are now recorded
ka_sub_whale(persona)         # dispatch one entry, by role name
```

- `write_arrangement` works **only** in `arrange_agent` and fails in any other stage. Entering the stage is
  `whale_report("arrange_agent")`, and `idle` is the only legal target from there.
- `ka_sub_whale` does not check the stage. Dispatch from `idle` by convention: the arrangement is written on
  the way in and the dispatching happens on the way out.
- `ka_sub_whale` takes one argument, the persona - the role name. Everything else (blacklist, task, fork)
  comes from the recorded entry. The entry's `task` becomes the subagent's first message.
- Independent entries go out in the same round; at most five subagents may be **running** at once, and a
  subagent that is loaded but between turns does not count against that.

## The entry

```
{ persona: [...], blacklist: [...], task: "...", fork: "..." }
```

- `persona` is either one of the reserved strings or `[role, description]` - an array of **exactly two
  non-empty strings**. Nothing else is accepted.
- `task` is required on every entry and is hard-checked: an empty or whitespace-only one is rejected. It is
  the subagent's first message, so write the ask, the scope, and what counts as done into it.
- `blacklist` is optional and is enforced, not advisory: a denied tool is absent from the subagent's tool
  face and calling it errors. The preset's own default deny list applies to every dispatched subagent on top
  of whatever is written here; adding names narrows the role further, and an empty list adds nothing back.
  Names in the reserved set are dropped silently and a name that is not a real tool is skipped with a note
  in the dispatch receipt - so read the receipt once rather than assuming the list landed whole.
- `fork` is optional and names a live session - `"main"` or a subagent id - whose completed history seeds
  the new subagent. If that session is not live, the dispatch starts fresh instead of failing, and says so in
  its receipt.
- `id`, `status`, and `summary` are the program's fields. Do not write them; they are filled on dispatch and
  preserved by role name across rewrites of the plan. `get_arrangement` reads them back, with `summary`
  truncated to its first line at 200 characters - which is why a subagent's closing message must lead with
  its verdict.

## The reserved values

| value | what it is for | its tool face |
|---|---|---|
| `"main"` | the main agent itself. It is a legal entry and **not dispatchable** - dispatching it is refused. | n/a |
| `"memoryMaintainer"` | the memory keeper. Only this role can write memories. | fixed by the preset |
| `"slopCleaner"` | the AI-slop cleaner, dispatched for a cleanup. | fixed by the preset |

- **The plan must contain `memoryMaintainer`, every round.** The stage text says so on entry, and it is the
  only role that can write a memory. An arrangement written without it is a round in which nothing can be
  remembered.
- For the two fixed-face roles the tool face comes from the preset, so a `blacklist` written on that entry
  would be ignored - and an entry that carries one is **rejected** rather than quietly accepted. Drop the
  field, or use `[role, description]` if the role needs narrowing.
- A reserved value may also be written as `[reservedName, description]`. It reaches the same fixed persona
  and the same fixed tool face, because the reserved name is matched as the role name - but write the bare
  string: it is what the entry validator, this file, and the dispatcher all agree on, and a later reader
  cannot tell the two forms apart.

## Role names are identity, and they are the reuse key

- `write_arrangement` **replaces the whole plan.** An entry that is not restated in this call is gone, and a
  live subagent with that name stops being addressable through the arrangement. Restate every entry the round
  still wants, `memoryMaintainer` included.
- Two entries that share a role name are the same entry, and only the first is ever dispatchable. **Names
  must differ** - two hypotheses are `cause-a` and `cause-b`, never `cause` twice.
- Re-dispatching a name that is already loaded **reuses** that subagent with its earlier context instead of
  starting a fresh one. That is the point: a second dispatch in the same conversation continues a role that
  already knows what it was told. The consequence to plan around is the opposite of fresh eyes - queue more
  work for a role rather than expecting it to re-read its first instructions.
- Dispatching a name whose subagent is still running is refused; wait for its report instead.
- A role that must be independent of another must therefore have a **different name**. Forking a role, or
  re-dispatching the same name, hands the work to an agent that has already seen it.

## Reading the result back

Dispatch returns a receipt; read it. It names the subagent id, whether an existing one was reused or a fresh
one was started, whether a requested `fork` target was reachable, and which blacklist names were skipped.
A refusal names the reason - an unknown persona, an entry with no task, a fixed-tool-face entry carrying a
blacklist, a name with no recorded entry, or the running cap. The refusal is the diagnosis; there is no
second place to look.

`get_arrangement` reads the plan back with the program's fields, in any stage. When the conversation has
grown long, prefer it over reconstructing what was dispatched from memory.

## What this file does not decide

- Whether the work should be dispatched at all, and which role should do it: that is the orchestration
  skill for the work type.
- What the role's instructions and boundaries are: that is the `persona` description on the entry.
- What the subagent is told it must not be told: that belongs in the `task`, written for the dispatcher.
- Whether a skill is visible to a subagent: this file is registered main-agent-only, in
  `functions/kaz-shared/lib/skill-visibility.js`. A skill that belongs to the main agent and is not listed
  there is visible to every subagent.
