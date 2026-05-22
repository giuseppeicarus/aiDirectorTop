"""
Struttura prompt reel per Z-Image / LTX: gerarchia registica, coerenza inquadratura, anti-ridondanza.
"""

from __future__ import annotations

import re
from typing import Any, Optional

# Cosa può comparire in frame per scala inquadratura (guida LLM + validazione)
_SHOT_SCALE: dict[str, dict[str, Any]] = {
    "extreme_close": {
        "label": "extreme close-up",
        "subjects": "ONE detail or face fragment only (eyes, hands, object texture)",
        "environment": "no readable room layout; only color bokeh or blur",
        "forbid": ("wide", "full body", "two people", "establishing", "entire room", "bar interior", "stage"),
    },
    "close_up": {
        "label": "close-up",
        "subjects": "ONE face or ONE subject filling most of the frame",
        "environment": "heavily blurred background hints only — no readable architecture",
        "forbid": ("medium shot of two", "full bar", "wide pub", "both characters full", "establishing"),
    },
    "close-up": {
        "label": "close-up",
        "subjects": "ONE face or ONE subject filling most of the frame",
        "environment": "heavily blurred background hints only",
        "forbid": ("medium shot of two", "full bar", "wide pub", "both characters full"),
    },
    "medium_close": {
        "label": "medium close-up",
        "subjects": "ONE primary subject chest-up; optional second subject soft in background",
        "environment": "minimal context — no full venue layout",
        "forbid": ("extreme wide", "full interior panorama", "entire pub visible"),
    },
    "medium_close-up": {
        "label": "medium close-up",
        "subjects": "ONE primary subject chest-up",
        "environment": "soft background only",
        "forbid": ("extreme wide", "full interior panorama"),
    },
    "medium": {
        "label": "medium shot",
        "subjects": "ONE primary subject in foreground; ONE secondary optional mid-ground",
        "environment": "selective environment layers — not every object in the room",
        "forbid": ("extreme close-up only", "macro texture only"),
    },
    "medium_wide": {
        "label": "medium wide shot",
        "subjects": "up to TWO subjects with clear spatial relationship",
        "environment": "location readable but not panoramic",
        "forbid": (),
    },
    "wide": {
        "label": "wide shot",
        "subjects": "subjects smaller in frame; environment shares importance",
        "environment": "full location staging allowed",
        "forbid": ("face filling frame", "macro detail"),
    },
    "extreme_wide": {
        "label": "extreme wide shot",
        "subjects": "figures small; landscape/architecture dominant",
        "environment": "full environment",
        "forbid": ("close-up", "shallow portrait"),
    },
}

_REPEATED_PHRASES = [
    re.compile(r"(\bshallow depth of field\b)(?:\s*[,;]?\s*\1)+", re.I),
    re.compile(r"(\b50\s*mm\b(?:\s+lens)?)(?:\s*[,;]?\s*\1)+", re.I),
    re.compile(r"(\bfilm grain\b)(?:\s*[,;]?\s*\1)+", re.I),
    re.compile(r"(\bhigh contrast chiaroscuro\b)(?:\s*[,;]?\s*\1)+", re.I),
    re.compile(r"(\bphotorealistic\b)(?:\s*[,;]?\s*\1)+", re.I),
    re.compile(r"(\b\d+k\b)(?:\s*[,;]?\s*\1)+", re.I),
]

_SHOT_CONFLICT_RE = re.compile(
    r"\b(?:extreme\s+)?close[- ]?up\b.*\b(?:medium\s+wide|wide\s+shot|full\s+(?:room|interior|bar)|"
    r"two\s+(?:people|characters|subjects)|establishing)\b",
    re.I | re.DOTALL,
)

_TRUNCATED_TAIL_RE = re.compile(
    r"\b(?:he|she|the\s+\w+)\s+(?:is|are|was|were|stands?|sits?)\s*,?\s*(?:\.|$)",
    re.I,
)


def normalize_shot_type(shot: Optional[str]) -> str:
    s = (shot or "medium").lower().replace("_", " ").strip()
    aliases = {
        "mcu": "medium_close",
        "cu": "close_up",
        "ecu": "extreme_close",
        "ms": "medium",
        "ws": "wide",
        "ews": "extreme_wide",
    }
    return aliases.get(s, s.replace(" ", "_").replace("-", "_"))


def shot_display_label(shot: Optional[str]) -> str:
    key = normalize_shot_type(shot).replace("-", "_")
    if key in _SHOT_SCALE:
        return str(_SHOT_SCALE[key]["label"])
    return (shot or "medium shot").replace("_", " ")


def _complete_sentence(text: str) -> str:
    t = (text or "").strip()
    if not t:
        return ""
    if _TRUNCATED_TAIL_RE.search(t):
        t = _TRUNCATED_TAIL_RE.sub("", t).strip(" ,.")
    if t.endswith(","):
        t = t.rstrip(",").strip()
    if t and t[-1] not in ".!?":
        t += "."
    return t


