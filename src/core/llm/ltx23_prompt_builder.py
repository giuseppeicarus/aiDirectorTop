"""
LTX 2.3 img2video prompt builder — struttura allineata a:
- https://ltx.io/model/model-blog/ltx-2-3-prompt-guide
- https://ltx23.github.io/ltx-2-3-prompt-template/
- https://ltx23.github.io/ltx-2-3-prompt-examples/

Formato: un paragrafo fluido, presente, 4–8 frasi.
Ordine: inquadratura/soggetto → luce/atmosfera → camera → azione nel tempo → micro-movimento ambiente → Sound:
Per img2video: descrivere solo ciò che CAMBIA rispetto al frame di partenza (no still ridondante).
"""

from __future__ import annotations

import re
from typing import Any, Optional

# Contesti UI / pipeline che usano paragrafo LTX 2.3 completo
LTX23_FULL_PARAGRAPH_CONTEXTS = frozenset({
    "ltx_video_prompt",
    "txt2video",
    "txt2video_lastframe",
    "img2video",
    "img2video_lastframe",
    "img_audio2video",
    "img2video_audio",
})

LTX23_IMG2VIDEO_CONTEXTS = frozenset({
    "ltx_video_prompt",
    "img2video",
    "img2video_lastframe",
    "img_audio2video",
    "img2video_audio",
})

LTX23_ENHANCE_SYSTEM_BLOCK = """
LTX 2.3 VIDEO PROMPT RULES (mandatory for enhanced output):

KEY PRINCIPLE — SPECIFICITY WINS: LTX 2.3 handles complex, detailed prompts better than simple ones.
Do NOT simplify. Spatial positions, material textures, multiple overlapping actions — all improve output.
VERBS DRIVE MOVEMENT: static-sounding descriptions produce frozen frames. Every prompt needs ≥2 subject verbs.

- Output ONE flowing English paragraph, present tense, 5–9 sentences (120–200 words).
- Order: (1) shot type + FULL subject description + spatial position (LEFT/RIGHT/foreground/background) + setting,
  (2) lighting: quality, direction, color temperature, mood atmosphere,
  (3) ONE camera move verb + lens mm + direction (dolly FORWARD/BACKWARD, track LEFT/RIGHT, orbit),
  (4) VERB-DRIVEN temporal action: WHO moves + WHAT body part + HOW (raises hand, turns head, steps forward).
     Use second-by-second beats for img2video: "1s [verb action], 2s [next verb]..."
     Include ≥2 distinct physical verbs. Camera verb must differ from subject verb.
  (5) Material/texture in motion: fabric ripple, hair strands catching light, rain on glass, surface detail,
  (6) ONE environment micro-motion (haze, flicker, crowd blur, smoke drift),
  (7) [9:16 portrait only] compose top-to-bottom, subject centered vertically,
  (8) Final sentence MUST start with "Sound: " — describe ambient tone, intensity, and audio quality specifically
      (NOT "ambient sound" but "low café hum, ceramic clinking, muffled rain against glass").

SPATIAL DIRECTION (mandatory):
- Name WHERE subjects stand: "to the LEFT of frame", "centered", "in the far RIGHT background"
- Name facing direction: "facing camera", "turned away", "facing subject B on her right"
- Name distances: "two steps apart", "half-meter gap", "three meters behind"

FORBIDDEN: keyword dumps, duplicate camera lines, "The scene shows...", truncated phrases,
trailing photorealistic/8k/skin texture tags, bare emotion labels, static descriptions with no action verbs.
Return the improved text as the single string in JSON field "enhanced".
"""

# Frasi da enrich legacy da rimuovere in normalizzazione
_LTX_JUNK_PATTERNS = [
    r"The scene shows[^.]*\.",
    r"with every surface and object clearly visible\.?",
    r"The subject remains consistent:[^.]*\.",
    r"The environment includes[^.]*\.",
    r"Recurring visual elements:[^.]*\.",
    r"photorealistic cinematic realism[^.]*\.",
    r"natural skin texture\.?",
    r"cinematic aesthetic\.?",
    r"Ambient (?:city sound|sound)[^.]*\.",
    r"subtle room tone[^.]*\.",
]

