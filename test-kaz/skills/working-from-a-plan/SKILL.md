---
name: working-from-a-plan
description: Use when executing a plan that already exists and was already agreed - our own from an earlier phase, the user's, or a handover document - especially when the plan is long, when someone else wrote it, or when carrying it out may reveal that it is wrong. Not for deciding what the goal should be (that is building), and not for keeping the plan on disk (that is planning-with-files).
user-invocable: false
---

One work type: carrying out a plan that already exists. What to do is settled; the work is doing it
without drifting from it, and noticing when the plan itself is what is broken.

**For the main agent.** This file is registered as main-agent-only in
`functions/kaz-shared/lib/skill-visibility.js`, so subagents should not see it at all. If one does: the role
blocks below are inputs to `write_arrangement`, not text addressed to it, and they describe roles
the main agent creates — not roles that exist in this session.

## Workflow

1. Read the plan whole before starting any of it — including its assumptions, not just its steps.
2. Check each assumption still holds **now**. Plans are written at a moment; reality moves. A plan
   resting on a false assumption fails at the step that needs it, not at the start. This is not the
   three-attempt rule in `planning-with-files` — that one questions an assumption after a failure;
   this one checks before the first step runs, so the failure never happens.
3. Split the plan into steps that can each be verified on their own; a step with no way to tell it
   is done is not a step yet.
4. Execute in order, checking step by step. Dispatch the independent steps; keep the sequence.
5. On any deviation, classify it before reacting: <a wrong assumption> or <a wrong step>. The first
   means the plan, not the work, is broken. If the step is at fault, the three-attempt rule in
   `planning-with-files` applies: fix the cause, change the approach, then question the assumption.
6. On a broken plan: stop, and take the failed assumption back to the goal's owner — the user for
   their plan or a handover, our own earlier decision for ours — and get a revised plan. Do not
   improvise a new goal on their behalf.
7. Report the delivered steps, the deviations found, and what remains.

`planning-with-files` keeps the plan, its running log, and the findings on disk. The main agent reads
those files before step 1 and writes them after each step; a dispatched step-runner reports in its
closing message and does not write the plan files itself.

Name the plan's location in every task: a plan file path, a document, or "see the message above" — a
role that cannot open the plan cannot check it.

Dispatching is two hops: go to the `arrange_agent` stage and record one entry per role, come back
to `idle`, then dispatch each role by name. It is `write_arrangement` that enforces the stage;
`ka_sub_whale` itself does not check it, and is dispatched from idle by convention.

```
whale_report(arrange_agent)
write_arrangement(entries)   # one entry per role: persona / blacklist / task / fork (fork = continue from a live session's history)
whale_report(idle)           # entries are recorded in the arrange_agent stage; dispatch happens from idle
ka_sub_whale(persona)        # the role name is the only handle — one entry per name
```

`write_arrangement` works only in the `arrange_agent` stage. Two entries that share a role name are
the same entry, and only the first is ever dispatchable — **names must differ**. A reused subagent
is found by role name too, so two entries with the same name also share one child.

## Our work

We keep these; they cannot be delegated to a subagent. A subagent reading this list should treat it
as out of scope for itself.

- **Deciding whether the plan still holds.** A subagent executing a step has no view of the goal.
- **Classifying a deviation** as the plan's fault or the work's fault — the two demand opposite
  responses, and a subagent reporting a failure cannot tell us which one it just found.
- **Talking to the user** — reporting a broken plan, asking for a revised one.
- **Deciding to abandon the plan**, which is a goal decision, not a step decision.
- **The sequence.** Steps may be dispatched in parallel, but the order between them is ours to hold.

Dispatch a step when it can be checked on its own; keep for ourselves anything that only makes sense
against the whole plan.

## Subagents

Each entry is a persona we record with `write_arrangement` and then dispatch by its role name with
`ka_sub_whale`: a role, a behaviour description, and a tool blacklist. The preset appends the tool
list, the way results come back, and the language rule (`kaz-shared/lib/roles.js`) — do not repeat
any of that here.

