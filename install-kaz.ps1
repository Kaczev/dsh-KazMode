#requires -Version 5.1
<#
.SYNOPSIS
  Kaz 模式插件一键接入 DSH（幂等，可重复运行；绝不覆盖已有配置）。

.DESCRIPTION
  做四件事：
    1) 把分发包里的 plugins\ 目录复制到 <DSH_HOME>\profiles\<ProfileName>\plugins
       （目标已存在的插件目录会跳过，不会覆盖你改过的源码）；
    2) 把分发包里的 .agent-presets\kaz 预设复制到 <DSH_HOME>\.agent-presets\kaz
       （已存在则跳过）；
    3) 为 plugins 下每个插件包在 profile 的 node_modules 里创建 junction
       （已存在且指向正确则跳过；指向错误会重建；是真实目录则警告跳过）；
    4) 把缺失的注册行追加到 <DSH_HOME>\profiles\<ProfileName>\cordis.patch.yml
       （按 name: 行级精确匹配，已存在则跳过；文件不存在会自动创建）。

  settings.yaml 的配置段不需要手动写：插件加载时会自动补齐缺失的键
  （只补缺失键，保留你已有的配置；文件不存在时由 settings 服务自动创建）。

.PARAMETER DshHome
  DSH 主目录。默认：$env:DSH_HOME（若设置），否则 %USERPROFILE%\.dsh。

.PARAMETER ProfileName
  目标 profile 名，默认 web。

.PARAMETER SourceDir
  分发包根目录（包含 plugins\ 与 .agent-presets\kaz）。默认：脚本所在目录。

.PARAMETER DryRun
  只打印将要执行的动作，不写任何文件。

.EXAMPLE
  # 把 Kaz 分发包整个解压后，在包内执行：
  .\install-kaz.ps1
  # 或指定目标（比如先在一个测试目录里验证）：
  .\install-kaz.ps1 -DshHome "C:\tmp\friend-dsh" -DryRun
