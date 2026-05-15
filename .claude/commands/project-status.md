---
name: project-status
description: Show the current state of the CinematicAI Studio project — what's been built, what's pending, and what to work on next.
---

# Project Status Check

Analizza lo stato corrente del progetto CinematicAI Studio e riporta.

## 1. Scan struttura file
Usa Glob per trovare tutti i file sorgente in `src/`, contali per modulo.

## 2. Verifica ogni modulo core
Per ogni modulo riporta: ✅ Completo | 🔨 In Progress | ❌ Mancante

**Backend (src/core/)**
- [ ] `main.py` — FastAPI entry point
- [ ] `config.py` — config loader
- [ ] `database.py` — SQLite setup
- [ ] `models/project.py` — ORM Project + Pydantic
- [ ] `models/media.py` — ORM MediaItem + Pydantic
- [ ] `llm/base.py` — base adapter
- [ ] `llm/openai_adapter.py`
- [ ] `llm/anthropic_adapter.py`
- [ ] `llm/ollama_adapter.py`
- [ ] `llm/factory.py`
- [ ] `comfyui/client.py`
- [ ] `comfyui/pool.py`
- [ ] `comfyui/workflow_builder.py`
- [ ] `workflow/pipeline.py`
- [ ] `api/project_routes.py`
- [ ] `api/llm_routes.py`
- [ ] `api/comfyui_routes.py`
- [ ] `api/pipeline_routes.py`
- [ ] `api/media_routes.py`
- [ ] `api/services_routes.py`

**Frontend (src/ui/)**
- [ ] `main.js` — Electron main process
- [ ] `preload.js` — IPC bridge
- [ ] `renderer/App.jsx` — React root + routing
- [ ] `renderer/stores/index.js` — Zustand stores
- [ ] `renderer/components/Layout.jsx` — sidebar + topbar
- [ ] `renderer/screens/ProjectListScreen.jsx`
- [ ] `renderer/screens/ProjectCreatorScreen.jsx`
- [ ] `renderer/screens/StoryboardScreen.jsx`
- [ ] `renderer/screens/PipelineScreen.jsx`
- [ ] `renderer/screens/NodesScreen.jsx`
- [ ] `renderer/screens/ServicesScreen.jsx`
- [ ] `renderer/screens/MediaLibraryScreen.jsx`
- [ ] `renderer/screens/SettingsScreen.jsx`

**Config & Templates**
- [ ] `config/default.yaml`
- [ ] `config/workflows/txt2img_base.json`
- [ ] `config/workflows/img2video_wan21.json`

**Infrastructure**
- [ ] `package.json`
- [ ] `requirements.txt`
- [ ] `scripts/setup.sh`
- [ ] `scripts/setup.bat`
- [ ] `scripts/setup.ps1`

## 3. Identifica Prossima Priorità
Basandoti su cosa manca, suggerisci il singolo task più importante da completare (o la fase da eseguire con /build-phase N).

## 4. Cerca TODO
Cerca `# TODO` e `// TODO` in src/ e listali.

## 5. Conta le righe
Per ogni file esistente mostra il numero di righe — aiuta a capire se è uno stub o implementazione reale.

Formatta come report compatto, non muro di testo.
