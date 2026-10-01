---
name: working-from-a-plan
description: Use when executing a plan that already exists and was already agreed - our own from an earlier phase, the user's, or a handover document - especially when the plan is long, when someone else wrote it, or when carrying it out may reveal that it is wrong. Not for deciding what the goal should be (that is building), and not for keeping the plan on disk (that is planning-with-files).
user-invocable: false
---

# Working from a plan

One work type: carrying out a plan that already exists. What to do is settled; the work is doing it
without drifting from it, and noticing when the plan itself is what is broken.

**For the main agent.** This file is registered main-agent-only in `functions/kaz-shared/lib/skill-visibility.js`; the role blocks below are inputs to `write_arrangement`, not text addressed to anyone.

## Workflow

1. Read the plan whole before starting any of it - including its assumptions, not just its steps.
2. Check each assumption still holds **now**. Plans are written at a moment; reality moves. A plan
   resting on a false assumption fails at the step that needs it, not at the start. This is not the
   three-attempt rule in `planning-with-files` - that one questions an assumption after a failure;
   this one checks before the first step runs, so the failure never happens.
3. Split the plan into steps that can each be verified on their own; a step with no way to tell it
   is done is not a step yet.
4. Execute in order, checking step by step. Dispatch the independent steps; keep the sequence.
5. On any deviation, classify it before reacting: <a wrong assumption> or <a wrong step>. The first
   means the plan, not the work, is broken. If the step is at fault, the three-attempt rule in
   `planning-with-files` applies: fix the cause, change the approach, then question the assumption.
6. On a broken plan: stop, and take the failed assumption back to the goal's owner - the user for
   their plan or a handover, our own earlier decision for ours - and get a revised plan. Do not
   improvise a new goal on their behalf.
7. Report the delivered steps, the deviations found, and what remains.

`planning-with-files` keeps the plan, its running log, and the findings on disk. The main agent reads
those files before step 1 and writes them after each step; a dispatched step-runner reports in its
closing message and does not write the plan files itself.

Name the plan's location in every task: a plan file path, a document, or "see the message above" - a
role that cannot open the plan cannot check it.

The dispatching mechanics, and what a dispatch is worth, are in `kaz-dispatch`. What follows is only
what this work type adds: where the plan is, and who holds the sequence.

## Our work

We keep these; they cannot be delegated.

- **Deciding whether the plan still holds.** A subagent executing a step has no view of the goal.
- **Classifying a deviation** as the plan's fault or the work's fault - the two demand opposite
  responses, and a subagent reporting a failure cannot tell us which one it just found.
- **Talking to the user** - reporting a broken plan, asking for a revised one.
- **Deciding to abandon the plan**, which is a goal decision, not a step decision.
- **The sequence.** Steps may be dispatched in parallel, but the order between them is ours to hold.

Dispatch a step when it can be checked on its own; keep for ourselves anything that only makes sense
against the whole plan.

## Subagents

Text in `<angle brackets>` is ours to fill in - name the concrete thing, not the category.

`blacklist` is **enforced**, not a suggestion: a denied tool is absent from the subagent's tool face,
and calling it errors. Names in the reserved set are dropped silently, and unknown names are skipped
with a note in the dispatch receipt - so write only real tool names, and read the receipt once. Treat
these lists as a starting point: add names when the task needs narrower hands, and drop names when the
role genuinely needs to write or run something. An empty list adds nothing back.

A `task` is required for every entry. Write it as: the step or question, the plan section it belongs
to, and what counts as done.

What a step-runner may not be told is the dispatcher's decision, not the role's: the plan section and
the boundary on what the step may touch are ours to write into the task.

An entry to copy:

    { persona: ["step-runner", "We do <step 3: add the retry> and nothing else. We do not improve the
        surrounding code, fix what we notice along the way, or reorder the plan. We report what we ran
        or changed and what we observed. When the step cannot be carried out as written, we stop and
        say what blocked it."],
      blacklist: [],
      task: "Step 3 of task_plan.md (add retry to the fetch path). Done = the failing test passes and
        nothing else changed. Do not touch the config layer; do not read findings.md." }

### step-runner - one step, exactly as written

```
role: hand that carries out <step <n> of <the plan file>> exactly as written
description: We do <step <n>> and nothing else. We do not improve the surrounding code, fix what we
  notice along the way, or reorder the plan - those are decisions we were not given. We report what we
  ran or changed, and what we observed, including anything that looked wrong but was outside the
  step. When the step cannot be carried out as written, we stop and say what blocked it.
blacklist: (empty - this role must be able to write and run things)
```

Check each step yourself, against its own stated outcome rather than the plan's intent: run what it
takes to establish the step landed, that it landed once, and that it disturbed nothing it was not
meant to touch. Report what could not be established.

The heavier the plan, the more its assumptions hide - that is when reading it costs more than it
looks, and it is also when the plan-replacement rule above matters most.

