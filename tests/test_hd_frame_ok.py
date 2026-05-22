"""Verifica che i frame HD non includano anteprime storyboard a bassa risoluzione."""

from pathlib import Path

import pytest

from src.core.workflow.trailer_pipeline import TrailerPipeline, TrailerRequest


def _pipeline(w: int = 1080, h: int = 1920) -> TrailerPipeline:
    req = TrailerRequest(
        project_id="test",
        audio_path=".",
        description="x" * 25,
        width=w,
        height=h,
    )
    return TrailerPipeline(req)


def test_hd_frame_ok_rejects_storyboard_sized_png(tmp_path: Path):
    from PIL import Image as PILImage

    p = TrailerPipeline(
        TrailerRequest(project_id="t", audio_path=".", description="x" * 25, width=1080, height=1920),
    )
    sb = tmp_path / "sb.png"
    with PILImage.new("RGB", (180, 320), color=(10, 20, 30)) as img:
        img.save(sb)
    assert not p._hd_frame_ok(sb)


def test_hd_frame_ok_accepts_project_resolution(tmp_path: Path):
    from PIL import Image as PILImage

    p = _pipeline()
    hd = tmp_path / "hd.png"
    with PILImage.new("RGB", (1080, 1920), color=(40, 50, 60)) as img:
        img.save(hd)
    assert p._hd_frame_ok(hd)
