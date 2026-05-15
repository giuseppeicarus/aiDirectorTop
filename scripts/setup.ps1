#Requires -Version 5.1
<#
.SYNOPSIS
    CinematicAI Studio — Script di setup per Windows (PowerShell)

.DESCRIPTION
    Installa tutte le dipendenze, configura l'ambiente e prepara
    CinematicAI Studio per lo sviluppo su Windows.

.EXAMPLE
    .\scripts\setup.ps1

.NOTES
    Se ricevi "esecuzione di script disabilitata", esegui prima:
    Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
#>

[CmdletBinding()]
param(
    [switch]$SkipNodeJs,
    [switch]$SkipPython,
    [switch]$NoVenv,
    [switch]$Quiet
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Colori e helpers ──────────────────────────────────────────────────────────
function Write-Header {
    Clear-Host
    Write-Host ""
    Write-Host "  ╔══════════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "  ║     🎬  CinematicAI Studio — Setup          ║" -ForegroundColor Cyan
    Write-Host "  ║        Windows (PowerShell) Edition          ║" -ForegroundColor Cyan
    Write-Host "  ╚══════════════════════════════════════════════╝" -ForegroundColor Cyan
    Write-Host ""
}

function Write-Step   { param($msg) Write-Host "  ▶ $msg" -ForegroundColor Cyan }
function Write-Ok     { param($msg) Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn   { param($msg) Write-Host "  ⚠ $msg" -ForegroundColor Yellow }
function Write-Fail   { param($msg) Write-Host "  ✗ $msg" -ForegroundColor Red }
function Write-Info   { param($msg) Write-Host "    $msg" -ForegroundColor Gray }
function Write-Divider { Write-Host "  " + ("─" * 50) -ForegroundColor DarkGray }

function Test-Command {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-CommandVersion {
    param([string]$Cmd, [string]$Args = "--version")
    try {
        $output = & $Cmd $Args 2>&1 | Select-Object -First 1
        return $output.ToString().Trim()
    } catch {
        return "sconosciuta"
    }
}

function Invoke-WithSpinner {
    param([string]$Message, [scriptblock]$Action)
    $frames = @("⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏")
    $job = Start-Job -ScriptBlock $Action
    $i = 0
    while ($job.State -eq "Running") {
        Write-Host "`r  $($frames[$i % $frames.Length]) $Message..." -NoNewline -ForegroundColor Cyan
        Start-Sleep -Milliseconds 80
        $i++
    }
    Write-Host "`r" -NoNewline
    $result = Receive-Job $job -ErrorAction SilentlyContinue
    Remove-Job $job
    return $result
}

# ── Sposta nella root del progetto ───────────────────────────────────────────
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
Set-Location $ProjectDir

Write-Header
Write-Info "Cartella progetto: $ProjectDir"
Write-Host ""

# ── Verifica Policy PowerShell ────────────────────────────────────────────────
$policy = Get-ExecutionPolicy -Scope CurrentUser
if ($policy -eq "Restricted") {
    Write-Warn "PowerShell Execution Policy e' Restricted."
    Write-Info "Esegui questo comando per abilitare gli script:"
    Write-Info "  Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser"
    Write-Host ""
    $confirm = Read-Host "  Vuoi che lo imposti automaticamente adesso? [S/n]"
    if ($confirm -ne "n" -and $confirm -ne "N") {
        Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
        Write-Ok "Execution Policy aggiornata"
    }
}

# ═════════════════════════════════════════════════════════════════════════════
# STEP 1 — Verifica Prerequisiti
# ═════════════════════════════════════════════════════════════════════════════
Write-Host "  [ 1/6 ] Verifica prerequisiti" -ForegroundColor White
Write-Divider

# Python
if (-not $SkipPython) {
    Write-Step "Verifica Python..."
    
    $pythonCmd = $null
    foreach ($cmd in @("python", "python3", "py")) {
        if (Test-Command $cmd) {
            $ver = & $cmd --version 2>&1
            if ($ver -match "Python (\d+)\.(\d+)") {
                $major = [int]$Matches[1]
                $minor = [int]$Matches[2]
                if ($major -eq 3 -and $minor -ge 11) {
                    $pythonCmd = $cmd
                    Write-Ok "Python $($Matches[0]) trovato ($cmd)"
                    break
                } elseif ($major -ge 3) {
                    Write-Warn "Python $($Matches[0]) trovato ma raccomandato 3.11+ (continuo)"
                    $pythonCmd = $cmd
                    break
                }
            }
        }
    }
    
    if (-not $pythonCmd) {
        Write-Fail "Python 3.11+ non trovato!"
        Write-Host ""
        Write-Info "Installa da: https://www.python.org/downloads/"
        Write-Info "IMPORTANTE: spunta 'Add Python to PATH' durante l'installazione"
        Write-Host ""
        
        $install = Read-Host "  Apro la pagina di download? [S/n]"
        if ($install -ne "n" -and $install -ne "N") {
            Start-Process "https://www.python.org/downloads/"
        }
        exit 1
    }
    
    $script:PythonCmd = $pythonCmd
}

# Node.js
if (-not $SkipNodeJs) {
    Write-Step "Verifica Node.js..."
    
    if (Test-Command "node") {
        $nodeVer = Get-CommandVersion "node"
        Write-Ok "Node.js $nodeVer trovato"
        
        $npmVer = Get-CommandVersion "npm"
        Write-Ok "npm $npmVer trovato"
    } else {
        Write-Fail "Node.js non trovato!"
        Write-Host ""
        Write-Info "Installa Node.js 20+ da: https://nodejs.org/"
        Write-Host ""
        
        $install = Read-Host "  Apro la pagina di download? [S/n]"
        if ($install -ne "n" -and $install -ne "N") {
            Start-Process "https://nodejs.org/"
        }
        exit 1
    }
}

# FFmpeg (opzionale)
Write-Step "Verifica FFmpeg..."
if (Test-Command "ffmpeg") {
    $ffVer = & ffmpeg -version 2>&1 | Select-Object -First 1
    Write-Ok "FFmpeg trovato: $($ffVer.ToString().Split(' ')[2])"
} else {
    Write-Warn "FFmpeg non trovato nel PATH"
    Write-Info "L'assemblaggio video finale non funzionera' senza FFmpeg"
    Write-Info "Download: https://www.gyan.dev/ffmpeg/builds/ (ffmpeg-release-essentials.zip)"
    Write-Info "Dopo l'installazione aggiorna il PATH o imposta 'ffmpeg_path' in config.yaml"
}

# Git (opzionale ma utile)
Write-Step "Verifica Git..."
if (Test-Command "git") {
    $gitVer = Get-CommandVersion "git"
    Write-Ok "Git $gitVer trovato"
} else {
    Write-Warn "Git non trovato (opzionale, ma raccomandato)"
}

Write-Host ""

# ═════════════════════════════════════════════════════════════════════════════
# STEP 2 — Directory dati utente
# ═════════════════════════════════════════════════════════════════════════════
Write-Host "  [ 2/6 ] Configurazione directory" -ForegroundColor White
Write-Divider

$DataDir = Join-Path $env:USERPROFILE ".cinematic-studio"
$SubDirs = @("projects", "logs", "cache")

Write-Step "Creo directory dati: $DataDir"
foreach ($sub in @("", "projects", "logs", "cache")) {
    $path = Join-Path $DataDir $sub
    if (-not (Test-Path $path)) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
    }
}
Write-Ok "Directory struttura creata"

# Config di default
$ConfigDest = Join-Path $DataDir "config.yaml"
$ConfigSrc  = Join-Path $ProjectDir "config\default.yaml"

if (-not (Test-Path $ConfigDest)) {
    Write-Step "Copio configurazione di default..."
    Copy-Item $ConfigSrc $ConfigDest -Force
    Write-Ok "Config creata in: $ConfigDest"
    Write-Warn "Ricordati di aggiungere le tue API key in config.yaml!"
} else {
    Write-Ok "Config gia' esistente: $ConfigDest"
}

Write-Host ""

# ═════════════════════════════════════════════════════════════════════════════
# STEP 3 — Virtual environment Python
# ═════════════════════════════════════════════════════════════════════════════
if (-not $SkipPython -and -not $NoVenv) {
    Write-Host "  [ 3/6 ] Virtual environment Python" -ForegroundColor White
    Write-Divider
    
    $VenvDir = Join-Path $ProjectDir "venv"
    
    if (-not (Test-Path $VenvDir)) {
        Write-Step "Creo virtual environment..."
        & $script:PythonCmd -m venv venv
        if ($LASTEXITCODE -ne 0) {
            Write-Fail "Creazione venv fallita!"
            exit 1
        }
        Write-Ok "Virtual environment creato"
    } else {
        Write-Ok "Virtual environment gia' esistente"
    }
    
    # Attiva venv
    $ActivateScript = Join-Path $VenvDir "Scripts\Activate.ps1"
    if (Test-Path $ActivateScript) {
        . $ActivateScript
        Write-Ok "Virtual environment attivato"
    } else {
        Write-Fail "Script di attivazione non trovato: $ActivateScript"
        exit 1
    }
    
    Write-Host ""
    
    # ═══════════════════════════════════════════════════════════════════════
    # STEP 4 — Dipendenze Python
    # ═══════════════════════════════════════════════════════════════════════
    Write-Host "  [ 4/6 ] Dipendenze Python" -ForegroundColor White
    Write-Divider
    
    Write-Step "Aggiorno pip..."
    python -m pip install --upgrade pip --quiet
    Write-Ok "pip aggiornato"
    
    Write-Step "Installo pacchetti Python (potrebbe richiedere qualche minuto)..."
    Write-Info "requirements.txt: FastAPI, SQLAlchemy, OpenAI, Anthropic, httpx, websockets..."
    
    $pipOutput = pip install -r requirements.txt 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "Installazione dipendenze Python fallita!"
        Write-Host ""
        Write-Info "Output errore:"
        $pipOutput | Select-Object -Last 20 | ForEach-Object { Write-Info $_ }
        exit 1
    }
    Write-Ok "Dipendenze Python installate"
    Write-Host ""
}

# ═════════════════════════════════════════════════════════════════════════════
# STEP 5 — Dipendenze Node.js
# ═════════════════════════════════════════════════════════════════════════════
if (-not $SkipNodeJs) {
    Write-Host "  [ 5/6 ] Dipendenze Node.js" -ForegroundColor White
    Write-Divider
    
    Write-Step "Installo pacchetti npm (Electron, React, Tailwind...)..."
    
    $npmOutput = npm install 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "npm install fallito!"
        $npmOutput | Select-Object -Last 10 | ForEach-Object { Write-Info $_ }
        exit 1
    }
    Write-Ok "Dipendenze Node.js installate"
    Write-Host ""
}

