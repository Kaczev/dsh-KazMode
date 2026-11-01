---
name: baseline-isolation
description: Use when creating, migrating or restoring a baseline, comparing agents or running repeatable experiments; validate scope, back up changes and isolate state between groups.
---

# Repeatable baselines and safe restoration

## Define the starting point

List included paths, exclusions and external state. Git restores only the files it manages; decide separately how to handle ignored configuration, caches, databases, saved games and memory stores. Unsynced does not mean disposable. Read repository instructions and status first; do not reset or clean unauthorized content.

Stop writers or obtain a consistent snapshot, and confirm that in-memory edits have been saved. Record relative paths, types, byte counts, content hashes and source identifiers. Matching hashes do not prove that the project runs.

## Restoration procedure

1. Validate the baseline itself and its full manifest. Reject out-of-scope paths and unexpected links. Check the destination and its ancestor directories; do not follow symlinks or directory junctions into writes outside the scope.
2. List changed, missing and added items read-only. Confirm authorization and that writers have stopped.
3. Back up items to be overwritten or removed outside the restoration scope. Preserve original paths and a difference manifest, and validate the backup. Obtain separate confirmation for irreversible operations.
4. Recheck targets and differences before writing; stop if a race occurs. Restore incrementally from the manifest rather than replacing comparison with a wholesale wipe.
5. Recheck the entire scope, then actually open or run the project. On failure, preserve the backup and current state; do not claim success.

Test the restoration program in isolated fixtures covering changed, missing, added and unchanged files, a corrupt baseline, links escaping the scope, races and protection refusals. List unverified cases.

## Comparisons between agents

Give each group the same baseline, requirements, permissions, budget and frozen handoff material. Isolate previous groups' code, scores, sessions and cross-session memory. Disabling automatic injection alone does not prevent active retrieval. If memory is required, start each group from the same snapshot rather than sharing a growing store.

When an environment defect is found, record its impact and revise the next version uniformly or rerun the tests. Do not give the hint only to later participants. Preserve each group's provenance and acceptance records; do not put this task's solution into a general-purpose skill.
