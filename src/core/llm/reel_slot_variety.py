"""
Slot/clip variety for CreateReel fallback prompts.

This module is used when an LLM returns weak, repeated or unusable slot plans.
It must never invent a generic performer, city, wardrobe or genre. Subject,
environment and symbols are derived from the user's brief.
"""

from __future__ import annotations

import re
from typing import Any, Optional


_BEAT_ARC = [
    {
        "role": "intro",
        "emotion": "anticipation",
        "shot": "wide",
        "lens": 24,
        "movement": "slow dolly in",
        "dof": "deep",
        "subject_action": "the protagonist enters the main world, hesitant and drawn forward",
        "scene_suffix": "establishing the central environment and its recurring visual symbols",
    },
    {
        "role": "build",
        "emotion": "pressure",
        "shot": "medium_close",
        "lens": 50,
        "movement": "tracking",
        "dof": "shallow",
        "subject_action": "the protagonist moves through the world as pressure builds around them",
        "scene_suffix": "supporting figures and symbolic details begin to close in",
    },
    {
        "role": "peak",
        "emotion": "chaos",
        "shot": "close_up",
        "lens": 35,
        "movement": "handheld",
        "dof": "shallow",
        "subject_action": "the protagonist confronts the dominant threat with unstable body language",
        "scene_suffix": "the environment becomes chaotic, aggressive and rhythmically fragmented",
    },
    {
        "role": "resolution",
        "emotion": "revelation",
        "shot": "medium",
        "lens": 85,
        "movement": "slow orbit",
        "dof": "medium",
        "subject_action": "the protagonist pauses as the emotional cost becomes visible",
        "scene_suffix": "the aftermath reveals the story's central transformation",
    },
    {
        "role": "outro",
        "emotion": "transformation",
        "shot": "extreme_wide",
        "lens": 18,
        "movement": "drone_push",
        "dof": "deep",
        "subject_action": "the transformed protagonist holds the final image",
        "scene_suffix": "the final tableau resolves the main metaphor in one clear image",
    },
]

_MUSIC_KW = re.compile(
    r"\b(?:rap|hip[\s-]?hop|music\s*video|videoclip|cant(?:o|are)|performer|mc\b|beat\b|lyric)",
    re.I,
)


def is_performance_brief(brief: str) -> bool:
    return bool(_MUSIC_KW.search(brief or ""))


def _brief_is_circus_horror(brief: str) -> bool:
    return bool(
        re.search(
            r"\b(?:circo|circus|tendone|clown|acrobat|freaks?|carosello|direttore del circo)\b",
            brief or "",
            re.I,
        )
    )


def _subject_anchor_from_brief(brief: str, vision: Optional[dict] = None) -> str:
    vis = vision or {}
    anchors = (vis.get("character_anchors") or [])[:2]
    if anchors:
        return str(anchors[0])[:180]
    if _brief_is_circus_horror(brief):
        return (
            "the exhausted male protagonist in ruined elegant clothes and haunted eyes, "
            "with the thin emotionless clown, the unstable acrobatic woman, the old circus "
            "director in black top hat with cane, and disturbing freak performers"
        )
    if re.search(r"\bprotagonista|protagonist|main character|personaggio principale\b", brief or "", re.I):
        return "the protagonist described in the brief, preserving wardrobe and physical traits exactly"
    return "the central subject described in the user's brief"


def _scene_suffix_for_index(brief: str, index: int, total: int, default_suffix: str) -> str:
    if _brief_is_circus_horror(brief):
        circus_arc = [
            "abandoned circus exterior in night rain, broken sign flickering red and blue",
            "inside the decaying big top, smoke, frozen spectators and a clown turning slowly",
            "red ropes and strobing lights as the acrobatic woman descends from above",
            "dirty tables, deformed dancers, warped mirrors and violent synchronized laughter",
            "central stage under collapsing canvas, internal rain, black glitter tears and firelight",
            "final circus tableau where the protagonist becomes the new director as the crowd applauds",
        ]
        pos = round(index * (len(circus_arc) - 1) / max(total - 1, 1)) if total > 1 else 0
        return circus_arc[max(0, min(pos, len(circus_arc) - 1))]
    return default_suffix


