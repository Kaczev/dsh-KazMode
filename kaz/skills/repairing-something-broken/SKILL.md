---
name: repairing-something-broken
description: Use when something that used to work, or was supposed to work, does not - a failing test, a crash, behaviour that is wrong but not fatal, or a report that "it just stopped". Not for building what never existed (that is building), and not for carrying out a plan that already covers the fix (that is working-from-a-plan).
user-invocable: false
---

# Repairing something broken

One work type: something is broken and the cause is not yet known. The work is finding why before
changing anything, and proving afterwards that it is fixed.

**If the broken thing is an agent extension, a hook, or a seam**, the ordering in
`diagnosing-agent-extensions` comes first: prove it is mounted and its contribution registered before
reproducing anything. Do not re-derive that here. Come back to step 1 once you have that proof - and
know that a session may have no tool for enumerating mounted components, in which case the visible
skill catalog and your own tool face are the evidence, and "I could not see it" is not a finding
about the component.

**For the main agent.** This file is registered main-agent-only in
`functions/kaz-shared/lib/skill-visibility.js`; the role blocks below are inputs to
`write_arrangement`, not text addressed to anyone.

## Workflow

1. **Reproduce it before touching anything, and in our own hands.** Write down the exact steps and
   the exact output, on the smallest input the failure needs, and try more than one trigger before
   concluding it does not reproduce. If it cannot be made to happen on demand - intermittent,
   load-dependent, already gone - do not stop: record the observed rate and the conditions it
   appeared under, and make *driving that rate to zero* the thing you must show. A rate is evidence;
   one lucky run is not.
   Before running it, look at what it will damage. If the reproduction writes outside the workspace,
   or destroys state you cannot recreate, stop and ask - a reproduction you cannot run twice is not
   one.
2. Say what **should** happen, in one line. Without it, "working" is only "different from before".
   **This line must exist in writing before the fixer is dispatched**, and its text goes into the
   fixer's task.
3. Find the cause ourselves, and keep asking why until the answer is a fact about the code rather
   than another symptom; distinguish the cause from what merely changed at the same time. Stop when a
   change to that fact would remove the failure.
4. Fix the smallest thing that removes the cause. Do not repair what the bug was hiding, and do not
   refactor on the way - both turn one known problem into several unknown ones. But if the cause is
   itself structural, say so plainly instead of band-aiding it: that is a finding, not a tangent.
5. **Change one variable at a time while testing hypotheses** - two hypotheses tested at once make
   both results unreadable. Once the cause is established, one coherent change is one change: cause
   plus call site, config key plus its reader, migration plus its caller. Do not split it to satisfy
   this rule, and do not bundle an unrelated change to save a round-trip.
6. Re-run the reproduction from step 1 ourselves, then run what was passing before ourselves, to
   check nothing else broke - and note anything that was already failing before the fix, so it is not
   counted against it.
7. Report: the cause in one sentence, what changed, the reproduction now passing, and what was not
   re-tested.

**A fix that makes the symptom go away without a mechanism is not a fix.** If the cause is still
unknown when the failure stops, say so - that is an unexplained disappearance, not a repair.

**Check it yourself, against the failure and the fix**: read the claims, run the command, compare the
two sides. Take the cause out and the failure must come back; make it inert and the failure must
stop.

**Match the roles to the repair.** A one-line cause, a reproduction and a passing suite need no
second role: fix it, re-run, report. Add a role only when it removes a specific doubt we cannot
remove ourselves.

## Our work

We keep these; they cannot be delegated.

- **Deciding what "should happen"** - that is the specification, and a subagent does not have it.
- **Deciding which cause to act on** when several are plausible: choosing is a judgement about cost
  and risk, not a measurement.
- **Deciding that the failure is acceptable** and leaving it. Sometimes correct; never a subagent's
  call.
- **Talking to the user** - reporting that the cause is elsewhere, or that the fix changes behaviour
  they rely on.
- **The whole picture** across parallel hypotheses: no single subagent sees the others.

The dispatching mechanics, and what a dispatch is worth, are in `kaz-dispatch`, under
`## What a dispatch buys`. What follows is only what this work type adds.

## Subagents

Text in `<angle brackets>` is ours to fill in - name the concrete thing, not the category.

**Blacklist the tool that would cause the harm, not every tool that could.** A role whose evidence
needs one scratch file is denied the path of the work under repair, not `write` itself - or the write
is handed to the main agent and the role reports the exact content to write.

Every block below needs a `task`, written the way its description is: the thing to do, and what
counts as done.

### fixer - the smallest change

```
role: fixer that removes <the cause we established, quoted with its file and line> with the smallest change
description: We change exactly what <the cause> requires and nothing else - one coherent change, not
  one edit. We do not refactor, tidy, or repair what the bug was hiding. We do not split a change the
  cause requires in two. We report the change and the reproduction re-run against it.
blacklist: (empty - this role must be able to write and run things)
```
