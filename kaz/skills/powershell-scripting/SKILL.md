---
name: powershell-scripting
description: Use when writing or running a PowerShell command or script that touches files - reading or writing text, encoding, JSON, multi-line arguments, native commands like git or python, junctions and links, or counting and filtering with Get-ChildItem - and when a command exits 0 but the result looks wrong, empty, or mojibake.
user-invocable: false
---

# PowerShell Scripting That Does Not Lie To You

PowerShell fails quietly. It can exit 0 while producing mojibake, write a file with the wrong
encoding, or split your arguments without complaining. Treat "the command succeeded" as a claim to
be checked, not a result.

## Non-negotiable: read the output back

Exit status is not evidence that text was written or read correctly. A script that mangles every
non-ASCII character in a file can still exit 0 and print nothing.

- After writing or transforming text, **read the text back** and compare it to what you intended.
- When something "worked but looks wrong", print the actual value before theorising. Byte counts,
  line counts, and the first characters of the result are cheap and decisive.
- A command that prints fewer lines than you expect has told you something; do not move on because
  the exit code was fine.

## Encoding: three different rules, one habit

The habit is to decide the encoding deliberately and verify it, because the same write produces a
BOM with some commands and not others, and different consumers tolerate different things.

| Target | Rule | Why |
|---|---|---|
| A script file containing non-ASCII | **Write a UTF-8 BOM** | Windows PowerShell 5.1 reads a BOM-less script as ANSI. Non-ASCII comments then become garbage, which either raises a parser error pointing at a signature line or silently drops output. |
| `.json` and other data files | **Never write a BOM** | `JSON.parse` rejects a BOM outright. |
| Text handed to another tool (a commit message, a config body) | **Never write a BOM** | The BOM becomes part of the first line and corrupts the value. |

Practical consequences:

- `Set-Content -Encoding UTF8` writes **with** a BOM. Do not use it for data files, for anything a
  parser reads, or for a `git commit -F` message file.
- To write without a BOM, use the framework API explicitly rather than a cmdlet's shorthand.
- To read non-ASCII text reliably, pass the encoding explicitly. A bare `Get-Content` decodes with
  the system ANSI code page, so UTF-8 Chinese or accented text arrives as mojibake.
- When reading a `.ps1` you generated, keep it pure ASCII if you can: that removes the BOM question
  entirely and is the cheapest fix.
- Keep one script's filename in **one variable** from creation to execution. A typo between where you
  wrote it and where you run it produces an error about the path, which invites a wrong diagnosis.
  Do not re-derive the path in a later statement.

## Move multi-line content through files, not arguments

A multi-line string passed directly to a native command is split on whitespace by the shell before
the program sees it. The command then receives fragments of your text as separate arguments and
usually fails with a message about one of the fragments.

- For a commit message, a request body, or any multi-line argument: write the text to a file and
  pass the file.
- When the output of a native command looks like a PowerShell error, check whether it is really the
  native program's stderr being wrapped. The text inside is usually the real diagnosis.

## Do text surgery with the right tool

PowerShell is a poor text editor, and its failure mode is invisible.

- **Do not reorder or rewrite a document by line number.** Collecting line numbers and then writing
  back to the same file drifts: earlier edits invalidate later line numbers. The symptom is a
  duplicated section or a silently deleted one, with no error.
- Prefer targeted edits: replace a specific unique string, one change at a time, reading the file
  first. For a large restructure, back up first and still make one replacement per pass.
- For batch replacements in a generated or structured file, use a scripted approach that **asserts
  each pattern occurs exactly once** and aborts otherwise. A silent no-match is how edits land in the
  wrong place or nowhere.
- For structured data, serialise with the library that will read it. A PowerShell JSON serialiser
  may choose different indentation and line endings than the application's own writer, which shows up
  as a byte-count mismatch when nothing is actually wrong.
- Judging a whole file by counting bytes is fragile until you have normalised and reported line
  endings. A few bytes of difference is usually `\r`.

## Files, links, and junctions

- **To read link metadata, ask for it.** Inspecting an item's link type or target requires the
  forced variant of `Get-Item`; without it you get a plain item and no link information.
- A link target may be an array. Take the first element and normalise it to a full path before
  comparing paths; also trim trailing separators on both sides before an equality test.
- **To remove a link, delete the link, not the tree.** A recursive delete that follows a link can
  walk into the target. Remove a directory link with the command that only unlinks.
- **A link that resolves to nothing is still a link.** Existence checks can report false for a
  dangling link, so probe the link metadata rather than the resolved path.
- Never let a broad cleaning command run in a tree whose directories are links: it writes through
  them. That applies to forced cleanups and forced checkouts.
- Before counting anything, force the pipeline into an array. A single result and a collection of one
  behave differently, and `.Count` on a scalar is not what you meant.
- Directory listings omit hidden entries unless you ask for them, so "empty" can be wrong. Patterns
  with more than one extension need the recursive file form; a single filter takes one pattern.

## Calling native programs

- `$LASTEXITCODE` is set by the native call, so read it immediately after that call.
- **Zero is not always success.** Some tools define a range of success codes - a mirroring or copying
  tool typically treats small positive codes as non-fatal. Compare against the tool's own contract
  instead of `0`.
- A pipe reports the status of its last command, so a failure upstream can still end in success.
  Collect the exit code per command rather than once per pipeline.
- Quote paths that contain spaces, and be careful when a command itself needs quoting: passing a
  quoted path through another shell layer often needs different quoting again.
- An interrupt usually arrives as a bare non-zero exit after the process was stopped, not as a
  distinguishable signal. Do not read it as a defect in the command.
- A dry run that prints the same success banner as a real run will fool you. Check whether the verb
  you called was the real one before concluding the work landed.

## Shell behaviour worth remembering

- Each invocation is a fresh process: a working directory, an environment variable, or a variable set
  by one call does not exist in the next. Any setup has to be repeated inside the same call.
- Modern shell operators - conditional chaining (the double-ampersand and double-pipe forms),
  null-coalescing, and their relatives - may not exist in the older Windows PowerShell that ships
  with the operating system. Use explicit conditionals. Treat any operator you cannot remember being
  available as unavailable until the shell runs it.
- An intermittent "cannot replace file" style failure on long non-ASCII writes is usually transient;
  retry the same operation once before investigating.
- To measure the environment rather than assume it: ask the shell for its own version, and ask for a
  command's resolved path, instead of reasoning from which shell you think is installed.

## When the shell refuses to parse the command

A parse error means nothing ran. The message points at a line, often not the line you would blame, so
read the message for the *token* it objected to rather than the line number. Two traps account for
most of these, and both come from characters that carry meaning inside a string:

- **Do not put a colon immediately after a variable inside a double-quoted string.** The shell reads
  `<name>:` as a drive-qualified reference and stops with a message about the colon not being followed
  by a valid variable name. Write the output as separate pieces, or use a formatting operator, or
  brace the name so the colon cannot attach to it.
- **Escaping characters inside one shell's string, only to hand the text to another matcher, is
  fragile.** If a search pattern needs the shell's escape character, the shell may consume it - or
  veto the whole command - before the matcher ever sees it. Prefer matching a plain substring, or
  build the text in a way that does not require escaping at all.

General habit: when a command fails to parse, do not retype it with more quoting. Reduce it to the
smallest piece that still fails, then look at what that piece actually contains.
