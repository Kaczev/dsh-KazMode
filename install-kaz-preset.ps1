<#
install-kaz-preset.ps1 - Windows installer for the Kaz agent preset.

What it does:
  1. Resolves a DSH home (default: %USERPROFILE%\.dsh) and one profile inside it.
  2. Version-gates the runtime (supported: 0.1.5-rc.2 and 0.1.7-rc.2).
  3. Mirrors the preset source (repo\kaz = the released copy users install;
     pass -Source test-kaz to promote the test-area development copy instead)
     into <DshHome>\.agent-presets\kaz, node_modules excluded.
  4. Wires the preset into the profile the way THAT runtime accepts it:
       0.1.5-rc.2 - nothing more: the runtime still scans `.agent-presets\<name>`
                    for `preset.yml` + `agent.cordis.yml`.
       0.1.7-rc.2 - the directory scan is gone from the runtime, so the preset
                    arrives as a profile BUNDLE instead: the mirrored directory
                    gets a `package.json` declaring `dsh.bundle.patch` and a
                    generated `cordis.patch.yml` that declares the
                    `preset-kaz` row, the profile's `dsh.profile.bundles` gains
                    the bundle name, and a junction at
                    <profile>\node_modules\<bundle> points back at the preset
                    directory. The generated patch points the preset row's
                    plugins at the preset's own `agent.cordis.yml` through a
                    `cordis:include`, so the preset assembly keeps one home and
                    no file is duplicated.
  5. Creates/refreshes the runtime junction the preset needs on both paths:
        <preset>\node_modules\@deepseek-ai -> the first of these two trees that
                                             carries the runtime package dsh\
                                             package.json:
                                               <DshHome>\profiles\node_modules\
                                               @deepseek-ai (the wider tree, which
                                               also holds rows living only there,
                                               such as dsh-persona and
                                               dsh-tool-ask-user), else
                                               <DshHome>\profiles\<profile>\
                                               node_modules\@deepseek-ai
                                             A home with only the wider tree is
                                             healthy -- dsh boot never creates
                                             the profile scope -- so it installs
                                             normally.
  6. Backs up an existing preset to <DshHome>\tools\kaz-preset-backup-<timestamp>.

Usage:
  powershell -ExecutionPolicy Bypass -File .\install-kaz-preset.ps1
  powershell -ExecutionPolicy Bypass -File .\install-kaz-preset.ps1 -DshHome "$env:USERPROFILE\.dsh-test"
  powershell -ExecutionPolicy Bypass -File .\install-kaz-preset.ps1 -AllHomes -DryRun
  powershell -ExecutionPolicy Bypass -File .\install-kaz-preset.ps1 -Uninstall

