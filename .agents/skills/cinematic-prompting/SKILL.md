---
name: cinematic-prompting
description: Costruisce prompt cinematografici professionali per ogni ruolo LLM della pipeline. Applicare quando si scrivono o modificano i system prompt dei 5 LLM, si generano frame prompts per ComfyUI, o si progettano motion prompts per img2video.
---

# Cinematic Prompting Skill

## PRINCIPIO FONDAMENTALE

Non chiedere all'LLM "genera scene".
Assegnagli un **ruolo** e impostagli **regole cinematografiche precise**.

## STRUTTURA SYSTEM PROMPT (per tutti i 5 LLM)

```
1. ROLE      — chi sei e cosa fai
2. INPUTS    — cosa ricevi
3. RULES     — regole cinematografiche obbligatorie
4. OUTPUT    — formato JSON esatto (mai testo libero)
```

## FRAME PROMPT FORMAT (per LLM 4 → ComfyUI)

```
[CINEMATIC STYLE], [SHOT TYPE], [SUBJECT + ACTION], [ENVIRONMENT], [LIGHTING], [MOOD], [TECHNICAL]
```

**Esempio completo:**
```
cinematic anamorphic photography, medium close-up shot,
weathered detective in cream linen shirt standing motionless at canal edge hands in pockets,
rain-soaked Venice calle at dusk narrow alley with warm lamplight reflections on wet cobblestones,
single sodium streetlamp casting long dramatic shadows golden warm light,
melancholic introspective nostalgic atmosphere,
35mm film grain shallow depth of field cinematic color grading 8k
```

**Negative prompt standard:**
```
ugly, deformed, blurry, low quality, watermark, text, bad anatomy,
extra limbs, cartoon, anime, painting, digital art, CGI, artificial
```

## CHARACTER ANCHOR PATTERN

Per ogni personaggio creare un "visual anchor string" da includere in OGNI prompt:

```python
def build_character_anchor(char: CharacterDef) -> str:
    return (
        f"{char.name}: {char.description}, "
        f"wearing {char.wardrobe}, "
        f"distinctive {char.visual_anchor}"
    )

# Esempio output:
# "marco: tall italian man 35yo dark wavy hair 3-day stubble weathered face,
#  wearing cream linen shirt rolled sleeves dark navy trousers leather belt,
#  distinctive silver ring on left index finger"
```

Questo string va **sempre** nel prompt di ogni shot in cui il personaggio appare.

## MOTION PROMPT RULES (per img2video)

- Massimo 15 parole
- Descrivi MOVIMENTO CAMERA + MOVIMENTO SOGGETTO
- Non descrivere l'ambiente (è già nei frame)
- Usa verbi di movimento precisi

**Buoni esempi:**
```
"camera slowly pushes forward, protagonist turns head toward horizon"
"drone rises revealing volcanic landscape, figure walks toward cliff edge"
"handheld follows running figure through crowded market, camera shakes rhythmically"
"camera orbits clockwise, character raises arms slowly, mist swirls"
"static shot, rain intensifies, protagonist remains motionless"
```

**Cattivi esempi:**
```
"nice movement"           ← troppo vago
"beautiful cinematic shot" ← non descrive movimento
"the camera moves"        ← non specifico
```

## FIRST FRAME vs LAST FRAME

Il movimento tra first e last frame IS la clip:

```
first_frame: "detective standing at canal edge, back to camera, looking at water"
last_frame:  "detective turning slowly, face now visible, rain-soaked expression"
motion_prompt: "camera slowly circles right revealing protagonist face, rain intensifies"
```

## CONTINUITY INJECTION PATTERN

Per ogni shot successivo, inietta nel prompt di LLM 3/4:

```python
continuity_context = f"""
CONTINUITY FROM PREVIOUS SHOT ({prev_shot.shot_id}):
- Location: {prev_shot.location} - same location continues
- Lighting: {prev_shot.lighting.time_of_day} - maintain same lighting
- Characters: {prev_shot.continuity_notes}
- Camera: previous was {prev_shot.camera.shot_type} - next should be {suggested_next}
- Active motifs: {', '.join(active_motifs)}
"""
```

## AUDIO SYNC PROMPT PATTERN

Quando c'è analisi audio, aggiungi al prompt di LLM 3:

```python
def build_audio_sync_context(section: AudioSection) -> str:
    energy_map = {
        "low":    "slow static camera, minimal movement, long takes",
        "medium": "gentle movement, medium pacing, mix of shot sizes",
        "high":   "dynamic movement, faster cuts, handheld elements",
        "peak":   "rapid cuts, extreme angles, maximum energy movement",
    }
    return f"""
MUSIC SYNC for this section ({section.start_sec}s - {section.end_sec}s):
- Energy level: {section.energy} → {energy_map[section.energy]}
- Emotional tone: {section.emotion}
- BPM: {section.bpm_local or 'inherit from global'}
- Camera speed should match: {'slow' if section.energy in ['low','medium'] else 'fast'}
"""
```

## SCENE CHANGE PROMPT

Per aiutare LLM 2 a decidere quando cambiare scena:

```
SCENE CHANGE DECISION RULES:
Change scene ONLY when ONE of these occurs:
1. Lyrical meaning shifts (different theme or subject)
2. Chorus/verse/bridge begins
3. Energy level changes significantly (low→high or high→low)
4. Symbolic visual metaphor is needed
5. Time has passed (morning→evening)
6. Emotional state of protagonist changes fundamentally

Do NOT change scene just for visual variety.
Each scene change must be JUSTIFIED by the narrative or musical structure.
```
