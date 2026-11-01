# Provider adaptation notes

Read only when developing an LLM adapter, SDK transport or image channel. These notes come from Cursor provider development; recheck SDK and DSH fields against the target version.

## Catalogs, configuration and switching latency

- Separate the account's available-model catalog from the models the user chooses to display. Preserve an explicitly empty list; do not restore the entire catalog on `length === 0`. When supporting legacy string IDs, retain fields from newer object entries.
- A local name and context budget do not prove account access or upstream parameter support. Validate parameter combinations and include the complete variant in cache identity.
- Model selection, capability resolution, titles and compression can all query the catalog. Do not fetch on every metadata lookup. Give the account catalog a bounded cache, invalidation rules and explicit refresh. Measure request counts before claiming a speedup.
- Isolate caches by credential identity without recording raw Keys. Bound them, make them clearable and return copies. Caching cannot remove first-load or expiry latency. Design concurrent deduplication and cancellation separately so one caller's cancellation does not cancel other callers.
- Explicitly reject temperature, maxTokens and stop when the SDK does not expose them, or implement them through a verified interface. Never silently ignore them. A context budget is host configuration; it does not enlarge the server's context window.

## Streaming content

- Token deltas for a continuous text segment should share a content block. Creating a block for every delta may make the host display one token per line. Close the current block only on a text/reasoning transition, a tool block or a terminal state.
- Emit exactly one finish per stream, with usage before finish and no content afterwards. Use structured failure for errors and cancellation. Raw SDK errors may contain credential-bearing URLs; never display or log them directly.
- Parse explicit tool protocols across chunks and validate names, JSON and argument schemas. Ordinary text such as "I will read the file" is not a tool call. Fail closed on unknown calls, truncated JSON and unexpected native tool channels.
- Preserve DSH execution and approval authority. An SDK custom-tool callback that executes host tools directly may bypass host approval. Do not outsource the whole task to another autonomous agent and present it as a model adapter.

## Images and input types

- Understand the host's `inputModalities` projection semantics first. Explicitly excluding `image` may cause the host to replace images with text placeholders; leaving it undeclared does not mean text-only. If the SDK catalog has no vision field, keep capability unknown and allow user declarations rather than marking every model as vision-verified.
- Preserve the official input-type control's behavior: text and images are selectable, with at least one retained. Do not force text on or remove user control after enabling images. An `image`-only declaration does not authorize the adapter to strip system and tool-protocol text.
- Define the fallback for existing undeclared models so a UI save does not accidentally disable images that already worked. Match official defaults for new models. Keep actual configuration fields, list metadata and exact-model resolution consistent.
- Validate and read images through the DSH attachment service; do not construct file paths from attachment IDs. Keep existing offload markers as text instead of uploading again. Support images in tool results, not only in the latest user message.
- If an SDK send accepts only a separate images array, retain positions in JSON history and map images by explicit indexes. This is a message-association convention, not native multi-turn multimodal history. Verify multiple images and historical images live.
- Select the normalized image or request variant under host policy, keeping dimensions, MIME and bytes consistent. Do not embed base64 in text history or logs. Do not invent image budgets or billing figures when unknown.

## Lifecycle and cost

- send, stream pull and wait may all block; timeouts must cover the entire operation. Give cancellation, unload and late-result cleanup a single owner to prevent double dispose and leaks.
- Disable SDK built-in tools, MCP and environment-settings import, and use an isolated cwd/store. A temporary directory is not an OS security sandbox. Verify whether the public API really disables execution; prompts alone cannot guarantee it.
- A fresh agent per turn is simple and isolated, but resending the entire history costs more. Before reusing agents, cover history rewriting, compression, system/tools changes, Key/model changes, auxiliary calls, concurrency and failure invalidation.
- Cumulative input across internal model turns is billable usage, not the size of one context. Keep per-turn size unknown when no per-turn data exists. Do not add hidden corrective input or internal retries; model input must be reconstructible from host logs.
- Live smoke tests require explicit paid-call authorization. Do not reuse Keys from old chats or put Keys in scripts, command lines, repositories or logs. Run only a few tests within the agreed scope and record tested and untested cases.

## Common regression cases

- Continuous text without extra newlines; every possible tool-JSON chunk split; invalid names and schemas.
- Empty catalogs, duplicate model IDs and round-trip saves of user names, budgets and input types.
- Account switching, catalog expiry and refresh, no cache refill after cancellation, and no caching failures as success.
- Single, multiple, repeated and tool-result images; offload, read failure and cancellation.
- send/pull/wait timeouts; exactly-once cleanup of agents/runs arriving after unload.
- Finish by checking real host projection and page interactions. Successful mock forwarding proves mapping, not that the model understands images.
