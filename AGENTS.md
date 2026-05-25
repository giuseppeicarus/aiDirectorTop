# CinematicAI Studio — Agent Memory

## PROJECT MISSION
Build a cross-platform desktop application (Windows/Linux/macOS) for **automated cinematic video creation** using AI. The app implements a professional cinematic pipeline: multi-LLM orchestration → Story Arc → Shot List → Frame generation → Video synthesis via ComfyUI.

The LLM must behave as a professional director, not a chatbot.

## GOAL
Deliver a production-ready Electron + Python backend app with these sections:
1. **Progetti** — gestione progetti, pipeline, storyboard
2. **Nodi ComfyUI** — monitoring e configurazione nodi GPU
3. **Servizi** — configurazione LLM, ComfyUI workflows, FFmpeg, database
4. **Media Library** — galleria immagini/video con tag progetto e filtri

---

## CINEMATIC PIPELINE — CORE CONCEPT

### Il sistema LLM è una catena di registi specializzati

```
USER INPUT (brief + lyrics + audio analysis + style refs)
      │
      ▼
LLM 1: STORY ANALYST
  - Analizza musica + lirica + BPM + emotion map
  - Output: emotion_timeline[], story_arc, visual_motifs[]

      │
      ▼
LLM 2: NARRATIVE DIRECTOR
  - Genera Story Arc gerarchico
  - Output: sequences[] → scenes[] → shots[]
  - Mantiene: narrative_continuity, emotional_pacing

      │
      ▼
LLM 3: CINEMATOGRAPHER
  - Genera shot list professionale
  - Assegna: camera_type, movement, lens, lighting, transition
  - Rispetta: camera_language_rules, continuity_rules

      │
      ▼
LLM 4: PROMPT ENGINEER
  - Genera prompt txt2img (first_frame, last_frame) coerenti
  - Genera motion_prompt per img2video
  - Rispetta: character_consistency, visual_continuity

      │
      ▼
LLM 5: CONTINUITY CHECKER
  - Verifica errori di continuità tra clip
  - Controlla: character state, lighting, location, wardrobe
  - Output: continuity_report, corrections[]

      │
      ▼
ComfyUI → Frames → Video clips → FFmpeg assembly
```

### Gerarchia narrativa
```
STORY ARC
  └── SEQUENCE (atto narrativo)
        └── SCENE (cambio location/tempo)
              └── SHOT (inquadratura singola)
                    ├── CAMERA ACTION
                    ├── CHARACTER ACTION
                    ├── TRANSITION IN/OUT
                    ├── EMOTIONAL INTENT
                    └── MUSIC SYNC
```

---

## ARCHITETTURA TECNICA

```
Frontend: Electron + React + Tailwind
Backend:  Python FastAPI (port 8765)
AI:       Multi-LLM pipeline (OpenAI / Anthropic / Ollama / Groq)
Video:    ComfyUI API (multi-node pool)
Storage:  SQLite + local filesystem
```

## TECH STACK
- **Frontend**: Electron 32+, React 18, Tailwind CSS, Zustand
- **Backend**: Python 3.11+, FastAPI, asyncio, httpx, Pydantic v2
- **DB**: SQLite via SQLAlchemy async
- **ComfyUI**: REST + WebSocket
- **Packaging**: electron-builder + PyInstaller
- **Fonts**: Playfair Display (headings) + JetBrains Mono (UI)

## DESIGN TOKENS
```
--bg0:#07070d  --bg1:#0f0f18  --bg2:#16161f  --bg3:#1e1e2a
--border:#252533  --border2:#32324a
--gold:#c9a84c  --gold2:#e6c46a  --gold-dim:#c9a84c22
--text:#e8e4dd  --text2:#9090a8  --text3:#555568
--green:#22c55e  --red:#ef4444  --blue:#3b82f6  --amber:#f59e0b
```

---

## CINEMATIC DATA MODELS

### ProjectInput (user fills this)
```python
class ProjectInput(BaseModel):
    title: str
    story_brief: str                    # descrizione narrativa
    lyrics: Optional[str]               # testo canzone (se music video)
    audio_analysis: Optional[AudioAnalysis]  # BPM, sezioni, energie
    style_references: List[str]         # "noir", "wes anderson", "tarantino"
    mood_references: List[str]          # "melancholic", "epic", "romantic"
    characters: List[CharacterDef]      # nome, descrizione fisica, wardrobe
    visual_references: List[str]        # URL immagini di riferimento
    runtime_target_sec: int             # durata target video
    aspect_ratio: str                   # "16:9" | "21:9" | "2.39:1"
    genre: str                          # "music_video" | "short_film" | "commercial"
```

