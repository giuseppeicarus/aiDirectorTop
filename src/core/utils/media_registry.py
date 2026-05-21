"""
Utility condivisa per registrare file generati nella Media Library.
Progettata per essere chiamata dalla pipeline e dai routes dei tool
senza bloccare il flusso principale in caso di errore.
"""

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


async def register_media(
    filepath: Path,
    media_type: str,
    project_id: str,
    project_title: str,
    source: str = "generated",
    shot_id: Optional[str] = None,
    frame_type: Optional[str] = None,
    tags: Optional[List[str]] = None,
) -> str:
    """
    Registra un file generato nella media library.
    Ritorna l'id del MediaItemORM creato, oppure stringa vuota in caso di errore.

    Gestisce le eccezioni silenziosamente — la pipeline non deve crashare
    per un fallimento della registrazione media.
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
        )

        async with AsyncSessionLocal() as session:
            session.add(orm)
            await session.commit()

        log.debug(
            "media_registered",
            id=item_id,
            filepath=str(filepath),
            project_id=project_id,
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
