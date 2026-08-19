# task-master-whiteboard

A **Task Master** whiteboard plugin for dsh: the model treats whiteboards as external
cognitive scratchpads, because its own memory is unreliable. Subtasks, threads of
thought, uncertainties, contradictions — and even its own identity — get written down
instead of trusted to memory.

- **Role setting** (injected into the system prompt): turns the agent into a decisive,
  action-oriented *Task Master* that records before it forgets, and always starts a new
  board with a short, precise `top` line stating its purpose. Injected **once, on the
  first round** of each new conversation (resumed conversations are skipped).
- **Per-round reminder (2026-08-21)**: from **turn 2 on, every round** gets a short
  whiteboard-first reminder (settings `turnReminder`, empty = built-in default) —
  including conversations resumed after a dsh restart, so the whiteboard habit is
  reinforced every turn instead of only on round 1.
- **Storage**: one JSON file per board under `.dsh/whiteboards/<session>/` in the **workspace root**
  (the calling agent's session cwd). **Scoped per conversation** (2026-08-19): each conversation
  has its own boards; subagents share their parent conversation's boards (`header.parentSession`
  → parent id, else `header.id`). Auto-created on first use. Portable, human-readable, easy to debug.
- **Six tools**: create / list / read / append / update / clear. All tool descriptions and
  parameter names are in English (the model reasons in English).
- **Kaz-mode integration**: the plugin is the **7th managed plugin** of kaz-mode — its
  enable toggle appears in the **Kaz control panel** (like `output-beep`), and Kaz mode
  force-enables it on entry. When loaded and enabled, the six whiteboard tools are also
  available in **round 1** (round-minimal auto-adds them to its first-round tool set;
  kaz-mode round-1 surface follows round-minimal).

## Per-conversation scoping

Each conversation gets its own directory: `.dsh/whiteboards/<session-key>/` where
`<session-key>` = `header.parentSession ?? header.id` (sanitized to `[A-Za-z0-9_-]`;
`default` when no agent context). Subagents (`origin: subagent`) resolve to their parent
conversation, so a conversation and its subagents share the same boards — boards stay
with the task, not with the worker. All six tools operate inside the current
conversation's scope; `boardsDir` override still gets the session subdirectory beneath it.

## Board file format

```json
{
  "id": "wb_1730000000000_ab12",
  "top": "brief purpose of this board",
  "entries": [
    { "subtitle": "subtask-1", "content": "content 1" },
    { "subtitle": "subtask-2", "content": "content 2" }
  ]
}
```

## Installation

### 1. Place the package

Copy this folder (or keep it) at:

```
%USERPROFILE%\.dsh\profiles\web\plugins\task-master-whiteboard\
├── package.json
├── lib\index.js
├── README.md
└── probe-task-master-whiteboard.mjs
```

### 2. Make the Loader resolve it (junction)

In PowerShell (no npm needed; `file:`-style npm installs create the same junction):

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\task-master-whiteboard" -Target "$env:USERPROFILE\.dsh\profiles\web\plugins\task-master-whiteboard"
```

### 3. Register the composition row — `cordis.patch.yml`

Append to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
# task-master-whiteboard: Task Master 白板插件（外部认知草稿纸）。6 个白板工具
# + Task Master 角色提示段；白板存 <工作区>/.dsh/whiteboards/。Kaz 模式的第 7 个
# 被管理插件（Kaz 面板开关行）。实时配置见 settings.yaml 的 task-master-whiteboard: 段。
- insert:
    - id: task-master-whiteboard
      name: task-master-whiteboard
      config:
        enabled: true
```

### 4. Register live settings — `settings.yaml`

Append to `~/.dsh/profiles/web/settings.yaml` (hot-reloaded):

```yaml
task-master-whiteboard:
  enabled: true
  # boardsDir: ""   # optional absolute-path override; empty = <workspace>/.dsh/whiteboards
```

### 5. Kaz control panel (this workspace only)

The toggle row appears in the Kaz panel because kaz-mode already manages it. Three
one-time patches are already applied in this workspace (they are **overwritten when dsh
is upgraded** — re-apply after any upgrade):

1. `kaz-mode/lib/index.js` → `MANAGED_PLUGINS` now lists
   `{ id: "task-master-whiteboard", label: "task-master-whiteboard（插件7 · 任务白板）" }`
   (host-side linkage: force-enable on entering Kaz, status snapshot, `kaz_mode_status` report).
2. `kaz-mode/lib/client.js` → the panel's `PLUGINS` array now contains the 7th row
   (toggle + `enabled` config field).
3. `dsh-host-apiproxy/lib/index.js` → `WEB_SETTINGS_NAMESPACES` (the
   `LOCAL PATCH (Kaczev Kaz 工作区)` block) now exposes `task-master-whiteboard`,
   otherwise the panel would show "未安装" and the toggle would be unwritable.

