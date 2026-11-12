---
name: windows-command-reliability
description: Handles Windows shell boundaries, path quoting, encoding and file-lock diagnosis; use when writing scripts or troubleshooting Windows command execution.
---

# Windows command reliability

## Shell and argument boundaries

- Match syntax to the actual shell and interpreter: PowerShell, CMD and Bash are not interchangeable. Set the command's working directory explicitly; another tool's directory change may not carry over.
- In PowerShell, use `$env:NAME` for environment variables and avoid automatic variable names such as `$HOME` (names are case-insensitive). Prefer `-LiteralPath` for file paths and pass executable arguments separately rather than building an evaluated command string.
- When crossing shells or introducing unfamiliar quoting or encoding, test a harmless fixture whose path contains spaces and Chinese characters. Check the arguments received and exit code; do not repeat this probe for routine commands on an already verified path.

## Encoding and entry points

- Choose encoding for the actual reader. Distinguish display corruption from file corruption by reopening with the intended decoder; binary or compressed files need their own reader.
- For batch files, use encoding and line endings supported by the target CMD environment. Test the complete `cmd.exe` entry point, not just the scripts it launches.

## File-access failures

Distinguish a missing parent, an application-held file lock, unsaved in-memory changes, ACL failure and sandbox denial before choosing a fix. For an ACL diagnosis, inspect the target and ancestors; do not broadly relax permissions. A sandbox denial requires the documented authorization path, not a different shell.

If a command reports success but its output is missing, resolve the actual working directory and output path. After a write affected by quoting, encoding or locking, reopen the artifact with its intended reader. Exercise only relevant edge cases, such as Chinese paths or a file held open by another application.