### AudioAnalysis
```python
class AudioSection(BaseModel):
    start_sec: float
    end_sec: float
    energy: Literal["low", "medium", "high", "peak"]
    emotion: str            # "nostalgic", "romantic", "epic", "dark"
    bpm_local: Optional[float]

class AudioAnalysis(BaseModel):
    bpm: float
    key: Optional[str]
    sections: List[AudioSection]
    emotion_timeline: List[dict]   # [{time, emotion, intensity}]
```

### CharacterDef
```python
class CharacterDef(BaseModel):
    name: str
    description: str        # aspetto fisico dettagliato
    wardrobe: str           # abbigliamento specifico
    personality: str        # per guidare le azioni
    visual_anchor: str      # elemento visivo persistente (es. "red scarf")
```

### CinematicShot (output LLM 3)
```python
class CameraConfig(BaseModel):
    shot_type: str          # wide|medium|close_up|extreme_close|drone|pov|over_shoulder
    movement: str           # static|dolly_in|dolly_out|pan|tilt|orbit|tracking|handheld|floating
    lens_mm: int            # 18|24|35|50|85|135
    depth_of_field: str     # shallow|medium|deep
    special: Optional[str]  # anamorphic|fisheye|macro

class LightingConfig(BaseModel):
    time_of_day: str        # golden_hour|blue_hour|midday|night|interior
    mood: str               # warm|cold|dramatic|soft|harsh
    sources: List[str]      # natural|practical|key|backlight|rim

class MusicSync(BaseModel):
    bass: str               # "camera pulse" | "subtle zoom"
    snare: str              # "small cuts" | "flash cut"
    vocals: str             # "slow drift" | "close-up"
    beat_cuts: bool         # taglia sul beat?

class CinematicShot(BaseModel):
    shot_id: str            # "shot_001_003" (scene_001, shot_003)
    sequence_id: str
    scene_id: str
    time_start: str         # "00:08"
    time_end: str           # "00:16"
    duration_sec: float
    lyrics_segment: Optional[str]
    scene_description: str  # descrizione visiva dettagliata
    location: str
    characters: List[dict]  # [{name, action, position, expression}]
    camera: CameraConfig
    lighting: LightingConfig
    transition_in: str      # fade_from_black|dissolve|match_cut|whip_pan|hard_cut|motion_blur|wipe
    transition_out: str
    emotion: str            # emotional intent dello shot
    music_sync: MusicSync
    continuity_notes: List[str]   # regole da rispettare per lo shot successivo
    first_frame: FramePrompt
    last_frame: FramePrompt
    motion_prompt: str      # per img2video: "camera slowly pushes forward, mist drifts left"
    comfyui_workflow: str
```

### StoryArc (output LLM 2)
```python
class StoryArc(BaseModel):
    title: str
    logline: str            # 1 frase che riassume la storia
    visual_motifs: List[str]  # elementi visivi ricorrenti
    color_palette: List[str]  # hex colors del progetto
    sequences: List[Sequence]

class Sequence(BaseModel):
    id: str
    title: str
    narrative_role: str     # "intro"|"buildup"|"climax"|"resolution"
    emotion_arc: str        # progressione emotiva della sequenza
    scenes: List[Scene]

class Scene(BaseModel):
    id: str
    title: str
    location: str
    time_of_day: str
    mood: str
    trigger: str            # cosa ha causato il cambio scena (lyric|energy|beat|symbol)
    shots: List[CinematicShot]
```

---

