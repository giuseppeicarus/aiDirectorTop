"""Recupera uno storyboard ComfyUI già generato sul server (history proxy vuota)."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from src.core.comfyui.pool import ComfyUINodePool
from src.core.utils.comfyui_outputs import (
    STORYBOARD_IMAGE_MIN_BYTES,
    download_image_by_prefix_probe,
)


async def main() -> int:
    storage = sys.argv[1] if len(sys.argv) > 1 else "reel_f5441d8833"
    clip_id = sys.argv[2] if len(sys.argv) > 2 else "clip_001_slot_002"
    prefix = f"{clip_id}_sb"
    dest = (
        Path.home()
        / ".cinematic-studio"
        / "projects"
        / storage
        / "storyboard"
        / f"{prefix}.png"
    )
    dest.parent.mkdir(parents=True, exist_ok=True)

    pool = ComfyUINodePool()
    client = await pool.get_client()
    saved = await download_image_by_prefix_probe(
        client, prefix, dest, min_image_bytes=STORYBOARD_IMAGE_MIN_BYTES,
    )
    print(f"OK {saved} ({saved.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
