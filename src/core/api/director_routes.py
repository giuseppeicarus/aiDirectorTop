"""
API routes per Director Cinema — generazione video timeline-based con LTX Director.
POST /api/director/generate  — SSE stream
POST /api/director/enhance   — miglioramento prompt via LLM
"""
import asyncio
import copy
import json
import random
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncGenerator, List, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from src.core.comfyui.pool import ComfyUINodePool
from src.core.comfyui.progress import stream_pool_comfy_run
from src.core.comfyui.workflow_builder import WORKFLOWS_DIR, get_workflow, list_workflows, extract_output_files
from src.core.config import get_config
from src.core.utils.media_registry import register_media, prompt_for_director_timeline

router = APIRouter()

_bg_tasks: set = set()


def _fire_register(coro) -> None:
    task = asyncio.create_task(coro)
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)


def _director_dir() -> Path:
    p = get_config().app.data_path / "director"
    p.mkdir(parents=True, exist_ok=True)
    return p


# ── Job Tracking Helpers ───────────────────────────────────────────────────────

def _jobs_dir() -> Path:
    p = _director_dir() / "jobs"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _save_director_job(job_data: dict) -> None:
    """Persiste metadata job su disco prima di inviare a ComfyUI."""
    job_id = job_data.get("job_id", "")
    if not job_id:
        return
    p = _jobs_dir() / f"{job_id}.json"
    p.write_text(json.dumps(job_data, indent=2, default=str), encoding="utf-8")


def _update_director_job(job_id: str, **fields) -> None:
    """Aggiorna campi specifici di un job esistente."""
    p = _jobs_dir() / f"{job_id}.json"
    if not p.exists():
        return
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        data.update(fields)
        p.write_text(json.dumps(data, indent=2, default=str), encoding="utf-8")
    except Exception:
        pass


