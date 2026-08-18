# dsh-KazMode 一键安装脚本
# 双击 install.bat 即可，或手动运行：
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
# 可选参数：
#   -ProfileDir          目标 profile 目录（默认 ~/.dsh/profiles/web）
#   -DshHome             dsh 主目录（默认 ~/.dsh）
#   -AgentPresetsDir     预设目录（默认 ~/.dsh/.agent-presets）
#   -SkipApiProxyPatch   跳过 dsh-host-apiproxy 补丁
#   -ApiProxyFile        指定 dsh-host-apiproxy/lib/index.js（调试用）

param(
  [string]$RepoRoot = $PSScriptRoot,
  [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh/profiles/web'),
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$AgentPresetsDir = (Join-Path $env:USERPROFILE '.dsh/.agent-presets'),
  [switch]$SkipApiProxyPatch,
  [string]$ApiProxyFile = ''
)

$ErrorActionPreference = 'Stop'
$nl = [string][char]13 + [string][char]10
$lf = [string][char]10
$cr = [string][char]13

function Write-Utf8NoBom {
  param([string]$Path, [string]$Content)
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $enc)
}

function Merge-SettingsSections {
  param([string]$ExamplePath, [string]$TargetPath)
  $exampleLines = Get-Content -LiteralPath $ExamplePath -Encoding UTF8
  $sections = New-Object System.Collections.ArrayList
  $currentKey = ''
  $currentLines = New-Object System.Collections.ArrayList
  foreach ($line in $exampleLines) {
    if ($line -match '^([A-Za-z0-9_-]+):[ 	]*$') {
      if ($currentKey) {
        [void]$sections.Add([pscustomobject]@{ Key = $currentKey; Text = ($currentLines -join $lf) })
      }
      $currentKey = $Matches[1]
      $currentLines = New-Object System.Collections.ArrayList
      [void]$currentLines.Add($line)
    } elseif ($currentKey) {
      [void]$currentLines.Add($line)
    }
  }
  if ($currentKey) {
    [void]$sections.Add([pscustomobject]@{ Key = $currentKey; Text = ($currentLines -join $lf) })
  }
  $added = New-Object System.Collections.ArrayList
  $target = Get-Content -LiteralPath $TargetPath -Raw -Encoding UTF8
  foreach ($s in $sections) {
    $pattern = '(?m)^' + [regex]::Escape($s.Key) + ':'
    if ($target -notmatch $pattern) {
      $target = $target.TrimEnd() + $nl + $nl + $s.Text + $nl
      [void]$added.Add($s.Key)
    }
  }
  if ($added.Count -gt 0) {
    Write-Utf8NoBom -Path $TargetPath -Content $target
  }
  return $added
}

function Patch-ApiProxyFile {
  param([string]$File)
  $text = Get-Content -LiteralPath $File -Raw -Encoding UTF8
  if ($text -match '"kaz-mode"') { return 'already-patched' }
  $block = @(
    '	// ---- dsh-KazMode installer patch ----',
    '	"kaz-mode",',
    '	"kaz-memory",',
    '	"thinking-anchor",',
    '	"round-minimal",',
    '	"tool-grouping",',
    '	"tool-filter",',
    '	"code-collapse",',
    '	"output-beep",',
    '	"task-master-whiteboard",',
    '	"round-display"'
  ) -join $nl
  $idx = $text.IndexOf('"web-search-deepseek",')
  if ($idx -ge 0) {
    $nlIdx = $text.IndexOf($lf, $idx)
    if ($nlIdx -lt 0) { $nlIdx = $text.Length }
    $text = $text.Substring(0, $nlIdx + 1) + $block + $nl + $text.Substring($nlIdx + 1)
  } else {
    $arrIdx = $text.IndexOf('const WEB_SETTINGS_NAMESPACES')
    if ($arrIdx -lt 0) { return 'anchor-not-found' }
    $closeIdx = $text.IndexOf('];', $arrIdx)
    if ($closeIdx -lt 0) { return 'anchor-not-found' }
    $text = $text.Substring(0, $closeIdx) + $block + $nl + $text.Substring($closeIdx)
  }
  Write-Utf8NoBom -Path $File -Content $text
  return 'patched'
}

