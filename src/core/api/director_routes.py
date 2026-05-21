"""
API routes per Director Cinema — generazione video timeline-based con LTX Director.
POST /api/director/generate  — SSE stream
POST /api/director/enhance   — miglioramento prompt via LLM
"""
import asyncio
import copy
import json
import uuid
from pathlib import Path
from typing import AsyncGenerator, List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from src.core.comfyui.pool import ComfyUINodePool
from src.core.comfyui.progress import stream_pool_comfy_run
from src.core.comfyui.workflow_builder import WORKFLOWS_DIR, get_workflow, list_workflows, extract_output_files
from src.core.config import get_config
from src.core.utils.media_registry import register_media

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
    context: str = "director_clip"    # director_clip | director_global


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


@router.post("/enhance")
async def director_enhance(req: DirectorEnhanceRequest):
    """Usa LLM per migliorare un prompt di clip o il prompt globale."""
    from src.core.llm.factory import get_llm_adapter
    cfg = get_config()
    try:
        role_cfg = cfg.get_llm_for_role("prompt_engineer")
    except Exception:
        raise HTTPException(500, "Nessun LLM configurato")

    adapter = get_llm_adapter(role_cfg)
    ctx = (
        "LTX Director cinematic motion prompt (camera movement, subject action, atmosphere, max 30 words)"
        if req.context == "director_clip"
        else "LTX Director global scene description (overall mood, style, visual theme)"
    )

    from src.core.llm.prompt_enhance import parse_enhance_llm_result

    result = await adapter.generate_json(
        system=(
            "You are an expert AI prompt engineer for cinematic video generation. "
            'Respond with EXACTLY one JSON object: '
            '{"enhanced": "<single improved prompt as plain text>"}. '
            "The enhanced value must be ONE string only — no nested JSON, no extra keys. "
            "No markdown, no thinking tags, no explanation."
        ),
        user=(
            f"Improve this prompt for {ctx}.\n"
            f"Make it more cinematic, specific and descriptive. Keep the same creative intent.\n"
            f"Original: {req.prompt}\n\n"
            'Return only: {"enhanced": "your improved prompt here"}'
        ),
        temperature=0.75,
        max_tokens=500,
    )
    parsed = parse_enhance_llm_result(result, req.prompt, tool="director_clip")
    return {
        "enhanced": parsed["enhanced"],
        "positive": parsed.get("positive"),
        "negative_prompt": parsed.get("negative_prompt"),
    }


@router.get("/output/{filename:path}")
async def serve_output(filename: str):
    """Serve i video generati da Director Cinema."""
    p = _director_dir() / filename
    if not p.exists():
        raise HTTPException(404, "File non trovato")
    return FileResponse(str(p))
