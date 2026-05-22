"""
API routes for the Trailer Generator module.
POST /api/trailer/generate  — SSE stream, runs the 7-phase TrailerPipeline
POST /api/trailer/analyze   — synchronous audio analysis, returns JSON
GET  /api/trailer/output/{project_id}/{filename} — serve generated video files
"""

import asyncio
import json
import uuid
from pathlib import Path
from typing import AsyncGenerator, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from src.core.config import get_config
from src.core.utils.http_files import file_response
from src.core import pipeline_registry

router = APIRouter()


# ── Request models ────────────────────────────────────────────────────────────

class TrailerGenerateRequest(BaseModel):
    project_id: str
    audio_path: str
    audio_name: str = ""
    lyrics: Optional[str] = None
    duration_sec: int = 60
    style: str = "cinematic, dramatic lighting"
    aspect_ratio: str = "9:16"
    width: int = 1080
    height: int = 1920
    fps: int = 30
    txt2img_workflow: str = "z_image_txt2img"
    img2video_workflow: str = "ltx_img2video"
    concurrent_jobs: int = 1
    max_clip_sec: float = 9.5
    resume_job_id: Optional[str] = None
    phase: str = "full"   # full → fino a storyboard | production → HD+video | storyboard → rigenera anteprima
    clip_backend: str = "auto"
    allow_ffmpeg_fallback: bool = True
    storyboard_max_side: int = Field(default=320, ge=96, le=768)
    storyboard_steps: int = Field(default=10, ge=4, le=40)
    hd_frame_steps: int = Field(default=25, ge=4, le=50)


class AudioAnalyzeRequest(BaseModel):
    audio_path: str


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/generate")
async def trailer_generate(req: TrailerGenerateRequest):
    """
    SSE stream — executes the complete 7-phase trailer pipeline.

    Each Server-Sent Event is a JSON object.  Terminal events:
      {"done": true, "video_path": "...", "duration_sec": N}
      {"error": "...", "phase": "..."}
    """
    from src.core.workflow.trailer_pipeline import TrailerPipeline, TrailerRequest

    job_id = req.resume_job_id or uuid.uuid4().hex[:10]
    audio_name = req.audio_name or Path(req.audio_path).name
    trailer_req = TrailerRequest(
        project_id=req.project_id,
        audio_path=req.audio_path,
        audio_name=audio_name,
        lyrics=req.lyrics,
        duration_sec=req.duration_sec,
        style=req.style,
        aspect_ratio=req.aspect_ratio,
        width=req.width,
        height=req.height,
        fps=req.fps,
        txt2img_workflow=req.txt2img_workflow,
        img2video_workflow=req.img2video_workflow,
        concurrent_jobs=req.concurrent_jobs,
        max_clip_sec=req.max_clip_sec,
        resume_job_id=job_id,
        phase=req.phase,
        clip_backend=req.clip_backend,
        allow_ffmpeg_fallback=req.allow_ffmpeg_fallback,
        storyboard_max_side=req.storyboard_max_side,
        storyboard_steps=req.storyboard_steps,
        hd_frame_steps=req.hd_frame_steps,
    )

    q: asyncio.Queue = asyncio.Queue()

    async def _run() -> None:
        try:
            pipeline = TrailerPipeline(trailer_req)
            async for event in pipeline.run():
                await q.put(event)
                if isinstance(event, dict):
                    pipeline_registry.update_job(
                        job_id,
                        stage=event.get("phase", event.get("stage", "")),
                        progress=event.get("progress", 0),
                        message=event.get("message", event.get("msg", "")),
                    )
        except asyncio.CancelledError:
            await q.put({"cancelled": True, "job_id": job_id})
            pipeline_registry.complete_job(job_id, status="cancelled")
            return
        except Exception as exc:
            await q.put({"error": str(exc), "job_id": job_id})
            pipeline_registry.complete_job(job_id, status="failed", error=str(exc))
            return
        finally:
            await q.put(None)

    pipeline_registry.register_job(job_id, kind="trailer", title=audio_name, project_id=req.project_id)
    task = asyncio.create_task(_run())
    pipeline_registry.register_task(job_id, task)

    async def stream() -> AsyncGenerator[str, None]:
        try:
            while True:
                try:
                    event = await asyncio.wait_for(q.get(), timeout=60)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                if event is None:
                    break
                yield "data: " + json.dumps(event) + "\n\n"
                if event.get("done") or event.get("error") or event.get("cancelled"):
                    pipeline_registry.complete_job(
                        job_id,
                        status="cancelled" if event.get("cancelled") else
                               "failed" if event.get("error") else "completed",
                        error=event.get("error"),
                    )
                    break
        except asyncio.CancelledError:
            pass

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/storage/{project_id}")
async def trailer_project_storage(project_id: str):
    """Percorso cartella trailer su disco (per UI e Esplora file)."""
    from src.core.utils.project_paths import ensure_project_directory, project_base_path

    from src.core.utils.project_paths import is_trailer_catalog_id, trailer_catalog_project_id

    base = ensure_project_directory(project_id, title="Trailer")
    return {
        "project_id": project_id,
        "catalog_project_id": trailer_catalog_project_id(project_id),
        "is_standalone_storage": is_trailer_catalog_id(project_id) or project_id.startswith("trailer_"),
        "project_dir": str(base.resolve()),
        "storyboard_dir": str((base / "storyboard").resolve()),
        "frames_dir": str((base / "frames").resolve()),
        "clips_dir": str((base / "clips").resolve()),
        "exists": project_base_path(project_id).is_dir(),
    }


