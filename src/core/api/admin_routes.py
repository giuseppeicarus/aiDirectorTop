"""
Admin / maintenance API — bulk purge of projects, reels, trailers.

POST /api/admin/purge
  scope:      "projects" | "reels" | "trailers" | "all"
  keep_media: bool  — if True, copies generated files to media/uploads library

GET /api/admin/stats
  Returns counts + disk usage per category (for the confirmation dialog)
"""

from __future__ import annotations

import json
import shutil
import uuid
from pathlib import Path
from typing import Literal

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.database import get_db
from src.core.models.project import ProjectORM
from src.core.models.media import MediaItemORM
from src.core.utils.project_paths import projects_root

log = structlog.get_logger()
router = APIRouter(prefix="/api/admin", tags=["admin"])

# Extensions considered "generated media" worth preserving
_MEDIA_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm", ".gif", ".mov"}
# Sub-folders inside a project dir that hold generated assets
_ASSET_SUBDIRS = ("frames", "clips", "final", "storyboard")
_HARD_RESET_DIRS = (
    "projects",
    "media",
    "tools",
    "director",
    "music_video",
    "music_video_jobs",
    "uploads",
    "characters",
    "ai-toolkit-training",
    "test_inputs",
)
_HARD_RESET_FILES = (
    "pipeline_audit.jsonl",
    "gen_stats.jsonl",
)


# ── helpers ──────────────────────────────────────────────────────────────────


def _media_uploads_dir() -> Path:
    from src.core.config import get_config
    d = get_config().app.data_path / "media" / "uploads"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _collect_media_files(project_dir: Path) -> list[Path]:
    """All generated media files inside a project folder."""
    files: list[Path] = []
    for subdir in _ASSET_SUBDIRS:
        sub = project_dir / subdir
        if not sub.is_dir():
            continue
        for f in sub.rglob("*"):
            if f.is_file() and f.suffix.lower() in _MEDIA_EXTS:
                files.append(f)
    return files


def _dir_size(path: Path) -> int:
    if not path.is_dir():
        return 0
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def _safe_child(root: Path, name: str) -> Path:
    """Resolve a fixed child and reject any path escaping the app data root."""
    resolved_root = root.expanduser().resolve()
    target = (resolved_root / name).resolve()
    if target.parent != resolved_root:
        raise RuntimeError(f"Percorso reset non valido: {target}")
    return target


def _hard_reset_targets(root: Path) -> tuple[list[Path], list[Path]]:
    directories = [_safe_child(root, name) for name in _HARD_RESET_DIRS]
    files = [_safe_child(root, name) for name in _HARD_RESET_FILES]
    obsidian_projects = (root.expanduser().resolve() / "obsidian-vault" / "Projects").resolve()
    if obsidian_projects.parent.parent == root.expanduser().resolve():
        directories.append(obsidian_projects)
    return directories, files


async def _move_to_library(files: list[Path], db: AsyncSession) -> int:
    """Copy files to the media/uploads library and register in DB."""
    dest_root = _media_uploads_dir()
    moved = 0
    for src in files:
        suffix = src.suffix.lower()
        dest = dest_root / f"{uuid.uuid4().hex}{suffix}"
        try:
            shutil.copy2(src, dest)
        except Exception as exc:
            log.warning("admin_copy_media_failed", src=str(src), error=str(exc))
            continue
        ftype = "video" if suffix in (".mp4", ".webm", ".mov", ".gif") else "image"
        size = dest.stat().st_size if dest.exists() else 0
        item = MediaItemORM(
            id=str(uuid.uuid4()),
            project_id="library",
            project_title="Libreria generica",
            filepath=str(dest),
            filename=dest.name,
            type=ftype,
            size_bytes=size,
            source="library",
        )
        db.add(item)
        moved += 1
    return moved


# ── stats endpoint ────────────────────────────────────────────────────────────


