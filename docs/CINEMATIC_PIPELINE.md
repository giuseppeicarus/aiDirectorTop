# CinematicAI Studio — Cinematic Pipeline Documentation

## Overview

La pipeline cinematografica di CinematicAI Studio implementa un sistema di produzione AI-driven professionale ispirato alle pipeline delle case di produzione reali.

Il principio fondamentale: **l'LLM non è un chatbot, è un regista**.

---

## Il Workflow Completo

```
USER INPUT
├── Story brief (testo narrativo)
├── Lyrics (opzionale, per music video)
├── Audio file (opzionale → analisi BPM/energia/emozione)
├── Style references ("noir", "wes anderson", "dogma 95")
├── Mood references ("melancholic", "epic", "romantic")
├── Character descriptions (fisico + wardrobe + visual anchor)
└── Runtime target (secondi)

         │
         ▼

STAGE 1: STORY ANALYST (LLM 1)
Analizza input → estrae temi, metafore visive, progressione emotiva
Output: StoryAnalysis {themes, visual_metaphors, emotion_progression, pacing_notes}

         │
         ▼

STAGE 2: NARRATIVE DIRECTOR (LLM 2)
Genera struttura narrativa gerarchica
Output: StoryArc {sequences → scenes → shot_placeholders}
Garantisce: continuità narrativa, pacing emotivo, coerenza visiva

         │
         ▼

STAGE 3: CINEMATOGRAPHER (LLM 3)
Assegna linguaggio cinematografico a ogni shot
Output: shot_list[] con CinematicShot completi
Garantisce: camera language, transitions, music sync, continuity_notes

         │
         ▼

STAGE 4: PROMPT ENGINEER (LLM 4)
Genera prompt immagine/video per ogni shot
Output: shot_list[] arricchiti con first_frame, last_frame, motion_prompt
Garantisce: character consistency, visual continuity, prompt quality

         │
         ▼

STAGE 5: CONTINUITY CHECKER (LLM 5)
Verifica errori di continuità sull'intero shot list
Output: ContinuityReport {errors[], corrections[]}
Se errori critici → torna a LLM 3/4 per correzioni (max 2 iterazioni)

         │
         ▼

FRAME GENERATION (ComfyUI — parallelo, max 4 job)
Per ogni shot: genera first_frame.png e last_frame.png via txt2img

         │
         ▼

VIDEO GENERATION (ComfyUI — parallelo, max 2 job)
Per ogni shot: genera clip video via img2video (WAN 2.1 / CogVideoX)

         │
         ▼

ASSEMBLY (FFmpeg)
Concatena clip con transizioni → video finale
```

---

## Gerarchia Narrativa

```
STORY ARC
│
├── SEQUENCE (atto narrativo: intro / buildup / chorus / bridge / climax / outro)
│   │   Ogni sequenza ha: ruolo narrativo, arco emotivo, durata
│   │
│   └── SCENE (cambio location/tempo/mood)
│       │   Ogni scena ha: trigger del cambio, location, mood
│       │
│       └── SHOT (inquadratura singola)
│               shot_type, camera_movement, lens
│               transition_in / transition_out
│               emotion, music_sync
│               continuity_notes → hereditate dallo shot successivo
│               first_frame, last_frame, motion_prompt
```

---

## Camera Language Rules

| Emozione/Situazione | Shot Type | Movimento |
|---|---|---|
| Intimità emotiva | close-up | slow dolly in |
| Isolamento | extreme wide | static |
| Rivelazione | medium | orbit/arc |
| Libertà | wide | drone push forward |
| Caos emotivo | medium | handheld |
| Spirituale/trascendente | medium | slow floating |
| Tensione | close-up | slow zoom in |
| Nostalgia | medium | slow pan |
| Epico/climax | extreme wide | drone push forward |
| Risoluzione | wide | slow pull back |

---

## Transition Rules

| Transizione | Quando usarla |
|---|---|
| `fade_from_black` | Inizio progetto, inizio sequenza |
| `fade_to_black` | Fine sequenza, pausa narrativa |
| `cinematic_dissolve` | Cambio temporale, transizione morbida |
| `match_cut` | Oggetti/forme simili tra clip consecutive |
| `whip_pan` | Cambio energetico brusco, azione |
| `hard_cut_on_beat` | Picco energetico musicale |
| `motion_blur_transition` | Velocità, adrenalina |
| `environmental_wipe` | Cambio location naturale |
| `silhouette_transition` | Momento simbolico/poetico |
| `j_cut` | Audio scena successiva anticipa il taglio |
| `l_cut` | Audio scena precedente continua nella nuova |

---

## Scene Change Triggers

Una scena deve cambiare **solo** quando:
1. Il significato lirico cambia (tema o soggetto diverso)
2. Il chorus/verse/bridge inizia
3. Il livello di energia cambia significativamente
4. È necessaria una metafora visiva simbolica
5. Il tempo è passato (mattina → sera)
6. Lo stato emotivo del protagonista cambia radicalmente

**NON** cambiare scena solo per varietà visiva.

---

## Audio Sync Logic

| Livello Energia | Camera Speed | Tipo Shot | Tagli |
|---|---|---|---|
| low | lenta/statica | wide/medium statico | lunghi (8-15s) |
| medium | gentile | mix shot sizes | medi (4-8s) |
| high | dinamica | handheld/tracking | veloci (2-4s) |
| peak | massima | estremi angoli | rapidissimi (<2s) |

---

## Continuity Memory System

Ogni shot eredita un "memory packet" dallo shot precedente:

```json
{
  "shot_id": "shot_002_003",
  "character_states": {
    "marco": {
      "position": "standing at canal edge, facing camera",
      "expression": "melancholic",
      "wardrobe_note": "cream linen shirt, navy trousers, silver ring left hand"
    }
  },
  "location_state": {
    "background_elements": ["canal", "lamppost left", "bridge in distance"],
    "lighting_direction": "from left, warm sodium",
    "weather": "light rain"
  },
  "camera_state": {
    "last_shot_type": "medium_close_up",
    "last_movement": "static",
    "last_lens": 50
  },
  "emotional_state": "melancholic_reflective",
  "active_motifs": ["canal reflection", "rain", "silver ring"],
  "continuity_constraints": [
    "Canal must remain visible in background",
    "Rain must continue",
    "Character wardrobe unchanged",
    "Next shot should widen to show full figure"
  ]
}
```

---

## LLM Role Configuration

Ogni ruolo LLM può usare un provider/modello diverso:

```yaml
# config/default.yaml
llm_roles:
  story_analyst:
    provider: anthropic
    model: claude-sonnet-4-6
    temperature: 0.85
    max_tokens: 2000

  narrative_director:
    provider: anthropic
    model: claude-sonnet-4-6
    temperature: 0.70
    max_tokens: 4000

  cinematographer:
    provider: openai
    model: gpt-4o
    temperature: 0.55
    max_tokens: 6000

  prompt_engineer:
    provider: openai
    model: gpt-4o
    temperature: 0.65
    max_tokens: 8000

  continuity_checker:
    provider: anthropic
    model: claude-haiku-4
    temperature: 0.20
    max_tokens: 3000
```

---

## Pipeline Stage Weights (per progress bar)

```python
STAGE_WEIGHTS = {
    "story_analysis":    0.06,
    "narrative_arc":     0.08,
    "shot_list":         0.08,
    "prompt_generation": 0.08,
    "continuity_check":  0.05,
    "frame_gen":         0.35,
    "video_gen":         0.25,
    "assembly":          0.05,
}
```
