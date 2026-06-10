#Requires -Version 5.1
<#
.SYNOPSIS
    CinematicAI Studio — Avvio sviluppo (Windows)
    Controlla dipendenze, configura l'ambiente e lancia tutti i servizi.
.DESCRIPTION
    Prima esecuzione: installa automaticamente node_modules e venv Python.
    Esecuzioni successive: avvio diretto in pochi secondi.
.EXAMPLE
    .\start-dev.ps1
    oppure doppio click su start-dev.bat
#>

$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ROOT

# ── Helpers ───────────────────────────────────────────────────────────────────

function Write-Header { param($t)
    Write-Host ""
    Write-Host "  $t" -ForegroundColor Cyan
    Write-Host "  $('─' * ($t.Length))" -ForegroundColor DarkGray
}

function Write-Ok   { param($m) Write-Host "  [OK]  $m" -ForegroundColor Green }
function Write-Info { param($m) Write-Host "  [..]  $m" -ForegroundColor Gray }
function Write-Warn { param($m) Write-Host "  [!!]  $m" -ForegroundColor Yellow }
function Write-Err  { param($m) Write-Host "  [XX]  $m" -ForegroundColor Red }
function Write-Step { param($m) Write-Host "  -->   $m" -ForegroundColor White }

function Abort { param($m)
    Write-Err $m
    Write-Host ""
    Write-Host "  Premi un tasto per chiudere..." -ForegroundColor DarkGray
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    exit 1
}

# ── Titolo ────────────────────────────────────────────────────────────────────

Clear-Host
Write-Host ""
Write-Host "  ╔══════════════════════════════════════════╗" -ForegroundColor DarkGray
Write-Host "  ║   CinematicAI Studio  —  Dev Launcher   ║" -ForegroundColor Cyan
Write-Host "  ╚══════════════════════════════════════════╝" -ForegroundColor DarkGray
Write-Host ""

# ═══════════════════════════════════════════════════════════════════════════════
Write-Header "1. Verifica Node.js"
# ═══════════════════════════════════════════════════════════════════════════════

$NodePath = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodePath) {
    Abort "Node.js non trovato. Installa da https://nodejs.org (versione 20+)"
}
$NodeVer = & node --version 2>&1
$NpmVer  = & npm  --version 2>&1
Write-Ok "Node.js $NodeVer  |  npm $NpmVer"

# ═══════════════════════════════════════════════════════════════════════════════
Write-Header "2. Verifica Python 3.10+"
# ═══════════════════════════════════════════════════════════════════════════════

$PythonExe = $null
$PythonCandidates = @(
    "python",
    "python3",
    "py",
    "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python310\python.exe",
    "C:\Python312\python.exe",
    "C:\Python311\python.exe",
    "C:\Python310\python.exe",
    "E:\Programmi\anaconda3\python.exe",
    "C:\ProgramData\anaconda3\python.exe",
    "$env:USERPROFILE\anaconda3\python.exe",
    "$env:USERPROFILE\miniconda3\python.exe"
)

foreach ($c in $PythonCandidates) {
    try {
        $v = & $c --version 2>&1
        if ($v -match "Python 3\.(1[0-9]|[89])") {
            $PythonExe = $c
            Write-Ok "Python trovato: $c ($v)"
            break
        }
    } catch { continue }
}

if (-not $PythonExe) {
    Abort "Python 3.10+ non trovato. Installa da https://python.org o aggiungi al PATH."
}

# ═══════════════════════════════════════════════════════════════════════════════
Write-Header "3. Dipendenze Node.js (node_modules)"
# ═══════════════════════════════════════════════════════════════════════════════

$NeedNpmInstall = -not (Test-Path "node_modules\electron\package.json")
if ($NeedNpmInstall) {
    Write-Step "node_modules mancante — eseguo npm install..."
    & npm install
    if ($LASTEXITCODE -ne 0) { Abort "npm install fallito" }
    Write-Ok "node_modules installato"
} else {
    Write-Ok "node_modules presente"
}

# ═══════════════════════════════════════════════════════════════════════════════
Write-Header "4. Ambiente Python (venv)"
# ═══════════════════════════════════════════════════════════════════════════════

$VenvPython = Join-Path $ROOT "venv\Scripts\python.exe"
$VenvPip    = Join-Path $ROOT "venv\Scripts\pip.exe"

