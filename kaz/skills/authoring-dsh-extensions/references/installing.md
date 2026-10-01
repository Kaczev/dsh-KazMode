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

What makes a row mount, and where to find the API, are in `references/composition.md`: the
per-field rules for `id`, `name`, `config`, `disabled`, `!!js`, scope, `isolate`, `group`
and the one-plane rule, and the inspect-first order for finding the API.
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
