---
name: powershell-scripting
description: Use when writing or running a PowerShell command or script that touches files - reading or writing text, encoding, JSON, multi-line arguments, native commands like git or python, junctions and links, counting with Get-ChildItem, or nested PowerShell calls - when a command exits 0 but the result looks wrong, empty, or mojibake, and when the machine is still on Windows PowerShell 5.1 and should be moved to PowerShell 7 with winget.
user-invocable: false
---

# PowerShell Scripting That Does Not Lie To You

PowerShell fails quietly. It can exit 0 while producing mojibake, write a file with the wrong
encoding, or split your arguments without complaining. Treat "the command succeeded" as a claim to
be checked, not a result.

**This file describes PowerShell 7 and later; Windows PowerShell 5.1 appears as the exception.**
Most of what looks like "a PowerShell problem" is specifically a 5.1 problem, and the fix is to get
off 5.1 rather than to learn its workarounds. Ask the shell which one it is, first, because every
rule below depends on the answer:

```powershell
$PSVersionTable.PSVersion      # 7.x = PowerShell 7; 5.1.x = Windows PowerShell
$PSVersionTable.PSEdition      # Core = 7+; Desktop = 5.1
$PSHOME                        # also tells you how it was installed - see references\upgrade-to-7.md
```

| Answer | Meaning |
|---|---|
| `Core` / 7.x | The rules in this file apply as written. |
| `Desktop` / 5.1.x | Read `references\upgrade-to-7.md` first. The differences are listed per rule. |

- A tool named `pwsh`, a shortcut, or a task runner is not evidence that 7 is what runs. The
  harness's own shell normally runs 7, but a caller that caches its shell path can keep running
  5.1 long after 7 is installed - which is exactly why you ask rather than assume.
- **PowerShell 7 does not replace Windows PowerShell 5.1.** They install side by side: on Windows
  `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` is still present and still reports
  5.1. Never propose removing 5.1, and never report it as removed.

## Read the matching reference

| Question | File |
|---|---|
| Which shell this is, which flavour the machine should get, and what may be reported | `references/upgrade-to-7.md` |
| The winget invocation, its exit codes, and making the install take effect | `references/installing-with-winget.md` |
| What encoding a write should use, and how to check the bytes that landed | `references/encoding-and-readback.md` |
| Getting multi-line text and nested commands through the layers intact | `references/quoting-and-arguments.md` |
| Editing a text file safely; what links, junctions and hidden items do | `references/files-on-disk.md` |
| What a native program's exit code and the shell's own state mean | `references/native-calls-and-shell.md` |

Read one with the file-read tool, when its question is the one in front of you. Every one is inside
the whole-read budget; a tool result over 8192 code points is trimmed to its first 4096 plus its last
1024 the next time compaction runs, so a file that grows past that loses its middle.

## Facts that decide the shape before you read further

- **Exit status is not evidence that text was written correctly.** A script that mangles every
  non-ASCII character in a file can still exit 0 and print nothing. Read the text back when the write
  was **non-ASCII**, when a **parser or another tool consumes the file**, or when the **exit code was
  0 but the output looks wrong**; a byte count, a line count, or the first characters is enough.
  Detail in `references/encoding-and-readback.md`.
- **Decide the encoding, and judge it by the bytes.** A `.ps1` containing non-ASCII gets a UTF-8
  BOM, because only 5.1 needs one; `.json` and text handed to another tool never do. `-Encoding utf8`
  means UTF-8 **with** a BOM under 5.1 and **without** one under 7.6, so the spelling is not the
  answer. Detail in `references/encoding-and-readback.md`.
- **The shell does not split a multi-line argument.** It arrives as one argv element, newlines and
  spaces intact, and `git commit -m` receives it whole. What breaks is elsewhere: `cmd.exe` truncates
  at the first newline, and a program that re-splits its own arguments will split yours. Write the
  text to a file and pass the file. Detail in `references/quoting-and-arguments.md`.
- **The outer layer interpolates before the inner shell parses.** A pipe inside an interpolated inner
  script can be consumed before the inner shell ever sees it, so nest with an inner script that has no
  quotes or pipes, pass a single-quoted literal, or hand the text over encoded. Detail in
  `references/quoting-and-arguments.md`.
- **Do not put a colon immediately after a variable inside a double-quoted string.** The shell reads
  `<name>:` as a drive-qualified reference and stops, and a parse error means nothing ran. Detail in
  `references/quoting-and-arguments.md`.
- **`$LASTEXITCODE` belongs to the native call**, so read it immediately after that call. Zero is not
  always success - some tools define a range of success codes - and a pipe reports the status of its
  last command. Detail in `references/native-calls-and-shell.md`.
- **Windows PowerShell 5.1 has no `&&`, `||`, `??` or ternary**, and they fail at **parse** time: so
  nothing in the command runs, and `$LASTEXITCODE` still holds the previous call's value. Measured:
  5.1 rejected `$x ?? "d"` at parse time while 7.6 evaluated the same line. Detail in
  `references/native-calls-and-shell.md`.
- **Each invocation is a fresh process.** A working directory, an environment variable, or a variable
  set by one call does not exist in the next, so repeat any setup inside the same call. Detail in
  `references/native-calls-and-shell.md`.
- **To read link metadata, just ask for it.** `Get-Item` populates `LinkType` and `Target` with or
  without `-Force`; what `-Force` decides is whether a hidden item is returned at all. Delete a link
  with the command that only unlinks, never with a recursive delete that can walk into the target.
  Detail in `references/files-on-disk.md`.

## When the output is wrong anyway

Work down this order; each rung is cheap, and only the last one asks you to read the script:

1. Which shell ran it - `$PSVersionTable.PSEdition`, not the name on the PATH.
2. What the exit code meant to the tool that returned it, not to you.
3. What the bytes say, not what a readback shows.
4. Reduce a parse failure to the smallest piece that still fails.
5. Only then read the command for a wrong verb or an argument that never arrived.

A command that exits 0 while the work is wrong is the shape of every failure in this file. Every
detail behind these rungs is in one of the references above, and when the shell turns out not to be
the suspect, `repairing-something-broken` carries that work.
