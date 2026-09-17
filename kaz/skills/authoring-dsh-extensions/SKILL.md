---
name: authoring-dsh-extensions
description: Use when writing, changing, wiring, verifying or shipping anything that extends the harness itself - a SKILL.md, a plugin module exporting name/inject/apply, a config schema, a model-facing tool, an agent preset's directory and composition rows, or a skill or asset that must travel with a preset. Also when one of those is in place but contributes nothing.
user-invocable: false
---

# Authoring DSH extensions

Three things extend the harness: a **skill**, a lazily loaded instruction pack; a **plugin**, a module
that contributes a tool, prompt text, or a service; and a **preset**, a directory that decides which
plugins one session gets alongside a persona. One craft, worked at three scales, and the same
asymmetry runs through all of it - a skill's `name` and `description` sit in the model's catalog every
turn while its body waits to be loaded, a plugin contributes nothing until a row mounts it, a preset
does nothing until someone selects it.

What follows is what each of the three is, what makes it mount, and how to verify it landed. One rule
spans all three, so it lives here rather than in three places: **read the contribution back from the
running system, through the same seam the model sees.** Loading the file yourself proves it parses;
your own module import proves it was written; only the running system proves the row mounted and the
contribution arrived. A missing tool, an absent prompt section, a catalog entry that is not there -
each is evidence that something did not land.

## Writing a skill

A skill is a directory bundle, or a flat file, under a skills root:

```
<skills-root>/<kebab-name>/SKILL.md      # directory bundle
<skills-root>/<kebab-name>.md            # flat entry
```

Discovery is **one level deep**: a nested `**/SKILL.md` is not found.

Frontmatter is YAML with two required keys:

```yaml
---
name: kebab-case-name
description: Use when ... - the situation, the symptoms, the phrasings a request might use.
---
```

- `name` must match `^[a-z0-9]+(?:-[a-z0-9]+)*$` and should equal its directory name.
- A missing or empty `name`/`description` makes the provider **warn and skip the file** - the skill
  simply does not exist, with no error at the call site.
- Optional keys: `whenToUse`, `metadata`, `disable-model-invocation`, `user-invocable`. The last two
  default to true. Use the kebab-case spellings; camelCase variants are rejected.
- `whenToUse` is registered but **does not reach the model catalog**: writing it adds nothing the model
  can match on. Put the trigger condition in `description`, where the model actually reads it.

**The catalog carries `name` and `description` and nothing else** - no body, no paths, no tags - so the
description is the only thing a reader has when deciding whether to load the skill. It is **truncated**
when it overflows: cut and marked with a literal `...`, never dropped. The limit is a configured number
(`catalogDescriptionMaxLength`, 500 by default), so keep to one sentence a stranger could match a
request against and check the number rather than assuming it.

Write the body as Markdown for the model: a `# Title` and a short orientation paragraph, then one
concern per `##` section; two heading levels are enough. State exact commands, real paths, and short
examples instead of describing them. Push long detail into a `references/<topic>.md` beside `SKILL.md`
and link it relatively - the loader resolves paths against the skill directory. Write current-state
imperative prose: a skill is an instruction, not an essay, so no reasoning transcripts, no restated
rationale, no metaphors.

### When a skill is the wrong artifact

Write one when the capability is **used repeatedly but not needed every turn**, and when its
description can name a situation the model will recognize. Writing it costs nothing until load. Do
not write one when:

- It belongs in a persona or system prompt. Text needed on *most* turns belongs to the always-on
  prompt; duplicating it in a skill creates drift between two copies.
- It is a fact about this machine or this repository. Those belong in memory, which is searched at
  the moment of need and costs nothing when unused.
- It is a one-off task. A skill occupies a catalog line in every session it is installed in; that cost
  is only repaid by a task that comes back.

### What makes a skill mount

Roots are ranked and **the nearest wins a duplicate name**, so a user's own copy overrides the shipped
one. A representative order, lowest number first:

| Rank | Root | Who puts skills there |
|---|---|---|
| 100 | `<project>/.dsh/skills` | the project, private to it |
| 200 | `<project>/.agents/skills` | the project, in the shared agent convention |
| 300 | configured extra directories | an extension that ships its own |
| 400 | `<DSH_HOME>/skills` | the user, across projects |
| 500 | `<agents home>/skills` | the user, shared across agent tools |
| 600 | a configured bundled root | the deployment |

The project root is the nearest ancestor containing `.git`; without one, the working directory. Rank
300 is the seam an extension uses to ship skills, and it deliberately outranks the user roots so that a
shipped skill is present by default while still being overridable at the project level.

