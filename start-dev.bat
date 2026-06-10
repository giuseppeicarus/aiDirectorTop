@echo off
title CinematicAI Studio — Dev Launcher
PowerShell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-dev.ps1"
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo  Avvio fallito. Controlla i messaggi sopra.
    pause
)
