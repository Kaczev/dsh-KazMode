---
name: writing-quality
description: Use when writing or reviewing prose a person will read - documentation, READMEs, guides, reports, commit messages, release notes, pull request descriptions - to make it useful on first read, and when a draft is accurate but hard to follow, padded, or reads like a transcript.
---

# Writing quality

A reader arrives with a question and leaves either able to act or still searching. Everything below
serves one goal: the shortest path from their question to the answer, without hiding the parts that
are uncertain.

## Lead with the answer

- Put the conclusion, the command, or the decision **first**. Background after, and only as much as
  the reader needs to trust the answer.
- The first sentence of a section should be its point. If a reader reads only the first sentence of
  each paragraph, they should still get the structure of the argument.
- State the outcome before the method: "this breaks X; here is why" beats a walk through the
  investigation.

## Structure carries the meaning

- One idea per paragraph. A paragraph covering two decisions makes the reader re-read to separate them.
- Headings are navigation, not decoration: a reader scanning only the headings should learn the shape
  of the document.
- **Lists for enumerable things, prose for reasoning.** Three or more parallel items, a set of steps,
  or a set of options: list. A causal argument, a trade-off, or a decision with a reason: prose. A
  bulleted argument hides the logic that connects the bullets.
- Tables when the reader will compare entries across the same fields; otherwise a list.
- Keep the important thing visible: burying a breaking change in the middle of a paragraph is how
  readers get hurt.

## Sentences that carry weight

- Prefer the concrete to the abstract: name the file, the command, the number, the error text. "The
  configuration must be updated" says nothing; "set `port` in `config.yml`" does.
- Active voice with a stated actor, unless the actor genuinely does not matter.
- One instruction per sentence, in the order the reader will perform it.
- Delete the wind-up: "It is important to note that", "In order to", "As we can see", "Basically".
  The sentence is always better without them.
- Hedge only where uncertainty is real, and then say what would remove it. A confident claim about
  something unverified is worse than a stated gap.

## Do not leak the process

Written output is not a transcript. Remove:

- dead ends you explored and abandoned, unless the dead end is itself the warning;
- restated reasoning, second explanations of the same point, and re-summaries at the end of every
  section;
- narration of your own work ("I first looked at ..., then I ..."). The reader wants the result;
- meta-commentary about the document ("this section will explain"). Explain it instead.

The exception is a report whose subject *is* the process - a debugging log, a decision record. There,
the path is the content, and it should be told in order.

## Make it verifiable

- Code samples must be copy-pasteable and complete: the imports, the file name, the command that
  produces the output shown. A fragment that does not run costs the reader more than no sample.
- State the version or the assumption the instruction depends on.
- Where a claim rests on something you observed, name what you observed. Where you did not verify it,
  say so - that is a feature of the document, not an admission.

## Revise in this order

1. **Cut.** Delete anything that does not change what the reader does. Expect to lose a fifth.
2. **Reorder.** Answer first, then support; steps in execution order. This fixes more than rewriting.
3. **Tighten.** One idea per paragraph, one instruction per sentence, concrete nouns.
4. **Check the edges.** Does the opening sentence state the point? Does the closing sentence say what
   happens next, or just trail off? Would a stranger know what to do after reading only the headings?
5. **Read it as the reader.** If you are the author, you cannot skip this: the first sentence that
   makes you re-read is a defect in the text, not in you.
