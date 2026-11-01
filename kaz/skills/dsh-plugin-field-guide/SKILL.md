---
name: dsh-plugin-field-guide
description: Practical plugin development and troubleshooting in DSH Creation Mode. Use for Cordis bundles, Host/Client plugins, configuration GUIs and model providers, or installation/UI mismatches, service injection, streaming and image support. Use with cordis-plugin-development; verify current interfaces before implementation and acceptance.
---

# DSH plugin field guide

Use this skill for plugin development in Creation Mode, as a practical supplement to `cordis-plugin-development`. Load the official development skill first when available. Otherwise, check the installed package's public documentation and interfaces, and state when required capabilities are missing. This file does not replace verification against the current version. Do not load it for ordinary plugin use, chat or unrelated coding tasks.

## Before starting

- Enter through the task handoff and repository navigation; read only relevant source. Distinguish the plugin working directory, DSH source checkout, installed runtime and current GUI URL. All four may differ.
- Establish authorization separately for development, local installation, paid calls, pushes, tags, Releases and npm publication. Development authorization does not authorize publication.
- By default, leave DSH core, built-in presets, existing configuration and user credentials unchanged. Do not reverse-engineer private protocols for SDK integration or read Keys from other applications.
- When Creation Mode provides inspect tools, obtain the Provider list first, then query the relevant Service, Event, Config and Slots. Inspect is read-only discovery, not a business service. Do not invent installation or inspect capabilities in Standard Mode.
- Locate the installed package's documentation through `packageDir` returned by `Config.listConfigs`. The same-named checkout source may differ from the running version.

## Choose an integration point

1. Prefer service registration and explicitly open slots. Distinguish additive extension areas, keyed replacement and full-page replacement. An extension area does not automatically control its parent's ordering or form permissions.
2. Before making a third-party provider match the official form exactly, check whether the form accepts third-party namespaces. Report hard-coded restrictions; do not impersonate a built-in namespace, modify another component's DOM or import private frontend modules to bypass them.
3. If no suitable entry point exists, use a maintainable alternative such as the official plugin-configuration slot. Ask the user before changing scope.
4. For UI changes, patch the existing HTML visual reference locally, then implement it in the plugin. HTML does not replace the actual plugin. Show the rendered result as required by the current session; state when rendering is unavailable.

## Host, Client and configuration

- Cordis injection must match actual service access. A past case injected only a child service such as `remote.credentials`, yet access to the root `ctx.remote` was denied. Declare the root dependency explicitly when needed, and verify it with a real Cordis contract test.
- Use the official configuration scope, revision and mutate mechanisms. Preserve unknown fields so concurrent saves cannot overwrite user changes. Configurable does not mean configured; do not bypass remote access permissions.
- Key fields are write-only: never populate them with saved values. Submit Keys to the credentials service and store only a credential reference in configuration. Key storage and configuration storage are usually separate transactions; explain recovery from partial success.
- Publication requires separate authorization. Afterwards, verify public metadata, the downloaded artifact and a clean installation. An acknowledgment does not prove consumer availability. Gather evidence after a brief lookup failure instead of publishing again immediately.
- Metadata, English and Chinese locales, icons, exports and the files list are part of delivery. Inspect the actual package with a pack dry-run; exclude tests, research downloads and secrets.
- Assign cleanup ownership for registrations, subscriptions, timers and asynchronous tasks. Check disposed state when asynchronous results arrive late to prevent post-unload registration and resource leaks.

## Installation does not prove that the UI updated

- Manage profiles through `plugin_manager`, not handwritten profile configuration. List first to obtain the exact package name, then install. Check `application`, warnings and nextStep.
- `already-installed` does not prove a successful reload. Do not repeatedly install the same version or remove a plugin without confirmation; removal can affect configuration and other sessions.
- Verify Host-service registration, Client-slot registration and actual page rendering separately. Passing offline React tests does not prove that the user's page loaded the new package.
- A local link proves only where disk files point, not that the process reloaded. Tell the user when a restart is needed; do not kill their DSH process without authorization.
- Promise HMR for built-in Client plugins only when the matching build watcher is running. Do not start another Vite server and present it as an update to the current GUI.
- Text inside app.asar may be readable only through Host file-reading tools. Shell or ordinary filesystem failures do not prove absence. Do not edit the packaged runtime to fix a plugin.

## Acceptance checks

- Establish and actually run this repository's test, build and pack commands. Commands from a reference repository are not passing results for this plugin.
- Mock request mapping, configuration saves, failure paths and cleanup. Add contract tests with real host types, Cordis or the stream assembler where needed.
- For UI, cover loading, empty states, read-only/permission denial, save failure, recovery and affected interactions. Restore user state changed by testing.
- Report offline verification, current-profile application state, actual page verification and user testing separately. User-confirmed success is valid evidence, but does not extend to other models or untested states.
- For model providers, images or SDK lifecycle work, read [Provider adaptation notes](provider-notes.md).
