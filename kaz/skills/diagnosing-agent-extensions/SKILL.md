---
name: diagnosing-agent-extensions
description: Use when an agent extension or hook does not do what it should - a prompt contribution appears at the wrong time or not at all, a configuration change has no effect, a plugin mounts but contributes nothing, a counter or tracker misbehaves, or a write lands somewhere you did not intend.
user-invocable: false
---

# Diagnosing agent extensions

An extension system has the same three parts everywhere: something **registers** a
contribution, something **reads** it at a specific moment, and something **delivers** it
to the model. Failures live at the seams between those parts, and the seams fail silently
far more often than loudly.

## Prove the extension loaded first

Do not debug behaviour until you know the extension is mounted and its contribution is
registered.

- A plugin whose declared dependencies are not all provided sits in a **pending** state
  indefinitely: it reports nothing, contributes nothing, and looks like a plugin that was
  never added. Where the host exposes no way to enumerate fibers, your evidence is what
  the session shows you - a readable catalog or prompt section, your own tool schemas. A
  tool absent from your face was either never mounted or is pending. **A row inside a
  preset is the exception**: its pending state surfaces as `waiting for <service>` in that
  preset's broken reason, so read the roster before concluding you cannot tell. Outside
  that, say which of the two you cannot rule out. "I could not see the fiber" is not "it
  is pending".
- A contribution that registered can still be absent from what the model sees, because a
  filter ran after registration. Compare what you registered against what the consumer
  actually received, not against what you passed in.
- A module specifier that fails to resolve is reported rather than thrown at the call
  site. At startup that report can be lost before any exporter is attached, so a row that
  silently does nothing usually means a misspelled name or a package that is not
  installed - check the spelling before the logic.

## Shape 1: configuration is read at mount, text at startup

The most common false conclusion here is "my change did nothing" when the change is
correct and has simply not been read yet.

- **Configuration is read when the component mounts.** Editing a config file under a
  running process changes nothing until that component is re-read: restart, or trigger a
  reload if the host exposes one - and from inside a session it often does not. A change
  confined to declared-volatile values is the exception; that commits into the running
  component.
- **Prompt text is mostly assembled from values captured at registration**, so an edit to
  it is invisible in the running process, including in the session that made the edit. The
  seam is not uniformly cold: a profile's patch layer reloads immediately, and at least one
  contributor reconciles live, so establish which kind you are editing.
- **A file swap is not a reload.** Writing a new file where a component was already loaded
  leaves the loaded copy in place.

Say which of the three applies before concluding a change failed.

## Shape 2: something accumulating state across events

Anything keeping a running total across events - a counter, a tracker, a "last seen"
marker - is where the session API matters most, and where a guess about that API produces
a confidently wrong diagnosis.

- **The feed is post-commit and forward-only.** A component subscribes to the session
  event feed (`session/event`) and sees events as they commit. It does not replay the log,
  so a listener attached mid-session never sees what happened before it. Not seeing history
  is normal, and is not a reason to seed a counter from zero.
- **Whole-log state belongs in a projection.** On a late build a projection folds the
  history it missed and then follows the feed. **Do not "skip to the current end" to avoid
  double counting** - that is exactly how a fold loses everything before it started. A
  total that looks too low should make you suspect that shortcut first.
- **Every read is ascending**, so processing order is not the hazard it is in systems that
  hand you a reversed stream. Synchronous log reads still exist and are deprecated.
- **The watermark is still your job.** Keep the last sequence you processed and reject
  anything at or below it, so a repeated notification cannot count the same event twice.
- **Untestable by reading.** These defects are invisible in review and obvious in a test
  that feeds a realistic sequence - history first, then live events - and asserts the
  total.

## Shape 3: silent failure by design

Extensions usually degrade rather than throw, which is right in production and hostile in
debugging. Know which failures are quiet here:

- unresolved module specifier - reported, component absent
- unmet declared dependency - pending forever, no error at the fiber, and `waiting for
  <service>` in a preset row's broken reason
- an empty contribution - usually omitted rather than rendered as empty, though a
  contribution type may deliberately render an envelope holding an instruction, so an
  empty-looking section is not proof that nothing registered
- **a listener that throws is NOT contained for you.** The dispatcher calls listeners
  unguarded, and a parallel dispatch rethrows the failure as an aggregate; containment is
  per producer. A throwing listener can take down the notifier or the step that emitted
  the event, and it reads afterwards like "the extension vanished". Wrap your own body.

The first three are silent at the call site. When behaviour is missing, check them before
reading the logic.

## Shapes 4 and 5: state roots and message delivery

A write that lands in a store you did not mean, and text that reaches a request you did
not mean, are the two remaining seams. Read `references/state-and-delivery.md` when the
symptom is "the data is wrong but the code is right", or when a contribution appears in
the wrong part of the model input or at the wrong frequency.

## The ladder

Work down this order; each rung is cheaper than the next and rules out more:

1. Read back the registration and the resolved config value.
2. Confirm the component is mounted and not pending - a preset row's broken reason is the
   one place that is visible.
3. Confirm the contribution is present in what the consumer received.
4. Confirm the process picked up the current files (restart if text or config is involved).
5. Confirm the cursor guard of any event scan, and that a fold started from history rather
   than from the current end.
6. Only then read the logic.
