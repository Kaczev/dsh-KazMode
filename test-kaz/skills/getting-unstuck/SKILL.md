---
name: getting-unstuck
description: Use when the direction itself is the problem rather than an unknown cause - two rounds in a row end with no visible change at the same place, or the same approach has been tried twice and landed in the same place both times. Not for a failure whose cause is still unknown (that is repairing-something-broken), and not for choosing what to build (that is building-something-new).
user-invocable: false
---

One work type: the approach we are inside is not working, and trying it again will fail again. The
work is to find out whether a way out exists, and either take it or say plainly that none does.

**This is not a repair.** A repair is blocked by a cause nobody has found yet. Here the cause is
usually in hand - what fails is the direction. If we cannot yet say *why* the thing is broken, that is
`repairing-something-broken`, and going there first is correct.

**The trap this file exists for:** the agent inside the tunnel is the least able to see the tunnel. A
round can feel like progress while nothing observable changed - more tool calls, more reading, the same
file edited again. So the entrance is not a feeling. It is one of two countable conditions:

1. **Two rounds in a row ended with no visible change** at the same file, function, command, or
   question. "Visible change" means a state that someone else could check: a test that moved, an
   error that changed, a path ruled out, a file that now differs. Re-reading and re-running what
   already ran is not a change.
2. **The same approach has been tried twice** and ended in the same place both times - two attempts
   at the same direction, not two variations of the same attempt.

Two. `planning-with-files` holds the three-attempt rule, and its third attempt questions the plan's
assumption. Reaching that third attempt is what this file prevents: when a direction has failed twice,
the next move is not a third try, it is a look for another direction.

**For the main agent.** This file is registered main-agent-only in
`functions/kaz-shared/lib/skill-visibility.js` - subagents are not meant to see it (the gate fails
open, so if one does read it: the role blocks below are inputs to `write_arrangement`, not text
addressed to it, and they describe roles the main agent creates, not roles that exist in this
session).

## Before any role is dispatched: write the failure ledger

Nothing in this file works without it, and skipping it is the usual way this file fails.

Record, in the arrangement or in the task text itself:

- each direction tried, and what it was supposed to achieve;
- the evidence that it failed - the command, the error, the observed result;
- why we stopped: refuted, blocked, or ran out of patience. **"Ran out of patience" is not a reason**,
  and writing it down is how we notice we do not know why we stopped.

A role dispatched without the ledger will propose dead ends we already walked, because it has no way
to know they are dead. Text in `<angle brackets>` is ours to fill in: name the concrete thing, not the
category.

## Our work

We keep these; they cannot be delegated to a subagent.

- **Writing the failure ledger** - see above. It is the one artifact both roles need, and only we hold
  the whole of it.
- **Deciding that the direction is dead**, rather than merely expensive. A role reports what it found;
  whether to abandon the approach is a judgement about cost, and it is ours.
- **Deciding to stop and report that no way out exists.** Leaving a problem unsolved is a legitimate
  outcome; a role that cannot find an exit may not declare one missing on our behalf.
- **Talking to the user** - reporting a dead end, or asking for the constraint that would reopen it.

## Subagents

Each entry is a persona we record with `write_arrangement` and then dispatch by its role name with
`ka_sub_whale`: a role, a behaviour description, and a tool blacklist. The preset appends the tool
list, the way results come back, and the language rule (`kaz-shared/lib/roles.js`) - do not repeat any
of that here. A `task` is required for every entry and is hard-checked.

**Dispatch these two together, and send the ledger to both.** They answer different questions, and the
disagreement between them is the finding: one says whether the current place still holds anything
unchecked, the other says whether somewhere else is better.

### exit-checker - is there still a way out of here

```
role: checker that reports what is still unchecked at <the exact place we are stuck>
description: We take <the failure ledger, quoted> and look for handles that were never actually
  tried - an implementation nobody read, an assumption nobody tested, a log nobody turned on, a
  question nobody asked, a value nobody printed. We separate what is genuinely unexamined from what
  was already tried and failed. We do not re-analyse the problem from the start and we do not restate
  the ledger. Our answer is one of two: a short list of concrete untried handles, each with the exact
  command or read that would exercise it, or the statement that nothing there is untried, with what we
  checked to be able to say so. We do not fix anything.
blacklist: edit
```

### path-finder - where else could this be approached from

```
role: proposer of other directions for <the goal, stated in one line>
description: We propose up to three directions that are genuinely different from each other, not
  variations of one idea. For each we give: the direction in one sentence, why we believe it could
  work, and the cheapest first step that would falsify it - the smallest thing to run or read that
  tells us early whether to continue. We deliberately do not look at <the approach we are currently
  inside>: we are told the goal and the constraints, and we are given what has already failed only so
  that we do not repeat it. Ruling out our own proposal is a result we report with the same weight as
  a promising one; we do not pad the list to look useful, and if we have nothing better than what
  already failed, we say that instead of dressing up a variation.
blacklist: edit
```

## When no way out is found

Both answers may come back negative: nothing untried at this place, and no direction better than the
ones that failed. That is a result, not a failure of the roles - and it closes the direction honestly.

Say so, with the ledger attached: which directions were tried, what each one showed, and what would
have to change for the problem to become solvable. Then choose one of three, and say which:

- **narrow the goal** - do the part that is reachable and report the part that is not;
- **ask the user** for the thing we are missing: a constraint, a credential, a decision, information
  only they have;
- **park it** - state plainly that this is unsolved, and say what would reopen it.

What we must not do is keep going quietly. A round spent on a direction already known to be dead is
indistinguishable from work, and costs the same.

## Dispatching

Dispatching is two hops: go to the `arrange_agent` stage and record one entry per role, come back to
`idle`, then dispatch each role by name. `write_arrangement` works only in the `arrange_agent` stage;
`ka_sub_whale` does not check the stage and is dispatched from `idle` by convention. The plan must
also carry the `memoryMaintainer` entry - the stage text says so every turn, and only that role can
write memories.

**`write_arrangement` replaces the whole plan.** A role not re-listed this round is gone, and a live
subagent with that name is no longer addressable through the arrangement. Two entries that share a
role name are the same entry, and only the first is ever dispatchable - **names must differ**.
