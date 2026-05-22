@echo off
REM Scarica modelli ComfyUI in .\models — eseguire dalla root di ComfyUI
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0download_model_comfyui_windows.ps1" %*
if errorlevel 1 (
  echo [ERRORE] Script terminato con errore.
  exit /b 1
)
exit /b 0
