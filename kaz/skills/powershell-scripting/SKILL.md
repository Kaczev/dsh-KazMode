---
name: powershell-scripting
description: Use when writing or running a PowerShell command or script that touches files - reading or writing text, encoding, JSON, multi-line arguments, native commands like git or python, junctions and links, counting with Get-ChildItem, or nested PowerShell calls - when a command exits 0 but the result looks wrong, empty, or mojibake, and when the machine is still on Windows PowerShell 5.1 and should be moved to PowerShell 7 with winget.
user-invocable: false
---

# PowerShell Scripting That Does Not Lie To You

PowerShell fails quietly. It can exit 0 while producing mojibake, write a file with the wrong
encoding, or split your arguments without complaining. Treat "the command succeeded" as a claim to
be checked, not a result.

**This file describes PowerShell 7 and later; Windows PowerShell 5.1 appears below as the
exception.** Most of what looks like "a PowerShell problem" is specifically a 5.1 problem, and the
fix is to get off 5.1 rather than to learn its workarounds. Ask the shell which one it is, first,
because every rule below depends on the answer:

```powershell
$PSVersionTable.PSVersion      # 7.x = PowerShell 7; 5.1.x = Windows PowerShell
$PSVersionTable.PSEdition      # Core = 7+; Desktop = 5.1
$PSHOME                        # also tells you how it was installed - see the upgrade section
```

| Answer | Meaning |
|---|---|
| `Core` / 7.x | The rules in this file apply as written. |
| `Desktop` / 5.1.x | Read the upgrade section first. The differences below are listed per rule. |

- A tool named `pwsh`, a shortcut, or a task runner is not evidence that 7 is what runs. The harness's
  own shell normally runs 7, but a caller that caches its shell path can keep running
  5.1 long after 7 is installed - which is exactly why you ask rather than assume.
- **PowerShell 7 does not replace Windows PowerShell 5.1.** They install side by side: on Windows
  `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` is still present and still
  reports 5.1. Never propose removing 5.1, and never report it as removed.

## Upgrade a 5.1 machine to PowerShell 7

Six steps: probe, decide, install, make it take effect, verify, report. The fastest route is winget,
but **which flavour gets installed is a decision, not a default.**

### Step 1 - Probe

```powershell
$PSVersionTable.PSEdition                            # the shell you are in now
pwsh -NoLogo -NoProfile -NonInteractive -Command '$PSHOME'   # what the name pwsh resolves to
Get-Command winget -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
```

Those are two different questions, and a caller that cached its shell path can answer them
differently - which is the whole subject of Step 4.

`$PSHOME` is the authoritative way to tell **which flavour** is installed, and the answer decides
what to do next:

