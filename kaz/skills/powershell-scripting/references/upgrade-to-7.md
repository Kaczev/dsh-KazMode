# Upgrading a machine from Windows PowerShell 5.1 to PowerShell 7

Six steps: probe, decide, install, make it take effect, verify, report. The fastest route is
winget, but **which flavour gets installed is a decision, not a default.**

This file carries the probe (Step 1), the decision (Step 2) and the report (Step 6). Step 3, the
winget invocation and its exit codes, and Step 4, making the install take effect, are in
`references\installing-with-winget.md`. Step 5, the verification, is in
`references\encoding-and-readback.md`, because judging a write means reading its bytes.

## Step 1 - Probe

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
MSIX row held: `$PSHOME` was
`C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe`, the matching path
was the resolved `pwsh` and the running process image. That is one machine's answer, not part of
the mapping - check your own `$PSHOME` against the table. The MSI, global-tool and ZIP rows have not
been seen, so treat them as the mapping to test, not as results.

## Step 2 - Decide the flavour

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

## Step 6 - Report what was verified and what was not

Never claim the shell changed on the strength of the installer's exit code, and never claim a step
worked when it was only read about. State plainly: which flavour is installed, whether the caller
actually changed over, which checks you ran, and what you could not confirm. "Upgrade complete" with
Step 4 skipped is the characteristic false report.

Say that the way back exists, because a machine can have a workflow that depends on the old default:
PowerShell 5.1 was never touched, and removing 7 returns the shell to it. That is the sentence to
reach for when the caller that still has to work cannot be changed - not a configuration hack, and
never a suggestion to remove 5.1.

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
