#!/usr/bin/env python3
"""Run trailer pipeline via API and stream progress until done or error."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import httpx

API = "http://127.0.0.1:8765"


def main() -> int:
    project_id = "trailer_standalone"
    jobs_path = Path.home() / ".cinematic-studio" / "projects" / project_id / "trailer_jobs.json"
    if not jobs_path.exists():
        print("No trailer_jobs.json found")
        return 1

    jobs = json.loads(jobs_path.read_text(encoding="utf-8"))
    job = jobs[0] if jobs else None
    if not job:
        print("No jobs")
        return 1

    audio_path = job["audio_path"]
    if not Path(audio_path).exists():
        print(f"Audio missing: {audio_path}")
        return 1

    cfg = job.get("config", {})
    checkpoint = Path.home() / ".cinematic-studio" / "projects" / project_id / f"trailer_state_{job['job_id']}.json"
    phase = "production" if checkpoint.exists() else "full"

    body = {
        "project_id": project_id,
        "audio_path": audio_path,
        "audio_name": job.get("audio_name", ""),
        "resume_job_id": job["job_id"],
        "phase": phase,
        **cfg,
    }
    print(f"Starting job {job['job_id']} phase={phase}")
    print(f"Audio: {audio_path}")

    with httpx.Client(timeout=None) as client:
        with client.stream("POST", f"{API}/api/trailer/generate", json=body) as resp:
            resp.raise_for_status()
            buf = ""
            for chunk in resp.iter_text():
                buf += chunk
                while "\n\n" in buf:
                    part, buf = buf.split("\n\n", 1)
                    for line in part.splitlines():
                        if not line.startswith("data: "):
                            continue
                        try:
                            ev = json.loads(line[6:])
                        except json.JSONDecodeError:
                            continue
                        if ev.get("done") is True:
                            print("\n=== DONE ===")
                            print(json.dumps(ev, indent=2))
                            return 0
                        if ev.get("error"):
                            print("\n=== ERROR ===", ev)
                            return 2
                        et = ev.get("event", "")
                        if et in (
                            "phase", "frame_done", "frame_skip", "clip_done",
                            "clip_skip", "clip_error", "generation_progress",
                            "resume", "audio_ready", "prompts_ready", "generation_complete",
                        ):
                            print(ev)
                        elif "pct" in ev and et == "":
                            pass

    print("Stream ended without done event")
    return 3


if __name__ == "__main__":
    sys.exit(main())
