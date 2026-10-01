# Reading a dispatch back

Dispatch returns a receipt, and **you are shown the whole thing** - not just the subagent id. A
refusal names its reason; the refusal *is* the diagnosis, and there is no second place to look.

## What the receipt tells you

- The subagent id, and which provider actually ran (`kaz-fork` only when a usable fork target was
  found).
- Whether an existing subagent was reused instead of a new one being started.
- Whether a requested `fork` target was reachable, and whether the child therefore inherited anything.
  When it says the child started fresh, the role has no memory of that target's conversation, however
  the plan was written.
- Which blacklist names were skipped, because they are reserved or because they are not real tools.

## The refusals, and what each one means

Each of these is a thing to change in the plan, not a thing to retry:

- an unknown persona;
- an entry with no `task`, or one that is only whitespace;
- an illegal `fork` value - it is not a boolean, so `true`, `false`, `"true"`, `"yes"` and any other
  value are rejected when the plan is written;
- an entry whose persona is one of the two fixed-face roles and which carries a `blacklist`;
- `ka_sub_whale` naming a role with no recorded entry;
- the running cap: five subagents may be **running** at once, and dispatching a name whose subagent is
  still running is refused - wait for its report instead.

## Reading the plan back

`get_arrangement` reads the plan back with the program's fields, in any stage. When the conversation
has grown long, prefer it over reconstructing from memory what was dispatched. It carries `id`,
`status` and `summary` per entry, with `summary` truncated to its first line at 200 characters - which
is why a subagent's closing message must lead with its verdict.