### 6. Make it effective

- New plugin code → hot-mounted when the `cordis.patch.yml` change is picked up.
- `kaz-mode` / apiproxy edits → **restart dsh** (Node ESM cache + startup whitelist),
  then hard-refresh the web page (Ctrl+F5) to fetch the updated client bundle.
- Tools must be in `kaz-mode.toolWhitelist` to be visible/callable inside Kaz mode —
  already added in this workspace (see `settings.yaml`).

## Usage examples (per tool)

```
new_whiteboard      { top: "Current task subtasks", entries: [{ subtitle: "a", content: "..." }] }
                    → { id: "wb_...", top: "...", entries: [...] }
list_whiteboards    {} → [ { id, top }, ... ]
read_whiteboard     { id: "wb_..." }                         → { id, top, subtitles: [...] }
read_whiteboard     { id: "wb_...", subtitle: "a" }          → { id, top, subtitle, content }
append_whiteboard   { id: "wb_...", subtitle: "b", content: "..." }   → upsert entry
update_whiteboard   { id: "wb_...", subtitle: "b", content: "..." }   → same upsert
clear_whiteboard    { id: "wb_...", subtitle: "b" }          → remove one entry
clear_whiteboard    { id: "wb_..." }                         → delete the whole board file
```

Worked scenario: model gets a multi-part task → `new_whiteboard` with subtasks →
`append_whiteboard` as the task evolves → `read_whiteboard` (no subtitle) to recall
the outline → `clear_whiteboard` (subtitle) to retire a done subtask.

## Verification

```powershell
# 1. Syntax
node --check "$env:USERPROFILE\.dsh\profiles\web\plugins\task-master-whiteboard\lib\index.js"

# 2. Module loads
node --input-type=module -e "import('file:///C:/Users/Kaczev/.dsh/profiles/web/plugins/task-master-whiteboard/lib/index.js').then(m=>console.log(m.default.name))"
#   expect: task-master-whiteboard

# 3. Logic probe (fake ctx; exercises all 6 tools against a temp workspace)
node "$env:USERPROFILE\.dsh\profiles\web\plugins\task-master-whiteboard\probe-task-master-whiteboard.mjs"
#   expect: PROBE OK

# 4. Composition (no restart needed)
node "C:\Users\Kaczev\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile web --dump-config
#   expect: a task-master-whiteboard row, exit 0

# 5. End-to-end (after restart + Ctrl+F5)
#    - Kaz panel shows "task-master-whiteboard（插件7 · 任务白板）" with an on/off toggle
#    - In a Kaz conversation (round 1 included): call list_whiteboards → []
#    - .dsh/whiteboards/ exists in the workspace root
```

## Common pitfalls

| Pitfall | Fix |
| --- | --- |
| Tools invisible in a Kaz conversation | The six tools must be in `kaz-mode.toolWhitelist` (settings.yaml). Already done here; after a dsh upgrade, re-check. |
| Panel shows "未安装" for the plugin | `WEB_SETTINGS_NAMESPACES` patch was lost in a dsh upgrade — re-add `task-master-whiteboard` to the `LOCAL PATCH` block. |
| Round 1 without whiteboard tools (Kaz or not) | The plugin must be loaded (cordis.patch.yml row) **and** enabled (settings.yaml). round-minimal auto-adds the six tools to round 1 only then; if you disabled the plugin, round 1 stays minimal. |
| `Error: Invalid whiteboard id` | Ids are generated (`wb_<ts>_<rand>`) — always take them from tool results, never type them by hand with odd characters. |
| Files written outside the workspace | `boardsDir` override resolves against the agent's cwd; relative paths stay inside the workspace. Absolute overrides are the user's choice. |
| Code changes don't take effect | Restart dsh (ESM module cache), then hard-refresh the page. |
| Boards "lost" | Boards are **per conversation**: `.dsh/whiteboards/<session>/` — another conversation (even in the same workspace) has its own scope and won't see them. Switching conversations intentionally hides the other's boards. |

## Settings

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Total switch; false removes the role section and the tools' availability is still governed by the tool registry. |
| `boardsDir` | string | `""` | Optional override for the boards location; empty = `<workspace>/.dsh/whiteboards`. |
| `turnReminder` | string | `""` | 每轮白板优先提醒（第二轮起每轮注入，含重启后续接会话）；留空 = 内置默认文案 |

## Compatibility

- Host-plane only (no client half); works with `profiles/web` and independently of Kaz mode
  (the `cordis.patch.yml` row alone is enough to use it standalone).
- Dependencies resolved at runtime from `profiles\node_modules` (already installed):
  `@deepseek-ai/cordis`, `@deepseek-ai/dsh-settings`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`.
