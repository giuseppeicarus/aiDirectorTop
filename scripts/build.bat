@echo off
:: CinematicAI Studio — Build script per Windows
:: Usage:
::   scripts\build.bat          — build completo
::   scripts\build.bat --skip-backend   — solo Electron (frontend)
::   scripts\build.bat --skip-frontend  — solo backend PyInstaller

setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1
title CinematicAI Studio — Build

cd /d "%~dp0\.."
set "PROJECT_DIR=%CD%"

set SKIP_BACKEND=0
set SKIP_FRONTEND=0

for %%a in (%*) do (
    if "%%a"=="--skip-backend"  set SKIP_BACKEND=1
    if "%%a"=="--skip-frontend" set SKIP_FRONTEND=1
)

echo.
echo  ╔══════════════════════════════════════════╗
echo  ║     CinematicAI Studio — Build           ║
echo  ║     Windows Edition                      ║
echo  ╚══════════════════════════════════════════╝
echo.

:: Attiva venv
if exist "venv\Scripts\activate.bat" (
    call venv\Scripts\activate.bat
) else (
    echo [WARN] venv non trovato — uso Python di sistema
)

:: ── STEP 1: Backend con PyInstaller ─────────────────────────────────────────
if "!SKIP_BACKEND!"=="0" (
    echo [1/3] Build backend Python con PyInstaller...

    python -c "import PyInstaller" >nul 2>&1
    if !errorlevel! neq 0 (
        echo [SETUP] Installo PyInstaller...
        pip install pyinstaller --quiet
    )

    python -m PyInstaller cinematic_backend.spec ^
        --noconfirm ^
        --clean ^
        --distpath backend-dist ^
        --workpath build-pyinstaller

    if !errorlevel! neq 0 (
        echo [ERRORE] PyInstaller build fallita!
        pause
        exit /b 1
    )
    echo [OK]    Backend compilato → backend-dist\cinematic_backend\
) else (
    echo [SKIP] Backend (--skip-backend)
)

:: ── STEP 2: Frontend con Vite ────────────────────────────────────────────────
if "!SKIP_FRONTEND!"=="0" (
    echo [2/3] Build frontend React con Vite...
    npm run build:renderer
    if !errorlevel! neq 0 (
        echo [ERRORE] Vite build fallita!
        pause
        exit /b 1
    )
    echo [OK]    Frontend compilato → dist-renderer\
) else (
    echo [SKIP] Frontend (--skip-frontend)
)

:: ── STEP 3: Packaging con electron-builder ───────────────────────────────────
echo [3/3] Packaging con electron-builder...
npx electron-builder --win
if !errorlevel! neq 0 (
    echo [ERRORE] electron-builder fallito!
    pause
    exit /b 1
)

echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║              Build Completato!                       ║
echo  ║  Output: dist-electron\                              ║
echo  ╚══════════════════════════════════════════════════════╝
echo.

dir /b dist-electron\ 2>nul
echo.
pause
