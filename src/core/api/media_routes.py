"""
API routes per la Media Library.
Gestisce lista, eliminazione, apertura, upload e assegnazione di immagini/video/audio generati.
"""

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import List, Optional
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from src.core.utils.http_files import file_response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.config import get_config
from src.core.database import get_db
from src.core.models.media import MediaItemORM, MediaItemSchema, MediaUploadResult
from src.core.utils.media_registry import cleanup_missing_media

router = APIRouter()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _detect_media_type(content_type: str, filename: str) -> str:
    """Return 'image', 'video', or 'audio' based on MIME type or file extension."""
    ct = (content_type or "").lower()
    if ct.startswith("image/"):
        return "image"
    if ct.startswith("video/"):
        return "video"
    if ct.startswith("audio/"):
        return "audio"

    # Fallback: extension-based detection
    ext = Path(filename).suffix.lower()
    image_exts = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif", ".avif"}
    video_exts = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv", ".m4v"}
    audio_exts = {".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a", ".opus", ".wma"}

    if ext in image_exts:
        return "image"
    if ext in video_exts:
        return "video"
    if ext in audio_exts:
        return "audio"

    return ""


# ---------------------------------------------------------------------------
# File serve endpoints (placed before parameterised routes to avoid shadowing)
# ---------------------------------------------------------------------------

