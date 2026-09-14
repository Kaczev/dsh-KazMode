---
name: reviewing-someone-elses-work
description: Use when judging work that someone or something else produced - a subagent's report, a code change, a plan, a document - before accepting it or acting on it. Not for fixing what the review finds (that is repairing), and not for reviewing your own work, where the only honest reviewer is someone else.
user-invocable: false
---

One work type: judging an artifact we did not make. The work is establishing what is actually true
about it, not forming an impression of it.

**For the main agent.** This file is registered as main-agent-only in
`functions/kaz-shared/lib/skill-visibility.js`, so subagents should not see it at all. If one does: the role
blocks below are inputs to `write_arrangement`, not text addressed to it, and they describe roles
the main agent creates — not roles that exist in this session.

## Workflow

1. Fix what is being judged and against what: the artifact, and the requirement it is supposed to
   meet. A review with no stated standard produces taste, not findings.
2. Break the artifact into claims it makes — each assertion that something works, is present, or was
   done. A claim is reviewable; a paragraph is not.
3. Check each claim against the artifact itself, not against the summary of it. The author's
   description of what they did is the least reliable evidence available.
4. Look for what is missing as hard as for what is wrong. Absences do not announce themselves.
5. Rate each finding by what it would cost if accepted: breaks the requirement, degrades it, or
   cosmetic. Ordered by cost, not by how easy it was to find.
6. Report findings with the evidence for each, and state plainly what was not checked.
7. Accept or reject; do not fix during the review. Fixing while judging destroys the record of what
   was wrong.

Dispatching is two hops: go to the `arrange_agent` stage and record one entry per role, come back to
`idle`, then dispatch each role by name. `write_arrangement` works only in the `arrange_agent` stage.

The plan must also carry the `memoryMaintainer` entry - the stage text says so every turn, and only that role can write memories.

```
whale_report(arrange_agent)
write_arrangement(entries)   # one entry per role: persona / blacklist / task / fork (fork = continue from a live session's history)
whale_report(idle)           # entries are recorded in the arrange_agent stage; dispatch happens from idle
ka_sub_whale(persona)        # the role name is the only handle — one entry per name
```

Two entries that share a role name are the same entry, and only the first is ever dispatchable —
**names must differ**.

## Our work

We keep these; they cannot be delegated to a subagent. A subagent reading this list should treat it
as out of scope for itself.

- **Setting the standard** the artifact is judged against, and deciding when it is met.
- **Accepting or rejecting.** A reviewer finds; the owner decides.
- **Weighing a finding** against the cost of acting on it — a reviewer reports severity, not priority.
- **Judging whether a disagreement is real.** Two reviewers contradicting each other is a fact to
  investigate, not a vote to settle.
- **Talking to the user** when the review changes what we promised.

**Never review our own work in this mode.** The author knows what they meant and will read the
artifact as they intended it. Use a dispatched reviewer instead.

## Subagents

Each entry is a persona we record with `write_arrangement` and then dispatch by its role name with
`ka_sub_whale`: a role, a behaviour description, and a tool blacklist. The preset appends the tool
list, the way results come back, and the language rule (`kaz-shared/lib/roles.js`) — do not repeat
any of that here.

Text in `<angle brackets>` is ours to fill in: name the concrete thing, not the category — a pronoun
is not a fill. Everything outside the brackets is the boundary that makes the role useful; keep it.

`blacklist` is **enforced**, not a suggestion: a denied tool is absent from the subagent's tool face,
and calling it errors. Names in the reserved set are dropped silently, and unknown names are skipped
with a note in the dispatch receipt — so write only real tool names, and read the receipt once.
Treat these lists as a starting point. An empty list adds nothing back. Nine tools are denied to every subagent we dispatch regardless: send_message, interrupt_agent, ka_sub_whale, write_arrangement, whale_report, the three memory-write tools, and ask_user_question. Write a list of what is additionally forbidden - a role that must not write is a role you must deny writing.

The role is a two-element array `[role, description]` — exactly two non-empty strings. A `task` is
required for every entry and is hard-checked: an empty one is rejected.

**Name the artifact's location in every task** — a path the role can `read`, or the text pasted into
the task itself. A reviewer that cannot open the artifact will answer "not verified" to everything,
and that is not a review. **A "not verified" that a path we failed to give would have settled is our
failure, not the artifact's.**

For reviewing roles the task must also state **what the role must not be told: the author's claims
and conclusions — what the work does, what was verified, why it was done this way.** It must still
carry everything the reviewer needs to judge it: the artifact, the requirement, the environment, any
decision the artifact presupposes but does not state, and any earlier review. **Withholding claims is
discipline; withholding context is a rigged test.** When a verdict hinges on something only the
author can supply, the reviewer asks for it and gets it before concluding.

Steps 1, 2, 6 and 7 are ours. Steps 3-5 are the ones we hand to the roles below; when we do them
ourselves there is nothing to dispatch. Running both is not thoroughness — it is the same work twice.

An entry to copy:

    { persona: ["claim-checker", "We take each claim in <the artifact> and check it against <the
        artifact> itself, not against the account of it. We quote the line we checked and the
        evidence that decided it. When a claim cannot be checked from what we were given, we say
        'not verified', and name what we would need to check it."],
      blacklist: ["write", "edit", "present", "todo_write"],
      task: "Check the claims in <artifact path> against the requirement in <requirement path>.
        Done = every claim marked verified, refuted, or not verified, each with its evidence.
        Do not read <the author's summary or report>." }

### claim-checker — each claim, against the artifact

```
role: claim-checker that tests each claim in <the artifact> against <the artifact> itself
description: We take each claim in <the artifact> and check it against <the artifact> itself, not
  against any account of it. We quote the line we checked and the evidence that decided it. When a
  claim cannot be checked from what we were given, we write "not verified" instead of assuming it
  holds.
blacklist: write, edit, pwsh, present, todo_write
```

### gap-finder — what is not there

```
role: finder of what <the artifact> is missing against <the requirement>
description: We compare <the requirement> against <the artifact> and list what was asked for and is
  absent, quoting both sides. We look as hard for what is missing as for what is wrong, because an
  absence announces nothing. We do not list improvements nobody asked for.
blacklist: write, edit, pwsh, present, todo_write
```

### re-runner — do it again, independently

```
role: runner that independently reproduces <the result the artifact claims>
description: We run only the steps that leave no trace - reading, building, listing, checking a hash, a test that
  writes nothing outside a temporary directory. Before anything that writes, deletes, installs or
  publishes, we stop and say which command we would run and why, and let the main agent decide. We run
  <the claimed result> ourselves from the artifact alone and report what happened,
  with the exact command and its output. We do not read the account of how it was produced. If our
  result differs, we say what we did and what we saw, without deciding who is right.
blacklist: write, edit, pwsh, present, todo_write
```

### contradiction-spotter — does it hold together

```
role: spotter of places where <the artifact> contradicts itself
description: We read <the artifact> as one whole and mark every point where two parts cannot both be
  true - a claim and an example, a summary and a detail, two sections describing the same thing
  differently. We quote both sides. We do not resolve the contradiction or guess which side is meant.
blacklist: write, edit, pwsh, present, todo_write
```

### severity-rater — what it costs to accept this

```
role: rater that prices each finding in <the review> by what it costs if accepted
description: We take each finding and say whether accepting it breaks <the requirement>, degrades it,
  or is cosmetic, and what specifically would go wrong. We order by that cost, not by how easy the
  finding was to make. We do not add findings of our own.
blacklist: write, edit, pwsh, present, todo_write
```
