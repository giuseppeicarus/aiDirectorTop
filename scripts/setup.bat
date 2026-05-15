@echo off
:: CinematicAI Studio — Setup per Windows (CMD)
:: Doppio click su questo file per installare tutto
:: Per PowerShell usa: setup.ps1

setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1
title CinematicAI Studio — Setup

echo.
echo  ╔══════════════════════════════════════════╗
echo  ║      CinematicAI Studio — Setup          ║
echo  ║      Windows (CMD) Edition               ║
echo  ╚══════════════════════════════════════════╝
echo.

:: Spostati nella cartella del progetto (quella dove si trova questo bat)
cd /d "%~dp0\.."
set "PROJECT_DIR=%CD%"
echo [INFO] Cartella progetto: %PROJECT_DIR%
echo.

:: ── Verifica Python ──────────────────────────────────────────────────────────
echo [CHECK] Verifica Python...
python --version >nul 2>&1
if %errorlevel% neq 0 (
    python3 --version >nul 2>&1
    if %errorlevel% neq 0 (
        echo [ERRORE] Python non trovato!
        echo.
        echo  Installa Python 3.11+ da: https://www.python.org/downloads/
        echo  IMPORTANTE: spunta "Add Python to PATH" durante l'installazione!
        echo.
        pause
        exit /b 1
    )
    set "PYTHON=python3"
) else (
    set "PYTHON=python"
)

for /f "tokens=2" %%v in ('!PYTHON! --version 2^>^&1') do set "PY_VERSION=%%v"
echo [OK]    Python !PY_VERSION! trovato

:: ── Verifica versione Python >= 3.11 ─────────────────────────────────────────
for /f "tokens=1,2 delims=." %%a in ("!PY_VERSION!") do (
    set "PY_MAJOR=%%a"
    set "PY_MINOR=%%b"
)
if !PY_MAJOR! lss 3 (
    echo [ERRORE] Richiesto Python 3.11+, trovato !PY_VERSION!
    pause
    exit /b 1
)
if !PY_MAJOR! equ 3 if !PY_MINOR! lss 11 (
    echo [WARN]   Python !PY_VERSION! trovato. Raccomandato 3.11+. Continuo comunque...
)

:: ── Verifica Node.js ──────────────────────────────────────────────────────────
echo [CHECK] Verifica Node.js...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERRORE] Node.js non trovato!
    echo.
    echo  Installa Node.js 20+ da: https://nodejs.org/
    echo.
    pause
    exit /b 1
)
for /f %%v in ('node --version') do set "NODE_VERSION=%%v"
echo [OK]    Node.js !NODE_VERSION! trovato

:: ── Verifica npm ──────────────────────────────────────────────────────────────
npm --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERRORE] npm non trovato. Reinstalla Node.js.
    pause
    exit /b 1
)
for /f %%v in ('npm --version') do set "NPM_VERSION=%%v"
echo [OK]    npm !NPM_VERSION! trovato

:: ── Verifica FFmpeg ───────────────────────────────────────────────────────────
echo [CHECK] Verifica FFmpeg...
ffmpeg -version >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARN]  FFmpeg non trovato nel PATH.
    echo [WARN]  L'assemblaggio video non funzionera'.
    echo [WARN]  Installa da: https://www.gyan.dev/ffmpeg/builds/
    echo [WARN]  Poi aggiungi la cartella bin al PATH di sistema.
) else (
    for /f "tokens=3" %%v in ('ffmpeg -version 2^>^&1 ^| findstr "ffmpeg version"') do (
        echo [OK]    FFmpeg %%v trovato
        goto :ffmpeg_ok
    )
    echo [OK]    FFmpeg trovato
    :ffmpeg_ok
)

echo.

:: ── Crea directory dati utente ────────────────────────────────────────────────
set "DATA_DIR=%USERPROFILE%\.cinematic-studio"
echo [SETUP] Creo directory dati: %DATA_DIR%
if not exist "%DATA_DIR%"           mkdir "%DATA_DIR%"
if not exist "%DATA_DIR%\projects"  mkdir "%DATA_DIR%\projects"
if not exist "%DATA_DIR%\logs"      mkdir "%DATA_DIR%\logs"
if not exist "%DATA_DIR%\cache"     mkdir "%DATA_DIR%\cache"
echo [OK]    Directory creata