# ═════════════════════════════════════════════════════════════════════════════
# STEP 6 — Inizializzazione database e script di avvio
# ═════════════════════════════════════════════════════════════════════════════
Write-Host "  [ 6/6 ] Finalizzazione" -ForegroundColor White
Write-Divider

# Init DB
Write-Step "Inizializzo database SQLite..."
$initCode = @"
import asyncio, sys
sys.path.insert(0, '.')
async def init():
    try:
        from src.core.database import init_db
        await init_db()
        print('ok')
    except ImportError:
        print('skip')
asyncio.run(init())
"@
$dbResult = python -c $initCode 2>&1
if ($dbResult -match "ok") {
    Write-Ok "Database inizializzato"
} elseif ($dbResult -match "skip") {
    Write-Warn "Modulo database non ancora creato — verra' inizializzato durante /build-phase 1"
} else {
    Write-Warn "Init database: $dbResult"
}

# Crea dev.ps1 per avvio rapido
Write-Step "Creo script di avvio rapido (dev.ps1)..."
$devScript = @'
# CinematicAI Studio — Avvio sviluppo
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent)
. .\venv\Scripts\Activate.ps1
Write-Host "[DEV] Avvio CinematicAI Studio..." -ForegroundColor Cyan
Write-Host "[DEV] Backend: http://localhost:8765" -ForegroundColor Gray
Write-Host "[DEV] Premi Ctrl+C per fermare" -ForegroundColor Gray
npm run dev
'@
$devScript | Set-Content -Path (Join-Path $ScriptDir "dev.ps1") -Encoding UTF8
Write-Ok "dev.ps1 creato"