function Find-ApiProxyFile {
  $candidates = New-Object System.Collections.ArrayList
  $cmd = Get-Command dsh -ErrorAction SilentlyContinue
  if ($cmd) {
    $binDir = Split-Path -Parent $cmd.Source
    [void]$candidates.Add((Join-Path $binDir 'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js'))
    [void]$candidates.Add((Join-Path $binDir 'node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js'))
  }
  [void]$candidates.Add((Join-Path $env:APPDATA 'npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js'))
  [void]$candidates.Add((Join-Path $env:APPDATA 'npm/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js'))
  foreach ($c in $candidates) {
    if (Test-Path -LiteralPath $c) { return $c }
  }
  $root = Join-Path $env:APPDATA 'npm/node_modules'
  if (Test-Path -LiteralPath $root) {
    $hit = Get-ChildItem -LiteralPath $root -Recurse -Filter 'index.js' -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -eq 'index.js' -and $_.FullName -match 'dsh-host-apiproxy' -and $_.DirectoryName -match 'dsh-host-apiproxy' } |
      Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return ''
}

# ---------- 0. 预检 ----------
Write-Host '==============================================' -ForegroundColor Cyan
Write-Host '  dsh-KazMode 一键安装 (11 个插件 + Kaz 预设)' -ForegroundColor Cyan
Write-Host '==============================================' -ForegroundColor Cyan

$PluginsDir = Join-Path $RepoRoot 'plugins'
$SettingsExample = Join-Path $RepoRoot 'settings.kaz.example.yaml'
$PresetSource = Join-Path $PluginsDir 'kaz-mode/kaz-preset'
$ProfilePluginsDir = Join-Path $ProfileDir 'plugins'
$NodeModulesDir = Join-Path $ProfileDir 'node_modules'
$PatchFile = Join-Path $ProfileDir 'cordis.patch.yml'

if (-not (Test-Path -LiteralPath $PluginsDir)) {
  Write-Host ("错误：找不到插件目录：" + $PluginsDir) -ForegroundColor Red
  exit 1
}
if (-not (Test-Path -LiteralPath $SettingsExample)) {
  Write-Host '错误：找不到 settings.kaz.example.yaml' -ForegroundColor Red
  exit 1
}
if (-not (Test-Path -LiteralPath $DshHome)) {
  Write-Host '警告：未找到 ~/.dsh 目录，请确认已安装并启动过 dsh' -ForegroundColor Yellow
}

# ---------- 1. 复制插件 ----------
Write-Host '[1/6] 复制插件到 profile' -ForegroundColor Cyan
New-Item -ItemType Directory -Path $ProfilePluginsDir -Force | Out-Null
$pluginDirs = @(Get-ChildItem -LiteralPath $PluginsDir -Directory)
foreach ($p in $pluginDirs) {
  $dest = Join-Path $ProfilePluginsDir $p.Name
  Copy-Item -LiteralPath $p.FullName -Destination $dest -Recurse -Force
  Write-Host ("    已复制: " + $p.Name) -ForegroundColor Green
}

# ---------- 2. junction ----------
Write-Host '[2/6] 在 node_modules 创建 junction' -ForegroundColor Cyan
New-Item -ItemType Directory -Path $NodeModulesDir -Force | Out-Null
foreach ($p in $pluginDirs) {
  $link = Join-Path $NodeModulesDir $p.Name
  if (Test-Path -LiteralPath $link) {
    Write-Host ("    已存在，跳过: " + $p.Name) -ForegroundColor Yellow
  } else {
    try {
      New-Item -ItemType Junction -Path $link -Target (Join-Path $ProfilePluginsDir $p.Name) -ErrorAction Stop | Out-Null
      Write-Host ("    junction: " + $p.Name) -ForegroundColor Green
    } catch {
      Write-Host ("    junction 创建失败: " + $p.Name + " - " + $_.Exception.Message) -ForegroundColor Red
      Write-Host '    请改用 npm 方式安装（见 README），或尝试以管理员身份运行' -ForegroundColor Yellow
    }
  }
}

