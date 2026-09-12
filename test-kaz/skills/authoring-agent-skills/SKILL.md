---
name: authoring-agent-skills
description: Use when writing, reviewing, or shipping a SKILL.md for an agent runtime - creating a skill, deciding what belongs in a skill versus a persona or memory, making a skill travel with an extension or preset instead of a user skills directory, or diagnosing a skill that does not appear in the catalog.
---

# Authoring agent skills

A skill is a lazily loaded instruction pack: its `name` and `description` sit in the model's catalog
every turn, and its body enters context only when the skill is loaded. Everything below follows from
that one asymmetry.

## What belongs in a skill

Write a skill when the capability is **used repeatedly but not needed every turn**, and when its
description can name a situation the model will recognize. Writing it costs nothing until load.

Do not write one when:

- It belongs in a persona or system prompt. Text needed on *most* turns belongs to the always-on
  prompt; duplicating it in a skill creates drift between two copies.
- It is a fact about this machine or this repository. Those belong in memory, which is searched at
  the moment of need and costs nothing when unused.
- It is a one-off task. A skill earns its catalog line by recurring.

A skill pays for itself only if the description routes correctly. **The description is the whole
routing decision**: the catalog carries `name` and `description` and nothing else - no body, no
paths, no tags.

## File format

```
<skills-root>/<kebab-name>/SKILL.md      # directory bundle
<skills-root>/<kebab-name>.md            # flat entry
```

Discovery is **one level deep**: a nested `**/SKILL.md` is not found.

Frontmatter is YAML and takes two required keys:

```yaml
---
name: kebab-case-name
description: Use when ... - the situation, the symptoms, the phrasings a request might use.
---
```

- `name` must match `^[a-z0-9]+(?:-[a-z0-9]+)*$` and should equal its directory name.
- A missing or empty `name`/`description` makes the provider **warn and skip the file** - the skill
  simply does not exist, with no error at the call site.
- Optional keys: `whenToUse`, `metadata`, `disable-model-invocation`, `user-invocable`. The last two
  default to true. Use the kebab-case spellings; camelCase variants are rejected.
- Some runtimes bound the description length and omit an entry's description entirely when the
  catalog overflows rather than truncating it. Keep it to one sentence that a stranger could match a
  request against. Follow the local spec's number when one exists.

The body is Markdown for the model. Open with a `# Title` and a short orientation paragraph, then one
concern per `##` section; two heading levels are enough. State exact commands, real paths, and short
examples instead of describing them. Push long detail into a `references/<topic>.md` beside
`SKILL.md` and link it relatively - the loader resolves paths against the skill directory.

Write current-state imperative prose. A skill is an instruction, not an essay: no reasoning
transcripts, no restated rationale, no metaphors.

## Where skills are discovered

Roots are ranked and **the nearest wins a duplicate name**, so a user's own copy overrides the
shipped one. A representative order, lowest number first:

| Rank | Root | Who puts skills there |
|---|---|---|
| 100 | `<project>/.dsh/skills` | the project, private to it |
| 200 | `<project>/.agents/skills` | the project, in the shared agent convention |
| 300 | configured extra directories | an extension that ships its own |
| 400 | `<DSH_HOME>/skills` | the user, across projects |
| 500 | `<agents home>/skills` | the user, shared across agent tools |
| 600 | a configured bundled root | the deployment |

The project root is the nearest ancestor containing `.git`; without one, the working directory. Rank
300 is the seam an extension uses to ship skills (see below), and it deliberately outranks the user
roots so that a shipped skill is present by default while still being overridable at the project
level.

## Ship skills with the extension

A skill file sitting inside an extension directory is **not** discovered by itself: the discovery
provider only scans its configured roots. Point it at the shipped directory from the composition
that loads the extension:

```yaml
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs:
      - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"
```

Three traps, all of them silent:

- **Compute an absolute path in the composition.** A plugin's own config goes through
  `path.resolve()`, which anchors on the process working directory, not on the composition file.
  A literal `./skills` therefore points wherever the process happened to start.
- **`baseUrl` is the composition file's own directory**, and it is in scope for `!!js` evaluation.
  `__dirname`, `require`, and `module` are **not**; reach builtins through
  `process.getBuiltinModule('node:...')`. An expression that throws breaks the whole mount.
- **Do not widen the search to a machine-specific path.** The expression above travels: it computes
  the directory of whichever copy of the composition is running, so a test install and a production
  install each find their own skills.

## Validate before trusting it

Reading the file proves only that it was written. Check the things a loader checks:

1. Frontmatter parses; `name` matches the directory and the kebab-case grammar.
2. `description` starts with the routing phrase the convention uses ("Use when ...") and fits the
   local length bound.
3. The body is non-empty and carries the commands a reader would need.
4. The file is pure ASCII with LF endings if the rest of the repository is - mixed encodings and a
   byte-order mark are user-visible defects in a text artifact.
5. The directory contains `SKILL.md` and nothing else unless a `references/` file is genuinely
   needed.

Then load it through the runtime and confirm the body arrived, rather than trusting the catalog
line: a skill can appear in the catalog and still fail to load its body.

## When a skill does not appear

- **Wrong depth.** `skills/<name>/SKILL.md` is found; `skills/<name>/docs/SKILL.md` is not.
- **Frontmatter rejected.** A malformed or incomplete frontmatter block is skipped with a warning
  that is easy to miss at startup.
- **Root not scanned.** Verify the root the provider actually resolved - a relative path in a
  plugin's config resolves against the process working directory, so confirm the absolute path
  rather than the string you wrote.
- **Catalog not rebuilt.** Adding or editing a skill file refreshes the catalog in a live session - the
  change appears without a restart, so a skill missing from the catalog was not discovered at all.
  A *newly configured root* is different: the provider is configured when the process mounts, so a
  change to `customSkillDirs` needs a restart before the new root is scanned.
- **Name collision.** A nearer root wins outright, so a same-named skill in the project's own skills
  directory shadows the shipped one - useful for overriding, confusing when accidental.
