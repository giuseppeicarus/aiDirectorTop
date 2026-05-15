# CinematicAI Studio — Architecture

## Overview
Cross-platform desktop app (Electron shell + Python FastAPI backend) for automated cinematic video generation via ComfyUI.

## System Diagram
```
┌─────────────────────────────────────────────────────────┐
│                    Electron App                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │              React Renderer (UI)                 │   │
│  │   ProjectCreator → StoryboardEditor → Pipeline   │   │
│  └────────────────┬─────────────────────────────────┘   │
│                   │ IPC (contextBridge)                  │
│  ┌────────────────▼─────────────────────────────────┐   │
│  │            Electron Main Process                 │   │
│  │   IPC Handlers → HTTP calls → Python backend    │   │
│  └────────────────┬─────────────────────────────────┘   │
└───────────────────┼─────────────────────────────────────┘
                    │ HTTP (localhost:8765)
┌───────────────────▼─────────────────────────────────────┐
│              Python FastAPI Backend                      │
│  ┌─────────────┐ ┌──────────────┐ ┌─────────────────┐  │
│  │  LLM Layer  │ │ Pipeline Orch│ │ ComfyUI Layer   │  │
│  │  Adapters:  │ │              │ │ Client + Pool   │  │
│  │ OpenAI      │ │ Storyboard → │ │                 │  │
│  │ Anthropic   │ │ Frame Gen  → │ │  Node 1 ──────► │  │
│  │ Ollama      │ │ Video Gen  → │ │  Node 2 ──────► │  │
│  │ LMStudio    │ │ Assembly     │ │  Node N ──────► │  │
│  └─────────────┘ └──────────────┘ └─────────────────┘  │
│  ┌─────────────────────────────────────────────────┐    │
│  │              SQLite + Filesystem                │    │
│  │  Projects DB │ Storyboards │ Frames │ Clips     │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

## Development Phases

| Phase | Focus                        | Status |
|-------|------------------------------|--------|
| 1     | Foundation (config, DB, API) | ❌ TODO |
| 2     | LLM Adapters                 | ❌ TODO |
| 3     | ComfyUI Integration          | ❌ TODO |
| 4     | Pipeline Orchestrator        | ❌ TODO |
| 5     | Electron + React UI          | ❌ TODO |
| 6     | Packaging & Distribution     | ❌ TODO |

## Data Flow: Full Pipeline

```
User Prompt
    │
    ▼
LLM Adapter
    │ JSON storyboard
    ▼
StoryboardGenerator ── validates ── saves to DB
    │
    ▼ (parallel, max 4)
FrameGenerator ──── ComfyUI txt2img ──► first_frame.png
                 └── ComfyUI txt2img ──► last_frame.png
    │
    ▼ (parallel, max 2)
VideoGenerator ──── ComfyUI img2video ──► shot_XXX.mp4
    │
    ▼
VideoAssembler ──── FFmpeg ──► final_video.mp4
```

## Config Hierarchy
```
config/default.yaml          ← bundled defaults
~/.cinematic-studio/config.yaml ← user overrides
env vars (OPENAI_API_KEY etc) ← highest priority
```

## ComfyUI Node Pool
Multiple ComfyUI nodes can be configured for parallel processing.
The pool uses round-robin with health checking:
- Each node gets a queue depth score
- Failed nodes quarantined for 60s
- Health checked every 30s in background
