"""
TrailerJobRegistry — persists trailer generation jobs to
  data/projects/{project_id}/trailer_jobs.json
so runs can be listed, restarted, or deleted from the UI.
"""

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


class TrailerJobRecord(BaseModel):
    job_id: str
    project_id: str          # catalogo job (trailer_standalone o UUID progetto)
    storage_project_id: str = ""  # cartella artefatti su disco; vuoto = legacy (project_id)
    created_at: str          # ISO-8601
    updated_at: str
    status: str              # running | awaiting_storyboard | done | failed | cancelled | interrupted
    audio_name: str
    audio_path: str
    config: dict             # TrailerRequest fields (except ids/paths)
    result: Optional[dict] = None
    error: Optional[str] = None


def _jobs_file(project_id: str) -> Path:
    cfg = get_config()
    base = cfg.app.data_path / "projects" / project_id
    base.mkdir(parents=True, exist_ok=True)
    return base / "trailer_jobs.json"


def load_jobs(project_id: str) -> List[TrailerJobRecord]:
    p = _jobs_file(project_id)
    if not p.exists():
        return []
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
        return [TrailerJobRecord(**j) for j in raw]
    except Exception:
        return []


def upsert_job(record: TrailerJobRecord) -> None:
    jobs = load_jobs(record.project_id)
    idx = next((i for i, j in enumerate(jobs) if j.job_id == record.job_id), None)
    if idx is not None:
        jobs[idx] = record
    else:
        jobs.insert(0, record)   # newest first
    _jobs_file(record.project_id).write_text(
        json.dumps([j.model_dump() for j in jobs], indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def _safe_remove_path(path: Path) -> None:
    """Rimuove file o directory senza propagare errori Windows (file aperti, permessi)."""
    if not path.exists():
        return
    try:
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
        else:
            path.unlink(missing_ok=True)
    except OSError as exc:
        log.warning("trailer_cleanup_path_failed", path=str(path), error=str(exc))


def job_storage_project_id(record: TrailerJobRecord) -> str:
    """Cartella disco effettiva per un job (compatibilità job vecchi)."""
    from src.core.utils.project_paths import trailer_storage_project_id_for_job

    return trailer_storage_project_id_for_job(
        record.project_id,
        record.job_id,
        storage_project_id=record.storage_project_id or "",
    )


def _cleanup_job_artifacts(project_id: str, job_id: str, *, storage_project_id: str = "") -> None:
    cfg = get_config()
    base = cfg.app.data_path / "projects" / (storage_project_id or project_id)

    checkpoint = base / f"trailer_state_{job_id}.json"
    clip_ids: list[str] = []
    if checkpoint.exists():
        try:
            data = json.loads(checkpoint.read_text(encoding="utf-8"))
            clip_ids = [
                c.get("clip_id")
                for c in data.get("clips_list", [])
                if c.get("clip_id")
            ]
        except Exception:
            pass
    _safe_remove_path(checkpoint)

    for clip_id in clip_ids:
        for sub in ("frames", "clips", "audio"):
            d = base / sub
            if not d.exists():
                continue
            for pattern in (
                f"{clip_id}_first.png",
                f"{clip_id}_last.png",
                f"{clip_id}_first.upload.jpg",
                f"{clip_id}_last.upload.jpg",
                f"{clip_id}.mp4",
                f"{clip_id}_audio.wav",
            ):
                _safe_remove_path(d / pattern)

    for sub in ("frames", "clips", "audio", "final"):
        d = base / sub
        if not d.exists():
            continue
        for f in d.glob(f"*{job_id}*"):
            _safe_remove_path(f)

    _safe_remove_path(base / "clips" / f"concat_{job_id}.txt")


def remove_job(project_id: str, job_id: str, cleanup_files: bool = False) -> bool:
    jobs = load_jobs(project_id)
    target = next((j for j in jobs if j.job_id == job_id), None)
    if target is None:
        return False

    if cleanup_files and target:
        _cleanup_job_artifacts(
            project_id,
            job_id,
            storage_project_id=job_storage_project_id(target),
        )

    new_jobs = [j for j in jobs if j.job_id != job_id]
    _jobs_file(project_id).write_text(
        json.dumps([j.model_dump() for j in new_jobs], indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    return True


def now_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
