# The cleaner's task, and what comes back

The main file names the four things that are the cleaner's own, and the five things every task
text must carry. This file is the wording: two copy-ready task forms, the constraints that are the
whole safety story, and the ledger the pass leaves behind. Adapt both forms; do not paste one over
the other's job.

## The two task forms

**Audit, the default - the cleaner may not change code:**

> Audit `<paths>` for `<classes from the table>` and change nothing. For each finding give
> `path:line - class - why it costs the reader - the evidence you ran - safe to fix - how you
> would prove it`. Exclude `<dirty files>`. Where a fix cannot be proven with `<the command>`,
> say so and leave the code. Report what you only found, what you refused to touch and why, and
> what you did not verify.

**Apply, only when the user has actually asked for the code to change:**

> **You may change code.** Apply `<the class, one class only>` in `<paths>`, and prove each change
> with `<the check>`, run before and after. If a change cannot be proven with `<the check>`,
> revert it and report it instead of keeping it. One class per pass; anything else you find is a
> finding, not a fix. Report what you removed, what you only found, what you refused to touch, and
> what you did not verify.

Both forms hinge on the check you name in `<the command>` / `<the check>`, so name it concretely:
the repository's own tests, typecheck or lint; a probe the cleaner writes and runs against real
inputs; or nothing, in which case the pass is read-only and the report says so. Take the loudest
check available first - a check that cannot fail on the mistake being made is not a check.

The permission has to be a word in this task text. The cleaner will not read it out of the mood of
your sentence, and a task text that never grants it lands on audit-and-report no matter how it is
phrased. Do not spell the permission with a hedge: `clean up what you think is safe` is not a
grant, and the cleaner is built to read it as the absence of one. If you are not sure the code
should change, dispatch the audit form first and let the user pick from its findings.

## The constraints

Restate these in the task, because they are the whole safety story and the cleaner's persona does
not carry them:

- Behaviour is preserved absolutely, including error types and timing.
- A change with no proof is reverted rather than kept.
- Pre-existing code is removed only after one thought about why it is there.
- Anything that is a real fix - a latent bug, a drifted duplicate, merging two behaviours -
  belongs in a separate change with its own evidence, never inside a cleanup diff.

## What comes back

The cleaner's closing message leads with its verdict, and the ledger you keep afterwards is not
the transcript:

- Cleaned: what was removed, and the check that proved behaviour survived.
- Found and left: what was only a finding, and what it refused to touch, with the reason.
- Unverified: what could not be proven, named as unverified rather than implied to be safe.

That ledger belongs in a file (see the `planning-with-files` skill) so the next pass does not
re-derive it. Restated reasoning and per-file narration do not belong anywhere.