@router.get("/file/{item_id}")
async def serve_file(item_id: str, db: AsyncSession = Depends(get_db)):
    """Serve the raw file bytes for a media item."""
    item = await db.get(MediaItemORM, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Media non trovato")

    path = Path(item.filepath)
    if not path.exists():
        raise HTTPException(status_code=404, detail="File non trovato su disco")

    return file_response(path, inline=True)


@router.get("/thumb/{item_id}")
async def serve_thumb(item_id: str, db: AsyncSession = Depends(get_db)):
    """
    Serve a 400×300 thumbnail for image items (cached on disk).
    Falls back to the original file for non-image types or when Pillow is unavailable.
    """
    item = await db.get(MediaItemORM, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Media non trovato")

    path = Path(item.filepath)

    # Only generate thumbs for images
    if item.type != "image":
        return file_response(path, inline=True)
    if not path.exists():
        raise HTTPException(status_code=404, detail="File non trovato su disco")

    thumb_path = Path(str(path) + ".thumb.jpg")

    if not thumb_path.exists():
        try:
            from PIL import Image as PILImage

            with PILImage.open(path) as img:
                img.thumbnail((400, 300))
                img = img.convert("RGB")
                img.save(str(thumb_path), "JPEG", quality=80)
        except (ImportError, Exception):
            return file_response(path, inline=True)

    return file_response(thumb_path, inline=True)


# ---------------------------------------------------------------------------
# Upload
# ---------------------------------------------------------------------------

@router.post("/upload", response_model=MediaUploadResult)
async def upload_media(
    file: UploadFile = File(...),
    tags: str = Form(""),
    description: str = Form(""),
    project_id: str = Form("__library__"),
    db: AsyncSession = Depends(get_db),
):
    """Upload a media file (image / video / audio) to the library."""
    media_type = _detect_media_type(file.content_type or "", file.filename or "")
    if not media_type:
        raise HTTPException(
            status_code=400,
            detail="Unsupported file type. Only image, video, and audio files are accepted.",
        )

    cfg = get_config()
    uploads_dir: Path = cfg.app.data_path / "media" / "uploads"
    uploads_dir.mkdir(parents=True, exist_ok=True)

    unique_name = f"{uuid4().hex[:8]}-{file.filename}"
    dest = uploads_dir / unique_name

    # Save file to disk
    content = await file.read()
    dest.write_bytes(content)

    # Gather metadata
    width, height = 0, 0
    duration_sec: Optional[float] = None

    if media_type == "image":
        try:
            from PIL import Image as PILImage

            with PILImage.open(dest) as img:
                width, height = img.size
        except (ImportError, Exception):
            pass

    size_bytes = dest.stat().st_size

    project_title = "Libreria" if project_id == "__library__" else ""

    tag_list = [t.strip() for t in tags.split(",") if t.strip()]
    tags_json = json.dumps(tag_list)

    orm = MediaItemORM(
        id=str(uuid4()),
        filename=file.filename,
        filepath=str(dest),
        type=media_type,
        source="uploaded",
        project_id=project_id,
        project_title=project_title,
        tags=tags_json,
        description=description,
        width=width,
        height=height,
        size_bytes=size_bytes,
        duration_sec=duration_sec,
    )
    db.add(orm)
    await db.flush()

    return MediaUploadResult(
        id=orm.id,
        filename=orm.filename,
        type=orm.type,
        source=orm.source,
        filepath=orm.filepath,
        width=orm.width,
        height=orm.height,
        size_bytes=orm.size_bytes,
        duration_sec=orm.duration_sec,
        created_at=orm.created_at,
    )


# ---------------------------------------------------------------------------
# Shots list (for the assign modal)
# ---------------------------------------------------------------------------

@router.get("/shots/{project_id}")
async def list_shots(project_id: str):
    """Return a minimal list of shots from the project's pipeline state."""
    cfg = get_config()
    state_path = cfg.app.data_path / "projects" / project_id / "pipeline_state.json"

    if not state_path.exists():
        return []

    try:
        with state_path.open("r", encoding="utf-8") as fh:
            state = json.load(fh)
        shot_list = state.get("data", {}).get("shot_list", [])
        return [
            {
                "shot_id": s.get("shot_id"),
                "scene_description": s.get("scene_description", ""),
                "location": s.get("location", ""),
            }
            for s in shot_list
        ]
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Existing list + stats endpoints
# ---------------------------------------------------------------------------

@router.post("/cleanup")
async def cleanup_media(db: AsyncSession = Depends(get_db)):
    """Elimina dal DB i media senza file su disco (record orfani)."""
    return await cleanup_missing_media(db)


@router.post("/scan")
async def scan_and_register_media(
    project_id: Optional[str] = Query(None, description="Scansiona solo questo progetto (ometti per tutti)"),
    db: AsyncSession = Depends(get_db),
):
    """
    Scansiona le cartelle frames/clips/final di tutti i progetti (o uno specifico)
    e registra nel DB i file media già presenti su disco ma non ancora indicizzati.
    Utile per recuperare media generati da pipeline che non hanno completato la registrazione.
    """
    import json as _json

    cfg = get_config()
    projects_root = cfg.app.data_path / "projects"
    if not projects_root.exists():
        return {"scanned": 0, "registered": 0, "skipped": 0}

    IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}
    VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm", ".avi"}

    # Fetch existing filepaths already in DB (to skip duplicates)
    from sqlalchemy import select as sa_select
    result = await db.execute(sa_select(MediaItemORM.filepath))
    known_paths: set[str] = {row[0] for row in result if row[0]}

    dirs_to_scan: list[Path] = []
    if project_id:
        candidate = projects_root / project_id
        if candidate.is_dir():
            dirs_to_scan.append(candidate)
    else:
        dirs_to_scan = [p for p in projects_root.iterdir() if p.is_dir()]

    scanned = registered = skipped = 0

    for proj_dir in dirs_to_scan:
        pid = proj_dir.name
        # Derive project title from project.json or pipeline_state.json
        ptitle = pid
        meta_path = proj_dir / "project.json"
        if meta_path.exists():
            try:
                meta = _json.loads(meta_path.read_text(encoding="utf-8"))
                ptitle = meta.get("title") or pid
            except Exception:
                pass
        else:
            state_path = proj_dir / "pipeline_state.json"
            if state_path.exists():
                try:
                    st = _json.loads(state_path.read_text(encoding="utf-8"))
                    arc = st.get("data", {}).get("story_arc", {})
                    ptitle = arc.get("title") or pid
                except Exception:
                    pass

        for subdir in ("frames", "clips", "final", "storyboard"):
            folder = proj_dir / subdir
            if not folder.is_dir():
                continue
            for fpath in folder.iterdir():
                if not fpath.is_file():
                    continue
                ext = fpath.suffix.lower()
                if ext not in IMAGE_EXT and ext not in VIDEO_EXT:
                    continue
                if ext in (".thumb.jpg",) or fpath.name.endswith(".thumb.jpg"):
                    continue
                scanned += 1
                norm = str(fpath.resolve())
                if norm in known_paths or str(fpath) in known_paths:
                    skipped += 1
                    continue

                mtype = "image" if ext in IMAGE_EXT else "video"
                width = height = 0
                if mtype == "image":
                    try:
                        from PIL import Image as PILImage
                        with PILImage.open(fpath) as img:
                            width, height = img.size
                    except Exception:
                        pass

                # Infer shot_id and frame_type from filename pattern: shot_NNN_NNN_first.png
                shot_id = frame_type = None
                stem = fpath.stem
                for ft in ("first", "last"):
                    if stem.endswith(f"_{ft}"):
                        frame_type = ft
                        shot_id = stem[: -(len(ft) + 1)]
                        break
                if frame_type is None and subdir == "final":
                    frame_type = "final"

                item = MediaItemORM(
                    id=str(uuid4()),
                    filename=fpath.name,
                    filepath=str(fpath),
                    type=mtype,
                    project_id=pid,
                    project_title=ptitle,
                    shot_id=shot_id,
                    frame_type=frame_type,
                    width=width,
                    height=height,
                    size_bytes=fpath.stat().st_size,
                    source="generated",
                    tags=_json.dumps(["scan", pid]),
                )
                db.add(item)
                known_paths.add(str(fpath))
                registered += 1

    await db.flush()
    return {"scanned": scanned, "registered": registered, "skipped": skipped}


@router.get("/", response_model=List[MediaItemSchema])
async def list_media(
    type: Optional[str]       = Query(None, description="image | video | audio"),
    project_id: Optional[str] = Query(None),
    db: AsyncSession           = Depends(get_db),
):
    """Lista tutti i media con filtri opzionali per tipo e progetto."""
    await cleanup_missing_media(db)

    query = select(MediaItemORM).order_by(MediaItemORM.created_at.desc())

    if type in ("image", "video", "audio"):
        query = query.where(MediaItemORM.type == type)
    if project_id:
        query = query.where(MediaItemORM.project_id == project_id)

    result = await db.execute(query)
    return result.scalars().all()


@router.get("/stats")
async def media_stats(db: AsyncSession = Depends(get_db)):
    """Restituisce statistiche aggregate della media library."""
    result = await db.execute(select(MediaItemORM))
    items = result.scalars().all()

    total_size = sum(i.size_bytes for i in items)
    return {
        "total":      len(items),
        "images":     sum(1 for i in items if i.type == "image"),
        "videos":     sum(1 for i in items if i.type == "video"),
        "audios":     sum(1 for i in items if i.type == "audio"),
        "size_bytes": total_size,
        "size_gb":    round(total_size / 1024**3, 2),
        "projects":   list({i.project_id for i in items}),
    }


# ---------------------------------------------------------------------------
# Patch (tags / description)
# ---------------------------------------------------------------------------

class MediaPatch(BaseModel):
    tags: Optional[str] = None
    description: Optional[str] = None


@router.patch("/{item_id}", response_model=MediaItemSchema)
async def patch_media(
    item_id: str,
    body: MediaPatch,
    db: AsyncSession = Depends(get_db),
):
    """Update tags and/or description for a media item."""
    item = await db.get(MediaItemORM, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Media non trovato")

    if body.tags is not None:
        item.tags = body.tags
    if body.description is not None:
        item.description = body.description

    await db.flush()
    return item


# ---------------------------------------------------------------------------
# Assign to shot slot
# ---------------------------------------------------------------------------

class AssignRequest(BaseModel):
    project_id: str
    shot_id: str
    slot: str  # "first_frame" | "last_frame" | "clip"


@router.post("/{item_id}/assign")
async def assign_to_shot(
    item_id: str,
    body: AssignRequest,
    db: AsyncSession = Depends(get_db),
):
    """Assign a media item to a project shot's first_frame / last_frame / clip slot."""
    item = await db.get(MediaItemORM, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Media non trovato")

    cfg = get_config()
    state_path = cfg.app.data_path / "projects" / body.project_id / "pipeline_state.json"

    if not state_path.exists():
        return {"ok": False, "error": "Pipeline state not found"}

    with state_path.open("r", encoding="utf-8") as fh:
        state = json.load(fh)

    shot_list = state.get("data", {}).get("shot_list", [])
    shot = next((s for s in shot_list if s.get("shot_id") == body.shot_id), None)

    if shot is None:
        return {"ok": False, "error": f"Shot {body.shot_id} not found"}

    if body.slot == "first_frame":
        if not isinstance(shot.get("first_frame"), dict):
            shot["first_frame"] = {}
        shot["first_frame"]["image_path"] = item.filepath
    elif body.slot == "last_frame":
        if not isinstance(shot.get("last_frame"), dict):
            shot["last_frame"] = {}
        shot["last_frame"]["image_path"] = item.filepath
    elif body.slot == "clip":
        shot["clip_path"] = item.filepath
    else:
        raise HTTPException(status_code=400, detail=f"Unknown slot '{body.slot}'. Use first_frame, last_frame, or clip.")

    with state_path.open("w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2, ensure_ascii=False)

    return {"ok": True, "shot_id": body.shot_id, "slot": body.slot, "filepath": item.filepath}


# ---------------------------------------------------------------------------
# Delete
# ---------------------------------------------------------------------------

@router.delete("/{item_id}", status_code=204)
async def delete_media(item_id: str, db: AsyncSession = Depends(get_db)):
    """Elimina un media item dal DB e dal filesystem."""
    item = await db.get(MediaItemORM, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Media non trovato")

    path = Path(item.filepath)
    if path.exists():
        path.unlink()

    # Also remove cached thumbnail if present
    thumb = Path(str(path) + ".thumb.jpg")
    if thumb.exists():
        thumb.unlink()

    await db.delete(item)


# ---------------------------------------------------------------------------
# Open folder / open file
# ---------------------------------------------------------------------------

@router.post("/{item_id}/open-folder")
async def open_folder(item_id: str, db: AsyncSession = Depends(get_db)):
    """Apre la cartella contenente il file nel file manager di sistema."""
    item = await db.get(MediaItemORM, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Media non trovato")

    folder = str(Path(item.filepath).parent)

    if sys.platform == "win32":
        subprocess.Popen(["explorer", folder])
    elif sys.platform == "darwin":
        subprocess.Popen(["open", folder])
    else:
        subprocess.Popen(["xdg-open", folder])

    return {"opened": folder}


@router.post("/{item_id}/open-file")
async def open_file(item_id: str, db: AsyncSession = Depends(get_db)):
    """Apre il file con l'applicazione di sistema predefinita."""
    item = await db.get(MediaItemORM, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Media non trovato")

    filepath = item.filepath
    if not Path(filepath).exists():
        raise HTTPException(status_code=404, detail="File non trovato su disco")

    if sys.platform == "win32":
        os.startfile(filepath)
    elif sys.platform == "darwin":
        subprocess.Popen(["open", filepath])
    else:
        subprocess.Popen(["xdg-open", filepath])

    return {"opened": filepath}


# ---------------------------------------------------------------------------
# Register (internal pipeline use)
# ---------------------------------------------------------------------------

@router.post("/register")
async def register_media(item: MediaItemSchema, db: AsyncSession = Depends(get_db)):
    """
    Registra un nuovo media item nel DB.
    Chiamato internamente dalla pipeline dopo aver salvato un file.
    """
    orm = MediaItemORM(**item.model_dump(exclude={"size_mb"}))
    db.add(orm)
    await db.flush()
    return item