## FILE STRUCTURE
```
cinematic-ai-studio/
├── .Codex/
│   ├── agents/
│   │   ├── storyboard-architect.md
│   │   ├── cinematic-director.md      ← NUOVO: regista AI
│   │   ├── continuity-checker.md      ← NUOVO: verifica continuità
│   │   ├── comfyui-engineer.md
│   │   ├── llm-adapter-engineer.md
│   │   ├── pipeline-orchestrator.md
│   │   └── ui-engineer.md
│   ├── skills/
│   │   ├── cinematic-prompting/       ← NUOVO
│   │   ├── audio-analysis/            ← NUOVO
│   │   ├── storyboard-gen/
│   │   ├── comfyui-workflow/
│   │   ├── llm-config/
│   │   └── video-pipeline/
│   ├── commands/
│   │   ├── build-phase.md
│   │   ├── project-status.md
│   │   ├── gen-storyboard.md
│   │   ├── test-comfyui.md
│   │   └── check-continuity.md        ← NUOVO
│   └── settings.json
├── src/
│   ├── core/
│   │   ├── main.py
│   │   ├── config.py
│   │   ├── database.py
│   │   ├── llm/
│   │   │   ├── base.py
│   │   │   ├── openai_adapter.py
│   │   │   ├── anthropic_adapter.py
│   │   │   ├── ollama_adapter.py
│   │   │   ├── factory.py
│   │   │   └── cinematic_prompts.py   ← NUOVO: prompt per ogni LLM ruolo
│   │   ├── comfyui/
│   │   │   ├── client.py
│   │   │   ├── pool.py
│   │   │   └── workflow_builder.py
│   │   ├── workflow/
│   │   │   ├── pipeline.py
│   │   │   ├── story_analyst.py       ← NUOVO: LLM 1
│   │   │   ├── narrative_director.py  ← NUOVO: LLM 2
│   │   │   ├── cinematographer.py     ← NUOVO: LLM 3
│   │   │   ├── prompt_engineer.py     ← NUOVO: LLM 4
│   │   │   └── continuity_checker.py  ← NUOVO: LLM 5
│   │   ├── models/
│   │   │   ├── project.py
│   │   │   ├── media.py
│   │   │   └── cinematic.py           ← NUOVO: tutti i modelli cinematografici
│   │   └── api/
│   │       ├── project_routes.py
│   │       ├── llm_routes.py
│   │       ├── comfyui_routes.py
│   │       ├── pipeline_routes.py
│   │       ├── media_routes.py
│   │       └── services_routes.py
│   └── ui/
│       ├── main.js
│       ├── preload.js
│       └── renderer/
│           ├── App.jsx
│           ├── stores/index.js
│           ├── components/Layout.jsx
│           └── screens/
│               ├── ProjectListScreen.jsx
│               ├── ProjectCreatorScreen.jsx  ← form avanzato + audio upload
│               ├── StoryboardScreen.jsx       ← viewer gerarchia cinematografica
│               ├── PipelineScreen.jsx         ← progress multi-stage LLM
│               ├── NodesScreen.jsx
│               ├── ServicesScreen.jsx
│               ├── MediaLibraryScreen.jsx
│               └── SettingsScreen.jsx
├── config/
│   ├── default.yaml
│   └── workflows/
└── docs/
    ├── ARCHITECTURE.md
    ├── CINEMATIC_PIPELINE.md          ← NUOVO
    ├── COMFYUI_API.md
    └── storyboard_schema.json
```

---

## LLM ROLES — SYSTEM PROMPTS

### LLM 1: Story Analyst
```
You are a professional music video story analyst.
Analyze the provided brief, lyrics, and audio analysis.
Extract: emotional progression, narrative themes, visual metaphors, pacing cues.
Output ONLY valid JSON. No explanations.
```

### LLM 2: Narrative Director
```
You are an award-winning cinematic music video director.
Transform the story analysis into a hierarchical narrative structure.
Think like a real director planning a professional production.
Maintain: narrative continuity, emotional pacing, visual coherence.
Do NOT generate random scenes. Every scene must have narrative purpose.
Output ONLY valid JSON. No explanations.
```

### LLM 3: Cinematographer
```
You are a professional cinematographer and storyboard artist.
For each shot, apply professional camera language:
- emotional intimacy → close-up
- isolation → wide shot
- revelation → orbit shot
- freedom → drone shot
- chaos → handheld
- spiritual → slow floating camera
Camera language must EVOLVE with music intensity.
Output ONLY valid JSON. No explanations.
```

### LLM 4: Prompt Engineer
```
You are a specialist in AI image/video generation prompts for cinematic content.
Generate detailed, coherent prompts for each shot's first_frame and last_frame.
Ensure character visual consistency across all shots.
Frame prompts format: [STYLE], [SHOT TYPE], [SUBJECT+ACTION], [ENVIRONMENT], [LIGHTING], [MOOD], [TECHNICAL]
Motion prompts: short (max 15 words), describe camera+subject movement.
Output ONLY valid JSON. No explanations.
```

### LLM 5: Continuity Checker
```
You are a professional script continuity supervisor.
Review the complete shot list for continuity errors:
- Character wardrobe/appearance consistency
- Lighting continuity within scenes
- Location/background consistency
- Emotional arc coherence
- Camera language progression logic
Report all errors with shot_id references and suggested corrections.
Output ONLY valid JSON. No explanations.
```

---

## CAMERA LANGUAGE RULES

```python
CAMERA_LANGUAGE = {
    "emotional_intimacy":  {"shot": "close_up",    "movement": "slow_dolly_in"},
    "isolation":           {"shot": "extreme_wide", "movement": "static"},
    "revelation":          {"shot": "medium",       "movement": "orbit"},
    "freedom":             {"shot": "wide",         "movement": "drone_push"},
    "chaos":               {"shot": "medium",       "movement": "handheld"},
    "spiritual":           {"shot": "medium",       "movement": "floating"},
    "tension":             {"shot": "close_up",     "movement": "slow_zoom_in"},
    "resolution":          {"shot": "wide",         "movement": "slow_pullback"},
    "nostalgia":           {"shot": "medium",       "movement": "slow_pan"},
    "epic":                {"shot": "extreme_wide", "movement": "drone_push_forward"},
}
```