def _dedupe_phrases(text: str) -> str:
    t = text
    for pat in _REPEATED_PHRASES:
        t = pat.sub(r"\1", t)
    # Due shot types nella stessa frase → tieni il primo blocco camera
    types = re.findall(
        r"\b(?:extreme\s+)?(?:close[- ]?up|medium\s+close[- ]?up|medium\s+wide|wide\s+shot|medium\s+shot)\b",
        t,
        re.I,
    )
    if len(types) > 1:
        first = types[0]
        rest = re.compile(
            r"\b(?:extreme\s+)?(?:close[- ]?up|medium\s+close[- ]?up|medium\s+wide|wide\s+shot|medium\s+shot)\b",
            re.I,
        )
        count = 0

        def _keep_one(m: re.Match) -> str:
            nonlocal count
            count += 1
            return m.group(0) if count == 1 else ""

        t = rest.sub(_keep_one, t)
    t = re.sub(r"\s{2,}", " ", t)
    t = re.sub(r",\s*,", ",", t)
    t = re.sub(r"\s+,", ",", t)
    return t.strip(" ,.")


def _fix_focus_contradiction(text: str, dof: str) -> str:
    t = text
    dof_l = (dof or "").lower()
    low = t.lower()
    if "shallow" in dof_l or "shallow depth" in low:
        t = re.sub(r",?\s*sharp focus(?:\s+on\s+everything)?", "", t, flags=re.I)
        t = re.sub(r",?\s*everything\s+in\s+sharp\s+focus", "", t, flags=re.I)
        t = re.sub(r"\bsubject in\s+with\b", "subject in focus with", t, flags=re.I)
        low = t.lower()
        if "bokeh" not in low and "background blur" not in low and "soft background" not in low:
            t += ", subject in sharp focus with soft bokeh background"
    return t


def _strip_useless_tokens(text: str) -> str:
    t = re.sub(r"\b8k\b", "", text, flags=re.I)
    t = re.sub(r"\bultra[- ]?hd\b", "", t, flags=re.I)
    return t


def polish_z_image_frame_prompt(
    text: str,
    *,
    shot_type: str = "medium",
    depth_of_field: str = "shallow",
) -> str:
    """Pulisce ridondanze e contraddizioni tipiche dei prompt reel."""
    t = _strip_useless_tokens(text)
    t = _dedupe_phrases(t)
    t = _fix_focus_contradiction(t, depth_of_field)
    t = re.sub(r"\s{2,}", " ", t).strip(" ,.")
    return t


def _environment_snippet(
    *,
    shot_key: str,
    scene: str,
    hint: str,
    env_anchors: list[str],
    theme: str,
) -> str:
    raw = _join_parts([scene, hint, ", ".join(env_anchors[:2]), theme])
    if shot_key in ("extreme_close", "close_up"):
        return (
            "Background dissolves into soft amber and deep blue bokeh with no readable architecture."
        )
    if shot_key in ("medium_close", "medium_close_up"):
        return _first_sentence(raw, max_words=35) or (
            "A dim neo-noir interior with warm practical lights and deep blue shadows in soft focus behind the subject."
        )
    return _first_sentence(raw, max_words=55) or "A cinematic interior with layered depth and practical lighting."


def _first_sentence(text: str, max_words: int = 40) -> str:
    t = (text or "").strip()
    if not t:
        return ""
    sent = re.split(r"(?<=[.!?])\s+", t)[0].strip()
    words = sent.split()
    if len(words) > max_words:
        sent = " ".join(words[:max_words]) + "."
    return _complete_sentence(sent)


def _join_parts(parts: list[str], *, sep: str = " ") -> str:
    seen: set[str] = set()
    out: list[str] = []
    for p in parts:
        p = (p or "").strip()
        if not p or len(p) < 3:
            continue
        key = p.lower()[:100]
        if key in seen:
            continue
        seen.add(key)
        out.append(p)
    return sep.join(out)


