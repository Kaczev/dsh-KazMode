---
name: windows-command-reliability
description: Use when writing or running scripts across Bash, PowerShell and CMD on Windows, including Chinese paths, encoding, file locks and artifact verification.
---

# Reliable Windows command execution

## Confirm the execution environment

Check the tool contract, actual shell, working directory and interpreter. A tool's name does not prove which shell it runs. Set the working directory explicitly; do not assume that another tool's cd applies. Keep Bash, PowerShell and CMD syntax separate. Put complex scripts in their owning scripts directory or a temporary directory and run them with the matching interpreter.

Use a non-destructive probe in a temporary path containing spaces and Chinese characters to verify argument boundaries, input/output encoding and exit codes. Garbled display does not by itself prove file corruption. Read binary and compressed files with the appropriate decoder; a failed search does not prove that a file is absent.

## File writes and retries

- Resolve absolute paths and check ownership and links. Read before overwriting; recheck scope before deleting or moving.
- Distinguish a missing path, a shared-file lock, unsaved in-memory changes, ACL problems and a sandbox-policy denial. Do not switch shells to bypass a guard.
- Use CMD-compatible encoding and line endings for batch files. Test the complete entry point with cmd.exe, not just its internal scripts.
- On a non-zero exit, read stderr before checking side effects. Interruption does not mean the operation failed, and failure does not mean nothing was written.
- Before repairing an ACL, prove the specific permission problem on the path and its ancestors. Do not recursively relax permissions across the user's directory or disable security policies without authorization.

## Acceptance checks

Check each artifact's actual path, content, format and ability to reopen. Cover paths with spaces and Chinese characters, files in use, missing parent directories and repeated execution. Keep logs in output or temporary directories; keep credentials out of command lines and logs.

For example, if replacing a spreadsheet is denied, first check whether the application holds the file; do not immediately assume a permission error. If a script succeeds but its file seems missing, check the working directory and the actual output path returned.
