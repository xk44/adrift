# Adrift installer for Windows (PowerShell 5.1+): app dependencies, ComfyUI
# connection, optional build. Safe to re-run. Models are NOT downloaded here:
# the setup wizard in the app does that.
#
#   .\install.ps1                      ask about each step
#   .\install.ps1 -Yes                 take the defaults, no questions
#   .\install.ps1 -DryRun              print every action, change nothing
#   (or install.cmd with the same options, which skips the execution policy prompt)
#
# ComfyUI (pick one; default: find an existing install and ask):
#   -Comfy PATH          use the ComfyUI folder at PATH (main.py, portable or Desktop folder)
#   -Remote URL          use ComfyUI on another machine, e.g. http://gpu-box:8188
#   -InstallComfy        install ComfyUI + PyTorch (~6 GB) into -InstallDir (default ..\ComfyUI)
#   -NoComfy             skip; set it up later in the app
#
# Other options: -Packs / -NoPacks (pinned third-party node packs, default no),
# -Build / -NoBuild (production build for fast page loads, default yes),
# -Start / -NoStart (start Adrift when done; default: ask, no with -Yes).
# $env:ADRIFT_TORCH_INDEX overrides the PyTorch wheel index URL.
[CmdletBinding()]
param(
  [string]$Comfy,
  [string]$Remote,
  [switch]$InstallComfy,
  [string]$InstallDir,
  [switch]$NoComfy,
  [switch]$Packs,
  [switch]$NoPacks,
  [switch]$Build,
  [switch]$NoBuild,
  [switch]$Start,
  [switch]$NoStart,
  [switch]$Yes,
  [switch]$DryRun,
  [switch]$Help
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$AppDir = $PSScriptRoot
Set-Location $AppDir
$ComfyGitUrl = 'https://github.com/Comfy-Org/ComfyUI'
$ComfyCommit = 'e3bee7ffcb7d6547ed0bcd15221792f3b8646b17'  # tested core, as docker/Dockerfile.comfyui
$TorchBase = 'https://download.pytorch.org/whl'

# Symbols built from code points: PowerShell 5.1 reads a BOM-less script as ANSI.
$CHECK = [char]0x2713; $ARROW = [char]0x2192; $CROSS = [char]0x2717

if ($Help) {
  Get-Content $PSCommandPath | Select-Object -First 19 | ForEach-Object { $_ -replace '^# ?', '' }
  exit 0
}
$modes = @()
if ($Comfy) { $modes += 'path' }
if ($Remote) { $modes += 'remote' }
if ($InstallComfy) { $modes += 'install' }
if ($NoComfy) { $modes += 'none' }
if ($modes.Count -gt 1) { Write-Host "$CROSS pick one of -Comfy, -Remote, -InstallComfy, -NoComfy"; exit 2 }
$Mode = if ($modes.Count) { $modes[0] } else { '' }

function Step($t) { Write-Host ""; Write-Host "$ARROW $t" }
function Ok($t) { Write-Host "$CHECK $t" }
function Did($t) { if ($DryRun) { Write-Host "$CHECK $t (dry run)" } else { Ok $t } }
function Note($t) { Write-Host "  $t" }
function Warn($t) { Write-Host "! $t" -ForegroundColor Yellow }
function Die($t) { Write-Host "$CROSS $t" -ForegroundColor Red; exit 1 }
function Show-Cmd($exe, $argv) {
  (@($exe) + $argv | ForEach-Object { if ("$_" -match '\s') { "`"$_`"" } else { "$_" } }) -join ' '
}
# Run an external command (only print it with -DryRun); stop on failure.
function Run($exe, [string[]]$argv) {
  if ($DryRun) { Write-Host "  [dry-run] $(Show-Cmd $exe $argv)"; return }
  Write-Host "  > $(Show-Cmd $exe $argv)"
  & $exe @argv
  if ($LASTEXITCODE -ne 0) { Die "failed (exit $LASTEXITCODE): $(Show-Cmd $exe $argv)" }
}
function Interactive { (-not $Yes) -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected }
function Ask-YN($q, [bool]$def) {
  $hint = if ($def) { '[Y/n]' } else { '[y/N]' }
  if (-not (Interactive)) { Note "$q $hint $(if ($def) {'yes'} else {'no'})"; return $def }
  $r = Read-Host "  $q $hint"
  if ($r -match '^[Yy]') { return $true }
  if ($r -match '^[Nn]') { return $false }
  return $def
}
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Full($p) {
  if ($p -like '~*') { $p = Join-Path $HOME $p.Substring(1).TrimStart('\', '/') }
  $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($p)
}

if ($DryRun) { Write-Host "Dry run: nothing is installed or written." }

# 1. preflight
Step 'Checking tools'
$nodeHelp = @(
  '  Install Node.js 20 or newer (an LTS release), then run install again:',
  '    winget install OpenJS.NodeJS.LTS      or the LTS installer from https://nodejs.org'
)
if (-not (Has node) -or -not (Has npm)) { Write-Host "$CROSS Node.js and npm are needed."; $nodeHelp | Write-Host; exit 1 }
$nodeMajor = [int](& node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt 20) { Write-Host "$CROSS Node.js $(& node -v) is too old."; $nodeHelp | Write-Host; exit 1 }
Ok "Node.js $(& node -v), npm $(& npm.cmd -v)"
if ($nodeMajor % 2 -eq 1) { Warn "Node $nodeMajor is not an LTS release; better-sqlite3 may have to compile (needs build tools)." }
$haveGit = Has git

# 2. app dependencies
Step 'App dependencies'
$stamp = 'node_modules\.adrift-lock'
if (Test-Path package-lock.json) {
  $lockHash = (Get-FileHash package-lock.json -Algorithm SHA256).Hash
  $hidden = 'node_modules\.package-lock.json'
  $inSync = ((Test-Path $stamp) -and ((Get-Content $stamp -Raw).Trim() -eq $lockHash)) -or
            ((Test-Path $hidden) -and ((Get-Item $hidden).LastWriteTime -ge (Get-Item package-lock.json).LastWriteTime))
  if ($inSync) { Ok 'node_modules matches package-lock.json' }
  else {
    Run 'npm.cmd' @('ci')
    if (-not $DryRun) { Set-Content -Path $stamp -Value $lockHash -NoNewline }
    Did 'dependencies installed'
  }
} else { Run 'npm.cmd' @('install'); Did 'dependencies installed' }
# The database driver is a native module: npm finishes "successfully" when its
# install script was blocked or its download failed, then every job fails later.
function SqliteOk { & node -e "new (require('better-sqlite3'))(':memory:').close()" *> $null; return ($LASTEXITCODE -eq 0) }
if (-not $DryRun -and -not (SqliteOk)) {
  Write-Host "! better-sqlite3 did not load; rebuilding it"
  & npm.cmd rebuild better-sqlite3
  if (-not (SqliteOk)) { Write-Host "$CROSS better-sqlite3 still does not load. Install Visual Studio Build Tools and Python, or use a Node LTS release, then run: npm rebuild better-sqlite3"; exit 1 }
  Did 'better-sqlite3 rebuilt'
}

# 3. ComfyUI
# "git" = main.py inside, "portable" = ComfyUI_windows_portable\ComfyUI,
# "desktop" = ComfyUI Desktop's base folder (models + .venv, no main.py).
function Comfy-Kind($d) {
  if (-not $d -or -not (Test-Path $d -PathType Container)) { return '' }
  if (Test-Path (Join-Path $d 'main.py')) {
    if (Test-Path (Join-Path $d '..\python_embeded\python.exe')) { return 'portable' }
    return 'git'
  }
  if ((Test-Path (Join-Path $d 'ComfyUI\main.py')) -and (Test-Path (Join-Path $d 'python_embeded'))) { return 'portable-root' }
  if ((Test-Path (Join-Path $d 'models')) -and ((Test-Path (Join-Path $d '.venv')) -or (Test-Path (Join-Path $d 'user')))) { return 'desktop' }
  return ''
}
function Env-Value($key) {
  if (-not (Test-Path .env.local)) { return '' }
  $m = Select-String -Path .env.local -Pattern "^\s*$key=(.*)$" | Select-Object -Last 1
  if ($m) { return $m.Matches[0].Groups[1].Value.Trim().Trim('"', "'") }
  return ''
}
function Detect-Comfy {
  $cands = @($env:COMFY_ROOT, (Env-Value 'COMFY_ROOT'),
    (Join-Path $AppDir '..\ComfyUI'), (Join-Path $HOME 'ComfyUI'),
    (Join-Path $HOME 'Documents\ComfyUI'), (Join-Path $HOME 'comfy\ComfyUI'),
    (Join-Path $AppDir '..\ComfyUI_windows_portable\ComfyUI'),
    (Join-Path $AppDir '..\..\ComfyUI_windows_portable\ComfyUI'),
    (Join-Path $HOME 'ComfyUI_windows_portable\ComfyUI'),
    (Join-Path $HOME 'Downloads\ComfyUI_windows_portable\ComfyUI'),
    (Join-Path $HOME 'Desktop\ComfyUI_windows_portable\ComfyUI'))
  foreach ($c in $cands) {
    if (-not $c) { continue }
    $f = Full $c
    if (Comfy-Kind $f) { return $f }
  }
  return $null
}
function Is-Url($u) { $u -match '^https?://.+' }

Step 'ComfyUI'
$arg = ''
if ($Comfy) { $arg = $Comfy } elseif ($Remote) { $arg = $Remote }
if (-not $Mode) {
  $found = Detect-Comfy
  if ($found) {
    Note "Found ComfyUI at $found"
    if (Ask-YN "Use ComfyUI at ${found}?" $true) { $Mode = 'path'; $arg = $found }
  } else {
    Note 'No ComfyUI found (looked in ..\ComfyUI, ~\ComfyUI, ~\Documents\ComfyUI, ComfyUI_windows_portable).'
  }
}
if (-not $Mode) {
  if (Interactive) {
    Note '[1] Install ComfyUI next to Adrift (~6 GB incl. PyTorch)'
    Note '[2] I have one: enter its folder or URL'
    Note "[3] Skip, I'll set it up in the app"
    $choice = Read-Host '  Choice [1]'
    if (-not $choice) { $choice = '1' }
    switch ($choice) {
      '1' { $Mode = 'install' }
      '2' {
        foreach ($i in 1..3) {
          $arg = Read-Host '  ComfyUI folder or URL'
          if (Is-Url $arg) { $Mode = 'remote'; break }
          if ($arg -and (Comfy-Kind (Full $arg))) { $Mode = 'path'; break }
          Warn 'not a ComfyUI folder (no main.py) or http(s):// URL'
        }
        if (-not $Mode) { $Mode = 'none' }
      }
      default { $Mode = 'none' }
    }
  } else { $Mode = 'none' }
}

$envSets = @(); $comfyDir = ''; $comfyPy = ''; $kind = ''; $url = ''
function Venv-Python($d) {
  foreach ($c in @('venv\Scripts\python.exe', '.venv\Scripts\python.exe', '..\python_embeded\python.exe')) {
    $p = Join-Path $d $c
    if (Test-Path $p) { return (Full $p) }
  }
  return ''
}
function Find-Python {
  # Returns @(exe, args...) for a Python 3.10-3.13.
  $cands = @()
  if (Has py) { foreach ($v in '3.12', '3.13', '3.11', '3.10') { $cands += , @('py', "-$v") } }
  foreach ($n in 'python', 'python3') { if (Has $n) { $cands += , @($n) } }
  foreach ($c in $cands) {
    $exe = $c[0]; $rest = @($c | Select-Object -Skip 1)
    try { $v = (& $exe @rest -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>$null) } catch { continue }
    if ($LASTEXITCODE -eq 0 -and $v -match '^3\.(1[0-3])$') { return , $c }
  }
  return $null
}

switch ($Mode) {
  'path' {
    $comfyDir = Full $arg
    $kind = Comfy-Kind $comfyDir
    if ($kind -eq 'portable-root') { $comfyDir = Join-Path $comfyDir 'ComfyUI'; $kind = 'portable' }
    if (-not $kind) { Die "$comfyDir is not a ComfyUI folder (no main.py). Use -InstallComfy to install one." }
    $envSets += "COMFY_ROOT=$comfyDir"
    if ($kind -eq 'desktop') {
      Ok "ComfyUI Desktop folder: $comfyDir"
      Note 'Start ComfyUI Desktop yourself and add this to its server arguments (Settings > Server-Config):'
      Note '  --enable-cors-header http://localhost:3000'
    } else {
      Ok "ComfyUI ($kind): $comfyDir"
      $comfyPy = Venv-Python $comfyDir
      if (-not $comfyPy) { Warn "no venv\ or .venv\ in ${comfyDir}: adrift.cmd needs ComfyUI's own Python there." }
    }
  }
  'remote' {
    if (-not (Is-Url $arg)) { Die '-Remote needs an http:// or https:// URL, e.g. http://gpu-box:8188' }
    $url = $arg.TrimEnd('/')
    $ws = $url -replace '^http://', 'ws://' -replace '^https://', 'wss://'
    $envSets += "COMFY_HTTP_URL=$url", "COMFY_WS_BASE=$ws", "NEXT_PUBLIC_COMFY_WS_BASE=$ws"
    Ok "ComfyUI on $url"
    if (-not $DryRun) {
      try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 4 "$url/system_stats" | Out-Null; Ok 'it answers' }
      catch { Warn "no answer from $url yet (fine if that machine is off)" }
    }
    Note 'Start ComfyUI there with: --listen 0.0.0.0 --enable-cors-header http://localhost:3000'
  }
  'install' {
    $comfyDir = Full $(if ($InstallDir) { $InstallDir } else { Join-Path $AppDir '..\ComfyUI' })
    if (-not $haveGit) { Die 'git is needed to install ComfyUI: winget install Git.Git' }
    $py = Find-Python
    if (-not $py) { Die 'Python 3.10-3.13 is needed for ComfyUI: winget install Python.Python.3.12' }
    Note "Installing ComfyUI into $comfyDir (~6 GB incl. PyTorch)"
    if (Test-Path (Join-Path $comfyDir 'main.py')) { Ok 'ComfyUI already cloned' }
    elseif ((Test-Path $comfyDir) -and (Get-ChildItem $comfyDir -Force | Select-Object -First 1)) {
      Die "$comfyDir exists and is not a ComfyUI folder; pick another: -InstallDir DIR"
    } else {
      Run 'git' @('clone', $ComfyGitUrl, $comfyDir)
      Run 'git' @('-C', $comfyDir, 'checkout', '-q', $ComfyCommit)
    }
    $comfyPy = Venv-Python $comfyDir
    if (-not $comfyPy) {
      Run $py[0] (@($py | Select-Object -Skip 1) + @('-m', 'venv', (Join-Path $comfyDir 'venv')))
      $comfyPy = Join-Path $comfyDir 'venv\Scripts\python.exe'
    } else { Ok "venv: $comfyPy" }
    $cpuOnly = $false
    if ($env:ADRIFT_TORCH_INDEX) { $idx = $env:ADRIFT_TORCH_INDEX; $why = 'ADRIFT_TORCH_INDEX' }
    else {
      $drv = ''
      if (Has nvidia-smi) { try { $drv = (& nvidia-smi --query-gpu=driver_version --format=csv,noheader | Select-Object -First 1).Trim() } catch { $drv = '' } }
      if ($drv) {
        $major = [int]($drv.Split('.')[0])
        $idx = if ($major -ge 580) { "$TorchBase/cu130" } elseif ($major -ge 570) { "$TorchBase/cu128" } else { "$TorchBase/cu126" }
        $why = "NVIDIA driver $drv"
      } else { $idx = "$TorchBase/cpu"; $why = 'no NVIDIA GPU found'; $cpuOnly = $true }
    }
    $torchOk = $false
    if (-not $DryRun -and (Test-Path $comfyPy)) {
      try { & $comfyPy -c 'import torch' 2>$null; $torchOk = ($LASTEXITCODE -eq 0) } catch { $torchOk = $false }
    }
    if ($torchOk) { Ok 'PyTorch already installed' }
    else {
      Note "PyTorch: $idx ($why; override with `$env:ADRIFT_TORCH_INDEX)"
      if ($cpuOnly) { Warn 'No NVIDIA GPU: ComfyUI will run on the CPU and generation will be VERY slow.' }
      Run $comfyPy @('-m', 'pip', 'install', 'torch', 'torchvision', 'torchaudio', '--index-url', $idx)
    }
    $req = Join-Path $comfyDir 'requirements.txt'
    $reqStamp = Join-Path $comfyDir 'venv\.adrift-requirements'
    $reqHash = if (Test-Path $req) { (Get-FileHash $req).Hash } else { '' }
    if (-not $DryRun -and (Test-Path $reqStamp) -and ((Get-Content $reqStamp -Raw).Trim() -eq $reqHash)) { Ok 'ComfyUI requirements already installed' }
    else {
      Run $comfyPy @('-m', 'pip', 'install', '-r', $req)
      if (-not $DryRun) { Set-Content -Path $reqStamp -Value (Get-FileHash $req).Hash -NoNewline }
    }
    $kind = 'git'
    $envSets += "COMFY_ROOT=$comfyDir"
    Did "ComfyUI ready: $comfyDir"
  }
  default { Ok "Skipped. The setup wizard in the app connects ComfyUI (or run .\install.ps1 -InstallComfy later)." }
}

# Optional third-party node packs (+ Adrift's own nodes) for a local ComfyUI.
if ($kind -eq 'git' -or $kind -eq 'portable') {
  $doPacks = if ($Packs) { $true } elseif ($NoPacks) { $false } else {
    Ask-YN 'Install the custom node packs the full tool set needs (pinned versions, ~1.5 GB)?' $false }
  if ($doPacks) {
    Step 'Node packs'
    if (-not $haveGit) { Die 'git is needed for the node packs: winget install Git.Git' }
    if (-not $comfyPy) { Die "no ComfyUI Python found for $comfyDir" }
    $nodesDir = Join-Path $comfyDir 'custom_nodes'
    Run $comfyPy @('docker\install-comfy-packs.py', $nodesDir)
    # Constrain the packs' deps to the versions ComfyUI is validated with; the
    # torch pins are left out so the installed GPU build is never replaced.
    if (-not (Test-Path 'docker\comfyui-constraints.txt')) { Die 'missing docker\comfyui-constraints.txt' }
    $packConstraints = [IO.Path]::GetTempFileName()
    Get-Content 'docker\comfyui-constraints.txt' |
      Where-Object { $_ -notmatch '^(torch|torchvision|torchaudio)==' } |
      Set-Content -Encoding ascii $packConstraints
    Run $comfyPy @('-m', 'pip', 'install', '-r', 'docker\comfyui-packs-requirements.txt', '-c', $packConstraints)
    Remove-Item -Force $packConstraints
    foreach ($n in Get-ChildItem comfy_nodes -Directory) {
      if (-not (Test-Path (Join-Path $n.FullName '__init__.py'))) { continue }
      $dest = Join-Path $nodesDir $n.Name
      if (Test-Path $dest) { continue }
      # A junction needs no administrator rights (a symlink would).
      if ($DryRun) { Write-Host "  [dry-run] junction $dest -> $($n.FullName)" }
      else { New-Item -ItemType Junction -Path $dest -Target $n.FullName | Out-Null; Write-Host "  > junction $dest -> $($n.FullName)" }
    }
    Did 'node packs installed (restart ComfyUI to load them)'
  } else { Note 'Node packs skipped: each Tools card shows what it is missing and has a Set up button.' }
}

# 4. .env.local
Step 'Settings (.env.local)'
$envArgs = @('scripts\install-env.mjs')
if ($DryRun) { $envArgs += '--dry-run' }
& node @($envArgs + $envSets)
if ($LASTEXITCODE -ne 0) { Die 'could not write .env.local' }

# 5. production build
Step 'Build'
$fresh = $false
if (Test-Path node_modules) { & node scripts\build-fresh.mjs | Out-Null; $fresh = ($LASTEXITCODE -eq 0) }
if ($fresh -and -not $Build) { Ok 'production build is up to date' }
else {
  $doBuild = if ($Build) { $true } elseif ($NoBuild) { $false } else {
    Ask-YN 'Build the app now for faster page loads? (~2 min; otherwise pages compile on first visit)' $true }
  if ($doBuild) {
    if ($DryRun) { Write-Host '  [dry-run] NEXT_DIST_DIR=.next-build node node_modules\next\dist\bin\next build' }
    else {
      $env:NEXT_DIST_DIR = '.next-build'; $env:NEXT_TELEMETRY_DISABLED = '1'
      Run 'node' @('node_modules\next\dist\bin\next', 'build')
      Remove-Item Env:NEXT_DIST_DIR
    }
    Run 'node' @('scripts\build-fresh.mjs', '--stamp')
    Did 'built (.next-build)'
  } else { Note 'No build: adrift.cmd uses the dev server (first visit to each page is slow).' }
}

Write-Host ''
if ($DryRun) { Ok 'Dry run finished: nothing was changed.' } else { Ok 'Adrift is installed.' }
switch ($Mode) {
  { $_ -in 'path', 'install' } { Note "ComfyUI: $comfyDir" }
  'remote' { Note "ComfyUI: $url" }
  default { Note 'ComfyUI: not set up yet (the setup wizard in the app helps)' }
}
Note 'Start it with:  adrift.cmd     (opens http://localhost:3000 in your browser)'
if (-not $DryRun -and -not $NoStart) {
  $doStart = if ($Start) { $true } elseif (Interactive) { Ask-YN 'Start Adrift now?' $true } else { $false }
  if ($doStart) { Write-Host ''; & (Join-Path $AppDir 'scripts\adrift.ps1') }
}
