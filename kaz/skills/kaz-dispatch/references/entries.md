# The entry: what each field takes

An entry is what `write_arrangement` records for one role of the round:

```text
{ persona: [...], blacklist: [...], task: "...", fork: "..." }
```

`id`, `status` and `summary` are the program's own fields: they are filled on dispatch and preserved
by role name across rewrites of the plan. Do not write them.

## `persona`

Either one of the reserved strings, or `[role, description]` - an array of **exactly two non-empty
strings**. Nothing else is accepted.

The description is where the role's instructions and boundaries go. The preset appends the tool
blacklist default, the way results come back, and the language rule (`kaz-shared/lib/roles.js`) to
every entry - do not repeat any of it in a role description.

## `task`

Required on every entry and hard-checked: an empty or whitespace-only one is rejected. It becomes the
subagent's first message, so write the ask, the scope, and what counts as done into it.

**Do not open a task with a holding instruction.** Because the `task` *is* the first message, "stand
by, you will be dispatched later" is taken literally: the role reads it as its whole assignment and
sits idle until someone messages it again. Write the actual ask from the first word, and queue later
work by messaging the role once it has reported.

**Check a skill is visible to the subagent before naming it.** Some skills are registered
main-agent-only: the catalog hides them from subagents, and loading one is refused - observed on a
live probe, where a dispatched subagent got `unknown or no longer available` for `kaz-dispatch` and
for `moving-or-upgrading-a-thing`, while `powershell-scripting` loaded. That is the observed
behaviour, not a guarantee: the load path itself is not filtered by the gate, so it rests on the
platform resolving names through the filtered catalog. Either way, naming a main-agent-only skill in a
task produces nothing, and the role silently works without it. The list lives in
`functions/kaz-shared/lib/skill-visibility.js` as `MAIN_AGENT_ONLY_SKILLS` (kebab-case, matching each
`SKILL.md`'s `name`). If the skill you wanted is on that list, **read it yourself and put what the
role needs into the task text** rather than telling the subagent to load it - a task that names a
main-agent-only skill burns a dispatch on a role that never saw the instructions.

## `blacklist`

Optional, and **enforced** rather than advisory: a denied tool is absent from the subagent's tool
face, and calling it errors.

**Nine tools are denied to every subagent we dispatch regardless:** `send_message`,
`interrupt_agent`, `ka_sub_whale`, `write_arrangement`, `whale_report`, the three memory-write tools
(`memory_save`, `memory_update`, `memory_forget`), and `ask_user_question`. That default lives in code
(`kaz-shared/lib/blacklists.js`, `SUBAGENT_DEFAULT_BLACKLIST`) and is never rendered to the model, so
this paragraph is the only place it reaches you. Write a list of what is **additionally** forbidden -
a role that must not write is a role you must deny writing. An empty list adds nothing back.

- Names in the reserved set are dropped silently: the reserved tools (the context four, the read-only
  memory three, `list_agents`, `get_arrangement`) cannot be denied by any blacklist.
- A name that is not a real tool is skipped with a note in the dispatch receipt - so read the
  receipt once rather than assuming the list landed whole.
- Write only real tool names. `get_arrangement` is mounted for the main agent alone, so no subagent
  receives it whatever the list says.

`blacklist` may be left out of an entry entirely; what may not be written is a `blacklist` on an entry
whose persona is one of the two fixed-face roles - see `references/reserved-and-reuse.md`.
