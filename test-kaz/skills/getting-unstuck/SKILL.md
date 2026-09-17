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
   already ran is not a change. A round here means one pass of work on the problem: a user turn, or a
   dispatch round if we are dispatching. If we are unsure whether a round changed anything, count it
   as unchanged - the doubt is the finding.
2. **One direction has been walked twice without moving** - two attempts at the same layer, with the
   same kind of solution, failing in the same place. Same *layer* and same *kind of solution* is the
   test, and it is the exact opposite of what the other files call a different approach: rewording the
   fix, retrying the same command, or moving the same code around inside the same layer is the same
   direction and counts. Changing tool, layer, or hypothesis is a different direction and does not
   count. Do not count "we have been at this a while" - that is not a direction.

Note the hand-off with `planning-with-files`, because the two files count differently on purpose.
There, attempt 2 is already "change the approach - different tool, different layer". So a second
attempt that genuinely changed the approach is *not* the condition above; condition 2 is what catches
the case where the approach did not really change, or where changing layer also failed and the
direction itself is now suspect. When condition 2 is met, the next move is not a third try and not a
third layer: it is a look for another direction.

**For the main agent.** This file is registered main-agent-only in
`functions/kaz-shared/lib/skill-visibility.js`. The role blocks below are inputs to
`write_arrangement`, not text addressed to anyone.

## Before any role is dispatched: write the failure ledger

Nothing in this file works without it, and skipping it is the usual way this file fails.

Write the ledger into the `task` of **each** entry we dispatch. A dispatched role does not see the
main agent's plan: `get_arrangement` is main-agent-only. What it does have is `list_agents`, so a
role can see which other agents are running. That is why the task field is the channel, and why what
goes in it is chosen deliberately.

Record, for every direction that is **dead**:

- the direction, and what it was supposed to achieve;
- the evidence that it failed - the command, the error, the observed result;
- why we stopped, as one of three: **refuted** (ruled out - move on), **blocked** (needs something we
  do not have - that is an "ask the user" ending), or **we do not know why we stopped**. The third is
  not a reason; writing it down is how we notice we cannot say why we stopped, and it belongs in the
  report to the user rather than being treated as a dead direction.

**The ledger holds failed directions, not the one we are inside.** Keep the current approach out of the
arrangement entirely - it stays in our own context - so that a role can be dispatched without it. A
role handed the ledger is told what is dead so it does not walk there again; that is all it needs.

A role dispatched without the ledger will propose dead ends we already walked, because it has no way
to know they are dead. One convention to keep in mind when reading the blocks below: text in
`<angle brackets>` is ours to fill in - name the concrete thing, not the category - **except where a
bracket is explicitly marked as something not to write**.

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
description: We take <the ledger of dead directions> and look for handles that were never actually
  tried - an implementation nobody read, an assumption nobody tested, a log nobody turned on, a
  question nobody asked, a value nobody printed. We separate what is genuinely unexamined from what
  was already tried and failed. We do not re-analyse the problem from the start and we do not restate
  the ledger. Our answer is one of two: **at most five** concrete untried handles, each with the exact
  command or read that would exercise it, listed most-likely-first, or the statement that nothing
  there is untried, with what we checked to be able to say so. We stop looking when we have five, or
  when the next candidate would need a step the ledger already records as failed. We do not fix
  anything. "I have not finished looking" is not an answer.
blacklist: edit
```

### path-finder - where else could this be approached from

```
role: proposer of other directions for <the goal, stated in one line>
description: We propose up to three directions that are genuinely different from each other, not
  variations of one idea. For each we give: the direction in one sentence, why we believe it could
  work, and the cheapest first step that would falsify it - the smallest thing to run or read that
  tells us early whether to continue. We are given the goal, the constraints, and the ledger of
  dead directions - nothing else, and deliberately no description of what the main agent is currently
  doing, so that we cannot simply re-propose it. Ruling out our own proposal is a result we report
  with the same weight as a promising one; we do not pad the list to look useful, and if we have
  nothing better than what already failed, we say that instead of dressing up a variation.
blacklist: edit
```

## When no way out is found

Both answers may come back negative: nothing untried at this place, and no direction better than the
ones that failed. That is a result, not a failure of the roles - and it closes the direction honestly.

Say so, with the ledger attached: which directions were tried, what each one showed, and what would
have to change for the problem to become solvable. Then choose one of three, and say which:

- **narrow the goal** - do the part that is reachable, report the part that is not, and say the goal
  is now the smaller one;
- **ask the user** for the thing we are missing: a constraint, a credential, a decision, information
  only they have - this is where a **blocked** stop reason ends;
- **park it** - state plainly that this is unsolved, say what would reopen it, and stop working on it.
  Parked means parked: not re-attacked this round, and not re-attacked next round with the same roles.

Each of the three is a final answer, not a stage of one. Whichever we choose, the report names it and
names the ledger behind it.

**How we stop dispatching.** Stop when both roles come back negative *and* the ledger has not grown
since the last dispatch: at that point we are dispatching on the same information, and another round
of it cannot produce anything new. Stop also when the ledger records three dead directions - past
that, more directions are not the missing thing; the goal, the constraint, or the information is.
Either stop ends this file's work: what follows is one of the three answers above, not another
dispatch.

What we must not do is keep going quietly. A round spent on a direction already known to be dead is
indistinguishable from work, and costs the same.

## Dispatching

The dispatching mechanics are the same for every work type; they are in `kaz-dispatch`. What follows
is only what this work type adds.
