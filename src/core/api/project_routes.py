"""
API routes per la gestione dei progetti.
"""

import json
import shutil
from pathlib import Path
from typing import List

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.config import get_config
from src.core.database import get_db
from src.core.models.project import ProjectORM, ProjectCreate, ProjectResponse

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
    return project


@router.delete("/{project_id}", status_code=204)
async def delete_project(project_id: str, db: AsyncSession = Depends(get_db)):
    project = await db.get(ProjectORM, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Progetto non trovato")
    await db.delete(project)


@router.get("/{project_id}/storyboard")
async def get_storyboard(project_id: str, db: AsyncSession = Depends(get_db)):
    project = await db.get(ProjectORM, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Progetto non trovato")
    if not project.storyboard_json:
        raise HTTPException(status_code=404, detail="Storyboard non ancora generato")
    return json.loads(project.storyboard_json)


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

    # Basic metadata (without librosa)
    size_mb = round(dest.stat().st_size / 1_048_576, 2)

    # Try optional librosa BPM detection
    bpm = None
    try:
        import librosa  # type: ignore
        y, sr = librosa.load(str(dest), sr=None, mono=True, duration=60)
        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        bpm = round(float(tempo), 1)
    except Exception:
        pass

    audio_meta = {
        "filename": file.filename,
        "size_mb": size_mb,
        "bpm": bpm,
        "suffix": suffix,
        "path": str(dest),
    }

    project.audio_path = str(dest)
    project.audio_analysis_json = json.dumps(audio_meta)
    await db.flush()

    return {"ok": True, "audio_path": str(dest), "bpm": bpm, "size_mb": size_mb}


@router.patch("/{project_id}/lyrics")
async def update_lyrics(
    project_id: str,
    lyrics: str,
    db: AsyncSession = Depends(get_db),
):
    """Aggiorna le liriche di un progetto."""
    project = await db.get(ProjectORM, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Progetto non trovato")
    project.lyrics = lyrics
    await db.flush()
    return {"ok": True}