@router.get("/stats")
async def purge_stats(db: AsyncSession = Depends(get_db)):
    """
    Returns counts and disk usage per category.
    Used by the SettingsScreen confirmation dialog to show what will be deleted.
    """
    root = projects_root()

    # Projects (UUID-based dirs)
    proj_result = await db.execute(select(ProjectORM))
    all_projects = proj_result.scalars().all()
    proj_ids = {p.id for p in all_projects}
    proj_bytes = sum(_dir_size(root / pid) for pid in proj_ids if (root / pid).is_dir())

    # Reels — dirs starting with reel_ (exclude reel_standalone)
    reel_dirs = [
        d for d in root.iterdir()
        if d.is_dir() and d.name.startswith("reel_") and d.name != "reel_standalone"
    ]
    reel_bytes = sum(_dir_size(d) for d in reel_dirs)

    # Reel jobs count from all reel_jobs.json files
    reel_job_count = 0
    for jobs_file in root.rglob("reel_jobs.json"):
        try:
            jobs = json.loads(jobs_file.read_text(encoding="utf-8"))
            reel_job_count += len(jobs)
        except Exception:
            pass

    # Trailers — dirs starting with trailer_ (exclude trailer_standalone)
    trailer_dirs = [
        d for d in root.iterdir()
        if d.is_dir() and d.name.startswith("trailer_") and d.name != "trailer_standalone"
    ]
    trailer_bytes = sum(_dir_size(d) for d in trailer_dirs)

    trailer_job_count = 0
    for jobs_file in root.rglob("trailer_jobs.json"):
        try:
            jobs = json.loads(jobs_file.read_text(encoding="utf-8"))
            trailer_job_count += len(jobs)
        except Exception:
            pass

    return {
        "projects": {
            "count": len(all_projects),
            "bytes": proj_bytes,
        },
        "reels": {
            "count": len(reel_dirs),
            "job_count": reel_job_count,
            "bytes": reel_bytes,
        },
        "trailers": {
            "count": len(trailer_dirs),
            "job_count": trailer_job_count,
            "bytes": trailer_bytes,
        },
    }


# ── purge endpoint ────────────────────────────────────────────────────────────


class PurgeRequest(BaseModel):
    scope: Literal["projects", "reels", "trailers", "all"]
    keep_media: bool = True


class HardResetRequest(BaseModel):
    confirmation: str


@router.post("/hard-reset")
async def hard_reset(req: HardResetRequest, db: AsyncSession = Depends(get_db)):
    """
    Physically remove every app-generated project/media artifact.
    Provider configuration, ComfyUI nodes, workflows and downloaded models survive.
    """
    if req.confirmation.strip() != "HARD RESET":
        raise HTTPException(status_code=400, detail="Digitare esattamente HARD RESET")

    from src.core import pipeline_registry
    from src.core.api.pipeline_routes import cancel_all_active_pipelines
    from src.core.config import get_config

    cancelled = await pipeline_registry.cancel_all_jobs()
    cancelled += await cancel_all_active_pipelines()

    media_count = (await db.execute(select(MediaItemORM))).scalars().all()
    project_count = (await db.execute(select(ProjectORM))).scalars().all()
    await db.execute(delete(MediaItemORM))
    await db.execute(delete(ProjectORM))
    await db.commit()

    root = get_config().app.data_path.expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    directories, files = _hard_reset_targets(root)
    bytes_freed = 0
    deleted_paths: list[str] = []

    for path in directories:
        if not path.exists():
            continue
        bytes_freed += _dir_size(path)
        shutil.rmtree(path)
        deleted_paths.append(str(path))

    for path in files:
        if not path.is_file():
            continue
        bytes_freed += path.stat().st_size
        path.unlink()
        deleted_paths.append(str(path))

    # Keep the app immediately usable without requiring a restart.
    for name in ("projects", "media", "tools", "director", "music_video_jobs", "uploads", "characters"):
        _safe_child(root, name).mkdir(parents=True, exist_ok=True)
    _safe_child(root, "media").joinpath("uploads").mkdir(parents=True, exist_ok=True)

    log.warning(
        "admin_hard_reset",
        projects=len(project_count),
        media=len(media_count),
        bytes_freed=bytes_freed,
        cancelled_jobs=cancelled,
    )
    return {
        "ok": True,
        "deleted_projects": len(project_count),
        "deleted_media_records": len(media_count),
        "deleted_paths": len(deleted_paths),
        "bytes_freed": bytes_freed,
        "cancelled_jobs": cancelled,
        "preserved": ["config.yaml", "studio.db", "workflow", "modelli ComfyUI"],
    }