_CAMERA_VERBS = {
    "dolly_in": "The camera slowly dollies forward",
    "dolly_out": "The camera slowly pulls back",
    "dolly_forward": "The camera slowly dollies forward",
    "pan": "The camera pans smoothly across the scene",
    "orbit": "The camera arcs in a slow orbit around the subject",
    "handheld": "A handheld camera tracks the subject with subtle shake",
    "tracking": "The camera tracks alongside the subject",
    "floating": "The camera drifts gently forward",
    "drone_push": "The camera pushes forward from a high angle",
    "static": "The camera holds steady",
    "tilt": "The camera tilts upward slowly",
    "slow_dolly_in": "The camera slowly dollies forward",
    "slow_pullback": "The camera slowly pulls back",
    "slow_pan": "The camera pans slowly",
}

_SHOT_LABELS = {
    "extreme_wide": "extreme wide shot",
    "wide": "wide shot",
    "medium_wide": "medium wide shot",
    "medium": "medium shot",
    "medium_close": "medium close-up",
    "medium_close_up": "medium close-up",
    "close_up": "close-up",
    "extreme_close": "extreme close-up",
    "over_shoulder": "over-the-shoulder shot",
    "pov": "POV shot",
}


def _word_count(text: str) -> int:
    return len(re.findall(r"\b\w+\b", text or ""))


def _clean_clause(text: str, max_len: int = 220) -> str:
    t = re.sub(r"\s+", " ", (text or "").strip())
    t = re.sub(r"^(?:cinematic|photorealistic|8k|wide shot|medium shot)\s*,?\s*", "", t, flags=re.I)
    if len(t) > max_len:
        cut = t[:max_len].rsplit(" ", 1)[0]
        t = cut.rstrip(",.;") + "."
    return t.rstrip(".,; ")


def _shot_phrase(shot_type: str) -> str:
    key = (shot_type or "medium").lower().replace(" ", "_").replace("-", "_")
    label = _SHOT_LABELS.get(key, key.replace("_", " "))
    if not label.endswith("shot") and "close" not in label and "pov" not in label:
        label = f"{label} shot"
    return f"A {label}"


def _camera_sentence(movement: str, lens_mm: int | str) -> str:
    move_raw = (movement or "slowly pushes forward").lower().replace(" ", "_")
    sentence = _CAMERA_VERBS.get(move_raw)
    if not sentence:
        for key, sent in _CAMERA_VERBS.items():
            if key in move_raw or key.replace("_", " ") in movement.lower():
                sentence = sent
                break
    if not sentence:
        sentence = f"The camera {movement}"
    lens = int(lens_mm) if str(lens_mm).isdigit() else 50
    return f"{sentence} on a {lens}mm lens."


