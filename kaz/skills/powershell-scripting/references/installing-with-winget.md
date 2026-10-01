# Installing PowerShell 7 with winget, and making it take effect

Step 3 and Step 4 of the ladder in `references\upgrade-to-7.md`, which holds the probe, the flavour
decision and what may be reported afterwards.

## Step 3 - Install, and expect a non-zero exit on a healthy machine

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
  even for a non-number, so a clean lookup is not evidence that a code is real, and its answer for
  `0` is canned text rather than independent evidence. `0` is the success value because that is the
  installer's contract. A vendor documentation page for these codes is not where they live - the
  table is generated from the same tool, which is why carrying the codes you need beats pointing at
  a page that may not be there.

## Step 4 - Make it take effect

**Installing is not the same as taking effect, and this is the most common failure.** A caller that
resolved the shell path at startup keeps running 5.1 after a successful 7 install, silently - the
install exit code is 0 and `pwsh` on the PATH is fine.

- A caller that looks `pwsh` up every time is fixed by restarting it.
- A caller that cached the path needs a restart, or an explicit configuration change - installing
  alone does nothing for it.
- A restart may be the only lever, and it may not be available from inside the session that would
  have to perform it. Say so at Step 6 rather than reporting success.
