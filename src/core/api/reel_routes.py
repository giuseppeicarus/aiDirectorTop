"""API CreateReel — generazione reel da brief + immagini di riferimento."""

from __future__ import annotations

import json
from pathlib import Path
from typing import AsyncGenerator, List, Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from src.core.config import get_config
from src.core.utils.http_files import file_response

router = APIRouter()


class ReelGenerateRequest(BaseModel):
    project_id: str = "reel_standalone"
    description: str
    reference_image_paths: List[str] = Field(default_factory=list)
    title: str = ""
    duration_sec: int = 30
    style: str = "cinematic, photorealistic, dramatic lighting"
    aspect_ratio: str = "9:16"
    width: int = 1080
    height: int = 1920
    fps: int = 30
    txt2img_workflow: str = "z_image_txt2img"
    img2video_workflow: str = "ltx_img2video"
    concurrent_jobs: int = 1
    max_clip_sec: float = 5.0
    num_slots: int = 0
    resume_job_id: Optional[str] = None
    phase: str = "full"
    clip_backend: str = "auto"
    allow_ffmpeg_fallback: bool = True
    storyboard_max_side: int = Field(default=320, ge=96, le=768)
    storyboard_steps: int = Field(default=10, ge=4, le=40)


@router.post("/generate")
async def reel_generate(req: ReelGenerateRequest):
    async def stream() -> AsyncGenerator[str, None]:
        from src.core.workflow.reel_pipeline import ReelPipeline, ReelRequest

        reel_req = ReelRequest(**req.model_dump())
        pipeline = ReelPipeline(reel_req)
        async for event in pipeline.run():
            yield "data: " + json.dumps(event) + "\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/upload-references")
async def upload_references(
    project_id: str = "reel_standalone",
    job_id: Optional[str] = None,
    files: List[UploadFile] = File(...),
):
    """Salva immagini di riferimento nella cartella references/ (opzionale prima del generate)."""
    from src.core.utils.project_paths import ensure_project_directory, resolve_reel_storage_project_id
    import uuid

    jid = job_id or uuid.uuid4().hex[:10]
    storage = resolve_reel_storage_project_id(project_id, jid)
    base = ensure_project_directory(storage, title="Reel refs")
    ref_dir = base / "references"
    ref_dir.mkdir(parents=True, exist_ok=True)
    paths: list[str] = []
    for i, uf in enumerate(files[:12]):
        suffix = Path(uf.filename or "img.png").suffix.lower() or ".png"
        dest = ref_dir / f"ref_{i:03d}{suffix}"
        content = await uf.read()
        if len(content) < 100:
            continue
        dest.write_bytes(content)
        paths.append(str(dest.resolve()))
    return {
        "job_id": jid,
        "storage_project_id": storage,
        "paths": paths,
        "count": len(paths),
    }


@router.get("/jobs")
async def list_reel_jobs(project_id: str = "reel_standalone"):
    from src.core.workflow.reel_jobs import load_jobs, job_storage_project_id

    jobs = load_jobs(project_id)
    return {
        "jobs": [
            {
                **j.model_dump(),
                "storage_project_id": job_storage_project_id(j),
            }
            for j in jobs
        ],
    }


@router.delete("/jobs/{project_id}/{job_id}")
async def delete_reel_job(project_id: str, job_id: str, cleanup: bool = False):
    from src.core.workflow.reel_jobs import remove_job

    if not remove_job(project_id, job_id, cleanup_files=cleanup):
        raise HTTPException(status_code=404, detail="Job not found")
    return {"ok": True}


@router.get("/storage/{project_id}")
async def reel_storage(project_id: str):
    from src.core.utils.project_paths import ensure_project_directory, reel_catalog_project_id

    base = ensure_project_directory(project_id, title="CreateReel")
    return {
        "project_id": project_id,
        "catalog_project_id": reel_catalog_project_id(project_id),
        "project_dir": str(base.resolve()),
        "references_dir": str((base / "references").resolve()),
        "storyboard_dir": str((base / "storyboard").resolve()),
    }


def _find_storyboard_for_clip(project_id: str, clip_id: str) -> Path | None:
    from src.core.api.trailer_routes import _find_storyboard_for_clip as _t_find
    from src.core.utils.project_paths import reel_media_search_project_ids

    for pid in reel_media_search_project_ids(project_id):
        found = _t_find(pid, clip_id)
        if found:
            return found
    return None


@router.get("/storyboard-clip/{project_id}/{clip_id}")
async def serve_storyboard_clip(project_id: str, clip_id: str):
    file_path = _find_storyboard_for_clip(project_id, clip_id)
    if not file_path:
        raise HTTPException(status_code=404, detail=f"Storyboard not found for {clip_id}")
    return file_response(file_path, inline=True)


@router.get("/storyboard/{project_id}/{filename:path}")
async def serve_storyboard(project_id: str, filename: str):
    from src.core.api.trailer_routes import _find_storyboard_file

    from src.core.utils.project_paths import reel_media_search_project_ids

    for pid in reel_media_search_project_ids(project_id):
        fp = _find_storyboard_file(pid, filename)
        if fp:
            return file_response(fp, inline=True)
    raise HTTPException(status_code=404, detail="Storyboard not found")


@router.get("/frames-clip/{project_id}/{clip_id}")
async def serve_frame_clip(project_id: str, clip_id: str):
    from src.core.api.trailer_routes import _find_frame_for_clip
    from src.core.utils.project_paths import reel_media_search_project_ids

    for pid in reel_media_search_project_ids(project_id):
        fp = _find_frame_for_clip(pid, clip_id)
        if fp:
            return file_response(fp, inline=True)
    raise HTTPException(status_code=404, detail="Frame not found")


@router.get("/clips/{project_id}/{filename:path}")
async def serve_clip(project_id: str, filename: str):
    from urllib.parse import unquote
    from src.core.utils.project_paths import reel_media_search_project_ids

    name = unquote(filename)
    cfg = get_config()
    for pid in reel_media_search_project_ids(project_id):
        p = cfg.app.data_path / "projects" / pid / "clips" / name
        if p.is_file():
            return file_response(p, inline=False)
    raise HTTPException(status_code=404, detail="Clip not found")


@router.get("/output/{project_id}/{filename:path}")
async def serve_output(project_id: str, filename: str):
    from urllib.parse import unquote
    from src.core.utils.project_paths import reel_media_search_project_ids

    name = unquote(filename)
    cfg = get_config()
    for pid in reel_media_search_project_ids(project_id):
        p = cfg.app.data_path / "projects" / pid / "final" / name
        if p.is_file():
            return file_response(p, inline=False)
    raise HTTPException(status_code=404, detail="Output not found")