def _lighting_phrase(dop: dict, mood: str, *, brief: str = "") -> str:
    # Always check environment first — override any fallback "warm directional" with physically accurate lighting
    _env_ctx = (
        (dop.get("scene_description") or "")
        + " " + (dop.get("first_frame_state") or "")
        + " " + (brief or "")
    ).lower()
    _polar = any(k in _env_ctx for k in (
        "antarc", "antart", "arctic", "polar", "penguin", "pinguino", "ghiaccio",
        "ice ", "tundra", "neve ", "glacier", "ghiacciaio", "blizzard", "iceberg",
        "permafrost", "aurora austral", "aurora boreal",
    ))
    _desert = any(k in _env_ctx for k in ("desert", "sahara", "dune", "arid", "scorching"))
    _forest = any(k in _env_ctx for k in ("forest", "jungle", "bosco", "foresta", "canopy"))
    _night = any(k in _env_ctx for k in ("night", "notte", "nuit", "noche", "dark street", "neon", "moonlight"))

    if _polar:
        light = "pale blue-white overcast diffused polar light, flat horizon glow, no warm tones, zero directional shadows"
    elif _desert:
        light = "harsh golden directional sunlight, hard cast shadows, bleached high-contrast sky"
    elif _forest:
        light = "soft dappled green-filtered light filtering through the canopy, low contrast, diffused"
    elif _night:
        light = "deep blue ambient night with scattered practical light sources, high contrast"
    else:
        lighting = dop.get("lighting") or {}
        if isinstance(lighting, dict):
            parts = [
                lighting.get("time_of_day") or "",
                lighting.get("mood") or "",
                ", ".join(
                    s if isinstance(s, str) else next((v for v in s.values() if isinstance(v, str)), str(s))
                    for s in (lighting.get("sources") or []) if s
                ) if isinstance(lighting.get("sources"), list) else "",
            ]
            light = " ".join(p for p in parts if p).strip()
        else:
            light = str(lighting).strip()

    if not light:
        # Derive physically accurate lighting from environment cues in scene_description or brief
        _scene_ctx = (
            (dop.get("scene_description") or "")
            + " " + (dop.get("first_frame_state") or "")
            + " " + (brief or "")
        ).lower()
        _polar = any(k in _scene_ctx for k in (
            "antarc", "antart", "arctic", "polar", "penguin", "pinguino", "ghiaccio",
            "ice ", "tundra", "snow", "neve ", "glacier", "ghiacciaio", "blizzard",
            "permafrost", "aurora austral", "aurora boreal",
        ))
        _desert = any(k in _scene_ctx for k in (
            "desert", "sahara", "dune", "arid", "scorching", "bleached",
        ))
        _forest = any(k in _scene_ctx for k in (
            "forest", "jungle", "bosco", "foresta", "jungle", "canopy", "undergrowth",
        ))
        _night = any(k in _scene_ctx for k in (
            "night", "notte", "nuit", "noche", "dark street", "neon", "moonlight",
        ))
        if _polar:
            light = "pale blue-white overcast diffused polar light, flat horizon glow, no warm tones, zero directional shadows"
        elif _desert:
            light = "harsh golden directional sunlight, hard cast shadows, bleached high-contrast sky"
        elif _forest:
            light = "soft dappled green-filtered light filtering through the canopy, low contrast, diffused"
        elif _night:
            light = "deep blue ambient night with scattered practical light sources, high contrast"
        else:
            light = "soft directional key light with controlled shadows, cinematic exposure"
    mood_bit = _clean_clause(mood, 40) if mood else "cinematic intensity"
    article = "an" if mood_bit[:1].lower() in "aeiou" else "a"
    return f"The lighting is {light}, creating {article} {mood_bit} atmosphere."


def _subject_clause(dop: dict, visual_hint: str) -> str:
    """Soggetto + setting + spatial position (img2video: il frame statico è già nell'immagine)."""
    raw = (
        dop.get("primary_visual_focus")
        or dop.get("first_frame_state")
        or dop.get("scene_description")
        or visual_hint
        or "the main subject"
    )
    clause = _clean_clause(str(raw), 200)
    # Remove stray shot type labels from subject clause
    clause = re.sub(r"\b(?:wide|medium|close[- ]?up)\s+shot\b", "", clause, flags=re.I)
    clause = re.sub(r"\s+", " ", clause).strip(" ,.")
    setting = _clean_clause(dop.get("location") or dop.get("environment") or "", 100)
    # Add spatial position if not already present
    comp = (dop.get("composition") or "").lower()
    if comp and not any(k in clause.lower() for k in ("left", "right", "center", "background", "foreground")):
        # Extract any spatial token from composition field
        for token in ("left", "right", "center", "foreground", "background", "centered"):
            if token in comp:
                clause = clause.rstrip(".") + f", positioned {token} of frame"
                break
    if setting and setting.lower() not in clause.lower():
        return f"{clause} in {setting.rstrip('.')}"
    return clause


