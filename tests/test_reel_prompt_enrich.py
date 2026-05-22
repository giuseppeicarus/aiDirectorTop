"""Test arricchimento prompt reel."""

from src.core.llm.reel_prompt_enrich import (
    _strip_prompt_leaks,
    enrich_reel_clip_prompts,
    _word_count,
)


def test_strip_emotion_and_platform_leaks():
    raw = (
        "photorealistic, razor on marble, Assertiveness emotion, instagram adv video"
    )
    out = _strip_prompt_leaks(raw)
    assert "emotion" not in out.lower() or "assertiveness" not in out.lower()
    assert "instagram" not in out.lower()


def test_enrich_sparse_llm_prompt_includes_visual_hint():
    dop = {
        "shot_type": "medium_close",
        "lens_mm": 50,
        "depth_of_field": "shallow",
        "scene_description": "Steel razor on black marble, warm side light",
        "first_frame_state": "Razor edge catches light",
        "last_frame_state": "Camera closer, gleam intensifies",
        "motion_intent": "slow dolly in, light sweeps across blade",
        "lighting": "warm key light, soft fill",
        "color_grade_note": "premium gold highlights",
    }
    pdata = {
        "first_frame_prompt": (
            "photorealistic, netflix style, medium close-up, 50mm lens, "
            "razor blade on marble, Assertiveness emotion, instagram adv video"
        ),
        "last_frame_prompt": "same shot, slightly closer",
        "ltx_video_prompt": "camera moves in",
        "scene_prompt": "razor product",
        "motion_prompt": "dolly in",
    }
    visual_hint = (
        "Extreme premium grooming ad: polished stainless razor with engraved handle "
        "resting on veined black marble, water droplets on metal, warm golden key "
        "light from left, dark soft background, assertive masculine luxury mood"
    )
    clean = enrich_reel_clip_prompts(
        pdata,
        dop,
        style="photorealistic, Netflix-grade, dramatic lighting",
        brief="Premium razor Instagram reel, assertive masculine tone",
        visual_hint=visual_hint,
        slot_emotion="assertive",
        vision={
            "character_anchors": [],
            "environment_anchors": ["black marble vanity surface", "dark studio backdrop"],
        },
        director_narrative={
            "mood": "assertive premium",
            "visual_motifs": ["steel gleam", "marble veins"],
        },
    )
    assert _word_count(clean["first_frame_prompt"]) >= 45
    assert "marble" in clean["first_frame_prompt"].lower()
    assert "instagram" not in clean["first_frame_prompt"].lower()
    assert _word_count(clean["ltx_video_prompt"]) >= 50
    assert "camera" in clean["ltx_video_prompt"].lower()
