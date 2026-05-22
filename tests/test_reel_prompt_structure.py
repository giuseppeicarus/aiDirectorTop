"""Test struttura prompt reel Z-Image."""

from src.core.llm.reel_prompt_enrich import _prompt_has_framing_defects, enrich_reel_clip_prompts
from src.core.llm.reel_prompt_structure import (
    build_structured_frame_prompt,
    polish_z_image_frame_prompt,
)


def test_polish_removes_redundancy_and_8k():
    raw = (
        "close-up shot, medium close-up, shallow depth of field, shallow depth of field, "
        "50mm lens, 50mm lens, sharp focus, 8k, film grain, film grain"
    )
    out = polish_z_image_frame_prompt(raw, shot_type="close_up", depth_of_field="shallow")
    assert "8k" not in out.lower()
    assert out.lower().count("shallow depth of field") == 1
    assert "sharp focus" not in out.lower() or "bokeh" in out.lower()


def test_structured_prompt_has_protagonist_and_single_shot():
    dop = {
        "shot_type": "medium",
        "lens_mm": 50,
        "depth_of_field": "shallow",
        "primary_visual_focus": "Italian man in doorway watching the dancer",
        "secondary_subject": "red-haired woman dancing on a small stage",
        "scene_description": "Dark neo-noir pub with amber lights",
        "first_frame_state": "He freezes in the doorway, eyes on her.",
        "last_frame_state": "He takes one step inward, her spin catches the light.",
        "emotional_beat": "quiet attraction and hesitation",
        "lighting": "warm amber key, deep blue shadows",
    }
    out = build_structured_frame_prompt(
        role="first",
        style="cinematic neo-noir, photorealistic",
        dop=dop,
        visual_hint="Pub scene with dancer and newcomer",
        mood="tense romantic",
        vision={"character_anchors": ["30yo Italian man, dark jacket"]},
        director_narrative={"mood": "tense romantic"},
        brief="Neo-noir pub encounter",
    )
    low = out.lower()
    assert "visual protagonist" in low or "italian man" in low
    assert "8k" not in low
    assert low.count("close-up") + low.count("close up") <= 1


def test_enrich_replaces_defective_llm_prompt():
    dop = {
        "shot_type": "medium_close",
        "lens_mm": 50,
        "depth_of_field": "shallow",
        "scene_description": "Pub interior",
        "first_frame_state": "Man at door, woman dances",
        "last_frame_state": "He steps closer",
        "motion_intent": "slow dolly in",
        "lighting": "chiaroscuro",
        "primary_visual_focus": "man at doorway",
    }
    pdata = {
        "first_frame_prompt": (
            "close-up shot, medium close-up shot, bar, table, stage, woman, man, "
            "shallow depth of field, shallow depth of field, 8k, sharp focus, the woman is,"
        ),
        "last_frame_prompt": "same",
        "motion_prompt": "dolly in",
        "scene_prompt": "pub",
        "ltx_video_prompt": "",
    }
    clean = enrich_reel_clip_prompts(
        pdata, dop, style="cinematic", brief="pub", visual_hint="pub dance",
        slot_emotion="tension",
    )
    assert _prompt_has_framing_defects(pdata["first_frame_prompt"])
    assert not _prompt_has_framing_defects(clean["first_frame_prompt"])
    assert "8k" not in clean["first_frame_prompt"].lower()
    assert "the woman is," not in clean["first_frame_prompt"].lower()