def _generate_second_beats(description: str, duration_sec: float) -> str:
    """
    Genera beat temporali secondo-per-secondo da una descrizione utente.
    Format: "1s action, 2s action, Ns action."
    """
    d = max(2, min(15, round(duration_sec)))
    # Split the description into meaningful fragments to map to seconds
    # Remove common filler patterns
    desc = re.sub(r"\s+", " ", description.strip().lower())
    # Extract action fragments: split on common conjunctions / punctuation
    fragments = re.split(r"[,;]|\s+(?:then|and then|after|next|finally|while|as|when)\s+", desc)
    fragments = [f.strip().strip(".,;") for f in fragments if f.strip() and len(f.strip()) > 3]

    if not fragments:
        fragments = [desc] if desc else ["movement occurs"]

    beats: list[str] = []
    for sec in range(1, d + 1):
        # Map each second to a fragment (cycle if fewer fragments than seconds)
        frag = fragments[(sec - 1) % len(fragments)]
        # Capitalize first word
        frag = frag[:1].upper() + frag[1:] if frag else ""
        beats.append(f"{sec}s {frag}")

    return ", ".join(beats) + "."


def _action_timeline(
    dop: dict,
    *,
    duration_sec: float = 5.0,
    brief: str = "",
) -> str:
    """Azione fisica verb-driven con progressione temporale.
    LTX 2.3: movement driven by verbs — WHO moves, WHAT body part, HOW.
    """
    motion = (dop.get("motion_intent") or dop.get("subject_action") or "").strip()
    if not motion and brief:
        motion = brief.strip()
    if not motion:
        # Fallback: generate a minimal verb-driven action from scene context
        subject_hint = dop.get("primary_visual_focus") or dop.get("scene_description") or "the subject"
        motion = f"{subject_hint[:80]} turns their head, shifts their weight, and glances toward camera"

    motion = _clean_clause(motion, 350).rstrip(".")
    d = max(3.0, min(15.0, float(duration_sec or 5.0)))

    # Short clips: compact but still verb-driven
    if d <= 3.5:
        # Ensure the sentence has at least one strong verb
        if not re.search(r"\b(?:raises|turns|steps|lifts|leans|reaches|looks|glances|"
                         r"exhales|smiles|tilts|shifts|moves|extends|rotates)\b", motion.lower()):
            motion = motion.rstrip(".") + ", turns slightly and exhales"
        return f"Over the clip, {motion}, with deliberate pacing."

    # Full second-by-second beats for longer clips
    return _generate_second_beats(motion, d)


def _texture_phrase(dop: dict) -> str:
    """LTX 2.3: material/texture details in motion improve sharpness and definition."""
    notes = (dop.get("texture_notes") or "").strip()
    if notes:
        return _clean_clause(notes, 120).rstrip(".") + "."
    # Derive from shot scale and scene description
    shot = (dop.get("shot_type") or "medium").lower()
    scene = (dop.get("scene_description") or dop.get("first_frame_state") or "").lower()
    hints = []
    if any(k in scene for k in ("rain", "wet", "glass")):
        hints.append("rain streaks on the glass surface catch the light")
    if any(k in scene for k in ("hair", "strand", "curl")):
        hints.append("fine hair strands drift in the ambient air current")
    if any(k in scene for k in ("fabric", "coat", "shirt", "jacket", "linen", "wool", "silk")):
        hints.append("fabric folds shift with each movement")
    if any(k in scene for k in ("smoke", "haze", "mist", "fog")):
        hints.append("haze drifts in soft layers through the light beam")
    if "extreme_close" in shot or "close_up" in shot:
        hints.append("skin texture and individual facial features resolve in sharp detail")
    if not hints:
        hints.append("surface materials and edge details stay crisp as the subject moves")
    return hints[0] + "."


def _environment_motion(dop: dict) -> str:
    env = (dop.get("environment_motion") or "").strip()
    if env:
        return _clean_clause(env, 120).rstrip(".") + "."
    hints = [
        "background haze drifts subtly",
        "practical lights flicker softly",
        "distant movement stays soft in the depth of field",
    ]
    return hints[hash(dop.get("shot_type", "")) % len(hints)] + "."


def _audio_line(brief: str, mood: str) -> str:
    try:
        from src.core.llm.reel_slot_variety import ltx_audio_line

        line = ltx_audio_line(brief)
    except ImportError:
        line = "ambient room tone and low urban atmosphere"
    line = re.sub(r"^Sound:\s*", "", line, flags=re.I).strip()
    if not line:
        line = f"subtle ambience matching the {mood or 'cinematic'} mood"
    return f"Sound: {line.rstrip('.')}."


