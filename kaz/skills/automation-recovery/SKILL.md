---
name: automation-recovery
description: Diagnoses MCP, bridge-service and desktop-automation failures by layer; use for connection errors, blocked queues, timeouts or unknown operation results.
---

# Automation diagnosis and recovery

## Locate the failure

Capture the target, requested action, verbatim error and time; redact credentials. Probe only the layers needed to distinguish:

- Host tool: is the tool available, and did it accept the call?
- Bridge: can it reach the intended application or session?
- Application: is it ready, busy, compiling or waiting on a modal dialog?
- Business object: did the requested state or artifact actually change?

A working tool catalog or live process does not establish business-level success. Use the current tool contract for connection and recovery methods, not historical version-specific fixes.

## Choose the recovery branch

- **Confirmed not sent:** correct the parameters or connection prerequisite, then submit once.
- **Explicit refusal without side effects:** address the stated cause within existing authorization; a permission refusal is not a connection fault.
- **Sent, result unknown:** use request/job identifiers and read-only target queries to distinguish running, completed and partial work before another write. If evidence is unavailable, preserve the state and identify the missing observation.
- **Application blocked:** inspect busy state, pending requests and dialogs. Do not dismiss save, overwrite or login prompts, or kill the application merely to clear a queue.

## Verify recovery

Wait for or reconnect to the original request as the tool contract permits. Run one minimal read-only connection probe, then inspect the business object. Resume only confirmed unfinished work; bound retries and stop when the same failure recurs without new evidence.

For a disconnected playback toggle, read playback state before deciding whether another toggle is needed. For an export timeout, check the original job and whether the destination artifact opens in the expected format.

Report the failed layer, confirmed outcome and unresolved state; include recovery actions only when they affect the result or next step.
