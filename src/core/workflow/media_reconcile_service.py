"""Risposte API unify per reconcile media (reel, trailer, cinematic, director)."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from src.core.workflow.checkpoint_loaders import load_job_pipeline_from_checkpoint


def persist_clips_checkpoint(state_path: Path, pipeline) -> None:
    import json

    raw = json.loads(state_path.read_text(encoding="utf-8"))
    raw["clips_list"] = [c.model_dump() for c in pipeline._clips_list]
    state_path.write_text(json.dumps(raw, indent=2, ensure_ascii=False), encoding="utf-8")


async def reconcile_reel_or_trailer_job(
    catalog_project_id: str,
    job_id: str,
    kind: str,
    *,
    storyboard: bool = True,
    hd_frames: bool = False,
    videos: bool = True,
) -> dict:
    from src.core.workflow.checkpoint_loaders import PipelineKind

    pk: PipelineKind = "reel" if kind == "reel" else "trailer"
    loaded = load_job_pipeline_from_checkpoint(catalog_project_id, job_id, pk)
    pipeline, state_path, raw = loaded
    if not pipeline:
        return {"ok": False, "error": "Checkpoint non trovato", "recovered": []}

    try:
        events = await pipeline.reconcile_missing_clip_media(
            storyboard=storyboard,
            hd_frames=hd_frames,
            videos=videos,
        )
    except Exception as exc:
        return {"ok": False, "error": str(exc), "recovered": []}

    if events and state_path:
        persist_clips_checkpoint(state_path, pipeline)

    raw = raw or {}
    return {
        "ok": True,
        "recovered": events,
        "count": len(events),
        "clip_ids": [e.get("clip_id") for e in events if e.get("clip_id")],
        "all_clips_ready": pipeline.all_clips_have_video(),
        "storyboard_approved": bool(raw.get("storyboard_approved")),
        "checkpoint_phase": int(raw.get("phase") or 0),
    }


async def reconcile_cinematic_project(
    project_id: str,
    *,
    frames: bool = True,
    videos: bool = True,
) -> dict:
    from src.core.workflow.pipeline import CinematicPipeline

    pipeline = CinematicPipeline(project_id)
    try:
        events = await pipeline.reconcile_missing_shot_media(frames=frames, videos=videos)
    except Exception as exc:
        return {"ok": False, "error": str(exc), "recovered": []}

    return {
        "ok": True,
        "recovered": events,
        "count": len(events),
        "shot_ids": list({e.get("shot_id") for e in events if e.get("shot_id")}),
        "all_shots_ready": pipeline.all_shots_have_video(),
        "completed_stages": pipeline._load_state().get("completed_stages", []),
    }


async def reconcile_director_output(
    job_id: str,
    *,
    filename_prefix: Optional[str] = None,
) -> dict:
    """Recupera video Director Cinema da disco o history ComfyUI."""
    from src.core.comfyui.pool import ComfyUINodePool
    from src.core.config import get_config
    from src.core.utils.comfyui_outputs import (
        COMFY_REAL_VIDEO_MIN_BYTES,
        download_video_by_prefix_probe,
        is_real_comfy_video,
    )

    cfg = get_config()
    out_dir = cfg.app.data_path / "director"
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / f"director_{job_id}.mp4"

    if is_real_comfy_video(dest):
        return {
            "ok": True,
            "recovered": [{
                "event": "director_done",
                "job_id": job_id,
                "path": str(dest),
                "url": f"/api/director/output/{dest.name}",
                "cached": True,
            }],
            "count": 1,
            "all_ready": True,
        }

    prefixes = []
    if filename_prefix:
        prefixes.append(filename_prefix)
    prefixes.append(f"director_{job_id}")

    pool = ComfyUINodePool()
    client = await pool.get_client()
    errors: list[str] = []
    for prefix in prefixes:
        try:
            await download_video_by_prefix_probe(
                client,
                prefix,
                dest,
                min_video_bytes=COMFY_REAL_VIDEO_MIN_BYTES,
                local_folders=[out_dir],
            )
            if is_real_comfy_video(dest):
                return {
                    "ok": True,
                    "recovered": [{
                        "event": "director_done",
                        "job_id": job_id,
                        "path": str(dest),
                        "url": f"/api/director/output/{dest.name}",
                    }],
                    "count": 1,
                    "all_ready": True,
                }
        except Exception as exc:
            errors.append(f"{prefix}: {exc}")

    return {
        "ok": True,
        "recovered": [],
        "count": 0,
        "all_ready": is_real_comfy_video(dest),
        "errors": errors[:4] if errors else None,
    }