def normalize_ltx23_prompt(text: str) -> str:
    """Ripulisce prompt LTX da concatenazioni legacy e duplicati."""
    if not text:
        return ""
    t = re.sub(r"\s+", " ", text).strip()
    for pat in _LTX_JUNK_PATTERNS:
        t = re.sub(pat, " ", t, flags=re.I)
    # Un solo blocco Sound:
    sounds = re.findall(r"Sound:\s*[^.]+(?:\.|$)", t, flags=re.I)
    t = re.sub(r"Sound:\s*[^.]+(?:\.|$)", " ", t, flags=re.I)
    if sounds:
        t = t.strip() + " " + sounds[-1].strip()
    # Rimuovi ripetizioni camera consecutive
    t = re.sub(
        r"(The camera[^.]*\.)\s*(The camera[^.]*\.)",
        r"\1",
        t,
        flags=re.I,
    )
    t = re.sub(r"\s+", " ", t).strip()
    if t and not t.endswith("."):
        t += "."
    return t


def is_ltx_prompt_well_formed(text: str) -> bool:
    """True se il prompt sembra già strutturato (non serve rebuild completo).
    Threshold raised to 80 words — LTX 2.3 rewards specificity, short prompts are underdirected.
    """
    if not text or _word_count(text) < 80:
        return False
    low = text.lower()
    if "the scene shows" in low or "every surface and object" in low:
        return False
    if low.count("the camera") > 2:
        return False
    if low.count("sound:") > 1 or (low.count("ambient") > 2 and "sound:" not in low):
        return False
    if re.search(r"establishing the s\b", low):
        return False
    # Reject prompts with no action verbs (static)
    action_verbs = re.findall(r"\b(?:raises|turns|steps|walks|lifts|drifts|leans|reaches|"
                               r"looks|glances|exhales|smiles|gestures|tilts|shifts|opens|"
                               r"closes|extends|moves|rotates|approaches|retreats)\b", low)
    if len(action_verbs) < 1:
        return False
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]
    return 4 <= len(sentences) <= 12


def project_context_to_dop(ctx: Optional[dict[str, Any]]) -> dict:
    """Mappa contesto enhance/progetto → pseudo piano DP per refine LTX."""
    c = ctx or {}
    return {
        "shot_type": c.get("shot_type") or "medium",
        "camera_movement": c.get("camera_movement") or c.get("camera") or "slow dolly in",
        "lens_mm": c.get("lens_mm") or 50,
        "duration_sec": float(c.get("duration_sec") or c.get("clip_duration_sec") or 5.0),
        "first_frame_state": c.get("scene_description") or c.get("description") or c.get("brief") or "",
        "motion_intent": c.get("motion_intent") or c.get("motion_prompt") or "",
        "scene_description": c.get("scene_description") or "",
        "location": c.get("location") or "",
        "lighting": c.get("lighting") if isinstance(c.get("lighting"), dict) else {"mood": str(c.get("lighting") or "")},
        "emotion": c.get("emotion") or c.get("energy") or "",
    }


def build_ltx23_txt2video_prompt(
    dop: dict,
    *,
    style: str = "cinematic",
    mood: str = "",
    visual_hint: str = "",
    brief: str = "",
    duration_sec: float = 6.0,
    slot_emotion: str = "",
) -> str:
    """txt2video: scena completa (nessun frame di riferimento)."""
    mood_use = mood or slot_emotion or (dop.get("emotion") or "cinematic")
    shot = _shot_phrase(str(dop.get("shot_type") or "medium"))
    scene = _clean_clause(
        visual_hint or dop.get("scene_description") or dop.get("first_frame_state") or brief,
        280,
    )
    lighting = _lighting_phrase(dop, mood_use, brief=brief)
    camera = _camera_sentence(
        str(dop.get("camera_movement") or "slow push-in"),
        dop.get("lens_mm") or 50,
    )
    action = _action_timeline(dop, duration_sec=duration_sec, brief=brief)
    env = _environment_motion(dop)
    audio = _audio_line(brief, mood_use)
    texture = _texture_phrase(dop)
    sentences = [
        f"{shot} of {scene}.",
        lighting,
        camera,
        action,
        texture,
        env,
        audio,
    ]
    paragraph = " ".join(s.rstrip() for s in sentences if s)
    return re.sub(r"\s+", " ", paragraph).strip()[:1200]