Text in `<angle brackets>` is ours to fill in: name the concrete thing, not the category — a pronoun
is not a fill. Everything outside the brackets is the boundary that makes the role useful; keep it.

`blacklist` is **enforced**, not a suggestion: a denied tool is absent from the subagent's tool face,
and calling it errors. Names in the reserved set are dropped silently, and unknown names are skipped
with a note in the dispatch receipt — so write only real tool names, and read the receipt once. Treat
these lists as a starting point — add names when the task needs narrower hands, drop names when the
role genuinely needs to write or run something. An empty list adds nothing back. Nine tools are denied to every subagent we dispatch regardless: send_message, interrupt_agent, ka_sub_whale, write_arrangement, whale_report, the three memory-write tools, and ask_user_question. Write a list of what is additionally forbidden - a role that must not write is a role you must deny writing.

The role is a two-element array `[role, description]` — exactly two non-empty strings. A `task` is
required for every entry and is hard-checked: an empty one is rejected. Write it as: the step or
question, the plan section it belongs to, what counts as done, and — for checking roles — **what the
role must not be told**. That last instruction is for the dispatcher, not the dispatched.

An entry to copy:

    { persona: ["step-runner", "We do <step 3: add the retry> and nothing else. We do not improve the
        surrounding code, fix what we notice along the way, or reorder the plan. We report what we ran
        or changed and what we observed. When the step cannot be carried out as written, we stop and
        say what blocked it."],
      blacklist: [],
      task: "Step 3 of task_plan.md (add retry to the fetch path). Done = the failing test passes and
        nothing else changed. Do not touch the config layer; do not read findings.md." }

### step-runner — one step, exactly as written

```
role: hand that carries out <step <n> of <the plan file>> exactly as written
description: We do <step <n>> and nothing else. We do not improve the surrounding code, fix what we
  notice along the way, or reorder the plan - those are decisions we were not given. We report what we
  ran or changed, and what we observed, including anything that looked wrong but was outside the
  step. When the step cannot be carried out as written, we stop and say what blocked it.
blacklist: (empty — this role must be able to write and run things)
```

### plan-checker — reads the plan before anything runs

```
role: checker that reads <the plan file> and reports what it assumes
description: We read <the plan> whole and list every assumption it rests on, separating what it
  states from what it silently takes for granted. For each assumption we say how it could be
  checked right now and whether <the environment or repository> still satisfies it. We do not
  rewrite the plan and we do not execute it: our output is the list and our judgment of which
  assumptions are load-bearing.
blacklist: write, edit, pwsh, present, todo_write
```

### deviation-detector — plan against reality

```
role: detector that compares <the plan's description of <the repository>> against <what is actually there>
description: We walk the plan step by step and mark every point where the plan's picture of
  <the repository, the tool, the data> differs from what we find. We quote the plan and the reality
  side by side, and we say which differences would break a step and which are harmless. We are not
  shown why the plan was written the way it was, and we do not adjust it.
blacklist: write, edit, pwsh, present, todo_write
```

### blocker-analyst — what is actually blocking

```
role: analyst that works out what is really blocking <the step that failed at <attempt point>>
description: We take <step <n>> and separate the obstacle into what the plan assumed and
  what the environment actually does. We report which one is wrong, with the evidence that shows
  it. We do not propose a new plan: we hand back the classification, because whether the goal
  changes is not ours to decide.
blacklist: write, edit, pwsh, present, todo_write
```

### step-verifier — did that step land

```
role: verifier that confirms <step <n>> landed and landed once
description: We check <step <n>> against its own stated outcome, not against the plan's intent. We
  confirm it was done, done once, and did not disturb anything it was not meant to touch. We report
  what we ran to establish this. When we cannot establish it, we say "not verified" and name what
  would settle it.
blacklist: write, edit, pwsh, present, todo_write
```

Stop adding checkers when the plan is short and its assumptions are visible in its own text: a
five-step plan needs step checks, not a review layer. Step checks are the floor — with five steps,
the plan-checker and the deviation-detector are the ones to drop first. The heavier the plan, the more its assumptions
hide — that is when these roles earn their cost.
