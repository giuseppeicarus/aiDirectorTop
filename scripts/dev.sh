#!/usr/bin/env bash
# Start CinematicAI Studio in development mode

set -e
cd "$(dirname "$0")/.."

# Activate Python venv if exists
if [ -f "venv/bin/activate" ]; then
    source venv/bin/activate
elif [ -f "venv/Scripts/activate" ]; then
    source venv/Scripts/activate
fi

echo "[DEV] Starting CinematicAI Studio..."
echo "[DEV] Backend: http://localhost:8765"
echo "[DEV] Frontend: Electron window"
echo ""

npm run dev
