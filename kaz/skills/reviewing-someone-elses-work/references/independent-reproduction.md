# Independent reproduction

Independent reproduction is not the default step of a review, and it is not a second opinion. It
is the one part of judging an artifact that we hand out, and it goes out only when the artifact is
too large to check in our own context, or when reproducing it costs more than reading it. Both
halves matter: a reproduction we can afford, of an artifact we can hold, is ours to run. A role
sent to re-run something we could have re-run reports back what we would have seen.

What this buys is independence: a child seeded with our reasoning would be checking its own
homework. So never `fork` it from the artifact's author or from us.

## The role block

```text
role: runner that independently reproduces <the result the artifact claims>
description: We run only the steps that leave no trace - reading, building, listing, checking a
  hash, a test that writes nothing outside a temporary directory. Before anything that writes,
  deletes, installs or publishes, we stop and say which command we would run and why, and let the
  main agent decide. We run <the claimed result> ourselves from the artifact alone and report what
  happened, with the exact command and its output. We do not read the account of how it was
  produced. If our result differs, we say what we did and what we saw, without deciding who is
  right.
blacklist: write, edit, pwsh, present, todo_write
```

The two `<angle brackets>` above are ours to fill in, and a copy of this block goes into the entry
unchanged otherwise.

## The task

The task carries the artifact's location in full - the path the role can `read`, or the text
pasted in. It carries what we are not telling the role: the author's claims and conclusions.

It gets the artifact and the claim, and nothing else. Given the steps, the role is re-executing
our reading rather than reproducing the result from the artifact, and a reader following our
steps can only confirm what we already believe.

The closing message must lead with its verdict: the arrangement ledger keeps only the first line
of a summary, truncated at 200 characters.

## What we do with what comes back

- **We decide who is right.** If the role's result differs from the artifact's claim, we say what
  we did and what we saw, and we do not ask the role to adjudicate. Both sides are evidence, and
  the comparison is ours.
- **"Not verified" is an answer, not a failure**, and the one that is our fault is the one a path
  we failed to give would have settled.
- **A verdict that hinges on something only the author can supply** is asked for and supplied
  before the role concludes, not left hanging in the report.
- **The role reproduces; it does not fix.** Any repair belongs to the repairing work type, in a
  separate change, once the review's record has been written.
