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
- Output ONE flowing English paragraph, present tense, 4–8 sentences (70–130 words).
- Order: (1) shot type + subject + setting, (2) lighting + mood atmosphere,
  (3) ONE camera move + lens mm, (4) timed physical action across clip duration,
  (5) environment micro-motion, (6) final sentence starting with "Sound: " (once only).
- img2video / ltx_video_prompt: describe MOTION and CHANGES only — do NOT re-describe the static reference image.
- txt2video: you may describe the full scene in sentence 1 (no reference frame).
- img_audio2video: align Sound: with music/vocal energy from context.
- FORBIDDEN: keyword dumps, duplicate camera lines, "The scene shows...", truncated phrases,
  trailing photorealistic/8k/skin texture tags (those belong to still image prompts).
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


def _lighting_phrase(dop: dict, mood: str) -> str:
    lighting = dop.get("lighting") or {}
    if isinstance(lighting, dict):
        parts = [
            lighting.get("time_of_day") or "",
            lighting.get("mood") or "",
            ", ".join(lighting.get("sources") or []) if isinstance(lighting.get("sources"), list) else "",
        ]
        light = " ".join(p for p in parts if p).strip()
    else:
        light = str(lighting).strip()
    if not light:
        light = "warm directional key light with controlled shadows"
    mood_bit = _clean_clause(mood, 40) if mood else "cinematic intensity"
    article = "an" if mood_bit[:1].lower() in "aeiou" else "a"
    return f"The lighting is {light}, creating {article} {mood_bit} atmosphere."


def _subject_clause(dop: dict, visual_hint: str) -> str:
    """Soggetto + setting minimo (il frame statico è già nell'immagine di riferimento)."""
    raw = (
        dop.get("primary_visual_focus")
        or dop.get("first_frame_state")
        or dop.get("scene_description")
        or visual_hint
        or "the main subject"
    )
    clause = _clean_clause(str(raw), 160)
    # Evita doppio "wide shot" nel soggetto
    clause = re.sub(r"\b(?:wide|medium|close[- ]?up)\s+shot\b", "", clause, flags=re.I)
    clause = re.sub(r"\s+", " ", clause).strip(" ,.")
    setting = _clean_clause(dop.get("location") or dop.get("environment") or "", 80)
    if setting and setting.lower() not in clause.lower():
        return f"{clause} in {setting.rstrip('.')}"
    return clause


def _action_timeline(
    dop: dict,
    *,
    duration_sec: float = 5.0,
    brief: str = "",
) -> str:
    """Azione fisica con progressione temporale (LTX: cosa accade nel clip)."""
    motion = (dop.get("motion_intent") or dop.get("subject_action") or "").strip()
    if not motion:
        beat = dop.get("emotion_beat") or dop.get("narrative_role") or ""
        motion = dop.get("subject_action") or "the subject completes one clear gesture toward camera"

    motion = _clean_clause(motion, 200).rstrip(".")
    d = max(3.0, min(12.0, float(duration_sec or 5.0)))

    if d <= 4.5:
        return (
            f"Over the clip, {motion}, with deliberate pacing and visible weight shift."
        )

    t_mid = max(2, round(d * 0.45))
    t_end = max(t_mid + 1, round(d * 0.85))
    return (
        f"In the first seconds, {motion}. "
        f"Around second {t_mid}, the movement intensifies and expression sharpens. "
        f"By second {t_end}, the action reaches its held beat before settling."
    )


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
    """True se il prompt sembra già strutturato (non serve rebuild completo)."""
    if not text or _word_count(text) < 55:
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
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]
    return 4 <= len(sentences) <= 10


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
    lighting = _lighting_phrase(dop, mood_use)
    camera = _camera_sentence(
        str(dop.get("camera_movement") or "slow push-in"),
        dop.get("lens_mm") or 50,
    )
    action = _action_timeline(dop, duration_sec=duration_sec, brief=brief)
    env = _environment_motion(dop)
    audio = _audio_line(brief, mood_use)
    sentences = [
        f"{shot} of {scene}.",
        lighting,
        camera,
        action,
        env,
        audio,
    ]
    paragraph = " ".join(s.rstrip() for s in sentences if s)
    return re.sub(r"\s+", " ", paragraph).strip()[:950]


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
    lighting = _lighting_phrase(dop, mood_use)
    camera = _camera_sentence(
        str(dop.get("camera_movement") or "slow dolly in"),
        dop.get("lens_mm") or 50,
    )
    action = _action_timeline(dop, duration_sec=duration_sec, brief=brief)
    env = _environment_motion(dop)
    audio = _audio_line(brief, mood_use)

    sentences = [
        f"{shot} of {subject}.",
        lighting,
        camera,
        action,
        env,
        audio,
    ]
    paragraph = " ".join(s.rstrip() for s in sentences if s)
    paragraph = re.sub(r"\s+", " ", paragraph).strip()
    if len(paragraph) > 950:
        paragraph = paragraph[:947].rsplit(" ", 1)[0] + "."
    return paragraph


def build_ltx_video_prompt_fallback(
    dop: dict,
    *,
    style: str = "cinematic",
    slot_emotion: str = "",
    duration_sec: float = 5.0,
    brief: str = "",
) -> str:
    """Compat: delega al builder LTX 2.3."""
    return build_ltx23_video_prompt(
        dop,
        style=style,
        slot_emotion=slot_emotion,
        brief=brief,
        duration_sec=duration_sec,
        mood=slot_emotion,
    )


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
