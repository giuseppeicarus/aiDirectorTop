#Requires -Version 5.1
<#
.SYNOPSIS
    Crea un venv isolato per la build di CinematicAI Studio.
    Da eseguire UNA SOLA VOLTA prima della prima build.
.DESCRIPTION
    Crea venv/ con solo le dipendenze di runtime (no Anaconda extras).
    Rende la build PyInstaller 10x più veloce e il bundle più piccolo.
.EXAMPLE
    .\scripts\setup_build_env.ps1
#>

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
Set-Location $ProjectDir

function Write-Ok   { param($m) Write-Host "  OK  $m" -ForegroundColor Green }
function Write-Info { param($m) Write-Host "  ... $m" -ForegroundColor Gray }
function Write-Fail { param($m) Write-Host "  ERR $m" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "  CinematicAI Studio — Build Environment Setup" -ForegroundColor Cyan
Write-Host ""

# Find Python
$py = $null
foreach ($c in @("python", "python3", "py")) {
    $v = & $c --version 2>&1
    if ($v -match "Python 3\.(\d+)") {
        $py = $c
        Write-Ok "Python $v ($c)"
        break
    }
}
if (-not $py) { Write-Fail "Python 3 not found" }

# Create venv
Write-Info "Creating venv/..."
& $py -m venv venv
if ($LASTEXITCODE -ne 0) { Write-Fail "venv creation failed" }
Write-Ok "venv created"

# Activate
. .\venv\Scripts\Activate.ps1
Write-Ok "venv activated"

# Upgrade pip
Write-Info "Upgrading pip..."
python -m pip install --upgrade pip --quiet
Write-Ok "pip upgraded"

# Install runtime deps only (skip dev/test tools)
Write-Info "Installing runtime dependencies (5-10 min)..."
pip install `
    fastapi uvicorn[standard] python-multipart `
    httpx websockets `
    pydantic pydantic-settings `
    sqlalchemy aiosqlite alembic `
    pyyaml python-dotenv `
    openai anthropic `
    structlog `
    pillow aiofiles tenacity `
    librosa soundfile numpy `
    pyinstaller `
    --quiet

if ($LASTEXITCODE -ne 0) { Write-Fail "pip install failed" }
Write-Ok "Runtime dependencies installed"

# Verify PyInstaller
$v = python -m PyInstaller --version 2>&1
Write-Ok "PyInstaller $v ready in venv"

Write-Host ""
Write-Host "  Build environment ready. Now run:" -ForegroundColor Green
Write-Host "  .\scripts\build_installer.ps1" -ForegroundColor Cyan
Write-Host ""
