---
name: authoring-agent-presets
description: Use when creating, changing, or validating an agent preset - the directory, its metadata, the composition that decides which plugins one session gets, a persona that replaces the deployment default, a skill that must travel with it, or when a preset does not appear in the picker or mounts but behaves like the default.
---

# Authoring agent presets

An agent preset is a directory the harness discovers, containing a metadata file and a composition of
plugin rows. Mounting it gives one session its tools, persona, and prompt contributions. Everything
below is about making a preset that mounts on someone else's machine, not just yours.

## The directory

```
<source>/<preset-id>/
  preset.yml          # how the picker lists it
  agent.cordis.yml    # what the session gets
  ...                 # anything the rows reference: modules, skills, assets
```

Placement decides who sees it. A preset directory may be shipped with the deployment, kept in the
user's preset root, or kept inside a project; the roster reports each preset's real path, so take the
path you are editing from there rather than assuming. Never edit a shipped preset in place - an
upgrade overwrites it. To change what a shipped preset does, copy its composition into a new preset
directory and edit the copy.

## preset.yml: three fields

```yaml
name: Creation mode
description: Everything the standard agent has, plus runtime inspection and preset authoring.
order: 4
```

That is the whole accepted shape. `description` is what a person reads when choosing, so write it for
that decision - what this session can do that the others cannot. Keep the same file's keys minimal:
unknown keys are ignored rather than reported, which is exactly how a setting silently does nothing.

## agent.cordis.yml: rows, not code

```yaml
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs:
      - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"
```

Rules that decide whether a preset works:

- **`id` is a stable identity.** Without it a row gets a generated id on every read, so any edit to
  the file counts as remove-plus-add and remounts the plugin. Always set it.
- **`name` resolves against the composition's own directory.** A relative specifier is a file beside
  the composition; a bare package name resolves from the harness installation. A `--patch` overlay is
  the exception and must use an absolute path.
- **`config:` replaces the whole value per layer.** When you override a row, restate every key it
  needs; dropping one does not merge, it removes.
- **`disabled: !!js <expression>`** is allowed on a row, and evaluated against the loader context at
  every mount decision. `baseUrl`, `process`, and globals are reachable; `__dirname`, `require`, and
  `module` are not - take a builtin through `process.getBuiltinModule('node:...')`. A throwing
  expression breaks the mount, so keep these trivial.
- **A plugin's own relative config path does not resolve against the preset.** Plugins that call
  `path.resolve()` anchor on the process working directory. Compute an absolute path in the
  composition, as the skills row above does.
- **Group with `isolate`** when a group publishes a service; otherwise a second session mounting the
  same preset collides on a process-global registration.

## The persona

A preset typically replaces the deployment's persona with its own, which is also how it removes prompt
text it does not want. Two things worth knowing before writing one:

- A persona can be marked **complete**, meaning it becomes the entire system prompt: assembly still
  runs, but the registered section is restored as the only one. That is how a preset ships a
  fixed-prompt agent with exactly one tool. Use it deliberately - the trade is total control for the
  loss of every other contribution, including tool guidance.
- Prompt contributions are **assembled when the process starts**. An edit to a persona or any injected
  text is invisible in a running session, including the session that made the edit. A restart is part
  of the change.

Cross-check the persona against what the preset actually mounts: a persona that promises capabilities
its rows do not provide is the most common way a preset feels broken.

## Ship skills and assets with the preset

Files inside the preset directory are **not** discovered by themselves. The provider has to be pointed
at them, and the pointer must be absolute, computed from `baseUrl` (see the row above). This is the
difference between "the file is in my preset" and "the session can see it".

## Make it portable

- **Refer to packages the harness installs**, not to files on your machine. A preset that works only
  where you built it is a local script with extra steps.
- **Do not assume the platform.** Gate platform-specific rows with `disabled: !!js`, rather than
  shipping a row that fails to mount elsewhere.
- **Do not assume a store, a path, or an environment variable.** Anything the rows need at runtime
  should be discoverable from the session, or set by the person installing it.
- **Make the directory answer three questions on its own.** A cold reader should be able to state,
  from `preset.yml` and the rows alone and without external notes, what the preset is for, which
  capabilities it mounts, and what it deliberately leaves out.

## Verify a preset

Mount the preset and read the result back from the running session:

1. Confirm the preset is listed at all - a directory in the wrong root, or a malformed metadata file,
   simply does not appear.
2. Confirm it **mounts**. A row that cannot resolve its specifier is logged, not thrown, and a row
   waiting on a service nobody provides stays pending forever with no error at the call site. Enumerate
   the loaded fibers rather than assuming.
3. Confirm the persona took effect and the expected prompt contributions are present.
4. Exercise one capability per row that matters: call a tool, load a shipped skill, trigger a prompt
   contribution, and check the output arrives.
5. Restart before believing any change to configuration or prompt text - both are read at mount.

## When something is wrong

- **Preset absent from the list**: wrong directory, unreadable metadata, or a mount failure that
  prevented the roster entry.
- **Mounts but behaves like the default**: the persona row did not take effect, or the preset's rows
  registered into a scope that the session does not use.
- **A row contributes nothing**: specifier misspelled, package not installed, or waiting on an unmet
  dependency. Silent by design - check these three before reading the plugin.
- **Works for you, not for someone else**: an absolute path, a machine-specific package, or an
  unguarded platform assumption.
