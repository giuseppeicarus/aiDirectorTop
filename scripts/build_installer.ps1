#Requires -Version 5.1
<#
.SYNOPSIS
    CinematicAI Studio — Build Windows Installer

.DESCRIPTION
    Builds the complete Windows installer (.exe) and portable (.exe) for
    CinematicAI Studio. Steps executed:
      1. Prerequisite check (Python 3.11+, Node.js 18+)
      2. Generate app icon (assets/icon.ico) if missing
      3. Build Python backend with PyInstaller  → backend-dist/cinematic_backend/
      4. Build React/Vite frontend              → dist-renderer/
      5. Package with electron-builder (NSIS)   → dist-electron/

.PARAMETER SkipBackend
    Skip PyInstaller step (use existing backend-dist/).

.PARAMETER SkipFrontend
    Skip Vite build step (use existing dist-renderer/).

.PARAMETER SkipPackage
    Stop after building frontend/backend, do not run electron-builder.

.PARAMETER Clean
    Delete build artifacts before starting (backend-dist, dist-renderer, dist-electron).

.EXAMPLE
    .\scripts\build_installer.ps1
    .\scripts\build_installer.ps1 -SkipBackend
    .\scripts\build_installer.ps1 -Clean
#>

[CmdletBinding()]
param(
    [switch]$SkipBackend,
    [switch]$SkipFrontend,
    [switch]$SkipPackage,
    [switch]$Clean
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir  = Split-Path -Parent $ScriptDir
Set-Location $ProjectDir

# ── Helpers ───────────────────────────────────────────────────────────────────

function Write-Banner {
    Write-Host ""
    Write-Host "  ╔══════════════════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "  ║       CinematicAI Studio — Windows Installer Build  ║" -ForegroundColor Cyan
    Write-Host "  ╚══════════════════════════════════════════════════════╝" -ForegroundColor Cyan
    Write-Host ""
}

function Write-Step   { param($n, $msg) Write-Host "  [$n] $msg" -ForegroundColor White }
function Write-Ok     { param($msg) Write-Host "      OK  $msg" -ForegroundColor Green }
function Write-Warn   { param($msg) Write-Host "      WARN  $msg" -ForegroundColor Yellow }
function Write-Fail   { param($msg) Write-Host "      FAIL  $msg" -ForegroundColor Red }
function Write-Info   { param($msg) Write-Host "      $msg" -ForegroundColor Gray }
function Write-Divider { Write-Host "  " + ("─" * 54) -ForegroundColor DarkGray }

function Require-Command {
    param([string]$Name, [string]$Hint = "")
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Write-Fail "$Name not found in PATH."
        if ($Hint) { Write-Info $Hint }
        exit 1
    }
}

function Invoke-Step {
    param([string]$Label, [scriptblock]$Action)
    Write-Info $Label
    & $Action
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
        Write-Fail "$Label failed (exit $LASTEXITCODE)"
        exit $LASTEXITCODE
    }
}

# ── Banner ────────────────────────────────────────────────────────────────────

Write-Banner
Write-Info "Project: $ProjectDir"
Write-Host ""

# ── STEP 0 — Optional clean ───────────────────────────────────────────────────

if ($Clean) {
    Write-Step "0/5" "Clean build artifacts"
    foreach ($dir in @("backend-dist", "dist-renderer", "dist-electron", "build-pyinstaller")) {
        if (Test-Path $dir) {
            Remove-Item -Recurse -Force $dir
            Write-Ok "Removed $dir"
        }
    }
    Write-Host ""
}

# ── STEP 1 — Prerequisites ────────────────────────────────────────────────────

Write-Step "1/5" "Checking prerequisites"
Write-Divider

# Python
$pythonCmd = $null
foreach ($cmd in @("python", "python3", "py")) {
    $ver = & $cmd --version 2>&1
    if ($ver -match "Python (\d+)\.(\d+)") {
        $maj = [int]$Matches[1]; $min = [int]$Matches[2]
        if ($maj -eq 3 -and $min -ge 11) {
            $pythonCmd = $cmd
            Write-Ok "Python $($Matches[0]) ($cmd)"
            break
        } elseif ($maj -ge 3) {
            $pythonCmd = $cmd
            Write-Warn "Python $($Matches[0]) (3.11+ recommended) — continuing"
            break
        }
    }
}
if (-not $pythonCmd) {
    Write-Fail "Python 3.11+ not found. Install from https://python.org"
    exit 1
}

# Node.js
Require-Command "node"  "Install Node.js 18+ from https://nodejs.org"
Require-Command "npm"   "npm should come with Node.js"
$nodeVer = node --version 2>&1
Write-Ok "Node.js $nodeVer"

# Virtual env — activate if present
$venvActivate = Join-Path $ProjectDir "venv\Scripts\Activate.ps1"
if (Test-Path $venvActivate) {
    . $venvActivate
    $pythonCmd = "python"
    Write-Ok "venv activated"
} else {
    Write-Warn "venv not found — using system Python (build may be slow and large)"
    Write-Info "Tip: create venv for faster, smaller builds:"
    Write-Info "  python -m venv venv && venv\Scripts\Activate.ps1 && pip install -r requirements.txt"
}

