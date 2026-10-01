---
name: authoring-dsh-extensions
description: Use when writing, changing, wiring, verifying or shipping anything that extends the harness - a SKILL.md, a plugin module exporting name/inject/apply, a config schema, a model-facing tool, an agent preset declaration, or a bundle that carries any of them. Also when one of those is in place but contributes nothing.
user-invocable: false
---

# Authoring DSH extensions

Three artifacts extend the harness, and one carrier puts them into a profile:

| Artifact | What it is | How it reaches a session |
|---|---|---|
| a **skill** | a lazily loaded instruction pack under a skills root | a skill provider scans that root |
| a **plugin** | a module exporting `apply(ctx)`, plus optional `name`, `inject`, `Config` | a composition row mounts it |
| an **agent preset** | one `@deepseek-ai/dsh-agent-preset` declaration row | the preset registry activates it; sessions select it |
| a **bundle** | a package whose `package.json` declares `dsh.bundle.patch` | `plugin_manager` installs it into the profile |

None of the artifacts delivers itself. A skill file inside a plugin or preset directory
is not discovered, a plugin contributes nothing until a row mounts it, and a preset does
nothing until a session selects it. A bundle is the supported way to add any of them to a
profile, and a profile is what a profile-launched CLI and the Desktop app both read.

One rule is worth more than any fact below: **read the contribution back from the
running system, through the same seam the model sees.** Loading a file proves it
parses; importing a module yourself proves it was written; only the running system
proves the row mounted and the contribution arrived. A tool missing from the tool
face, a prompt section that never renders, a catalog entry that is not there - each
is evidence that something did not land. "I could not see the component" is never
"it is pending"; say which of the two you cannot rule out.

## Read the matching reference

| Question | File |
|---|---|
| Skill file shape, frontmatter keys, roots and ranks, the catalog, loading a body; verifying a skill landed, and when not to write one | `references/skills.md`, `references/verify-and-scope.md` |
| Plugin export forms, Config, services, prompt seams; the tool a plugin registers and the text it injects mid-turn | `references/plugins.md`, `references/tool-surface.md` |
| Bundles, `plugin_manager`, version floors, mount faults; what makes a composition row mount, and finding the API | `references/installing.md`, `references/composition.md` |
| Declaring a preset, overriding a row, verifying the roster; the patch dialect, row fields, isolate realms, the one-plane rule | `references/presets.md`, `references/patch-layers.md` |

Read one with the file-read tool, whole: every reference here renders under 7,200 code
points, so none of them is long enough to need windows. The rule that forced the split is
worth keeping in view anyway: a tool result over 8192 code points is trimmed to its first
4096 plus its last 1024 the next time compaction runs, so a long file read whole loses its
middle. This file stays short for that reason, and so should every `SKILL.md` you write -
and a reference that does grow past that line is read with `offset` and `limit`.

## Facts that decide the shape before you read further

- **A preset is a declaration row, not a directory.** `preset.yml` beside
  `agent.cordis.yml` is the retired layout; nothing reads it. Declare
  `@deepseek-ai/dsh-agent-preset` with `id` (required), `plugins` (required) and
  optional `name`, `description`, `order`, and carry the row in a bundle patch.
- **`!!js` has two scopes.** Inside `config` it runs against the row's own plugin
  context, after that row's declared injections activate, so services and
  `ctx.get(...)` are reachable. In a row's `disabled` it runs against the loader
  context at every mount decision. Every other row field stays literal, so an
  expression there is silently truthy data rather than an error.
- **A provider name is unique per registry and per scope.** There is no harness-wide
  shadowing: the registry that owns the name raises on a duplicate, and the outcome is
  a refused registration rather than an override. Read what the composition already
  mounts before adding a row that supplies the same thing.
- **A row belongs to exactly one plane.** A preset row that is also active in the host
  composition mounts twice - once per process, once per session - and the damage
  depends on what it does.
- **`plugin_manager` is how a change becomes live**, and its `application` and
  `warnings` fields decide that, not logs, terminal output or process lists. Replacing
  an installed package needs a restart to load fresh module code; the profile's patch
  layer reloads immediately.
- **A session keeps the revision it started with.** Open a new session to see a
  changed composition.
- **The skill catalog carries `name` and `description` and nothing else**, so the
  description is the entire routing surface. `whenToUse` is stored and never shown.
- **Know which scope you are editing.** A skill body under an already-scanned root is
  picked up live, because the provider watches by default. A new root, a row's
  `config`, and prompt text captured at registration are not - those need the mount
  redone or the process restarted.

## When it does not appear

Take the cheapest explanation first, and report the one you ruled out rather than
guessing a cause you cannot see.

- **A skill:** wrong depth (discovery is one level deep, so a nested `**/SKILL.md` is
  skipped without any warning), a missing or empty `name`/`description`, a root the
  provider never resolved, a nearer root winning the same name, or a description cut
  at the catalog bound. Detail in `references/skills.md`.
- **A plugin:** the row is pending on a service nobody provides, the specifier does
  not resolve, `apply` threw, or `config` failed validation before `apply` ran. The
  mount verdict names the rows that did not activate and distinguishes `never started`
  from `waiting for <service>`; read that message before reading the logic. Detail in
  `references/installing.md`.
- **A preset:** no declaration reached the roster, the declaration sits on the roster
  with a `broken` reason, or the session predates the change. Detail in
  `references/presets.md`.

Mount state, hook timing and counter or tracker misbehaviour are a different skill's
territory: when the contribution is not the problem but the moment it arrives is,
`diagnosing-agent-extensions` carries those techniques.
