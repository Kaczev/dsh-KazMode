---
name: dsh-plugin-authoring
description: Use when writing, changing, wiring, configuring, verifying, or packaging a DeepSeek Harness plugin - a module exporting name/inject/apply, a model-facing tool registered through ctx.tools, a config schema, or a row in an agent preset's agent.cordis.yml - and when the plugin mounts but contributes nothing.
---

# Authoring DSH plugins

Every capability in the DeepSeek Harness is a Cordis plugin: a module exporting `apply(ctx)`, plus
optional `name`, `inject`, and `Config`. A composition file decides which plugins are composed. There
is no bootstrap code and no separate configuration language.

## Minimal plugin

A module exporting `apply` is a complete plugin; it needs no package to be loaded.

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'hello'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',
    parameters: { who: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return `Hello, ${args.who}!`
    },
  }))
}
```

`inject` holds the plugin in PENDING until every named service exists, so `ctx.tools` is ready inside
`apply`. Registration is an effect: unloading the plugin unregisters the tool. Use the object form
(`export default { name, inject, apply }`) or a `Service` subclass only when the plugin *provides* a
service.

## Borrow services from ctx

Add every service you touch to `inject`; reach an optional one with `ctx.get('fs')` so the plugin
mounts as a no-op where no provider exists.

| Service | Use it for |
|---|---|
| `ctx.logger` | `warn` / `info` diagnostics |
| `ctx.tools` | Register a model-facing tool |
| `ctx.systemPrompt` | `section({ name, order, text })` for system-prompt text; `context({ name, order, text })` for dynamic model context |
| `ctx.agents` | Reach a live agent; `followup()` to start a turn, `steer()` to redirect one |
| `ctx.sessions` | Read or create durable session state |
| `ctx.fs` | File access through the policy seam |
| `ctx.settings` | Validated user settings |
| `ctx.jobs` | Background jobs |

Two prompt seams, different consumers: a **section** is rendered into the system prompt, a **context**
into the per-turn runtime snapshot. Their order tables are separate (`SECTION_ORDERS` vs
`CONTEXT_ORDERS`), so pick the seam first and the number second.

## Put text in front of the model mid-turn

`agent.inject(message)` appends a message the next request will carry. It takes a complete
`UserMessage`, not a plain object:

```ts
import { createUserMessage } from '@deepseek-ai/dsh-llm'

agent.inject(createUserMessage({
  content: [{ type: 'text', text: 'file changed: a.ts' }],
  source: { kind: 'plugin', plugin: 'watcher' },
}))
```

It is not a wake-up: an idle agent stays idle, so pair it with `followup()` when the agent must act.
A `source` with `kind: 'plugin'` and the plugin name keeps injected text distinguishable from real
user input - do not inject as a user message.

To add text to one step only, return a decision from the `agent/pre-step` waterfall instead, pushing
onto `decision.messages`; that is how per-step notices are delivered without touching other steps.

## Register a model-facing tool

- `name` - kebab-free snake_case by convention. Every shipped tool uses it (`read`, `web_search`,
  `todo_write`), and PTC bindings address a plain name as `tools.<name>(args)`, so a hyphenated name
  needs subscript access instead. The registry enforces no name grammar; `run_code` is reserved.
- `description` - what the model reads to decide whether to call it. Write it for that decision.
- `parameters` - the DSL spec; `required: true` marks a required key. Arguments are validated before
  `execute` runs.
- `output.schema` - one canonical JSON value; return only that value, never content blocks.
- `output.render(args, value)` - the model-facing content.
- `execute(args, exec)` - honor `exec.signal`.
- `presentCall` / `presentResult` - optional card presenters, replayed from the session log, so they
  must be pure: no I/O, clock, or randomness.

A thrown error or a value failing `output.schema` becomes an error result and does not end the turn.
Keep policy out of the tool body: `tools/pre-execute` decides allow/deny/ask, `ctx.tools.guard()`
adds a final deny, `tools/post-execute` may replace a result, `tools/result` observes the frozen one.

## Declare a Config schema

The harness uses Schemastery. Export an interface and a runtime schema under the same name; a plain
object exported as `Config` does not work.

```ts
import z from '@deepseek-ai/schemastery'

