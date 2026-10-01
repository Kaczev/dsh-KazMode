# Reserved values, reuse, and rewriting the plan

## The three things `fork` accepts

`fork` is not a boolean. It is the literal `"main"` (inherit the dispatcher's own conversation), the
literal `"none"` (start a fresh subagent), or a subagent id. `"none"` and leaving the field out mean
the same thing and store the same entry; any other value is rejected when the plan is written. Which
of the three is worth writing is the rule in the main file, under "When a fork is worth it".

## The reserved values

| value | what it is for | its tool face |
|---|---|---|
| `"main"` | the main agent itself. It is a legal entry and **not dispatchable** - dispatching it is refused. | n/a |
| `"memoryMaintainer"` | the memory keeper. Only this role can write memories. | fixed by the preset |
| `"slopCleaner"` | the AI-slop cleaner, dispatched for a cleanup. | fixed by the preset |

- **The plan must contain `memoryMaintainer`, every round.** The stage text says so on entry, and it is
  the only role that can write a memory. An arrangement written without it is a round in which nothing
  can be remembered.
- For the two fixed-face roles the tool face comes from the preset, so a `blacklist` written on that
  entry would be ignored - and an entry that carries one is **rejected** rather than quietly accepted.
  Drop the field, or use `[role, description]` if the role needs narrowing.
- A reserved value may also be written as `[reservedName, description]`. It reaches the same fixed
  persona and the same fixed tool face, because the reserved name is matched as the role name - but
  write the bare string: it is what the entry validator, this file, and the dispatcher all agree on,
  and a later reader cannot tell the two forms apart.

## Role names are identity, and they are the reuse key

- `write_arrangement` **replaces the whole plan.** An entry that is not restated in this call is gone,
  and a live subagent with that name stops being addressable through the arrangement. Restate every
  entry the round still wants, `memoryMaintainer` included.
- Two entries that share a role name are the same entry, and only the first is ever dispatchable.
  **Names must differ** - two independent proposers are `proposer-a` and `proposer-b`, never
  `proposer` twice.
- Re-dispatching a name that is already loaded **reuses** that subagent with its earlier context
  instead of starting a fresh one. That is the point: a second dispatch in the same conversation
  continues a role that already knows what it was told. The consequence to plan around is the opposite
  of fresh eyes - queue more work for a role rather than expecting it to re-read its first
  instructions. A `fork` written on a reused entry does nothing, and the receipt says so; if the role
  must actually be seeded from somewhere, it needs a **new name**, so that it starts fresh and the
  fork is what fills its context.
- Dispatching a name whose subagent is still running is refused; wait for its report instead.
- A role that must be independent of another must therefore have a **different name**. Forking a role,
  or re-dispatching the same name, hands the work to an agent that has already seen it.