# Crea scorciatoia nel desktop (opzionale)
$createShortcut = Read-Host "  Creo scorciatoia sul Desktop per avviare l'app? [S/n]"
if ($createShortcut -ne "n" -and $createShortcut -ne "N") {
    $WScriptShell = New-Object -ComObject WScript.Shell
    $Shortcut = $WScriptShell.CreateShortcut(
        (Join-Path ([Environment]::GetFolderPath("Desktop")) "CinematicAI Studio.lnk")
    )
    $Shortcut.TargetPath = "powershell.exe"
    $Shortcut.Arguments = "-ExecutionPolicy Bypass -File `"$(Join-Path $ScriptDir 'dev.ps1')`""
    $Shortcut.WorkingDirectory = $ProjectDir
    $Shortcut.Description = "Avvia CinematicAI Studio in modalita' sviluppo"
    $Shortcut.Save()
    Write-Ok "Scorciatoia creata sul Desktop"
}

Write-Host ""

# ═════════════════════════════════════════════════════════════════════════════
# Riepilogo finale
# ═════════════════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "  ╔══════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "  ║              ✓  Setup Completato!                        ║" -ForegroundColor Green
Write-Host "  ╠══════════════════════════════════════════════════════════╣" -ForegroundColor Green
Write-Host "  ║                                                          ║" -ForegroundColor Green
Write-Host "  ║  Prossimi passi:                                         ║" -ForegroundColor Green
Write-Host "  ║                                                          ║" -ForegroundColor Green
Write-Host "  ║  1. Configura API key e ComfyUI:                         ║" -ForegroundColor Green
Write-Host "  ║     $env:USERPROFILE\.cinematic-studio\config.yaml" -ForegroundColor Yellow
Write-Host "  ║                                                          ║" -ForegroundColor Green
Write-Host "  ║  2. Avvia sviluppo:                                      ║" -ForegroundColor Green
Write-Host "  ║     .\scripts\dev.ps1                                    ║" -ForegroundColor Cyan
Write-Host "  ║     oppure: npm run dev                                  ║" -ForegroundColor Cyan
Write-Host "  ║                                                          ║" -ForegroundColor Green
Write-Host "  ║  3. Installa Claude Code e apri il progetto:             ║" -ForegroundColor Green
Write-Host "  ║     claude                                               ║" -ForegroundColor Cyan
Write-Host "  ║     poi digita: /project-status                          ║" -ForegroundColor Cyan
Write-Host "  ║                                                          ║" -ForegroundColor Green
Write-Host "  ╚══════════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""

# Apri config.yaml in Notepad per modifica immediata
$openConfig = Read-Host "  Apro il file config.yaml per la configurazione? [S/n]"
if ($openConfig -ne "n" -and $openConfig -ne "N") {
    Start-Process "notepad.exe" -ArgumentList (Join-Path $DataDir "config.yaml")
}

Write-Host ""
Write-Host "  Setup completato. Buon sviluppo! 🎬" -ForegroundColor Cyan
Write-Host ""
