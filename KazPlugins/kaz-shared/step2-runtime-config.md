# Kaz 6.0 Step 2 — Runtime delegation config (pending next restart)

Because the Step 2 hot-load probe verdict is `unsupported-from-main-surface`, this
runtime wiring must be applied **before the next DSH restart**, then verified in
the new process. It is not hot-loaded in the current session.

## 1. Agent preset: add fixed maintenance subagent tool instance

Target: `C:\Users\Kaczev\.dsh\.agent-presets\kaz\agent.cordis.yml`
(add inside the existing `delegation` group, near the other `tool-subagent` rows):

```yaml
    # Kaz 6.0 Step 2: maintenance subagent — fixed toolFilter whitelist at the
    # tool-instance/provider-request layer; model cannot pass arbitrary allow lists.
    - id: tool-subagent-maintenance
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: maintenance_subagent
        enableRunInBackground: false
        backgroundMode: one-shot
        maxDepth: 2
        persona: We are the memory maintenance subagent. Write concise memories with evidence; deletion requires main-model approval.
        toolFilter:
          allow:
            - memory_save
            - memory_update
            - memory_forget
            - memory_list
            - memory_search
            - memory_detail
            - read
            - glob
            - grep
            - write
            - edit
            - pwsh
            - safe_json_write
            - todo_write
```

Optional companion roles when the tool-creation pilot is enabled:

```yaml
    - id: tool-subagent-tool-creator
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: tool_creator_subagent
        enableRunInBackground: false
        backgroundMode: one-shot
        maxDepth: 2
        persona: We are a tool creator subagent. Create tools only within the delegated whitelist and report evidence.
        toolFilter:
          allow:
            - read
            - glob
            - grep
            - write
            - edit
            - pwsh
            - safe_json_write
            - todo_write
```

## 2. Maintenance subagent output contract

Return the structured short report (no full content reread by the main model):

```json
{
  "conclusion": "one-line result",
  "evidence": ["memory_save id=... ok"],
  "failures": [],
  "next": "optional next step"
}
```

Physical deletion must only be attempted after the main model approved and after
a backup + audit entry exist; the offline guard lives in
`lib/maintenance-report.js` (`validatePhysicalDeletionRequest`).

## 3. Verification after restart

- Confirm the tools register: `maintenance_subagent`, optional `tool_creator_subagent`.
- Confirm the maintenance child does **not** see tools outside its `toolFilter.allow`.
- Confirm the main task surface does **not** contain `memory_save/update/forget`
  when task filtering is active.
- Re-run the full profile probe suite (28 probes expected at Step 2 close).
