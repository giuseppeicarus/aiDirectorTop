"""Test validazione output ComfyUI e rilevamento placeholder."""

from pathlib import Path

import pytest

from src.core.utils.comfyui_outputs import (
    COMFY_REAL_IMAGE_MIN_BYTES,
    STORYBOARD_IMAGE_MIN_BYTES,
    is_ffmpeg_placeholder_image,
    is_real_comfy_image,
    pick_best_image_output,
    pick_largest_real_image,
    validate_downloaded_bytes,
)


def test_validate_rejects_tiny_payload():
    with pytest.raises(ValueError, match="vuoto|piccolo"):
        validate_downloaded_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 50, expect="image")


def test_validate_accepts_minimal_png_header():
    # PNG valido ma sotto soglia download_comfyui_file (testato separatamente)
    data = b"\x89PNG\r\n\x1a\n" + b"\x00" * 300
    validate_downloaded_bytes(data, expect="image")


def test_is_real_comfy_image_rejects_placeholder_size(tmp_path: Path):
    p = tmp_path / "placeholder.png"
    p.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 800)
    assert not is_real_comfy_image(p)
    assert p.stat().st_size < COMFY_REAL_IMAGE_MIN_BYTES


def test_pick_best_image_output_prefers_final_over_preview():
    files = [
        {"filename": "preview_latent.png", "type": "temp"},
        {"filename": "proge_72e1df5b4e_0003_.png", "type": "output"},
    ]
    best = pick_best_image_output(files)
    assert "proge" in best["filename"]


def test_is_real_comfy_image_accepts_large_png(tmp_path: Path):
    p = tmp_path / "frame.png"
    p.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 12_000)
    assert is_real_comfy_image(p)


def test_is_ffmpeg_placeholder_detects_836_byte_png(tmp_path: Path):
    p = tmp_path / "clip_001_sb.png"
    p.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 820)
    assert is_ffmpeg_placeholder_image(p)
    assert not is_real_comfy_image(p, min_bytes=STORYBOARD_IMAGE_MIN_BYTES)


def test_pick_largest_real_image_skips_placeholder(tmp_path: Path):
    small = tmp_path / "clip_001_sb.png"
    big = tmp_path / "clip_001_sb_00009_.png"
    small.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 820)
    big.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 12_000)
    picked = pick_largest_real_image([small, big], min_bytes=STORYBOARD_IMAGE_MIN_BYTES)
    assert picked == big
