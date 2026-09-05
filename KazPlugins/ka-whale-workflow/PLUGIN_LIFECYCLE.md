# KazPrivatePlugins — Private Plugin Lifecycle Reference (v0.9)

This file is the single lifecycle reference for private plugin creation, update,
retire, and candidate-registry synchronization. Personas do not embed the full
procedure; role prompts only tell the subagent to read this file through the
`lifecyclePath` value present in the current stage injection.

Location: `<repo>/KazPlugins/ka-whale-workflow/PLUGIN_LIFECYCLE.md`
Runtime constant: `KAZ_PRIVATE_PLUGIN_LIFECYCLE_PATH` (defined by `kaz-shared`).

## 1. Naming and root

- Private plugins live under `KazPrivatePlugins/<plugin>/` in the active DSH
  profile. Do not create `KazPrivatePlugins` at the Git repository root.
- Public/official plugins live under `KazPlugins/` and are never modified by
  the private-plugin lifecycle flow.
- Plugin names use lower-kebab-case and begin with `kaz-skill-` only when the
  plugin is agent-managed and needs the legacy agent-managed registry mapping.
  New v0.9 private plugins should use a clear kebab-case name and register a
  candidate entry.

## 2. CANDIDATE stage

Before implementation, create/update `CANDIDATE.md` inside the plugin folder
(or an adjacent process note) that records:

- Proposed tool name(s) and one-sentence English purpose;
- Source path (`KazPrivatePlugins/<plugin>`);
- Expected probe commands;
- Rollback/restore plan.

## 3. Implementation

- Keep the plugin small and single-purpose.
- Implement under `KazPrivatePlugins/<plugin>/`.
- Include `package.json` when the plugin is a Node/Cordis component, and plain
  `.mjs/.js` modules when it is only a tool implementation.
- Keep public `KazPlugins/` untouched.

### Mounting scope (default policy)

- Future self-built private plugins default to the Kaz-only preset mount:
  add the row to `~/.dsh/.agent-presets/kaz/agent.cordis.yml`, using a relative
  path such as `../../profiles/web/KazPrivatePlugins/<plugin>/lib/index.js`.
- Do NOT add Kaz-only private plugins to the profile-global
  `cordis.patch.yml`: that layer loads in every agent preset.
- The profile-global layer is reserved for plugins that are explicitly meant to
  be resident across modes (a documented cross-mode exception).

## 4. Probe and syntax gate

Every change must pass before registration/versioning:

- Run the plugin's own probes.
- Run `node --check` on every changed JavaScript file.
- Verify the tool schema/registration works in the expected scope.
- If a probe cannot run yet, state `probe: not-run` and do not mark the plugin
  available in the candidate registry.

## 5. Candidate registry sync

The candidate registry shares the agent-managed registry file
`~/.dsh/storages/kaz-agent-managed-tools.json`. Its target schema (version 2)
is:

```json
{
  "version": 2,
  "plugins": {},
  "candidates": [
    {
      "tool": "safe_json_write",
      "description": "Safely write JSON files with backup and rollback",
      "source": "KazPrivatePlugins/<plugin>",
      "available": true
    }
  ]
}
```

Rules:

- Create/update/retire must sync this file after implementation/probe.
- Old files without `candidates` are read as an empty candidate list and must
  not be destroyed by the reader.
- `plugins` content from the legacy agent-managed registry remains untouched.
- `description` is one sentence in English.
- `available` is true only after probes pass.
- Use a safe JSON write tool/pwsh to update only the `candidates` array and
  keep the file valid JSON. `kaz-shared` exposes pure helpers
  (`normalizeAgentManagedCandidateRegistry`, `availablePrivatePluginCandidateToolNames`,
  `upsertPrivatePluginCandidate`, `removePrivatePluginCandidate`) for verification;
  prefer them when running an offline probe/script.

## 6. Versioning

- Every user-visible change increments the plugin/tool version in
  `package.json`/manifest/`CANDIDATE.md`.
- Keep a short change log in the plugin folder when practical.

## 7. Hot reload policy

- v0.9 does not implement KazPrivatePlugins hot reload yet.
- Until a later generation proves hot reload, a newly created/updated plugin
  takes effect in the next task or after DSH restart.
- Never claim immediate availability in the current task when hot reload is not
  proven.

## 8. Retire

- Retire only plugins explicitly listed in the delegation brief.
- Before deletion: copy the plugin folder to a backup/audit location and record
  timestamp, plugin id, trigger source, and delegation source.
- Remove only the listed `KazPrivatePlugins/<plugin>/` folder.
- Remove or mark unavailable its candidate registry entry.
- Do not delete public `KazPlugins/` or official plugins.

## 9. Rollback

Git is the rollback source for `KazPlugins/` and this repository. For private
plugin changes that are not in Git, keep the backup/audit copy produced by the
retire/update step and record its path in the report.
