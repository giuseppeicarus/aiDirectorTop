"""Persistenza job CreateReel — reel_jobs.json per catalogo progetto."""

from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

import structlog
from pydantic import BaseModel

from src.core.config import get_config

log = structlog.get_logger()


class ReelJobRecord(BaseModel):
    job_id: str
    project_id: str
    storage_project_id: str = ""
    created_at: str
    updated_at: str
    status: str
    title: str = ""
    description: str = ""
    reference_count: int = 0
    config: dict
    result: Optional[dict] = None
    error: Optional[str] = None


def _jobs_file(project_id: str) -> Path:
    cfg = get_config()
    base = cfg.app.data_path / "projects" / project_id
    base.mkdir(parents=True, exist_ok=True)
    return base / "reel_jobs.json"


def load_jobs(project_id: str) -> List[ReelJobRecord]:
    p = _jobs_file(project_id)
    if not p.exists():
        return []
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
        return [ReelJobRecord(**j) for j in raw]
    except Exception:
        return []


def upsert_job(record: ReelJobRecord) -> None:
    jobs = load_jobs(record.project_id)
    idx = next((i for i, j in enumerate(jobs) if j.job_id == record.job_id), None)
    if idx is not None:
        jobs[idx] = record
    else:
        jobs.insert(0, record)
    _jobs_file(record.project_id).write_text(
        json.dumps([j.model_dump() for j in jobs], indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def job_storage_project_id(record: ReelJobRecord) -> str:
    from src.core.utils.project_paths import reel_storage_project_id_for_job

    return reel_storage_project_id_for_job(
        record.project_id,
        record.job_id,
        storage_project_id=record.storage_project_id or "",
    )


def remove_job(project_id: str, job_id: str, cleanup_files: bool = False) -> bool:
    jobs = load_jobs(project_id)
    target = next((j for j in jobs if j.job_id == job_id), None)
    if target is None:
        return False
    if cleanup_files:
        storage = job_storage_project_id(target)
        cfg = get_config()
        base = cfg.app.data_path / "projects" / storage
        for name in (f"reel_state_{job_id}.json",):
            p = base / name
            if p.exists():
                p.unlink(missing_ok=True)
    new_jobs = [j for j in jobs if j.job_id != job_id]
    _jobs_file(project_id).write_text(
        json.dumps([j.model_dump() for j in new_jobs], indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    return True


def now_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
