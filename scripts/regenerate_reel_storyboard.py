"""Rigenera storyboard mancanti per un job CreateReel (phase=storyboard)."""
from __future__ import annotations

import asyncio
import json
import sys

from src.core.workflow.reel_pipeline import ReelPipeline, ReelRequest


async def main() -> int:
    job_id = sys.argv[1] if len(sys.argv) > 1 else "20921bc93f"
    req = ReelRequest(
        project_id="reel_standalone",
        description="resume",
        resume_job_id=job_id,
        phase="storyboard",
        concurrent_jobs=1,
        clip_backend="comfyui",
        allow_ffmpeg_fallback=False,
    )
    pipeline = ReelPipeline(req)
    ok_count = 0
    fail_count = 0
    async for event in pipeline.run():
        ev = event.get("event") or event.get("error", "")
        if event.get("event") == "storyboard_frame":
            if event.get("storyboard_ok"):
                ok_count += 1
                print(f"OK  {event.get('clip_id')} -> {event.get('path')}")
            else:
                fail_count += 1
                print(f"FAIL {event.get('clip_id')}")
        elif ev in ("storyboard_ready", "awaiting_storyboard_approval", "phase_done"):
            print(json.dumps({k: event[k] for k in event if k in ("event", "count", "pct")}))
        elif event.get("error"):
            print("ERROR:", event["error"])
            return 1
    base = pipeline._storyboard_dir
    files = sorted(base.glob("*.png")) if base.exists() else []
    print(f"\nDisk: {len(files)} PNG in {base}")
    for f in files:
        print(f"  {f.name}: {f.stat().st_size} bytes")
    print(f"SSE summary: ok={ok_count} fail={fail_count}")
    return 0 if ok_count >= 1 and fail_count == 0 else (1 if fail_count else 0)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
