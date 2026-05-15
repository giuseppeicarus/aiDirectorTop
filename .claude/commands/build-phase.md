---
name: build-phase
description: Execute a complete development phase for CinematicAI Studio. Usage: /build-phase 1 through /build-phase 7
---

# Build Phase: $ARGUMENTS

Execute the specified development phase completely before stopping.

## Phase Definitions

### Phase 1 — Foundation (Backend skeleton + DB)
Build in this order:
1. `requirements.txt` — dipendenze Python
2. `src/core/config.py` — YAML config loader con env vars
3. `src/core/database.py` — SQLAlchemy async SQLite
4. `src/core/models/project.py` — ORM + Pydantic: Project, MediaItem
5. `src/core/main.py` — FastAPI app con health endpoint
6. `config/default.yaml` — config completa
7. `scripts/setup.sh / setup.bat / setup.ps1`
8. Test: `python -m pytest tests/test_config.py tests/test_models.py`

### Phase 2 — LLM Adapters
1. `src/core/llm/base.py` — abstract base class
2. `src/core/llm/openai_adapter.py` — OpenAI + streaming
3. `src/core/llm/anthropic_adapter.py` — Anthropic
4. `src/core/llm/ollama_adapter.py` — Ollama locale
5. `src/core/llm/factory.py` — get_adapter(config)
6. `src/core/api/llm_routes.py` — FastAPI routes
7. Test: `python -m pytest tests/test_llm_adapters.py`

### Phase 3 — ComfyUI Integration
1. `src/core/comfyui/client.py` — async ComfyUI client
2. `src/core/comfyui/pool.py` — multi-node pool + health check
3. `src/core/comfyui/workflow_builder.py` — template-based builder
4. `config/workflows/txt2img_base.json` — SDXL workflow
5. `config/workflows/img2video_wan21.json` — WAN 2.1
6. `src/core/api/comfyui_routes.py` — routes + node management
7. Test: `python -m pytest tests/test_comfyui_client.py`

### Phase 4 — Pipeline + Media
1. `src/core/workflow/pipeline.py` — orchestratore completo
2. `src/core/api/pipeline_routes.py` — SSE streaming progress
3. `src/core/models/media.py` — MediaItem ORM + schema
4. `src/core/api/media_routes.py` — CRUD media + filtri
5. `src/core/api/services_routes.py` — status tutti i servizi
6. Test: `python -m pytest tests/test_pipeline.py tests/test_media.py`

### Phase 5 — Electron Shell + Layout
1. `package.json` — Electron + React deps
2. `src/ui/main.js` — Electron main + TUTTI gli IPC handlers
3. `src/ui/preload.js` — contextBridge completo
4. `src/ui/renderer/main.jsx` — React entry
5. `src/ui/renderer/App.jsx` — routing completo
6. `src/ui/renderer/components/Layout.jsx` — sidebar + topbar
7. `src/ui/renderer/stores/index.js` — TUTTI gli Zustand stores
8. Test: `npm run dev` per verificare la finestra si apre

### Phase 6 — Tutte le Schermate React
In questo ordine (dalla più semplice alla più complessa):
1. `SettingsScreen.jsx`
2. `ProjectCreatorScreen.jsx`
3. `ProjectListScreen.jsx` — con pipeline attiva
4. `StoryboardScreen.jsx` — viewer/editor storyboard
5. `PipelineScreen.jsx` — progress real-time SSE
6. `NodesScreen.jsx` — monitoring nodi ComfyUI
7. `ServicesScreen.jsx` — config LLM/FFmpeg/DB
8. `MediaLibraryScreen.jsx` — galleria con filtri

### Phase 7 — Packaging & Distribution
1. Aggiorna `scripts/build.sh`
2. PyInstaller per bundle backend Python
3. `electron-builder.yml` — config win/mac/linux
4. Test build su piattaforma corrente
5. Verifica installer

## Instructions
- Completa TUTTI i file della fase prima di andare avanti
- Esegui i test dopo ogni fase
- Se un file esiste ed è completo, skippa
- Riporta: file creati, test passati, prossima fase consigliata
