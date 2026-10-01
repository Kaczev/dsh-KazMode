# State roots and message delivery

The two seams where a correct-looking change lands in the wrong place: a write that goes
to a different store than you assumed, and text that reaches a different request than you
intended.

## Shape 4: the write landed somewhere else

Storage keyed by root produces "the data is wrong but the code is right". Start from the
shape this harness has, which is **not** two roots resolved by two different rules:

- **One home, resolved from the environment**: `$DSH_HOME`, else `~/.dsh`. A second
  environment-resolved home holds shared agent configuration: `$DSH_AGENTS_HOME`, else
  `~/.agents`. Profiles are subdirectories of the same home.
- **A store's root is explicit and required.** Storage backends take a `root` with
  deliberately **no** working-directory fallback, because that would scatter data. The
  session store's root is a fixed path under the home, *keyed by* the working directory
  into project and session subdirectories - a labelling scheme, not a second root.
- **Working-directory defaults exist for the working tree** - file access and the sandbox
  base - not for a store.

So:

- **Prove the landing point, not the intent.** Print the resolved absolute path before
  writing, and read the file back from the consumer's path.
- **Check for a second copy.** The same logical store may exist per home or per profile,
  and a write to one is invisible from the other. Two harnesses pointed at different homes
  is the usual cause.
- **A write that landed in the working directory is a caller bug**, not a fallback: some
  relative path was passed into a required root.

## Shape 5: text delivered to the wrong request

- **Appended, not replacing.** An injected message is added to what the next request
  carries; it does not overwrite earlier context, and repeated injection accumulates.
- **Not a wake-up.** Injecting context into an idle agent leaves it idle; something has to
  start a turn.
- **Per-step versus per-turn.** A contribution intended for one step belongs in the
  per-step seam; put it in the per-turn path and it reappears every turn.
- **A published context is a durable snapshot**, not a per-turn value: it stays until
  something replaces it. Reaching for it when you wanted one agent or one moment is a
  common mismatch.
- **Two rendering paths.** Prompt text and runtime context are separate seams with
  separate ordering tables. Placing a contribution in the wrong seam puts it in the wrong
  part of the model input - it looks like an ordering problem, but the cause is the seam.