# ---------- 3. cordis.patch.yml ----------
Write-Host '[3/6] 追加组合行到 cordis.patch.yml' -ForegroundColor Cyan
$rows = @(
  @{ id = 'kaz-memory'; text = ('- insert:' + $nl + '    - id: kaz-memory' + $nl + '      name: kaz-memory') },
  @{ id = 'thinking-anchor'; text = ('- insert:' + $nl + '    - id: thinking-anchor' + $nl + '      name: thinking-anchor' + $nl + '      config:' + $nl + '        enabled: true') },
  @{ id = 'tool-filter'; text = ('- insert:' + $nl + '    - id: tool-filter' + $nl + '      name: tool-filter' + $nl + '      config:' + $nl + '        enabled: true' + $nl + '        mode: remove' + $nl + '        disabledTools:' + $nl + '          - tool-cordis' + $nl + '          - tool-subagent-report' + $nl + '          - codex' + $nl + '          - claude-code') },
  @{ id = 'tool-grouping'; text = ('- insert:' + $nl + '    - id: tool-grouping' + $nl + '      name: tool-grouping' + $nl + '      config:' + $nl + '        enabled: true') },
  @{ id = 'round-minimal'; text = ('- insert:' + $nl + '    - id: round-minimal' + $nl + '      name: round-minimal' + $nl + '      config:' + $nl + '        enabled: true') },
  @{ id = 'kaz-mode'; text = ('- insert:' + $nl + '    - id: kaz-mode' + $nl + '      name: kaz-mode' + $nl + '      config:' + $nl + '        enabled: false') },
  @{ id = 'code-collapse'; text = ('- insert:' + $nl + '    - id: code-collapse' + $nl + '      name: code-collapse' + $nl + '      config:' + $nl + '        enabled: false') },
  @{ id = 'output-beep'; text = ('- insert:' + $nl + '    - id: output-beep' + $nl + '      name: output-beep' + $nl + '      config:' + $nl + '        enabled: true') },
  @{ id = 'round-display'; text = ('- insert:' + $nl + '    - id: round-display' + $nl + '      name: round-display' + $nl + '      config:' + $nl + '        enabled: true') },
  @{ id = 'task-master-whiteboard'; text = ('- insert:' + $nl + '    - id: task-master-whiteboard' + $nl + '      name: task-master-whiteboard' + $nl + '      config:' + $nl + '        enabled: true') }
)

$existingPatch = ''
if (Test-Path -LiteralPath $PatchFile) {
  $existingPatch = Get-Content -LiteralPath $PatchFile -Raw -Encoding UTF8
}
$missing = @($rows | Where-Object {
  $existingPatch -notmatch ('(?m)^[ 	]*(?:- )?id:[ 	]*' + [regex]::Escape($_.id) + '[ 	]*' + $cr + '?$')
})
if ($missing.Count -eq 0) {
  Write-Host '    已包含全部插件行，跳过' -ForegroundColor Green
} else {
  $block = ($missing | ForEach-Object { $_.text }) -join ($nl + $nl)
  if ($existingPatch.Trim() -eq '' -or $existingPatch.Trim() -eq '[]') {
    $header = '# dsh-KazMode 插件注册（由 install.ps1 生成）' + $nl + '# 组合行说明见各插件 README；实时配置写在 ~/.dsh/settings.yaml' + $nl + $nl
    $newContent = $header + $block + $nl
  } else {
    $newContent = $existingPatch.TrimEnd() + $nl + $nl + $block + $nl
  }
  Write-Utf8NoBom -Path $PatchFile -Content $newContent
  Write-Host ("    已追加 " + $missing.Count + " 条组合行") -ForegroundColor Green
}

