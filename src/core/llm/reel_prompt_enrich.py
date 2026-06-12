"""
Arricchisce prompt reel (txt2img + LTX) con soggetti, oggetti, ambiente e coerenza narrativa.
Usato dopo sanitize_trailer_clip_prompts quando l'LLM restituisce output scarni.
"""

from __future__ import annotations

import re
from typing import Any

from src.core.llm.generation_prompt_sanitize import (
    CINEMATIC_NEGATIVE_PROMPT,
    build_ltx_video_prompt_fallback,
    ensure_detailed_frame_prompt,
    finalize_positive_prompt,
    sanitize_generation_prompt,
    sanitize_motion_prompt,
    sanitize_trailer_clip_prompts,
)
from src.core.llm.reel_prompt_structure import (
    build_structured_frame_prompt,
    polish_z_image_frame_prompt,
)

_EMOTION_LABEL_RE = re.compile(
    r",?\s*\b(?:assertiveness|nostalgia|euphoria|tension|melancholy|joy|fear|anger|"
    r"romance|mystery|cinematic)\s+emotion\b",
    re.IGNORECASE,
)
_PLATFORM_LEAK_RE = re.compile(
    r",?\s*\b(?:instagram|tiktok|youtube|facebook|reels?|adv(?:ertisement)?|"
    r"commercial\s+video|social\s+media)\b[^,]*",
    re.IGNORECASE,
)
_STATIC_SHOT_CLICHE_RE = re.compile(
    r"\b(?:majestic\s+)?static\s+shot\s+of\b",
    re.IGNORECASE,
)


def _strip_prompt_leaks(text: str) -> str:
    if not text:
        return ""
    t = _EMOTION_LABEL_RE.sub("", text)
    t = _PLATFORM_LEAK_RE.sub("", t)
    t = re.sub(r",\s*,", ",", t)
    t = re.sub(r"\s{2,}", " ", t).strip(" ,.")
    return t


def _word_count(text: str) -> int:
    return len(text.split()) if text else 0


def _join_unique(parts: list[str], *, sep: str = ", ") -> str:
    """Deduplicate prompt parts by keyword overlap, not prefix truncation.

    Two parts are considered duplicates if:
    - One is a substring of the other (after lowercasing), OR
    - They share more than 60% of their significant keywords (len>3)
    """
    import re as _re_ju
    seen_keys: list[set[str]] = []
    seen_full: list[str] = []
    out: list[str] = []
    for p in parts:
        p = (p or "").strip()
        if not p or len(p) < 4:
            continue
        p_lower = p.lower()
        # Check substring containment against already-accepted parts
        is_dup = False
        for accepted_lower in seen_full:
            if p_lower in accepted_lower or accepted_lower in p_lower:
                is_dup = True
                break
        if not is_dup:
            # Check keyword-set overlap
            p_kw = set(_re_ju.findall(r"[a-z]{4,}", p_lower))
            if p_kw:
                for accepted_kw in seen_keys:
                    if accepted_kw:
                        overlap = len(p_kw & accepted_kw) / min(len(p_kw), len(accepted_kw))
                        if overlap > 0.6:
                            is_dup = True
                            break
        if not is_dup:
            seen_full.append(p_lower)
            seen_keys.append(set(_re_ju.findall(r"[a-z]{4,}", p_lower)))
            out.append(p)
    return sep.join(out)


def _lighting_phrase(dop: dict, mood: str) -> str:
    lighting = dop.get("lighting")
    if isinstance(lighting, dict):
        parts = [
            str(lighting.get("time_of_day") or ""),
            str(lighting.get("mood") or ""),
            " ".join(
                s if isinstance(s, str) else next((v for v in s.values() if isinstance(v, str)), str(s))
                for s in (lighting.get("sources") or []) if s
            ) if isinstance(lighting.get("sources"), list) else "",
        ]
        s = " ".join(p for p in parts if p).strip()
        if s:
            return s
    if isinstance(lighting, str) and lighting.strip():
        return lighting.strip()
    return f"cinematic directional lighting, {mood} mood"


