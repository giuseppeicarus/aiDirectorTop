"""
API routes per i Tool di generazione standalone.
txt2img · txt2video · img2video · img_audio2video
"""
import asyncio
import json
import random
import uuid
from pathlib import Path
from typing import AsyncGenerator, Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from src.core.comfyui.pool import ComfyUINodePool, ComfyUIRunResult
from src.core.comfyui.progress import stream_pool_comfy_run
from src.core.comfyui.workflow_builder import (
    build_img2video_workflow,
    build_txt2img_workflow,
    build_txt2video_workflow,
    extract_output_files,
    list_workflows,
)
from src.core.config import get_config
from src.core.models.cinematic import CinematicShot, FramePrompt
from src.core.utils.media_registry import register_media
from src.core.utils.http_files import file_response
from src.core.utils.comfyui_outputs import download_comfyui_file
router = APIRouter()

QUALITY_STEPS = {"low": 15, "medium": 25, "high": 40, "ultra": 60}

ASPECT_RESOLUTIONS = {
    "16:9":  (1280, 720),
    "9:16":  (720, 1280),
    "1:1":   (1024, 1024),
    "21:9":  (1344, 576),
    "4:3":   (1024, 768),
    "2:3":   (768, 1024),
    "3:2":   (1024, 768),
}


def _tools_dir() -> Path:
    p = get_config().app.data_path / "tools"
    p.mkdir(parents=True, exist_ok=True)
    return p


async def _finalize_tool_artifact(
    dest: Path,
    file_info: dict,
    client,
    *,
    media_type: str,
    tool: str,
    tags: list[str],
) -> dict:
    """Scarica da ComfyUI, valida, registra in Media Library, ritorna payload SSE done."""
    expect = "video" if media_type == "video" else "image"
    await download_comfyui_file(client, file_info, dest, expect=expect)

    media_id = await register_media(
        dest, media_type, "__tools__", "AI Tools",
        source="tools",
        tags=tags,
    )
    preview = (
        f"/api/media/file/{media_id}" if media_id
        else f"/api/tools/output/{dest.name}"
    )
    return {
        "type": media_type,
        "filename": dest.name,
        "path": str(dest),
        "media_id": media_id,
        "preview_url": preview,
    }


# ── Request models ─────────────────────────────────────────────────────────────

class ToolRunRequest(BaseModel):
    tool: str                       # txt2img | txt2video | img2video | img_audio2video
    prompt: str
    negative_prompt: str = ""
    aspect_ratio: str = "16:9"
    width: Optional[int] = None     # se fornito, sovrascrive aspect_ratio lookup
    height: Optional[int] = None    # se fornito, sovrascrive aspect_ratio lookup
    quality: str = "medium"         # low | medium | high | ultra
    fps: int = 24
    duration_sec: float = 6.0
    seed: Optional[int] = None
    workflow_id: Optional[str] = None
    image_path: Optional[str] = None
    audio_path: Optional[str] = None


class EnhanceRequest(BaseModel):
    prompt: str
    tool: str = "txt2img"
    negative_prompt: str = ""


# ── Minimal shot shim for workflow_builder ─────────────────────────────────────