def build_structured_frame_prompt(
    *,
    role: str,
    style: str,
    dop: dict,
    visual_hint: str,
    mood: str,
    vision: dict | None,
    director_narrative: dict | None,
    brief: str,
) -> str:
    """
    Prompt first/last frame in prosa strutturata (Z-Image):
    Scene → Main subject → Secondary → Action → Emotion → Camera → Lighting → Texture → Mood
    """
    dn = director_narrative or {}
    vis = vision or {}
    shot_key = normalize_shot_type(dop.get("shot_type"))
    shot_label = shot_display_label(dop.get("shot_type"))
    lens = dop.get("lens_mm") or 50
    dof = dop.get("depth_of_field") or "shallow"
    scene = (dop.get("scene_description") or visual_hint or brief or "").strip()
    hint = (visual_hint or scene).strip()
    first_state = _complete_sentence(dop.get("first_frame_state") or "")
    last_state = _complete_sentence(dop.get("last_frame_state") or "")
    motion = (dop.get("motion_intent") or "").strip()
    primary = (dop.get("primary_visual_focus") or dop.get("visual_focus") or "").strip()
    secondary = (dop.get("secondary_subject") or "").strip()
    anchors = list(vis.get("character_anchors") or [])[:2]
    env_anchors = list(vis.get("environment_anchors") or [])[:2]
    theme = (dn.get("visual_theme") or "").strip()
    emotion_beat = (dop.get("emotional_beat") or mood or dn.get("mood") or "cinematic tension").strip()
    wardrobe = (vis.get("wardrobe_notes") or "").strip()
    color_grade = (dop.get("color_grade_note") or "").strip()

    state = first_state if role == "first" else (last_state or first_state)
    if not state:
        state = _first_sentence(hint, max_words=45)

    # 1 Scene setup
    scene_block = _environment_snippet(
        shot_key=shot_key,
        scene=scene,
        hint=hint,
        env_anchors=env_anchors,
        theme=theme,
    )

    # 2 Main subject
    main_subject = primary or _first_sentence(
        _join_parts([anchors[0] if anchors else "", first_state, hint]),
        max_words=40,
    )
    if not main_subject:
        main_subject = "The primary subject holds the viewer's attention in the foreground."

    # 3 Secondary (only wider shots)
    secondary_block = ""
    if shot_key in ("medium", "medium_wide", "wide", "extreme_wide") and (secondary or (len(anchors) > 1)):
        secondary_block = secondary or (anchors[1] if len(anchors) > 1 else "")
        if secondary_block:
            secondary_block = (
                f"In the middle distance, {secondary_block.rstrip('.')}, softly separated by depth."
            )

    # 4 Action
    if role == "last" and last_state:
        action_block = last_state
    else:
        action_block = state or motion.split(",")[0]
    action_block = _complete_sentence(action_block)

    # 5 Emotion
    emotion_block = (
        f"The emotional undercurrent is {emotion_beat}: unspoken tension and narrative intent, not a posed poster."
    )

    # 6 Camera — single coherent statement
    dof_phrase = (
        "shallow depth of field isolates the subject from the background"
        if "shallow" in str(dof).lower()
        else f"{dof} depth of field"
    )
    camera_block = (
        f"The camera frames the moment as a {shot_label} on a {lens}mm lens; "
        f"{dof_phrase}."
    )

    # 7 Lighting
    lighting_raw = dop.get("lighting")
    if isinstance(lighting_raw, dict):
        lighting_block = _join_parts([
            " ".join(lighting_raw.get("sources") or []) if isinstance(lighting_raw.get("sources"), list) else "",
            str(lighting_raw.get("mood") or ""),
            str(lighting_raw.get("time_of_day") or ""),
        ])
    else:
        lighting_block = str(lighting_raw or "").strip()
    if not lighting_block:
        lighting_block = (
            "High-contrast chiaroscuro with deep blue shadows, warm amber practical highlights, "
            "and soft rim light on skin."
        )
    lighting_block = _complete_sentence(lighting_block)

    # 8 Texture / style (once)
    texture_block = _join_parts([
        style.split(",")[0].strip(),
        "subtle film grain",
        "photorealistic skin texture",
        "cinematic color grading",
        wardrobe,
        color_grade,
    ])
    texture_block = _complete_sentence(texture_block)

    # 9 Mood
    mood_block = f"Overall mood: {mood or dn.get('mood') or 'cinematic neo-noir'} — story-driven, not stock photography."

    paragraphs = [
        scene_block,
        f"The visual protagonist is clear: {main_subject.rstrip('.')}.",
        secondary_block,
        action_block,
        emotion_block,
        camera_block,
        lighting_block,
        texture_block,
        mood_block,
    ]
    text = " ".join(p for p in paragraphs if p and p.strip())
    return polish_z_image_frame_prompt(text, shot_type=shot_key, depth_of_field=str(dof))


# Regole testuali per i system prompt LLM (incollate in reel_prompts.py)
REEL_SHOT_FRAMING_RULES = """
SHOT SCALE RULES (mandatory — never violate):
- extreme_close / close_up: ONE subject or detail only; NO full room, NO bar interior, NO stage, NO two full bodies.
- medium_close: ONE primary subject chest-up; background must be bokeh only.
- medium: ONE clear visual protagonist in foreground; secondary subject only soft in mid-ground.
- wide / medium_wide: environment allowed but still name WHO is the visual protagonist.

Never combine two shot types in one prompt (e.g. "close-up" AND "medium close-up").
Never list every object in the room if the shot is a close-up.

CAMERA / FOCUS:
- If shallow depth of field: do NOT write "sharp focus on everything".
- Write: "subject in focus, background soft bokeh" once only.

PROMPT STRUCTURE (Z-Image / LTX) — use flowing English prose in this order, NOT comma keyword lists:
1. Scene setup (environment at appropriate scale)
2. Main subject (visual protagonist — who the camera cares about)
3. Secondary subject (only if shot scale allows)
4. Action / pose for this exact frame
5. Emotional intent (tension, desire, curiosity — not label "X emotion")
6. Camera (ONE shot type + lens + depth of field)
7. Lighting (once)
8. Texture / style (film grain, skin texture — no "8k")
9. Mood

FORBIDDEN: 8k, keyword stacking, duplicate phrases, truncated sentences ("she is,"), platform names, emotion labels.
"""
