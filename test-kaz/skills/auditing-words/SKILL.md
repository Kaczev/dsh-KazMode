---
name: auditing-words
description: Use when writing, reviewing or shipping prose a person will read, or wording nobody can justify - documentation, READMEs, guides, reports, commit messages, release notes, pull request descriptions, a persona, a prompt, a skill body - and when a draft is accurate but padded, hard to follow or reads like a transcript; also before reporting work as done, fixed, passing, verified or a bug gone, where it sets what counts as evidence and how to state what was not verified.
user-invocable: false
---

# Auditing words

Prose is written, then audited, then shipped on a claim. The three movements below are separate
jobs: **write it** for a reader who has to act, **audit it** for wording that survived only because
it was familiar, **claim it** before reporting work as done. Read the one you came for; the others
are reachable from it.

## Write it

A reader arrives with a question and leaves either able to act or still searching. Everything here
serves one goal: the shortest path from their question to the answer, without hiding the parts that
are uncertain.

**Lead with the answer.** Put the conclusion, the command, or the decision first. Background after,
and only as much as the reader needs to trust the answer. The first sentence of a section should be
its point; if a reader reads only the first sentence of each paragraph, they should still get the
structure of the argument. State the outcome before the method: "this breaks X; here is why" beats a
walk through the investigation.

**Structure carries the meaning.** One idea per paragraph - a paragraph covering two decisions makes
the reader re-read to separate them. Headings are navigation, not decoration: a reader scanning only
the headings should learn the shape of the document. Lists for enumerable things, prose for
reasoning: three or more parallel items, a set of steps, or a set of options are a list; a causal
argument, a trade-off, or a decision with a reason is prose, because a bulleted argument hides the
logic that connects the bullets. Tables when the reader will compare entries across the same fields;
otherwise a list. Keep the important thing visible: burying a breaking change in the middle of a
paragraph is how readers get hurt.

**Sentences that carry weight.** Prefer the concrete to the abstract: name the file, the command, the
number, the error text. "The configuration must be updated" says nothing; "set `port` in
`config.yml`" does. Active voice with a stated actor, unless the actor genuinely does not matter. One
instruction per sentence, in the order the reader will perform it. Delete the wind-up phrases - "It is
important to note that", "In order to" - the sentence is better without them.

