---
name: auditing-words
description: Use when writing, reviewing or shipping prose a person will read, or wording nobody can justify - documentation, READMEs, guides, reports, commit messages, release notes, pull request descriptions, a persona, a prompt, a skill body - and when a draft is accurate but padded, hard to follow or reads like a transcript; also before reporting work as done, fixed, passing, verified or a bug gone, where it sets what counts as evidence and how to state what was not verified.
user-invocable: false
---

# Auditing words

Prose is written, then audited, then shipped on a claim - three separate jobs: **write it**
for a reader who has to act, **audit it** for wording that survived only because it was
familiar, **claim it** before reporting work as done. Read the one you came for.

## Read the matching reference

| Question | File |
|---|---|
| Writing prose someone has to act on - structure, sentences, revision | `references/writing-it.md` |
| What inherited wording is, the two gates, the audit, the worked cases | `references/auditing-it.md` |
| The red flags, and why each one is a flag | `references/red-flags.md` |
| Deciding what counts as done: evidence, testing the real artifact, reporting | `references/claiming-it.md` |

Read one with the file-read tool, and read it in windows: a tool result over 8192 code
points is trimmed to its first 4096 plus its last 1024 the next time compaction runs, so a
long file read whole loses its middle. This file stays short for the same reason, and so
should every `SKILL.md` you write.

## The standard the file sets

**Write it.** A reader arrives with a question and leaves either able to act or still
searching: the shortest path from their question to the answer, without hiding the parts
that are uncertain.

- **Lead with the answer.** The conclusion, the command, or the decision comes first, then
  only as much background as the reader needs to trust it. State the outcome before the
  method: the cause beats a walk through the investigation.
- **Structure carries the meaning.** One idea per paragraph, and a reader scanning only the
  headings should learn the shape of the document. Lists for enumerable things, prose for
  reasoning, tables when the reader compares entries across the same fields.
- **Sentences that carry weight.** The concrete beats the abstract: name the file, the
  command, the number, the error text. One instruction per sentence, in the order the reader
  will perform it. Delete the wind-up phrases - the sentence is better without them.
- **Do not leak the process.** Written output is not a transcript: no dead ends, no restated
  reasoning, no narration of your own work, no meta-commentary about the document. The
  exception is a report whose subject *is* the process, where the path is the content and is
  told in order.
- **Make it verifiable.** Samples copy-pasteable and complete, the assumption the instruction
  depends on stated, and **hedging only where uncertainty is real - then say what would
  remove it.** Detail in `references/writing-it.md`.

**Audit it.** Inherited wording is text that arrived without being argued for: the phrase
everyone uses, the opening sentence that was in the first draft, the famous quote, the term
from another field. The rule: **inherited wording goes through the same filter as invented
wording. Coming from a convention, a draft, a translation, or a respected source is not a
reason to keep it.**

- **The two gates**, applied to every sentence carrying an obligation or an identity: does
  it name a specific failure mode it prevents, and does it avoid reducing the agent to a
  single action? A sentence that fails both is an instruction nobody can follow and nobody
  can check.
- **The audit.** Mark where the sentence came from; run the two gates; test the attribution
  if there is one - correcting a false attribution is a finding, not a nitpick; rewrite as
  an observable or delete, and **the replacement must not be longer than the sentence it
  replaces** unless it now names checkable actions that were implicit; then report the
  family and **fix at most two** - the ones that constrain behaviour - listing the other
  files rather than starting another editing round. Finish the document you were asked to
  audit first.
- **Red flags.** A quality adjective with no test. Cargo-culted structure. Soft attribution.
  A rule that contradicts another rule nearby. A metaphor standing in for a mechanism. An
  absolute with no counterexample.
- **Why the author cannot do this alone.** Inherited phrasing feels correct precisely
  because it is familiar, and the person who wrote it reads the intention rather than the
  words. Two ways out: have someone else point at the sentence, or state the origin out
  loud - "this came from the draft and I never chose it" - which is usually enough to see
  it.

The gates in use, the sources that bypass scrutiny, and what each red flag hides are in
`references/auditing-it.md` and `references/red-flags.md`.

**Claim it.** A claim of completion is a factual claim about the world: make it only from
evidence you produced yourself, in this session, about the exact artifact that will run.
Reading the code you just wrote is not observation; neither is a passing syntax check, nor
"the pieces look right". Where you cannot observe it, say which part is unproven and what
would prove it. **The strongest evidence is the real thing's own output, then reading back
what actually landed, then an independent source of truth.** Prefer the strongest the
environment allows, and name which one you used.

- **Test the artifact that will run**, not a copy, a mock or an older build: the file on
  disk, the installed copy, the process actually serving, the target environment.
- **Make the test able to fail.** Ask what a wrong version would do - if a wrong version also
  passes, the check is decoration. Probe the boundary, not just the middle. Feed it the
  input you believe it rejects, and distrust a check that returns nothing.
- **When a test fails, suspect the test**: before changing the artifact, work out whether the
  artifact or the harness is wrong. And when a check passes first try, confirm it exercised
  what you think.
- **Clean up in the same pass.** Any probe you add to real code is a defect the moment it
  lands: remove it in the same turn and re-check that the file compiles.
- **Report the two separately**: what you ran and saw, and what remains unproven with the
  smallest step that would settle it. Say where a claim rests on a single check. Detail in
  `references/claiming-it.md`.

What costs the most is always one of three: not leading with the answer, hedging where
uncertainty is not real, and testing something other than the artifact that will run.