| `$PSHOME` | Flavour |
|---|---|
| starts with `$env:ProgramFiles\WindowsApps\` | MSIX |
| `$env:ProgramFiles\PowerShell\7` | MSI |
| `$HOME\.dotnet\tools` | .NET global tool |
| anything else | portable ZIP |

Those four mappings are vendor documentation. On the one install this file was written against, the
MSIX row held: `$PSHOME` was `C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe`,
the matching path was the resolved `pwsh` and the running process image. That is one machine's answer,
not part of the mapping - check your own `$PSHOME` against the table. The MSI, global-tool and ZIP rows
have not been seen, so treat them as the mapping to test, not as results.

### Step 2 - Decide the flavour

- **Client machine, and a working `pwsh` is all you need** - take the default winget install (MSIX):
  fastest, no administrator. As of PowerShell 7.6 the plain install is MSIX, so a default install
  that used to land in `Program Files` does not any more; check what you got rather than assuming.
- **Server, Windows PowerShell remoting (WSMAN), machine-level configuration, or all-users
  profiles** - you need the MSI flavour, `--installer-type wix`, and an administrator.
- **No winget at all** (Windows Server 2022 and earlier): there is no measured route here. The
  fallback is the vendor release assets, matching the architecture, and **you check the asset name
  and hash from the release metadata rather than writing the filename from memory.**
- Do not use `winget show --id Microsoft.PowerShell --exact` to decide whether an MSI exists: it
  lists the MSIX installer only. Adding `--installer-type wix` does reach a `wix` installer whose
  hash cross-checks against the vendor release. Measured, both halves.

The MSIX limits, which are why the decision matters: single-user with no all-users option; runs in
an app sandbox; **no PowerShell remoting**, because the sandbox forbids writing the app root, which
is where WSMAN configuration lives (user-level configuration and outbound SSH remoting _are_
supported); and the following fail because they need to write `$PSHOME`:
`Register-PSSessionConfiguration`, `Update-Help -Scope AllUsers`,
`Enable-ExperimentalFeature -Scope AllUsers`, `Set-ExecutionPolicy -Scope LocalMachine`.

Two parts of that are measured rather than quoted: `$PSHOME` here **denies writes** - creating a
file in it raises `UnauthorizedAccessException` and leaves nothing behind - and the all-users
profile paths resolve but **do not exist**, because both point inside that same directory. The
remoting and execution-policy consequences are vendor documentation that was read, not tested: an
unelevated session cannot isolate them. The MSI flavour documents `ENABLE_PSREMOTING` and `ALLUSERS`
semantics instead.

### Step 3 - Install, and expect a non-zero exit on a healthy machine

```powershell
winget install --id Microsoft.PowerShell --exact `
  --accept-package-agreements --accept-source-agreements --disable-interactivity
$ok = @(0, -1978335189)
if ($ok -notcontains $LASTEXITCODE) { throw "winget failed with exit code $LASTEXITCODE" }
```

- `--exact` is required, or a same-named package can match. The two `--accept-*` flags are required
  or the first run blocks on an interactive agreement. `--disable-interactivity` keeps unattended
  runs from hanging. Add `--installer-type wix` for the MSI flavour, which needs administrator.
- **An unconditional "non-zero means failure" throw is wrong.** Measured on a machine that already
  had 7: re-running the install prints `No newer package versions are available from the configured
  sources.` and returns **-1978335189**, which is `0x8A15002B`,
  `APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE`. `winget upgrade --id Microsoft.PowerShell --exact`
  returns the same code when there is nothing to do.
- `0` is the success value, on the installer's own contract. Every other value above is an error,
  including the benign-looking one - whitelist the codes you expect and say why in a comment, or
  the next reader will take the whitelist for a missed error.
- Keep both the decimal and the hex for every code you whitelist, because the two tools speak
  different dialects: `$LASTEXITCODE` gives you only the negative decimal, and `winget error`
  accepts only the hex. The translation is not memorable - `-1978335135` and `-1978334963` are
  `0x8A150061` and `0x8A15010D` - so do not do it in your head at the point of failure.
- Recognise these worth-handling cases: `-1978335189` / `0x8A15002B` means nothing to do, the
  normal result on an already-installed machine; `-1978335135` / `0x8A150061` and
  `-1978334963` / `0x8A15010D` mean some version is present but not necessarily the newest;
  `-1978335212` / `0x8A150014` usually means a mistyped package ID; `-1978335230` / `0x8A150002`
  means invalid arguments. Note that `0x8A15010D` and `0x8A150109` are one hex digit apart while
  their decimals, `-1978334963` and `-1978334967`, are not adjacent - so a mistyped hex looks
  plausible. Whether the two "already installed" codes behave as their symbols claim was **not**
  reproduced with a real old-version scenario; only the symbol lookup was checked.
- Deciding between ensure-installed and ensure-newest matters here: for ensure-installed the
  "already installed" codes can be treated as success with a warning; for ensure-newest only
  `0x8A15002B` means current, and anything else needs a `winget upgrade`.
- Look any code up without going online: `winget error 0x8A15002B` prints
  `APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE` and `No applicable update found`. Verified.
  **But it validates nothing** - it echoes a value for `0xDEADBEEF` (`unknown error`) and exits 0
  even for a non-number, so a clean lookup is not evidence that a code is real, and its answer for `0`
  is canned text rather than independent evidence. `0` is the success value because that is the
  installer's contract. A vendor documentation page for these codes is not where they live - the table
  is generated from the same tool, which is why carrying the codes you need beats pointing at a page
  that may not be there.