if (-not (Test-Path $VenvPython)) {
    Write-Step "Creazione venv isolato (evita conflitti con pacchetti di sistema)..."
    & $PythonExe -m venv venv
    if ($LASTEXITCODE -ne 0) { Abort "Creazione venv fallita" }
    Write-Ok "venv creato"
} else {
    Write-Ok "venv presente"
}

# ═══════════════════════════════════════════════════════════════════════════════
Write-Header "5. Dipendenze Python"
# ═══════════════════════════════════════════════════════════════════════════════

# Controlla se le dipendenze chiave sono installate nel venv
$DepsOk = $false
try {
    $check = & $VenvPython -c "import fastapi, uvicorn, openai, anthropic, structlog, pydantic; print('ok')" 2>&1
    $DepsOk = ($check -eq 'ok')
} catch { $DepsOk = $false }

if (-not $DepsOk) {
    Write-Step "Installazione dipendenze Python in venv..."
    & $VenvPython -m pip install --upgrade pip --quiet
    & $VenvPython -m pip install -r requirements.txt
    if ($LASTEXITCODE -ne 0) { Abort "pip install fallito — controlla requirements.txt" }

    # Force-reinstall C extensions per il corretto ABI
    Write-Step "Reinstall estensioni C per ABI Python corretta..."
    & $VenvPython -m pip install --force-reinstall pydantic pydantic-core jiter --quiet
    if ($LASTEXITCODE -ne 0) { Abort "Force-reinstall pydantic/jiter fallito" }

    Write-Ok "Dipendenze Python installate"
} else {
    Write-Ok "Dipendenze Python presenti"
}

# Verifica finale
try {
    $check = & $VenvPython -c "import fastapi, uvicorn, openai, anthropic, structlog, pydantic; print('ok')" 2>&1
    if ($check -ne 'ok') { throw "import fallito" }
    Write-Ok "Verifica import: OK"
} catch {
    Abort "Dipendenze Python non caricate correttamente: $_"
}

# ═══════════════════════════════════════════════════════════════════════════════
Write-Header "6. Avvio servizi"
# ═══════════════════════════════════════════════════════════════════════════════

$BackendCmd  = "Set-Location '$ROOT'; Write-Host '[Backend] Avvio uvicorn su :8123...' -ForegroundColor Blue; & '$VenvPython' -m uvicorn src.core.main:app --reload --reload-dir src/core --reload-delay 2 --port 8123 --host 127.0.0.1"
$ViteCmd     = "Set-Location '$ROOT'; Write-Host '[Vite] Avvio dev server su :5300...' -ForegroundColor Green; npx --no-install vite"
$ElectronCmd = "Set-Location '$ROOT'; Write-Host '[Electron] Attendo Vite...' -ForegroundColor Magenta; npx --no-install wait-on http://127.0.0.1:5300 -t 120000; Write-Host '[Electron] Avvio...' -ForegroundColor Magenta; npx --no-install electron ."

Write-Step "Avvio finestra Backend  (blu)..."
Start-Process powershell -ArgumentList @(
    '-NoProfile', '-NoExit',
    '-Command', $BackendCmd
) -WorkingDirectory $ROOT

Start-Sleep -Milliseconds 800

Write-Step "Avvio finestra Vite     (verde)..."
Start-Process powershell -ArgumentList @(
    '-NoProfile', '-NoExit',
    '-Command', $ViteCmd
) -WorkingDirectory $ROOT

Start-Sleep -Milliseconds 800

Write-Step "Avvio finestra Electron (viola)..."
Start-Process powershell -ArgumentList @(
    '-NoProfile', '-NoExit',
    '-Command', $ElectronCmd
) -WorkingDirectory $ROOT

# ═══════════════════════════════════════════════════════════════════════════════

Write-Host ""
Write-Host "  ✓ Tutti i servizi avviati in finestre separate" -ForegroundColor Green
Write-Host ""
Write-Host "  Backend  →  http://127.0.0.1:8123" -ForegroundColor Blue
Write-Host "  Vite     →  http://127.0.0.1:5300" -ForegroundColor Green
Write-Host "  Electron →  si apre automaticamente" -ForegroundColor Magenta
Write-Host ""
Write-Host "  Per fermare tutto: chiudi le 3 finestre dei servizi." -ForegroundColor DarkGray
Write-Host ""
