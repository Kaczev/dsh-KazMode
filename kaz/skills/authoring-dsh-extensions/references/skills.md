# Skills

A skill is an instruction pack a session can load on demand. Two shapes are
discovered under a skills root:

```
<root>/<name>/SKILL.md      # directory bundle: the name comes from frontmatter
<root>/<name>.md            # flat entry
```

Discovery reads **direct children of the root only**. Any top-level `*.md` is treated
as a flat skill, and any child directory holding a `SKILL.md` is a bundle; nothing
deeper is scanned, so a nested `**/SKILL.md` is invisible. The path segment never
names the skill: `name` always comes from frontmatter.

## Frontmatter

Two keys are required:

```yaml
---
name: kebab-case-name
description: Use when ... - the situation, the symptoms, the phrasings a request might use.
---
```

- `name` must match `^[a-z0-9]+(?:-[a-z0-9]+)*$`. **Nothing compares it with the file
  or directory name** - a mismatch loads normally and is simply confusing to read.
- `description` must be a non-empty string. A missing or unusable `name`/`description`
  logs `frontmatter requires name and description` and the skill does not exist, with
  no error at the call site. A missing frontmatter block warns too.
- A top-level `.md` that is not really a skill is still parsed, and warns on every
  discovery. A directory without a `SKILL.md` is skipped with **no warning at all** -
  the asymmetry is worth knowing before you trust "no warning" as "nothing wrong".

Optional keys - these four and no others are read:

| Key | Meaning |
|---|---|
| `whenToUse` | stored on the skill, and **never reaches the model**; put the trigger in `description` |
| `metadata` | provider-specific free-form data, stored and passed through |
| `disable-model-invocation` | set true to bar the `skill` tool from loading it |
| `user-invocable` | set false to bar the user's `/name` invocation |

Both invocation keys default to permitting their surface. Values accept YAML booleans
plus `true`/`false`, `yes`/`no`, `on`/`off` and `1`/`0`, case-insensitively. Only three
legacy camelCase spellings are **rejected** with an error: `disableModelInvocation`,
`modelInvocable`, `userInvocable`. Every other unknown key - camelCase included - is
**ignored silently**, and `whenToUse` is itself camelCase. So a misspelled invocation
key does nothing at all rather than failing.

## Roots and ranks

| Rank | Root | Who puts skills there |
|---|---|---|
| 100 | `<project>/.dsh/skills` | the project, private to it |
| 200 | `<project>/.agents/skills` | the project, in the shared agent convention |
| 250 | the registry's runtime layer | a provider that contributes at runtime |
| 300 | configured extra directories (`customSkillDirs`) | an extension that ships its own |
| 400 | `<dshHome>/skills` (`$DSH_HOME`, else `~/.dsh`) | the user, across projects |
| 500 | `<agentsHome>/skills` (`$DSH_AGENTS_HOME`, else `~/.agents`) | the user, shared across agent tools |
| 600 | the bundled root (`$DSH_BUNDLED_SKILL_DIR`) | the deployment |

- **The lowest rank wins a duplicate name only within one layer.** Across layers the
  nearer layer wins outright, whatever the ranks say.
- Rank 300 is the seam an extension uses to ship skills, and it deliberately outranks
  the user roots so a shipped skill is present by default while still being overridable
  at the project level.
- The **project root** is the nearest ancestor containing `.git`; with none, the
  working directory. The `.system` child of the user root is skipped.
- `includeDefaultRoots: false` drops the project and user roots, and the bundled root
  is mounted only when default roots are included or `bundledSkillDir` is set.
- `watch` and `watchFollowSymlinks` both default true, which is why editing a skill
  file refreshes the catalog in a live session. `customSkillDirs` is read when the
  provider mounts, so a **newly configured root needs a restart** even though edits
  inside an existing root do not.

A skill file inside a plugin or preset directory is **not** discovered by itself: the
provider scans only its configured roots. Point `customSkillDirs` at the shipped
directory, which is what a preset that ships skills does.

## The catalog

The catalog is delivered by `dsh-tool-skill`, not by the provider: at the first
`agent/pre-step` of a live session that observes a non-empty complete view, it injects
a durable user-role `<system-reminder>` listing the available skills. The tool and the
catalog travel together - hiding or shadowing the `skill` tool removes both.

- Entries carry `name` and a normalized, XML-escaped `description`, sorted. No body,
  path, source, provider or routing hint.
- The description is whitespace-normalized, then cut to `catalogDescriptionMaxLength`
  (**default 500, minimum 3**) and marked with a literal `...`. It is never dropped.
- A catalog change appends a **complete replacement**, including an empty catalog that
  retires the old names. An edit that touches only a body changes no digest and emits
  no catalog message, so the model cannot notice it.

## Loading a body

The result renders as `<skill_content name="...">`, a `<skill_resources>` hint that
names the base directory, then `<skill_instructions>`.

- A **directory bundle**'s base directory is the skill directory, so a relative
  `references/<topic>.md` resolves beside `SKILL.md`.
- A **flat** skill's base directory is the whole scanned **root**, so `references/`
  beside the file does NOT resolve. Push long detail into a bundle, or the link breaks.
- Resources are not enumerated or fetched for you: read the ones the body names, and
  prefer reading them in windows rather than whole.
- In Desktop the skills live inside `app.asar`, which shell commands, the glob and
  search tools, `node` and `pnpm` cannot open. The file-read tool can.
- A rendered body above **8192 code points** is trimmed to its first 4096 plus its last
  1024 the next time compaction runs. Keep the body short and put depth in references.

`disable-model-invocation` skills are reached only by the user typing `/<name>` as a
whitespace-bounded token in their own message, which injects the same content into that
step. A model call fails: an invalid name, a name that is `unknown or no longer
available`, or a skill that is `not available for model invocation`.

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
