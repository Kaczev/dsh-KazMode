---
name: reviewing-someone-elses-work
description: Use when judging work that someone or something else produced - a subagent's report, a code change, a plan, a document - before accepting it or acting on it. Not for fixing what the review finds (that is repairing), and not for reviewing your own work, where the only honest reviewer is someone else.
user-invocable: false
---

# Reviewing someone else's work

One work type: judging an artifact we did not make. The work is establishing what is actually true
about it, not forming an impression of it. A review with no stated standard produces taste rather
than findings, so the standard comes first.

**For the main agent.** This file is registered main-agent-only in
`functions/kaz-shared/lib/skill-visibility.js`; the role blocks below are inputs to
`write_arrangement`, not text addressed to anyone.

The dispatching mechanics, and what a dispatch is worth, are in `kaz-dispatch`. What follows is
only what this work type adds.

## Workflow

1. Fix what is being judged and against what: the artifact, and the requirement it is supposed to
   meet.
2. Break the artifact into claims it makes - each assertion that something works, is present, or
   was done. A claim is reviewable; a paragraph is not.
3. Check each claim against the artifact itself, not against the summary of it. The author's
   description of what they did is the least reliable evidence available.
4. Look for what is missing as hard as for what is wrong. Absences do not announce themselves.
5. Rate each finding by what it would cost if accepted: breaks the requirement, degrades it, or
   cosmetic. Ordered by cost, not by how easy it was to find.
6. Report findings with the evidence for each, and state plainly what was not checked.
7. Accept or reject; do not fix during the review. Fixing while judging destroys the record of
   what was wrong.

Steps 3, 4 and 5 are ours to do with the artifact in front of us, and steps 1, 2, 6 and 7 always
were. They are sequential and they are cheap, and doing them ourselves leaves nothing to hand out.
Running both is not thoroughness - it is the same work twice.

## Our work

We keep these; they cannot be delegated.

- **Setting the standard** the artifact is judged against, and deciding when it is met.
- **Accepting or rejecting.** A reviewer finds; the owner decides.
- **Weighing a finding** against the cost of acting on it - a reviewer reports severity, not
  priority.
- **Judging whether a disagreement is real.** Two reviewers contradicting each other is a fact to
  investigate, not a vote to settle.
- **Talking to the user** when the review changes what we promised.

What we can check ourselves, we check ourselves: read the claims, run the command, compare the two
sides. The one thing handed out is an independent reproduction, and only when the gate below is
met - `references/independent-reproduction.md`.

**Never review our own work in this mode.** We read our own artifact as we meant it, not as it
is, and a fresh re-reading does not fix that. When the artifact is ours, the honest reader is
someone who does not already know what we meant.

## Subagents

One role, and the gate that has to hold before it goes out is below.

**Do not blacklist more than the role must not do.** Denying `pwsh` to a role whose job is to
reproduce a result denies the reproduction.

**Name the artifact's location in every task** - a path the role can `read`, or the text pasted
into the task itself. A role that cannot open the artifact will answer "not verified" to
everything, and that is not a review. **A "not verified" that a path we failed to give would have
settled is our failure, not the artifact's.**

For reviewing roles the task must also state **what the role must not be told: the author's claims
and conclusions - what the work does, what was verified, why it was done this way.** It must still
carry everything the role needs to judge it: the artifact, the requirement, the environment, any
decision the artifact presupposes but does not state, and any earlier review. **Withholding claims
is discipline; withholding context is a rigged test.** When a verdict hinges on something only the
author can supply, the role asks for it and gets it before concluding.

### independent-reproducer

Dispatch this one only when the artifact is too large to check in our own context, or when
reproducing it costs more than reading it. Both halves matter: a reproduction we can afford, of an
artifact we can hold, is ours to run. The role block, the task rules and the constraints the role
runs under are in `references/independent-reproduction.md`.
