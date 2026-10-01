# Verifying a skill, and when not to write one

## Verify it landed

Reading the file proves only that it was written. Check what a loader checks:

1. Frontmatter parses; `name` matches the kebab grammar.
2. `description` starts with the routing phrase the convention uses and fits the bound.
3. The body is non-empty and carries the commands a reader would need.
4. The file sits at the depth the provider scans, under a root it actually resolved -
   confirm the resolved absolute path, not the string you wrote.
5. Load it through the runtime and confirm the body arrived. A skill can appear in the
   catalog and still fail to load its body.

## When a skill is the wrong artifact

Write one when the capability is **used repeatedly but not needed every turn**, and
when its description can name a situation the model will recognize. Writing it costs
nothing until load. Do not write one when:

- It belongs in a persona or system prompt. Text needed on *most* turns belongs to the
  always-on prompt; duplicating it in a skill creates drift between two copies.
- It is a fact about this machine or this repository. Those belong in memory, which is
  searched at the moment of need and costs nothing when unused.
- It is a one-off task. A skill occupies a catalog line in every session it is
  installed in; that cost is only repaid by a task that comes back.
