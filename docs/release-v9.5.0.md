# 9.5.0

Reorganize the Kaz prompt into five sections: goals and decisions, authorization and clarification, implementation and verification, project navigation and file management, and conditional protocols for HTML proposals, prose writing and goal state.

The English prompt follows the user-approved Chinese draft. It retains proactive navigation, file ownership, behavioral verification and readback after uncertain writes. It no longer prescribes a default response language, the former direct-answer style, or model-switching preferences.

Remove `baseline-isolation` and `dsh-plugin-field-guide`. Refine `automation-recovery` and `windows-command-reliability`; keep `write-like-a-person` unchanged. Kaz now bundles three skills. Runtime code and dependencies are unchanged.

## Verification

- `npm run check`: 25 tests, version consistency and README synchronization.
- Package dry-run and inspection of the actual npm tarball: prompt matches the source; only the three retained skills are included.
- `git diff --check`.

Tests use a simulated Host. This release has not been tested for live DSH reload, UI display or model behavior.
