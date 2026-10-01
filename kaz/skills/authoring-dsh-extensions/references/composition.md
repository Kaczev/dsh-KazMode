# Composition rules that decide whether a row mounts

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
  catalog. `references/patch-layers.md` carries the same rule for a preset row and the
  isolate realms it forces.

## Finding the API

`cordis_inspect_query` is the first source, and the one that needs no approval.
`references/plugins.md` gives the order to consult after it, and how to read an installed
package's own documentation and types.