class _MinimalShot:
    """Shim to feed build_img2video_workflow without a full CinematicShot."""
    def __init__(self, job_id: str, prompt: str, image_path: str):
        self.shot_id = f"tool_{job_id}"
        self.motion_prompt = prompt
        self.first_frame = FramePrompt(prompt=prompt, image_path=image_path)
        self.last_frame = None


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.post("/run")
async def run_tool(req: ToolRunRequest):
    """SSE: esegue una generazione ComfyUI standalone."""

    async def stream() -> AsyncGenerator[str, None]:
        try:
            if req.width and req.height:
                w, h = req.width, req.height
            else:
                w, h = ASPECT_RESOLUTIONS.get(req.aspect_ratio, (1280, 720))
            seed = req.seed if req.seed is not None else random.randint(0, 2 ** 32)
            pool = ComfyUINodePool()
            cfg = get_config()
            out_dir = _tools_dir()
            out_dir.mkdir(parents=True, exist_ok=True)
            job_id = uuid.uuid4().hex[:8]

            def ev(data: dict) -> str:
                return "data: " + json.dumps(data) + "\n\n"

            yield ev({"event": "start", "job_id": job_id})

            # ── txt2img ──────────────────────────────────────────────────────
            steps = QUALITY_STEPS.get(req.quality, 25)

            if req.tool == "txt2img":
                frame = FramePrompt(
                    prompt=req.prompt,
                    negative_prompt=req.negative_prompt or "",
                    seed=seed,
                )
                prefix = f"tool_{job_id}"
                wf = build_txt2img_workflow(frame, prefix, width=w, height=h,
                                            steps=steps, workflow_id=req.workflow_id)
                yield ev({"event": "progress", "msg": "Accodamento ComfyUI…", "pct": 0.02})
                run = None
                async for item in stream_pool_comfy_run(
                    pool, wf,
                    timeout=cfg.comfyui.execution_timeout_sec,
                    start=0.05, end=0.88, label="Immagine",
                ):
                    if "_result" in item:
                        run = item["_result"]
                    else:
                        yield ev(item)
                files = extract_output_files(run.history)
                if not files:
                    yield ev({"error": "Nessun output da ComfyUI"}); return

                yield ev({"event": "progress", "msg": "Download risultato…", "pct": 0.92})
                dest = out_dir / f"{prefix}.png"
                artifact = await _finalize_tool_artifact(
                    dest, files[0], run.client,
                    media_type="image", tool=req.tool,
                    tags=["tools", "txt2img", f"{w}x{h}"],
                )
                yield ev({"done": True, "job_id": job_id, **artifact})

            # ── txt2video ────────────────────────────────────────────────────
            elif req.tool == "txt2video":
                prefix = f"tool_{job_id}"
                wf = build_txt2video_workflow(
                    req.prompt, prefix, width=w, height=h,
                    duration_sec=req.duration_sec, fps=req.fps,
                    steps=steps, workflow_id=req.workflow_id,
                )
                yield ev({"event": "progress", "msg": "Accodamento ComfyUI…", "pct": 0.02})
                run = None
                async for item in stream_pool_comfy_run(
                    pool, wf,
                    timeout=cfg.comfyui.execution_timeout_sec,
                    start=0.05, end=0.88, label="Video",
                ):
                    if "_result" in item:
                        run = item["_result"]
                    else:
                        yield ev(item)
                files = extract_output_files(run.history)
                if not files:
                    yield ev({"error": "Nessun output da ComfyUI"}); return

                fname = files[0]["filename"]
                ext = Path(fname).suffix or ".mp4"
                dest = out_dir / f"{prefix}{ext}"
                yield ev({"event": "progress", "msg": "Download video…", "pct": 0.9})
                artifact = await _finalize_tool_artifact(
                    dest, files[0], run.client,
                    media_type="video", tool=req.tool,
                    tags=["tools", "txt2video", f"{w}x{h}"],
                )
                yield ev({"done": True, "job_id": job_id, **artifact})

            # ── img2video / img_audio2video ───────────────────────────────────
            elif req.tool in ("img2video", "img_audio2video"):
                if not req.image_path or not Path(req.image_path).exists():
                    yield ev({"error": "Immagine sorgente non trovata: " + (req.image_path or "nessuna")})
                    return

                run_client = await pool.get_client()
                yield ev({"event": "progress", "msg": "Upload immagine a ComfyUI…", "pct": 0.08})
                fn = await run_client.upload_image(Path(req.image_path))

                use_audio = req.tool == "img_audio2video"
                audio_filename = None
                if use_audio and req.audio_path:
                    audio_path = Path(req.audio_path)
                    if not audio_path.exists():
                        yield ev({"error": f"File audio non trovato: {req.audio_path}"})
                        return
                    yield ev({"event": "progress", "msg": "Upload audio…", "pct": 0.12})
                    audio_filename = audio_path.name

                prefix = f"tool_{job_id}"
                shot = _MinimalShot(job_id, req.prompt, req.image_path)
                wf = build_img2video_workflow(
                    shot, fn, fn, prefix,
                    audio_filename=audio_filename,
                    width=w, height=h,
                    duration_sec=req.duration_sec,
                    fps=req.fps,
                    workflow_id=req.workflow_id,
                    use_audio_track=use_audio and bool(audio_filename),
                )
                yield ev({"event": "progress", "msg": "Accodamento ComfyUI…", "pct": 0.14})
                hist = None
                run = None
                async for item in stream_pool_comfy_run(
                    pool, wf,
                    client=run_client,
                    timeout=cfg.comfyui.execution_timeout_sec,
                    start=0.16, end=0.88, label="Video",
                ):
                    if "_result" in item:
                        run = item["_result"]
                    else:
                        yield ev(item)
                files = extract_output_files(run.history)
                if not files:
                    yield ev({"error": "Nessun output da ComfyUI"}); return

                fname = files[0]["filename"]
                ext = Path(fname).suffix or ".mp4"
                dest = out_dir / f"{prefix}{ext}"
                yield ev({"event": "progress", "msg": "Download video…", "pct": 0.9})
                artifact = await _finalize_tool_artifact(
                    dest, files[0], run.client,
                    media_type="video", tool=req.tool,
                    tags=["tools", req.tool, f"{w}x{h}"],
                )
                yield ev({"done": True, "job_id": job_id, **artifact})

            else:
                yield ev({"error": f"Tool sconosciuto: {req.tool}"})

        except Exception as exc:
            yield "data: " + json.dumps({"error": str(exc)}) + "\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/enhance-prompt")
