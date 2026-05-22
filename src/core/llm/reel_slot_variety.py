"""
Varietà per slot/clip reel — evita prompt identici (stesso zoom, stessa scena).
Usato quando il regista/DP LLM fallisce o restituisce slot omogenei.
"""

from __future__ import annotations

import re
from typing import Any, Optional

# Arco tipico reel / music video (ruota su N slot)
_BEAT_ARC = [
    {
        "role": "intro",
        "emotion": "anticipation",
        "shot": "wide",
        "lens": 24,
        "movement": "slow dolly in",
        "dof": "deep",
        "subject_action": "artist walks into frame from shadow, head down then lifts chin",
        "scene_suffix": "establishing the street and neon environment before the performance",
    },
    {
        "role": "build",
        "emotion": "confidence",
        "shot": "medium_close",
        "lens": 50,
        "movement": "tracking",
        "dof": "shallow",
        "subject_action": "artist performs toward camera, subtle hand gestures and lip movement as if rapping",
        "scene_suffix": "performance energy builds, crowd bokeh behind shoulders",
    },
    {
        "role": "peak",
        "emotion": "defiance",
        "shot": "close_up",
        "lens": 35,
        "movement": "handheld",
        "dof": "shallow",
        "subject_action": "intense eye contact, jaw set, quick head turn and micro-expressions",
        "scene_suffix": "peak attitude, sweat sheen, harsh rim light on face",
    },
    {
        "role": "resolution",
        "emotion": "release",
        "shot": "medium",
        "lens": 85,
        "movement": "slow orbit",
        "dof": "medium",
        "subject_action": "artist exhales, shoulders drop, slow turn away from camera",
        "scene_suffix": "aftermath on the street, breath visible in cold air",
    },
    {
        "role": "outro",
        "emotion": "nostalgia",
        "shot": "extreme_wide",
        "lens": 18,
        "movement": "drone_push",
        "dof": "deep",
        "subject_action": "figure recedes into distance along wet pavement",
        "scene_suffix": "city swallows the silhouette, lights streak",
    },
]

_MUSIC_KW = re.compile(
    r"\b(?:rap|hip[\s-]?hop|music\s*video|videoclip|cant(?:o|are)|performer|mc\b|beat\b|lyric)",
    re.I,
)


def is_performance_brief(brief: str) -> bool:
    return bool(_MUSIC_KW.search(brief or ""))


def _hints_too_similar(slots: list[dict]) -> bool:
    hints = [(s.get("visual_hint") or "").strip().lower()[:80] for s in slots]
    if len(hints) < 2:
        return False
    return len(set(hints)) <= 1


def beat_for_index(index: int, total: int) -> dict[str, Any]:
    if total <= 0:
        total = 1
    if total == 1:
        return dict(_BEAT_ARC[1])
    # Mappa indice su arco: intro → build → peak → resolution
    arc_len = len(_BEAT_ARC)
    if total <= arc_len:
        return dict(_BEAT_ARC[min(index, arc_len - 1)])
    # Più slot del template: interpola ruoli
    t = index / max(total - 1, 1)
    arc_idx = int(t * (arc_len - 1))
    return dict(_BEAT_ARC[min(arc_idx, arc_len - 1)])


def build_differentiated_slot_hints(
    brief: str,
    n: int,
    *,
    vision: Optional[dict] = None,
) -> list[dict]:
    """Slot narrativi distinti quando il regista LLM non differenzia."""
    vis = vision or {}
    anchors = (vis.get("character_anchors") or [])[:2]
    anchor_snip = (anchors[0] if anchors else "the artist")[:120]
    base = (brief or "cinematic reel").strip()

    out: list[dict] = []
    for i in range(n):
        beat = beat_for_index(i, n)
        hint = (
            f"{base[:180]}. Beat {i + 1}/{n} ({beat['role']}): "
            f"{beat['scene_suffix']}. Subject: {anchor_snip}. "
            f"Emotion: {beat['emotion']}. Action: {beat['subject_action']}."
        )
        out.append({
            "slot_id": f"slot_{i + 1:03d}",
            "narrative_role": beat["role"],
            "emotion": beat["emotion"],
            "visual_hint": hint[:450],
            "duration_weight": 1.2 if beat["role"] in ("peak", "build") else 1.0,
            "energy": "high" if beat["role"] in ("peak", "build") else "medium",
        })
    return out