:: ── Copia config di default ───────────────────────────────────────────────────
if not exist "%DATA_DIR%\config.yaml" (
    echo [SETUP] Creo configurazione di default...
    copy "config\default.yaml" "%DATA_DIR%\config.yaml" >nul
    echo [OK]    Config creata in %DATA_DIR%\config.yaml
    echo [WARN]  Modifica il file config.yaml per aggiungere le tue API key!
) else (
    echo [OK]    Config gia' esistente in %DATA_DIR%\config.yaml
)

:: ── Virtual environment Python ────────────────────────────────────────────────
echo.
echo [SETUP] Creo virtual environment Python...
if not exist "venv" (
    !PYTHON! -m venv venv
    if !errorlevel! neq 0 (
        echo [ERRORE] Creazione venv fallita.
        pause
        exit /b 1
    )
)
echo [OK]    Virtual environment pronto

:: ── Installa dipendenze Python ────────────────────────────────────────────────
echo [SETUP] Installo dipendenze Python (potrebbe richiedere qualche minuto)...
call venv\Scripts\activate.bat

python -m pip install --upgrade pip --quiet
if %errorlevel% neq 0 (
    echo [ERRORE] Aggiornamento pip fallito.
    pause
    exit /b 1
)

pip install -r requirements.txt --quiet
if %errorlevel% neq 0 (
    echo [ERRORE] Installazione dipendenze Python fallita.
    echo          Controlla requirements.txt e la tua connessione internet.
    pause
    exit /b 1
)
echo [OK]    Dipendenze Python installate

:: ── Installa dipendenze Node.js ───────────────────────────────────────────────
echo [SETUP] Installo dipendenze Node.js...
npm install --silent
if %errorlevel% neq 0 (
    echo [ERRORE] npm install fallito.
    pause
    exit /b 1
)
echo [OK]    Dipendenze Node.js installate

:: ── Inizializza database ──────────────────────────────────────────────────────
echo [SETUP] Inizializzo database...
python -c "import asyncio, sys; sys.path.insert(0, '.'); exec(\"async def f():\n try:\n  from src.core.database import init_db\n  await init_db()\n  print('[OK]    Database inizializzato')\n except ImportError:\n  print('[SKIP]  Modulo database non ancora creato - ok')\nasyncio.run(f())\")"

:: ── Crea dev.bat per avvio rapido ─────────────────────────────────────────────
echo [SETUP] Creo script di avvio rapido...
(
echo @echo off
echo :: CinematicAI Studio — Avvio sviluppo
echo cd /d "%%~dp0.."
echo call venv\Scripts\activate.bat
echo echo [DEV] Avvio CinematicAI Studio...
echo echo [DEV] Backend: http://localhost:8765
echo npm run dev
) > scripts\dev.bat
echo [OK]    dev.bat creato

:: ── Riepilogo finale ──────────────────────────────────────────────────────────
echo.
echo  ╔══════════════════════════════════════════════════════════╗
echo  ║                  Setup Completato!                       ║
echo  ╠══════════════════════════════════════════════════════════╣
echo  ║                                                          ║
echo  ║  Prossimi passi:                                         ║
echo  ║                                                          ║
echo  ║  1. Modifica la configurazione:                          ║
echo  ║     %USERPROFILE%\.cinematic-studio\config.yaml
echo  ║     - Aggiungi la tua API key LLM                        ║
echo  ║     - Configura il nodo ComfyUI                          ║
echo  ║                                                          ║
echo  ║  2. Avvia in sviluppo:                                   ║
echo  ║     scripts\dev.bat                                      ║
echo  ║     oppure: npm run dev                                  ║
echo  ║                                                          ║
echo  ║  3. In Claude Code digita:                               ║
echo  ║     /project-status                                      ║
echo  ║                                                          ║
echo  ╚══════════════════════════════════════════════════════════╝
echo.
echo Premi un tasto per aprire il file di configurazione...
pause >nul
notepad "%DATA_DIR%\config.yaml"
