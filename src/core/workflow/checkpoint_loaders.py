"""Carica pipeline reel/trailer da checkpoint per reconcile, regen e dettaglio job."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal, Optional, Tuple

from src.core.config import get_config

PipelineKind = Literal["reel", "trailer"]


def _state_search_ids(catalog_project_id: str, job_id: str, kind: PipelineKind) -> list[str]:
    standalone = "reel_standalone" if kind == "reel" else "trailer_standalone"
    prefix = "reel" if kind == "reel" else "trailer"
    candidates = [
        catalog_project_id,
        standalone,
        f"{prefix}_{job_id}",
        job_id,
    ]
    seen: set[str] = set()
    out: list[str] = []
    for pid in candidates:
        if pid and pid not in seen:
            seen.add(pid)
            out.append(pid)
    return out


def find_job_checkpoint(
    catalog_project_id: str,
    job_id: str,
    kind: PipelineKind,
) -> Optional[Path]:
    cfg = get_config()
    fname = f"{'reel' if kind == 'reel' else 'trailer'}_state_{job_id}.json"
    for pid in _state_search_ids(catalog_project_id, job_id, kind):
        p = cfg.app.data_path / "projects" / pid / fname
        if p.is_file():
            return p
    return None


def _find_job_record(catalog_project_id: str, job_id: str, kind: PipelineKind):
    if kind == "reel":
        from src.core.workflow.reel_jobs import load_jobs

        candidates = _state_search_ids(catalog_project_id, job_id, kind)
    else:
        from src.core.workflow.trailer_jobs import load_jobs

        candidates = _state_search_ids(catalog_project_id, job_id, kind)

    seen: set[str] = set()
    for cat in candidates:
        if not cat or cat in seen:
            continue
        seen.add(cat)
        hit = next((j for j in load_jobs(cat) if j.job_id == job_id), None)
        if hit:
            return hit
    return None


def load_job_pipeline_from_checkpoint(
    catalog_project_id: str,
    job_id: str,
    kind: PipelineKind,
) -> Tuple[Any, Optional[Path], Optional[dict]]:
    """
    Istanzia ReelPipeline o TrailerPipeline da checkpoint.
    Returns (pipeline, state_path, raw_dict) or (None, None, None).
    """
    state_path = find_job_checkpoint(catalog_project_id, job_id, kind)
    if not state_path:
        return None, None, None

    raw = json.loads(state_path.read_text(encoding="utf-8"))
    job_rec = _find_job_record(catalog_project_id, job_id, kind)

    cfg = dict(job_rec.config) if job_rec else {}
    if job_rec:
        if kind == "reel":
            cfg.setdefault("description", getattr(job_rec, "description", ""))
            cfg.setdefault("title", getattr(job_rec, "title", ""))
        else:
            cfg.setdefault("audio_name", getattr(job_rec, "audio_name", ""))
    cfg["project_id"] = catalog_project_id
    cfg["resume_job_id"] = job_id
    if kind == "reel":
        cfg["description"] = cfg.get("description") or raw.get("reel_description") or ""
        cfg.setdefault("duration_sec", 30)
        cfg.setdefault("reference_image_paths", [])
        from src.core.workflow.reel_pipeline import ReelPipeline, ReelRequest

        pipeline = ReelPipeline(ReelRequest(**cfg))
    else:
        from src.core.workflow.trailer_pipeline import TrailerPipeline, TrailerRequest

        pipeline = TrailerPipeline(TrailerRequest(**cfg))

    pipeline.job_id = job_id
    storage_id = state_path.parent.name
    pipeline._storage_project_id = storage_id
    cfg_root = get_config()
    pipeline._storyboard_dir = cfg_root.app.data_path / "projects" / storage_id / "storyboard"
    pipeline._frames_dir = cfg_root.app.data_path / "projects" / storage_id / "frames"
    pipeline._clips_dir = cfg_root.app.data_path / "projects" / storage_id / "clips"
    for d in (pipeline._storyboard_dir, pipeline._frames_dir, pipeline._clips_dir):
        d.mkdir(parents=True, exist_ok=True)

    if not pipeline._load_checkpoint():
        from src.core.workflow.trailer_pipeline import TrailerClip

        if kind == "reel":
            pipeline._vision = raw.get("vision") or {}
        pipeline._director_narrative = raw.get("director_narrative") or {}
        pipeline._clips_list = [TrailerClip(**c) for c in raw.get("clips_list", [])]
        vp = raw.get("visual_plans")
        pipeline._visual_plans_cache = vp if isinstance(vp, dict) else {}

    return pipeline, state_path, raw