### Step 4 - Make it take effect

**Installing is not the same as taking effect, and this is the most common failure.** A caller that
resolved the shell path at startup keeps running 5.1 after a successful 7 install, silently - the
install exit code is 0 and `pwsh` on the PATH is fine.

- A caller that looks `pwsh` up every time is fixed by restarting it.
- A caller that cached the path needs a restart, or an explicit configuration change - installing
  alone does nothing for it.
- A restart may be the only lever, and it may not be available from inside the session that would
  have to perform it. Say so at Step 6 rather than reporting success.

### Step 5 - Verify with the shell, not with the exit code

Strongest evidence first:

```powershell
$PSVersionTable.PSEdition                      # must be Core; Desktop means you are still in 5.1
$PSHOME                                        # reverse-check the flavour from Step 1
```

Then an end-to-end check in a non-ASCII language, because that is the point of the upgrade and it is
the cheapest thing that can fail visibly:

```powershell
$f = Join-Path $env:TEMP 'probe.txt'
Set-Content -Path $f -Value '中文测试ABC'
$b = [System.IO.File]::ReadAllBytes($f)
($b | ForEach-Object { $_.ToString('X2') }) -join ' '
Remove-Item $f
```

**Judge this by the bytes, not by reading the text back.** Measured with the four characters `中文测试`
plus `ABC`: PowerShell 7 wrote `E4 B8 AD E6 96 87 E6 B5 8B E8 AF 95 41 42 43 0D 0A` - UTF-8, no BOM.
Windows PowerShell 5.1 on the same machine wrote `D6 D0 CE C4 B2 E2 CA D4 41 42 43 0D 0A` - the
system ANSI code page, which was 936 on that machine. The ASCII tail is identical in both, so **a test value
needs non-ASCII characters or it proves nothing.**

A readback cannot make this distinction, and it is worth knowing why: 5.1 reading back its own
GBK file inside the same process returns clean text, because each process decodes in its own
encoding. `[System.Text.Encoding]::Default` is `gb2312` under 5.1 and `utf-8` under 7, so text that
round-trips cleanly under either shell tells you nothing about which one wrote it. The bytes are the
evidence.

### Step 6 - Report what was verified and what was not

Never claim the shell changed on the strength of the installer's exit code, and never claim a step
worked when it was only read about. State plainly: which flavour is installed, whether the caller
actually changed over, which checks you ran, and what you could not confirm. "Upgrade complete" with
Step 4 skipped is the characteristic false report.

Say that the way back exists, because a machine can have a workflow that depends on the old default:
PowerShell 5.1 was never touched, and removing 7 returns the shell to it. That is the sentence to reach
for when the caller that still has to work cannot be changed - not a configuration hack, and never a
suggestion to remove 5.1.

Things this file does **not** establish, and must not be read as fact:

- The remoting and execution-policy consequences of MSIX in Step 2 are vendor documentation that
  was read, not tested - an unelevated session cannot isolate them. What **is** measured there is
  narrower: `$PSHOME` denies writes, and the all-users profile paths do not exist.
- The MSI route (`--installer-type wix`) was never actually executed - the installer was queried and
  its hash cross-checked, but nothing was installed through it.
- Only the MSIX row of the `$PSHOME` table was ever seen. The MSI, global-tool and ZIP rows come
  from documentation.
- Exit-code behaviour was only exercised on one winget version, and only in an ordinary user
  session - not under a restricted ACL sandbox. The "already installed" codes were looked up, not
  provoked by building a real old-version machine.
- A machine with no winget was never tested.
- Nothing here about which release is long-term-support, which future release drops the MSI, minimum
  operating-system versions, or how long 5.1 will survive has been checked. Those are the claims
  most likely to have gone stale, so verify before repeating them - do not carry them forward on the
  strength of this file.

## Read the output back when it can be wrong

Exit status is not evidence that text was written or read correctly. A script that mangles every
non-ASCII character in a file can still exit 0 and print nothing. But not every write needs a
verification round:

