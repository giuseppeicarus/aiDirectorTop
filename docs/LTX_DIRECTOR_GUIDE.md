# LTX Director 2.3 — Guida all'integrazione in CinematicAI Studio

## Cos'è LTX Director 2.3

LTX Director 2.3 è un sistema di generazione video AI sviluppato da WhatDreamsCost
([github.com/WhatDreamsCost/WhatDreamsCost-ComfyUI](https://github.com/WhatDreamsCost/WhatDreamsCost-ComfyUI))
che trasforma LTX Video 2.x in uno "studio di regia" programmabile.

Il meccanismo chiave è il **Prompt Relay**: matrici di penalità Gaussiane applicate alla
cross-attention del transformer permettono di assegnare testi diversi a segmenti temporali
specifici all'interno di un unico video latent. Questo consente di:

- Specificare una descrizione diversa per ogni shot (segmento) nel video
- Ancorare fotogrammi guida (first_frame / last_frame) a posizioni precise della timeline
- Sincronizzare l'audio originale con la generazione video
- Mantenere coerenza temporale completa tra shot contigui

---

## Pipeline LTX Director: 2 Stage

```
Stage 1 — Generazione iniziale (8 step, denoise=1.0)
  Input:  Latent vuoto + guide frames + conditioning per segmento
  Output: Video latent a risoluzione nativa (es. 1280×720)
          Audio latent (se audio fornito)

          │
          ▼

Stage 2 — Upscaling + Refinement (4 step, denoise=0.4)
  Input:  Video latent stage-1 → upsampler spaziale 2x → re-sampling
  Output: Video latent ad alta risoluzione, dettagliato
          Audio latent stage-1 (passthrough)

          │
          ▼

Output: Video + Audio decodificati → file video con audio sincrono
```

Il stage-2 raffina ma **non stravolge** il contenuto: denoise=0.4 significa che il 60%
del latent di partenza viene mantenuto — solo i dettagli vengono migliorati.

---

## Come CinematicAI Studio usa LTX Director

### Prerequisiti della pipeline

LTX Director viene eseguito **sempre dopo la frame generation** (stage ComfyUI txt2img).
Questo è essenziale: il sistema usa le immagini `first_frame.png` e `last_frame.png`
di ogni shot come guide frame per ancorare il contenuto visivo.

```
Pipeline completa con LTX Director abilitato:

story_analysis → narrative_arc → shot_list → prompt_generation → continuity_check
                                                                        │
                                                                        ▼
                                                              frame_gen (txt2img)
                                                              Genera first_frame.png
                                                              e last_frame.png per shot
                                                                        │
                                                                        ▼
                                                              video_gen (LTX Director)
                                                              ← usa i frame appena generati
                                                                        │
                                                                        ▼
                                                              assembly (FFmpeg)
```

### Dati della pipeline che entrano in LTX Director

| Dato | Fonte | Come viene usato |
|------|-------|-----------------|
| `shot.scene_description` | LLM 3 — Cinematographer | global_prompt + local_prompt per segmento |
| `shot.emotion` | LLM 3 | aggiunto al global_prompt |
| `shot.location` | LLM 3 | aggiunto al global_prompt |
| `shot.lighting` | LLM 3 | aggiunto al global_prompt |
| `shot.camera` | LLM 3 | shot_type, movement, lens, DOF nel prompt |
| `shot.motion_prompt` | LLM 4 — Prompt Engineer | local_prompt della fase di movimento |
| `shot.lyrics_segment` | post-processing da AudioAnalysis | prefissato al local_prompt |
| `shot.first_frame.image_path` | frame_gen ComfyUI | guide_frame al frame 0 del segmento |
| `shot.last_frame.image_path` | frame_gen ComfyUI | guide_frame all'ultimo frame del segmento |
| `shot.duration_sec` | LLM 2 — Narrative Director | `segment_lengths` in frame |
| `audio_analysis.beat_times` | Librosa | opzionale, per sincronizzazione ritmica |
| `story_arc.logline` | LLM 2 | global_prompt modalità full_video |
| `story_arc.visual_motifs` | LLM 2 | global_prompt modalità full_video |
| `audio_file` (upload progetto) | utente | `LoadAudio` — audio VAE sincronizzato |

---

## Due modalità operative

### Modalità `per_shot` — Un workflow per ogni shot

Ogni CinematicShot genera un workflow LTX Director indipendente.

**Come funziona:**
- Lo shot viene diviso in 2 segmenti: fase intro (prima metà) + fase movimento (seconda metà)
- `global_prompt` = descrizione completa dello shot (scena + emozione + location + lighting + camera)
- `local_prompts` = `"[lyrics + scene_description] | [motion_prompt]"`
- `segment_lengths` = `"[frames_intro],[frames_motion]"`
- Guide frame 0 = first_frame.png dello shot
- Guide frame finale = last_frame.png dello shot
- L'audio (se fornito) viene ritagliato alla durata dello shot partendo da `time_start`

**Vantaggi:**
- Ogni shot è rigenerato indipendentemente → errori non si propagano
- Parallelizzabile: più shot possono girare su nodi GPU diversi
- Facile rigenerare un singolo shot senza ripartire da zero

**Svantaggi:**
- Nessuna coerenza temporale tra shot contigui: il modello non "vede" lo shot precedente
- Transizioni tra shot gestite solo da FFmpeg (dissolve/cut), non dal modello

---

### Modalità `full_video` — Tutta la timeline in un unico workflow (default)

Tutti gli shot del progetto vengono inviati a LTX Director come segmenti di un'unica
generazione video. Il modello mantiene il flusso latente attraverso tutta la durata.

**Come funziona:**

```
Shot 1 (4s)  Shot 2 (5s)  Shot 3 (3s)  Shot 4 (4s)  ...
├────────────┼────────────┼────────────┼────────────┤
│ prompt 1   │ prompt 2   │ prompt 3   │ prompt 4   │  ← local_prompts
│ frames 0   │ frame 96   │ frame 216  │ frame 288  │  ← guide frames (first_frame)
│ frame 95   │ frame 215  │ frame 287  │ frame 383  │  ← guide frames (last_frame)
└────────────┴────────────┴────────────┴────────────┘
                    UNICO LATENT VIDEO
```

**Struttura dei parametri:**
- `global_prompt` = logline StoryArc + visual_motifs + color_palette + stile cinematografico
- `local_prompts` = un prompt per shot pipe-separated, con lyrics_segment prefissato se presente
  ```
  "[lyrics shot1]. [scene_desc]. [motion_prompt] | [lyrics shot2]. [scene_desc]. [motion_prompt] | ..."
  ```
- `segment_lengths` = frame count di ogni shot comma-separated
  ```
  "96,120,72,96,..."
  ```
- Guide frames: `first_frame` e `last_frame` di ogni shot posizionati ai loro frame assoluti
- Audio: file audio completo del progetto, da 0s

**Vantaggi:**
- Continuità temporale reale: il modello interpola naturalmente tra shot
- Transizioni fluide senza artefatti di giuntura
- Il contesto narrativo globale permea ogni frame

**Svantaggi:**
- Un solo job ComfyUI per tutto il video (non parallelizzabile)
- VRAM proporzionale alla durata totale (video lunghi richiedono GPU con più VRAM)
- Errori richiedono la rigenerazione dell'intero video

---

## Timeline Data — il formato interno

Il `timeline_data` è una stringa JSON che LTX Director usa per mappare guide frames
ai segmenti temporali. CinematicAI lo costruisce automaticamente:

```json
{
  "segments": [
    {
      "start": 0,
      "end": 95,
      "prompt": "Ella walks through rain. camera slowly pushes forward",
      "guides": [
        { "frame": 0,  "imagePath": "shot_001_first.png", "strength": 1.0, "type": "image" },
        { "frame": 95, "imagePath": "shot_001_last.png",  "strength": 1.0, "type": "image" }
      ]
    },
    {
      "start": 96,
      "end": 215,
      "prompt": "Close-up of rain on window. camera static, slow zoom",
      "guides": [
        { "frame": 96,  "imagePath": "shot_002_first.png", "strength": 1.0, "type": "image" },
        { "frame": 215, "imagePath": "shot_002_last.png",  "strength": 1.0, "type": "image" }
      ]
    }
  ]
}
```

Ogni segmento ha:
- `start` / `end`: posizione in frame assoluti nella timeline
- `prompt`: il testo specifico per quel segmento (lyrics + scene + motion)
- `guides`: riferimenti alle immagini PNG (già caricate su ComfyUI via `/upload/image`)

---

## Grafo dei nodi ComfyUI generato

Gli ID nodo sono stabili (range 1001–3999) per non collidere con i workflow manifest esistenti.

```
LOADERS (1001–1005)
  1001: CheckpointLoaderSimple   ← ltx-video-2b-v0.9.6.safetensors
  1002: DualCLIPLoader           ← t5xxl_fp16.safetensors
  1003: VAELoaderKJ (video)      ← ltx-video-vae-decode-v0.9.6.safetensors
  1004: VAELoaderKJ (audio)      ← ltx-video-2b-v0.9.6.safetensors
  1005: LoraLoaderModelOnly      ← (opzionale)

IMAGE GUIDE LOADERS (2001, 2002, ...)
  2001: LoadImage first_frame    ← shot_001_first.png
  2002: LoadImage last_frame     ← shot_001_last.png
  2003: LoadImage first_frame    ← shot_002_first.png  (full_video mode)
  ...

AUDIO LOADER (3001)
  3001: LoadAudio                ← audio.mp3

CORE DIRECTOR (1010–1012)
  1010: LTXDirector              ← riceve tutto: model, clip, prompts, segments, audio
  1011: LTXVConditioning         ← conditioning adattato a LTXV
  1012: ConditioningZeroOut      ← negative conditioning

STAGE 1 — SAMPLING (1020–1026)
  1020: LTXDirectorGuide         ← applica guide frames + conditioning al latent
  1021: CFGGuider
  1022: RandomNoise
  1023: KSamplerSelect
  1024: BasicScheduler           ← steps=8, denoise=1.0
  1025: SamplerCustomAdvanced
  1026: LTXVSeparateAVLatent     ← separa video latent da audio latent

STAGE 2 — UPSCALING + REFINEMENT (1030–1038)
  1030: LTXVCropGuides
  1031: LatentUpscaleModelLoader ← ltxv_spatial_upscaler_0.9.7.safetensors
  1032: LTXVLatentUpsampler      ← 2x spatial upscale
  1033: LTXDirectorGuide         ← ri-applica guide al latent upscaled
  1034: CFGGuider
  1035: KSamplerSelect
  1036: BasicScheduler           ← steps=4, denoise=0.4
  1037: SamplerCustomAdvanced
  1038: LTXVSeparateAVLatent

OUTPUT (1040–1043)
  1040: LTXVConcatAVLatent       ← unisce video stage-2 + audio stage-1
  1041: VAEDecode                ← decodifica video latent → pixel
  1042: LTXVAudioVAEDecode       ← decodifica audio latent → waveform
  1043: SaveVideo                ← salva video+audio
```

---

## Configurazione in `config/default.yaml`

```yaml
ltx_director:
  enabled: false           # metti true quando LTX 2.3 è installato in ComfyUI
  mode: "full_video"       # "per_shot" | "full_video"

  # Nomi dei file modello (devono corrispondere esattamente a quelli in ComfyUI/models/)
  checkpoint: "ltx-video-2b-v0.9.6.safetensors"
  clip_name1: "t5xxl_fp16.safetensors"
  clip_name2: ""           # secondo CLIP (opzionale, lascia vuoto se non usato)
  video_vae: "ltx-video-vae-decode-v0.9.6.safetensors"
  audio_vae: "ltx-video-2b-v0.9.6.safetensors"
  upscale_model: "ltxv_spatial_upscaler_0.9.7.safetensors"
  lora_name: ""            # LoRA opzionale (es. "my_style_lora.safetensors")

  # Parametri di sampling
  stage1_steps: 8          # step generazione iniziale
  stage2_steps: 4          # step refinement dopo upscaling
  cfg_scale: 1.0           # LTX funziona meglio con CFG basso (1.0–2.0)
  frame_rate: 24           # FPS del video generato

  # Risoluzione output
  width: 1280
  height: 720
```

### Configurazione via API

I parametri sono anche modificabili via Services screen nell'app o via endpoint API:

```python
GET  /api/config
POST /api/config  { "ltx_director": { "enabled": true, "mode": "full_video" } }
```

---

## Come abilitare LTX Director

### 1. Installa il plugin ComfyUI

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/WhatDreamsCost/WhatDreamsCost-ComfyUI
cd WhatDreamsCost-ComfyUI
pip install -r requirements.txt
```

### 2. Scarica i modelli

Posiziona questi file nelle cartelle corrette di ComfyUI:

| File | Cartella ComfyUI |
|------|-----------------|
| `ltx-video-2b-v0.9.6.safetensors` | `models/checkpoints/` |
| `ltx-video-vae-decode-v0.9.6.safetensors` | `models/vae/` |
| `t5xxl_fp16.safetensors` | `models/clip/` |
| `ltxv_spatial_upscaler_0.9.7.safetensors` | `models/upscale_models/` |

### 3. Abilita in config

```yaml
# config/default.yaml
ltx_director:
  enabled: true
  mode: "full_video"
```

### 4. Riavvia il backend

```bash
python -m src.core.main
```

---

## Requisiti hardware

| Modalità | VRAM minima | Note |
|----------|-------------|------|
| `per_shot` (4s clip, 720p) | 12 GB | Un clip alla volta |
| `per_shot` (8s clip, 720p) | 16 GB | Shot più lunghi occupano più VRAM |
| `full_video` (60s, 720p) | 24 GB | Intero latent in memoria simultaneamente |
| `full_video` (120s, 720p) | 40+ GB | Non raccomandato su GPU consumer |

Per video lunghi in modalità `full_video` considera di ridurre la risoluzione
(`width: 854, height: 480`) o di usare la modalità `per_shot`.

---

## Integrazione con Audio Analysis

Quando il progetto include un file audio analizzato, CinematicAI:

1. **Assegna i lyrics_segment** a ogni shot durante la pipeline LLM (post-cinematographer)
2. **Carica l'audio su ComfyUI** (`POST /upload/image` con il file audio)
3. **Costruisce il nodo LoadAudio** con `start_seconds=0` (full_video) o `start_seconds=shot.time_start` (per_shot)
4. **Prefissa il lyrics_segment al local_prompt** di ogni segmento

Esempio di local_prompt generato con audio+lyrics:

```
"La luna splende sui tetti. Ella guarda in alto, occhi lucidi. camera slow dolly in | camera static, slow zoom on face"
```

L'audio VAE genera un latent audio sincronizzato con il video. Il risultato è un video
con l'audio originale del progetto incorporato e temporalmente allineato alle scene.

---

## Struttura dei file generati

```
~/.cinematic-studio/projects/{project_id}/
├── frames/
│   ├── shot_001_first.png      ← generato da txt2img (frame_gen stage)
│   ├── shot_001_last.png
│   ├── shot_002_first.png
│   └── ...
├── clips/
│   ├── ltx_shot_001.mp4        ← generato da LTX Director (per_shot mode)
│   ├── ltx_shot_002.mp4
│   └── ...
│   (oppure)
│   └── ltx_full_video.mp4      ← generato da LTX Director (full_video mode)
├── final/
│   └── {title}_final.mp4       ← assemblato da FFmpeg
└── pipeline_state.json
```

---

## Debugging

### LTX Director non viene invocato

Verifica che `ltx_director.enabled: true` in `config/default.yaml` e che
`pipeline_state.json` non abbia `video_gen` già in `completed_stages` (usa reset).

### Errore "node not found: LTXDirector"

Il plugin WhatDreamsCost non è installato correttamente in ComfyUI.
Verifica: `ComfyUI/custom_nodes/WhatDreamsCost-ComfyUI/` esiste e i requirements sono installati.

### Video generato senza audio

- Verifica che il progetto abbia un file audio caricato
- Controlla che `audio_vae` punti a un file esistente in ComfyUI
- In modalità `per_shot`, l'audio è opzionale: se mancante il video viene generato silenzioso

### VRAM insufficiente in `full_video` mode

Abbassa la risoluzione in config o passa a `mode: "per_shot"`.

### Qualità video scarsa

- Aumenta `stage1_steps` (es. 15–20) per più dettaglio nella generazione iniziale
- Aumenta `stage2_steps` (es. 8) per più raffinamento
- Il `cfg_scale` di LTX funziona meglio tra 1.0–3.0 (non alzarlo come con SDXL)