# ---------- 4. Kaz 预设 ----------
Write-Host '[4/6] 安装 Kaz 预设' -ForegroundColor Cyan
if (Test-Path -LiteralPath $PresetSource) {
  New-Item -ItemType Directory -Path $AgentPresetsDir -Force | Out-Null
  $presetDest = Join-Path $AgentPresetsDir 'kaz'
  Copy-Item -LiteralPath $PresetSource -Destination $presetDest -Recurse -Force
  Write-Host ("    已复制到 " + $presetDest) -ForegroundColor Green
} else {
  Write-Host '    警告：找不到 kaz-preset，跳过（预设选择器将没有「Kaz 模式」）' -ForegroundColor Yellow
}

# ---------- 5. settings.yaml ----------
Write-Host '[5/6] 合并设置到 settings.yaml' -ForegroundColor Cyan
$settingsTarget = Join-Path $DshHome 'settings.yaml'
if (-not (Test-Path -LiteralPath $settingsTarget)) {
  New-Item -ItemType Directory -Path $DshHome -Force | Out-Null
  Copy-Item -LiteralPath $SettingsExample -Destination $settingsTarget -Force
  Write-Host ("    已创建 " + $settingsTarget) -ForegroundColor Green
} else {
  $addedKeys = @(Merge-SettingsSections -ExamplePath $SettingsExample -TargetPath $settingsTarget)
  if ($addedKeys.Count -gt 0) {
    Write-Host ("    已新增设置段: " + ($addedKeys -join ', ')) -ForegroundColor Green
  } else {
    Write-Host '    设置段已齐全，无需修改' -ForegroundColor Green
  }
}

# ---------- 6. dsh-host-apiproxy 补丁 ----------
if (-not $SkipApiProxyPatch) {
  Write-Host '[6/6] dsh-host-apiproxy 命名空间补丁' -ForegroundColor Cyan
  $apiFile = $ApiProxyFile
  if (-not $apiFile) { $apiFile = Find-ApiProxyFile }
  if ($apiFile -and (Test-Path -LiteralPath $apiFile)) {
    $result = Patch-ApiProxyFile -File $apiFile
    if ($result -eq 'patched') {
      Write-Host ("    已打补丁: " + $apiFile) -ForegroundColor Green
    } elseif ($result -eq 'already-patched') {
      Write-Host '    已包含 kaz-mode，无需重复补丁' -ForegroundColor Green
    } else {
      Write-Host '    警告：找不到补丁锚点（web-search-deepseek），请手动添加 WEB_SETTINGS_NAMESPACES' -ForegroundColor Yellow
    }
  } else {
    Write-Host '    警告：未找到 dsh-host-apiproxy/lib/index.js，跳过补丁' -ForegroundColor Yellow
    Write-Host '    面板可能显示「未安装」或无法写入插件设置；手动补丁内容见 README' -ForegroundColor Yellow
  }
}

# ---------- 完成 ----------
Write-Host ''
Write-Host '==============================================' -ForegroundColor Cyan
Write-Host '  安装完成！接下来：' -ForegroundColor Cyan
Write-Host '==============================================' -ForegroundColor Cyan
Write-Host '  1. 完全退出并重启 dsh'
Write-Host '  2. 浏览器强刷页面 (Ctrl+F5)'
Write-Host '  3. 新建会话 -> 预设选择器选「Kaz 模式」'
Write-Host '     或点会话头部的「Kaz 模式」按钮'
Write-Host ''
Write-Host '  验证：dsh --profile web --dump-config 应能看到 kaz-mode 等行'
Write-Host ''
exit 0