export interface Config { greeting: string; targets?: string[] }

export const Config: z<Config> = z.object({
  greeting: z.string().required(),
  targets: z.array(z.string()).default(['world']),
})
```

`.default(...)` fills missing keys, so `apply` always receives complete validated config. A bad value
fails the load before `apply` runs, reporting the offending path:

```
ValidationError: invalid config:
  - $.targets expected array but got not-an-array (at targets)
```

## Wire a row into a composition

A host-plane row goes in the deployment's patch file; an agent-plane row goes in an agent preset's
`agent.cordis.yml`:

```yaml
- id: hello
  name: dsh-hello-plugin
  config:
    greeting: Hello

- id: optional-row
  name: '@deepseek-ai/dsh-tool-extra'
  disabled: !!js process.platform !== 'win32'
```

- `id` is a stable identity. Without one a row gets a generated id on every read, so any config edit
  counts as removal plus addition and remounts the plugin.
- `name` is a module specifier. Inside a composition, the base URL is **the composition file's own
  directory**: a relative specifier resolves against the preset directory, a bare package name
  against the harness installation, an absolute path becomes a file URL. A `--patch` overlay is the
  exception and must use an absolute path.
- `config:` passes the row's configuration. A later layer **replaces the whole value** rather than
  deep-merging, so an overriding row must restate every key it needs.
- `disabled: true` keeps the row but skips mounting it.
- `!!js` is allowed only inside `config` and in a row's `disabled`. The evaluation scope is the
  loader context (`options`): `baseUrl`, `process`, and globals are reachable, while `__dirname`,
  `require`, and `module` are **not** - take builtins through `process.getBuiltinModule('node:...')`.
  A throwing expression breaks the mount, so keep these expressions trivial.
- A relative directory handed to a plugin's own config does **not** resolve against the preset:
  plugins that call `path.resolve()` resolve against the process cwd. Compute an absolute path in the
  composition instead, e.g.
  `!!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"`.
- Groups nest rows and load them as a unit. Add `isolate: { <service>: true }` when a group publishes
  a service, or the second session mounting the preset collides on a process-global registration.

## Verify

```sh
pnpm install
pnpm run typecheck
pnpm run lint
pnpm exec vitest run packages/<group>/<pkg>/tests/<behavior>.spec.ts
```

Add `--coverage --coverage.include='packages/<group>/<pkg>/src/**/*.ts'` for a behavior-bearing
change. Also available: `pnpm run test`, `pnpm run test:coverage` (the CI gate), `pnpm run
test:docs`, `pnpm run doc-sync` after docs or catalogs change, and `pnpm run build && pnpm run
hygiene` when manifests, exports, or built paths change.

For a plugin inside an agent preset, the loop that settles a change fastest is: edit, restart the
process, then read the feature back from the running system - a tool appears in the catalog, a
section appears in the prompt, an injected notice appears in the transcript. Configuration is read
at mount, so an edit to a live process changes nothing until it restarts.

## When a plugin mounts but does nothing

- **PENDING, not broken.** A plugin whose `inject` names a service no row provides waits forever and
  reports nothing. Check the fiber state before debugging the plugin's logic.
- **An unresolvable specifier is logged, not thrown.** At boot that log can be lost before any
  exporter is attached, so a row that silently does nothing usually means the name is misspelled or
  the package is not installed.
- **An `apply` that throws fails the load loudly**, and an invalid `config` fails it before `apply`.
  Both surface as a failed fiber, not a partial mount.
- **Read back through the same seam the model sees.** Loading the module yourself proves the code
  parses; only the running system proves the row mounted and the contribution landed.