**Do not leak the process.** Written output is not a transcript. Remove dead ends you explored and
abandoned, unless the dead end is itself the warning; restated reasoning, second explanations of the
same point, and re-summaries at the end of every section; narration of your own work ("I first looked
at ..., then I ..."), because the reader wants the result; and meta-commentary about the document
("this section will explain") - explain it instead. The exception is a report whose subject *is* the
process, a debugging log or a decision record: there the path is the content, and it should be told
in order.

**Make it verifiable.**

- Code samples must be copy-pasteable and complete: the imports, the file name, the command that
  produces the output shown. A fragment that does not run costs the reader more than no sample.
- State the version or the assumption the instruction depends on.
- Where a claim rests on something you observed, name what you observed.
- **Hedge only where uncertainty is real - and then say what would remove it.** A confident claim about
  something unverified is worse than a stated gap, and "where you did not verify it, say so" is a
  feature of the document, not an admission. That is the rule; the symptoms of breaking it are under
  **Audit it**, in the soft-attribution flag.

**Revise once, then check once.**

1. **Reorder.** Answer first, then support; steps in execution order. Fixing order replaces most
   rewriting.
2. **Cut.** Delete anything that does not change what the reader does.
3. **Tighten.** One idea per paragraph, one instruction per sentence, concrete nouns.

Then one finishing check, asking exactly one question: reading only the first sentence of each
paragraph, does a stranger get the argument? Fix the first sentence that fails; do not re-read the
whole draft again. A second revision needs a reason: the artifact is a README, a release note, a
guide, or something a stranger acts on without you. A commit message, a status line, and an answer in
this conversation get one pass and are then done.

## Audit it

Inherited wording is text that arrived without being argued for: the phrase everyone uses, the
opening sentence that was in the first draft, the famous quote, the term from another field. It is
the least examined text in any document, because its presence feels self-justifying.

The rule: **inherited wording goes through the same filter as invented wording. Coming from a
convention, a draft, a translation, or a respected source is not a reason to keep it.**

**Two gates.** Apply both to every sentence that carries an obligation or an identity:

1. **Does it name an enemy?** Point at the specific failure mode this sentence prevents. "Be
   rigorous" has no enemy; "do not ship a draft whose claims you have not checked" names one.
2. **Does it reduce the agent to a single action?** A role word like "reviewer" pretends one action
   is the whole job. If the word narrows the job, the same sentence has to restore what it dropped.

A sentence that fails both is not weak phrasing - it is an instruction nobody can follow and nobody
can check.

**Sources that bypass scrutiny.** Name the source, because the source is the reason nobody looked:

| Source | Why it slips through | Example seen in practice |
|---|---|---|
| The first draft | it was never a decision, only a starting point | a persona opening that stayed because it was there |
| Industry convention | everyone writes it, so it reads as correct | quality adjectives in a tool description |
| Translation | the borrowed term sounds technical | a foreign term carrying an unexamined frame |
| A famous attribution | quoting someone outsources the argument | a triad attributed to a philosopher who never wrote it |
| A previous document | copying is easier than re-deciding | a rule that contradicts another rule in the same file |

**Red flags.**

- **A quality adjective with no test.** helpful, thorough, rigorous, thoughtful, clean, robust,
  elegant, professional, delightful. Ask how to check it. If the answer is a feeling, rewrite as the
  action it was standing in for.
- **Cargo-culted structure.** A shape everyone follows (a triad, a template, a section order) that
  forces content to fill slots that do not exist in the material.
- **Soft attribution.** "It is well known", "studies show", "classically", "as X said". The hedging is
  where the verification is missing - the rule for it is under **Write it**, in *Make it verifiable*.
- **A rule that contradicts another rule nearby.** One of the two was inherited and never
  reconciled; find out which by asking which one has a failure mode behind it.
- **A metaphor standing in for a mechanism.** A vivid image can hide the fact that the mechanism was
  never described.
- **An absolute with no counterexample.** "Always", "never", "best" - a rule with no situation that
  violates it is decoration.

**Why the author cannot do this alone.** Inherited phrasing feels correct precisely because it is
familiar, and the person who wrote it knows what they meant, so they read the intention rather than
the words. Two ways out: have someone else point at the sentence, or state the origin out loud -
"this came from the draft and I never chose it" - which is usually enough to see it. The failure is
rarely a bad sentence; it is a sentence nobody ever decided on.

**The audit.**

1. **Mark the sentence's origin.** Ask where it came from. "It was in the draft" and "everyone does
   it" are answers, and both mean unexamined.
2. **Run the two gates.** Name the enemy, and check whether the phrasing narrows the job.
3. **Test the attribution**, if there is one. Verify the quote, the term, and its sense in the source
   language. Correcting a false attribution is a finding, not a nitpick.
4. **Rewrite as an observable, or delete.** The replacement names a failure mode or a checkable
   action: "keep the style consistent" becomes "one corner radius everywhere"; "be transparent"
   becomes "say which checks were run and which were not". **The replacement must not be longer than
   the sentence it replaces** - unless it is longer because it now names the checkable actions that
   were implicit, which is the one growth worth paying for. Longer and vaguer is the failure. If you
   cannot say it shorter and it names nothing checkable, delete the original and report the gap - a
   gap the reader can see beats a rule that grew a paragraph.
5. **Report the family, fix at most two.** Inherited wording travels in families - if one file has
   it, sibling files usually do too. Fix one or two occurrences: the ones where the wording
   constrains behaviour. Name the other files, but put them in the report as a list rather than
   starting another round of edits. The cap is on changing other files: within the document you were
   asked to audit, finish the job.

**Three worked cases.**

- **A persona opening kept from a draft.** "We are a helpful agent" survived because it was in the
  first sketch. It fails gate 1: there is no failure mode called *unhelpful* in the taxonomy it was
  meant to serve. Deleted.
- **A quality adjective in a tool description.** "Makes the layout look deliberate rather than
  generated" fails gate 1 as written - but the underlying intent is checkable once stated as the
  actions it meant: spacing that stays on one scale, a countable number of type sizes, and the empty
  and error states designed. The adjective was replaced by those three checks.
- **A famous triad.** "Thesis, antithesis, synthesis" is routinely attributed to Hegel, who did not
  write it; the shape comes from later commentators. A structure inherited under a false attribution
  is a structure nobody validated - here it also forced a three-beat rhythm the material did not
  have.

## Claim it

A claim of completion is a factual claim about the world. Make it only from evidence you produced
yourself, in this session, about the exact artifact that will run.

**The rule.** State work as done only when you have observed it working. Reading the code you just
wrote is not observation. A passing syntax check is not observation. "The pieces look right" is not
observation. When you cannot observe it - no runtime, no credentials, no device - say exactly which
part is unproven and what would prove it. An honest gap costs one sentence; a false "done" costs the
reader's trust and their time rebuilding what you broke.

**Evidence, in descending order of strength.**

1. **Run the real thing and read its real output.** The program's own output, the file's bytes on
   disk, the screen the user would see, the response body.
2. **Read back what you wrote, from the same place the consumer reads it.** Not the value you passed
   in - what landed.
3. **Compare against an independent source of truth**: a checksum, a byte count, a re-parse, a second
   computation by different means.
4. **A check whose result you actually looked at.** Exit status alone is weak: a pipeline reports the
   last command's status, so a failing command in the middle can still end in `0`.

Prefer the strongest evidence the environment allows, and name which one you used.

**Test the artifact that will run.** The most common false "done" comes from proving a copy, a mock,
or an older build:

- The file on disk, not the string you passed to the writer.
- The installed/deployed copy, not the source tree. If a build step exists, rebuild and confirm the
  change is present in the output.
- The process that is actually serving, not the one you started earlier. Code that is loaded at
  startup does not pick up an edit; a restart is part of the change.
- The target environment, not your development stand-in. Isolation that you intended is not
  isolation you verified: prove where the write landed, not where you meant it to land.

**Make the test able to fail.** A test that cannot fail proves nothing. Before trusting a check:

- Ask what a wrong version would do. If the wrong version also passes, the check is decoration.
- Probe the boundary, not just the middle: one step below, exactly at, one step above.
- Feed it the input you believe it rejects. If the rejection path was never exercised, the rule is a
  hope, not a guard.
- Distrust a check that returns nothing: an unexpected `undefined`/empty result can make every
  comparison trivially false and the whole guard silently inactive. Confirm the guard's own inputs
  are what you assume.

**Take the expected value from the artifact, not from memory.** An assertion is only as good as the
string you compare against. When you write that string from recollection of what the file says, you
are testing your memory and reporting the result as a test failure - the artifact is right, your
expectation is wrong, and the false alarm costs the same attention as a real defect.

- **Copy the expected value out of the artifact** - read the file, print the field, quote the line -
  rather than typing it from what you believe it contains. Every expected value should have an
  observed source.
- **Watch the whitespace.** Prose wraps: a sentence you match as one line exists in the file as two
  lines with indentation between them, so `the harness installs a subset` fails against
  `the\n  harness installs a subset` even though the text is plainly there. Assert on a short
  distinctive fragment well inside one line, or normalize whitespace on both sides before comparing,
  and never conclude "the content is missing" from a failed literal match.
- **When a check fails, print both sides before touching anything.** The diff between expected and
  actual is the evidence; without it, "it failed" is a feeling.
- **Re-read after writing.** An edit that silently changes what you wrote earlier is a real hazard,
  and the check that catches it is the same one: read the artifact back.

**When a test fails, suspect the test.** A failing check indicts two things: the artifact and the
harness. Before changing the artifact, work out which one is wrong - an incomplete fixture, a missing
field, an environment variable the code reads but the test never set. Changing working code to
satisfy a broken test is how correct behaviour gets broken. Conversely, when a check passes on the
first try, confirm it exercised what you think: name the observable you expected and find it in the
output.

**Clean up in the same pass.** Evidence-gathering writes things: temp files, probe directories, debug
lines inside the artifact. Any probe you add to real code is a defect the moment it lands - remove it
in the same turn, re-check the file compiles, and confirm nothing else was touched.

**Reporting.** Separate the two, explicitly:

- **Verified** - what you ran, and what you saw.
- **Not verified** - what remains unproven, and the smallest step that would settle it.

Report what actually happened, including the parts that failed, regressed, or turned out to be your
own mistake. Name the file, the command, and the observed result. If a claim rests on one check, say
so; do not present a single observation as a general property.