Notes:
  - Windows only. ASCII only (PowerShell 5.1 safe).
  - Idempotent: re-run any time to update the preset; junctions are refreshed
    and the 0.1.7 wiring (manifest entries, generated patch, bundle link) is
    rebuilt from scratch each run.
  - Rollback: `-Uninstall` removes the preset directory AND, on a 0.1.7 home,
    the bundle wiring it added (bundle name, dependency entry, link). Setting
    only `dsh.profile.bundles` back by hand returns the home to exactly its
    pre-install composition, because no other file of the profile is touched.
  - Multi-home: pass -DshHome per home, or use -AllHomes to install into every
    %USERPROFILE%\.dsh* home that has a profiles\ directory.
  - Supported runtimes are 0.1.5-rc.2 and 0.1.7-rc.2. The gate reads each home's
    own runtime, so both are live at once: the main home .dsh still reads the
    global 0.1.5-rc.2 while the test home .dsh-test reads 0.1.7-rc.2 from its own
    pinned copy. -SkipVersionCheck is the deliberate
    rollback override (only for a user-chosen return to 0.1.5-rc.1, which also
    needs the launcher's EXPECTED_CLI set back); normal installs and updates
    must never use it.
  - The profile's own @deepseek-ai scope is not required: a home whose runtime is
    reached through <DshHome>\profiles\node_modules\@deepseek-ai only installs
    fine, because dsh's boot self-heal never creates the profile scope.
  - Never run "git clean -fdx" or "git checkout -f" while kaz or test-kaz is a
    junction to a live preset; those commands would write through it. The same
    care applies to this script's own robocopy: /MIR deletes extra files under
    <DshHome>\.agent-presets\kaz, so never point -DshHome at a home whose
    .agent-presets\kaz is a junction into a repository checkout.
#>
param(
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$ProfileName = '',
  [switch]$AllHomes,
  [switch]$DryRun,
  [switch]$Uninstall,
  [switch]$SkipVersionCheck,
  [string]$Source = ''
)

$ErrorActionPreference = 'Stop'
$PresetName = 'kaz'
$SupportedVersions = @('0.1.5-rc.2', '0.1.7-rc.2')

# The 0.1.7 delivery form: a bundle package that lives in the preset directory
# itself. BundleName must be a valid npm package name (dsh resolves it with
# createRequire().resolve.paths()) and BundleRowId is the profile row the
# generated patch inserts -- the preset's identity in the mode list is `kaz`,
# which is also the id agent.cordis.yml's Include patch targets.
$BundleName = 'kaz-preset-bundle'
$BundleRowId = 'preset-kaz'
$BundlePresetId = 'kaz'
$BundleOrder = 5

if ([string]::IsNullOrWhiteSpace($Source)) { $Source = Join-Path $PSScriptRoot 'kaz' }

function Write-Step([string]$Message) { Write-Host $Message }

function Get-RuntimeVersion([string]$TargetHome, [string]$Profile) {
  $candidates = New-Object System.Collections.ArrayList
  [void]$candidates.Add((Join-Path $TargetHome 'tools\dsh-cli\node_modules\@deepseek-ai\dsh\package.json'))
  if (-not [string]::IsNullOrWhiteSpace($Profile)) {
    [void]$candidates.Add((Join-Path $TargetHome "profiles\$Profile\node_modules\@deepseek-ai\dsh\package.json"))
  }
  [void]$candidates.Add((Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\package.json'))
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      try {
        $version = (Get-Content $candidate -Raw | ConvertFrom-Json).version
        if (-not [string]::IsNullOrWhiteSpace($version)) {
          return @{ Version = $version; Path = $candidate }
        }
      } catch { }
    }
  }
  return $null
}

function Resolve-ProfileName([string]$TargetHome, [string]$Wanted) {
  $profilesDir = Join-Path $TargetHome 'profiles'
  if (-not (Test-Path $profilesDir)) { throw "no profiles directory under $TargetHome" }
  $profiles = @(Get-ChildItem $profilesDir -Directory -Force | Where-Object { Test-Path (Join-Path $_.FullName 'node_modules') })
  if ($Wanted -ne '') {
    if (@($profiles | Where-Object { $_.Name -eq $Wanted }).Count -eq 1) { return $Wanted }
    throw "profile '$Wanted' not found under $profilesDir"
  }
  if ($profiles.Count -eq 1) { return $profiles[0].Name }
  $names = ($profiles | ForEach-Object { $_.Name }) -join ', '
  throw "multiple profiles under ${TargetHome}: $names ; pass -ProfileName"
}

function Clear-LinkPath([string]$Path, [bool]$WhatIfOnly) {
  if (-not (Test-Path $Path)) {
    # May be a dangling junction; rmdir is harmless if it is not there.
    if (-not $WhatIfOnly) { try { cmd /c rmdir "$Path" 2>&1 | Out-Null } catch { } }
    return
  }
  $item = Get-Item $Path -Force
  if ($item.LinkType) {
    if ($WhatIfOnly) { Write-Step "  would refresh link: $Path" } else { cmd /c rmdir "$Path" | Out-Null }
    return
  }
  if ($item.PSIsContainer) {
    if (@(Get-ChildItem $Path -Force).Count -eq 0) {
      if (-not $WhatIfOnly) { Remove-Item $Path -Force }
      return
    }
    throw "cannot replace non-empty real directory: $Path"
  }
  throw "cannot replace file: $Path"
}

# A file URL for a Windows path, as the loader's YAML wants it: `file:///C:/dir/file`.
function ConvertTo-FileUrl([string]$Path) {
  $full = [System.IO.Path]::GetFullPath($Path).Replace('\', '/')
  if (-not $full.StartsWith('/')) { $full = '/' + $full }
  return 'file://' + $full
}

function Read-JsonFile([string]$Path) {
  return (Get-Content $Path -Raw | ConvertFrom-Json)
}

function Write-TextFile([string]$Path, [string]$Text, [bool]$WhatIfOnly, [string]$Label) {
  if ($WhatIfOnly) {
    Write-Step "  would write: $Label"
    return
  }
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
  Write-Step "  wrote: $Label"
}

# The profile manifest belongs to the user, so it is edited in place rather
# than re-serialized: a JSON round trip through ConvertTo-Json reorders keys
# (observed: `patchReload` jumped ahead of `bundles`) and reformats the whole
# document, which turns a one-line change into a diff the user has to read.
# These two functions splice exactly one line into, or out of, the `bundles`
# array. They assume that array is written one entry per line -- true of every
# manifest dsh's own initProfile writes and of this machine's profiles -- and
# they verify the result still parses before anything is written.
function Set-ProfileBundleEntry([string]$ProfileJsonPath, [bool]$WhatIfOnly) {
  $text = [System.IO.File]::ReadAllText($ProfileJsonPath)
  $manifest = $text | ConvertFrom-Json
  $bundles = @()
  if ($null -ne $manifest.dsh.profile.bundles) { $bundles = @($manifest.dsh.profile.bundles) }
  if ($bundles -contains $BundleName) {
    Write-Step "  profile bundles already list $BundleName"
    return
  }
  $match = [Regex]::Match($text, '(?m)^(?<indent>\s*)"bundles"\s*:\s*\[\s*(?<eol>\r?\n)')
  if (-not $match.Success) {
    throw "cannot wire the bundle: no multi-line 'bundles' array in $ProfileJsonPath; add '$BundleName' to dsh.profile.bundles by hand"
  }
  $entry = "$($match.Groups['indent'].Value)    " + '"' + $BundleName + '",' + $match.Groups['eol'].Value
  $updated = $text.Insert($match.Index + $match.Length, $entry)
  $null = $updated | ConvertFrom-Json
  # No `dependencies` entry is added on purpose. The loader resolves a bundle
  # name through the node_modules link, not through the manifest, and an
  # unmatched dependency would make the next `pnpm install` inside the profile
  # rewrite pnpm-lock.yaml -- a change the user did not ask for.
  Write-Step "  profile bundles += $BundleName"
  Write-TextFile $ProfileJsonPath $updated $WhatIfOnly "profile manifest -> dsh.profile.bundles gains $BundleName ($ProfileJsonPath)"
}

function Remove-ProfileBundleEntry([string]$ProfileJsonPath, [bool]$WhatIfOnly) {
  $text = [System.IO.File]::ReadAllText($ProfileJsonPath)
  $manifest = $text | ConvertFrom-Json
  $bundles = @()
  if ($null -ne $manifest.dsh.profile.bundles) { $bundles = @($manifest.dsh.profile.bundles) }
  if ($bundles -notcontains $BundleName) {
    Write-Step "  profile manifest already free of $BundleName"
    return
  }
  # An entry that is not last leaves its own comma behind on the line above it.
  $updated = [Regex]::Replace($text, '(?m)^[ \t]*"' + [Regex]::Escape($BundleName) + '",?[ \t]*\r?\n', '')
  $updated = [Regex]::Replace($updated, ',(?<trail>\s*\]\s*)\z', '${trail}')
  $null = $updated | ConvertFrom-Json
  Write-Step "  profile bundles -= $BundleName"
  Write-TextFile $ProfileJsonPath $updated $WhatIfOnly "profile manifest -> dsh.profile.bundles loses $BundleName ($ProfileJsonPath)"
}

# The generated bundle patch. It is deliberately the same text on every install:
# the only values that vary are the preset's display name/description and one
# absolute path, which dsh needs as an absolute file URL (a relative `path`
# resolves against the composing patch document in a config dump but against the
# process working directory on a real mount, and those two anchors disagree).
#
# `name` and `description` are copied out of the preset's own `preset.yml`: the
# mode list renders them and falls back to printing the raw preset id without
# them, so dropping them would make the row show up as "kaz".
function Get-PresetYamlScalar([string]$PresetDir, [string]$Key) {
  $path = Join-Path $PresetDir 'preset.yml'
  if (-not (Test-Path $path)) { return '' }
  # preset.yml is a two-line file whose values are scalars; `name: Kaz 模式` and
  # `description: ...`. Only those two keys are read here -- a value containing a
  # colon or a newline would need a real YAML parser, and this is not one.
  $pattern = '^\s*' + [Regex]::Escape($Key) + '\s*:\s*(.*)$'
  foreach ($line in (Get-Content $path -Encoding UTF8)) {
    $match = [Regex]::Match($line, $pattern)
    if ($match.Success) {
      return $match.Groups[1].Value.Trim().Trim('"').Trim("'")
    }
  }
  return ''
}

# The preset's own composition rows, indented and path-rewritten to become the
# `plugins` list of the generated `preset-kaz` row.
#
# Two things a plain copy would get wrong, both measured on dsh 0.1.7-rc.2:
#
#   * The rows must BE rows. A preset's `plugins` is a list of plugin rows and
#     `entryListProblem` rejects anything else: an Include row in that position
#     registered the preset but marked it
#     `broken: row 1 names no plugin (a "name" string is required)`, and the mode
#     picker hides a broken preset, so Kaz never reached the list. Every shipped
#     preset inlines its rows the same way.
#   * A relative `name:` must become an absolute file URL. With
#     `./kaz-system-prompt.mjs` and friends left relative, every local row
#     reported `never started` in the roster while the package rows beside them
#     mounted fine; with the same rows pointing at `file:///...` URLs the whole
#     preset came up `active`. Bare package names (`@deepseek-ai/...`) are left
#     alone -- they resolve through the preset's own `node_modules` junction.
#
# Only the `!!js` skills directory expression keeps a relative anchor, because
# it is evaluated with `baseUrl` bound to this file's directory: the Loader's
# resolution base for a row IS the row's own directory, so `new URL('skills/',
# baseUrl)` still lands inside the preset.
function Get-PresetRows([string]$PresetDir) {
  $path = Join-Path $PresetDir 'agent.cordis.yml'
  if (-not (Test-Path $path)) { throw "preset composition not found: $path" }
  $baseUrl = ConvertTo-FileUrl $PresetDir
  if (-not $baseUrl.EndsWith('/')) { $baseUrl += '/' }
  $shifted = New-Object System.Collections.ArrayList
  foreach ($line in [System.IO.File]::ReadAllLines($path)) {
    # Comments and blank lines are dropped: the generated patch is machine-owned
    # and rewritten on every install, so carrying the source's prose would only
    # duplicate it. The source file keeps the explanations.
    if ($line -match '^\s*#') { continue }
    if ($line.Trim() -eq '') { continue }
    $row = $line -replace '^(\s*name:\s*)\./', ('${1}' + $baseUrl)
    [void]$shifted.Add('        ' + $row)
  }
  if ($shifted.Count -eq 0) { throw "preset composition is empty: $path" }
  return $shifted
}

function Get-BundlePatchText([string]$PresetDir) {
  $rows = Get-PresetRows $PresetDir
  $lines = New-Object System.Collections.ArrayList
  [void]$lines.Add('# Generated by install-kaz-preset.ps1 -- do not edit by hand; re-run the installer.')
  [void]$lines.Add('#')
  [void]$lines.Add('# dsh 0.1.7-rc.2 dropped the runtime''s `.agent-presets\<name>` scan, so the preset')
  [void]$lines.Add('# reaches the profile as this bundle instead: the `preset-kaz` row below declares')
  [void]$lines.Add('# the preset for the mode picker. Its `plugins` are a copy of the preset''s own')
  [void]$lines.Add('# `agent.cordis.yml` with the local rows rewritten to absolute file URLs -- copied')
  [void]$lines.Add('# rather than included, because a preset''s plugins must be plugin rows, and made')
  [void]$lines.Add('# absolute because relative names in that position never start. The source file')
  [void]$lines.Add('# remains the single home of the composition; this file is generated from it.')
  [void]$lines.Add('- insert:')
  [void]$lines.Add("    - id: $BundleRowId")
  [void]$lines.Add("      name: '@deepseek-ai/dsh-agent-preset'")
  [void]$lines.Add('      config:')
  [void]$lines.Add("        id: $BundlePresetId")
  $displayName = Get-PresetYamlScalar $PresetDir 'name'
  if ($displayName -ne '') { [void]$lines.Add("        name: '$($displayName.Replace("'", "''"))'") }
  $description = Get-PresetYamlScalar $PresetDir 'description'
  if ($description -ne '') { [void]$lines.Add("        description: '$($description.Replace("'", "''"))'") }
  [void]$lines.Add("        order: $BundleOrder")
  [void]$lines.Add('        plugins:')
  foreach ($row in $rows) { [void]$lines.Add($row) }
  return (($lines -join "`n") + "`n")
}

function Get-BundlePackageText([string]$Version) {
  # No peerDependencies on purpose: the loader silently SKIPS a bundle whose
  # @deepseek-ai/dsh-* peers the running runtime does not satisfy, and this
  # bundle ships with the runtime rather than depending on it.
  $manifest = [ordered]@{
    name = $BundleName
    version = $Version
    private = $true
    dsh = [ordered]@{ bundle = [ordered]@{ patch = @('./cordis.patch.yml') } }
  }
  return ($manifest | ConvertTo-Json -Depth 8) + "`n"
}

function Install-LegacyDelivery([string]$PresetDir, [string]$PresetVersion, [bool]$WhatIfOnly, [string]$SourceReal, [bool]$SameDirectory) {
  # 0.1.5-rc.2: the runtime scans `.agent-presets\<name>` itself; files are the
  # whole delivery, and only the runtime junction below has to be maintained.
  Write-Step "  delivery: 0.1.5 directory scan (.agent-presets\$PresetName)"
  if ($SameDirectory) {
    Write-Step "  source and target are the same directory; skip file copy"
  } else {
    Write-Step "  copy: $SourceReal -> $PresetDir (node_modules excluded)"
    if (-not $WhatIfOnly) {
      robocopy $SourceReal $PresetDir /MIR /XD node_modules /NFL /NDL /NJH /NJS /NP | Out-Null
      if ($LASTEXITCODE -gt 7) { throw "preset robocopy failed ($LASTEXITCODE)" }
    }
  }
}

function Install-BundleDelivery([string]$TargetHome, [string]$Profile, [string]$PresetDir, [string]$PresetVersion, [bool]$WhatIfOnly, [string]$SourceReal, [bool]$SameDirectory) {
  Write-Step "  delivery: 0.1.7 profile bundle ($BundleName)"
  if ($SameDirectory) {
    Write-Step "  source and target are the same directory; skip file copy"
  } else {
    Write-Step "  copy: $SourceReal -> $PresetDir (node_modules excluded)"
    if (-not $WhatIfOnly) {
      robocopy $SourceReal $PresetDir /MIR /XD node_modules /NFL /NDL /NJH /NJS /NP | Out-Null
      if ($LASTEXITCODE -gt 7) { throw "preset robocopy failed ($LASTEXITCODE)" }
    }
  }

  $patchPath = Join-Path $PresetDir 'cordis.patch.yml'
  $packagePath = Join-Path $PresetDir 'package.json'
  Write-Step "  write: $packagePath"
  Write-Step "  write: $patchPath"
  if (-not $WhatIfOnly) {
    [System.IO.File]::WriteAllText($packagePath, (Get-BundlePackageText $PresetVersion), (New-Object System.Text.UTF8Encoding($false)))
    [System.IO.File]::WriteAllText($patchPath, (Get-BundlePatchText $PresetDir), (New-Object System.Text.UTF8Encoding($false)))
  }

  $profileDir = Join-Path $TargetHome "profiles\$Profile"
  Set-ProfileBundleEntry (Join-Path $profileDir 'package.json') $WhatIfOnly

  $linkPath = Join-Path $profileDir "node_modules\$BundleName"
  Clear-LinkPath $linkPath $WhatIfOnly
  if ($WhatIfOnly) {
    Write-Step "  would link: $linkPath -> $PresetDir"
  } else {
    New-Item -ItemType Junction -Path $linkPath -Target $PresetDir | Out-Null
    Write-Step "  linked: $linkPath -> $PresetDir"
  }
}

function Uninstall-BundleDelivery([string]$TargetHome, [string]$Profile, [bool]$WhatIfOnly) {
  $profileDir = Join-Path $TargetHome "profiles\$Profile"
  $manifestPath = Join-Path $profileDir 'package.json'
  if (Test-Path $manifestPath) {
    $manifest = Read-JsonFile $manifestPath
    $listed = $false
    if ($null -ne $manifest.dsh.profile.bundles) {
      $listed = @($manifest.dsh.profile.bundles) -contains $BundleName
    }
    $linked = Test-Path (Join-Path $profileDir "node_modules\$BundleName")
    if (-not ($listed -or $linked)) {
      Write-Step "  bundle wiring: not installed"
      return
    }
    Remove-ProfileBundleEntry $manifestPath $WhatIfOnly
    Clear-LinkPath (Join-Path $profileDir "node_modules\$BundleName") $WhatIfOnly
    if ($WhatIfOnly) { Write-Step "  would remove bundle link" }
    else { Write-Step "  removed bundle link" }
  }
}

function Install-OneHome([string]$TargetHome, [string]$WantedProfile) {
  $TargetHome = [System.IO.Path]::GetFullPath($TargetHome)
  if (-not (Test-Path $TargetHome)) { throw "DSH home not found: $TargetHome" }
  $profile = Resolve-ProfileName $TargetHome $WantedProfile
  Write-Step "== home: $TargetHome (profile: $profile)"
  $presetDir = Join-Path $TargetHome ".agent-presets\$PresetName"

  if ($Uninstall) {
    Write-Step "uninstall: $presetDir"
    if (Test-Path $presetDir) {
      $item = Get-Item $presetDir -Force
      if ($item.LinkType) {
        # The preset directory is reached through a junction: robocopy /MIR into
        # it would rewrite whatever it points at, so stop instead of guessing.
        throw "refusing to uninstall: $presetDir is a $($item.LinkType) to $(@($item.Target)[0]); remove the link by hand if that is really wanted"
      }
      if ($DryRun) { Write-Step "  would remove $presetDir" }
      else { Remove-Item $presetDir -Recurse -Force; Write-Step "  removed $presetDir" }
    } else {
      Write-Step "  not installed"
    }
    Uninstall-BundleDelivery $TargetHome $profile $DryRun.IsPresent
    if (-not $DryRun) { Write-Step "KAZ-PRESET-UNINSTALL OK - $TargetHome" }
    return
  }

  $runtime = Get-RuntimeVersion $TargetHome $profile
  if ($null -eq $runtime) {
    Write-Step "  runtime dsh version: NOT FOUND"
  } else {
    Write-Step "  runtime dsh version: $($runtime.Version)  ($($runtime.Path))"
  }
  if (-not $SkipVersionCheck) {
    $version = if ($null -eq $runtime) { '' } else { $runtime.Version }
    if ($SupportedVersions -notcontains $version) {
      throw ("VERSION GATE: FAIL - runtime dsh '" + $version + "' is not supported (supported: " + ($SupportedVersions -join ', ') + "). Use -SkipVersionCheck to override.")
    }
  }
  $runtimeVersion = if ($null -eq $runtime) { '' } else { $runtime.Version }

  $sourcePath = [System.IO.Path]::GetFullPath($Source)
  if (-not (Test-Path $sourcePath)) { throw "preset source not found: $sourcePath" }
  $sourceItem = Get-Item $sourcePath -Force
  $sourceReal = $sourcePath
  if ($sourceItem.LinkType -and @($sourceItem.Target).Count -gt 0) {
    $sourceReal = [System.IO.Path]::GetFullPath([string]@($sourceItem.Target)[0])
  }
  $sameDirectory = $sourceReal.TrimEnd('\') -ieq $presetDir.TrimEnd('\')

  $presetVersion = 'unknown'
  $versionFile = Join-Path $sourcePath 'VERSION'
  if (Test-Path $versionFile) { $presetVersion = (Get-Content $versionFile -Raw).Trim() }

  if (Test-Path $presetDir) {
    $backup = Join-Path $TargetHome ("tools\kaz-preset-backup-" + (Get-Date -Format 'yyyyMMddHHmmss'))
    Write-Step "  backup: $presetDir -> $backup"
    if (-not $DryRun) {
      New-Item -ItemType Directory -Force -Path $backup | Out-Null
      robocopy $presetDir $backup /E /XD node_modules /NFL /NDL /NJH /NJS /NP | Out-Null
      if ($LASTEXITCODE -gt 7) { throw "backup robocopy failed ($LASTEXITCODE)" }
    }
  }

  if ($runtimeVersion -eq '0.1.7-rc.2') {
    Install-BundleDelivery $TargetHome $profile $presetDir $presetVersion $DryRun.IsPresent $sourceReal $sameDirectory
  } else {
    Install-LegacyDelivery $presetDir $presetVersion $DryRun.IsPresent $sourceReal $sameDirectory
  }

  $modulesDir = Join-Path $presetDir 'node_modules'
  $profileScope = Join-Path $TargetHome "profiles\$profile\node_modules\@deepseek-ai"

  # Which package tree the preset's @deepseek-ai junction must point at.
  #
  # The preset resolves a row's package name from its OWN node_modules first,
  # so this junction is the one lookup that decides what the preset can see --
  # and a link shadowing a parent directory stops the upward walk there. In a
  # home whose runtime is complete, <home>\profiles\<profile>\node_modules\
  # @deepseek-ai may hold only the subset that profile installed, while rows
  # such as dsh-persona / dsh-tool-ask-user exist solely in the wider
  # <home>\profiles\node_modules\@deepseek-ai beside it -- pointing at the
  # subset makes those rows unresolvable (Kaz 8.0 needs both). Prefer the wider
  # tree when it is a real Node resolution root (it carries the runtime package
  # itself); otherwise take the profile layer.
  #
  # The profile layer is NOT something dsh creates: dsh boot only heals the
  # wider <home>\profiles\node_modules and links bundles that sit outside the
  # dsh installation closure -- and both shipped web bundles (dsh-base,
  # dsh-web-app) are inside it, so a profile that was auto-initialized and never
  # had a package manager run inside it legitimately has no profile scope at
  # all. Its runtime is still complete, because every bundle resolves from the
  # dsh installation and the installation closure is reached through the wider
  # tree. So requiring the profile scope would reject a healthy home; the wider
  # tree is enough to install, and it is the tree the junction should point at
  # on such a home anyway, exactly as it does on a home that has both.
  $scopeCandidates = @(
    (Join-Path $TargetHome "profiles\node_modules\@deepseek-ai"),
    $profileScope
  )
  $scopeTarget = ''
  foreach ($candidate in $scopeCandidates) {
    if (Test-Path (Join-Path $candidate 'dsh\package.json')) {
      $scopeTarget = $candidate
      break
    }
  }
  if ([string]::IsNullOrEmpty($scopeTarget)) {
    # No candidate carries the runtime package: accept one that exists only if
    # the other does not, so a partially installed home still installs and the
    # downstream required-target check reports the exact path.
    foreach ($candidate in $scopeCandidates) {
      if (Test-Path $candidate) {
        $scopeTarget = $candidate
        break
      }
    }
  }
  if ([string]::IsNullOrEmpty($scopeTarget)) {
    throw "runtime scope not found: neither $($scopeCandidates[0]) nor $($scopeCandidates[1]) exists; install or repair the dsh runtime for this home first"
  }

  $links = @(
    @{ Path = (Join-Path $modulesDir '@deepseek-ai'); Target = $scopeTarget; Required = $true }
  )
  if (-not $DryRun) { New-Item -ItemType Directory -Force -Path $modulesDir | Out-Null }
  foreach ($link in $links) {
    if (-not (Test-Path $link.Target)) {
      if ($link.Required) { throw "required runtime package missing: $($link.Target)" }
      Write-Step "  WARN: optional runtime package missing: $($link.Target)"
      continue
    }
    Clear-LinkPath $link.Path $DryRun.IsPresent
    if ($DryRun) {
      Write-Step "  would link: $($link.Path) -> $($link.Target)"
    } else {
      New-Item -ItemType Junction -Path $link.Path -Target $link.Target | Out-Null
      Write-Step "  linked: $($link.Path) -> $($link.Target)"
    }
  }

  Write-Step "KAZ-PRESET-INSTALL OK - $TargetHome ($profile)"
  if ($runtimeVersion -eq '0.1.7-rc.2') {
    Write-Step "Next: restart dsh for this home, start a new conversation, and pick Kaz ($BundlePresetId) from the mode list."
  } else {
    Write-Step "Next: restart dsh for this home, start a new conversation, and pick the Kaz preset."
  }
}

if ($AllHomes) {
  $homes = @(Get-ChildItem $env:USERPROFILE -Directory -Force | Where-Object {
    $_.Name -like '.dsh*' -and (Test-Path (Join-Path $_.FullName 'profiles'))
  } | ForEach-Object { $_.FullName })
  if ($homes.Count -eq 0) { throw 'no .dsh* homes with a profiles directory found' }
  $summary = @()
  foreach ($h in $homes) {
    try {
      Install-OneHome $h $ProfileName
      $summary += "OK   $h"
    } catch {
      $summary += "FAIL $h :: $($_.Exception.Message)"
      Write-Step "FAIL $h :: $($_.Exception.Message)"
    }
  }
  Write-Step '--- summary ---'
  $summary | ForEach-Object { Write-Step $_ }
} else {
  Install-OneHome $DshHome $ProfileName
}