def _action_for_index(brief: str, index: int, total: int, default_action: str) -> str:
    if _brief_is_circus_horror(brief):
        actions = [
            "the protagonist walks toward the circus entrance through rain and smoke",
            "the protagonist crosses the big top while motionless spectators stare",
            "the acrobatic woman drops on red ropes while the thin clown watches from the back",
            "freak performers break into aggressive choreography around the protagonist",
            "the protagonist sees clown makeup forming on his own face in a warped mirror",
            "the old circus director places the black top hat on the protagonist's head",
        ]
        pos = round(index * (len(actions) - 1) / max(total - 1, 1)) if total > 1 else 0
        return actions[max(0, min(pos, len(actions) - 1))]
    return default_action


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
    arc_len = len(_BEAT_ARC)
    if total <= arc_len:
        return dict(_BEAT_ARC[min(index, arc_len - 1)])
    t = index / max(total - 1, 1)
    arc_idx = int(t * (arc_len - 1))
    return dict(_BEAT_ARC[min(arc_idx, arc_len - 1)])


def build_differentiated_slot_hints(
    brief: str,
    n: int,
    *,
    vision: Optional[dict] = None,
) -> list[dict]:
    """Create distinct narrative slot hints without changing the user's story world."""
    vis = vision or {}
    anchor_snip = _subject_anchor_from_brief(brief, vis)[:180]
    base = (brief or "cinematic reel").strip()

    out: list[dict] = []
    for i in range(n):
        beat = beat_for_index(i, n)
        scene_suffix = _scene_suffix_for_index(brief, i, n, beat["scene_suffix"])
        subject_action = _action_for_index(brief, i, n, beat["subject_action"])
        hint = (
            f"{base[:180]}. Beat {i + 1}/{n} ({beat['role']}): "
            f"{scene_suffix}. Subject: {anchor_snip}. "
            f"Emotion: {beat['emotion']}. Action: {subject_action}."
        )
        out.append({
            "slot_id": f"slot_{i + 1:03d}",
            "narrative_role": beat["role"],
            "emotion": beat["emotion"],
            "visual_hint": hint[:650],
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
    """Apply varied shot language while preserving the user's subject and setting."""
    beat = beat_for_index(slot_index, slot_total)
    out = dict(plan)
    scene_suffix = _scene_suffix_for_index(brief, slot_index, slot_total, beat["scene_suffix"])
    subject_action = _action_for_index(brief, slot_index, slot_total, beat["subject_action"])

    same_hint = not base_hint or len(set((base_hint or "")[:60])) < 2
    if force_variety or same_hint or not out.get("camera_movement"):
        out["shot_type"] = beat["shot"]
        out["lens_mm"] = beat["lens"]
        out["depth_of_field"] = beat["dof"]
        out["camera_movement"] = beat["movement"]
        out["motion_intent"] = (
            f"{beat['movement']}, {subject_action}, {beat['emotion']} energy"
        )

    role = beat["role"]
    emotion = beat.get("emotion") or out.get("emotion") or "cinematic"
    hint_body = (base_hint or brief or "")[:240]
    anchor = _subject_anchor_from_brief(brief)

    shot_desc = {
        "extreme_close": "extreme close-up on face detail",
        "close_up": "close-up on face and shoulders",
        "medium_close": "medium close-up chest-up",
        "medium": "medium shot waist-up",
        "wide": "wide shot full environment",
        "extreme_wide": "extreme wide view of the story environment",
    }.get(out.get("shot_type", beat["shot"]), "medium shot")

    out["first_frame_state"] = (
        f"{shot_desc}, {anchor}, {subject_action}, opening moment - {hint_body[:140]}"
    )
    out["last_frame_state"] = (
        f"{shot_desc}, {anchor}, evolved pose after {subject_action}, "
        f"beat {role} resolution, {emotion} mood"
    )
    out["scene_description"] = (
        f"{hint_body}. {scene_suffix}. Camera: {out.get('camera_movement', beat['movement'])}."
    )[:520]
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
    """Distinct motion prompt per clip: camera + subject motion."""
    beat = beat_for_index(slot_index, slot_total)
    move = dop.get("camera_movement") or beat["movement"]
    action = _action_for_index(brief, slot_index, slot_total, beat["subject_action"])

    in_slot_variants = [
        "",
        " gestures intensify with the rhythm",
        " eyes lock on the dominant symbol",
        " body shifts forward under pressure",
    ]
    if clips_in_slot > 1 and clip_index_in_slot < len(in_slot_variants):
        action = action + in_slot_variants[clip_index_in_slot]

    parts = [move, action]
    if is_performance_brief(brief):
        parts.append("movement follows vocal phrasing and beat accents")
    parts.append("natural motion blur on background only")

    return ", ".join(p.strip() for p in parts if p.strip())[:120]


def ltx_audio_line(brief: str) -> str:
    if is_performance_brief(brief):
        return "Music drives the movement, with breath, fabric and room tone under the vocal."
    return "Ambient room tone and subtle environmental sound underscore the moment."
