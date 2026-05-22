"""
Utility condivisa per registrare file generati nella Media Library.
Il prompt di generazione è sempre persistito in MediaItemORM.description.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any, List, Optional

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.database import AsyncSessionLocal
from src.core.models.media import MediaItemORM

log = structlog.get_logger()

GENERATION_PROMPT_MAX = 2048

# Progetti virtuali senza checkpoint shot/clip
_VIRTUAL_PROJECT_IDS = frozenset({"__tools__", "__library__", "__director__"})


def normalize_generation_prompt(
    *texts: Optional[str],
    tags: Optional[List[str]] = None,
) -> Optional[str]:
    """Primo testo non vuoto, oppure tag ``prompt:...``."""
    for text in texts:
        if text is None:
            continue
        s = str(text).strip()
        if s:
            return s[:GENERATION_PROMPT_MAX]
    if tags:
        for tag in tags:
            if isinstance(tag, str) and tag.startswith("prompt:"):
                p = tag[7:].strip()
                if p:
                    return p[:GENERATION_PROMPT_MAX]
    return None


def prompt_for_cinematic_shot(
    shot: Any,
    media_type: str,
    frame_type: Optional[str] = None,
) -> Optional[str]:
    """Estrae il prompt da CinematicShot (o dict shot list)."""
    if shot is None:
        return None

    def _get(obj: Any, key: str, default: Any = "") -> Any:
        if isinstance(obj, dict):
            return obj.get(key, default)
        return getattr(obj, key, default)

    if media_type == "video":
        return normalize_generation_prompt(
            _get(shot, "ltx_global_prompt"),
            _get(shot, "motion_prompt"),
            _get(shot, "scene_description"),
        )

    ft = frame_type or "first"
    if ft == "last":
        lf = _get(shot, "last_frame") or {}
        if isinstance(lf, dict):
            lp = lf.get("prompt")
        else:
            lp = getattr(lf, "prompt", None) if lf else None
        return normalize_generation_prompt(lp, _get(shot, "scene_description"))

    ff = _get(shot, "first_frame") or {}
    if isinstance(ff, dict):
        fp = ff.get("prompt")
    else:
        fp = getattr(ff, "prompt", None) if ff else None
    return normalize_generation_prompt(fp, _get(shot, "scene_description"))


def prompt_for_trailer_clip(
    clip: Any,
    media_type: str,
    asset_role: Optional[str] = None,
) -> Optional[str]:
    """Estrae il prompt da TrailerClip / reel clip (oggetto o dict)."""

    def _get(obj: Any, key: str, default: Any = "") -> Any:
        if isinstance(obj, dict):
            return obj.get(key, default)
        return getattr(obj, key, default)

    if media_type == "video" or asset_role == "clip":
        return normalize_generation_prompt(
            _get(clip, "ltx_video_prompt"),
            _get(clip, "motion_prompt"),
            _get(clip, "scene_prompt"),
        )
    if asset_role == "last" or _get(clip, "frame_type") == "last":
        return normalize_generation_prompt(
            _get(clip, "last_frame_prompt"),
            _get(clip, "scene_prompt"),
        )
    return normalize_generation_prompt(
        _get(clip, "first_frame_prompt"),
        _get(clip, "scene_prompt"),
    )


def prompt_for_shots_summary(shots: List[Any], max_items: int = 5) -> Optional[str]:
    """Riassunto prompt per video assembly / LTX full."""
    parts: list[str] = []
    for shot in (shots or [])[:max_items]:
        if isinstance(shot, dict):
            sid = shot.get("shot_id", "")
            p = (
                shot.get("ltx_global_prompt")
                or shot.get("motion_prompt")
                or shot.get("scene_description")
            )
        else:
            sid = getattr(shot, "shot_id", "")
            p = (
                getattr(shot, "ltx_global_prompt", None)
                or getattr(shot, "motion_prompt", None)
                or getattr(shot, "scene_description", None)
            )
        if p and str(p).strip():
            parts.append(f"{sid}: {str(p).strip()[:500]}")
    return normalize_generation_prompt("\n---\n".join(parts)) if parts else None


def prompt_for_assembly_final(
    project_title: str,
    project_input: Optional[dict] = None,
    shots: Optional[List[Any]] = None,
    logline: Optional[str] = None,
) -> str:
    """Prompt descrittivo per output assembly / finale."""
    if logline and str(logline).strip():
        return normalize_generation_prompt(f"Assemblaggio finale — {logline}") or ""
    if project_input:
        brief = (project_input.get("story_brief") or project_input.get("title") or "").strip()
        if brief:
            return normalize_generation_prompt(f"Assemblaggio finale — {brief}") or ""
    summary = prompt_for_shots_summary(shots or [])
    if summary:
        return summary
    title = (project_title or "progetto").strip()
    return normalize_generation_prompt(f"Assemblaggio finale — {title}") or f"Assemblaggio finale — {title}"


def prompt_for_director_timeline(global_prompt: str, clips: List[Any]) -> str:
    """Timeline Director Cinema: global + prompt per clip."""
    parts: list[str] = []
    gp = (global_prompt or "").strip()
    if gp:
        parts.append(gp)
    for clip in clips or []:
        if isinstance(clip, dict):
            cid, p = clip.get("id", "clip"), clip.get("prompt", "")
        else:
            cid, p = getattr(clip, "id", "clip"), getattr(clip, "prompt", "")
        p = str(p or "").strip()
        if p:
            parts.append(f"[{cid}] {p}")
    return normalize_generation_prompt("\n".join(parts)) or gp or "Director Cinema"


async def _resolve_prompt_fallback(
    *,
    project_id: str,
    shot_id: Optional[str],
    frame_type: Optional[str],
    media_type: str,
    tags: Optional[List[str]],
    filename: str,
) -> Optional[str]:
    if not project_id or project_id in _VIRTUAL_PROJECT_IDS:
        return None
    try:
        from src.core.utils.media_prompt_resolver import resolve_fields

        return resolve_fields(
            project_id=project_id,
            shot_id=shot_id,
            frame_type=frame_type,
            media_type=media_type,
            tags=json.dumps(tags) if tags else None,
            filename=filename,
        ) or None
    except Exception as exc:
        log.debug("media_prompt_fallback_failed", project_id=project_id, error=str(exc))
        return None


async def register_media(
    filepath: Path,
    media_type: str,
    project_id: str,
    project_title: str,
    source: str = "generated",
    shot_id: Optional[str] = None,
    frame_type: Optional[str] = None,
    tags: Optional[List[str]] = None,
    description: Optional[str] = None,
    generation_prompt: Optional[str] = None,
) -> str:
    """
    Registra un file generato nella media library.
    ``generation_prompt`` (o ``description``) viene sempre salvato in DB se disponibile.

    Ritorna l'id del MediaItemORM creato, oppure stringa vuota in caso di errore.
    """
    try:
        size_bytes = filepath.stat().st_size if filepath.exists() else 0

        width, height = 0, 0
        if media_type == "image" and filepath.exists():
            try:
                from PIL import Image as PILImage  # type: ignore
                with PILImage.open(filepath) as img:
                    width, height = img.size
            except Exception:
                pass

        stored_prompt = normalize_generation_prompt(generation_prompt, description, tags=tags)
        if not stored_prompt:
            stored_prompt = await _resolve_prompt_fallback(
                project_id=project_id,
                shot_id=shot_id,
                frame_type=frame_type,
                media_type=media_type,
                tags=tags,
                filename=filepath.name,
            )

        if not stored_prompt:
            log.warning(
                "media_register_missing_prompt",
                filepath=str(filepath),
                project_id=project_id,
                shot_id=shot_id,
                media_type=media_type,
                source=source,
            )

        tags_json = json.dumps(tags) if tags else None
        item_id = str(uuid.uuid4())

        orm = MediaItemORM(
            id=item_id,
            filename=filepath.name,
            filepath=str(filepath),
            type=media_type,
            project_id=project_id,
            project_title=project_title,
            shot_id=shot_id,
            frame_type=frame_type,
            width=width,
            height=height,
            size_bytes=size_bytes,
            source=source,
            tags=tags_json,
            description=stored_prompt,
        )

        async with AsyncSessionLocal() as session:
            session.add(orm)
            await session.commit()

        log.debug(
            "media_registered",
            id=item_id,
            filepath=str(filepath),
            project_id=project_id,
            has_prompt=bool(stored_prompt),
        )
        return item_id

    except Exception as exc:
        log.warning(
            "media_register_failed",
            filepath=str(filepath),
            project_id=project_id,
            error=str(exc),
        )
        return ""


def _file_exists(filepath: str) -> bool:
    """True se il file media esiste su disco."""
    if not filepath or not str(filepath).strip():
        return False
    return Path(filepath).is_file()


async def cleanup_missing_media(db: AsyncSession) -> dict[str, Any]:
    """
    Rimuove dal DB i media il cui filepath non esiste più su disco.
    Elimina anche eventuali thumbnail .thumb.jpg orfane.
    """
    result = await db.execute(select(MediaItemORM))
    items = result.scalars().all()
    removed: list[dict[str, str]] = []

    for item in items:
        if _file_exists(item.filepath):
            continue
        path = Path(item.filepath) if item.filepath else None
        if path is not None:
            thumb = Path(str(path) + ".thumb.jpg")
            if thumb.is_file():
                try:
                    thumb.unlink()
                except OSError as exc:
                    log.warning("media_thumb_unlink_failed", path=str(thumb), error=str(exc))
        removed.append({
            "id": item.id,
            "filename": item.filename,
            "filepath": item.filepath or "",
        })
        await db.delete(item)

    if removed:
        log.info("media_cleanup_orphans", count=len(removed))
    return {"removed_count": len(removed), "removed": removed}