@router.post("/analyze")
async def trailer_analyze(req: AudioAnalyzeRequest):
    """
    Synchronous audio analysis — returns section list with BPM, energy
    and hook scoring without running the full pipeline.
    """
    audio_path = Path(req.audio_path)
    if not audio_path.exists():
        raise HTTPException(status_code=404, detail=f"Audio file not found: {req.audio_path}")

    from src.core.workflow.trailer_pipeline import TrailerPipeline, TrailerRequest

    dummy_req = TrailerRequest(
        project_id="__analyze__",
        audio_path=req.audio_path,
    )
    pipeline = TrailerPipeline(dummy_req)

    loop = asyncio.get_event_loop()
    sections, downbeats, duration = await loop.run_in_executor(
        None, pipeline._analyze_audio_sync, audio_path
    )

    return {
        "duration_sec": round(duration, 2),
        "bpm": sections[0].bpm_local if sections else 0,
        "sections": [s.model_dump() for s in sections],
        "downbeat_count": len(downbeats),
    }


@router.get("/source")
async def serve_source_audio(path: str):
    """Serve file locali per path assoluto (audio, immagini storyboard, ecc.)."""
    from urllib.parse import unquote
    file_path = Path(unquote(path))
    if not file_path.exists() and "/" in path and "\\" not in path:
        file_path = Path(unquote(path).replace("/", "\\"))
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")
    return file_response(file_path, inline=True)


def _find_storyboard_for_clip(project_id: str, clip_id: str) -> Path | None:
    """Trova storyboard ComfyUI reale per clip_id (esclude placeholder FFmpeg)."""
    from urllib.parse import unquote
    from src.core.utils.comfyui_outputs import pick_largest_real_image
    from src.core.utils.project_paths import trailer_media_search_project_ids

    clip_id = unquote(clip_id)
    for pid in trailer_media_search_project_ids(project_id):
        direct = _find_storyboard_file(pid, f"{clip_id}_sb.png")
        if direct:
            return direct

        cfg = get_config()
        base = cfg.app.data_path / "projects" / pid
        image_ext = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}

        for folder in (base / "storyboard", base / "frames"):
            if not folder.is_dir():
                continue
            matches = [
                p for p in folder.iterdir()
                if p.is_file()
                and p.suffix.lower() in image_ext
                and clip_id in p.stem
            ]
            picked = pick_largest_real_image(matches)
            if picked:
                return picked
    return None


def _find_storyboard_file(project_id: str, filename: str) -> Path | None:
    """Risolve storyboard reale (ignora placeholder ~836 byte)."""
    from urllib.parse import unquote
    from src.core.utils.comfyui_outputs import is_real_comfy_image, pick_largest_real_image
    from src.core.utils.project_paths import trailer_media_search_project_ids

    name = unquote(filename)
    for pid in trailer_media_search_project_ids(project_id):
        cfg = get_config()
        base = cfg.app.data_path / "projects" / pid
        search_dirs = [base / "storyboard", base / "frames"]
        image_ext = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}

        for folder in search_dirs:
            if not folder.is_dir():
                continue
            direct = folder / name
            if direct.is_file() and is_real_comfy_image(direct, min_bytes=3000):
                return direct
            stem = Path(name).stem
            matches = [
                p for p in folder.iterdir()
                if p.is_file()
                and p.suffix.lower() in image_ext
                and (p.name == name or p.stem.startswith(stem) or stem in p.stem)
            ]
            picked = pick_largest_real_image(matches)
            if picked:
                return picked
    return None


@router.get("/storyboard-clip/{project_id}/{clip_id}")
async def serve_storyboard_by_clip(project_id: str, clip_id: str):
    """Serve storyboard per clip_id senza richiedere il filename esatto."""
    file_path = _find_storyboard_for_clip(project_id, clip_id)
    if not file_path:
        raise HTTPException(status_code=404, detail=f"Storyboard not found for {clip_id}")
    return file_response(file_path, inline=True)


@router.get("/storyboard/{project_id}/{filename:path}")
async def serve_storyboard(project_id: str, filename: str):
    """Serve storyboard preview frames (bassa risoluzione)."""
    file_path = _find_storyboard_file(project_id, filename)
    if not file_path:
        raise HTTPException(status_code=404, detail="Storyboard frame not found")
    return file_response(file_path, inline=True)


