# Plugins

Every capability in the harness is a Cordis plugin, and a composition row decides
whether it is composed. There is no separate configuration language. (The deployment
composes its own root rows in code; a plugin you write never needs bootstrap code of its
own.)

This file covers writing the module. Bundles, `plugin_manager`, row semantics, version
floors and mount troubleshooting live in `references/installing.md`.

## What a plugin is

`index.js` exports one of two forms, and does not mix them:

- `export function apply(ctx, config) {}` with optional `export const name`,
  `export const inject = ['tools']`, and `export const Config`.
- A `Service` subclass as the default export, when the plugin **provides** a service.

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

A module exporting `apply` is a complete plugin; it needs no package to be loaded.
Registration is an effect: register inside `apply` with `ctx.on` or `ctx.effect`, and the
registration goes away when the plugin unloads. `inject` holds the plugin in **PENDING**
until every named service exists, so `ctx.tools` is ready inside `apply`; reach an
optional service with `ctx.get('fs')` so the plugin mounts as a no-op where no provider
exists.

## Find the API before writing

1. **Inspection.** `cordis_inspect_list`, then targeted `cordis_inspect_query` calls:
   exact Service methods and Event modes, a mounted plugin's Config JSON Schema
   (`Config.listConfigs`, filtered by `name`, then queried by `entry` id), the tools
   this agent can call, and live Client Slots and theme tokens.
2. **Package documentation.** `Config.listConfigs` returns a `packageDir`; read
   `<packageDir>/README.md`. Bundled packages resolve from the installation and
   profile-installed bundles from the profile, so never guess the path.
3. **Source.** Installed packages ship built `lib/index.js` and `lib/types/**/*.d.ts`
   under that same `packageDir`; a DSH source checkout has
   `packages/<group>/<name>/src`.

When an attribute looks missing, enumerate the object or read the installed types. Do not
fill the gap from memory of an older signature - the installed package is the authority.

## Declare a Config schema

The harness uses Schemastery. Export an interface and a runtime schema under the same
name; a plain object exported as `Config` does not work.

```ts
import z from '@deepseek-ai/schemastery'

export interface Config { greeting: string; targets?: string[] }

export const Config: z<Config> = z.object({
  greeting: z.string().required(),
  targets: z.array(z.string()).default(['world']),
})
```

`.default(...)` fills missing keys, so `apply` always receives complete validated config.
A bad value fails the load **before** `apply` runs and reports the offending path:

```
ValidationError: invalid config:
  - $.targets expected array but got not-an-array (at targets)
```

## Borrow services from ctx

Add every service you touch to `inject`.

| Service | Use it for |
|---|---|
| `ctx.logger` | `warn` / `info` diagnostics |
| `ctx.tools` | Register a model-facing tool; `restrict()`, `guard()`, `get()` |
| `ctx.systemPrompt` | `section()` for system-prompt text, `context()` for model context |
| `ctx.agents` | Reach a live agent; `followup()` to start a turn, `steer()` to redirect one, `inject()` to queue context |
| `ctx.sessions` | Read or create durable session state |
| `ctx.fs` | File access through the policy seam |
| `ctx.settings` | Validated user settings |
| `ctx.jobs` | Background jobs |

## Two prompt seams, different consumers

- `ctx.systemPrompt.section({ name, order, text })` renders into the **system prompt**.
- `ctx.systemPrompt.context({ name, order, text })` publishes a **durable user-role
  snapshot** that supersedes earlier snapshots. It is not a per-turn value: it stays until
  something replaces it, and a deployment can suppress it wholesale.

Their order tables are separate (`SECTION_ORDERS` vs `CONTEXT_ORDERS`), so pick the seam
first and the number second. `interpolate: false` preserves literal text. For context that
belongs to one agent or one moment, use `agent.inject()` below rather than the context
seam.

The tool a plugin registers, and the text it puts in front of the model mid-turn, are in
`references/tool-surface.md`: the field-by-field tool definition, the policy hooks around
`execute`, and `agent.inject`.

## Dynamic plugins

The extensions subsystem can define, run, inspect and retract plugin packages **at runtime
from a session**, with their own approval and lifecycle. That is a different mechanism
from authoring files in a bundle: reach for it when the capability is per-session and
disposable, not when it should survive a restart for everyone.

## The browser half, and MCP

A package can carry a Client half: declare `dsh.client` in the manifest and export
`./client`. A package that exports `./client` without declaring `dsh.client`, or the
reverse, has a half that is never served. Client code contributes slots - query the live
slot tree and the registration options through the Client inspect provider instead of
guessing the shape, and use theme tokens rather than hard-coded colors. An MCP server can
be connected through a configuration-only bundle, with no plugin code at all.