def build_ltx23_video_prompt(
    dop: dict,
    *,
    style: str = "cinematic",
    mood: str = "",
    visual_hint: str = "",
    brief: str = "",
    duration_sec: float = 5.0,
    slot_emotion: str = "",
    mode: str = "img2video",
) -> str:
    """
    Costruisce un paragrafo LTX 2.3 conforme (4–8 frasi, presente).
    mode: img2video | img_audio2video | txt2video
    """
    if mode == "txt2video":
        return build_ltx23_txt2video_prompt(
            dop,
            style=style,
            mood=mood,
            visual_hint=visual_hint,
            brief=brief,
            duration_sec=duration_sec,
            slot_emotion=slot_emotion,
        )
    mood_use = mood or slot_emotion or (dop.get("emotion") or "intense")
    shot = _shot_phrase(str(dop.get("shot_type") or "medium"))
    subject = _subject_clause(dop, visual_hint)
    lighting = _lighting_phrase(dop, mood_use, brief=brief)
    camera = _camera_sentence(
        str(dop.get("camera_movement") or "slow dolly in"),
        dop.get("lens_mm") or 50,
    )
    action = _action_timeline(dop, duration_sec=duration_sec, brief=brief)
    env = _environment_motion(dop)
    audio = _audio_line(brief, mood_use)

    texture = _texture_phrase(dop)
    sentences = [
        f"{shot} of {subject}.",
        lighting,
        camera,
        action,
        texture,
        env,
        audio,
    ]
    paragraph = " ".join(s.rstrip() for s in sentences if s)
    paragraph = re.sub(r"\s+", " ", paragraph).strip()
    if len(paragraph) > 1200:
        paragraph = paragraph[:1197].rsplit(" ", 1)[0] + "."
    return paragraph


