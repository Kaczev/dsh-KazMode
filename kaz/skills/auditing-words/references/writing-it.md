# Writing prose a reader acts on

The rules are stated and compressed in the main file, under **Write it**. This is the same
material at length: what each rule looks like in a draft, and the revision pass that applies
them. Read it when you are writing or reworking prose, not when you are auditing wording
that already exists - that is `references/auditing-it.md`.

## The goal, stated once

A reader arrives with a question and leaves either able to act or still searching. Everything
here serves one goal: the shortest path from their question to the answer, without hiding the
parts that are uncertain.

## Lead with the answer

Put the conclusion, the command, or the decision first. Background after, and only as much as
the reader needs to trust the answer. The first sentence of a section should be its point; if
a reader reads only the first sentence of each paragraph, they should still get the structure
of the argument. State the outcome before the method: "this breaks X; here is why" beats a
walk through the investigation.

## Structure carries the meaning

One idea per paragraph - a paragraph covering two decisions makes the reader re-read to
separate them. Headings are navigation, not decoration: a reader scanning only the headings
should learn the shape of the document. Lists for enumerable things, prose for reasoning:
three or more parallel items, a set of steps, or a set of options are a list; a causal
argument, a trade-off, or a decision with a reason is prose, because a bulleted argument hides
the logic that connects the bullets. Tables when the reader will compare entries across the
same fields; otherwise a list. Keep the important thing visible: burying a breaking change in
the middle of a paragraph is how readers get hurt.

## Sentences that carry weight

Prefer the concrete to the abstract: name the file, the command, the number, the error text.
"The configuration must be updated" says nothing; "set `port` in `config.yml`" does. Active
voice with a stated actor, unless the actor genuinely does not matter. One instruction per
sentence, in the order the reader will perform it. Delete the wind-up phrases - "It is
important to note that", "In order to" - the sentence is better without them.

## Do not leak the process

Written output is not a transcript. Remove dead ends you explored and abandoned, unless the
dead end is itself the warning; restated reasoning, second explanations of the same point,
and re-summaries at the end of every section; narration of your own work ("I first looked
at ..., then I ..."), because the reader wants the result; and meta-commentary about the
document ("this section will explain") - explain it instead. The exception is a report whose
subject *is* the process, a debugging log or a decision record: there the path is the content,
and it should be told in order.

## Make it verifiable

- Code samples must be copy-pasteable and complete: the imports, the file name, the command
  that produces the output shown. A fragment that does not run costs the reader more than no
  sample.
- State the version or the assumption the instruction depends on.
- Where a claim rests on something you observed, name what you observed.
- **Hedge only where uncertainty is real - and then say what would remove it.** A confident
  claim about something unverified is worse than a stated gap, and "where you did not verify
  it, say so" is a feature of the document, not an admission. That is the rule; the symptoms
  of breaking it are the soft-attribution red flag in `references/red-flags.md`.

## Revise once, then check once

1. **Reorder.** Answer first, then support; steps in execution order. Fixing order replaces
   most rewriting.
2. **Cut.** Delete anything that does not change what the reader does.
3. **Tighten.** One idea per paragraph, one instruction per sentence, concrete nouns.

Then one finishing check, asking exactly one question: reading only the first sentence of each
paragraph, does a stranger get the argument? Fix the first sentence that fails; do not re-read
the whole draft again.

**A second revision needs a reason**: the artifact is a README, a release note, a guide, or
something a stranger acts on without you. A commit message, a status line, and an answer in
this conversation get one pass and are then done.
