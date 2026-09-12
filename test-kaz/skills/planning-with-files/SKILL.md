---
name: planning-with-files
description: Use when a task will outlive one context window - multi-phase work, long investigations, or anything spanning many tool calls or sessions - to keep the plan, the evidence, and the state on disk instead of in memory, so the work survives compaction and a fresh session can resume it.
---

# Planning with files

Treat the context window as volatile memory and the filesystem as disk. Anything that must survive
compaction, a restart, or a handover gets written down while it is still known.

## When this earns its cost

Use it for work with phases: an investigation, a multi-step build, anything that will span more than
one sitting or more than one context window. Do not use it for a single edit, a quick lookup, or a
question answerable in one step - the files then cost more attention than the work.

## Three files, three jobs

Keep them in the working directory, beside the code they describe, never inside a skill or tool
installation directory.

| File | Holds | Written when |
|---|---|---|
| `task_plan.md` | goal, phases, current status, decisions and why | after each phase completes |
| `findings.md` | discoveries with their evidence: paths, commands, observed output | the moment a finding is made |
| `progress.md` | running log: what was attempted, what passed, what failed, what is next | continuously, and at every stop |

The split matters: a plan that also carries raw findings becomes unreadable, and findings buried in a
log are not re-read before a decision.

## Rules that carry the weight

1. **Write the plan before starting.** A phase list with a status per phase, and the goal stated in
   one line at the top. Without it there is no way to tell progress from motion.
2. **Record findings when they are made**, not at the end. Two reads or two commands without a write
   is the signal: whatever was learned is one compaction away from being lost. Content that arrived
   as an image, a screenshot, or a rendered page is the most urgent - it cannot be recovered by
   re-reading a file.
3. **Read the plan before a decision.** Re-reading the goal and the current phase before choosing what
   to do next is what keeps the work aligned; a plan read once at the start is decoration.
4. **Update after acting.** Mark the phase, note the files touched, and log the errors.
5. **Log every failure with its attempt count**, and never repeat an action that already failed.
   Change the approach instead.
6. **Keep the plan short.** It is a map, not a transcript. Evidence goes in `findings.md`, detail goes
   in the artifacts themselves.

## When something fails three times

```
attempt 1: diagnose the error, fix the cause
attempt 2: change the approach - different tool, different layer
attempt 3: question the assumption the plan rests on
after 3:  stop and report - what was tried, the exact error, what would decide it
```

Repeating a failing action with more confidence is the most expensive habit available.

## Read or write?

| Situation | Action | Why |
|---|---|---|
| A file was just written | do not re-read it | its content is still in context |
| An image, page, or screenshot arrived | write it down now | it will not survive compaction |
| A command produced output that matters | quote the line into findings | the log scrolls away |
| A new phase starts | read plan and findings | re-orient before deciding |
| An error appeared | read the current state | fix from what is, not from what was |
| Resuming after a gap | read all three | rebuild the picture before acting |

## Resuming cold

Someone else - or the same agent after a restart - should be able to answer five questions from the
files alone:

1. Where is the work now? (`task_plan.md` status)
2. What remains? (phases not done)
3. What is the goal? (the one-line statement)
4. What has been learned? (`findings.md`)
5. What has been done and what failed? (`progress.md`)

If any answer requires reading the session transcript, something was not written down.

## Living with the runtime's own features

- **Next-step reminders** (a todo list) and a plan file complement each other: the todo list carries
  the immediate next actions, the plan file carries phases, decisions, and the reason behind them.
  Do not duplicate one into the other - a todo list is not durable and a plan file is not a scratchpad.
- **Context compaction** folds the middle of a conversation into a summary. Assume it will happen:
  the plan file is what remains exact afterwards.
- **Memory** stores facts that outlive the task. A plan file is scoped to one piece of work and should
  be deleted or archived when that work ends, rather than accumulating as a second, worse memory.
