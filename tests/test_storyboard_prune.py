"""Test rimozione duplicati storyboard ComfyUI."""

from pathlib import Path

from src.core.utils.comfyui_outputs import prune_storyboard_folder


def test_prune_removes_comfyui_sidecar_when_canonical_exists(tmp_path: Path):
    folder = tmp_path / "storyboard"
    folder.mkdir()
    canon = folder / "clip_000_slot_001_sb.png"
    sidecar = folder / "clip_000_slot_001_sb_00004_.png"
    canon.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 8000)
    sidecar.write_bytes(canon.read_bytes())

    removed = prune_storyboard_folder(folder)

    assert sidecar.name in removed
    assert canon.exists()
    assert not sidecar.exists()


def test_prune_keeps_sidecar_if_no_canonical(tmp_path: Path):
    folder = tmp_path / "storyboard"
    folder.mkdir()
    only = folder / "clip_001_slot_002_sb_00006_.png"
    only.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 8000)

    removed = prune_storyboard_folder(folder)

    assert removed == []
    assert only.exists()
