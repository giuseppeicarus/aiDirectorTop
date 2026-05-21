"""
API routes per la gestione dei progetti.
"""

import json
import shutil
from pathlib import Path
from typing import List

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.config import get_config
from src.core.database import get_db
from src.core.models.project import ProjectORM, ProjectCreate, ProjectResponse
from src.core.models.media import MediaItemORM
from src.core.utils.project_paths import ensure_project_directory, project_base_path

router = APIRouter()

AUDIO_EXTENSIONS = {".mp3", ".wav", ".m4a", ".ogg", ".flac", ".aac"}


@router.post("/", response_model=ProjectResponse, status_code=201)
async def create_project(data: ProjectCreate, db: AsyncSession = Depends(get_db)):
    project = ProjectORM(**data.model_dump())
    db.add(project)
    await db.flush()
    await db.refresh(project)
    # Create project directory structure
    cfg = get_config()
    base = cfg.app.data_path / "projects" / project.id
    for d in ("frames", "clips", "final", "audio"):
        (base / d).mkdir(parents=True, exist_ok=True)
    return project


@router.get("/", response_model=List[ProjectResponse])
async def list_projects(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(ProjectORM).order_by(ProjectORM.created_at.desc()))
    return result.scalars().all()


@router.get("/{project_id}", response_model=ProjectResponse)
async def get_project(project_id: str, db: AsyncSession = Depends(get_db)):
    project = await db.get(ProjectORM, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Progetto non trovato")
    # Ripara cartelle mancanti (progetti creati prima o DB migrato)
    if not project_base_path(project_id).is_dir():
        ensure_project_directory(project_id, title=project.title)
    return project


@router.get("/{project_id}/media-count")
async def get_project_media_count(project_id: str, db: AsyncSession = Depends(get_db)):
    """Conta e somma la dimensione dei media generati per un progetto."""
    result = await db.execute(
        select(func.count(MediaItemORM.id), func.coalesce(func.sum(MediaItemORM.size_bytes), 0))
        .where(MediaItemORM.project_id == project_id)
    )
    count, size_bytes = result.one()
    return {"count": count, "size_bytes": size_bytes}


@router.delete("/{project_id}", status_code=204)
async def delete_project(
    project_id: str,
    delete_media: bool = Query(False),
    db: AsyncSession = Depends(get_db),
):
    project = await db.get(ProjectORM, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Progetto non trovato")

    if delete_media:
        # Elimina tutti i MediaItemORM del progetto (file fisici + thumbnail)
        media_result = await db.execute(
            select(MediaItemORM).where(MediaItemORM.project_id == project_id)
        )
        media_items = media_result.scalars().all()
        for item in media_items:
            fpath = Path(item.filepath)
            if fpath.exists():
                try:
                    fpath.unlink()
                except Exception:
                    pass
            thumb = Path(str(fpath) + ".thumb.jpg")
            if thumb.exists():
                try:
                    thumb.unlink()
                except Exception:
                    pass
            await db.delete(item)

    # Elimina la cartella del progetto
    cfg = get_config()
    project_dir = cfg.app.data_path / "projects" / project_id
    if project_dir.exists():
        shutil.rmtree(project_dir, ignore_errors=True)

    await db.delete(project)


@router.get("/{project_id}/storyboard")
async def get_storyboard(project_id: str, db: AsyncSession = Depends(get_db)):
    project = await db.get(ProjectORM, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Progetto non trovato")
    if project.storyboard_json:
        return json.loads(project.storyboard_json)
    # Fallback: return unconfirmed storyboard from pipeline_state.json
    cfg = get_config()
    state_path = cfg.app.data_path / "projects" / project_id / "pipeline_state.json"
    if state_path.exists():
        state = json.loads(state_path.read_text(encoding="utf-8"))
        data = state.get("data", {})
        if data.get("story_arc") or data.get("shot_list"):
            return {
                "_confirmed": False,
                "story_analysis": data.get("story_analysis"),
                "story_arc": data.get("story_arc"),
                "shot_list": data.get("shot_list", []),
                "continuity_report": data.get("continuity_report"),
                "completed_stages": state.get("completed_stages", []),
            }
    raise HTTPException(status_code=404, detail="Storyboard non ancora generato")


@router.post("/{project_id}/storyboard/confirm")
async def confirm_storyboard(project_id: str, db: AsyncSession = Depends(get_db)):
    """Conferma lo storyboard: lo salva nel DB e aggiorna lo status del progetto."""
    project = await db.get(ProjectORM, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Progetto non trovato")

    # Se già confermato, OK idempotente
    if project.storyboard_json:
        return {"ok": True, "status": project.status, "already_confirmed": True}

    cfg = get_config()
    state_path = cfg.app.data_path / "projects" / project_id / "pipeline_state.json"
    if not state_path.exists():
        raise HTTPException(status_code=404, detail="Nessuno storyboard da confermare")

    text = state_path.read_text(encoding="utf-8").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Pipeline state vuoto")

    state = json.loads(text)
    data = state.get("data", {})
    if not (data.get("story_arc") or data.get("shot_list")):
        raise HTTPException(status_code=400, detail="Storyboard non ancora generato")

    confirmed = {
        "_confirmed": True,
        "story_analysis":    data.get("story_analysis"),
        "story_arc":         data.get("story_arc"),
        "shot_list":         data.get("shot_list", []),
        "continuity_report": data.get("continuity_report"),
        "completed_stages":  state.get("completed_stages", []),
    }
    project.storyboard_json = json.dumps(confirmed, ensure_ascii=False)
    project.status = "storyboard_confirmed"
    await db.flush()

    return {"ok": True, "status": "storyboard_confirmed"}


@router.get("/{project_id}/frames/{filename}")
async def serve_frame(project_id: str, filename: str):
    """Serve le immagini dei frame generate dalla pipeline."""
    cfg = get_config()
    frame_path = cfg.app.data_path / "projects" / project_id / "frames" / filename
    if not frame_path.exists():
        raise HTTPException(status_code=404, detail="Frame non trovato")
    from fastapi.responses import FileResponse
    return FileResponse(str(frame_path))


@router.post("/{project_id}/audio")
async def upload_audio(
    project_id: str,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
):
    """Salva il file audio del progetto e aggiorna il path nel DB."""
    project = await db.get(ProjectORM, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Progetto non trovato")

    suffix = Path(file.filename or "audio.mp3").suffix.lower()
    if suffix not in AUDIO_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Formato non supportato: {suffix}")

    cfg = get_config()
    audio_dir = cfg.app.data_path / "projects" / project_id / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    dest = audio_dir / f"source{suffix}"

    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)

    size_mb = round(dest.stat().st_size / 1_048_576, 2)

    # Full librosa analysis (runs in threadpool to avoid blocking the event loop)
    import asyncio as _asyncio
    from src.core.utils.lyric_analyzer import analyze_audio_full

    try:
        analysis = await _asyncio.get_event_loop().run_in_executor(
            None,
            lambda: analyze_audio_full(str(dest), project.lyrics),
        )
    except Exception as exc:
        analysis = {"bpm": None, "key": None, "sections": [], "emotion_timeline": [], "lyric_beats": []}

    bpm = analysis.get("bpm")
    audio_meta = {
        "filename": file.filename,
        "size_mb":  size_mb,
        "suffix":   suffix,
        "path":     str(dest),
        **analysis,
    }

    project.audio_path = str(dest)
    project.audio_analysis_json = json.dumps(audio_meta)
    await db.flush()

    return {
        "ok":         True,
        "audio_path": str(dest),
        "bpm":        bpm,
        "key":        analysis.get("key"),
        "size_mb":    size_mb,
        "duration_sec": analysis.get("duration_sec"),
        "sections":   len(analysis.get("sections", [])),
        "lyric_beats": len(analysis.get("lyric_beats", [])),
    }


@router.patch("/{project_id}/lyrics")
async def update_lyrics(
    project_id: str,
    lyrics: str,
    db: AsyncSession = Depends(get_db),
):
    """Aggiorna le liriche e ricalcola il lyric timing se l'audio è presente."""
    project = await db.get(ProjectORM, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Progetto non trovato")
    project.lyrics = lyrics

    # Recompute lyric_beats if audio is already analyzed
    lyric_beats_count = 0
    if project.audio_analysis_json and project.audio_path:
        try:
            import asyncio as _asyncio
            from src.core.utils.lyric_analyzer import compute_lyric_timing
            audio_data = json.loads(project.audio_analysis_json)
            sections = audio_data.get("sections", [])
            duration_sec = audio_data.get("duration_sec", 0.0)
            if sections and duration_sec > 0:
                beats = compute_lyric_timing(lyrics, sections, duration_sec)
                audio_data["lyric_beats"] = beats
                project.audio_analysis_json = json.dumps(audio_data)
                lyric_beats_count = len(beats)
        except Exception:
            pass

    await db.flush()
    return {"ok": True, "lyric_beats": lyric_beats_count}
