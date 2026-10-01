# Agent presets

An agent preset is an ordinary `@deepseek-ai/dsh-agent-preset` **declaration row** in a
Cordis composition. Nothing edits a declaration in place: a preset is created or
changed by installing a bundle whose patch declares or overrides it.

> The directory layout this replaced is dead. A preset used to be
> `$DSH_HOME/.agent-presets/<id>/` holding `preset.yml` (display metadata) and
> `agent.cordis.yml` (the plugin list). **Nothing reads that directory any more**, and
> a composition file named `agent.cordis.yml` has no special meaning. If you are
> reading an older repository that still keeps those files, they are that project's own
> source artifacts feeding its generator, not something the harness loads.

## The declaration

```yaml
- id: preset-review
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: review
    name: Review
    description: Reviews changes with the shell only.
    order: 10
    plugins:
      - id: persona
        name: '@deepseek-ai/dsh-persona'
        config:
          prefix: You review software changes.
      - id: tool-bash
        name: '@deepseek-ai/dsh-tool-bash'
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | stable preset identity; lowercase letters, digits and hyphens; what a session records |
| `plugins` | yes | the child Cordis entry list, inline |
| `name` | no | display name in the picker |
| `description` | no | one sentence on what this preset is for - write it for the person choosing |
| `order` | no | position in the roster |

The **Loader row `id` is `preset-<id>` by convention**, which is what an override
targets. Child entry ids may be omitted and are then assigned by the Loader, but set
them: an id is what makes an edit a config change rather than a remount.

The registry owns selection and runtime revisions. Declarations activate eagerly, so a
broken one shows up before anyone selects it; a failed declaration stays on the roster
with its diagnostic and refuses new bindings without stopping the application. Agents
keep the revision they started with, and their children inherit that exact revision - so
**validate changed behaviour in a new session**.

## Create a preset

Write a bundle directory in the workspace with two files, then install it.

`review-preset/package.json`:

```json
{
  "name": "@local/dsh-review-preset",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`review-preset/cordis.patch.yml`:

```yaml
- insert:
    - id: preset-review
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: review
        name: Review
        description: Reviews changes with the shell only.
        order: 10
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: You review software changes.
          - id: tool-bash
            name: '@deepseek-ai/dsh-tool-bash'
```

Install with `plugin_manager`, `action: install_bundle`, `target` set to the absolute
bundle directory. It runs package installation and bundle selection itself; do not
reproduce those steps with shell commands.

A preset that ships skills or other assets puts them in the bundle directory and points
a skill provider at that directory from inside its own child list - a skill file inside
a preset directory is not discovered by itself.

## Change a preset

**A preset you ship:** override the declaration by its Loader row id instead of
inserting. The override replaces the complete `config`, so restate `id`, `plugins` and
every other field the original carries:

```yaml
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    order: 1
    plugins:
      # the shipped list with your changes
```

A truthy `name` on such a row **asserts** the existing plugin name; it does not rename
the row.

**A shipped preset:** never edit the deployment's own patch in place - an upgrade
overwrites it. Copy what you need into your own declaration and override.

In a Desktop or Web UI that offers an agent-preset editor, that editor changes only the
child plugin list and writes the profile's user patch, preserving display metadata and
unrelated configuration. It is a convenient way to tune a preset for yourself and is not
a substitute for a bundle when you are shipping one to someone else.

The patch dialect over those declarations, the row fields an insert or an override writes,
and the realm and one-plane rules that decide whether a row mounts once or twice, are in
`references/patch-layers.md`.

## Verify it landed

1. `plugin_manager`, `action: list_bundles`: the bundle is listed.
2. `plugin_manager`, `action: list_plugins`: the `preset-<id>` row is present with its
   activation state. A declaration whose activation failed stays on the roster with its
   diagnostic and cannot compose a session until the bundle is fixed and reinstalled.
3. Read the roster as a client sees it: rows carry `id`, `isDefault`, and optional
   `name`, `description` and `broken`. There is no other field - no trust flag, no path.
4. **Open a new session.** The picker lists the preset by its `name`, and existing
   sessions and their children keep the revision they started with.
5. Exercise one capability per row that matters: call a tool, load a shipped skill,
   trigger a prompt contribution.

Installing a bundle executes plugin code in the Host process, so it requires full access
or approval. `Config.listConfigs` queried with a `preset-<id>` row's `entry` id returns
the `packageDir` the declaration came from, which is the fastest way to read the
declaration you are actually running.
