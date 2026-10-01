# Installing and composing

How a plugin gets into a profile, and what a composition row actually means.

## Getting one into a profile

A **bundle** is a package whose `package.json` declares `dsh.bundle.patch`; each patch
file is a layer over the entry lists.

```json
{
  "name": "@local/my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

```yaml
- insert:
    - id: my-plugin
      name: '@local/my-plugin'
      config: {}
```

Install it with `plugin_manager`, `action: install_bundle`, `target` set to the absolute
package directory. It performs package installation and bundle selection itself - do not
reproduce those steps with shell commands, and do not hand-write the profile's
`package.json` or patch file.

- `list_plugins` and `list_bundles` return exact identifiers for existing installs;
  `set_plugin` and `set_bundle` toggle them; `remove_bundle` removes one.
- The **`application` and `warnings` fields decide whether the change is live**. Logs,
  terminal output and process lists do not. `failed` needs diagnosis, `overridden` means
  a higher-priority layer wins, `restart-required` means it is not live yet.
- Installing a new bundle can activate through HMR. Replacing an installed package needs
  a restart to load a fresh JavaScript module generation.
- The profile's patch layer reloads immediately. A plugin's own `config` is read at
  mount, but a change confined to declared-volatile values commits into the running
  fiber without a remount.
- Installing a bundle executes Host code, so it requires full access or approval, and
  `approvedBuilds` is passed only after the user explicitly approves those scripts.
- Prefer `cordis_inspect_query` for confirming a row: it needs no approval, whereas
  every `plugin_manager` action does without full access.

## Finding the API

`cordis_inspect_query` is the first source, and the one that needs no approval.
`references/plugins.md` gives the order to consult after it, and how to read an installed
package's own documentation and types.

## Composition rules that decide whether a row mounts

- **`id` is a stable identity.** Without it a row gets a generated id on every read, so
  any config edit counts as removal plus addition and remounts the plugin. Always set it.
- **`name` is a module specifier.** Inside a composition the base URL is the composition
  file's own directory: a relative specifier resolves against it, a bare package name
  against the installation, an absolute path becomes a file URL. In a patch layer an
  **inserted** relative name is anchored beside the patch file instead.
- **`config:` replaces the whole value per layer.** When you override a row, restate
  every key it needs; dropping one does not merge, it removes.
- **`disabled: true` keeps the row and skips mounting it**, and `disabled: !!js <expr>`
  is evaluated against the loader context at every mount decision. Gate a
  platform-specific row this way rather than shipping a row that fails to mount
  elsewhere.
- **`!!js` is allowed only inside `config` and in a row's `disabled`.** Every other row
  field stays literal, so an expression there is silently truthy data rather than an
  error. In `config` the expression runs against the **row's own plugin context, after
  that row's declared injections activate**, so services and `ctx.get(...)` are
  reachable; builtins come through `process.getBuiltinModule('node:...')`. A throwing
  expression breaks the whole mount, so keep these trivial.
- **Scope and `isolate` are different things.** Scope controls contributions and event
  visibility; `isolate` controls service instances. `isolate: { <service>: true }` gives
  the row an entry-local realm; `isolate: { <service>: '<label>' }` joins a named realm
  shared by every row using that label. A preset row that publishes a process-global
  service is refused with `Preset services require isolate realms: <names>` - isolate the
  provider and all its consumers together, or move the row to the host composition.
- **A provider name is unique per registry and per scope.** There is no harness-wide
  shadowing and no "last registration wins": the registry that owns the name raises on a
  duplicate. To filter a provider, wrap it in one row rather than mounting a second.
- **`group: true` with `name: cordis:group`** makes `config` a nested entry list;
  `cordis:include` loads a literal entry list from `config.path`.
- **One row, one plane.** A row active in both the host composition and a preset mounts
  twice - once per process, once per session - and neither failure shows up in a tool
  catalog.

`DSH_PROFILE` (the profile name) and `DSH_PROFILE_DIR` (its directory, whose
`node_modules` holds only profile-installed bundles) are set in every shell call of a
profile-launched harness. With `dsh` on the PATH,
`dsh --profile "$DSH_PROFILE" --dump-config` prints the composed profile.

## Pin a floor, then read the truth from disk

Examples are written against the version their author had. Treat these as floors:

| Component | Known-good floor | Why the floor exists |
|---|---|---|
| Node | 22.19 | `process.getBuiltinModule` and other modern builtins |
| `@deepseek-ai/cordis` | 4 | service and effect semantics |
| `@deepseek-ai/schemastery` | 3 | the validator contract behind `Config` |
| the `@deepseek-ai/dsh-*` packages | the runtime's own version | the plugin API matches the harness that loads it, not an independent line |

The last row is the one that bites: dsh packages are released together, so a plugin
written against one harness version can fail on another with a missing method rather than
a clear error.

```sh
node -p "require('@deepseek-ai/dsh-tools/package.json').version"
node -p "process.version + ' getBuiltinModule=' + typeof process.getBuiltinModule"
```

- **Smoke-test before writing a real plugin**: import the module, register one trivial
  tool or listener, and confirm the registration landed.
- **Check the peer requirements in `package.json`** before assuming a dependency is
  available; the installation supplies a subset, and what one profile has another may
  lack.
- Record the versions in whatever the reader will rerun, so a later failure can be traced
  to a dependency change rather than to the plugin logic.

## When it mounts but does nothing

- **PENDING, not broken.** A plugin whose `inject` names a service no row provides waits
  forever and contributes nothing, silently. Inside a session you may have no way to
  enumerate components, so read what you can: a missing tool, a prompt section that never
  appears, an absent catalog entry. A preset row in this state does surface it - its
  `broken` reason reads `waiting for <service>`.
- **An unresolvable specifier is reported, not silent.** The row does not load and the
  preset does not compose; the verdict names the row and the specifier it could not
  resolve.
- **An `apply` that throws fails the load loudly**, and an invalid `config` fails it
  before `apply`; both refuse the mount rather than half-mounting it, and the refusal
  names the rows that did not activate.
- **A filter that runs after registration** can still remove a contribution from what the
  consumer receives; compare what you registered against what the consumer got.
- **A file swap is not a reload.** Replacing the module behind an already-loaded row
  changes nothing until the process restarts.