def _list_pending_jobs(project_id: str = "", clip_id: str = "") -> list[dict]:
    """Elenca job con status 'pending' (non completati)."""
    jobs_path = _jobs_dir()
    result = []
    for f in sorted(jobs_path.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            if data.get("status") in ("pending", "submitted"):
                if project_id and data.get("project_id") != project_id:
                    continue
                if clip_id and data.get("clip_id") != clip_id:
                    continue
                result.append(data)
        except Exception:
            pass
    return result


# ── FFmpeg transition map ─────────────────────────────────────────────────────

_FFMPEG_XFADE = {
    "fade":        "fade",
    "dissolve":    "dissolve",
    "flash":       "fadewhite",
    "black":       "fadeblack",
    "slide_left":  "slideleft",
    "slide_right": "slideright",
    "slide_up":    "slideup",
    "slide_down":  "slidedown",
    "push_left":   "hlslice",
    "push_right":  "hrslice",
    "wipe_left":   "wipeleft",
    "wipe_right":  "wiperight",
    "wipe_up":     "wipeup",
    "wipe_down":   "wipedown",
    "radial":      "radial",
    "iris":        "circleopen",
    "zoom_in":     "zoomin",
    "zoom_blur":   "zoomin",
    "film_burn":   "distance",
    "light_leak":  "fadewhite",
    "glitch":      "pixelize",
    "pixelate":    "pixelize",
    "cube":        "slideleft",
    "page_turn":   "wipeleft",
    "flip_h":      "hblur",
    "flip_v":      "vblur",
    "fold":        "wipeleft",
}

_TRANSITION_DURATION = {
    "cut": 0, "fade": 0.5, "dissolve": 0.6, "flash": 0.3, "black": 0.5,
    "slide_left": 0.4, "slide_right": 0.4, "slide_up": 0.4, "slide_down": 0.4,
    "push_left": 0.4, "push_right": 0.4,
    "wipe_left": 0.5, "wipe_right": 0.5, "wipe_up": 0.5, "wipe_down": 0.5,
    "radial": 0.6, "iris": 0.6,
    "zoom_in": 0.5, "zoom_blur": 0.6, "film_burn": 0.8, "light_leak": 0.7,
    "glitch": 0.4, "pixelate": 0.5,
    "cube": 0.7, "page_turn": 0.8, "flip_h": 0.6, "flip_v": 0.6, "fold": 0.7,
}


# ── Request Models ─────────────────────────────────────────────────────────────

class DirectorClip(BaseModel):
    id: str
    prompt: str
    duration_sec: float = 4.0
    image_path: Optional[str] = None   # local path — will be uploaded to ComfyUI


class DirectorGenerateRequest(BaseModel):
    workflow_id: str = "ltx_director_img2video"
    mode: str = "img2video"            # txt2video | img2video
    global_prompt: str = ""
    clips: List[DirectorClip]
    audio_path: Optional[str] = None
    fps: int = 24
    width: int = 1280
    height: int = 720
    project_name: str = "Director Cinema"


class DirectorEnhanceRequest(BaseModel):
    prompt: str
    context: str = "director_clip"    # director_clip | director_global | director_image_prompt
    project_context: Optional[dict] = None


class DirectorClipImageRequest(BaseModel):
    clip_id: str
    project_id: str = "director_standalone"
    prompt: str
    workflow_id: str = "z_image_turbo_txt2img"
    width: int = 1280
    height: int = 720
    steps: int = 20
    seed: int = -1


class DirectorClipVideoRequest(BaseModel):
    clip_id: str
    project_id: str = "director_standalone"
    prompt: str
    workflow_id: str = "ltx_img2video"
    image_path: Optional[str] = None    # None → txt2video
    audio_path: Optional[str] = None    # presente → img_audio2video
    audio_start_sec: float = 0.0        # offset audio allineato alla clip
    width: int = 1280
    height: int = 720
    fps: int = 24
    duration_sec: float = 3.0


class DirectorScenePromptRequest(BaseModel):
    scene_description: str
    global_prompt: str = ""
    mode: str = "img2video"  # img2video | txt2video


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_workflow_meta(workflow_id: str) -> dict:
    try:
        meta, _ = get_workflow(workflow_id)
    except KeyError:
        raise HTTPException(404, f"Workflow '{workflow_id}' non trovato")
    if meta.get("type") not in ("director", "img2video", "img2video_lastframe", "img_audio2video"):
        raise HTTPException(400, f"Workflow '{workflow_id}' non è di tipo director/img2video")
    return meta


def _build_director_workflow(
    meta: dict,
    wf_json: dict,
    *,
    first_image_name: str,
    last_image_name: str,
    global_prompt: str,
    local_prompts: str,
    segment_lengths: str,
    duration_frames: int,
    duration_seconds: float,
    fps: int,
    width: int,
    height: int,
    audio_name: Optional[str] = None,
) -> dict:
    """Deep-copy workflow e inietta tutti i parametri Director."""
    wf = copy.deepcopy(wf_json)
    inject = meta.get("inject", {})

    def _set(node_id: str, field: str, val):
        nid = str(node_id)
        if nid in wf:
            wf[nid]["inputs"][field] = val

    # Standard inject map
    if "first_image" in inject:
        _set(inject["first_image"]["node"], inject["first_image"]["field"], first_image_name)
    if "last_image" in inject:
        _set(inject["last_image"]["node"], inject["last_image"]["field"], last_image_name)
    if "prompt" in inject:
        _set(inject["prompt"]["node"], inject["prompt"]["field"], global_prompt)
    if "width" in inject:
        _set(inject["width"]["node"], inject["width"]["field"], width)
    if "height" in inject:
        _set(inject["height"]["node"], inject["height"]["field"], height)
    if "fps" in inject:
        _set(inject["fps"]["node"], inject["fps"]["field"], float(fps))
    if "duration_frames" in inject:
        _set(inject["duration_frames"]["node"], inject["duration_frames"]["field"], duration_frames)

    # Director-specific params (inject map or direct LTXDirector node scan)
    if "local_prompts" in inject:
        _set(inject["local_prompts"]["node"], inject["local_prompts"]["field"], local_prompts)
    if "segment_lengths" in inject:
        _set(inject["segment_lengths"]["node"], inject["segment_lengths"]["field"], segment_lengths)

    # Fallback: scan for LTXDirector node and inject directly
    for node_id, node in wf.items():
        if node.get("class_type") == "LTXDirector":
            inp = node["inputs"]
            inp["global_prompt"]   = global_prompt
            inp["local_prompts"]   = local_prompts
            inp["segment_lengths"] = segment_lengths
            inp["duration_frames"] = duration_frames
            inp["duration_seconds"] = duration_seconds
            inp["frame_rate"]      = float(fps)
            inp["custom_width"]    = width
            inp["custom_height"]   = height
            if audio_name:
                inp["use_custom_audio"] = True
            break

    # Set output prefix on SaveVideo/SaveImage nodes
    for node_id in meta.get("output_nodes", []):
        nid = str(node_id)
        if nid in wf:
            inp = wf[nid].get("inputs", {})
            if "filename_prefix" in inp:
                inp["filename_prefix"] = f"director_{uuid.uuid4().hex[:6]}"

    return wf


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.post("/generate")
async def director_generate(req: DirectorGenerateRequest):
    """SSE: esegue generazione Director Cinema timeline → video."""

    async def stream() -> AsyncGenerator[str, None]:
        def ev(data: dict) -> str:
            return "data: " + json.dumps(data) + "\n\n"

        try:
            if not req.clips:
                yield ev({"error": "Nessuna clip nella timeline"}); return

            meta, wf_json = get_workflow(req.workflow_id)
            pool = ComfyUINodePool()
            cfg = get_config()
            out_dir = _director_dir()
            job_id = uuid.uuid4().hex[:8]

            yield ev({"event": "start", "job_id": job_id, "clips": len(req.clips)})

            c = await pool.get_client()

            # ── Upload images ────────────────────────────────────────────────
            uploaded_names: List[str] = []
            for i, clip in enumerate(req.clips):
                if req.mode == "img2video" and clip.image_path and Path(clip.image_path).exists():
                    pct = 0.05 + (i / len(req.clips)) * 0.20
                    yield ev({"event": "progress", "msg": f"Upload immagine clip {i+1}/{len(req.clips)}…", "pct": round(pct, 2)})
                    name = await c.upload_image(Path(clip.image_path))
                    uploaded_names.append(name)
                else:
                    uploaded_names.append("")  # txt2video: no image needed

            first_image_name = next((n for n in uploaded_names if n), "") or "placeholder.png"
            last_image_name  = next((n for n in reversed(uploaded_names) if n), first_image_name)

            # ── Upload audio ─────────────────────────────────────────────────
            audio_name: Optional[str] = None
            if req.audio_path and Path(req.audio_path).exists():
                yield ev({"event": "progress", "msg": "Upload traccia audio…", "pct": 0.26})
                audio_name = Path(req.audio_path).name

            # ── Build director params ─────────────────────────────────────────
            local_prompts_list = [c.prompt or req.global_prompt for c in req.clips]
            segment_frames     = [max(1, round(c.duration_sec * req.fps)) for c in req.clips]

            local_prompts   = "|".join(local_prompts_list)
            segment_lengths = ",".join(str(f) for f in segment_frames)
            duration_frames  = sum(segment_frames)
            duration_seconds = sum(c.duration_sec for c in req.clips)

            yield ev({
                "event": "progress",
                "msg": f"Timeline: {len(req.clips)} clip · {duration_seconds:.1f}s · {duration_frames} frames",
                "pct": 0.30,
            })

            # ── Build workflow ────────────────────────────────────────────────
            wf = _build_director_workflow(
                meta, wf_json,
                first_image_name=first_image_name,
                last_image_name=last_image_name,
                global_prompt=req.global_prompt,
                local_prompts=local_prompts,
                segment_lengths=segment_lengths,
                duration_frames=duration_frames,
                duration_seconds=duration_seconds,
                fps=req.fps,
                width=req.width,
                height=req.height,
                audio_name=audio_name,
            )

            # ── Submit to ComfyUI ─────────────────────────────────────────────
            yield ev({"event": "progress", "msg": "Accodamento ComfyUI…", "pct": 0.34})
            run = None
            async for item in stream_pool_comfy_run(
                pool, wf, client=c,
                timeout=cfg.comfyui.execution_timeout_sec,
                start=0.35, end=0.90, label="LTX Director",
            ):
                if "_result" in item:
                    run = item["_result"]
                else:
                    yield ev(item)

            files = extract_output_files(run.history)
            if not files:
                yield ev({"error": "Nessun output da ComfyUI"}); return

            # ── Download result ───────────────────────────────────────────────
            fname = files[0]["filename"]
            ext   = Path(fname).suffix or ".mp4"
            dest  = out_dir / f"director_{job_id}{ext}"
            yield ev({"event": "progress", "msg": "Download video…", "pct": 0.92})
            await run.client.download_output(fname, dest, subfolder=files[0].get("subfolder", ""))

            _fire_register(register_media(
                dest, "video", "__director__", req.project_name,
                source="director",
                tags=["director", req.project_name, f"{req.width}x{req.height}"],
                generation_prompt=prompt_for_director_timeline(req.global_prompt, req.clips),
            ))

            yield ev({
                "done": True,
                "job_id": job_id,
                "type": "video",
                "filename": dest.name,
                "path": str(dest),
            })

        except HTTPException as exc:
            yield ev({"error": exc.detail})
        except Exception as exc:
            yield ev({"error": str(exc)})

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class DirectorReconcileRequest(BaseModel):
    job_id: str
    filename_prefix: Optional[str] = None


@router.post("/reconcile")
async def director_reconcile(req: DirectorReconcileRequest):
    """Recupera output video Director da disco o history ComfyUI."""
    from src.core.workflow.media_reconcile_service import reconcile_director_output

    return await reconcile_director_output(
        req.job_id,
        filename_prefix=req.filename_prefix,
    )


@router.post("/enhance")
async def director_enhance(req: DirectorEnhanceRequest):
    """Migliora prompt clip/globale con il modello regia configurato (DP o narrativa)."""
    if req.context == "director_image_prompt":
        # Percorso specializzato: migliora prompt txt2img per qualità immagine cinematografica
        try:
            from src.core.llm.factory import get_llm_adapter
            ctx = req.project_context or {}
            system = (
                "You are a professional AI image prompt engineer. "
                "Improve the given txt2img prompt to avoid anatomical defects, "
                "bad quality, and deformities. Make it precise, cinematic, and coherent. "
                "Consider the scene description and aspect ratio. "
                "Return ONLY JSON: {\"enhanced\": \"...improved prompt...\"}"
            )
            user_parts = [f"Current prompt: {req.prompt}"]
            if ctx.get("scene_description"):
                user_parts.append(f"Scene: {ctx['scene_description']}")
            if ctx.get("global_prompt"):
                user_parts.append(f"Style: {ctx['global_prompt']}")
            if ctx.get("width") and ctx.get("height"):
                user_parts.append(
                    f"Resolution: {ctx['width']}x{ctx['height']} ({ctx.get('aspect_ratio', '')})"
                )
            user_parts.append(
                "Rules: avoid 'deformed', 'mutated', 'extra limbs'. "
                "Add: professional photography, cinematic lighting, sharp focus, high detail."
            )
            adapter = get_llm_adapter()
            result = await adapter.generate_json(
                system=system,
                user="\n".join(user_parts),
                temperature=0.6,
                max_tokens=300,
            )
            enhanced = result.get("enhanced", "")
            if enhanced:
                return {"ok": True, "enhanced": enhanced}
        except Exception:
            pass  # fallback al path normale

    # Path normale per tutti gli altri context (e fallback di director_image_prompt)
    from src.core.llm.prompt_enhance_service import run_prompt_enhance
    try:
        return await run_prompt_enhance(
            prompt=req.prompt,
            context=req.context,
            project_context=req.project_context,
            max_tokens=500,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(500, str(exc)) from exc


@router.get("/output/{filename:path}")
async def serve_output(filename: str):
    """Serve i video generati da Director Cinema."""
    p = _director_dir() / filename
    if not p.exists():
        raise HTTPException(404, "File non trovato")
    return FileResponse(str(p))


# ── Persistenza Progetti ───────────────────────────────────────────────────────

@router.get("/projects")
async def list_projects():
    """Legge tutti i progetti salvati, ordinati per data modifica desc."""
    projects_dir = _director_dir() / "projects"
    projects_dir.mkdir(parents=True, exist_ok=True)

    results = []
    for f in sorted(projects_dir.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            results.append({
                "id": f.stem,
                "title": data.get("title", f.stem),
                "mode": data.get("mode", ""),
                "clips_count": len(data.get("clips", [])),
                "updated_at": f.stat().st_mtime,
            })
        except Exception:
            pass

    return {"projects": results}


@router.post("/projects/{project_id}")
async def save_project(project_id: str, request: Request):
    """Salva un progetto completo sul disco."""
    body = await request.json()
    projects_dir = _director_dir() / "projects"
    projects_dir.mkdir(parents=True, exist_ok=True)
    dest = projects_dir / f"{project_id}.json"
    dest.write_text(json.dumps(body, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True, "project_id": project_id}


@router.get("/projects/{project_id}")
async def get_project(project_id: str):
    """Carica un progetto salvato per ID."""
    dest = _director_dir() / "projects" / f"{project_id}.json"
    if not dest.exists():
        raise HTTPException(404, f"Progetto '{project_id}' non trovato")
    return json.loads(dest.read_text(encoding="utf-8"))


@router.delete("/projects/{project_id}")
async def delete_project(project_id: str, cleanup: bool = False):
    """Elimina un progetto Director Cinema dal disco."""
    dest = _director_dir() / "projects" / f"{project_id}.json"
    if not dest.exists():
        # Already gone — treat as success so frontend can clean up state
        return {"ok": True, "project_id": project_id}
    dest.unlink()
    if cleanup:
        # Remove generated images/clips directory for this project
        proj_assets = _director_dir() / "projects" / project_id
        if proj_assets.is_dir():
            import shutil as _shutil
            _shutil.rmtree(proj_assets, ignore_errors=True)
        # Cancel any pending/running jobs for this project
        jobs_dir = _jobs_dir()
        for jf in jobs_dir.glob("*.json"):
            try:
                data = json.loads(jf.read_text(encoding="utf-8"))
                if data.get("project_id") == project_id:
                    jf.unlink(missing_ok=True)
            except Exception:
                pass
    return {"ok": True, "project_id": project_id}


# ── Generazione immagine per singola clip (txt2img) ────────────────────────────

@router.post("/clips/generate-image")
async def director_clip_generate_image(req: DirectorClipImageRequest):
    """SSE: genera immagine per una singola clip via txt2img."""
    from src.core.comfyui.workflow_builder import build_txt2img_workflow, get_workflow_meta
    from src.core.models.cinematic import FramePrompt
    from src.core.llm.generation_prompt_sanitize import CINEMATIC_NEGATIVE_PROMPT
    from src.core.utils.comfyui_outputs import download_comfyui_image_resilient

    async def stream() -> AsyncGenerator[str, None]:
        def ev(data: dict) -> str:
            return "data: " + json.dumps(data) + "\n\n"

        local_job_id = uuid.uuid4().hex[:10]

        try:
            # Verifica che il workflow esista e sia di tipo txt2img
            meta = get_workflow_meta(req.workflow_id)
            if not meta:
                yield ev({"event": "error", "error": f"Workflow '{req.workflow_id}' non trovato"}); return
            if meta.get("type") != "txt2img":
                yield ev({"event": "error", "error": f"Workflow '{req.workflow_id}' non è di tipo txt2img (trovato: {meta.get('type')})"}); return

            yield ev({"event": "progress", "msg": "Generazione immagine...", "pct": 0.1})

            seed = req.seed if req.seed >= 0 else random.randint(0, 2**32)
            frame = FramePrompt(
                prompt=req.prompt,
                negative_prompt=CINEMATIC_NEGATIVE_PROMPT,
                seed=seed,
            )

            # Directory destinazione (calcolata prima del submit per persistere nel job)
            img_dir = _director_dir() / "projects" / req.project_id / "images"
            img_dir.mkdir(parents=True, exist_ok=True)
            dest_path = img_dir / f"{req.clip_id}_image.png"

            wf = build_txt2img_workflow(
                frame,
                output_prefix=f"director_{req.clip_id}",
                width=req.width,
                height=req.height,
                steps=req.steps,
                workflow_id=req.workflow_id,
            )

            # Persisti il job prima di inviarlo a ComfyUI
            _save_director_job({
                "job_id": local_job_id,
                "prompt_id": None,
                "comfyui_node_url": None,
                "type": "image",
                "clip_id": req.clip_id,
                "project_id": req.project_id,
                "workflow_id": req.workflow_id,
                "prompt": req.prompt,
                "width": req.width,
                "height": req.height,
                "steps": req.steps,
                "dest_path": str(dest_path),
                "result_path": None,
                "status": "submitted",
                "created_at": datetime.now(timezone.utc).isoformat(),
            })
            yield ev({"event": "job_tracking", "job_id": local_job_id})

            cfg = get_config()
            pool = ComfyUINodePool()

            yield ev({"event": "progress", "msg": "ComfyUI processing...", "pct": 0.3})

            run = None
            async for item in stream_pool_comfy_run(
                pool, wf,
                timeout=cfg.comfyui.execution_timeout_sec,
                start=0.30, end=0.90, label="txt2img",
            ):
                if "_result" in item:
                    run = item["_result"]
                    # Aggiorna tracking con prompt_id e nodo
                    _update_director_job(
                        local_job_id,
                        prompt_id=run.prompt_id,
                        comfyui_node_url=getattr(run.client, "_base_url", "") if run.client else "",
                        status="running",
                    )
                else:
                    yield ev(item)

            if run is None:
                _update_director_job(local_job_id, status="failed", error="Nessun risultato da ComfyUI")
                yield ev({"event": "error", "error": "Nessun risultato da ComfyUI"}); return

            yield ev({"event": "progress", "msg": "Download immagine...", "pct": 0.92})

            await download_comfyui_image_resilient(
                run.client,
                run.history,
                output_prefix=f"director_{req.clip_id}",
                dest=dest_path,
                prompt_id=run.prompt_id,
            )

            _update_director_job(local_job_id, status="done", result_path=str(dest_path))

            _fire_register(register_media(
                dest_path,
                "image",
                req.project_id,
                f"Director Clip {req.clip_id}",
                source="director_clip_image",
                tags=["director", "clip-image", req.clip_id, req.project_id, f"{req.width}x{req.height}"],
                generation_prompt=req.prompt,
            ))

            yield ev({
                "event": "done",
                "clip_id": req.clip_id,
                "image_path": str(dest_path),
                "preview_url": f"/api/director/projects/{req.project_id}/images/{req.clip_id}_image.png",
            })

        except Exception as exc:
            _update_director_job(local_job_id, status="failed", error=str(exc))
            yield ev({"event": "error", "error": str(exc)})

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/projects/{project_id}/images/{filename}")
async def serve_project_image(project_id: str, filename: str):
    """Serve le immagini generate per un progetto."""
    p = _director_dir() / "projects" / project_id / "images" / filename
    if not p.exists():
        raise HTTPException(404, "Immagine non trovata")
    return FileResponse(str(p))


@router.post("/clips/generate-video")
async def director_clip_generate_video(req: DirectorClipVideoRequest):
    """SSE: genera video per una singola clip (img2video o txt2video)."""
    from src.core.comfyui.workflow_builder import build_img2video_workflow, build_txt2video_workflow

    async def stream() -> AsyncGenerator[str, None]:
        def ev(data: dict) -> str:
            return "data: " + json.dumps(data) + "\n\n"

        local_job_id = uuid.uuid4().hex[:10]

        try:
            has_image = bool(req.image_path) and Path(req.image_path).exists()
            has_audio = bool(req.audio_path) and Path(req.audio_path).exists()
            output_prefix = f"director_clip_{req.clip_id}_{uuid.uuid4().hex[:6]}"
            cfg = get_config()
            pool = ComfyUINodePool()

            mode_label = "img+audio→video" if (has_image and has_audio) else ("img→video" if has_image else "testo→video")
            yield ev({"event": "progress", "msg": f"Preparazione workflow ({mode_label})...", "pct": 0.05})

            if has_image:
                c = await pool.get_client()
                yield ev({"event": "progress", "msg": "Upload immagine...", "pct": 0.10})
                first_frame_name = await c.upload_image(Path(req.image_path))

                # Upload audio se presente
                audio_filename: Optional[str] = None
                if has_audio:
                    yield ev({"event": "progress", "msg": "Upload traccia audio...", "pct": 0.14})
                    audio_filename = Path(req.audio_path).name
                    await c.upload_audio(Path(req.audio_path))

                from src.core.models.cinematic import CinematicShot, CameraConfig, LightingConfig, MusicSync, FramePrompt
                shot = CinematicShot(
                    shot_id=req.clip_id,
                    sequence_id="seq_001",
                    scene_id="scene_001",
                    time_start="00:00",
                    time_end="00:10",
                    duration_sec=req.duration_sec,
                    scene_description=req.prompt,
                    location="",
                    camera=CameraConfig(shot_type="medium", movement="static", lens_mm=35, depth_of_field="medium"),
                    lighting=LightingConfig(time_of_day="interior", mood="cinematic", sources=["key"]),
                    transition_in="hard_cut_on_beat",
                    transition_out="hard_cut_on_beat",
                    emotion="cinematic",
                    music_sync=MusicSync(bass="", snare="", vocals="", beat_cuts=False),
                    continuity_notes=[],
                    first_frame=FramePrompt(prompt=req.prompt, seed=random.randint(0, 2**32)),
                    last_frame=FramePrompt(prompt=req.prompt, seed=random.randint(0, 2**32)),
                    motion_prompt=req.prompt,
                    comfyui_workflow=req.workflow_id,
                )
                wf = build_img2video_workflow(
                    shot,
                    first_frame_name=first_frame_name,
                    last_frame_name=first_frame_name,
                    output_prefix=output_prefix,
                    audio_filename=audio_filename,
                    audio_start_sec=req.audio_start_sec,
                    width=req.width,
                    height=req.height,
                    duration_sec=req.duration_sec,
                    fps=req.fps,
                    workflow_id=req.workflow_id,
                    use_audio_track=has_audio,
                )
            else:
                from src.core.models.cinematic import CinematicShot, CameraConfig, LightingConfig, MusicSync, FramePrompt
                shot = CinematicShot(
                    shot_id=req.clip_id,
                    sequence_id="seq_001",
                    scene_id="scene_001",
                    time_start="00:00",
                    time_end="00:10",
                    duration_sec=req.duration_sec,
                    scene_description=req.prompt,
                    location="",
                    camera=CameraConfig(shot_type="medium", movement="static", lens_mm=35, depth_of_field="medium"),
                    lighting=LightingConfig(time_of_day="interior", mood="cinematic", sources=["key"]),
                    transition_in="hard_cut_on_beat",
                    transition_out="hard_cut_on_beat",
                    emotion="cinematic",
                    music_sync=MusicSync(bass="", snare="", vocals="", beat_cuts=False),
                    continuity_notes=[],
                    first_frame=FramePrompt(prompt=req.prompt, seed=random.randint(0, 2**32)),
                    last_frame=FramePrompt(prompt=req.prompt, seed=random.randint(0, 2**32)),
                    motion_prompt=req.prompt,
                    comfyui_workflow=req.workflow_id,
                )
                wf = build_txt2video_workflow(
                    shot,
                    output_prefix=output_prefix,
                    width=req.width,
                    height=req.height,
                    duration_sec=req.duration_sec,
                    fps=req.fps,
                    workflow_id=req.workflow_id,
                )

            # Directory destinazione (calcolata prima del submit per persistere nel job)
            clip_dir = _director_dir() / "projects" / req.project_id / "clips"
            clip_dir.mkdir(parents=True, exist_ok=True)
            dest_path = clip_dir / f"{req.clip_id}_clip.mp4"

            # Persisti il job prima di inviarlo a ComfyUI
            _save_director_job({
                "job_id": local_job_id,
                "prompt_id": None,
                "comfyui_node_url": None,
                "type": "video",
                "clip_id": req.clip_id,
                "project_id": req.project_id,
                "workflow_id": req.workflow_id,
                "prompt": req.prompt,
                "width": req.width,
                "height": req.height,
                "fps": req.fps,
                "duration_sec": req.duration_sec,
                "image_path": req.image_path,
                "dest_path": str(dest_path),
                "result_path": None,
                "status": "submitted",
                "created_at": datetime.now(timezone.utc).isoformat(),
            })
            yield ev({"event": "job_tracking", "job_id": local_job_id})

            yield ev({"event": "progress", "msg": "Accodamento ComfyUI...", "pct": 0.20})

            run = None
            async for item in stream_pool_comfy_run(
                pool, wf,
                timeout=cfg.comfyui.execution_timeout_sec,
                start=0.20, end=0.90, label="video clip",
            ):
                if "_result" in item:
                    run = item["_result"]
                    # Aggiorna tracking con prompt_id e nodo
                    _update_director_job(
                        local_job_id,
                        prompt_id=run.prompt_id,
                        comfyui_node_url=getattr(run.client, "_base_url", "") if run.client else "",
                        status="running",
                    )
                else:
                    yield ev(item)

            if run is None:
                _update_director_job(local_job_id, status="failed", error="Nessun risultato da ComfyUI")
                yield ev({"event": "error", "error": "Nessun risultato da ComfyUI"}); return

            files = extract_output_files(run.history)
            if not files:
                _update_director_job(local_job_id, status="failed", error="Nessun file video in output")
                yield ev({"event": "error", "error": "Nessun file video in output"}); return

            video_file = next((f for f in files if Path(f.get("filename","")).suffix in (".mp4",".webm",".mov")), files[0])

            yield ev({"event": "progress", "msg": "Download video...", "pct": 0.92})
            await run.client.download_output(video_file["filename"], dest_path, subfolder=video_file.get("subfolder", ""))

            _update_director_job(local_job_id, status="done", result_path=str(dest_path))

            _fire_register(register_media(
                dest_path,
                "video",
                req.project_id,
                f"Director Clip Video {req.clip_id}",
                source="director_clip_video",
                tags=["director", "clip-video", req.clip_id, req.project_id,
                      "img2video" if req.image_path else "txt2video"],
                generation_prompt=req.prompt,
            ))

            yield ev({
                "event": "done",
                "clip_id": req.clip_id,
                "video_path": str(dest_path),
                "video_url": f"/api/director/projects/{req.project_id}/clips/{req.clip_id}_clip.mp4",
            })

        except Exception as exc:
            _update_director_job(local_job_id, status="failed", error=str(exc))
            yield ev({"event": "error", "error": str(exc)})

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/projects/{project_id}/clips/{filename}")
async def serve_project_clip(project_id: str, filename: str):
    """Serve i video clip generati per un progetto."""
    p = _director_dir() / "projects" / project_id / "clips" / filename
    if not p.exists():
        raise HTTPException(404, "Clip non trovata")
    return FileResponse(str(p), media_type="video/mp4")


# ── Job Tracking Endpoints ─────────────────────────────────────────────────────

@router.get("/jobs/pending")
async def list_pending_director_jobs(project_id: str = "", clip_id: str = ""):
    """Elenca job ComfyUI in stato pending/submitted per un progetto/clip."""
    jobs = _list_pending_jobs(project_id=project_id, clip_id=clip_id)
    return {"jobs": jobs, "count": len(jobs)}


@router.post("/jobs/{job_id}/recover")
async def recover_director_job(job_id: str):
    """Controlla ComfyUI history per un job perso e scarica il risultato se pronto."""
    import httpx
    from src.core.comfyui.workflow_builder import extract_output_files, extract_history_error

    p = _jobs_dir() / f"{job_id}.json"
    if not p.exists():
        raise HTTPException(404, f"Job {job_id} non trovato")

    job = json.loads(p.read_text(encoding="utf-8"))

    # Job già completato con file su disco
    if job.get("status") == "done" and job.get("result_path") and Path(job["result_path"]).exists():
        job_type = job.get("type", "image")
        result_name = Path(job["result_path"]).name
        project_id = job.get("project_id", "")
        if job_type == "image":
            preview_url = f"/api/director/projects/{project_id}/images/{result_name}"
        else:
            preview_url = f"/api/director/projects/{project_id}/clips/{result_name}"
        return {
            "ok": True,
            "status": "done",
            "already_done": True,
            "result_path": job["result_path"],
            "type": job_type,
            "clip_id": job.get("clip_id"),
            "project_id": project_id,
            "preview_url": preview_url,
        }

    prompt_id = job.get("prompt_id")
    node_url = job.get("comfyui_node_url", "")

    # Se non abbiamo il prompt_id, cercalo nella history di tutti i nodi disponibili
    if not prompt_id:
        cfg = get_config()
        nodes = getattr(cfg.comfyui, "nodes", [])
        for node_cfg in nodes:
            base = f"http://{getattr(node_cfg, 'host', 'localhost')}:{getattr(node_cfg, 'port', 8188)}"
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    r = await client.get(f"{base}/history")
                    if r.is_success:
                        hist_all = r.json()
                        prefix = f"director_{job.get('clip_id', '')}"
                        for pid, hdata in hist_all.items():
                            files = extract_output_files(hdata)
                            if any(prefix in (f.get("filename", "")) for f in files):
                                prompt_id = pid
                                node_url = base
                                _update_director_job(job_id, prompt_id=prompt_id, comfyui_node_url=base)
                                break
                if prompt_id:
                    break
            except Exception:
                continue

    if not prompt_id:
        return {"ok": False, "status": "not_found", "error": "prompt_id non trovato in nessun nodo ComfyUI"}

    # Risolvi node_url se ancora vuoto
    if not node_url:
        cfg = get_config()
        nodes = getattr(cfg.comfyui, "nodes", [])
        if nodes:
            n = nodes[0]
            node_url = f"http://{getattr(n, 'host', 'localhost')}:{getattr(n, 'port', 8188)}"

    # Controlla history sul nodo corretto
    try:
        async with httpx.AsyncClient(timeout=10.0) as http_client:
            r = await http_client.get(f"{node_url}/history/{prompt_id}")
            if not r.is_success:
                return {"ok": False, "status": "not_found_in_history", "error": f"HTTP {r.status_code}"}
            hist = r.json()
    except Exception as exc:
        return {"ok": False, "status": "comfyui_unreachable", "error": str(exc)}

    err = extract_history_error(hist)
    if err:
        _update_director_job(job_id, status="failed", error=err)
        return {"ok": False, "status": "failed", "error": err}

    files = extract_output_files(hist)
    if not files:
        # Controlla se è ancora in coda/esecuzione
        try:
            async with httpx.AsyncClient(timeout=5.0) as hc:
                q = await hc.get(f"{node_url}/queue")
                running = q.json().get("queue_running", [])
                if any(str(item[1]) == str(prompt_id) for item in running if len(item) > 1):
                    return {"ok": False, "status": "still_running", "error": "Job ancora in esecuzione su ComfyUI"}
        except Exception:
            pass
        return {"ok": False, "status": "no_output", "error": "Nessun output disponibile in history"}

    # Scarica il risultato
    dest_path = Path(job.get("dest_path", ""))
    if not dest_path.parent.exists():
        dest_path.parent.mkdir(parents=True, exist_ok=True)

    job_type = job.get("type", "image")

    try:
        best = files[0]
        fname = best.get("filename", "")
        subfolder = best.get("subfolder", "")
        params = f"filename={fname}&subfolder={subfolder}&type=output"
        async with httpx.AsyncClient(timeout=60.0) as hc:
            dl = await hc.get(f"{node_url}/view?{params}")
            dl.raise_for_status()
            dest_path.write_bytes(dl.content)

        _update_director_job(job_id, status="done", result_path=str(dest_path))

        _fire_register(register_media(
            dest_path,
            job_type,
            job.get("project_id", ""),
            f"Director Recovered {job.get('clip_id', '')}",
            source="director_recovery",
            tags=["director", "recovered", job.get("clip_id", "")],
            generation_prompt=job.get("prompt", ""),
        ))

        project_id = job.get("project_id", "")
        fname_local = dest_path.name
        if job_type == "image":
            preview_url = f"/api/director/projects/{project_id}/images/{fname_local}"
        else:
            preview_url = f"/api/director/projects/{project_id}/clips/{fname_local}"

        return {
            "ok": True,
            "status": "done",
            "type": job_type,
            "clip_id": job.get("clip_id"),
            "project_id": project_id,
            "result_path": str(dest_path),
            "preview_url": preview_url,
        }
    except Exception as exc:
        return {"ok": False, "status": "download_failed", "error": str(exc)}


# ── AI Magic: scene description → clip prompt ──────────────────────────────────

@router.post("/ai-scene-prompt")
async def director_ai_scene_prompt(req: DirectorScenePromptRequest):
    """Genera un prompt cinematografico da una descrizione di scena via LLM."""
    from src.core.llm.factory import get_llm_adapter

    if not req.scene_description.strip():
        raise HTTPException(400, "scene_description non può essere vuota")

    system_prompt = (
        "You are a professional cinematographer and AI video prompt specialist.\n"
        "Generate a concise, cinematic motion prompt for AI video generation based on the scene description.\n"
        "Output ONLY valid JSON: {\"prompt\": \"...\"}\n"
        "The prompt should describe: camera movement, subject action, atmosphere, lighting.\n"
        "Maximum 60 words. English only. No explanations."
    )
    user_prompt = (
        f"Scene: {req.scene_description}\n"
        f"Global style: {req.global_prompt or 'cinematic'}\n"
        f"Mode: {req.mode}"
    )

    try:
        adapter = get_llm_adapter()
        result = await adapter.generate_json(
            system=system_prompt,
            user=user_prompt,
            temperature=0.7,
            max_tokens=200,
        )
        prompt_text = result.get("prompt", "")
        if not prompt_text:
            return {"ok": False, "error": "LLM non ha restituito un prompt valido"}
        return {"ok": True, "prompt": prompt_text}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}



# ── Transitions / FFmpeg assembly ─────────────────────────────────────────────

class DirectorAssembleClip(BaseModel):
    video_path: str
    duration_sec: float
    transition_in: str = "cut"


class DirectorAssembleRequest(BaseModel):
    clips: List[DirectorAssembleClip]
    output_path: Optional[str] = None
    fps: int = 24
    width: int = 1280
    height: int = 720


@router.post("/assemble")
async def director_assemble(req: DirectorAssembleRequest):
    """Assembla le clip con transizioni via FFmpeg filter_complex (xfade)."""
    import subprocess

    if not req.clips:
        raise HTTPException(400, "Nessuna clip da assemblare")

    # Verifica clip esistenti
    for c in req.clips:
        if not Path(c.video_path).exists():
            raise HTTPException(400, f"Clip non trovata: {c.video_path}")

    out_dir = _director_dir() / "assembly"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = Path(req.output_path) if req.output_path else out_dir / f"director_{uuid.uuid4().hex[:8]}.mp4"

    # Build FFmpeg command with xfade filter_complex
    inputs = []
    for c in req.clips:
        inputs += ["-i", str(c.video_path)]

    n = len(req.clips)
    if n == 1:
        # Single clip — just copy
        cmd = ["ffmpeg", "-y"] + inputs + ["-c", "copy", str(out_path)]
    else:
        # Build xfade filter chain
        filter_parts: list[str] = []
        # Running offset tracker
        cumulative = 0.0
        prev_label = "[0:v]"
        for i in range(1, n):
            trans_id = req.clips[i].transition_in
            xfade = _FFMPEG_XFADE.get(trans_id)
            dur = _TRANSITION_DURATION.get(trans_id, 0.0)
            next_input = f"[{i}:v]"
            out_label = f"[v{i}]"

            # offset = cumulative duration of prev clip minus half transition
            offset = max(0.0, cumulative + req.clips[i - 1].duration_sec - dur)
            cumulative = offset + req.clips[i - 1].duration_sec

            if xfade and dur > 0:
                filter_parts.append(
                    f"{prev_label}{next_input}xfade=transition={xfade}:duration={dur}:offset={offset:.3f}{out_label}"
                )
            else:
                # cut: just concat
                filter_parts.append(f"{prev_label}{next_input}concat=n=2:v=1:a=0{out_label}")

            prev_label = out_label

        filter_str = ";".join(filter_parts)
        # Add audio concat separately (simple)
        audio_inputs = "".join(f"[{i}:a]" for i in range(n))
        filter_str += f";{audio_inputs}concat=n={n}:v=0:a=1[a]"

        cmd = (
            ["ffmpeg", "-y"]
            + inputs
            + ["-filter_complex", filter_str,
               "-map", prev_label,
               "-map", "[a]",
               "-c:v", "libx264", "-preset", "fast", "-crf", "18",
               "-c:a", "aac", "-b:a", "192k",
               str(out_path)]
        )

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            raise HTTPException(500, f"FFmpeg error: {result.stderr[-500:]}")
    except subprocess.TimeoutExpired:
        raise HTTPException(500, "FFmpeg timeout")

    return {
        "ok": True,
        "output_path": str(out_path),
        "output_url": f"/api/director/assembly/{out_path.name}",
    }


@router.get("/assembly/{filename}")
async def serve_assembly(filename: str):
    p = _director_dir() / "assembly" / filename
    if not p.exists():
        raise HTTPException(404, "File non trovato")
    return FileResponse(str(p), media_type="video/mp4")
