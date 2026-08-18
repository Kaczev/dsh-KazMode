#requires -Version 5.1
<#
.SYNOPSIS
  卸载 Kaz 模式插件（幂等，可重复运行；默认只"停用"，不删插件源码）。

.DESCRIPTION
  默认动作：
    1) 删除 profile node_modules 里指向本 profile plugins 目录的 junction（只删链接，不动源码）；
    2) 从 cordis.patch.yml 移除各插件的注册块（按 name: 行级匹配，只删对应 - insert: 块）；
    3) 从 settings.yaml 移除 10 个插件的配置段（thinking-anchor / round-minimal / tool-filter /
       tool-grouping / kaz-mode / kaz-memory / code-collapse / output-beep /
       task-master-whiteboard / round-display），并把 agent-presets.default=kaz 还原为
       standard（仅当当前值恰好是 kaz；其它值不动）；
    4) 删除已复制到 <DSH_HOME>\.agent-presets\kaz 的预设目录。

  可选参数：
    -RemoveFiles  连同 <profile>\plugins 源码目录一起删除；
    -KeepSettings 不碰 settings.yaml；
    -KeepPreset   不删 .agent-presets\kaz；
    -DryRun       只打印将要执行的动作，不写任何文件。

  注意：卸载后需重启 dsh web 才生效。

.EXAMPLE
  .\uninstall-kaz.ps1
  .\uninstall-kaz.ps1 -DshHome "C:\tmp\friend-dsh" -DryRun
  .\uninstall-kaz.ps1 -RemoveFiles -KeepSettings
