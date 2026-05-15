@echo off
:: CinematicAI Studio — Avvio rapido sviluppo (Windows CMD)
:: Generato da setup.bat

cd /d "%~dp0.."
call venv\Scripts\activate.bat

echo.
echo  [DEV] Avvio CinematicAI Studio...
echo  [DEV] Backend:  http://localhost:8765
echo  [DEV] Frontend: finestra Electron
echo  [DEV] Premi Ctrl+C per fermare
echo.

npm run dev
