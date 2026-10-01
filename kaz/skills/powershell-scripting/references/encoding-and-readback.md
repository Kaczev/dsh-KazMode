# Encoding, and reading the output back

A write can exit 0 and still put bytes in the file that no other tool will read. This file holds the
readback rules, the encoding decisions they apply to, and Step 5 of the upgrade ladder in
`references\upgrade-to-7.md` - the byte-level probe that judges both.

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
  in its own encoding and both may read their own output cleanly. For that ask for the bytes, which
  is what Step 5 below does.

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
  (`[System.IO.File]::WriteAllText($path, $text, [System.Text.UTF8Encoding]::new($false))`) rather
  than a cmdlet's shorthand, because on 5.1 the default spelling is the one that adds the BOM.
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
  one word - but note the code page is machine-specific (it happened to be 936 on the machine this
  was measured on), which is why the portable form is to find out what the file actually is rather
  than to hard-code a number. Upgrading is not unconditionally an improvement: identify the file's
  real encoding first.
- `[Console]::OutputEncoding` is **not** set to UTF-8 automatically by 7. 7 changed the default
  encoding for **files** and `$OutputEncoding` (what a pipeline feeds an external program), but
  reading an external program's stdout still follows the system code page, so set
  `[Console]::OutputEncoding` yourself when a native tool's output matters. Treat the reason as
  weakly evidenced - it is carried over from prior knowledge rather than measured, because the
  session it would have been measured in had both settings already reading `utf-8`; the earlier
  byte-level findings are the ones with measurements behind them.
- Keep one script's filename in **one variable** from creation to execution. A typo between where
  you wrote it and where you run it produces an error about the path, which invites a wrong
  diagnosis. Do not re-derive the path in a later statement.
- When in doubt, keep a generated `.ps1` pure ASCII: that removes the BOM question entirely.

## Step 5 - Verify with the shell, not with the exit code

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
system ANSI code page, which was 936 on that machine. The ASCII tail is identical in both, so **a test
value needs non-ASCII characters or it proves nothing.**

A readback cannot make this distinction, and it is worth knowing why: 5.1 reading back its own GBK
file inside the same process returns clean text, because each process decodes in its own encoding.
`[System.Text.Encoding]::Default` is `gb2312` under 5.1 and `utf-8` under 7, so text that round-trips
cleanly under either shell tells you nothing about which one wrote it. The bytes are the evidence.
