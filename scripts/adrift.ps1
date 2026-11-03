# Start Adrift (and your local ComfyUI) on Windows and open it in the browser.
# Run it through adrift.cmd in the app folder:
#
#   adrift.cmd          start whatever is not running yet, open the app
#   adrift.cmd -Dev     use the dev server even when a production build exists
#
# Serves the production build (.next-build) when it is newer than the source,
# else the dev server. Starts ComfyUI from COMFY_ROOT (environment or
# .env.local): the portable build with its python_embeded, a git install with
# its venv. A remote ComfyUI URL, a ComfyUI Desktop folder or no ComfyUI yet
# starts only the app (the setup wizard takes it from there).
# Ports: PORT (app, default 3000), COMFY_PORT (ComfyUI, default 8188).
# Logs: %LOCALAPPDATA%\Adrift\logs (ADRIFT_LOG_DIR overrides). ADRIFT_NO_OPEN=1
# skips opening the browser. For the GPU-free mock mode use Git Bash or WSL:
# ./adrift --mock.
[CmdletBinding()]
param([switch]$Dev, [switch]$Help)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

if ($Help) {
  Get-Content $PSCommandPath | Select-Object -First 15 | ForEach-Object { $_ -replace '^# ?', '' }
  exit 0
}
$AppDir = Split-Path -Parent $PSScriptRoot
Set-Location $AppDir

$nodeHelp = '  Install Node.js 20 or newer, then run adrift.cmd again:  winget install OpenJS.NodeJS.LTS  (or https://nodejs.org)'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host 'Node.js is not installed.'; Write-Host $nodeHelp; exit 1 }
$nodeMajor = 0
try { $nodeMajor = [int](& node -p 'process.versions.node.split(".")[0]') } catch { $nodeMajor = 0 }
if ($nodeMajor -lt 20) { Write-Host "Node.js $(& node -v) is too old (Adrift needs 20 or newer)."; Write-Host $nodeHelp; exit 1 }
if (-not (Test-Path node_modules)) {
  Write-Host 'Adrift is not installed yet: run install.cmd first (one time), then adrift.cmd.'
  exit 1
}

$AppPort = if ($env:PORT) { $env:PORT } else { '3000' }
$ComfyPort = if ($env:COMFY_PORT) { $env:COMFY_PORT } else { '8188' }
$AppUrl = "http://localhost:$AppPort"
$Origin = if ($env:CJ_ORIGIN) { $env:CJ_ORIGIN } else { $AppUrl }
$LogDir = if ($env:ADRIFT_LOG_DIR) { $env:ADRIFT_LOG_DIR } else { Join-Path $env:LOCALAPPDATA 'Adrift\logs' }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Env-Value($key) {  # environment, else .env.local (never printed)
  $v = [Environment]::GetEnvironmentVariable($key)
  if (-not $v -and (Test-Path .env.local)) {
    $m = Select-String -Path .env.local -Pattern "^\s*$key=(.*)$" | Select-Object -Last 1
    if ($m) { $v = $m.Matches[0].Groups[1].Value.Trim().Trim('"', "'") }
  }
  return "$v"
}
function Answers($url) {
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 $url | Out-Null; return $true } catch { return $false }
}
function Wait-For($url, $seconds) {
  for ($i = 0; $i -lt $seconds; $i++) { if (Answers $url) { return $true }; Start-Sleep -Seconds 1 }
  return $false
}

