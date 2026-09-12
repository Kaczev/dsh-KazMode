<#
install-kaz-preset.ps1 - Windows installer for the Kaz agent preset.

What it does:
  1. Resolves a DSH home (default: %USERPROFILE%\.dsh) and one profile inside it.
  2. Version-gates the runtime (supported: 0.1.5-rc.2 only).
  3. Mirrors the preset template (repo\test-kaz, node_modules excluded) into
     <DshHome>\.agent-presets\kaz.
  4. Creates/refreshes the two runtime junctions the preset needs:
       <preset>\node_modules\@deepseek-ai -> the home's WIDER runtime package tree,
                                            <DshHome>\profiles\node_modules\@deepseek-ai,
                                            so rows living only there (dsh-persona,
                                            dsh-tool-ask-user) stay resolvable; falls
                                            back to <DshHome>\profiles\<profile>\
                                            node_modules\@deepseek-ai when that wider
                                            tree carries no runtime package
       <preset>\node_modules\zod          -> <DshHome>\profiles\<profile>\node_modules\zod
  5. Backs up an existing preset to <DshHome>\tools\kaz-preset-backup-<timestamp>.

Usage:
  powershell -ExecutionPolicy Bypass -File .\install-kaz-preset.ps1
  powershell -ExecutionPolicy Bypass -File .\install-kaz-preset.ps1 -DshHome "$env:USERPROFILE\.dsh-test"
  powershell -ExecutionPolicy Bypass -File .\install-kaz-preset.ps1 -AllHomes -DryRun
  powershell -ExecutionPolicy Bypass -File .\install-kaz-preset.ps1 -Uninstall

Notes:
  - Windows only. ASCII only (PowerShell 5.1 safe).
  - Idempotent: re-run any time to update the preset; junctions are refreshed.
  - Multi-home: pass -DshHome per home, or use -AllHomes to install into every
    %USERPROFILE%\.dsh* home that has a profiles\ directory.
  - Supported runtime is 0.1.5-rc.2 only. -SkipVersionCheck is the deliberate
    rollback override (only for a user-chosen return to 0.1.5-rc.1, which also
    needs the launcher's EXPECTED_CLI set back); normal installs and updates
    must never use it.
  - Never run "git clean -fdx" or "git checkout -f" while test-kaz is a junction
    to a live preset; those commands would write through it.
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
$SupportedVersions = @('0.1.5-rc.2')

if ([string]::IsNullOrWhiteSpace($Source)) { $Source = Join-Path $PSScriptRoot 'test-kaz' }

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

function Install-OneHome([string]$TargetHome, [string]$WantedProfile) {
  $TargetHome = [System.IO.Path]::GetFullPath($TargetHome)
  if (-not (Test-Path $TargetHome)) { throw "DSH home not found: $TargetHome" }
  $profile = Resolve-ProfileName $TargetHome $WantedProfile
  Write-Step "== home: $TargetHome (profile: $profile)"
  $presetDir = Join-Path $TargetHome ".agent-presets\$PresetName"

  if ($Uninstall) {
    Write-Step "uninstall: $presetDir"
    if (Test-Path $presetDir) {
      if ($DryRun) { Write-Step "  would remove $presetDir" }
      else { Remove-Item $presetDir -Recurse -Force; Write-Step "  removed $presetDir" }
    } else {
      Write-Step "  not installed"
    }
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

  $sourcePath = [System.IO.Path]::GetFullPath($Source)
  if (-not (Test-Path $sourcePath)) { throw "preset source not found: $sourcePath" }
  $sourceItem = Get-Item $sourcePath -Force
  $sourceReal = $sourcePath
  if ($sourceItem.LinkType -and @($sourceItem.Target).Count -gt 0) {
    $sourceReal = [System.IO.Path]::GetFullPath([string]@($sourceItem.Target)[0])
  }
  $sameDirectory = $sourceReal.TrimEnd('\') -ieq $presetDir.TrimEnd('\')

  if (Test-Path $presetDir) {
    $backup = Join-Path $TargetHome ("tools\kaz-preset-backup-" + (Get-Date -Format 'yyyyMMddHHmmss'))
    Write-Step "  backup: $presetDir -> $backup"
    if (-not $DryRun) {
      New-Item -ItemType Directory -Force -Path $backup | Out-Null
      robocopy $presetDir $backup /E /XD node_modules /NFL /NDL /NJH /NJS /NP | Out-Null
      if ($LASTEXITCODE -gt 7) { throw "backup robocopy failed ($LASTEXITCODE)" }
    }
  }

  if ($sameDirectory) {
    Write-Step "  source and target are the same directory; skip file copy"
  } else {
    Write-Step "  copy: $sourceReal -> $presetDir (node_modules excluded)"
    if (-not $DryRun) {
      robocopy $sourceReal $presetDir /MIR /XD node_modules /NFL /NDL /NJH /NJS /NP | Out-Null
      if ($LASTEXITCODE -gt 7) { throw "preset robocopy failed ($LASTEXITCODE)" }
    }
  }

  $modulesDir = Join-Path $presetDir 'node_modules'
  $scopeTarget = Join-Path $TargetHome "profiles\$profile\node_modules\@deepseek-ai"
  $zodTarget = Join-Path $TargetHome "profiles\$profile\node_modules\zod"
  if (-not (Test-Path $scopeTarget)) { throw "runtime scope not found: $scopeTarget" }

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
  # itself); otherwise keep the profile scope, so a home without one still
  # installs exactly as before.
  $scopeCandidates = @(
    (Join-Path $TargetHome "profiles\node_modules\@deepseek-ai"),
    $scopeTarget
  )
  foreach ($candidate in $scopeCandidates) {
    $runtimeMarker = Join-Path $candidate 'dsh\package.json'
    if (Test-Path $runtimeMarker) {
      $scopeTarget = $candidate
      break
    }
  }

  $links = @(
    @{ Path = (Join-Path $modulesDir '@deepseek-ai'); Target = $scopeTarget; Required = $true },
    @{ Path = (Join-Path $modulesDir 'zod'); Target = $zodTarget; Required = $false }
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
  Write-Step "Next: restart dsh for this home, start a new conversation, and pick the Kaz preset."
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