## ALLOWED TRANSITIONS
```python
TRANSITIONS = [
    "fade_from_black", "fade_to_black",
    "cinematic_dissolve",
    "match_cut",        # oggetto/forma simile tra clip
    "whip_pan",         # taglio veloce con pan
    "hard_cut_on_beat",
    "motion_blur_transition",
    "environmental_wipe",
    "silhouette_transition",
    "smash_cut",
    "j_cut",            # audio della scena successiva anticipa il taglio
    "l_cut",            # audio della scena precedente continua
]
```

## SCENE CHANGE TRIGGERS
```python
SCENE_CHANGE_TRIGGERS = [
    "lyrical_meaning_changes",
    "emotional_intensity_changes",
    "chorus_begins",
    "verse_begins",
    "instrumental_break",
    "symbolic_visual_metaphor_needed",
    "beat_structure_changes",
    "energy_shift_high_to_low",
    "energy_shift_low_to_high",
]
```

---

## APP SECTIONS

### 1. Progetti (/projects)
- Griglia card: titolo, genere, durata, stato
- Progress pipeline real-time (5 stage LLM + frame gen + video gen + assembly)
- Card con: Story Arc preview, numero scene/shot, personaggi

### 2. Nodi ComfyUI (/nodes)
- Card per nodo: VRAM, queue, modello attivo, uptime
- Distribuzione job round-robin
- Health check ogni 30s

### 3. Servizi (/services)
- LLM Provider: selezione + API key + test
- LLM Pipeline Config: quale LLM per quale ruolo (Story Analyst / Director / ecc.)
- ComfyUI Pipeline: workflow attivi
- Assembly & Output: FFmpeg config
- Storage stats

### 4. Media Library (/media)
- Galleria griglia: immagini e video
- Filtri: tipo (IMG/VIDEO) e progetto
- Project tag colorato su ogni item
- Preview, download, elimina

---

## NAVIGATION
```
Sidebar:
  🗂 Progetti
  ⚡ Nodi ComfyUI
  🔧 Servizi
  ─────────
  🖼 Media Library
  ─────────
  ⚙ Impostazioni

Footer: dot nodi real-time
```

## ROUTING
```
/projects                     ProjectListScreen
/projects/new                 ProjectCreatorScreen (form avanzato)
/projects/:id/storyboard      StoryboardScreen (viewer gerarchia)
/projects/:id/pipeline        PipelineScreen (5 stage LLM + gen)
/nodes                        NodesScreen
/services                     ServicesScreen
/media                        MediaLibraryScreen
/settings                     SettingsScreen
```

## IPC CHANNELS
```javascript
// Progetti
'project:create'  'project:list'  'project:get'  'project:delete'  'project:storyboard'

// Nodi
'comfyui:nodes'  'comfyui:node:add'  'comfyui:node:remove'  'comfyui:node:test'

// Servizi
'services:status'  'llm:health'  'llm:config:save'  'ffmpeg:version'  'storage:stats'

// Media
'media:list'  'media:delete'  'media:open-folder'  'media:open-file'

// Pipeline (SSE)
'pipeline:run'  'pipeline:state'  'pipeline:reset'  'pipeline:progress'
```

## ZUSTAND STORES
```javascript
useProjectStore     projects[], currentProject, storyArc, shotList
usePipelineStore    stage, progress, llmStage, logs[], frames{}, clips{}, finalVideoPath
useNodesStore       nodes[], addNode, removeNode, refreshStatus
useServicesStore    llmStatus, ffmpegVersion, storageStats, workflows
useMediaStore       items[], filters{type,projectId}, loadMedia, deleteItem
useConfigStore      llm{}, llmRoles{}, output{}, ui{}
```

## PIPELINE STAGES (aggiornato con 5 LLM)
```python
STAGE_WEIGHTS = {
    "story_analysis":    0.06,   # LLM 1
    "narrative_arc":     0.08,   # LLM 2
    "shot_list":         0.08,   # LLM 3
    "prompt_generation": 0.08,   # LLM 4
    "continuity_check":  0.05,   # LLM 5
    "frame_gen":         0.35,   # ComfyUI txt2img
    "video_gen":         0.25,   # ComfyUI img2video
    "assembly":          0.05,   # FFmpeg
}
```

## CODING RULES
- Python: type hints, Pydantic v2, async/await
- JS/JSX: functional components, no any
- API errors: {"error": str, "code": str}
- LLM calls: sempre JSON mode + retry 3x
- ComfyUI: async, timeout 300s
- Paths: pathlib.Path sempre
- Log: structlog (Python), electron-log (JS)

## TOKEN-SAVING RULES
- Leggi AGENTS.md prima di tutto
- Usa subagenti per exploration
- Un file per volta
- @docs/CINEMATIC_PIPELINE.md per domande sul pipeline LLM
- @docs/COMFYUI_API.md per domande ComfyUI
