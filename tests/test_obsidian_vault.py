"""Test vault Obsidian — sync da checkpoint fittizio."""

import json
from pathlib import Path

from src.core.obsidian.vault_manager import ObsidianVaultManager


def test_sync_trailer_checkpoint(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    mgr = ObsidianVaultManager(vault)
    checkpoint = {
        "request": {
            "txt2img_workflow": "z_image_txt2img",
            "img2video_workflow": "ltx_img_audio2video",
            "audio_path": "/audio/song.wav",
        },
        "clips_list": [
            {
                "clip_id": "clip_001_slot_a",
                "slot_id": "slot_a",
                "start_sec": 10.0,
                "end_sec": 20.0,
                "duration_sec": 10.0,
                "audio_src_start_sec": 0.0,
                "audio_src_end_sec": 10.0,
                "scene_prompt": "Beach at golden hour",
                "first_frame_prompt": "wide shot woman on sand",
                "motion_prompt": "slow dolly in",
                "ltx_video_prompt": "camera push, waves",
            }
        ],
        "trailer_audio_path": "/tmp/trailer.wav",
        "sections": [{"start_sec": 0, "end_sec": 30, "energy": "high"}],
        "downbeats": [0.0, 0.5, 1.0],
        "audio_duration": 30.0,
    }
    result = mgr.sync_trailer_or_reel_checkpoint(
        project_id="test_proj",
        job_id="job99",
        pipeline_kind="reel",
        checkpoint=checkpoint,
    )
    assert result["clips_synced"] == 1
    clip_note = vault / "Projects" / "test_proj" / "Clips" / "clip_001_slot_a.md"
    assert clip_note.exists()
    text = clip_note.read_text(encoding="utf-8")
    assert "ltx_img_audio2video" in text
    assert "audio_src_start_sec" in text or "0.0" in text
    assert "[[Projects/test_proj/_Project]]" in text

    bundle = mgr.get_context_bundle(project_id="test_proj", clip_id="clip_001_slot_a")
    assert "Beach at golden hour" in bundle or "clip_001" in bundle

    hits = mgr.search("dolly", project_id="test_proj")
    assert len(hits) >= 1

    arc_note = vault / "Projects" / "test_proj" / "Memory" / "Regia-Memory.md"
    assert arc_note.exists()


def test_sync_cinematic_pipeline_memory(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    mgr = ObsidianVaultManager(vault)
    state = {
        "completed_stages": ["story_analysis", "narrative_arc"],
        "project_input": {
            "title": "Test Film",
            "story_brief": "A hero returns home",
            "genre": "short_film",
            "aspect_ratio": "16:9",
            "runtime_target_sec": 60,
            "style_references": ["noir"],
            "mood_references": ["melancholic"],
            "characters": [],
        },
        "data": {
            "story_analysis": {
                "themes": ["nostalgia"],
                "narrative_summary": "Return journey",
                "visual_metaphors": ["empty station"],
            },
            "story_arc": {
                "title": "Home",
                "logline": "She comes back",
                "sequences": [],
            },
            "shot_list": [
                {
                    "shot_id": "shot_001_001",
                    "sequence_id": "seq_01",
                    "scene_id": "scene_01",
                    "location": "station",
                    "emotion": "longing",
                    "camera": {"shot_type": "wide", "movement": "dolly_in", "lens_mm": 35},
                    "lighting": {"time_of_day": "night", "mood": "cold"},
                    "first_frame": {"prompt": "wide station"},
                    "motion_prompt": "slow push",
                },
            ],
        },
    }
    out = mgr.sync_cinematic_pipeline(project_id="cinema_1", pipeline_state=state)
    assert out["shots_synced"] == 1
    assert (vault / "Projects" / "cinema_1" / "Memory" / "01-Story-Analysis.md").exists()
    assert (vault / "Projects" / "cinema_1" / "Story-Arc.md").exists()
    bundle = mgr.get_context_bundle(
        project_id="cinema_1",
        include=("story_analysis", "story_arc", "shot"),
        shot_id="shot_001_001",
    )
    assert "nostalgia" in bundle or "Return journey" in bundle
    assert "station" in bundle
