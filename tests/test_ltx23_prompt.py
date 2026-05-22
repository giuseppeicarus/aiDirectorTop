"""Test builder prompt LTX 2.3."""

from src.core.llm.ltx23_prompt_builder import (
    build_ltx23_video_prompt,
    is_ltx_prompt_well_formed,
    normalize_ltx23_prompt,
    refine_ltx23_video_prompt,
)


def test_build_intro_slot_structure():
    dop = {
        "shot_type": "wide",
        "camera_movement": "dolly_in",
        "lens_mm": 24,
        "duration_sec": 5.0,
        "first_frame_state": (
            "the rap artist in leather jacket and chains, "
            "artist walks into frame from shadow, head down then lifts chin"
        ),
        "motion_intent": "artist walks into frame from shadow, head down then lifts chin",
        "lighting": {"time_of_day": "night", "mood": "warm directional", "sources": ["key"]},
        "location": "dim urban interior",
    }
    prompt = build_ltx23_video_prompt(
        dop,
        mood="anticipation",
        brief="rap music video cinematic",
        duration_sec=5.0,
    )
    low = prompt.lower()
    assert prompt.startswith("A wide shot")
    assert "the lighting is" in low
    assert "the camera slowly dollies forward" in low
    assert "in the first seconds" in low or "over the clip" in low
    assert low.count("sound:") == 1
    assert "the scene shows" not in low
    assert "every surface" not in low
    assert "establishing the s" not in low


def test_normalize_strips_legacy_junk():
    bad = (
        "The camera slowly dollies forward in a wide framing, 24mm lens. wide shot. "
        "The scene shows cinematic, head dow, with every surface and object clearly visible. "
        "The mood is intense, cinematic aesthetic. Ambient city sound. "
        "Sound: room tone."
    )
    cleaned = normalize_ltx23_prompt(bad)
    assert "the scene shows" not in cleaned.lower()
    assert "every surface" not in cleaned.lower()


def test_refine_rebuilds_malformed_llm_output():
    dop = {
        "shot_type": "wide",
        "camera_movement": "dolly_in",
        "lens_mm": 24,
        "duration_sec": 5.0,
        "motion_intent": "artist lifts chin toward camera",
        "lighting": {"mood": "dramatic"},
    }
    malformed = (
        "The camera slowly dollies forward in a wide framing, 24mm lens. "
        "wide shot full environment, cinematic aesthetic. "
        "photorealistic cinematic realism, natural skin texture"
    )
    assert not is_ltx_prompt_well_formed(malformed)
    out = refine_ltx23_video_prompt(malformed, dop, duration_sec=5.0)
    assert is_ltx_prompt_well_formed(out) or out.lower().count("sound:") >= 1
