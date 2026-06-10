from pathlib import Path

import pytest

from src.core.utils.comfyui_outputs import (
    is_real_comfy_video,
    pick_best_video_output,
)


def test_png_renamed_mp4_is_not_a_real_video(tmp_path: Path):
    fake = tmp_path / "clip.mp4"
    fake.write_bytes(b"\x89PNG\r\n\x1a\n" + b"x" * 60_000)

    assert is_real_comfy_video(fake) is False


def test_mp4_ftyp_header_is_a_real_video(tmp_path: Path):
    video = tmp_path / "clip.mp4"
    video.write_bytes(
        b"\x00\x00\x00\x20ftypisom\x00\x00\x02\x00isomiso2avc1mp41"
        + b"\x00" * 60_000
    )

    assert is_real_comfy_video(video) is True


def test_pick_best_video_rejects_image_only_history():
    with pytest.raises(ValueError, match="senza output video"):
        pick_best_video_output([
            {"filename": "last_frame.png", "type": "output"},
        ])


def test_pick_best_video_prefers_actual_video():
    result = pick_best_video_output([
        {"filename": "last_frame.png", "type": "output"},
        {"filename": "clip_001.mp4", "type": "output"},
    ])

    assert result["filename"] == "clip_001.mp4"
