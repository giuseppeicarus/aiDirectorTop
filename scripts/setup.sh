#!/usr/bin/env bash
# CinematicAI Studio — First-time setup script
# Works on: macOS, Linux, Windows (Git Bash / WSL)

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}[SETUP]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

log "CinematicAI Studio — Setup"
echo "────────────────────────────────────────"

# ── Check Python ──────────────────────────────────────────────────────────────
log "Checking Python..."
if ! command -v python3 &>/dev/null && ! command -v python &>/dev/null; then
    error "Python 3.11+ is required. Install from https://python.org"
fi
PYTHON=$(command -v python3 || command -v python)
PY_VERSION=$($PYTHON --version 2>&1 | cut -d' ' -f2)
log "Found Python $PY_VERSION at $PYTHON"

# ── Check Node.js ─────────────────────────────────────────────────────────────
log "Checking Node.js..."
if ! command -v node &>/dev/null; then
    error "Node.js 20+ is required. Install from https://nodejs.org"
fi
NODE_VERSION=$(node --version)
log "Found Node.js $NODE_VERSION"

# ── Check FFmpeg ──────────────────────────────────────────────────────────────
log "Checking FFmpeg..."
if command -v ffmpeg &>/dev/null; then
    FFMPEG_VERSION=$(ffmpeg -version 2>&1 | head -1)
    log "Found FFmpeg: $FFMPEG_VERSION"
else
    warn "FFmpeg not found in PATH. Video assembly will fail."
    warn "Install: https://ffmpeg.org/download.html"
fi

# ── Create user data directory ────────────────────────────────────────────────
DATA_DIR="$HOME/.cinematic-studio"
log "Creating data directory: $DATA_DIR"
mkdir -p "$DATA_DIR"/{projects,logs,cache}

# ── Copy default config if not exists ─────────────────────────────────────────
if [ ! -f "$DATA_DIR/config.yaml" ]; then
    log "Creating default config..."
    cp config/default.yaml "$DATA_DIR/config.yaml"
    log "Config created at $DATA_DIR/config.yaml"
    warn "Edit $DATA_DIR/config.yaml to add your API keys and ComfyUI settings"
else
    log "Config already exists at $DATA_DIR/config.yaml"
fi

# ── Python virtual environment ────────────────────────────────────────────────
log "Setting up Python virtual environment..."
if [ ! -d "venv" ]; then
    $PYTHON -m venv venv
fi

# Activate venv
if [ -f "venv/Scripts/activate" ]; then
    source venv/Scripts/activate  # Windows Git Bash
elif [ -f "venv/bin/activate" ]; then
    source venv/bin/activate  # macOS/Linux
fi

log "Installing Python dependencies..."
pip install --upgrade pip -q
pip install -r requirements.txt -q
log "Python dependencies installed"

# ── Node.js dependencies ──────────────────────────────────────────────────────
log "Installing Node.js dependencies..."
npm install --silent
log "Node.js dependencies installed"

# ── Initialize database ───────────────────────────────────────────────────────
log "Initializing database..."
$PYTHON -c "
import asyncio
import sys
sys.path.insert(0, '.')
async def init():
    try:
        from src.core.database import init_db
        await init_db()
        print('Database initialized')
    except ImportError:
        print('Database module not yet created - skipping')
asyncio.run(init())
"

echo ""
echo "────────────────────────────────────────"
log "Setup complete! Next steps:"
echo ""
echo "  1. Edit ~/.cinematic-studio/config.yaml"
echo "     - Add your LLM API key"
echo "     - Configure your ComfyUI node(s)"
echo ""
echo "  2. Start development:"
echo "     npm run dev"
echo ""
echo "  3. Or start just the backend:"
echo "     source venv/bin/activate && python -m uvicorn src.core.main:app --port 8765"
echo ""
echo "  4. In Claude Code, run /project-status to see what to build next"
echo "────────────────────────────────────────"
