---
name: repairing-something-broken
description: Use when something that used to work, or was supposed to work, does not - a failing test, a crash, behaviour that is wrong but not fatal, or a report that "it just stopped". Not for building what never existed (that is building), and not for carrying out a plan that already covers the fix (that is working-from-a-plan).
user-invocable: false
---

One work type: something is broken and the cause is not yet known. The work is finding why before
changing anything, and proving afterwards that it is fixed.

**If the broken thing is an agent extension, a hook, or a seam**, the ordering in
`diagnosing-agent-extensions` comes first: prove it is mounted and its contribution registered before
reproducing anything. Do not re-derive that here. Come back to step 1 once you have that proof - and
know that a session may have no tool for enumerating mounted components, in which case the visible
skill catalog and your own tool face are the evidence, and "I could not see it" is not a finding
about the component.

**For the main agent.** This file is registered main-agent-only in
`functions/kaz-shared/lib/skill-visibility.js` — subagents are not meant to see it (the gate fails
open, so if
one does read it: the role blocks below are inputs to `write_arrangement`, not text addressed to it,
and they describe roles the main agent creates, not roles that exist in this session).

## Workflow

1. **Reproduce it before touching anything.** Write down the exact steps and the exact output.
   If it cannot be made to happen on demand — intermittent, load-dependent, already gone — do not
   stop: record the observed rate and the conditions it appeared under, and make *driving that rate
   to zero* the thing you must show. A rate is evidence; one lucky run is not.
   Before running it, look at what it will damage. If the reproduction writes outside the workspace,
   or destroys state you cannot recreate, stop and ask — a reproduction you cannot run twice is not
   one.
2. Say what **should** happen, in one line. Without it, "working" is only "different from before".
   **This line must exist in writing before any role is dispatched**, and its text goes into the
   fixer's and the regression-runner's task.
3. Find the cause, and keep asking why until the answer is a fact about the code rather than another
   symptom. Stop when a change to that fact would remove the failure.
4. Fix the smallest thing that removes the cause. Do not repair what the bug was hiding, and do not
   refactor on the way — both turn one known problem into several unknown ones. But if the cause is
   itself structural, say so plainly instead of band-aiding it: that is a finding, not a tangent.
5. **Change one variable at a time while testing hypotheses.** Once the cause is established, one
   coherent change is one change: cause plus call site, config key plus its reader, migration plus
   its caller. Do not split it to satisfy this rule, and do not bundle an unrelated change to save a
   round-trip.
6. Re-run the reproduction from step 1, then run what was passing before to check nothing else broke.
7. Report: the cause in one sentence, what changed, the reproduction now passing, and what was not
   re-tested. **Lead the closing message with the verdict** - the arrangement ledger keeps only its
   first line, truncated at 200 characters.

**A fix that makes the symptom go away without a mechanism is not a fix.** If the cause is still
unknown when the failure stops, say so — that is an unexplained disappearance, not a repair.

**Match the roles to the repair.** A failure with a one-line cause, a reproduction and a passing
suite needs no tracer and no skeptic: fix it, re-run, report. Add a role only when it removes a
specific doubt we cannot remove ourselves.

Dispatching is two hops: go to the `arrange_agent` stage and record one entry per role, come back to
`idle`, then dispatch each role by name. `write_arrangement` works only in the `arrange_agent` stage;
`ka_sub_whale` does not check the stage and is dispatched from `idle` by convention.

The plan must also carry the `memoryMaintainer` entry - the stage text says so every turn, and only that role can write memories.

```
whale_report(arrange_agent)
write_arrangement(entries)   # one entry per role: persona / blacklist / task / fork (fork = continue from a live session's history)
whale_report(idle)           # entries are recorded in the arrange_agent stage; dispatch happens from idle
ka_sub_whale(persona)        # the role name is the only handle — one entry per name
```

**`write_arrangement` replaces the whole plan.** A role not re-listed this round is gone, and a live
subagent with that name is no longer addressable through the arrangement. The `"main"` entry exists
but is not dispatchable. Two entries that share a role name are the same entry, and only the first is
ever dispatchable — **names must differ**, so two hypotheses are e.g. `cause-a` and `cause-b`. The
role name is also the reuse key: re-dispatching a live child reuses it, with its earlier context.

## Our work

We keep these; they cannot be delegated to a subagent. A subagent reading this list should treat it
as out of scope for itself.

- **Deciding what "should happen"** — that is the specification, and a subagent does not have it.
- **Deciding which cause to act on** when several are plausible: choosing is a judgement about cost
  and risk, not a measurement.