#>
[CmdletBinding()]
param(
  [string]$DshHome = "",
  [string]$ProfileName = "web",
  [switch]$RemoveFiles,
  [switch]$KeepSettings,
  [switch]$KeepPreset,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Write-Step($msg)  { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "    WARN: $msg" -ForegroundColor Yellow }
function Write-Skip($msg)  { Write-Host "    skip: $msg" -ForegroundColor DarkGray }

# ---------- 路径解析（与 install-kaz.ps1 一致） ----------
if ([string]::IsNullOrWhiteSpace($DshHome)) {
  $envHome = [Environment]::GetEnvironmentVariable("DSH_HOME")
  if (-not [string]::IsNullOrWhiteSpace($envHome)) { $DshHome = $envHome }
  else { $DshHome = Join-Path $env:USERPROFILE ".dsh" }
}
$DshHome = [System.IO.Path]::GetFullPath($DshHome)
$ProfileDir    = Join-Path $DshHome (Join-Path "profiles" $ProfileName)
$TargetPlugins = Join-Path $ProfileDir "plugins"
$TargetNm      = Join-Path $ProfileDir "node_modules"
$PatchFile     = Join-Path $ProfileDir "cordis.patch.yml"
$SettingsFile  = Join-Path $DshHome "settings.yaml"
$TargetPreset  = Join-Path $DshHome ".agent-presets\kaz"

Write-Host "DSH home : $DshHome" -ForegroundColor Gray
Write-Host "Profile  : $ProfileName" -ForegroundColor Gray
if ($DryRun) { Write-Host "DRY RUN  : 不写任何文件" -ForegroundColor Magenta }

# ---------- 读/写文本（保留 BOM） ----------
function Read-TextFile($path) {
  $bytes = [System.IO.File]::ReadAllBytes($path)
  $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  $text = [System.IO.File]::ReadAllText($path)
  return @{ text = $text; bom = $hasBom }
}
function Write-TextFile($path, $text, $hasBom) {
  $enc = New-Object System.Text.UTF8Encoding($hasBom)
  [System.IO.File]::WriteAllText($path, $text, $enc)
}

# ---------- 1. 删除 junction ----------
Write-Step "删除 node_modules junction"
if (Test-Path $TargetPlugins) {
  foreach ($dir in Get-ChildItem $TargetPlugins -Directory) {
    $pkgJson = Join-Path $dir.FullName "package.json"
    if (-not (Test-Path $pkgJson)) { Write-Skip "$($dir.Name) 无 package.json，跳过"; continue }
    $pkgName = $dir.Name
    try {
      $pkg = Get-Content -Path $pkgJson -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($pkg.name -and $pkg.name -ne "") { $pkgName = [string]$pkg.name }
    } catch { $pkgName = $dir.Name }
    if ($pkgName -notmatch "^[a-z0-9][a-z0-9-]*$") { continue }
    $link = Join-Path $TargetNm $pkgName
    if (Test-Path $link) {
      $item = Get-Item $link -Force
      if ($item.LinkType -eq "Junction") {
        $t = [string]$item.Target
        if ($t.StartsWith($TargetPlugins, [System.StringComparison]::OrdinalIgnoreCase)) {
          Write-Ok "删除 junction: $pkgName"
          if (-not $DryRun) { cmd /c rmdir "$link" }
        } else {
          Write-Warn "junction 指向非本 profile plugins 目录（$t），跳过"
        }
      } else {
        Write-Warn "node_modules\$pkgName 是真实目录（非 junction），跳过"
      }
    } else { Write-Skip "junction 不存在: $pkgName" }
  }
} else { Write-Skip "plugins 目录不存在（$TargetPlugins）" }

$dq = [string][char]34

# ---------- 2. 移除 cordis.patch.yml 注册块 ----------
Write-Step "移除 cordis.patch.yml 注册块"
if (Test-Path $PatchFile) {
  $patch = Read-TextFile $PatchFile
  $lines = $patch.text.Split([char]10)
  $removedAny = $false
  foreach ($dir in Get-ChildItem $TargetPlugins -Directory) {
    $pkgJson = Join-Path $dir.FullName "package.json"
    if (-not (Test-Path $pkgJson)) { continue }
    $pkgName = $dir.Name
    try {
      $pkg = Get-Content -Path $pkgJson -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($pkg.name -and $pkg.name -ne "") { $pkgName = [string]$pkg.name }
    } catch { $pkgName = $dir.Name }
    if ($pkgName -notmatch "^[a-z0-9][a-z0-9-]*$") { continue }
    $kept = New-Object System.Collections.Generic.List[string]
    $i = 0
    $hit = $false
    while ($i -lt $lines.Count) {
      $line = $lines[$i].TrimEnd([char]13)
      if ($line -match "^\s*- insert:\s*$") {
        $j = $i + 1
        $blockLines = New-Object System.Collections.Generic.List[string]
        while ($j -lt $lines.Count -and $lines[$j] -match "^[ \t]") {
          $blockLines.Add($lines[$j].TrimEnd([char]13))
          $j++
        }
        $remove = $false
        foreach ($bl in $blockLines) {
          if ($bl -match ("^\s*name:\s*" + $pkgName + "\s*$")) { $remove = $true; break }
          if ($bl -match ("^\s*name:\s*[" + $dq + "']" + $pkgName + "[" + $dq + "']\s*$")) { $remove = $true; break }
        }
        if ($remove) {
          $hit = $true
          $removedAny = $true
          $i = $j
          continue
        }
        $kept.Add($line)
        for ($k = $i + 1; $k -lt $j; $k++) { $kept.Add($lines[$k]) }
        $i = $j
        continue
      }
      $kept.Add($line)
      $i++
    }
    if ($hit) {
      Write-Ok "移除注册块: $pkgName"
      $lines = $kept.ToArray()
    } else { Write-Skip "注册块不存在: $pkgName" }
  }
  if ($removedAny -and -not $DryRun) {
    $newText = [string]::Join([char]10, $lines)
    $hasAnyItem = ($lines | Where-Object { $_ -match "^\s*-" }).Count -gt 0
    if ([string]::IsNullOrWhiteSpace($newText) -or -not $hasAnyItem) {
      $newText = "# Your patch layer for this dsh profile, applied after every bundle layer:" + [char]10
      $newText += "# a top-level YAML array of loader patch entries (id-targeted config" + [char]10
      $newText += "# overrides, disables, and insert lists; !!js expressions allowed)." + [char]10
      $newText += "[]" + [char]10
    }
    Write-TextFile $PatchFile $newText $patch.bom
  }
} else { Write-Skip "cordis.patch.yml 不存在（$PatchFile）" }

# ---------- 3. 移除 settings.yaml 配置段 ----------
if (-not $KeepSettings) {
  Write-Step "移除 settings.yaml 配置段"
  if (Test-Path $SettingsFile) {
    $settings = Read-TextFile $SettingsFile
    $sLines = $settings.text.Split([char]10)
    $nsList = @(
      "thinking-anchor", "round-minimal", "tool-filter", "tool-grouping",
      "kaz-mode", "kaz-memory", "code-collapse", "output-beep",
      "task-master-whiteboard", "round-display"
    )
    foreach ($ns in $nsList) {
      $kept2 = New-Object System.Collections.Generic.List[string]
      $i = 0
      $hit2 = $false
      while ($i -lt $sLines.Count) {
        $line = $sLines[$i].TrimEnd([char]13)
        if ($line -match ("^" + $ns + ":\s*$")) {
          $j = $i + 1
          while ($j -lt $sLines.Count -and $sLines[$j] -match "^[ \t]") { $j++ }
          $hit2 = $true
          $i = $j
          continue
        }
        $kept2.Add($line)
        $i++
      }
      if ($hit2) {
        Write-Ok "移除配置段: $ns"
        $sLines = $kept2.ToArray()
      } else { Write-Skip "配置段不存在: $ns" }
    }
    # agent-presets.default=kaz -> standard（仅当恰好是 kaz）
    $kept3 = New-Object System.Collections.Generic.List[string]
    $i = 0
    $presetReset = $false
    while ($i -lt $sLines.Count) {
      $line = $sLines[$i].TrimEnd([char]13)
      if ($line -match "^agent-presets:\s*$") {
        $kept3.Add($line)
        $i++
        while ($i -lt $sLines.Count -and $sLines[$i] -match "^[ \t]") {
          $inner = $sLines[$i].TrimEnd([char]13)
          if ($inner -match "^\s*default:\s*kaz\s*$") {
            $kept3.Add("  default: standard")
            $presetReset = $true
            Write-Ok "agent-presets.default: kaz -> standard"
          } else {
            $kept3.Add($inner)
          }
          $i++
        }
        continue
      }
      $kept3.Add($line)
      $i++
    }
    $sLines = $kept3.ToArray()
    if (-not $DryRun) { Write-TextFile $SettingsFile ([string]::Join([char]10, $sLines)) $settings.bom }
    if (-not $presetReset) { Write-Skip "agent-presets.default 不是 kaz（或已还原），未改动" }
  } else { Write-Skip "settings.yaml 不存在（$SettingsFile）" }
} else { Write-Skip "-KeepSettings：跳过 settings.yaml" }

# ---------- 4. 删除 kaz 预设 ----------
if (-not $KeepPreset) {
  if (Test-Path $TargetPreset) {
    Write-Ok "删除预设目录: $TargetPreset"
    if (-not $DryRun) { Remove-Item $TargetPreset -Recurse -Force }
  } else { Write-Skip "预设目录不存在（$TargetPreset）" }
} else { Write-Skip "-KeepPreset：保留预设" }

# ---------- 5. 可选：删除 plugins 源码 ----------
if ($RemoveFiles) {
  if (Test-Path $TargetPlugins) {
    Write-Ok "删除插件源码目录: $TargetPlugins"
    if (-not $DryRun) { Remove-Item $TargetPlugins -Recurse -Force }
  } else { Write-Skip "plugins 目录不存在" }
} else {
  Write-Skip "保留插件源码（想连源码一起删，加 -RemoveFiles）"
}

# ---------- 6. 小结 ----------
Write-Host ""
Write-Host "========== 卸载完成 ==========" -ForegroundColor Green
if ($DryRun) { Write-Host "（DryRun：以上为将要执行的动作）" -ForegroundColor Magenta }
Write-Host "重启 dsh web 后，Kaz 模式开关与各插件 UI 将消失。"
Write-Host "想重新启用：重新运行 install-kaz.ps1 即可（幂等）。"
