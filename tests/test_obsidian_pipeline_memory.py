"""Obsidian pipeline memory builders."""

from src.core.obsidian.pipeline_memory import (
    merge_slot_lyrics_into_edl,
    notes_from_reel_trailer_checkpoint,
    phase_label,
)


def test_phase_label_reel():
    assert phase_label("reel", 3) == "reel_director"


def test_merge_slot_lyrics():
    edl = {"slots": [{"slot_id": "slot_001", "start_sec": 0, "end_sec": 5}]}
    out = merge_slot_lyrics_into_edl(edl, {"slot_001": "hello world"})
    assert out["slots"][0]["lyrics_segment"] == "hello world"


def test_notes_from_checkpoint_includes_lyrics():
    notes = notes_from_reel_trailer_checkpoint(
        {
            "lyric_beats": [{"lyric_line": "a", "time_sec": 0, "end_sec": 1}],
            "request": {"txt2img_workflow": "z_image_txt2img"},
        },
        pipeline_kind="reel",
        project_id="p1",
        job_id="j1",
    )
    paths = [n[0] for n in notes]
    assert "Memory/03-Lyric-Timing.md" in paths
    assert "Memory/06-Production-Config.md" in paths
