---
name: auditing-inherited-wording
description: Use when reviewing wording you or someone else did not originally justify - a persona, a prompt, a skill body, a doc introduction - and when a phrase survives only because it is conventional, familiar, or attributed to an authority; also when a draft keeps an inherited sentence and nobody can say what it prevents.
user-invocable: false
---

# Auditing inherited wording

Inherited wording is text that arrived without being argued for: the phrase everyone uses, the
opening sentence that was in the first draft, the famous quote, the term from another field. It is the
least examined text in any document, because its presence feels self-justifying.

The rule: **inherited wording goes through the same filter as invented wording. Coming from a
convention, a draft, a translation, or a respected source is not a reason to keep it.**

## Two gates

Apply both to every sentence that carries an obligation or an identity:

1. **Does it name an enemy?** Point at the specific failure mode this sentence prevents. "Be
   rigorous" has no enemy; "do not ship a draft whose claims you have not checked" names one.
2. **Does it reduce the agent to a single action?** A role word like "reviewer" pretends one action is
   the whole job. If the word narrows the job, the same sentence has to restore what it dropped.

A sentence that fails both is not weak phrasing - it is an instruction nobody can follow and nobody
can check.

## Sources that bypass scrutiny

Name the source, because the source is the reason nobody looked:

| Source | Why it slips through | Example seen in practice |
|---|---|---|
| The first draft | it was never a decision, only a starting point | a persona opening that stayed because it was there |
| Industry convention | everyone writes it, so it reads as correct | quality adjectives in a tool description |
| Translation | the borrowed term sounds technical | a foreign term carrying an unexamined frame |
| A famous attribution | quoting someone outsources the argument | a triad attributed to a philosopher who never wrote it |
| A previous document | copying is easier than re-deciding | a rule that contradicts another rule in the same file |

## Red flags

- **A quality adjective with no test.** helpful, thorough, rigorous, thoughtful, clean, robust, elegant,
  professional, delightful. Ask how to check it. If the answer is a feeling, rewrite as the action it
  was standing in for.
- **Cargo-culted structure.** A shape everyone follows (a triad, a template, a section order) that
  forces content to fill slots that do not exist in the material.
- **Soft attribution.** "It is well known", "studies show", "classically", "as X said". The hedging is
  where the verification is missing.
- **A rule that contradicts another rule nearby.** One of the two was inherited and never reconciled;
  find out which by asking which one has a failure mode behind it.
- **A metaphor standing in for a mechanism.** A vivid image can hide the fact that the mechanism was
  never described.
- **An absolute with no counterexample.** "Always", "never", "best" - a rule with no situation that
  violates it is decoration.

## The audit

1. **Mark the sentence's origin.** Ask where it came from. "It was in the draft" and "everyone does it"
   are answers, and both mean unexamined.
2. **Run the two gates.** Name the enemy, and check whether the phrasing narrows the job.
3. **Test the attribution**, if there is one. Verify the quote, the term, and its sense in the source
   language. Correcting a false attribution is a finding, not a nitpick.
4. **Rewrite as an observable, or delete.** The replacement names a failure mode or a checkable action:
   "keep the style consistent" becomes "one corner radius everywhere"; "be transparent" becomes "say
   which checks were run and which were not".
5. **Search for the same phrase elsewhere.** Inherited wording travels in families - if one file has it,
   sibling files usually do too, and those need the same pass.

## Why the author cannot do this alone

Inherited phrasing feels correct precisely because it is familiar, and the person who wrote it knows
what they meant, so they read the intention rather than the words. Two ways out: have someone else
point at the sentence, or state the origin out loud - "this came from the draft and I never chose it" -
which is usually enough to see it. The failure is rarely a bad sentence; it is a sentence nobody
ever decided on.

## Three worked cases

- **A persona opening kept from a draft.** "We are a helpful agent" survived because it was in the
  first sketch. It fails gate 1: there is no failure mode called *unhelpful* in the taxonomy it was
  meant to serve. Deleted.
- **A quality adjective in a tool description.** "Makes the layout look deliberate rather than
  generated" fails gate 1 as written - but the underlying intent is checkable once stated as the
  actions it meant: spacing that stays on one scale, a countable number of type sizes, and the empty
  and error states designed. The adjective was replaced by those three checks.
- **A famous triad.** "Thesis, antithesis, synthesis" is routinely attributed to Hegel, who did not
  write it; the shape comes from later commentators, and the book-length correction
  [The Dialectical Method: A Treatise Hegel Never Wrote](https://www.semanticscholar.org/paper/The-Dialectical-Method%3A-A-Treatise-Hegel-Never-Butler/5d2fa1201cc4afd439c091d9d2a29563f8ba2612#citing-papers)
  exists for that reason. A structure inherited under a false attribution is a structure nobody
  validated - here it also forced a three-beat rhythm the material did not have.