def enrich_visual_plan_for_slot(
    plan: dict,
    *,
    slot_index: int,
    slot_total: int,
    brief: str,
    base_hint: str,
    force_variety: bool = False,
) -> dict:
    """Applica inquadratura/movimento/azione distinti al piano DP."""
    beat = beat_for_index(slot_index, slot_total)
    out = dict(plan)

    same_hint = not base_hint or len(set((base_hint or "")[:60])) < 2
    if force_variety or same_hint or not out.get("camera_movement"):
        out["shot_type"] = beat["shot"]
        out["lens_mm"] = beat["lens"]
        out["depth_of_field"] = beat["dof"]
        out["camera_movement"] = beat["movement"]
        out["motion_intent"] = (
            f"{beat['movement']}, {beat['subject_action']}, {beat['emotion']} energy"
        )

    role = beat["role"]
    emotion = beat.get("emotion") or out.get("emotion") or "cinematic"
    hint_body = (base_hint or brief or "")[:200]
    anchor = "the primary subject"
    if "artist" in hint_body.lower() or is_performance_brief(brief):
        anchor = "the rap artist in leather jacket and chains"

    _shot_desc = {
        "extreme_close": "extreme close-up on face detail",
        "close_up": "close-up on face and shoulders",
        "medium_close": "medium close-up chest-up",
        "medium": "medium shot waist-up",
        "wide": "wide shot full environment",
        "extreme_wide": "extreme wide urban panorama",
    }.get(out.get("shot_type", beat["shot"]), "medium shot")

    out["first_frame_state"] = (
        f"{_shot_desc}, {anchor}, {beat['subject_action']}, opening moment — {hint_body[:120]}"
    )
    out["last_frame_state"] = (
        f"{_shot_desc}, {anchor}, evolved pose after {beat['subject_action']}, "
        f"beat {role} resolution, {emotion} mood"
    )
    out["scene_description"] = (
        f"{hint_body[:200]}. {beat['scene_suffix']}. "
        f"Camera: {out.get('camera_movement', beat['movement'])}."
    )[:400]
    out["primary_visual_focus"] = f"{anchor} as visual protagonist, {emotion} expression"
    out["emotional_beat"] = emotion
    return out


def motion_for_clip(
    *,
    dop: dict,
    slot_index: int,
    slot_total: int,
    clip_index_in_slot: int = 0,
    clips_in_slot: int = 1,
    brief: str = "",
) -> str:
    """Motion prompt distinto per clip (camera + soggetto, no solo zoom)."""
    beat = beat_for_index(slot_index, slot_total)
    move = dop.get("camera_movement") or beat["movement"]
    action = beat["subject_action"]

    _in_slot_variants = [
        "",
        " hands emphasize rhythm, ",
        " eyes lock on lens, ",
        " body shifts weight forward, ",
    ]
    if clips_in_slot > 1 and clip_index_in_slot < len(_in_slot_variants):
        action = action + _in_slot_variants[clip_index_in_slot]

    parts = [move, action]
    if is_performance_brief(brief):
        parts.append("lip sync energy, subtle head bob to beat")
    parts.append("natural motion blur on background only")

    return ", ".join(p.strip() for p in parts if p.strip())[:120]


def ltx_audio_line(brief: str) -> str:
    if is_performance_brief(brief):
        return (
            "Muted trap beat under the scene, distant city hum, "
            "breath and fabric rustle on the vocal performance."
        )
    return "Ambient city sound and subtle room tone underscore the moment."