- Read the text back when the write was **non-ASCII**, when a **parser or another tool consumes the
  file**, or when the **exit code was 0 but the output looks wrong**.
- A byte count, a line count, or the first characters of the result is enough; those are cheap and
  decisive. Do not re-read a whole file you just wrote, and never re-read one whose content is still
  in context.
- Print the actual value before theorising. A command that prints fewer lines than you expect has
  told you something.
- One question a readback cannot answer: **which shell wrote the file**, since each process decodes
  in its own encoding and both may read their own output cleanly. For that ask for the bytes, as the
  upgrade section does.

## Encoding: decide it deliberately, per version

Under 7 the defaults are sane, which is precisely why the 5.1 habits that worked around them now
cause damage. Decide the encoding, and check the bytes rather than trusting a spelling.

| Target | Rule | Why |
|---|---|---|
| A script file containing non-ASCII | **Write a UTF-8 BOM** | Only 5.1 needs this: it reads a BOM-less script as ANSI, so non-ASCII comments become garbage, which either raises a parser error pointing at a signature line or silently drops output. Under 7 a BOM is harmless, so it stays the safe default for a `.ps1`. |
| `.json` and other data files | **Never write a BOM** | `JSON.parse` rejects a BOM outright. |
| Text handed to another tool (a commit message, a config body) | **Never write a BOM** | The BOM becomes part of the first line and corrupts the value. |

- **`-Encoding utf8` changed meaning.** Measured: 5.1 wrote `EF BB BF` first - UTF-8 **with** a BOM;
  7.6 wrote the same text with **no** BOM. Never use that spelling for data files or for a
  `git commit -F` message file, and check the bytes rather than the spelling. This matters most to a
  script that has to run on both: to write without a BOM under 5.1, use the framework API explicitly
  (`[System.IO.File]::WriteAllText($path, $text, [System.Text.UTF8Encoding]::new($false))`) rather than
  a cmdlet's shorthand, because on 5.1 the default spelling is the one that adds the BOM.
- Under 7 the default for a cmdlet write is already UTF-8 without a BOM, so you often need no
  `-Encoding` argument at all - measured identical output with and without it.
- Under 5.1, reading a **UTF-8** file needs an explicit encoding: a bare `Get-Content` decodes with
  the system ANSI code page, so UTF-8 text arrives as mojibake. 7 defaults to UTF-8, so that
  direction of the trap is 5.1's alone - 7 makes the opposite mistake, on the ANSI file below.
- **A genuinely ANSI or GBK legacy file is the case where 5.1 was accidentally right and 7 is
  wrong.** 5.1 read it because the system ANSI code page was its default; 7 defaulted to UTF-8
  instead, so a bare `Get-Content` on that file now produces mojibake where it used to work.
  A GBK file behaves this way: `Get-Content -Raw` returns garbage, while
  `Get-Content -Raw -Encoding ansi` returns the original text correctly. So the fix exists and is
  one word - but note the code page is machine-specific (it happened to be 936 on the machine this was
  measured on), which is why
  the portable form is to find out what the file actually is rather than to hard-code a number.
  Upgrading is not unconditionally an improvement: identify the file's real encoding first.
- `[Console]::OutputEncoding` is **not** set to UTF-8 automatically by 7. 7 changed the default
  encoding for **files** and `$OutputEncoding` (what a pipeline feeds an external program), but
  reading an external program's stdout still follows the system code page, so set
  `[Console]::OutputEncoding` yourself when a native tool's output matters. Treat the reason as
  weakly evidenced - it is carried over from prior knowledge rather than measured, because the session
  it would have been measured in had both settings already reading `utf-8`; the earlier byte-level
  findings are the ones with measurements behind them.
- Keep one script's filename in **one variable** from creation to execution. A typo between where
  you wrote it and where you run it produces an error about the path, which invites a wrong
  diagnosis. Do not re-derive the path in a later statement.
- When in doubt, keep a generated `.ps1` pure ASCII: that removes the BOM question entirely.

## Move multi-line content through files, not arguments