- **Deciding that the failure is acceptable** and leaving it. Sometimes correct; never a subagent's
  call.
- **Talking to the user** — reporting that the cause is elsewhere, or that the fix changes behaviour
  they rely on.
- **The whole picture** across parallel hypotheses: no single subagent sees the others.

## Subagents

Each entry is a persona we record with `write_arrangement` and then dispatch by its role name with
`ka_sub_whale`: a role, a behaviour description, and a tool blacklist. The preset appends the tool
list, the way results come back, and the language rule (`kaz-shared/lib/roles.js`) — do not repeat
any of that here.

Text in `<angle brackets>` is ours to fill in: name the concrete thing, not the category — a pronoun
is not a fill. Everything outside the brackets is the boundary that makes the role useful; keep it.

`blacklist` is **enforced**, not a suggestion: a denied tool is absent from the subagent's tool face,
and calling it errors. Names in the reserved set are dropped silently, and unknown names are skipped
with a note in the dispatch receipt — do not rely on that skip: a name that passes for a real tool
but is not one fails the dispatch outright. **Blacklist the tool that would cause the harm, not every
tool that could.** A role whose evidence needs one scratch file is denied the path of the work under
repair, not `write` itself — or the write is handed to the main agent and the role reports the exact
content to write.

The role is a two-element array `[role, description]` — exactly two non-empty strings. A `task` is
required for every entry (every block below needs one, written as in the example) and is hard-checked:
an empty one is rejected.

An entry to copy:

    { persona: ["reproducer", "We find a command sequence that triggers <the failure> every time, and
        we quote it verbatim with its output. We do not guess causes and we do not fix anything. When
        it does not reproduce, we report the rate we observed and the conditions it appeared under."],
      blacklist: ["edit"],
      task: "Make <the reported failure> happen. Done = a command sequence that fails on demand,
        quoted verbatim with its output, or a measured rate if it is intermittent. Try at least three
        different triggers before concluding it does not reproduce." }

### reproducer — makes it happen on demand

```
role: reproducer that makes <the reported failure> happen on demand
description: We find a command sequence that triggers <the failure> every time, and we quote it
  verbatim with its output. We create only the minimal input the failure needs, and we never write
  inside <the work under repair>. We do not guess causes and we do not fix anything. When it does not
  reproduce, we report the rate we observed and the conditions it appeared under.
blacklist: edit
```

### cause-a / cause-b — one hypothesis each

```
role: investigator testing <one hypothesis about the cause> and no other
description: We test <hypothesis> against <the reproduction command and its output, copied from the
  reproducer's report> and report whether the evidence supports it, with the exact command or read
  that decided it. We ignore every other possible cause: a second hypothesis tested at the same time
  makes both results unreadable. We do not fix anything.
blacklist: edit
```

Dispatch two of these under different names when the cause is not obvious. Their value is the
disagreement: when two independent lines of evidence point at the same fact, that fact is real.

### cause-tracer — why, until it is a fact

```
role: tracer that follows <the failure> back to <the file and function where it is caused>
description: We take <the reproduction command and its output> and keep asking why until the answer is
  a statement about the code rather than another symptom, and we quote the file and line where that
  statement is true. We distinguish the cause from what merely changed at the same time. We do not fix
  anything.
blacklist: edit
```

### fixer — the smallest change

```
role: fixer that removes <the cause the tracer established, quoted with its file and line> with the smallest change
description: We change exactly what <the cause> requires and nothing else — one coherent change, not
  one edit. We do not refactor, tidy, or repair what the bug was hiding. We do not split a change the
  cause requires in two. We report the change and the reproduction re-run against it.
blacklist: (empty - this role must be able to write and run things)
```

### regression-runner — what else moved

```
role: runner that checks <the commands that passed before the fix> still pass
description: We run <those commands> and report the results verbatim, including any that were already
  failing before the fix so they are not counted against it. We do not fix failures we find: we report
  them, with the command and the output.
blacklist: edit
```

### cause-skeptic — is this really the cause

```
role: skeptic that attacks <the cause recorded in the arrangement, quoted> before we accept it
description: We try to make <the failure> happen with <the cause> removed, and to make it stop with
  the cause present but inert. We do not edit the work under repair: we state the inert-cause change
  as an exact diff and hand it back for the main agent to apply. If the failure goes away for a
  different reason, we say so — a symptom that disappears without a mechanism is an unexplained
  disappearance, not a repair.
blacklist: edit
```