def build_rich_frame_prompt(
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
    """Prompt first/last frame: prosa strutturata Z-Image con gerarchia registica."""
    text = build_structured_frame_prompt(
        role=role,
        style=style,
        dop=dop,
        visual_hint=visual_hint,
        mood=mood,
        vision=vision,
        director_narrative=director_narrative,
        brief=brief,
    )
    text = _strip_prompt_leaks(text)
    text = _STATIC_SHOT_CLICHE_RE.sub("", text)
    text = polish_z_image_frame_prompt(
        text,
        shot_type=str(dop.get("shot_type") or "medium"),
        depth_of_field=str(dop.get("depth_of_field") or "shallow"),
    )
    return finalize_positive_prompt(text)


def build_rich_ltx_video_prompt(
    *,
    style: str,
    dop: dict,
    visual_hint: str,
    mood: str,
    vision: dict | None,
    director_narrative: dict | None,
    brief: str,
    existing: str = "",
) -> str:
    """Paragrafo LTX 2.3 (4–8 frasi, timeline azione, Sound: finale)."""
    from src.core.llm.ltx23_prompt_builder import refine_ltx23_video_prompt

    duration = float(dop.get("duration_sec") or 5.0)
    paragraph = refine_ltx23_video_prompt(
        _strip_prompt_leaks(existing or ""),
        dop,
        style=style,
        mood=mood,
        visual_hint=visual_hint,
        brief=brief,
        duration_sec=duration,
        slot_emotion=mood,
    )
    return finalize_positive_prompt(paragraph)


def _hint_covered(prompt: str, visual_hint: str) -> bool:
    """True se almeno parte del visual_hint del regista è nel prompt."""
    if not visual_hint or not prompt:
        return not visual_hint
    hint_words = [w.lower() for w in re.findall(r"[a-zA-Z]{4,}", visual_hint)[:12]]
    if len(hint_words) < 3:
        return visual_hint.lower()[:40] in prompt.lower()
    hits = sum(1 for w in hint_words if w in prompt.lower())
    return hits >= max(2, len(hint_words) // 3)


def _prompt_has_framing_defects(text: str) -> bool:
    low = (text or "").lower()
    if low.count("shallow depth of field") > 1:
        return True
    if re.search(r"\b8k\b", low):
        return True
    if re.search(r"sharp focus", low) and "shallow" in low:
        return True
    shot_hits = len(re.findall(
        r"\b(?:extreme\s+)?close[- ]?up|medium\s+close[- ]?up|medium\s+wide|wide\s+shot\b",
        low,
    ))
    if shot_hits > 1:
        return True
    if re.search(r"\b(?:he|she|the\s+\w+)\s+is\s*,", low):
        return True
    return False


def _merge_frame_prompt(llm_prompt: str, rich_prompt: str, *, min_words: int = 50) -> str:
    llm = _strip_prompt_leaks(llm_prompt)
    rich = _strip_prompt_leaks(rich_prompt)
    if _word_count(llm) < min_words or _prompt_has_framing_defects(llm):
        return rich
    if _word_count(rich) <= _word_count(llm) and not _prompt_has_framing_defects(llm):
        return finalize_positive_prompt(llm)
    return finalize_positive_prompt(rich)


def enrich_reel_clip_prompts(
    pdata: dict,
    dop: dict,
    *,
    style: str,
    brief: str = "",
    visual_hint: str = "",
    slot_emotion: str = "",
    vision: dict | None = None,
    director_narrative: dict | None = None,
    slot_index: int = 0,
    slot_total: int = 1,
    clip_index_in_slot: int = 0,
    clips_in_slot: int = 1,
) -> dict[str, str]:
    """Sanitizza + arricchisce prompt reel; garantisce densità e coerenza visiva."""
    from src.core.llm.reel_slot_variety import (
        enrich_visual_plan_for_slot,
        motion_for_clip,
    )

    dop = dict(dop)
    if pdata.get("duration_sec"):
        dop.setdefault("duration_sec", float(pdata["duration_sec"]))
    if slot_total > 1:
        dop = enrich_visual_plan_for_slot(
            dop,
            slot_index=slot_index,
            slot_total=slot_total,
            brief=brief,
            base_hint=visual_hint,
            force_variety=slot_index > 0 or clip_index_in_slot > 0,
        )
    motion_override = motion_for_clip(
        dop=dop,
        slot_index=slot_index,
        slot_total=max(slot_total, 1),
        clip_index_in_slot=clip_index_in_slot,
        clips_in_slot=max(clips_in_slot, 1),
        brief=brief,
    )
    dop["motion_intent"] = motion_override

    mood = (
        (director_narrative or {}).get("mood")
        or slot_emotion
        or "cinematic"
    )
    base = sanitize_trailer_clip_prompts(
        pdata, dop, style=style, slot_emotion=slot_emotion,
    )

    rich_first = build_rich_frame_prompt(
        role="first",
        style=style,
        dop=dop,
        visual_hint=visual_hint,
        mood=mood,
        vision=vision,
        director_narrative=director_narrative,
        brief=brief,
    )
    rich_last = build_rich_frame_prompt(
        role="last",
        style=style,
        dop=dop,
        visual_hint=visual_hint,
        mood=mood,
        vision=vision,
        director_narrative=director_narrative,
        brief=brief,
    )

    first_merged = _merge_frame_prompt(base["first_frame_prompt"], rich_first)
    if visual_hint and not _hint_covered(first_merged, visual_hint):
        hint_snip = visual_hint.strip()
        if len(hint_snip) > 220:
            hint_snip = hint_snip[:217].rsplit(" ", 1)[0] + "."
        first_merged = polish_z_image_frame_prompt(
            f"{first_merged} {hint_snip}",
            shot_type=str(dop.get("shot_type") or "medium"),
            depth_of_field=str(dop.get("depth_of_field") or "shallow"),
        )
        first_merged = finalize_positive_prompt(first_merged)

    last_merged = _merge_frame_prompt(base["last_frame_prompt"], rich_last, min_words=45)

    base["first_frame_prompt"] = ensure_detailed_frame_prompt(
        first_merged,
        scene_prompt=visual_hint or dop.get("scene_description", ""),
        style=style,
        shot_type=dop.get("shot_type") or "medium",
        frame_state=dop.get("first_frame_state") or "",
        role="first",
        min_chars=110,
    )
    base["last_frame_prompt"] = ensure_detailed_frame_prompt(
        last_merged,
        scene_prompt=visual_hint or dop.get("scene_description", ""),
        style=style,
        shot_type=dop.get("shot_type") or "medium",
        frame_state=dop.get("last_frame_state") or "",
        role="last",
        min_chars=100,
    )
    base["scene_prompt"] = sanitize_generation_prompt(
        _join_unique([
            base["scene_prompt"],
            style,
            f"{dop.get('shot_type', 'medium')} shot",
            (visual_hint or dop.get("scene_description", ""))[:220],
            _lighting_phrase(dop, mood),
        ]),
        min_len=45,
        max_len=550,
    )
    base["ltx_video_prompt"] = build_rich_ltx_video_prompt(
        style=style,
        dop=dop,
        visual_hint=visual_hint,
        mood=mood,
        vision=vision,
        director_narrative=director_narrative,
        brief=brief,
        existing=base.get("ltx_video_prompt", ""),
    )

    base["motion_prompt"] = sanitize_motion_prompt(
        motion_override,
        fallback=motion_override,
        max_len=120,
    )
    base["negative_prompt"] = base.get("negative_prompt") or CINEMATIC_NEGATIVE_PROMPT

    return base