# ── which ComfyUI ───────────────────────────────────────────────────────────
$comfyUrl = Env-Value 'COMFY_HTTP_URL'
if (-not $comfyUrl -and (Test-Path data\runtime_settings.json)) {
  try { $comfyUrl = "$((Get-Content data\runtime_settings.json -Raw | ConvertFrom-Json).comfy.httpUrl)" } catch { $comfyUrl = '' }
}
$root = Env-Value 'COMFY_ROOT'
if ($root -like '~*') { $root = Join-Path $HOME $root.Substring(1).TrimStart('\', '/') }
elseif ($root -and -not [IO.Path]::IsPathRooted($root)) { $root = Join-Path $AppDir $root }
if (-not $root -and (Test-Path (Join-Path $AppDir '..\ComfyUI\main.py'))) { $root = Join-Path $AppDir '..\ComfyUI' }

$startComfy = $false
if ($comfyUrl -and $comfyUrl -notmatch '^https?://(localhost|127\.|\[::1\])') {
  Write-Host "ComfyUI: $comfyUrl (remote, not started here)"
} elseif (-not $root) {
  Write-Host 'ComfyUI: not set up yet, so only the app is started.'
  Write-Host "  Point Adrift at it (then run adrift.cmd again), or pick it in the app's setup wizard:"
  Write-Host '    install.cmd -Comfy C:\path\to\ComfyUI      a ComfyUI folder on this computer'
  Write-Host '    install.cmd -Remote http://HOST:8188       ComfyUI on another computer'
  Write-Host '    install.cmd -InstallComfy                  install ComfyUI next to Adrift (~6 GB)'
} elseif (-not (Test-Path (Join-Path $root 'main.py'))) {
  Write-Host "ComfyUI: start ComfyUI Desktop (or your ComfyUI) yourself; $root has no main.py"
} else { $startComfy = $true; $env:COMFY_ROOT = $root }

if ($startComfy) {
  if (Answers "http://127.0.0.1:$ComfyPort/system_stats") { Write-Host "ComfyUI already running on :$ComfyPort" }
  else {
    # Same flags as scripts/start-comfyui.sh. The portable build's
    # run_nvidia_gpu.bat is not used: it does not pass --enable-cors-header,
    # without which ComfyUI refuses the app's WebSocket.
    $flags = @('--listen', '127.0.0.1', '--port', $ComfyPort, '--enable-cors-header', $Origin, '--preview-method', 'auto')
    $embedded = Join-Path $root '..\python_embeded\python.exe'
    if (Test-Path $embedded) {
      $py = $embedded; $pyArgs = @('-s', 'main.py', '--windows-standalone-build') + $flags
    } else {
      $py = @('venv\Scripts\python.exe', '.venv\Scripts\python.exe') | ForEach-Object { Join-Path $root $_ } |
        Where-Object { Test-Path $_ } | Select-Object -First 1
      if (-not $py) {
        Write-Host "! no venv\ in $root (ComfyUI's own Python with GPU PyTorch). Run install.cmd -InstallComfy, or start ComfyUI yourself."
      }
      $pyArgs = @('main.py') + $flags
    }
    if ($py) {
      if (Select-String -Path (Join-Path $root 'comfy\cli_args.py') -Pattern '"--cache-ram"' -Quiet -ErrorAction SilentlyContinue) {
        $pyArgs += @('--cache-ram', 'auto')
      }
      Write-Host 'starting ComfyUI...'
      $p = Start-Process -FilePath $py -ArgumentList $pyArgs -WorkingDirectory $root -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $LogDir 'adrift-comfyui.log') -RedirectStandardError (Join-Path $LogDir 'adrift-comfyui.err.log')
      Write-Host "  ComfyUI pid $($p.Id)"
      # Not fatal: the app still starts and shows ComfyUI as offline.
      if (-not (Wait-For "http://127.0.0.1:$ComfyPort/system_stats" 90)) { Write-Host "! ComfyUI is not up yet (see $LogDir)" }
    }
  }
}

# ── the app ─────────────────────────────────────────────────────────────────
function Is-Adrift($url) {  # the app's health route answers {"ok":true,...,"uptime":N}
  try { return ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 20 "$url/api/health").Content -match '"uptime"') } catch { return $false }
}
if (Answers $AppUrl) {
  if (-not (Is-Adrift $AppUrl)) {
    Write-Host "Port $AppPort is in use by another program, not Adrift."
    Write-Host "  Stop it, or start Adrift on another port. PowerShell: `$env:PORT='3001'; .\adrift.cmd   cmd: set PORT=3001 then adrift.cmd"
    exit 1
  }
  Write-Host "Adrift already running on :$AppPort"
}
else {
  $mode = 'dev'
  if (-not $Dev) {
    $reason = & node scripts\build-fresh.mjs
    if ($LASTEXITCODE -eq 0) { $mode = 'start'; $env:NEXT_DIST_DIR = '.next-build' }
    elseif (Test-Path .next-build) { Write-Host "Using the dev server: $reason. Rebuild with install.cmd -Build" }
  }
  Write-Host "starting Adrift app ($mode)..."
  $p = Start-Process -FilePath 'node' -ArgumentList @('scripts\serve.mjs', $mode, '-p', $AppPort) -WorkingDirectory $AppDir `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $LogDir 'adrift-app.log') -RedirectStandardError (Join-Path $LogDir 'adrift-app.err.log')
  Write-Host "  app pid $($p.Id)"
  if (-not (Wait-For $AppUrl 180)) { Write-Host "! Adrift did not come up at $AppUrl (see $LogDir)"; exit 1 }
}
if ($env:ADRIFT_NO_OPEN -ne '1') { Start-Process $AppUrl }
Write-Host "Adrift is up: $AppUrl"
Write-Host "Logs: $LogDir   Stop: Stop-Process -Id <pid> (or end the node/python processes in Task Manager)"