@router.post("/purge")
async def purge_data(req: PurgeRequest, db: AsyncSession = Depends(get_db)):
    """
    Bulk-delete data by scope.
    If keep_media=True, generated files are copied to the media library first.
    """
    root = projects_root()
    result = {
        "deleted_projects": 0,
        "deleted_reels": 0,
        "deleted_trailers": 0,
        "media_moved": 0,
        "media_deleted": 0,
        "bytes_freed": 0,
    }

    do_projects = req.scope in ("projects", "all")
    do_reels    = req.scope in ("reels",    "all")
    do_trailers = req.scope in ("trailers", "all")

    # ── Projects ──────────────────────────────────────────────────────────────
    if do_projects:
        proj_result = await db.execute(select(ProjectORM))
        all_projects = proj_result.scalars().all()

        for project in all_projects:
            pid = project.id
            proj_dir = root / pid

            if req.keep_media:
                files = _collect_media_files(proj_dir)
                moved = await _move_to_library(files, db)
                result["media_moved"] += moved
            else:
                # Count files that will be physically removed with the dir
                for subdir in _ASSET_SUBDIRS:
                    sub = proj_dir / subdir
                    if sub.is_dir():
                        result["media_deleted"] += sum(
                            1 for f in sub.rglob("*")
                            if f.is_file() and f.suffix.lower() in _MEDIA_EXTS
                        )

            # Remove media_items from DB (regardless of keep_media — file is gone)
            await db.execute(
                delete(MediaItemORM).where(MediaItemORM.project_id == pid)
            )
            await db.delete(project)

            # Remove disk folder
            if proj_dir.is_dir():
                result["bytes_freed"] += _dir_size(proj_dir)
                shutil.rmtree(proj_dir, ignore_errors=True)

            result["deleted_projects"] += 1

        log.info("admin_purge_projects", count=result["deleted_projects"])

    # ── Reels ─────────────────────────────────────────────────────────────────
    if do_reels:
        reel_dirs = [
            d for d in root.iterdir()
            if d.is_dir() and d.name.startswith("reel_") and d.name != "reel_standalone"
        ]

        for reel_dir in reel_dirs:
            if req.keep_media:
                files = _collect_media_files(reel_dir)
                moved = await _move_to_library(files, db)
                result["media_moved"] += moved
            else:
                for subdir in _ASSET_SUBDIRS:
                    sub = reel_dir / subdir
                    if sub.is_dir():
                        result["media_deleted"] += sum(
                            1 for f in sub.rglob("*")
                            if f.is_file() and f.suffix.lower() in _MEDIA_EXTS
                        )

            await db.execute(
                delete(MediaItemORM).where(MediaItemORM.project_id == reel_dir.name)
            )
            result["bytes_freed"] += _dir_size(reel_dir)
            shutil.rmtree(reel_dir, ignore_errors=True)
            result["deleted_reels"] += 1

        # Clear reel_jobs.json catalogs
        for jobs_file in root.rglob("reel_jobs.json"):
            try:
                jobs_file.write_text("[]", encoding="utf-8")
            except Exception:
                pass

        log.info("admin_purge_reels", count=result["deleted_reels"])

    # ── Trailers ──────────────────────────────────────────────────────────────
    if do_trailers:
        trailer_dirs = [
            d for d in root.iterdir()
            if d.is_dir() and d.name.startswith("trailer_") and d.name != "trailer_standalone"
        ]

        for trailer_dir in trailer_dirs:
            if req.keep_media:
                files = _collect_media_files(trailer_dir)
                moved = await _move_to_library(files, db)
                result["media_moved"] += moved
            else:
                for subdir in _ASSET_SUBDIRS:
                    sub = trailer_dir / subdir
                    if sub.is_dir():
                        result["media_deleted"] += sum(
                            1 for f in sub.rglob("*")
                            if f.is_file() and f.suffix.lower() in _MEDIA_EXTS
                        )

            await db.execute(
                delete(MediaItemORM).where(MediaItemORM.project_id == trailer_dir.name)
            )
            result["bytes_freed"] += _dir_size(trailer_dir)
            shutil.rmtree(trailer_dir, ignore_errors=True)
            result["deleted_trailers"] += 1

        # Clear trailer_jobs.json catalogs
        for jobs_file in root.rglob("trailer_jobs.json"):
            try:
                jobs_file.write_text("[]", encoding="utf-8")
            except Exception:
                pass

        log.info("admin_purge_trailers", count=result["deleted_trailers"])

    await db.commit()
    return result
