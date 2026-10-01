# Patch layers, realms and planes

A profile composes an ordered list of patch layers over the bundle entry lists. Each patch
is a mapping of layer operations, and the rows it writes carry the fields below.

## The patch dialect

- **`insert: [rows]`** appends rows. With an `id` naming an existing `group: true` row,
  the rows are appended inside that group's `config` list.
- **A patch with an `id` and no `insert`** targets the existing row with that id.
  Supplied fields replace the row's fields; `config` is replaced wholesale, never
  deep-merged, so restate every field the row needs.
- **Non-insert patches without a nonempty `id`, and targets matching no row**, are
  warned about and skipped.

A row has `id`, `name` (the plugin package specifier; in a patch layer an inserted
relative path is anchored beside its patch file), and optional `config`, `disabled`,
`inject`, `intercept`, `isolate` and `group`.

- `group: true` with `name: cordis:group` makes `config` a nested entry list and lets
  other patches insert into it by id; `cordis:include` loads an entry list from
  `config.path`.
- `disabled` accepts a boolean, null, or a `!!js` expression evaluated against the
  loader context at every mount decision.
- `!!js` inside `config` is evaluated against that row's own plugin context, after the
  row's declared injections activate. Every other row field stays literal.

## Realms, scope, and the one-plane rule

- **`scope`** controls contributions and event visibility; **`isolate`** controls service
  instances. They are not the same lever.
- A preset plugin that **provides** a service must isolate the provider and every
  consumer in the same realm. `isolate: { <service>: true }` gives the row an
  entry-local realm; `isolate: { <service>: '<label>' }` joins a named realm shared by
  all rows using that label.
- A preset row that publishes a process-global service is **refused**:
  `Preset services require isolate realms: <names>`. Move the row to the host
  composition instead if its service must be shared.
- A row consumed by host plugins belongs in the host composition.
- **A row belongs to exactly one plane.** A row active in both the host composition and
  a preset mounts twice - once per process, once per session. Depending on what it does,
  a provider behind an `isolate` realm shadows the host's for its own consumers, or a
  host-singleton registration collides on the second live session. Neither changes a
  tool catalog, so no catalog assertion can see it.
