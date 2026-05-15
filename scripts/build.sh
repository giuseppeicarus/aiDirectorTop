#!/usr/bin/env bash
# CinematicAI Studio — Build script (all platforms)
# Usage:
#   ./scripts/build.sh          # build for current platform
#   ./scripts/build.sh --win    # Windows (requires Wine on Linux/macOS)
#   ./scripts/build.sh --mac    # macOS
#   ./scripts/build.sh --linux  # Linux
#   ./scripts/build.sh --all    # all platforms

set -euo pipefail
cd "$(dirname "$0")/.."

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'

step()  { echo -e "\n${CYAN}▶ $*${NC}"; }
ok()    { echo -e "${GREEN}✓ $*${NC}"; }
warn()  { echo -e "${YELLOW}⚠ $*${NC}"; }
fail()  { echo -e "${RED}✗ $*${NC}"; exit 1; }

# ── Parse args ────────────────────────────────────────────────────────────────
TARGET="current"
for arg in "$@"; do
  case $arg in
    --win)   TARGET="win" ;;
    --mac)   TARGET="mac" ;;
    --linux) TARGET="linux" ;;
    --all)   TARGET="all" ;;
    --skip-backend) SKIP_BACKEND=1 ;;
    --skip-frontend) SKIP_FRONTEND=1 ;;
  esac
done

SKIP_BACKEND=${SKIP_BACKEND:-0}
SKIP_FRONTEND=${SKIP_FRONTEND:-0}

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║     CinematicAI Studio — Build           ║${NC}"
echo -e "${BOLD}║     Target: ${TARGET}                         ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"

# ── Activate Python venv ──────────────────────────────────────────────────────
if [ -f "venv/bin/activate" ]; then
  source venv/bin/activate
elif [ -f "venv/Scripts/activate" ]; then
  source venv/Scripts/activate
else
  warn "No venv found — using system Python"
fi

# ── Version info ──────────────────────────────────────────────────────────────
VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "1.0.0")
step "Building version ${VERSION}"

# ═════════════════════════════════════════════════════════════════════════════
# STEP 1 — Build Python backend with PyInstaller
# ═════════════════════════════════════════════════════════════════════════════
if [ "$SKIP_BACKEND" -eq 0 ]; then
  step "Building Python backend with PyInstaller..."

  # Check PyInstaller
  if ! python -c "import PyInstaller" 2>/dev/null; then
    step "Installing PyInstaller..."
    pip install pyinstaller --quiet
  fi

  # Run PyInstaller
  python -m PyInstaller cinematic_backend.spec \
    --noconfirm \
    --clean \
    --distpath backend-dist \
    --workpath build-pyinstaller

  if [ -d "backend-dist/cinematic_backend" ]; then
    ok "Backend bundled → backend-dist/cinematic_backend/"
  else
    fail "PyInstaller build failed — check output above"
  fi
else
  warn "Skipping backend build (--skip-backend)"
fi

# ═════════════════════════════════════════════════════════════════════════════
# STEP 2 — Build React frontend with Vite
# ═════════════════════════════════════════════════════════════════════════════
if [ "$SKIP_FRONTEND" -eq 0 ]; then
  step "Building React frontend with Vite..."

  npm run build:renderer 2>/dev/null || npx vite build

  if [ -d "dist-renderer" ]; then
    ok "Frontend built → dist-renderer/"
  else
    fail "Vite build failed"
  fi
else
  warn "Skipping frontend build (--skip-frontend)"
fi

# ═════════════════════════════════════════════════════════════════════════════
# STEP 3 — Package with electron-builder
# ═════════════════════════════════════════════════════════════════════════════
step "Packaging with electron-builder (target: ${TARGET})..."

case "$TARGET" in
  win)    npx electron-builder --win ;;
  mac)    npx electron-builder --mac ;;
  linux)  npx electron-builder --linux ;;
  all)    npx electron-builder --win --mac --linux ;;
  current)
    case "$(uname -s)" in
      Darwin) npx electron-builder --mac ;;
      Linux)  npx electron-builder --linux ;;
      MINGW*|MSYS*|CYGWIN*) npx electron-builder --win ;;
      *) npx electron-builder ;;
    esac
    ;;
esac

# ═════════════════════════════════════════════════════════════════════════════
# Done
# ═════════════════════════════════════════════════════════════════════════════
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              Build Completato!                        ║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║  Output:  dist-electron/                              ║${NC}"
echo -e "${GREEN}║  Version: ${VERSION}                                       ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
echo ""

ls -lh dist-electron/ 2>/dev/null || true