async def enhance_prompt(req: EnhanceRequest):
    """Usa LLM per migliorare il prompt."""
    from src.core.llm.factory import get_llm_adapter

    cfg = get_config()
    try:
        role_cfg = cfg.get_llm_for_role("prompt_engineer")
    except Exception:
        raise HTTPException(500, "Nessun LLM configurato")

    adapter = get_llm_adapter(role_cfg)
    tool_desc = {
        "txt2img":          "AI image generation (Stable Diffusion / FLUX style)",
        "txt2video":        "AI video generation (LTX Video / CogVideoX)",
        "img2video":        "img-to-video motion prompt (camera + subject movement, max 20 words)",
        "img_audio2video":  "img+audio-to-video motion prompt",
    }.get(req.tool, "AI generation")

    from src.core.llm.prompt_enhance import (
        NEGATIVE_BLOCK_MARKER,
        needs_negative_prompt,
        parse_enhance_llm_result,
        split_positive_and_negative,
    )

    wants_neg = needs_negative_prompt(req.tool)
    orig_pos, orig_neg = split_positive_and_negative(req.prompt, req.negative_prompt)

    if wants_neg:
        marker = NEGATIVE_BLOCK_MARKER
        schema = (
            f'{{"enhanced": "<positive prompt>\\n\\n{marker}\\n<negative tags in English>"}}'
        )
        neg_hint = (
            f"Original text may include a negative section after '{marker}'.\n"
            f"Original negative to improve: {orig_neg or '(use standard quality exclusions)'}\n"
            "Return ONE string in 'enhanced': improved positive, then a blank line, "
            f"then exactly '{marker}', then comma-separated negative tags (English). "
            "Do NOT use separate JSON keys for negative — everything inside 'enhanced'."
        )
    else:
        schema = '{"enhanced": "<improved prompt>"}'
        neg_hint = ""

    result = await adapter.generate_json(
        system=(
            "You are an expert AI prompt engineer for image/video generation. "
            f"Respond with EXACTLY one JSON object: {schema}. "
            "The 'enhanced' value is ONE plain-text string (never nested JSON). "
            "No markdown, no thinking tags, no explanation."
        ),
        user=(
            f"Improve this prompt for {tool_desc}.\n"
            f"Make it more detailed, cinematic, specific. Keep the same creative intent.\n"
            f"Original:\n{orig_pos}\n"
            f"{neg_hint}\n\n"
            f"Return only: {schema}"
        ),
        temperature=0.75,
        max_tokens=700,
    )
    parsed = parse_enhance_llm_result(
        result,
        orig_pos,
        original_negative=orig_neg,
        tool=req.tool,
    )
    return {
        "enhanced": parsed["enhanced"],
        "positive": parsed.get("positive"),
        "negative_prompt": parsed.get("negative_prompt"),
    }


@router.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    """Carica un file (immagine/audio) per i tool."""
    uploads = _tools_dir() / "uploads"
    uploads.mkdir(exist_ok=True)
    safe = f"{uuid.uuid4().hex[:8]}_{file.filename}"
    dest = uploads / safe
    dest.write_bytes(await file.read())
    return {"path": str(dest), "filename": safe, "original_name": file.filename}


@router.get("/output/{filename:path}")
async def serve_output(filename: str):
    """Serve i file generati dai tool."""
    root = _tools_dir().resolve()
    p = (root / Path(filename).name).resolve()
    try:
        p.relative_to(root)
    except ValueError:
        raise HTTPException(400, "Percorso non valido")
    if not p.is_file():
        raise HTTPException(404, "File non trovato")
    return file_response(p, inline=True)


@router.get("/workflows")
async def get_tool_workflows():
    return list_workflows()
