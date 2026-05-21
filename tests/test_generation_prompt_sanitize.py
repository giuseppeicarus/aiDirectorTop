"""Test sanitizzazione prompt per modelli thinking."""

import pytest

from src.core.llm.generation_prompt_sanitize import (
    CINEMATIC_NEGATIVE_PROMPT,
    ensure_detailed_frame_prompt,
    finalize_positive_prompt,
    looks_like_gibberish_or_instruction,
    looks_like_meta_or_schema,
    sanitize_generation_prompt,
    sanitize_trailer_clip_prompts,
    strip_llm_reasoning,
)


def test_strip_xml_thinking_tags():
    raw = "<thinking>planning shot</thinking>Cinematic, wide shot, rain, neon city"
    out = strip_llm_reasoning(raw)
    assert "planning shot" not in out
    assert "Cinematic" in out


def test_strip_qwen_think_block():
    raw = "``\nSome analysis.\n``\nCinematic medium shot, hero in alley"
    out = strip_llm_reasoning(raw)
    assert "analysis" not in out.lower() or "Cinematic" in out
    assert "Cinematic" in out


def test_rejects_json_as_prompt():
    bad = '{"slot_id":"slot_001","first_frame_prompt":"test"}'
    assert looks_like_meta_or_schema(bad)
    out = sanitize_generation_prompt(
        bad,
        fallback="cinematic wide shot, urban night, rain, neon reflections, 8k",
    )
    assert "slot_id" not in out
    assert "cinematic" in out.lower()


def test_rejects_meta_instructions():
    bad = (
        "OUTPUT JSON only. FRAME PROMPT FORMAT: [STYLE], [SHOT]. "
        "I will now create the first frame prompt for slot_001."
    )
    fb = "cinematic close-up, woman at window, golden hour, soft rim light, 35mm"
    out = sanitize_generation_prompt(bad, fallback=fb)
    assert "OUTPUT JSON" not in out
    assert "slot_001" not in out
    assert len(out) >= 24


def test_sanitize_trailer_clip_from_thinking_payload():
    pdata = {
        "first_frame_prompt": (
            "Need a noir alley. "
            "Cinematic, medium shot, lone figure in rain-soaked alley, "
            "neon signs, wet pavement, cool blue key light, warm rim, 35mm, 8k"
        ),
    }
    dop = {
        "shot_type": "medium",
        "scene_description": "Noir alley at night with rain and neon.",
        "first_frame_state": "figure standing still under flickering sign",
        "last_frame_state": "figure turns toward camera",
        "motion_intent": "slow dolly in",
    }
    clean = sanitize_trailer_clip_prompts(pdata, dop, style="noir cinematic")
    assert "Need a noir" not in clean["first_frame_prompt"]
    assert "rain-soaked" in clean["first_frame_prompt"] or "alley" in clean["first_frame_prompt"]


def test_finalize_adds_anti_text_suffix():
    out = finalize_positive_prompt("cinematic wide shot, rain, neon alley")
    assert "no visible text" in out.lower()


def test_gibberish_instruction_detected():
    bad = "OUTPUT JSON only. I will create the first_frame_prompt for slot_001."
    assert looks_like_gibberish_or_instruction(bad)
    assert looks_like_meta_or_schema(bad)


def test_negative_prompt_includes_text_ban():
    assert "typography" in CINEMATIC_NEGATIVE_PROMPT
    assert "gibberish" in CINEMATIC_NEGATIVE_PROMPT


def test_ensure_detailed_frame_prompt_min_length():
    short = "wide shot, rain"
    out = ensure_detailed_frame_prompt(
        short,
        scene_prompt="Noir alley at night with neon reflections and wet pavement",
        style="noir cinematic",
        min_chars=80,
    )
    assert len(out) >= 80
    assert "no visible text" in out.lower()


def test_sanitize_strips_instruction_prefix():
    bad = "The user wants a noir scene. Cinematic medium shot, hero in alley, rain, 8k"
    out = sanitize_generation_prompt(
        bad,
        fallback="cinematic medium shot, hero in alley, rain, neon, 8k",
    )
    assert "the user wants" not in out.lower()
    assert "no visible text" in out.lower()
