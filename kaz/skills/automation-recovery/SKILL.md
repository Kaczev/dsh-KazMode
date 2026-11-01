---
name: automation-recovery
description: Use to diagnose MCP, bridge-service and desktop-automation connection failures, timeouts or unknown execution states; gather evidence by layer and recover without repeating writes.
---

# Layered automation diagnosis and recovery

Use when a connection fails, a request times out, a queue blocks or an operation's result is unknown. Follow the current tool contract for interface names and recovery procedures rather than reusing historical version-specific fixes.

## Fix the target and preserve evidence

Record the target, action, verbatim error, time and whether a write may have occurred. Check the host tool, bridge service, target process and business object separately. A discoverable tool catalog does not prove that the application is usable. Redact authentication information first.

## Respond at the point of failure

- Definitely not sent: correct the parameters or connection prerequisites, then execute once.
- Explicit business refusal with no side effects: address the stated reason. Do not bypass a permission denial; ask when authorization is missing.
- Sent, but timed out, disconnected or missing an acknowledgment: mark the effects as unknown. Query objects and artifacts read-only; do not treat a timeout as cancellation.
- Blocked application: check busy states, compilation, modal windows and pending requests. Do not automatically confirm save, overwrite, login or unknown dialogs, or kill the process to clear the queue.

Do not blindly retry toggles, deletions, appends or paid operations. First establish whether the original request is still running, succeeded or partially completed. If that cannot be established, preserve the state and report which evidence is missing.

## Verify after recovery

Follow the current tool contract to wait for the original call or restore the connection. Run a minimal read-only probe, then inspect the target. A live process or a closed window cannot replace a business-level probe. Complete only the parts confirmed unfinished and still authorized, with a bounded retry count.

For example, after a disconnect during a playback toggle, query playback first; do not toggle again if it already changed. After an export timeout, check the actual path, format and decodability, and establish whether the original job has ended.

Report the failing layer, confirmed side effects, recovery actions, actual verification and unknown states.
