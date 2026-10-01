# The model-facing surface

Two ways a plugin changes what the model sees without going through a prompt: the tool it
registers, and the text it queues mid-turn.

## Register a model-facing tool

`defineTool` comes from `@deepseek-ai/dsh-tools`; `ctx.tools.register(definition)` returns
the disposer that unregisters it.

- `name` - snake_case by convention. The registry enforces no name grammar, but it
  **reserves `run_code`** and rejects a duplicate name. PTC bindings address a plain name
  as `tools.<name>(args)`, so a hyphenated name needs subscript access instead.
- `description` - what the model reads to decide whether to call it.
- `parameters` - the DSL spec; `required: true` marks a required key. Arguments are
  validated before `execute` runs.
- `output.schema` - one canonical JSON value; return only that value, never content
  blocks.
- `output.render(args, value)` - the model-facing content.
- `execute(args, exec)` - honor `exec.signal`.
- `presentCall` / `presentResult` - optional card presenters, replayed from the session
  log, so they must be pure: no I/O, clock or randomness.
- Also available: `output.presentationMeta`, `deferLoading`, `timeoutMs`,
  `isConcurrencySafe`, `projectContent`, `finalizeContent`.

A thrown error or a value failing `output.schema` becomes an error result and does not end
the turn. Keep policy out of the tool body: `tools/pre-execute` decides allow/deny/ask,
`ctx.tools.guard()` adds a final deny evaluated after it, `tools/post-execute` may replace
a result, and `tools/result` observes the frozen one.

## Put text in front of the model mid-turn

`agent.inject(message)` queues context for the next pre-step. It takes a complete
`UserMessage`, not a plain object:

```ts
import { createUserMessage } from '@deepseek-ai/dsh-llm'

agent.inject(createUserMessage({
  content: [{ type: 'text', text: 'file changed: a.ts' }],
  source: { kind: 'plugin', plugin: 'watcher' },
}))
```

It is not a wake-up: an idle agent stays idle, so pair it with `followup()` when the agent
must act. The `kind: 'plugin'` source keeps injected text distinguishable from real user
input - do not inject as a user message. To add text to **one step only**, return a
decision from the `agent/pre-step` waterfall and push onto `decision.messages`.