def build_ltx_video_prompt_fallback(
    dop: dict,
    *,
    style: str = "cinematic",
    slot_emotion: str = "",
    duration_sec: float = 5.0,
    brief: str = "",
) -> str:
    """
    Generate a flowing prose LTX 2.3 video prompt.

    Format (as per LTX 2.3 guide):
    "Camera [movement] as [subject] [physical_action]. [Environment detail].
     [Lighting]. [Secondary motion]. Sound: [ambient]."

    Example for Antarctic scene:
    "Wide angle camera dollies forward slowly as a young woman in an orange jacket
     walks across blue-white Antarctic ice. Emperor penguins stand motionless on the
     right side of frame. Cold polar diffused light, pale blue-white with no warm tones,
     flat horizon glow. Fine snow powder drifts from the ice surface in the wind.
     Sound: polar wind, distant ice creaking, muffled footsteps on compressed snow."
    """
    shot_type = str(dop.get("shot_type") or "medium")
    movement = str(dop.get("camera_movement") or "slow dolly in")
    lens = dop.get("lens_mm") or 50
    mood_use = slot_emotion or (dop.get("emotion") or "cinematic")

    # Subject: prefer primary_visual_focus → scene_description → brief
    subject_raw = (
        dop.get("primary_visual_focus")
        or dop.get("first_frame_state")
        or dop.get("scene_description")
        or brief
        or "the primary subject"
    )
    subject_clause = _clean_clause(str(subject_raw), 200)
    # Strip stray shot type labels
    subject_clause = re.sub(r"(?:wide|medium|close[- ]?up)\s+shot", "", subject_clause, flags=re.I)
    subject_clause = re.sub(r"\s+", " ", subject_clause).strip(" ,.")

    # Physical action — extract from motion_intent or dop
    motion_raw = (dop.get("motion_intent") or dop.get("subject_action") or "").strip()
    if not motion_raw:
        # Build a minimal physical action
        _env = (dop.get("scene_description") or brief or "").lower()
        if any(k in _env for k in ("walk", "cammin", "step")):
            motion_raw = "walks forward across the terrain"
        elif any(k in _env for k in ("stand", "rest", "still")):
            motion_raw = "stands still, then slowly turns their head"
        else:
            motion_raw = "moves through the scene, pausing to look around"

    # Camera movement sentence
    camera_verb = _CAMERA_VERBS.get(
        movement.lower().replace(" ", "_"),
        f"The camera {movement}"
    )
    camera_sentence = f"{camera_verb} on a {lens}mm lens."

    # Environment detail from scene_description or brief
    env_ctx = (dop.get("scene_description") or brief or "").strip()
    env_clause = _clean_clause(env_ctx, 160) if env_ctx else "in a cinematic environment"
    env_clause = re.sub(r"\s+", " ", env_clause).strip(" ,.")

    # Lighting
    lighting = _lighting_phrase(dop, mood_use, brief=brief)

    # Secondary motion (environment micro-motion)
    env_motion = _environment_motion(dop)

    # Texture
    texture = _texture_phrase(dop)

    # Audio
    audio = _audio_line(brief, mood_use)

    # Assemble flowing prose
    shot_label = _SHOT_LABELS.get(
        shot_type.lower().replace(" ", "_").replace("-", "_"),
        shot_type.replace("_", " ")
    )
    # Avoid "wide shot shot:" duplication — _SHOT_LABELS values already include "shot"
    shot_intro = shot_label.capitalize() if shot_label.endswith("shot") else f"{shot_label.capitalize()} shot"
    sentences = [
        f"{shot_intro}: {camera_verb.lower()} as {subject_clause} {motion_raw}.",
        f"{env_clause}.",
        lighting,
        texture,
        env_motion,
        audio,
    ]
    paragraph = " ".join(s.rstrip() for s in sentences if s and s.strip())
    paragraph = re.sub(r"\s+", " ", paragraph).strip()
    if len(paragraph) > 1200:
        paragraph = paragraph[:1197].rsplit(" ", 1)[0] + "."
    return paragraph


def refine_ltx23_video_prompt(
    existing: str,
    dop: dict,
    *,
    style: str = "cinematic",
    mood: str = "",
    visual_hint: str = "",
    brief: str = "",
    duration_sec: float = 5.0,
    slot_emotion: str = "",
    mode: str = "img2video",
) -> str:
    """
    Usa output LLM se ben formato; altrimenti ricostruisce con template LTX 2.3.
    """
    cleaned = normalize_ltx23_prompt(existing or "")
    if is_ltx_prompt_well_formed(cleaned):
        if "sound:" not in cleaned.lower():
            cleaned = cleaned.rstrip(".") + " " + _audio_line(brief, mood or slot_emotion)
        return cleaned
    return build_ltx23_video_prompt(
        dop,
        style=style,
        mood=mood,
        visual_hint=visual_hint,
        brief=brief,
        duration_sec=duration_sec,
        slot_emotion=slot_emotion,
        mode=mode,
    )


def enhance_apply_ltx23_postprocess(
    enhanced_text: str,
    context_key: str,
    *,
    project_context: Optional[dict[str, Any]] = None,
) -> str:
    """Post-process output Migliora per contesti video LTX 2.3."""
    if context_key not in LTX23_FULL_PARAGRAPH_CONTEXTS:
        return enhanced_text
    ctx = project_context or {}
    dop = project_context_to_dop(ctx)
    mode = "txt2video"
    if context_key in LTX23_IMG2VIDEO_CONTEXTS:
        mode = "img_audio2video" if "audio" in context_key else "img2video"
    return refine_ltx23_video_prompt(
        enhanced_text,
        dop,
        style=str(ctx.get("style") or "cinematic"),
        visual_hint=str(ctx.get("scene_description") or ctx.get("description") or ctx.get("brief") or ""),
        brief=str(ctx.get("brief") or ctx.get("description") or ""),
        duration_sec=float(dop.get("duration_sec") or 5.0),
        mood=str(ctx.get("emotion") or ctx.get("energy") or ""),
        mode=mode,
    )
