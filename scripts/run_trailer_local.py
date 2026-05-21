#!/usr/bin/env python3
"""Run TrailerPipeline in-process (survives uvicorn --reload)."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

# project root on path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.core.workflow.trailer_pipeline import TrailerPipeline, TrailerRequest  # noqa: E402


async def run_job() -> int:
    project_id = "trailer_standalone"
    jobs_path = Path.home() / ".cinematic-studio" / "projects" / project_id / "trailer_jobs.json"
    jobs = json.loads(jobs_path.read_text(encoding="utf-8"))
    job = jobs[0]
    job_id = job["job_id"]
    cfg = job.get("config", {})
    checkpoint = Path.home() / ".cinematic-studio" / "projects" / project_id / f"trailer_state_{job_id}.json"
    phase = "production" if checkpoint.exists() else "full"
    if phase == "production":
        data = json.loads(checkpoint.read_text(encoding="utf-8"))
        if data.get("phase_completed", 0) < 5:
            phase = "full"

    extra = {k: v for k, v in cfg.items() if k not in ("resume_job_id", "phase", "clip_backend")}
    if phase == "production":
        # Resume: forza auto+FFmpeg se il job era fallito con comfyui senza fallback
        extra["clip_backend"] = "auto"
        extra["allow_ffmpeg_fallback"] = True
    req = TrailerRequest(
        project_id=project_id,
        audio_path=job["audio_path"],
        audio_name=job.get("audio_name", ""),
        resume_job_id=job_id,
        phase=phase,
        **extra,
    )
    print(f"job={job_id} phase={phase}", flush=True)
    pipeline = TrailerPipeline(req)
    done_ev: dict | None = None
    async for ev in pipeline.run():
        if ev.get("done") is True:
            done_ev = ev
        elif ev.get("phase") == "fatal" or (ev.get("error") and not ev.get("event")):
            print("FATAL", ev, flush=True)
            return 2
        et = ev.get("event", "")
        if et or "pct" in ev or ev.get("done"):
            print(json.dumps(ev, ensure_ascii=False), flush=True)
    if done_ev:
        print("DONE", flush=True)
        return 0
    print("ended without done", flush=True)
    return 3


def main() -> None:
    raise SystemExit(asyncio.run(run_job()))


if __name__ == "__main__":
    main()