# PyInstaller
& $pythonCmd -c "import PyInstaller" 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Info "Installing PyInstaller..."
    & $pythonCmd -m pip install pyinstaller --quiet
    if ($LASTEXITCODE -ne 0) { Write-Fail "pip install pyinstaller failed"; exit 1 }
    Write-Ok "PyInstaller installed"
} else {
    $piVer = & $pythonCmd -c "import PyInstaller; print(PyInstaller.__version__)" 2>&1
    Write-Ok "PyInstaller $piVer"
}

Write-Host ""

# ── STEP 2 — App icon ─────────────────────────────────────────────────────────

Write-Step "2/5" "App icon"
Write-Divider

$IconPath = Join-Path $ProjectDir "assets\icon.ico"
if (Test-Path $IconPath) {
    Write-Ok "icon.ico already exists"
} else {
    Write-Info "Generating icon via create_icon.py..."
    & $pythonCmd scripts\create_icon.py
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "Icon generation failed — electron-builder will use default Electron icon"
    } elseif (Test-Path $IconPath) {
        Write-Ok "icon.ico created"
    } else {
        Write-Warn "create_icon.py ran but icon.ico not found — continuing without custom icon"
    }
}

Write-Host ""

# ── STEP 3 — Python backend (PyInstaller) ─────────────────────────────────────

Write-Step "3/5" "Python backend (PyInstaller)"
Write-Divider

if ($SkipBackend) {
    Write-Warn "Skipped (--SkipBackend)"
    if (-not (Test-Path "backend-dist\cinematic_backend")) {
        Write-Fail "backend-dist\cinematic_backend\ is missing! Cannot skip backend on first build."
        exit 1
    }
    Write-Ok "Using existing backend-dist\cinematic_backend\"
} else {
    Write-Info "Running PyInstaller (this may take 5-10 minutes)..."
    & $pythonCmd -m PyInstaller cinematic_backend.spec `
        --noconfirm `
        --clean `
        --distpath backend-dist `
        --workpath build-pyinstaller

    if ($LASTEXITCODE -ne 0) {
        Write-Fail "PyInstaller build failed!"
        exit 1
    }

    $exePath = "backend-dist\cinematic_backend\cinematic_backend.exe"
    if (-not (Test-Path $exePath)) {
        Write-Fail "Expected output not found: $exePath"
        exit 1
    }
    $size = [math]::Round((Get-Item $exePath).Length / 1MB, 1)
    Write-Ok "cinematic_backend.exe  ($size MB)"
    Write-Ok "Output: backend-dist\cinematic_backend\"
}

Write-Host ""

# ── STEP 4 — React / Vite frontend ───────────────────────────────────────────

Write-Step "4/5" "React frontend (Vite)"
Write-Divider

if ($SkipFrontend) {
    Write-Warn "Skipped (--SkipFrontend)"
    if (-not (Test-Path "dist-renderer\index.html")) {
        Write-Fail "dist-renderer\index.html missing! Cannot skip frontend on first build."
        exit 1
    }
    Write-Ok "Using existing dist-renderer\"
} else {
    Write-Info "Running: npm run build:renderer"
    npm run build:renderer
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "Vite build failed!"
        exit 1
    }
    if (-not (Test-Path "dist-renderer\index.html")) {
        Write-Fail "dist-renderer\index.html not created by Vite!"
        exit 1
    }
    Write-Ok "Frontend built → dist-renderer\"
}

Write-Host ""

# ── STEP 5 — electron-builder ─────────────────────────────────────────────────

Write-Step "5/5" "Packaging (electron-builder)"
Write-Divider

if ($SkipPackage) {
    Write-Warn "Skipped (--SkipPackage)"
} else {
    Write-Info "Running: electron-builder --win"
    npx electron-builder --win
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "electron-builder failed!"
        exit 1
    }

    Write-Host ""
    Write-Ok "Installer output:"
    if (Test-Path "dist-electron") {
        Get-ChildItem "dist-electron" -File | Where-Object { $_.Extension -in @('.exe','.zip') } |
            ForEach-Object {
                $mb = [math]::Round($_.Length / 1MB, 1)
                Write-Host "      $($_.Name)  ($mb MB)" -ForegroundColor Cyan
            }
    }
}

# ── Done ──────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  ╔══════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "  ║              Build Completed!                        ║" -ForegroundColor Green
Write-Host "  ║                                                      ║" -ForegroundColor Green
Write-Host "  ║  Installer: dist-electron\                           ║" -ForegroundColor Green
Write-Host "  ║                                                      ║" -ForegroundColor Green
Write-Host "  ║  After installing, configure:                        ║" -ForegroundColor Green
Write-Host "  ║  %USERPROFILE%\.cinematic-studio\config.yaml         ║" -ForegroundColor Yellow
Write-Host "  ╚══════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
