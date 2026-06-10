"""Resume a CreateReel production job while keeping its SSE stream alive."""

from __future__ import annotations

import argparse
import json
import time

import httpx


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("job_id")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--project-id", default="reel_standalone")
    args = parser.parse_args()

    base = f"http://127.0.0.1:{args.port}"
    with httpx.Client(timeout=None) as client:
        response = client.get(
            f"{base}/api/reel/jobs",
            params={"project_id": args.project_id},
        )
        response.raise_for_status()
        jobs = response.json().get("jobs", [])
        job = next((item for item in jobs if item.get("job_id") == args.job_id), None)
        if not job:
            raise RuntimeError(f"Reel job not found: {args.job_id}")

        payload = dict(job.get("config") or {})
        payload.update(
            {
                "project_id": args.project_id,
                "resume_job_id": args.job_id,
                "phase": "production",
                "concurrent_jobs": 1,
            }
        )

        print(f"{time.strftime('%H:%M:%S')} resume {args.job_id}", flush=True)
        with client.stream(
            "POST",
            f"{base}/api/reel/generate",
            json=payload,
        ) as stream:
            stream.raise_for_status()
            for line in stream.iter_lines():
                if not line.startswith("data: "):
                    continue
                event = json.loads(line[6:])
                summary = {
                    key: event.get(key)
                    for key in (
                        "event",
                        "phase",
                        "pct",
                        "msg",
                        "clip_id",
                        "done",
                        "error",
                        "cancelled",
                        "final_video_path",
                    )
                    if event.get(key) is not None
                }
                print(
                    f"{time.strftime('%H:%M:%S')} "
                    f"{json.dumps(summary, ensure_ascii=False)}",
                    flush=True,
                )
                if event.get("done"):
                    return 0
                if event.get("error") or event.get("cancelled"):
                    return 1
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
