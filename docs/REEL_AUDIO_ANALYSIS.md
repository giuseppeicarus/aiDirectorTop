# Analisi audio — Create Reel

Documentazione di cosa fa il pulsante **「Analizza audio e timing lirica」**, dove finiscono i dati e come li usa lo **Studio di regia AI** (pipeline reel).

---

## Due momenti distinti

| Momento | Endpoint / fase | Persistenza |
|--------|------------------|-------------|
| **Anteprima** (form Create Reel) | `POST /api/reel/analyze-audio` | Solo memoria UI (`audioAnalysis` in React). File temporaneo WAV in `data/uploads/reel_analyze/`. |
| **Generazione reel** | Fase pipeline `audio_analysis` (`ReelPipeline._phase_reel_audio_analysis`) | Checkpoint job: `sections`, `downbeats`, `audio_duration` in `checkpoint.json` sotto la cartella progetto/job. |

L’anteprima **non** invia i risultati al backend quando clicchi **Genera**: la pipeline **ricalcola** la stessa analisi sulla finestra `[audio_start_sec, audio_start_sec + duration_sec]`. Serve a verificare BPM, sezioni e timing testo prima di spendere GPU/LLM.

---

## Cosa fa l’analisi (tecnicamente)

1. **Trim FFmpeg** — estrae solo la finestra reel dalla traccia (`trim_audio_window` → `_analysis_window.wav`).
2. **Librosa** (sync, senza Demucs di default):
   - caricamento mono, durata;
   - **BPM** globale + griglia beat / downbeat (ogni 4 beat);
   - **segmentazione** strutturale (MFCC + clustering agglomerativo, fallback ogni ~15s);
   - **energia RMS** per sezione → `low` | `medium` | `high` | `peak`;
   - **euristica vocale** (centroid spettrale, o Demucs se `CINEMATIC_AUDIO_USE_DEMUCS=1`).
3. **Sezioni** (`AudioSection`): `start_sec`, `end_sec`, `section_type` (intro/verse/chorus/… ciclico), `energy`, `bpm_local`, `has_vocal`, `hook_score`.
4. **Timing lirica** (solo se hai incollato testo nel campo lirica):
   - `compute_lyric_timing` in `src/core/utils/lyric_analyzer.py`;
   - **non** trascrive dall’audio: distribuisce le righe del testo manuale sulle sezioni in proporzione alla durata/energia;
   - output: `lyric_beats[]` con `{ lyric_line, time_sec, end_sec, emotion, energy, suggested_visual }`.

Risposta API anteprima:

```json
{
  "duration_sec": 30,
  "audio_start_sec": 0,
  "bpm": 128.5,
  "sections": [ { "section_id", "start_sec", "end_sec", "energy", ... } ],
  "downbeat_count": 32,
  "lyric_beats": [ { "lyric_line", "time_sec", "end_sec", ... } ]
}
```

---

## Dove viene salvato il timing della lirica

| Dato | Anteprima UI | Durante generazione |
|------|----------------|---------------------|
| `sections` | Stato React `audioAnalysis.raw.sections` | `ReelPipeline._sections` → `checkpoint.json` campo `"sections"` |
| `lyric_beats` | Stato React `audioAnalysis.raw.lyric_beats` | `ReelPipeline._lyric_beats` (**RAM**, non serializzato nel checkpoint attuale) |
| Testo per slot | — | `ReelPipeline._slot_lyrics[slot_id]` dopo `_map_lyrics_to_slots()` |
| Su clip | — | `lyrics_segment` nei prompt cinematografo / `visual_hint` con prefisso `Lyrics in this window:` |

Il testo sorgente resta in **`ReelRequest.lyrics`** (inviato con **Genera**). Il timing derivato vive in `_lyric_beats` fino a fine job; le clip ereditano il segmento testo mappato per finestra temporale EDL.

---

## Come lo usa lo Studio di regia AI

Flusso reel con audio (`_has_source_audio`):

```
audio_analysis → reel_director (LLM) → EDL slot → _map_lyrics_to_slots → cinematographer → prompt_engineer → ComfyUI (LTX img+audio)
```

### 1. Narrative Director (`build_reel_director_user_prompt`)

Riceve nel prompt:

- `AUDIO TIMELINE`: BPM, JSON sezioni (max ~10), JSON `lyric_beats` (max ~24);
- `FULL LYRICS`: testo incollato dall’utente.

Il regista definisce **slot** narrativi (`duration_weight`, `visual_hint`, emozione) allineati a energia e beat lirici.

### 2. `_map_lyrics_to_slots`

Per ogni slot EDL `[start_sec, end_sec]` del reel, raccoglie le righe i cui `time_sec`/`end_sec` si sovrappongono → `_slot_lyrics[slot_id]`.

### 3. Cinematographer / Prompt engineer

Ogni slot porta `lyrics_segment` e hint visivi; i prompt LTX possono citare il testo nella finestra clip.

### 4. Audio LTX

`_reel_sequential_audio_seek` taglia la traccia sorgente per clip (`audio_src_start_sec`) in sync con la timeline reel (non è STT: è allineamento manuale + analisi ritmica).

---

## UI — feedback dopo 「Analizza」

Dopo successo compare il pannello verde **「Analisi completata」** con BPM, sezioni, breakdown energia, timeline sezioni e (se c’è testo) anteprima timing lirica.

Se non vedi nulla:

- errore rosso sotto il pulsante (timeout 504, file non trovato, ffmpeg);
- analisi ok ma **senza testo** → solo BPM/sezioni (messaggio giallo informativo);
- testo presente ma righe vuote → 0 `lyric_beats`.

Durante **Genera**, gli eventi SSE `audio_analysis` / `audio_analysis_done` aggiornano la barra fasi (come nel trailer), indipendentemente dall’anteprima.

---

## File di riferimento

| Ruolo | Path |
|-------|------|
| API anteprima | `src/core/api/reel_routes.py` → `reel_analyze_audio` |
| Orchestrazione anteprima | `src/core/utils/reel_audio.py` |
| Analisi librosa | `src/core/workflow/trailer_pipeline.py` → `_analyze_audio_sync` |
| Timing testo | `src/core/utils/lyric_analyzer.py` |
| Pipeline reel | `src/core/workflow/reel_pipeline.py` |
| Prompt regista | `src/core/llm/reel_prompts.py` |
| UI | `src/ui/renderer/components/ReelAudioSection.jsx` |

---

## Variabili utili

- `CINEMATIC_AUDIO_USE_DEMUCS=1` — abilita separazione vocale Demucs (lento; disattivato di default per l’anteprima reel).
