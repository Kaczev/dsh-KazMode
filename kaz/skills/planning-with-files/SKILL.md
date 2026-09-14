---
name: planning-with-files
description: Use when a task will outlive one context window - multi-phase work, long investigations, or anything spanning many tool calls or sessions - to keep the plan, the evidence, and the state on disk instead of in memory, so the work survives compaction and a fresh session can resume it.
user-invocable: false
---

# Planning with files

Treat the context window as volatile memory and the filesystem as disk. Anything that must survive
compaction, a restart, or a handover gets written down while it is still known.

## When this earns its cost

Use it for work with phases: an investigation, a multi-step build, anything that will span more than
one sitting or more than one context window. Do not use it for a single edit, a quick lookup, or a
question answerable in one step - the files then cost more attention than the work.

## Two files, two jobs

Keep them in the working directory, beside the code they describe, never inside a skill or tool
installation directory.

| File | Holds | Written when |
|---|---|---|
| `task_plan.md` | goal, phases, current status, decisions and why, and a short log tail: what was attempted, what passed, what failed, what is next | when a phase ends, or when you stop for the session |
| `findings.md` | discoveries with their evidence: paths, commands, observed output | when a line of investigation concludes - as a batch, not one call at a time |

The split matters: a plan that also carries raw findings becomes unreadable, and findings buried in a
log are not re-read before a decision. A status column and a log tail are the same information at
different resolution, so they belong in one file; raw findings do not.

## Rules that carry the weight

1. **Write the plan before starting.** A phase list with a status per phase, and the goal stated in
   one line at the top. Without it there is no way to tell progress from motion.
2. **Record what a cold reader will need**, not everything you learned. A cold reader is someone who
   did not watch you work and has only the files: they need a decision, a path, an exact error, or
   what a two-command investigation concluded. Trivia that can be re-derived from the code does not
   qualify. The plan gets its batch when the phase ends; findings get theirs when the investigation
   they belong to concludes. Neither is a reason to write after every second tool call.
   The exception is content that arrived as an image, a screenshot, or a rendered page: write that
   down the moment you have it, because unlike a file it cannot be recovered by reading again.
3. **Read the plan before a decision.** Re-reading the goal and the current phase before choosing what
   to do next is what keeps the work aligned; a plan read once at the start is decoration.
4. **Log every failure with its attempt count**, and never repeat an action that already failed.
   Change the approach instead.
5. **Keep the plan short.** It is a map, not a transcript. Evidence goes in `findings.md`, detail goes
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
| Resuming after a gap | read both | rebuild the picture before acting |

## Resuming cold

Someone else - or the same agent after a restart - should be able to answer three questions from the
files alone:

1. Where is the work now, and what remains? (`task_plan.md`: the status column, then the phases not done)
2. What is the goal? (the one-line statement at the top)
3. What has been learned, and what has failed? (`findings.md`, and the log tail of `task_plan.md`)

If a question can only be answered by reading the session transcript, the files have a gap - the
transcript is the fallback, not the record.

## Living with the runtime's own features

- **A todo list and a plan file are different instruments, not two copies of one.** A todo list is
  what the runtime shows the model for the current turn, and it is replaced whole by the next
  `todo_write` call - so it carries the immediate next actions and nothing durable. The plan file
  carries the phases, the decisions, and the reason behind them, and it is the only one of the two
  that survives compaction. Put a thing in the plan file, not in a todo, when it has to still be true
  tomorrow. That said, the session log keeps every todo write, so "I wrote it in a todo and it is
  gone" is not a real loss - search the log before concluding something was never recorded. The log is
  a fallback: it answers for you, not for a cold reader.
- **Context compaction** folds the middle of a conversation into a summary. Assume it will happen:
  the plan file is what remains exact afterwards.
- **Memory** stores facts that outlive the task. A plan file is scoped to one piece of work and should
  be deleted or archived when that work ends, rather than accumulating as a second, worse memory.