A skill file sitting inside an extension or preset directory is **not** discovered by itself: the
discovery provider only scans its configured roots, so the loading composition has to be pointed at the
shipped directory - see the skills row under "Composition ground rules" below.

## Writing a plugin

Every capability in the harness is a Cordis plugin: a module exporting `apply(ctx)`, plus optional
`name`, `inject`, and `Config`. A composition file decides which plugins are composed. There is no
bootstrap code and no separate configuration language.

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

A module exporting `apply` is a complete plugin; it needs no package to be loaded. `inject` holds the
plugin in PENDING until every named service exists, so `ctx.tools` is ready inside `apply`.
Registration is an effect: unloading the plugin unregisters the tool. Use the object form
(`export default { name, inject, apply }`) or a `Service` subclass only when the plugin *provides* a
service.

### Borrow services from ctx

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

### Put text in front of the model mid-turn

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

### Register a model-facing tool

- `name` - kebab-free snake_case by convention. The shipped tools use it (`read`, `web_search`,
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

### Declare a Config schema

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

## Writing an agent preset

An agent preset is a directory the harness discovers, containing a metadata file and a composition of
plugin rows:

```
<source>/<preset-id>/
  preset.yml          # how the picker lists it
  agent.cordis.yml    # what the session gets
  ...                 # anything the rows reference: modules, skills, assets
```

Placement decides who sees it. A preset directory may be shipped with the deployment, kept in the
user's preset root, or kept inside a project. A roster row read from outside the host is **path-free by
design** - it carries an id, a trust, a name, a description, whether the preset is the default, and a
`broken` reason when it cannot compose - so the composition's location stays the host's own and you
take the path you are editing from the home you are working in, not from the roster. Never edit a
shipped preset in place, because an upgrade overwrites it: to change what a shipped preset does, copy
its composition into a new preset directory and edit the copy.

### preset.yml: three fields

```yaml
name: Creation mode
description: Everything the standard agent has, plus runtime inspection and preset authoring.
order: 4
```

That is the whole accepted shape. `description` is what a person reads when choosing, so write it for
that decision - what this session can do that the others cannot. Keep the file's keys minimal: unknown
keys are ignored rather than reported, which is exactly how a setting silently does nothing.

### The persona

A preset typically replaces the deployment's persona with its own, which is also how it removes prompt
text it does not want. Two things worth knowing before writing one:

- A persona can be marked **complete**, meaning it becomes the entire system prompt: assembly still
  runs, but the registered section is restored as the only one. That is how a preset ships a
  fixed-prompt agent with exactly one tool. Use it deliberately - the trade is total control for the
  loss of every other contribution, including tool guidance.
- Prompt contributions are **assembled per step**, inside the agent loop. Most text is captured at
  registration, so an edit to a persona prefix is invisible in a running session, including the session
  that made the edit, and a restart is part of the change. But the seam is not uniformly cold: at least
  one contributor reconciles live, so a workspace-instruction file can be picked up while the process
  runs. Know which kind you are editing before you tell the reader to restart.

Cross-check the persona against what the preset actually mounts: a persona that promises capabilities
its rows do not provide is the most common way a preset feels broken.

### Make it portable

- **Refer to packages the harness installs**, not to files on your machine. A preset that works only
  where you built it is a local script with extra steps.
- **Do not assume the platform.** Gate platform-specific rows with `disabled: !!js`, rather than
  shipping a row that fails to mount elsewhere.
- **Do not assume a store, a path, or an environment variable.** Anything the rows need at runtime
  should be discoverable from the session, or set by the person installing it.
- **Make the directory answer three questions on its own.** A cold reader should be able to state,
  from `preset.yml` and the rows alone and without external notes, what the preset is for, which
  capabilities it mounts, and what it deliberately leaves out.

## Composition ground rules

Skills, plugins, and presets all meet in a composition file, so these rules decide whether any of the
three works. A host-plane row goes in the deployment's patch file; an agent-plane row goes in an agent
preset's `agent.cordis.yml`:

```yaml
- id: hello
  name: dsh-hello-plugin
  config:
    greeting: Hello

- id: optional-row
  name: '@deepseek-ai/dsh-tool-extra'
  disabled: !!js process.platform !== 'win32'

- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs:
      - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"
```

- **`id` is a stable identity.** Without it a row gets a generated id on every read, so any config
  edit counts as removal plus addition and remounts the plugin. Always set it.
- **`name` is a module specifier.** Inside a composition the base URL is **the composition file's own
  directory**: a relative specifier resolves against the preset directory, a bare package name against
  the harness installation, an absolute path becomes a file URL. A `--patch` overlay anchors
  differently - a relative name there resolves **beside the patch file**, not against the process
  working directory - so the two anchoring rules are different and worth stating explicitly.
- **`config:` replaces the whole value per layer.** When you override a row, restate every key it
  needs; dropping one does not merge, it removes.
- **`disabled: true` keeps the row but skips mounting it**, and `disabled: !!js <expression>` is
  evaluated against the loader context at every mount decision.
- **A plugin's own relative config path does not resolve against the composition.** Plugins that call
  `path.resolve()` anchor on the process working directory, so a literal `./skills` points wherever the
  process happened to start. Compute an absolute path in the composition, as the skills row above does.
- **`!!js` is allowed only inside `config` and in a row's `disabled`.** The evaluation scope is the
  loader context: `baseUrl`, `process`, and globals are reachable, while `__dirname`, `require`, and
  `module` are **not** - take builtins through `process.getBuiltinModule('node:...')`. A throwing
  expression breaks the whole mount, so keep these expressions trivial.
- **Do not widen a path to a machine-specific one.** The expression above travels: it computes the
  directory of whichever copy of the composition is running, so a test install and a production install
  each find their own skills.
- **Group with `isolate`** when a group publishes a service. Groups nest rows and load them as a unit;
  `isolate: { <service>: true }` is what keeps the second session mounting the preset from colliding on
  a process-global registration. The failure is a refused mount, not a silent collision: a row
  publishing a process-global service is rejected with an error naming the leaked services and telling
  you to use an `isolate` realm or move the row to the host composition.
- **Providers are unique by name, and a duplicate registration fails the whole mount** rather than
  overriding it. So adding the official provider row beside an existing one of the same name does not
  shadow it - and a deployment that wants to filter a provider has to wrap it in one row rather than
  mount a second one beside it. This preset is that case: it ships its own wrapper row (`skill-visibility`)
  around the official `filesystem` provider, whose own name is what a second row would collide on. Look at
  what the preset you are editing already mounts rather than assuming a recipe row is absent.

## Verify it landed

Every check here ends in the same place, and it is the rule from the top of this file: **read the
contribution back through the seam the model sees.** A session cannot see mount state, only its
effects - a tool in the tool face, a section in the prompt, an entry in the skill catalog - so read the
composition to see what should be there, then check whether each expected contribution arrived. Say
which part you could not establish rather than guessing at the cause.

**A skill.** Reading the file proves only that it was written, so check the things a loader checks:

1. Frontmatter parses; `name` matches the directory and the kebab-case grammar.
2. `description` starts with the routing phrase the convention uses ("Use when ...") and fits the
   local length bound.
3. The body is non-empty and carries the commands a reader would need.
4. The file is pure ASCII with LF endings if the rest of the repository is - mixed encodings and a
   byte-order mark are user-visible defects in a text artifact.
5. The directory contains `SKILL.md` and nothing else unless a `references/` file is genuinely needed.

Then load it through the runtime and confirm the body arrived, rather than trusting the catalog line: a
skill can appear in the catalog and still fail to load its body.

**A plugin.** Install, typecheck, lint, and run the behavior test that covers the change:

```sh
pnpm install
pnpm run typecheck
pnpm run lint
pnpm exec vitest run packages/<group>/<pkg>/tests/<behavior>.spec.ts
```

Add `--coverage --coverage.include='packages/<group>/<pkg>/src/**/*.ts'` for a behavior-bearing change.
Also available: `pnpm run test`, `pnpm run test:coverage` (the CI gate), `pnpm run test:docs`,
`pnpm run doc-sync` after docs or catalogs change, and `pnpm run build && pnpm run hygiene` when
manifests, exports, or built paths change.

For a plugin inside a preset, the loop that settles a change fastest is: edit, restart the process, then
read the feature back - a tool appears in the catalog, a section appears in the prompt, an injected
notice appears in the transcript. Configuration is read at mount, so an edit to a live process changes
nothing until it restarts.

**A preset.** Mount it and read the result back from the running session:

1. Confirm the preset is listed at all - a directory in the wrong root, or a malformed metadata file,
   simply does not appear.
2. Confirm it **mounts**. A row whose specifier cannot be resolved keeps the preset from composing at all,
   and the verdict names that row rather than showing an empty contribution; a row waiting on a service
   nobody provides stays pending instead and contributes nothing, quietly. Each expected contribution is
   the evidence you have, so check them one by one. Where the deployment reports preset state, a preset
   that cannot compose carries a `broken` reason - and a failure that reaches you as a refusal names the
   rows that did not activate, distinguishing `never started` from `waiting for <service>`. Read that
   message; it is the one mount diagnosis you can get.
3. Confirm the persona took effect and the expected prompt contributions are present.
4. Exercise one capability per row that matters: call a tool, load a shipped skill, trigger a prompt
   contribution, and check the output arrives.
5. Restart before believing any change to configuration or prompt text - both are read at mount.

## Pin a floor, then detect

The host libraries move between releases and an example is only ever written against the version its
author had. Treat these as **floors known to work**, not as what is installed here, and let the
runtime report the truth:

| Component | Known-good floor | Why the floor exists |
|---|---|---|
| Node | 22 | `process.getBuiltinModule` and other modern builtins are absent before it |
| `@deepseek-ai/cordis` | 4 | service and effect semantics |
| `@deepseek-ai/schemastery` | 3 | the validator contract used by `Config` |
| the `@deepseek-ai/dsh-*` packages | the runtime's own version | the plugin API matches the harness that loads it, not an independent line |

The last row is the one that bites in practice: dsh packages are released together, so a plugin written
against one harness version can fail on another with a missing method rather than a clear error. Match
the runtime, and read the version from disk instead of recalling it:

```sh
node -p "require('@deepseek-ai/dsh-tools/package.json').version"
node -p "process.version + ' getBuiltinModule=' + typeof process.getBuiltinModule"
```

Then:

- **Smoke-test before writing a real plugin**: import the module, register one trivial tool or
  listener, and confirm the registration landed. A missing export or a changed signature shows up in
  seconds instead of inside a hundred-line plugin.
- **When an attribute is missing, enumerate the object** (`Object.keys`, `Object.getOwnPropertyNames`
  on the prototype) or read the installed package's own types - do not fill the gap from memory of an
  older signature. The installed package is the authority.
- **Check the peer requirements in `package.json`** before assuming a dependency is available: the
  harness installs a subset, and a package present in one profile may be absent in another.
- **Record the versions** in whatever the reader will rerun, so a later failure can be traced to a
  dependency change rather than to the plugin logic.

## When it does not appear, or mounts but does nothing

**A skill that does not appear:**

- **Wrong depth.** `skills/<name>/SKILL.md` is found; `skills/<name>/docs/SKILL.md` is not.
- **Frontmatter rejected.** A malformed or incomplete frontmatter block is skipped with a warning that
  is easy to miss at startup.
- **Root not scanned.** Verify the root the provider actually resolved - a relative path in a plugin's
  config resolves against the process working directory, so confirm the absolute path rather than the
  string you wrote.
- **Catalog not rebuilt.** Adding or editing a skill file refreshes the catalog in a live session - the
  change appears without a restart, so a skill missing from the catalog was not discovered at all. That
  is the default, not a law: the provider's `watch` option (on by default, and able to follow symlinks)
  is what makes it true, so a deployment that turns it off gets the opposite behaviour and needs a
  restart. A *newly configured root* is different: the provider is configured when the process mounts,
  so a change to `customSkillDirs` needs a restart before the new root is scanned.
- **Name collision.** A nearer root wins outright, so a same-named skill in the project's own skills
  directory shadows the shipped one - useful for overriding, confusing when accidental.

**A plugin that mounts but does nothing:**

- **PENDING, not broken.** A plugin whose `inject` names a service no row provides waits forever and
  contributes nothing. A session may offer you no way to enumerate mounted components, so read what you
  can - a tool that is absent from your tool face, a prompt section that never appears, a catalog entry
  that is missing. Those tell you the contribution did not land; "I could not see the component" is not
  "it is pending", so do not report a cause you cannot distinguish.
- **A specifier that cannot be resolved is reported, not silent.** The row does not load and the preset
  does not compose; the verdict names the row and the name it could not resolve, so a misspelled package
  or one that is not installed is what you are looking at. Before any session reads it, that verdict
  exists only as the preset's `broken` reason - which is why the roster's account of a preset is worth
  reading before you trust the preset.
- **An `apply` that throws fails the load loudly**, and an invalid `config` fails it before `apply`.
  Both fail the mount rather than half-mounting it, and the refusal names the rows that did not
  activate - distinguishing `never started` from `waiting for <service>`. That message is the one mount
  diagnosis available, though it arrives at whoever attempted the mount, which may not be you.

**A preset that is wrong:**

- **Preset absent from the list**: wrong directory, unreadable metadata, or a mount failure that
  prevented the roster entry.
- **Mounts but behaves like the default**: the persona row did not take effect, or the preset's rows
  registered into a scope that the session does not use.
- **A row contributes nothing**: specifier misspelled, package not installed, or waiting on an unmet
  dependency. Silent by design - check these three before reading the plugin.
- **Works for you, not for someone else**: an absolute path, a machine-specific package, or an
  unguarded platform assumption.

Mount state, hook timing, and counter or tracker misbehaviour are a separate skill's territory: when
the contribution is not the problem but the moment it arrives is, `diagnosing-agent-extensions` carries
those techniques.
