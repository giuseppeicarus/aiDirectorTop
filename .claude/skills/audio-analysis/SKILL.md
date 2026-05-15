---
name: audio-analysis
description: Analizza file audio per estrarre BPM, sezioni, mappa emotiva e dati di sincronizzazione. Applicare quando si implementa audio_analyzer.py, si aggiunge il supporto upload audio nel frontend, o si integra l'analisi audio nella pipeline cinematografica.
---

# Audio Analysis Skill

## Librerie richieste
```
librosa==0.10.2
numpy==1.26.4
soundfile==0.12.1
```
Aggiungi a `requirements.txt`.

## Implementazione (`src/core/workflow/audio_analyzer.py`)

```python
import librosa
import numpy as np
from pathlib import Path
from src.core.models.cinematic import AudioAnalysis, AudioSection

ENERGY_THRESHOLDS = {"low": 0.3, "medium": 0.6, "high": 0.85}

EMOTION_MAP = {
    ("low",    True):  "melancholic",
    ("low",    False): "calm",
    ("medium", True):  "romantic",
    ("medium", False): "nostalgic",
    ("high",   True):  "epic",
    ("high",   False): "intense",
    ("peak",   True):  "euphoric",
    ("peak",   False): "dramatic",
}

async def analyze_audio(filepath: str) -> AudioAnalysis:
    y, sr = librosa.load(filepath, sr=None, mono=True)
    
    # BPM globale
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    
    # Segmentazione per energia RMS
    hop_length = 512
    rms = librosa.feature.rms(y=y, hop_length=hop_length)[0]
    rms_norm = rms / (rms.max() + 1e-8)
    
    # Chroma features per tonalità
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    key_idx = int(np.argmax(chroma.mean(axis=1)))
    keys = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"]
    key = keys[key_idx]
    
    # Segmenta in blocchi di ~8 secondi
    block_sec = 8.0
    frames_per_block = int(block_sec * sr / hop_length)
    sections = []
    
    for i in range(0, len(rms_norm), frames_per_block):
        block = rms_norm[i:i+frames_per_block]
        if len(block) == 0:
            continue
        avg_energy = float(block.mean())
        
        if avg_energy < ENERGY_THRESHOLDS["low"]:
            energy_level = "low"
        elif avg_energy < ENERGY_THRESHOLDS["medium"]:
            energy_level = "medium"
        elif avg_energy < ENERGY_THRESHOLDS["high"]:
            energy_level = "high"
        else:
            energy_level = "peak"
        
        start_sec = i * hop_length / sr
        end_sec = min((i + frames_per_block) * hop_length / sr, len(y) / sr)
        
        # BPM locale
        y_block = y[int(start_sec*sr):int(end_sec*sr)]
        local_tempo, _ = librosa.beat.beat_track(y=y_block, sr=sr)
        
        # Stima modalità (maggiore/minore) per emozione
        spectral_contrast = librosa.feature.spectral_contrast(y=y_block, sr=sr)
        is_major = float(spectral_contrast.mean()) > 20
        
        emotion = EMOTION_MAP.get((energy_level, is_major), "neutral")
        
        sections.append(AudioSection(
            start_sec=round(start_sec, 2),
            end_sec=round(end_sec, 2),
            energy=energy_level,
            emotion=emotion,
            bpm_local=round(float(local_tempo), 1),
        ))
    
    # Emotion timeline (granularità 1s)
    timeline = []
    for sec in range(int(len(y)/sr)):
        frame = int(sec * sr / hop_length)
        if frame < len(rms_norm):
            intensity = float(rms_norm[frame])
            section = next((s for s in sections if s.start_sec <= sec < s.end_sec), None)
            emotion = section.emotion if section else "neutral"
            timeline.append({"time_sec": sec, "emotion": emotion, "intensity": round(intensity, 3)})
    
    return AudioAnalysis(
        bpm=round(float(tempo), 1),
        key=key,
        sections=sections,
        emotion_timeline=timeline,
    )
```

## API Route (`src/core/api/media_routes.py` — aggiungi)

```python
@router.post("/audio/analyze")
async def analyze_audio_upload(file: UploadFile):
    """Carica un file audio e restituisce l'analisi cinematografica."""
    import tempfile
    suffix = Path(file.filename).suffix
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name
    
    from src.core.workflow.audio_analyzer import analyze_audio
    result = await analyze_audio(tmp_path)
    Path(tmp_path).unlink()
    return result
```

## UI — ProjectCreatorScreen

Aggiungi sezione "Analisi Audio" nel form:
- Input file audio (MP3, WAV, FLAC, M4A)
- Bottone "Analizza" → chiama `/api/media/audio/analyze`
- Preview risultati: BPM, tonalità, grafico energie per sezione
- I dati vengono salvati in ProjectInput.audio_analysis

## Output usato da LLM 3 (Cinematographer)

```python
audio_context = f"""
AUDIO ANALYSIS:
BPM: {analysis.bpm}
Key: {analysis.key}

Sections:
{chr(10).join([
    f"  {s.start_sec}s-{s.end_sec}s: {s.energy} energy, {s.emotion} mood, {s.bpm_local} BPM"
    for s in analysis.sections
])}

Use this to determine:
- Shot pacing (low energy = slow, high = fast)
- Camera movement speed
- Transition timing (cut on beat when energy is high)
- Emotional tone per section
"""
```
