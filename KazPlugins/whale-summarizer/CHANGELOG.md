# CHANGELOG — whale-summarizer

## v0.1.0 (2026-09-05)

- New Kaz-only Cordis plugin (initially private under KazPrivatePlugins;
  formalized under KazPlugins on 2026-09-05).
- Internal `ctx.provide("whaleSummarizer")` service; no model-visible tool,
  no prompt-section injection, no RPC, no round-display write.
- `summarize({evidence, refs, purpose, opts?}, {agent, signal?})` →
  `{summary, sourceIds}`.
- Direct-children input protocol: leaf = original text, block = existing
  summary; nested/subtree/history/expanded input rejected.
- Route: requestHeader config → agent.options → agentDefaultModel.
- Reasoning explicitly `off` after capability precheck; strict failure.
- Bounded retries default 3 (opts.maxAttempts); no deterministic fallback.
- Probes: core, service (stub llm/kazMode), registration; all offline.
