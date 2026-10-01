---
name: building-something-new
description: Use when creating something that does not exist yet and its shape is still open - a feature, a script, a plugin, a document, an interface - and you must decide who designs it, who builds it, and who checks it. Not for fixing what is broken, executing a plan someone already agreed on, or porting an existing thing.
user-invocable: false
---

# Building something new

One work type: creating something that does not exist yet, where the shape is still open.

**For the main agent.** This file is registered main-agent-only in `functions/kaz-shared/lib/skill-visibility.js`; the role blocks below are inputs to `write_arrangement`, not text addressed to anyone.

## Workflow

1. Define what "done" means - who accepts it, and what counts as good. **Before dispatching anyone.**
2. If the shape is still open: dispatch two proposers that disagree, and arbitrate between them. If the
   shape is already agreed: skip straight to building.
3. Split the work into pieces that can each be verified on their own.
4. Dispatch the builder. Then check the artifact against the intent, and the fact by running it, in our
   own hands.
5. Assemble and verify against step 1 yourself.
6. Report what was verified and what was not.

The dispatching mechanics, and what a dispatch is worth, are in `kaz-dispatch`. What follows is only
what this work type adds: two proposers are e.g. `proposer-a` and `proposer-b`.

## Our work

We keep these; they cannot be delegated to a subagent.

- **Deciding what "done" means.** A subagent defines it in its own favour.
- **Arbitrating** between competing proposals, and saying why we chose one.
- **Talking to the user** - clarifying, reporting, promising.
- **Final acceptance**, because a builder is the worst-placed judge of its own work.
- **The whole picture.** No subagent holds it; while several run, it exists only with us.

Dispatch when briefing plus checking costs less than doing it ourselves, and only for the parts that
can be checked on their own; checking them is ours once the work is back.

## Subagents

Text in `<angle brackets>` is ours to fill in - name the concrete thing, not the category.

`blacklist` is **enforced**, not a suggestion: a denied tool is absent from the subagent's tool face,
and calling it errors. Names in the reserved set are dropped silently, and unknown names are skipped
with a note in the dispatch receipt - so write only real tool names, and read the receipt once. Treat
these lists as a starting point: add names when the task needs narrower hands, and remember that `pwsh`
can do everything `write` and `edit` can, so a read-only role that keeps `pwsh` is not read-only.

A `task` is required for every entry. Write it as: the ask, the artifact or path it works on, and what
counts as done.

The two proposers are the one dispatch this work type keeps for its own sake: opposing directions
have to arrive independently, so neither inherits the other's argument.

### proposer-a - one direction, defended

```
role: a design hand arguing for <the direction that buys the most if it works, and what it costs if it does not>
description: We push for the version that would still be worth having if <what we refuse to give up>
  were non-negotiable. We state one direction, not a menu - a menu is a way of not deciding. We lean
  toward <the part that is hardest to reverse later>. We name the single case that would change our
  mind. We do not write files and we do not implement; our contribution is the argument and its weak
  point.
blacklist: write, edit, pwsh, present, todo_write
```

### proposer-b - the other way

```
role: a design hand arguing for <the smallest thing we can ship that we will not have to undo>
description: We argue for the version that still looks reasonable when <the assumption most likely to
  fail> does. We state one direction and say what it gives up. We assume <schedule, requirements,
  scale> moves against us. We do not write files and we do not implement.
blacklist: write, edit, pwsh, present, todo_write
```

### builder - builds what was decided

```
role: a hand that builds exactly <the direction arbitration chose>
description: We build <the direction arbitration chose> and do not re-decide it. We do not quietly
  shrink the scope: when that direction cannot be followed as given, we stop and say so. We report
  what we built, what we could not build, and which claims we actually checked.
blacklist: (empty - this role must be able to write and run things)
```

Check it yourself, against the artifact and the intent we fixed in step 1: read what the builder
claims, run the command that would prove it, and compare the artifact against what was asked for.
Report what did not hold.

Stop dispatching when two rounds in a row produce no new difference: at that point the remaining risk
is ours to accept, not another subagent's to find.
