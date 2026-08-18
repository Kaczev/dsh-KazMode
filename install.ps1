# dsh-KazMode 一键安装脚本
# 双击 install.bat 即可，或手动运行：
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
# 只读诊断（不改任何文件）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Diagnose
# 可选参数：
#   -ProfileDir          目标 profile 目录（默认 ~/.dsh/profiles/web）
#   -DshHome             dsh 主目录（默认 ~/.dsh）
#   -AgentPresetsDir     预设目录（默认 ~/.dsh/.agent-presets）
#   -SkipApiProxyPatch   跳过 dsh-host-apiproxy 补丁
#   -ApiProxyFile        指定 dsh-host-apiproxy/lib/index.js（调试用）
#   -Diagnose            只读诊断：检查插件加载所需的一切并输出报告

param(
  [string]$RepoRoot = $PSScriptRoot,
  [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh/profiles/web'),
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$AgentPresetsDir = (Join-Path $env:USERPROFILE '.dsh/.agent-presets'),
  [switch]$SkipApiProxyPatch,
  [string]$ApiProxyFile = '',
  [switch]$Diagnose
)

$ErrorActionPreference = 'Stop'
# 统一控制台编码为 UTF-8，避免中文乱码（Windows PowerShell 5.1 + Windows Terminal 常见问题）
try { & chcp 65001 | Out-Null } catch { }
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { $OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$nl = [string][char]13 + [string][char]10
$lf = [string][char]10
$cr = [string][char]13

# ==================== 工具函数 ====================

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
  $dir = Get-DshInstallDir
  if ($dir) {
    [void]$candidates.Add((Join-Path $dir 'node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js'))
    [void]$candidates.Add((Join-Path $dir 'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js'))
  }
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
  return ''
}

function Get-DshInstallDir {
  $candidates = New-Object System.Collections.ArrayList
  [void]$candidates.Add((Join-Path $env:APPDATA 'npm/node_modules/@deepseek-ai/dsh'))
  $cmd = Get-Command dsh -ErrorAction SilentlyContinue
  if ($cmd) {
    $binDir = Split-Path -Parent $cmd.Source
    [void]$candidates.Add((Join-Path $binDir 'node_modules/@deepseek-ai/dsh'))
  }
  $npxRoot = Join-Path $env:LOCALAPPDATA 'npm-cache/_npx'
  if (Test-Path -LiteralPath $npxRoot) {
    $npxDirs = @(Get-ChildItem -LiteralPath $npxRoot -Directory -ErrorAction SilentlyContinue)
    foreach ($d in $npxDirs) {
      [void]$candidates.Add((Join-Path $d.FullName 'node_modules/@deepseek-ai/dsh'))
    }
  }
  foreach ($c in $candidates) {
    if (Test-Path -LiteralPath (Join-Path $c 'package.json')) { return $c }
  }
  return ''
}

function Get-DshVersion {
  $dir = Get-DshInstallDir
  if ($dir) {
    try { return (Get-Content -LiteralPath (Join-Path $dir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { }
  }
  return ''
}

function Get-JsYamlPath {
  $dir = Get-DshInstallDir
  if (-not $dir) { return '' }
  $cands = @(
    (Join-Path $dir 'node_modules/js-yaml/index.js'),
    (Join-Path $dir 'node_modules/@deepseek-ai/dsh/node_modules/js-yaml/index.js'),
    (Join-Path (Split-Path $dir -Parent) 'js-yaml/index.js')
  )
  foreach ($c in $cands) {
    if (Test-Path -LiteralPath $c) { return $c }
  }
  return ''
}

# ==================== 只读诊断模式 ====================

if ($Diagnose) {
  Write-Host '==============================================' -ForegroundColor Cyan
  Write-Host '  dsh-KazMode 只读诊断（不改任何文件）' -ForegroundColor Cyan
  Write-Host '==============================================' -ForegroundColor Cyan

  $PluginsDir = Join-Path $RepoRoot 'plugins'
  $ProfilePluginsDir = Join-Path $ProfileDir 'plugins'
  $NodeModulesDir = Join-Path $ProfileDir 'node_modules'
  $PatchFile = Join-Path $ProfileDir 'cordis.patch.yml'
  $pluginNames = @('code-collapse','kaz-memory','kaz-mode','kaz-no-context','output-beep','round-display','round-minimal','task-master-whiteboard','thinking-anchor','tool-filter','tool-grouping')
  $clientNames = @('kaz-mode','kaz-memory','round-display')
  $expectedIds = @('kaz-memory','thinking-anchor','tool-filter','tool-grouping','round-minimal','kaz-mode','code-collapse','output-beep','round-display','task-master-whiteboard')

  Write-Host ''
  Write-Host '[1] dsh 版本' -ForegroundColor Cyan
  $ver = Get-DshVersion
  $dshDir = Get-DshInstallDir
  if ($dshDir) {
    Write-Host ('    位置: ' + $dshDir)
  }
  if ($ver) {
    Write-Host ('    版本: ' + $ver)
    if ($ver -notmatch '^0[.]1[.]0-rc[.](6|7|8|9)|^0[.]1[.]0') {
      Write-Host '    警告：Kaz 模式客户端 UI 依赖 dsh 0.1.0-rc.6+ 的客户端 API；版本过旧会没有按钮' -ForegroundColor Yellow
    }
  } else {
    Write-Host '    未找到 dsh 全局安装（npm 全局）' -ForegroundColor Yellow
  }

  Write-Host ''
  Write-Host '[2] profile 目录' -ForegroundColor Cyan
  Write-Host ('    路径: ' + $ProfileDir)
  Write-Host ('    plugins 存在: ' + (Test-Path -LiteralPath $ProfilePluginsDir))
  Write-Host ('    node_modules 存在: ' + (Test-Path -LiteralPath $NodeModulesDir))

  Write-Host ''
  Write-Host '[3] cordis.patch.yml 插件行' -ForegroundColor Cyan
  if (Test-Path -LiteralPath $PatchFile) {
    $patch = Get-Content -LiteralPath $PatchFile -Raw -Encoding UTF8
    foreach ($id in $expectedIds) {
      $ok = $patch -match ('(?m)^[ 	]*(?:- )?(?:id|name):[ 	]*' + [regex]::Escape($id) + '[ 	]*' + $cr + '?$')
      Write-Host ('    ' + $id + ': ' + $(if ($ok) { 'OK' } else { '缺失' }))
    }
    $emptySeq = $patch -match '(?m)^[ 	]*[[]][ 	]*$'
    $hasRows = $patch -match '(?m)^[ 	]*-[ 	]'
    if ($emptySeq -and $hasRows) {
      Write-Host '    检测到 [] 与组合行并存 —— YAML 非法！请重跑 install.bat 修复' -ForegroundColor Red
    }
  } else {
    Write-Host '    文件不存在！' -ForegroundColor Red
  }

  Write-Host ''
  Write-Host '[4] node_modules 插件链接' -ForegroundColor Cyan
  foreach ($name in $pluginNames) {
    $link = Join-Path $NodeModulesDir $name
    if (Test-Path -LiteralPath $link) {
      $pkgJson = Join-Path $link 'package.json'
      Write-Host ('    ' + $name + ': 存在' + $(if (Test-Path -LiteralPath $pkgJson) { ' (package.json OK)' } else { ' (无 package.json!)' }))
    } else {
      Write-Host ('    ' + $name + ': 缺失！') -ForegroundColor Red
    }
  }

  Write-Host ''
  Write-Host '[5] 客户端 bundle（有 UI 的插件）' -ForegroundColor Cyan
  foreach ($name in $clientNames) {
    $cb = Join-Path $ProfilePluginsDir ($name + '/lib/client.js')
    Write-Host ('    ' + $name + '/lib/client.js: ' + $(if (Test-Path -LiteralPath $cb) { '存在' } else { '缺失！' }))
  }

  Write-Host ''
  Write-Host '[6] dsh-host-apiproxy 命名空间补丁' -ForegroundColor Cyan
  $apiFile = $ApiProxyFile
  if (-not $apiFile) { $apiFile = Find-ApiProxyFile }
  if ($apiFile -and (Test-Path -LiteralPath $apiFile)) {
    $api = Get-Content -LiteralPath $apiFile -Raw -Encoding UTF8
    if ($api -match '"kaz-mode"') {
      Write-Host '    已打补丁（Kaz 面板可读写插件设置）'
    } else {
      Write-Host '    未打补丁！Kaz 面板会显示「未安装」/无法写入设置' -ForegroundColor Red
    }
    Write-Host ('    文件: ' + $apiFile)
  } else {
    Write-Host '    未找到 dsh-host-apiproxy/lib/index.js（面板设置可能不可用）' -ForegroundColor Red
  }

  Write-Host ''
  Write-Host '[7] settings.yaml 插件设置段' -ForegroundColor Cyan
  $settingsFile = Join-Path $DshHome 'settings.yaml'
  if (Test-Path -LiteralPath $settingsFile) {
    $s = Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8
    foreach ($key in @('thinking-anchor','tool-filter','tool-grouping','round-minimal','kaz-mode','kaz-memory','code-collapse','output-beep','task-master-whiteboard','round-display')) {
      $ok = $s -match ('(?m)^' + [regex]::Escape($key) + ':')
      Write-Host ('    ' + $key + ': ' + $(if ($ok) { 'OK' } else { '缺失' }))
    }
  } else {
    Write-Host ('    ' + $settingsFile + ' 不存在') -ForegroundColor Red
  }

  Write-Host ''
  Write-Host '[8] dsh 日志中的 client-modules 报错' -ForegroundColor Cyan
  $log = Join-Path $DshHome 'dsh.log'
  if (Test-Path -LiteralPath $log) {
    $hits = Select-String -LiteralPath $log -Pattern 'client-modules|clientModules|FAILED' -ErrorAction SilentlyContinue | Select-Object -Last 8
    if ($hits) {
      $hits | ForEach-Object { Write-Host ('    ' + $_.Line.Trim().Substring(0, [Math]::Min(180, $_.Line.Trim().Length))) -ForegroundColor Yellow }
    } else {
      Write-Host '    未发现相关报错'
    }
  } else {
    Write-Host '    无日志文件'
  }

  Write-Host ''
  Write-Host '把以上输出发给作者即可定位问题。' -ForegroundColor Green
  exit 0
}

# ==================== 正式安装 ====================

Write-Host '==============================================' -ForegroundColor Cyan
Write-Host '  dsh-KazMode 一键安装 (11 个插件 + Kaz 预设)' -ForegroundColor Cyan
Write-Host '==============================================' -ForegroundColor Cyan

$PluginsDir = Join-Path $RepoRoot 'plugins'
$SettingsExample = Join-Path $RepoRoot 'settings.kaz.example.yaml'
$PresetSource = Join-Path $PluginsDir 'kaz-mode/kaz-preset'
$ProfilePluginsDir = Join-Path $ProfileDir 'plugins'
$NodeModulesDir = Join-Path $ProfileDir 'node_modules'
$PatchFile = Join-Path $ProfileDir 'cordis.patch.yml'
$apiProxyPatched = $false

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
Write-Host '[1/7] 复制插件到 profile' -ForegroundColor Cyan
New-Item -ItemType Directory -Path $ProfilePluginsDir -Force | Out-Null
$pluginDirs = @(Get-ChildItem -LiteralPath $PluginsDir -Directory)
foreach ($p in $pluginDirs) {
  $dest = Join-Path $ProfilePluginsDir $p.Name
  Copy-Item -LiteralPath $p.FullName -Destination $dest -Recurse -Force
  Write-Host ("    已复制: " + $p.Name) -ForegroundColor Green
}

# ---------- 2. junction ----------
Write-Host '[2/7] 在 node_modules 创建 junction' -ForegroundColor Cyan
New-Item -ItemType Directory -Path $NodeModulesDir -Force | Out-Null
foreach ($p in $pluginDirs) {
  $link = Join-Path $NodeModulesDir $p.Name
  if (Test-Path -LiteralPath $link) {
    $pkgOk = Test-Path -LiteralPath (Join-Path $link 'package.json')
    if ($pkgOk) {
      Write-Host ("    已存在，跳过: " + $p.Name) -ForegroundColor Yellow
    } else {
      $item = Get-Item -LiteralPath $link -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        try {
          Remove-Item -LiteralPath $link -Force
          New-Item -ItemType Junction -Path $link -Target (Join-Path $ProfilePluginsDir $p.Name) -ErrorAction Stop | Out-Null
          Write-Host ("    已重建损坏的链接: " + $p.Name) -ForegroundColor Green
        } catch {
          Write-Host ("    链接重建失败: " + $p.Name + " - " + $_.Exception.Message) -ForegroundColor Red
        }
      } else {
        Write-Host ("    警告：node_modules/" + $p.Name + " 已存在（非链接且无 package.json），请手动删除后重跑") -ForegroundColor Red
      }
    }
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
Write-Host '[3/7] 追加组合行到 cordis.patch.yml' -ForegroundColor Cyan
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
$patchLines = $existingPatch -split $lf
$keptLines = New-Object System.Collections.ArrayList
$sawBlockEntry = $false
$sawEmptySeq = $false
foreach ($line in $patchLines) {
  $t = $line.Trim()
  if ($t -eq '[]') { $sawEmptySeq = $true; continue }
  if ($t -ne '' -and -not $t.StartsWith('#')) { $sawBlockEntry = $true }
  [void]$keptLines.Add($line)
}
$cleanedPatch = $keptLines -join $lf
$placeholderPatch = -not $sawBlockEntry

$missing = @($rows | Where-Object {
  $existingPatch -notmatch ('(?m)^[ 	]*(?:- )?(?:id|name):[ 	]*' + [regex]::Escape($_.id) + '[ 	]*' + $cr + '?$')
})
if ($missing.Count -eq 0 -and -not $sawEmptySeq) {
  Write-Host '    已包含全部插件行，跳过' -ForegroundColor Green
} else {
  $block = ($missing | ForEach-Object { $_.text }) -join ($nl + $nl)
  if ($placeholderPatch) {
    $header = '# dsh-KazMode 插件注册（由 install.ps1 生成）' + $nl + '# 组合行说明见各插件 README；实时配置写在 ~/.dsh/settings.yaml' + $nl + $nl
    $newContent = $header + $block + $nl
  } elseif ($sawEmptySeq) {
    $newContent = $cleanedPatch.TrimEnd() + $nl + $nl + $block + $nl
  } else {
    $newContent = $existingPatch.TrimEnd() + $nl + $nl + $block + $nl
  }
  Write-Utf8NoBom -Path $PatchFile -Content $newContent
  if ($missing.Count -gt 0) {
    Write-Host ("    已追加 " + $missing.Count + " 条组合行") -ForegroundColor Green
  }
  if ($sawEmptySeq) {
    Write-Host '    已移除残留的 []（YAML 非法占位）' -ForegroundColor Green
  }
}

# ---------- 4. Kaz 预设 ----------
Write-Host '[4/7] 安装 Kaz 预设' -ForegroundColor Cyan
if (Test-Path -LiteralPath $PresetSource) {
  New-Item -ItemType Directory -Path $AgentPresetsDir -Force | Out-Null
  $presetDest = Join-Path $AgentPresetsDir 'kaz'
  Copy-Item -LiteralPath $PresetSource -Destination $presetDest -Recurse -Force
  Write-Host ("    已复制到 " + $presetDest) -ForegroundColor Green
} else {
  Write-Host '    警告：找不到 kaz-preset，跳过（预设选择器将没有「Kaz 模式」）' -ForegroundColor Yellow
}

# ---------- 5. settings.yaml ----------
Write-Host '[5/7] 合并设置到 settings.yaml' -ForegroundColor Cyan
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
  Write-Host '[6/7] dsh-host-apiproxy 命名空间补丁' -ForegroundColor Cyan
  $apiFile = $ApiProxyFile
  if (-not $apiFile) { $apiFile = Find-ApiProxyFile }
  if ($apiFile -and (Test-Path -LiteralPath $apiFile)) {
    $result = Patch-ApiProxyFile -File $apiFile
    if ($result -eq 'patched') {
      Write-Host ("    已打补丁: " + $apiFile) -ForegroundColor Green
      $apiProxyPatched = $true
    } elseif ($result -eq 'already-patched') {
      Write-Host '    已包含 kaz-mode，无需重复补丁' -ForegroundColor Green
      $apiProxyPatched = $true
    } else {
      Write-Host '    警告：找不到补丁锚点（web-search-deepseek），请手动添加 WEB_SETTINGS_NAMESPACES' -ForegroundColor Yellow
    }
  } else {
    Write-Host '    警告：未找到 dsh-host-apiproxy/lib/index.js，跳过补丁' -ForegroundColor Yellow
    Write-Host '    面板可能显示「未安装」或无法写入插件设置；手动补丁内容见 README' -ForegroundColor Yellow
  }
} else {
  $apiProxyPatched = $true
}

# ---------- 7. 自检 + package.json 依赖合并 ----------
Write-Host '[7/7] 自检 + package.json 依赖合并' -ForegroundColor Cyan
$selfCheckFailures = New-Object System.Collections.ArrayList

# 7a. 把 11 个插件依赖合并进 profile package.json（和作者机器一致；junction 已存在时无需 npm install）
$pkgFile = Join-Path $ProfileDir 'package.json'
if (Test-Path -LiteralPath $pkgFile) {
  try {
    $pkg = Get-Content -LiteralPath $pkgFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $hasDeps = $pkg.PSObject.Properties.Name -contains 'dependencies'
    if (-not $hasDeps) {
      $pkg | Add-Member -NotePropertyName 'dependencies' -NotePropertyValue ([pscustomobject]@{})
    } elseif ($null -eq $pkg.dependencies) {
      $pkg.dependencies = [pscustomobject]@{}
    }
    $deps = $pkg.dependencies
    $changed = $false
    foreach ($p in $pluginDirs) {
      if (-not ($deps.PSObject.Properties.Name -contains $p.Name)) {
        $deps | Add-Member -NotePropertyName $p.Name -NotePropertyValue ('file:plugins/' + $p.Name)
        $changed = $true
      }
    }
    if ($changed) {
      $pkg.dependencies = $deps
      Write-Utf8NoBom -Path $pkgFile -Content ($pkg | ConvertTo-Json -Depth 20)
      Write-Host '    已把插件依赖合并进 package.json' -ForegroundColor Green
    } else {
      Write-Host '    package.json 依赖已齐全' -ForegroundColor Green
    }
  } catch {
    Write-Host ('    package.json 解析失败，跳过合并（' + $_.Exception.Message + '）') -ForegroundColor Yellow
  }
} else {
  Write-Host '    未找到 profile package.json（跳过）' -ForegroundColor Yellow
}

# 7b. junction 复查
$missingLinks = @()
foreach ($p in $pluginDirs) {
  $link = Join-Path $NodeModulesDir $p.Name
  if (-not (Test-Path -LiteralPath (Join-Path $link 'package.json'))) { $missingLinks += $p.Name }
}
if ($missingLinks.Count -gt 0) {
  [void]$selfCheckFailures.Add(('node_modules 链接缺失或损坏: ' + ($missingLinks -join ', ')))
  Write-Host ('    警告：node_modules 链接缺失或损坏: ' + ($missingLinks -join ', ')) -ForegroundColor Red
} else {
  Write-Host '    node_modules 链接全部就绪' -ForegroundColor Green
}

# 7c. 客户端 bundle 复查
$missingClient = @()
foreach ($name in @('kaz-mode','kaz-memory','round-display')) {
  $cb = Join-Path $ProfilePluginsDir ($name + '/lib/client.js')
  if (-not (Test-Path -LiteralPath $cb)) { $missingClient += $name }
}
if ($missingClient.Count -gt 0) {
  [void]$selfCheckFailures.Add(('客户端 bundle 缺失: ' + ($missingClient -join ', ')))
  Write-Host ('    警告：客户端 bundle 缺失: ' + ($missingClient -join ', ')) -ForegroundColor Red
} else {
  Write-Host '    客户端 bundle 全部就绪' -ForegroundColor Green
}

# 7d. apiproxy 补丁状态
if ($apiProxyPatched) {
  Write-Host '    dsh-host-apiproxy 补丁: 已就绪' -ForegroundColor Green
} else {
  [void]$selfCheckFailures.Add('WEB_SETTINGS_NAMESPACES 补丁未打（Kaz 面板无法读写插件设置）')
  Write-Host '    警告：dsh-host-apiproxy 补丁未打（Kaz 面板无法读写插件设置）' -ForegroundColor Red
}

# 7e. dsh 版本
$ver = Get-DshVersion
if ($ver) {
  Write-Host ('    dsh 版本: ' + $ver)
  if ($ver -notmatch '^0[.]1[.]0-rc[.](6|7|8|9)|^0[.]1[.]0') {
    [void]$selfCheckFailures.Add(('dsh 版本过旧（' + $ver + '），客户端 UI 需要 0.1.0-rc.6+'))
    Write-Host '    警告：dsh 版本过旧，客户端 UI 需要 0.1.0-rc.6+' -ForegroundColor Red
  }
} else {
  Write-Host '    警告：未找到 dsh 全局安装（无法核对版本）' -ForegroundColor Yellow
}

# 7f. cordis.patch.yml YAML 合法性（防止 [] 占位残留这类启动崩溃）
$yamlLib = Get-JsYamlPath
if ($yamlLib -and (Test-Path -LiteralPath $PatchFile) -and (Get-Command node -ErrorAction SilentlyContinue)) {
  $nodeScript = "const y=require(process.argv[1]);const f=process.argv[2];try{y.load(require('fs').readFileSync(f,'utf8'));console.log('OK')}catch(e){console.log('FAIL: '+e.message);process.exit(1)}"
  $yamlOut = & node -e $nodeScript $yamlLib $PatchFile 2>&1
  if ($LASTEXITCODE -eq 0) {
    Write-Host '    cordis.patch.yml YAML 合法' -ForegroundColor Green
  } else {
    [void]$selfCheckFailures.Add(('cordis.patch.yml YAML 非法（' + (($yamlOut -join ' ')) + '）'))
    Write-Host ('    警告：cordis.patch.yml YAML 非法！' + ($yamlOut -join ' ')) -ForegroundColor Red
  }
}

# ---------- 汇总 ----------
Write-Host ''
Write-Host '==============================================' -ForegroundColor Cyan
if ($selfCheckFailures.Count -eq 0) {
  Write-Host '  安装完成，自检全部通过！' -ForegroundColor Green
  Write-Host '==============================================' -ForegroundColor Cyan
  Write-Host '  接下来：'
  Write-Host '  1. 完全退出并重启 dsh'
  Write-Host '  2. 浏览器强刷页面 (Ctrl+F5)'
  Write-Host '  3. 新建会话 -> 预设选择器选「Kaz 模式」'
  Write-Host '     或点会话头部的「Kaz 模式」按钮'
  Write-Host ''
  Write-Host '  验证：dsh --profile web --dump-config 应能看到 kaz-mode 等行'
  Write-Host ''
  exit 0
} else {
  Write-Host '  安装完成，但自检发现问题：' -ForegroundColor Red
  foreach ($f in $selfCheckFailures) { Write-Host ('  - ' + $f) -ForegroundColor Red }
  Write-Host '==============================================' -ForegroundColor Cyan
  Write-Host '  请把本窗口输出发给作者，或运行只读诊断：'
  Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Diagnose'
  Write-Host ''
  exit 1
}
