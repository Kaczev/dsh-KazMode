---
name: getting-unstuck
description: Use when the direction itself is the problem rather than an unknown cause - two rounds in a row end with no visible change at the same place, or the same approach has been tried twice and landed in the same place both times. Not for a failure whose cause is still unknown (that is repairing-something-broken), and not for choosing what to build (that is building-something-new).
user-invocable: false
---

# Getting unstuck

One work type: the approach we are inside is not working, and trying it again will fail again. The
work is to find whether a way out exists, and either take it or say plainly that none does.

**This is not a repair.** A repair is blocked by a cause nobody has found yet; here the cause is
usually in hand and what fails is the direction. If we cannot yet say *why* the thing is broken,
that is `repairing-something-broken`, and going there first is correct.

**The trap this file exists for:** the agent inside the tunnel is the least able to see the tunnel. A
round can feel like progress while nothing observable changed: more tool calls, the same file edited
again. So the entrance is not a feeling but one of two countable conditions:

1. **Two rounds in a row ended with no visible change** at the same file, function, command, or
   question. Visible change means a state someone else could check: a test that moved, an error that
   changed, a path ruled out, a file that now differs. Re-reading and re-running what already ran is
   not a change, and a round is one pass of work on the problem: a user turn, or a dispatch round.
   Count an unsure round as unchanged - the doubt is the finding.
2. **One direction has been walked twice without moving on**: two attempts at the same layer, with
   the same kind of solution, failing in the same place. That is the test, and it is the opposite of
   a different direction - rewording the fix or retrying the same command is the same direction,
   while changing tool, layer, or hypothesis is not. "We have been at this a while" is not one.

`planning-with-files` counts differently on purpose: there, attempt 2 is already "change the
approach - different tool, different layer". So a genuine change of approach is *not* condition 2,
which catches the approach that did not really change, or where changing layer also failed and the
direction is now suspect. And once it is met the next move is not a third try but a look for another
direction.

**For the main agent.** This file is registered main-agent-only in
`functions/kaz-shared/lib/skill-visibility.js`; what it records is an input to a dispatch. The
dispatching mechanics, and what a dispatch is worth, are in `kaz-dispatch`.

## Write the failure ledger first

Nothing here works without it, and skipping it is the usual way this file fails. It comes before any
look or dispatch, because both are aimed at it.

The ledger is a **file**, at a path we name, opening with the direction we are inside and the goal it
was meant to reach. In the conversation instead, it is lost to the next round and cannot be handed
to anyone. `planning-with-files` has the file discipline, `powershell-scripting` the writing.

Record, for every direction that is **dead**:

- the direction, and what it was supposed to achieve;
- the evidence that it failed: the command, the error, the observed result;
- why we stopped: **refuted** (ruled out - move on), **blocked** (needs something we do not have -
  that is an "ask the user" ending), or **we do not know why we stopped**. The third is no reason:
  writing it down is how we notice we cannot say why we stopped, and it goes to the user rather than
  standing as a dead direction.

It holds failed directions, not the one we are inside - that stays in our own context. And it travels
only if we put it there: `get_arrangement` is mounted for the main agent alone, so a subagent cannot
read the plan. What it has is `list_agents`.

## What we keep for ourselves

We keep these; they cannot be delegated.

- **Writing the failure ledger** - every look and every dispatch is aimed at this one artifact.
- **Keeping the current approach out of anything we hand over.** A role given the ledger knows what
  is dead and will not walk there again, which is all it needs; one that re-proposes the current
  approach was told too much.
- **Deciding that the direction is dead**, rather than merely expensive. A look reports what it
  found; abandoning the approach is a judgement about cost, and it is ours.
- **Deciding to stop and report that no way out exists.** Finding no exit is not the same as
  declaring one missing.
- **Talking to the user** - reporting a dead end, or asking for the constraint that would reopen it.

## How we look for a way out

**Anything left unchecked?** Go through what the ledger does not cover for a handle never actually
tried - an implementation nobody read, an assumption nobody tested, a log nobody turned on, a
question nobody asked, a value nobody printed - and separate the genuinely unexamined from the
already failed. The answer is **at most five** such handles, each with the exact command or read that
would exercise it, most-likely-first, or the statement that nothing is untried, with what we checked
to be able to say so.

**Somewhere else better?** Up to three directions genuinely different from each other. For each: the
direction in one sentence, why it could work, and the cheapest first step that would falsify it.
Ruling out our own proposal carries the same weight as a promising one, and we do not pad the list to
look useful.

This is a **look, not a next attempt**: a handle we list and then act on is the third try this file
exists to prevent. Read the claims, run the command, compare the two sides - these are ours. A
dispatch earns its place only when the hunt needs context we cannot put in a task (a large artifact,
a long history) or when it must not inherit our reasoning about what is dead.

## When no way out is found

Both halves may come back negative: nothing untried, and no direction better than the ones that
failed. That is a result, not a failure.

Say so with the ledger attached: which directions were tried, and what would have to change for the
problem to become solvable. Then choose one of three, and say which:

- **narrow the goal** - do the part that is reachable, report the part that is not, and say the goal
  is now the smaller one;
- **ask the user** for what we are missing: a constraint, a credential, a decision, information only
  they have - this is where a **blocked** stop reason ends;
- **park it** - state plainly that this is unsolved, say what would reopen it, and stop working on
  it. Parked means not re-attacked this round, and not next round the same way.

Each is a final answer, not a stage of one, and the report names it and the ledger behind it.

**Two signs that we are done looking.** The ledger has not grown since the last look: another pass
over the same information cannot produce anything new. Or it records three dead directions - past
that, more directions are not the missing thing; the goal, the constraint, or the information is.
Either sign ends this file's work: what follows is one of the three answers above, never another
round on a direction already known to be dead.