def _find_frame_for_clip(project_id: str, clip_id: str, *, role: str = "first") -> Path | None:
    """Risolve frame HD per clip_id (ComfyUI può salvare proge_* invece del nome canonico)."""
    from urllib.parse import unquote
    from src.core.utils.project_paths import trailer_media_search_project_ids

    clip_id = unquote(clip_id)
    suffix = "first" if role == "first" else "last"
    for pid in trailer_media_search_project_ids(project_id):
        direct = _find_frame_file(pid, f"{clip_id}_{suffix}.png")
        if direct:
            return direct

        cfg = get_config()
        base = cfg.app.data_path / "projects" / pid / "frames"
        if not base.is_dir():
            continue
        image_ext = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
        matches = [
            p for p in base.iterdir()
            if p.is_file()
            and p.suffix.lower() in image_ext
            and p.stat().st_size >= 2000
            and clip_id in p.stem
        ]
        if matches:
            matches.sort(key=lambda p: p.stat().st_mtime, reverse=True)
            return matches[0]
    return None


def _find_frame_file(project_id: str, filename: str) -> Path | None:
    """Risolve frame anche con prefisso ComfyUI (proge_*, z-image, ecc.)."""
    from urllib.parse import unquote
    from src.core.utils.project_paths import trailer_media_search_project_ids

    name = unquote(filename)
    for pid in trailer_media_search_project_ids(project_id):
        cfg = get_config()
        frames_dir = cfg.app.data_path / "projects" / pid / "frames"
        if not frames_dir.is_dir():
            continue
        image_ext = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
        direct = frames_dir / name
        if direct.is_file() and direct.stat().st_size >= 80:
            return direct
        stem = Path(name).stem
        matches = [
            p for p in frames_dir.iterdir()
            if p.is_file()
            and p.suffix.lower() in image_ext
            and p.stat().st_size >= 80
            and (p.name == name or p.stem.startswith(stem) or stem in p.stem)
        ]
        if matches:
            matches.sort(key=lambda p: p.stat().st_mtime, reverse=True)
            return matches[0]
    return None


@router.get("/frames-clip/{project_id}/{clip_id}")
async def serve_frame_by_clip(project_id: str, clip_id: str):
    """Serve first frame HD per clip_id (nome file ComfyUI variabile)."""
    file_path = _find_frame_for_clip(project_id, clip_id, role="first")
    if not file_path:
        raise HTTPException(status_code=404, detail=f"Frame not found for {clip_id}")
    return file_response(file_path, inline=True)


@router.get("/frames/{project_id}/{filename:path}")
async def serve_frame(project_id: str, filename: str):
    """Serve intermediate frame images generated during trailer pipeline."""
    file_path = _find_frame_file(project_id, filename)
    if not file_path:
        raise HTTPException(status_code=404, detail="Frame not found")
    return file_response(file_path, inline=True)


@router.get("/clips/{project_id}/{filename:path}")
async def serve_clip(project_id: str, filename: str):
    """Serve clip video intermedi durante la generazione trailer."""
    cfg = get_config()
    clips_dir = cfg.app.data_path / "projects" / project_id / "clips"
    file_path = clips_dir / filename
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="Clip not found")
    return file_response(file_path, inline=True)


@router.get("/output/{project_id}/{filename:path}")
async def serve_output(project_id: str, filename: str):
    """Serve generated trailer video files."""
    cfg = get_config()
    final_dir = cfg.app.data_path / "projects" / project_id / "final"
    file_path = final_dir / filename

    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    return file_response(file_path, inline=True)


# ── Job management ─────────────────────────────────────────────────────────────

@router.get("/jobs")
async def list_jobs(project_id: str):
    """Return all saved trailer jobs for a project, newest first."""
    from src.core.workflow.trailer_jobs import load_jobs
    jobs = load_jobs(project_id)
    # Mark any 'running' job as interrupted (app was closed mid-run)
    changed = False
    for j in jobs:
        if j.status == "running":
            j.status = "interrupted"
            changed = True
        # awaiting_storyboard resta ripristinabile dall'UI
    if changed:
        from src.core.workflow.trailer_jobs import upsert_job
        for j in jobs:
            if j.status == "interrupted":
                upsert_job(j)
    return {"jobs": [j.model_dump() for j in jobs]}


@router.delete("/jobs/{project_id}/{job_id}")
async def delete_job(project_id: str, job_id: str, cleanup: bool = False):
    """Delete a job record. Pass ?cleanup=true to also remove generated files."""
    from src.core.workflow.trailer_jobs import remove_job

    try:
        ok = remove_job(project_id, job_id, cleanup_files=cleanup)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    if not ok:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"ok": True}