The shell does **not** split a multi-line argument: it arrives as one argv element, newlines and
spaces intact, and node, python and `git commit -m` receive it whole. What breaks is something else -
`cmd.exe` truncates at the first newline, and a program that re-splits its own arguments will split
yours. So the failure is real but the mechanism is not the shell's, and a diagnosis built on "the
shell split my argument" will look in the wrong place. Passing a file removes the whole question,
which is why it is the safer habit for a commit message or a request body.

- For a commit message, a request body, or any multi-line argument: write the text to a file and
  pass the file.
- When the output of a native command looks like a PowerShell error, check whether it is really the
  native program's stderr being wrapped. The text inside is usually the real diagnosis.

## Calling PowerShell from PowerShell

A script string that has to survive both an outer and an inner PowerShell is where quoting stops
being tedious and starts being a defect.

- **The outer layer interpolates before the inner shell parses.** Measured here: with the inner text
  reaching the outer command through a double-quoted string, `"a" | "b"` reached the inner shell as
  `a | b` - the quotes were evaluated as empty expressions - and it then failed with a syntax error
  against the inner line you did write. The same inner text passed through a single-quoted outer string
  survived intact, so the layer boundary is not the problem; the outer interpolation is. **A pipe inside
  an interpolated inner script can be consumed before the inner shell ever sees it.**
- The fix is to nest with the inner script containing no quotes or pipes, to pass it as a
  single-quoted literal that nothing interpolates, or to hand the text over encoded so no layer
  can touch it.
- Reduce a nested failure to the smallest inner script that still fails and print what the inner
  shell actually received, rather than adding another layer of quoting.

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

- **To read link metadata, just ask for it.** `Get-Item` populates `LinkType` and `Target` on a
  junction or symlink with or without `-Force`. What `-Force` decides is whether a **hidden** item is
  returned at all - without it you get no item rather than an item without metadata. Measured on this
  machine with a real junction, hiding each end in turn: hiding the **target** leaves the link returned
  and readable (`Target` is still populated); hiding the **link** itself - the attribute then sits on
  the reparse point - makes it **not returned** without `-Force`, exactly like a plain hidden
  directory. So the link's own visibility is what decides, and a hidden link is invisible to a listing
  that omits hidden entries while the directory it points at is not.
- A link target may be an array. Take the first element and normalise it to a full path before
  comparing paths; also trim trailing separators on both sides before an equality test.
- **To remove a link, delete the link, not the tree.** A recursive delete that follows a link can
  walk into the target. Remove a directory link with the command that only unlinks.
- **A link that resolves to nothing is still a link.** Existence checks can report false for a
  dangling link, so probe the link metadata rather than the resolved path.
- Never let a broad cleaning command run in a tree whose directories are links: it writes through
  them. That applies to forced cleanups and forced checkouts.
- **Force the pipeline into an array before it reaches a consumer that distinguishes shape.** `.Count`
  does not need this - it returns `1` on a single item on both 7 and 5.1 - but a serialiser and an
  indexer do: `ConvertTo-Json` of a single item starts `{` where `@($one)` starts `[`, and a caller that
  expects an array breaks on the object.
- Directory listings omit hidden entries unless you ask for them, so "empty" can be wrong. Patterns
  with more than one extension need the recursive file form; a single filter takes one pattern.

## Calling native programs

- `$LASTEXITCODE` is set by the native call, so read it immediately after that call.
- **Zero is not always success.** Some tools define a range of success codes - a mirroring or copying
  tool typically treats small positive codes as non-fatal. Compare against the tool's own contract
  instead of `0`. winget is the live example in the upgrade section: the install that changed nothing
  returned a non-zero code while the install that succeeded returned `0`.
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
- **Windows PowerShell 5.1 only:** no conditional chaining (the double-ampersand and double-pipe
  forms), no null-coalescing operator or its assigning form, and no ternary. They fail at **parse**
  time - so nothing in the command runs, and `$LASTEXITCODE` still holds whatever the previous native
  call left in it. Measured: 5.1 rejected `$x ?? "d"` at parse time while 7.6 evaluated the same
  line. Under 7 these operators exist and the rule does not apply.
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