#>
[CmdletBinding()]
param(
  [string]$DshHome = "",
  [string]$ProfileName = "web",
  [string]$SourceDir = "",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Step($msg)  { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "    WARN: $msg" -ForegroundColor Yellow }
function Write-Skip($msg)  { Write-Host "    skip: $msg" -ForegroundColor DarkGray }

# ---------- 1. 路径解析 ----------
if ([string]::IsNullOrWhiteSpace($DshHome)) {
  $envHome = [Environment]::GetEnvironmentVariable("DSH_HOME")
  if (-not [string]::IsNullOrWhiteSpace($envHome)) { $DshHome = $envHome }
  else { $DshHome = Join-Path $env:USERPROFILE ".dsh" }
}
$DshHome = [System.IO.Path]::GetFullPath($DshHome)
if ([string]::IsNullOrWhiteSpace($SourceDir)) { $SourceDir = $PSScriptRoot }
$SourceDir = [System.IO.Path]::GetFullPath($SourceDir)

$ProfileDir   = Join-Path $DshHome (Join-Path "profiles" $ProfileName)
$TargetPlugins = Join-Path $ProfileDir "plugins"
$TargetNm     = Join-Path $ProfileDir "node_modules"
$PatchFile    = Join-Path $ProfileDir "cordis.patch.yml"
$TargetPreset = Join-Path $DshHome ".agent-presets\kaz"
$SourcePlugins = Join-Path $SourceDir "plugins"
$SourcePreset  = Join-Path $SourceDir ".agent-presets\kaz"

Write-Host "DSH home : $DshHome" -ForegroundColor Gray
Write-Host "Profile  : $ProfileName ($ProfileDir)" -ForegroundColor Gray
Write-Host "Source   : $SourceDir" -ForegroundColor Gray
if ($DryRun) { Write-Host "DRY RUN  : 不写任何文件" -ForegroundColor Magenta }

# ---------- 2. plugins 目录 ----------
if (-not (Test-Path $SourcePlugins)) {
  Write-Warn "找不到分发包里的 plugins 目录：$SourcePlugins"
  Write-Warn "请把 install-kaz.ps1 与 plugins、.agent-presets 放在同一个目录里再运行。"
  Write-Warn "（也可以把 plugins 目录直接放进 $TargetPlugins，脚本会直接用。）"
} else {
  if (-not (Test-Path $TargetPlugins)) {
    Write-Step "复制 plugins -> $TargetPlugins"
    if (-not $DryRun) {
      New-Item -ItemType Directory -Path $TargetPlugins -Force | Out-Null
      Copy-Item -Path (Join-Path $SourcePlugins "*") -Destination $TargetPlugins -Recurse -Force
    }
    Write-Ok "已复制（共 $((Get-ChildItem $SourcePlugins -Directory).Count) 个插件目录）"
  } else {
    Write-Step "plugins 目录已存在，补齐缺失的插件目录"
    $copied = 0
    foreach ($dir in Get-ChildItem $SourcePlugins -Directory) {
      $dest = Join-Path $TargetPlugins $dir.Name
      if (-not (Test-Path $dest)) {
        if (-not $DryRun) { Copy-Item -Path $dir.FullName -Destination $dest -Recurse -Force }
        Write-Ok "补齐: $($dir.Name)"
        $copied++
      } else { Write-Skip "$($dir.Name) 已存在" }
    }
    if ($copied -eq 0) { Write-Ok "没有需要补齐的目录" }
  }
}

# ---------- 3. kaz 预设 ----------
# 预设源兼容两种布局：标准分发包的 .agent-presets\kaz，或仓库根目录的 kaz\。
if (-not (Test-Path $SourcePreset)) {
  $altPreset = Join-Path $SourceDir "kaz"
  if (Test-Path $altPreset) {
    $SourcePreset = $altPreset
    Write-Ok "预设源使用仓库布局：$SourcePreset"
  }
}
if (Test-Path $SourcePreset) {
  if (-not (Test-Path $TargetPreset)) {
    Write-Step "复制预设 -> $TargetPreset"
    if (-not $DryRun) {
      New-Item -ItemType Directory -Path (Split-Path $TargetPreset) -Force | Out-Null
      Copy-Item -Path $SourcePreset -Destination $TargetPreset -Recurse -Force
    }
    Write-Ok "已复制 kaz 预设"
  } else { Write-Skip "kaz 预设已存在：$TargetPreset" }
} else {
  Write-Warn "分发包里既没有 .agent-presets\kaz 也没有 kaz\（不影响插件加载，但 Kaz 预设选择器里不会出现 kaz）"
}

# ---------- 4. junction ----------
if (Test-Path $TargetPlugins) {
  Write-Step "创建/校验 node_modules junction"
  New-Item -ItemType Directory -Path $TargetNm -Force | Out-Null
  foreach ($dir in Get-ChildItem $TargetPlugins -Directory) {
    $pkgJson = Join-Path $dir.FullName "package.json"
    if (-not (Test-Path $pkgJson)) { Write-Skip "$($dir.Name) 无 package.json，不是插件包"; continue }
    $pkgName = $dir.Name
    try {
      $pkg = Get-Content -Path $pkgJson -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($pkg.name -and $pkg.name -ne "") { $pkgName = [string]$pkg.name }
    } catch { $pkgName = $dir.Name }
    if ($pkgName -notmatch "^[a-z0-9][a-z0-9-]*$") {
      Write-Warn "$($dir.Name) 的包名 $pkgName 不是普通小写包名，跳过注册（scoped 包需手动处理）"
      continue
    }
    $link = Join-Path $TargetNm $pkgName
    if (Test-Path $link) {
      $item = Get-Item $link -Force
      if ($item.LinkType -eq "Junction") {
        $target = $item.Target
        $targetFull = [string]$target
        if ($targetFull -eq $dir.FullName) {
          Write-Skip "junction 已存在且指向正确: $pkgName"
          continue
        }
        Write-Step "junction 指向错误，重建: $pkgName"
        if (-not $DryRun) {
          cmd /c rmdir "$link"
          New-Item -ItemType Junction -Path $link -Target $dir.FullName | Out-Null
        }
      } else {
        Write-Warn "node_modules\$pkgName 是真实目录（非 junction），跳过（可能由 npm/pnpm 安装；如需接管请手动删除该目录后重跑）"
        continue
      }
    } else {
      Write-Step "创建 junction: $pkgName"
      if (-not $DryRun) { New-Item -ItemType Junction -Path $link -Target $dir.FullName | Out-Null }
    }
    Write-Ok "OK: $pkgName"
  }
}

# ---------- 5. cordis.patch.yml 注册行 ----------
Write-Step "追加缺失的注册行到 cordis.patch.yml"
$patchText = ""
if (Test-Path $PatchFile) {
  $patchText = [System.IO.File]::ReadAllText($PatchFile, $utf8NoBom)
} else {
  if (-not $DryRun) {
    New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
    $patchText = "# Kaz 模式插件注册（install-kaz.ps1 生成）`n# 实时配置写在 DSH_HOME\settings.yaml 的对应段（插件加载时自动补齐缺失键）。`n[]`n"
  }
}
# 先归一化：去掉占位空列表（"[]"），避免 "[]" 后跟条目导致 YAML 解析失败。
$trimmed = $patchText.TrimEnd()
if ($trimmed -eq "[]") { $patchText = "" }
elseif ($trimmed.EndsWith("[]")) { $patchText = $trimmed.Substring(0, $trimmed.Length - 2).TrimEnd() }
$appended = 0
foreach ($dir in Get-ChildItem $TargetPlugins -Directory) {
  $pkgJson = Join-Path $dir.FullName "package.json"
  if (-not (Test-Path $pkgJson)) { continue }
  $pkgName = $dir.Name
  try {
    $pkg = Get-Content -Path $pkgJson -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($pkg.name -and $pkg.name -ne "") { $pkgName = [string]$pkg.name }
  } catch { $pkgName = $dir.Name }
  if ($pkgName -notmatch "^[a-z0-9][a-z0-9-]*$") { continue }
  $escaped = [regex]::Escape($pkgName)
  $q = [string][char]39
  $pattern = "(?m)^\s*name:\s*[\`"$q]?" + $escaped + "[\`"$q]?\s*$"
  if ([regex]::IsMatch($patchText, $pattern)) { Write-Skip "注册行已存在: $pkgName"; continue }
  $row = "- insert:`n    - id: " + $pkgName + "`n      name: " + $pkgName + "`n"
  if ([string]::IsNullOrWhiteSpace($patchText)) {
    $patchText = "# Kaz 模式插件注册（install-kaz.ps1 生成）`n" + $row
  } else {
    $patchText = $patchText.TrimEnd("`r", "`n") + "`n" + $row
  }
  Write-Ok "追加注册行: $pkgName"
  $appended++
}
if ($appended -eq 0 -and $patchText -ne "") { Write-Ok "注册行无需追加" }
if (-not $DryRun -and $patchText -ne "") {
  New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
  [System.IO.File]::WriteAllText($PatchFile, $patchText, $utf8NoBom)
}

# ---------- 6. 小结 ----------
Write-Host ""
Write-Host "========== 完成 ==========" -ForegroundColor Green
if ($DryRun) { Write-Host "（DryRun：以上为将要执行的动作）" -ForegroundColor Magenta }
Write-Host "接下来："
Write-Host "  1. 启动 dsh web（或重启正在运行的 dsh）。"
Write-Host "  2. 插件加载时会自动在 settings.yaml 补齐缺失的配置段（只补缺失键）。"
Write-Host "  3. 右上角应出现 Kaz 模式开关；设置页可看到各插件段。"
Write-Host "  4. 验证：设置页 -> 插件清单，或新建对话后输入 kaz_mode_status。"
Write-Host "故障排查："
Write-Host '  - junction 用 cmd /c rmdir "<路径>" 删除（勿用 Remove-Item）。'
Write-Host "  - 改插件代码后需重启 dsh（ESM 模块缓存）。"
