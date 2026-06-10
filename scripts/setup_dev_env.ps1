#Requires -Version 5.1
<#
.SYNOPSIS
    Crea il venv Python isolato per sviluppo (npm run dev).
    Risolve i conflitti di dipendenze con pacchetti di sistema (mcp, hermes-agent, ecc.)
.EXAMPLE
    .\scripts\setup_dev_env.ps1
#>

$ProjectDir = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectDir

function Write-Ok   { param($m) Write-Host "  [OK]  $m" -ForegroundColor Green }
function Write-Info { param($m) Write-Host "  [...] $m" -ForegroundColor Cyan }
function Write-Fail { param($m) Write-Host "  [ERR] $m" -ForegroundColor Red; exit 1 }

Write-Info "Setup venv per sviluppo in: $ProjectDir\venv"

# Trova Python
$PythonCandidates = @(
    "python",
    "python3",
    "py",
    "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
    "C:\Python311\python.exe",
    "C:\Python312\python.exe"
)

$Python = $null
foreach ($candidate in $PythonCandidates) {
    try {
        $ver = & $candidate --version 2>&1
        if ($ver -match 'Python 3\.1[0-9]') {
            $Python = $candidate
            Write-Ok "Python trovato: $candidate ($ver)"
            break
        }
    } catch { continue }
}

if (-not $Python) { Write-Fail "Python 3.10+ non trovato nel PATH" }

# Crea venv se non esiste
if (Test-Path "venv\Scripts\python.exe") {
    Write-Ok "venv gia' esistente"
} else {
    Write-Info "Creazione venv..."
    & $Python -m venv venv
    if ($LASTEXITCODE -ne 0) { Write-Fail "Creazione venv fallita" }
    Write-Ok "venv creato"
}

$VenvPython = ".\venv\Scripts\python.exe"

# Aggiorna pip
Write-Info "Aggiornamento pip..."
& $VenvPython -m pip install --upgrade pip --quiet

# Installa dipendenze
Write-Info "Installazione dipendenze da requirements.txt..."
& $VenvPython -m pip install -r requirements.txt
if ($LASTEXITCODE -ne 0) { Write-Fail "pip install fallito" }

Write-Ok "Dipendenze installate"
Write-Host ""
Write-Host "  Venv pronto. Esegui:" -ForegroundColor Yellow
Write-Host "    npm run dev" -ForegroundColor White
Write-Host ""
Write-Host "  Il backend usera' automaticamente venv\Scripts\python.exe" -ForegroundColor Gray
