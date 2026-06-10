#Requires -Version 5.1
# CinematicAI Studio - Dev Launcher
# Controlla dipendenze, configura ambiente e lancia tutti i servizi.
# Uso: doppio click su start-dev.bat  oppure  .\start-dev.ps1

$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ROOT

function Write-Header {
    param($t)
    Write-Host ""
    Write-Host "  $t" -ForegroundColor Cyan
    Write-Host "  $('=' * 50)" -ForegroundColor DarkGray
}
function Write-Ok   { param($m) Write-Host "  [ OK ]  $m" -ForegroundColor Green }
function Write-Info { param($m) Write-Host "  [ .. ]  $m" -ForegroundColor Gray }
function Write-Step { param($m) Write-Host "  [ >> ]  $m" -ForegroundColor White }
function Write-Warn { param($m) Write-Host "  [ !! ]  $m" -ForegroundColor Yellow }
function Write-Fail { param($m) Write-Host "  [ XX ]  $m" -ForegroundColor Red }

function Abort {
    param($msg)
    Write-Host ""
    Write-Fail $msg
    Write-Host ""
    Write-Host "  Premi un tasto per chiudere..." -ForegroundColor DarkGray
    try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch {}
    exit 1
}

# Titolo
Clear-Host
Write-Host ""
Write-Host "  ========================================" -ForegroundColor DarkGray
Write-Host "   CinematicAI Studio  -  Dev Launcher   " -ForegroundColor Cyan
Write-Host "  ========================================" -ForegroundColor DarkGray
Write-Host ""

# ============================================================
Write-Header "1. Node.js"
# ============================================================

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Abort "Node.js non trovato. Installa da https://nodejs.org (v20+)"
}
$nodeVer = (& node --version 2>&1).ToString().Trim()
$npmVer  = (& npm  --version 2>&1).ToString().Trim()
Write-Ok "node $nodeVer  |  npm $npmVer"

# ============================================================
Write-Header "2. Python 3.10+"
# ============================================================

$PythonExe = $null
$candidates = @(
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

foreach ($c in $candidates) {
    try {
        $v = (& $c --version 2>&1).ToString().Trim()
        if ($v -match 'Python 3\.(1[0-9])') {
            $PythonExe = $c
            Write-Ok "Python trovato: $c  ($v)"
            break
        }
    } catch { continue }
}

if (-not $PythonExe) {
    Abort "Python 3.10+ non trovato. Installa da https://python.org e riprova."
}

# ============================================================
Write-Header "3. Dipendenze Node.js"
# ============================================================

$needInstall = -not (Test-Path (Join-Path $ROOT 'node_modules\electron\package.json'))
if ($needInstall) {
    Write-Step "node_modules mancante - eseguo npm install (prima volta, ~2 min)..."
    & npm install
    if ($LASTEXITCODE -ne 0) { Abort "npm install fallito" }
    Write-Ok "node_modules installato"
} else {
    Write-Ok "node_modules OK"
}

# ============================================================
Write-Header "4. Venv Python"
# ============================================================

$VenvPy = Join-Path $ROOT 'venv\Scripts\python.exe'

if (-not (Test-Path $VenvPy)) {
    Write-Step "Creazione venv isolato..."
    & $PythonExe -m venv venv
    if ($LASTEXITCODE -ne 0) { Abort "Creazione venv fallita" }
    Write-Ok "venv creato"
} else {
    Write-Ok "venv OK  ($VenvPy)"
}

# ============================================================
Write-Header "5. Dipendenze Python"
# ============================================================

# Controlla se i pacchetti chiave sono gia' presenti
$depsOk = $false
try {
    $chk = (& $VenvPy -c "import fastapi, uvicorn, openai, anthropic, structlog, pydantic; print('ok')" 2>&1).ToString().Trim()
    if ($chk -eq 'ok') { $depsOk = $true }
} catch { $depsOk = $false }

if (-not $depsOk) {
    Write-Step "Installazione dipendenze da requirements.txt..."
    & $VenvPy -m pip install --upgrade pip --quiet
    & $VenvPy -m pip install -r requirements.txt
    if ($LASTEXITCODE -ne 0) { Abort "pip install fallito - controlla requirements.txt" }

    Write-Step "Reinstall estensioni C per ABI Python corretta..."
    & $VenvPy -m pip install --force-reinstall pydantic pydantic-core jiter --quiet
    if ($LASTEXITCODE -ne 0) { Abort "Force-reinstall pydantic/jiter fallito" }

    Write-Ok "Dipendenze Python installate"
} else {
    Write-Ok "Dipendenze Python OK"
}

# Verifica finale import
try {
    $chk = (& $VenvPy -c "import fastapi, uvicorn, openai, anthropic, structlog, pydantic; print('ok')" 2>&1).ToString().Trim()
    if ($chk -ne 'ok') { throw "import fallito: $chk" }
    Write-Ok "Verifica import: OK"
} catch {
    Abort "Dipendenze Python non caricate: $_"
}

# ============================================================
Write-Header "6. Avvio servizi"
# ============================================================

$venvPyQ = $VenvPy.Replace("'", "''")
$rootQ   = $ROOT.Replace("'", "''")

$backendCmd = @"
Set-Location '$rootQ'
Write-Host '[Backend] Avvio uvicorn su porta 8123...' -ForegroundColor Blue
& '$venvPyQ' -m uvicorn src.core.main:app --reload --reload-dir src/core --reload-delay 2 --port 8123 --host 127.0.0.1
"@

$viteCmd = @"
Set-Location '$rootQ'
Write-Host '[Vite] Avvio dev server su porta 5300...' -ForegroundColor Green
npx --no-install vite
"@

$electronCmd = @"
Set-Location '$rootQ'
Write-Host '[Electron] Attendo Vite su :5300...' -ForegroundColor Magenta
npx --no-install wait-on http://127.0.0.1:5300 -t 120000
Write-Host '[Electron] Avvio...' -ForegroundColor Magenta
npx --no-install electron .
"@

Write-Step "Avvio Backend..."
Start-Process powershell -ArgumentList '-NoProfile', '-NoExit', '-Command', $backendCmd

Start-Sleep -Milliseconds 600

Write-Step "Avvio Vite..."
Start-Process powershell -ArgumentList '-NoProfile', '-NoExit', '-Command', $viteCmd

Start-Sleep -Milliseconds 600

Write-Step "Avvio Electron (aspetta Vite)..."
Start-Process powershell -ArgumentList '-NoProfile', '-NoExit', '-Command', $electronCmd

# ============================================================

Write-Host ""
Write-Host "  Servizi avviati in 3 finestre separate:" -ForegroundColor Green
Write-Host ""
Write-Host "   Backend  ->  http://127.0.0.1:8123" -ForegroundColor Blue
Write-Host "   Vite     ->  http://127.0.0.1:5300" -ForegroundColor Green
Write-Host "   Electron ->  si apre automaticamente" -ForegroundColor Magenta
Write-Host ""
Write-Host "  Per fermare tutto: chiudi le 3 finestre dei servizi." -ForegroundColor DarkGray
Write-Host ""
