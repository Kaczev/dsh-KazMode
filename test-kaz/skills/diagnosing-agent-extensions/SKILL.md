---
name: diagnosing-agent-extensions
description: Use when an agent extension or hook does not do what it should - a prompt contribution appears at the wrong time or not at all, a configuration change has no effect, a plugin mounts but contributes nothing, a counter or tracker misbehaves, or a write lands somewhere you did not intend.
---

# Diagnosing agent extensions

An extension system has the same three parts everywhere: something **registers** a contribution,
something **reads** it at a specific moment, and something **delivers** it to the model. Failures
live at the seams between those parts, and the seams fail silently far more often than loudly.

## Prove the extension loaded first

Do not debug behaviour until you know the extension is mounted and its contribution is registered.

- A plugin whose declared dependencies are not all provided can sit in a **pending** state
  indefinitely. It reports nothing, contributes nothing, and looks identical to a plugin that was
  never added. Enumerate the loaded fibers and their states; pending is the single most common
  explanation for "nothing happens".
- A contribution that registered can still be absent from what the model sees, because a filter ran
  after registration. Compare what you registered against what the consumer actually received, not
  against what you passed in.
- A module specifier that fails to resolve is typically **logged, not thrown**. At startup that log
  can be lost before any exporter is attached, so a row that silently does nothing usually means a
  misspelled name or a package that is not installed - check the spelling before the logic.

## Shape 1: configuration is read at mount, text at startup

The most common false conclusion in extension work is "my change did nothing" when the change is
correct and simply has not been read yet.

- **Configuration is read when the component mounts.** Editing a config file under a running process
  changes nothing until that component is re-read: restart, or trigger the reload the host offers.
- **Prompt text and personas are assembled when the process starts.** An edit to injected text is
  invisible in the running process - including in the very session that made the edit. A restart is
  part of the change, not an optimisation.
- **A file swap is not a reload.** Writing a new file where a component was already loaded leaves
  the loaded copy in place.

Say which of the three applies before concluding a change failed.

## Shape 2: a hook fired at the wrong moment, or a tracker misbehaves

Anything that accumulates state across events (a counter, a tracker, a "last seen" marker) breaks in
the same two ways:

- **Replaying history on startup.** A new process starts its cursor at zero, so its first scan sees
  every event the session ever recorded. A threshold meant to fire "after N calls in this turn" fires
  immediately, because the whole conversation counted. Fix: on first sight of a session, set the
  cursor to the current end without counting what came before.
- **Iterating events in the wrong direction.** When the consumer only *settles* records, order does
  not matter. When it maintains a running total, order is load-bearing: processing newest-to-oldest
  lets a "reset at the start of a turn" event run last and erase the count that was just built. Scan
  oldest-to-newest, always.
- **Double counting.** A scan loop without a "already processed up to here" guard increments again on
  every rerun. Keep the cursor guard and make the handler idempotent for a repeated event.
- **Untestable by reading.** These defects are invisible in code review and obvious in a test that
  feeds a realistic event sequence. Write that test: a session with history, then new activity.

## Shape 3: silent failure by design

Extensions are usually written to degrade rather than throw, which is right in production and
hostile in debugging. Know which failures are quiet here:

- unresolved module specifier - logged, component absent
- unmet declared dependency - pending forever, no error
- a listener that throws - caught and logged by the dispatcher, so the rest of the pipeline proceeds
- an empty contribution - omitted entirely rather than rendered as empty

Each is silent at the call site. When behaviour is missing, check these before reading the logic.

## Shape 4: the write landed somewhere else

Storage keyed by scope or root is a frequent source of "the data is wrong but the code is right".

- **Two roots, two rules.** A per-user store and a per-workspace store usually resolve differently:
  one from an environment variable, the other from the current working directory. Setting one and
  assuming both are isolated is the classic mistake.
- **Prove the landing point, not the intent.** Print the resolved absolute path before writing, and
  read the file back from the consumer's path. "I used a temporary directory" is not evidence unless
  the resolved path says so.
- **Check for a second copy.** The same logical store may exist per home, per profile, or per
  checkout, and a write to one is invisible from the other.

## Shape 5: text delivered to the wrong request

- **Appended, not replacing.** An injected message is added to what the next request carries; it does
  not overwrite earlier context, and repeated injection accumulates.
- **Not a wake-up.** Injecting context into an idle agent leaves it idle. If the work must continue,
  something has to start a turn.
- **Per-step versus per-turn.** A contribution intended for one step belongs in the per-step seam; put
  it in the per-turn path and it reappears every turn.
- **Two rendering paths.** Prompt text and runtime context are often separate seams with separate
  ordering tables. Placing a contribution in the wrong seam puts it in the wrong part of the model
  input - the bug looks like an ordering problem, but the cause is the seam.

## The ladder

Work down this order; each rung is cheaper than the next and rules out more:

1. Read back the registration and the resolved config value.
2. Confirm the component is mounted and not pending.
3. Confirm the contribution is present in what the consumer received.
4. Confirm the process picked up the current files (restart if text or config is involved).
5. Confirm the order and the cursor guard of any event scan.
6. Only then read the logic.
