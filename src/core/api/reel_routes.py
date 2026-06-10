"""API CreateReel — generazione reel da brief + immagini di riferimento."""

from __future__ import annotations

import asyncio
import json
import tempfile
import uuid
from pathlib import Path
from typing import AsyncGenerator, List, Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from src.core.config import get_config
from src.core.utils.http_files import file_response
from src.core import pipeline_registry

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
    txt2img_workflow: str = "z_image_turbo_txt2img"
    img2video_workflow: str = "ltx_img2video"
    img_audio2video_workflow: str = "ltx_img_audio2video"
    concurrent_jobs: int = 1
    max_clip_sec: float = 5.0
    num_slots: int = 0
    resume_job_id: Optional[str] = None
    phase: str = "full"
    clip_backend: str = "auto"
    allow_ffmpeg_fallback: bool = True
    storyboard_max_side: int = Field(default=320, ge=96, le=768)
    storyboard_steps: int = Field(default=10, ge=4, le=40)
    hd_frame_steps: int = Field(default=25, ge=4, le=50)
    audio_path: Optional[str] = None
    audio_name: str = ""
    audio_start_sec: float = Field(default=0.0, ge=0.0)
    lyrics: Optional[str] = None
    character_mode: str = "none"
    character_id: Optional[str] = None
    character_owner_id: str = "local_user"
    regen_clip_id: Optional[str] = None      # fase regen_clip: ID clip da rigenerare
    regen_asset: Optional[str] = None        # first | last | video


class ReelAudioAnalyzeRequest(BaseModel):
    audio_path: str
    audio_start_sec: float = Field(default=0.0, ge=0.0)
    duration_sec: int = Field(default=30, ge=8, le=180)
    lyrics: Optional[str] = None


class WhisperTranscribeRequest(BaseModel):
    audio_path: str
    audio_start_sec: float = 0.0
    duration_sec: float = 30.0
    model_size: str = "base"
    language: Optional[str] = None


@router.post("/transcribe-whisper")
async def transcribe_whisper_endpoint(req: WhisperTranscribeRequest):
    """Trascrive audio con Whisper locale e restituisce SRT + parole + lyrics lines."""
    import structlog

    log = structlog.get_logger()

    audio_path = Path(req.audio_path)
    if not audio_path.exists():
        raise HTTPException(status_code=404, detail=f"Audio non trovato: {req.audio_path}")

    # Check that whisper is installed before doing any ffmpeg work
    try:
        import whisper as _whisper_check  # noqa: F401
    except ImportError:
        return {
            "ok": False,
            "error": "Whisper non installato. Esegui: pip install openai-whisper torch",
        }

    from src.core.utils.lyrics_align import transcribe_whisper, words_to_srt

    # Determine total duration via ffmpeg probe (best-effort)
    total_duration: Optional[float] = None
    try:
        import subprocess as _sp
        probe = _sp.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(audio_path),
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if probe.returncode == 0 and probe.stdout.strip():
            total_duration = float(probe.stdout.strip())
    except Exception:
        pass

    # Determine whether we need to slice the audio
    needs_slice = req.audio_start_sec > 0.0 or (
        total_duration is not None and req.duration_sec < total_duration - 0.5
    )

    work_audio_path: str = str(audio_path)
    tmp_file = None
    try:
        if needs_slice:
            suffix = audio_path.suffix.lower() or ".wav"
            tmp_file = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
            tmp_path = Path(tmp_file.name)
            tmp_file.close()

            from src.core.workflow.trailer_pipeline import _run_ffmpeg
            rc, err = await _run_ffmpeg(
                "-y",
                "-ss", f"{req.audio_start_sec:.3f}",
                "-t", f"{req.duration_sec:.3f}",
                "-i", str(audio_path),
                "-ar", "16000",
                "-ac", "1",
                str(tmp_path),
            )
            if rc != 0 or not tmp_path.exists():
                log.warning(
                    "whisper_ffmpeg_slice_failed",
                    rc=rc,
                    err=(err or "")[-200:],
                )
                # Fall through and transcribe the original file
            else:
                work_audio_path = str(tmp_path)

        log.info(
            "whisper_transcribe_start",
            path=work_audio_path,
            model=req.model_size,
            language=req.language,
        )
        result = await asyncio.get_event_loop().run_in_executor(
            None,
            lambda: transcribe_whisper(
                work_audio_path,
                model_size=req.model_size,
                language=req.language,
            ),
        )

        words = result.get("words", [])
        detected_language = result.get("language", "")
        srt_string = words_to_srt(words)

        # Build lyrics_lines: one string per SRT segment (text of each block)
        lyrics_lines: List[str] = []
        if words:
            from src.core.utils.lyrics_align import words_to_srt as _w2srt
            # Re-group words into segments the same way words_to_srt does
            _max_gap = 1.5
            _max_words = 8
            segments: List[List[dict]] = []
            current: List[dict] = [words[0]]
            for w in words[1:]:
                gap = w["start"] - current[-1]["end"]
                if gap > _max_gap or len(current) >= _max_words:
                    segments.append(current)
                    current = [w]
                else:
                    current.append(w)
            if current:
                segments.append(current)
            lyrics_lines = [" ".join(w["word"] for w in seg) for seg in segments]

        log.info(
            "whisper_transcribe_done",
            words=len(words),
            language=detected_language,
            srt_lines=len(lyrics_lines),
        )
        return {
            "ok": True,
            "srt": srt_string,
            "words": words,
            "language": detected_language,
            "lyrics_lines": lyrics_lines,
        }

    except Exception as exc:
        log.warning("whisper_transcribe_error", error=str(exc))
        return {"ok": False, "error": str(exc)}
    finally:
        if tmp_file is not None:
            try:
                Path(tmp_file.name).unlink(missing_ok=True)
            except Exception:
                pass


@router.get("/workflows")
async def reel_workflows():
    """Return available ComfyUI workflows grouped by type (txt2img, img2video, img_audio2video)."""
    manifest_path = Path(__file__).parents[3] / "config" / "workflows" / "manifest.json"
    if not manifest_path.exists():
        return {"txt2img": [], "img2video": [], "img_audio2video": []}
    with manifest_path.open(encoding="utf-8") as f:
        data = json.load(f)
    result: dict = {"txt2img": [], "img2video": [], "img_audio2video": []}
    for wf in data.get("workflows", []):
        t = wf.get("type", "")
        if t in result:
            result[t].append({"id": wf["id"], "name": wf.get("name", wf["id"]), "description": wf.get("description", "")})
    return result


@router.post("/analyze-audio")
async def reel_analyze_audio(req: ReelAudioAnalyzeRequest):
    """Analisi BPM/sezioni + timing lirica manuale sulla finestra reel."""
    from pathlib import Path as P

    import structlog

    log = structlog.get_logger()

    audio_path = P(req.audio_path)
    if not audio_path.exists():
        raise HTTPException(status_code=404, detail=f"Audio not found: {req.audio_path}")

    from src.core.utils.reel_audio import analyze_reel_audio_window
    from src.core.config import get_config

    work = get_config().app.data_path / "uploads" / "reel_analyze"
    work.mkdir(parents=True, exist_ok=True)

    timeout_sec = max(90.0, min(300.0, float(req.duration_sec) * 3))
    log.info(
        "reel_analyze_audio_start",
        path=str(audio_path),
        start_sec=req.audio_start_sec,
        duration_sec=req.duration_sec,
        timeout_sec=timeout_sec,
    )
    try:
        sections, downbeats, duration, lyric_beats = await asyncio.wait_for(
            analyze_reel_audio_window(
                audio_path,
                start_sec=req.audio_start_sec,
                duration_sec=float(req.duration_sec),
                work_dir=work,
                lyrics=req.lyrics,
            ),
            timeout=timeout_sec,
        )
    except asyncio.TimeoutError:
        log.warning("reel_analyze_audio_timeout", timeout_sec=timeout_sec)
        raise HTTPException(
            status_code=504,
            detail=(
                f"Analisi audio scaduta dopo {int(timeout_sec)}s. "
                "Riduci la durata del reel o verifica che ffmpeg sia disponibile."
            ),
        ) from None

    log.info(
        "reel_analyze_audio_done",
        sections=len(sections),
        downbeats=len(downbeats),
        lyric_beats=len(lyric_beats),
    )
    return {
        "duration_sec": round(duration, 2),
        "audio_start_sec": req.audio_start_sec,
        "bpm": sections[0].bpm_local if sections else 0,
        "sections": [s.model_dump() for s in sections],
        "downbeat_count": len(downbeats),
        "lyric_beats": lyric_beats,
    }


@router.post("/generate")
async def reel_generate(req: ReelGenerateRequest):
    from src.core.workflow.reel_pipeline import ReelPipeline, ReelRequest

    # Ensure we have a stable job_id before the pipeline starts so we can
    # register the asyncio task for cancellation support.
    job_id = req.resume_job_id or uuid.uuid4().hex[:10]
    req_dict = req.model_dump()
    req_dict["resume_job_id"] = job_id
    # CreateReel must submit one generation workflow at a time to ComfyUI.
    # Ignore stale UI/local-storage values that may still send a higher value.
    req_dict["concurrent_jobs"] = 1
    reel_req = ReelRequest(**req_dict)

    q: asyncio.Queue = asyncio.Queue()
    activity_title = (req.title or req.description[:60]).strip() or "Reel"

    async def _run() -> None:
        try:
            pipeline = ReelPipeline(reel_req)
            async for event in pipeline.run():
                if isinstance(event, dict):
                    event.setdefault("job_id", job_id)
                    event.setdefault("title", activity_title)
                    event.setdefault("catalog_project_id", req.project_id)
                await q.put(event)
                # Update registry with live progress
                if isinstance(event, dict):
                    pipeline_registry.update_job(
                        job_id,
                        stage=event.get("phase", event.get("stage", "")),
                        progress=event.get("progress_pct", event.get("progress", 0)) / 100
                            if event.get("progress_pct") is not None else event.get("progress", 0),
                        message=event.get("message", event.get("msg", "")),
                    )
        except asyncio.CancelledError:
            from src.core.workflow.reel_jobs import interrupt_job_everywhere

            interrupt_job_everywhere(job_id, error="Pipeline annullata")
            await q.put({"cancelled": True, "job_id": job_id})
            pipeline_registry.complete_job(job_id, status="cancelled")
            return
        except Exception as exc:
            await q.put({"error": str(exc), "job_id": job_id})
            pipeline_registry.complete_job(job_id, status="failed", error=str(exc))
            return
        finally:
            await q.put(None)  # sentinel — stream ends

    pipeline_registry.register_job(
        job_id,
        kind="reel",
        title=activity_title,
        project_id=req.project_id,
    )
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
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/jobs/{project_id}/{job_id}/resume-background")
async def resume_reel_job_background(project_id: str, job_id: str):
    """Resume a reel without tying its lifetime to an SSE client connection."""
    from src.core.workflow.reel_jobs import interrupt_job_everywhere
    from src.core.workflow.reel_pipeline import ReelPipeline, ReelRequest

    if pipeline_registry.is_task_running(job_id):
        return {"job_id": job_id, "status": "running", "already_running": True}

    job = _find_reel_job_record(project_id, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    request_data = dict(job.config)
    request_data.update(
        {
            "project_id": project_id,
            "resume_job_id": job_id,
            "phase": "production",
            "concurrent_jobs": 1,
        }
    )
    reel_request = ReelRequest(**request_data)
    activity_title = (job.title or job.description[:60]).strip() or "Reel"

    async def _run_background() -> None:
        terminal_status = "completed"
        terminal_error = None
        try:
            pipeline = ReelPipeline(reel_request)
            async for event in pipeline.run():
                if not isinstance(event, dict):
                    continue
                pipeline_registry.update_job(
                    job_id,
                    stage=event.get("phase", event.get("stage", "")),
                    progress=(
                        event.get("progress_pct", 0) / 100
                        if event.get("progress_pct") is not None
                        else event.get("progress", event.get("pct", 0))
                    ),
                    message=event.get("message", event.get("msg", "")),
                )
                if event.get("error") and event.get("event") not in {
                    "clip_error",
                    "frame_error",
                }:
                    terminal_status = "failed"
                    terminal_error = str(event["error"])
                    break
                if event.get("cancelled"):
                    terminal_status = "cancelled"
                    break
                if event.get("done"):
                    break
        except asyncio.CancelledError:
            terminal_status = "cancelled"
            interrupt_job_everywhere(job_id, error="Pipeline annullata")
        except Exception as exc:
            terminal_status = "failed"
            terminal_error = str(exc)
            interrupt_job_everywhere(job_id, error=terminal_error)
            log.exception("reel_background_resume_failed", job_id=job_id)
        finally:
            pipeline_registry.complete_job(
                job_id,
                status=terminal_status,
                error=terminal_error,
            )

    pipeline_registry.register_job(
        job_id,
        kind="reel",
        title=activity_title,
        project_id=project_id,
    )
    task = asyncio.create_task(_run_background())
    pipeline_registry.register_task(job_id, task)
    return {"job_id": job_id, "status": "running", "background": True}


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
    from src.core.workflow.reel_jobs import load_jobs, job_storage_project_id, upsert_job
    from src.core import pipeline_registry

    jobs = load_jobs(project_id)
    changed = False
    for j in jobs:
        if j.status == "running" and not pipeline_registry.is_task_running(j.job_id):
            j.status = "interrupted"
            j.error = j.error or "Pipeline interrotta (app o backend riavviato)"
            changed = True
    if changed:
        for j in jobs:
            if j.status == "interrupted":
                upsert_job(j)

    out_jobs = []
    for j in jobs:
        row = {
            **j.model_dump(),
            "storage_project_id": job_storage_project_id(j),
        }
        cp = _find_reel_checkpoint(project_id, j.job_id)
        row["has_checkpoint"] = cp is not None
        if j.status in ("interrupted", "failed") and cp is not None:
            row["can_resume"] = True
        elif j.status == "awaiting_storyboard":
            row["can_resume"] = True
        else:
            row["can_resume"] = False
        out_jobs.append(row)

    return {"jobs": out_jobs}


def _find_reel_job_record(project_id: str, job_id: str):
    from src.core.workflow.reel_jobs import load_jobs, ReelJobRecord

    candidates = [project_id, "reel_standalone", f"reel_{job_id}", job_id]
    seen = set()
    for cat in candidates:
        if not cat or cat in seen:
            continue
        seen.add(cat)
        hit = next((j for j in load_jobs(cat) if j.job_id == job_id), None)
        if hit:
            return hit
    return None


def _load_reel_pipeline_from_checkpoint(project_id: str, job_id: str):
    """Istanzia ReelPipeline da checkpoint per regen / reconcile / dettaglio job."""
    import json as _json
    from src.core.workflow.reel_pipeline import ReelPipeline, ReelRequest

    state_path = _find_reel_checkpoint(project_id, job_id)
    if not state_path:
        return None, None, None

    job_rec = _find_reel_job_record(project_id, job_id)
    raw = _json.loads(state_path.read_text(encoding="utf-8"))

    cfg = dict(job_rec.config) if job_rec else {}
    if job_rec:
        cfg.setdefault("description", job_rec.description)
        cfg.setdefault("title", job_rec.title)
    cfg["project_id"] = project_id
    cfg["description"] = cfg.get("description") or raw.get("reel_description") or ""
    cfg["resume_job_id"] = job_id
    cfg.setdefault("duration_sec", 30)
    cfg.setdefault("reference_image_paths", [])

    reel_req = ReelRequest(**cfg)
    pipeline = ReelPipeline(reel_req)
    pipeline.job_id = job_id

    storage_id = state_path.parent.name
    pipeline._storage_project_id = storage_id
    cfg_root = get_config()
    pipeline._storyboard_dir = cfg_root.app.data_path / "projects" / storage_id / "storyboard"
    pipeline._frames_dir = cfg_root.app.data_path / "projects" / storage_id / "frames"
    pipeline._clips_dir = cfg_root.app.data_path / "projects" / storage_id / "clips"
    for d in (pipeline._storyboard_dir, pipeline._frames_dir, pipeline._clips_dir):
        d.mkdir(parents=True, exist_ok=True)

    if not pipeline._load_checkpoint():
        from src.core.workflow.trailer_pipeline import TrailerClip

        pipeline._vision = raw.get("vision") or {}
        pipeline._director_narrative = raw.get("director_narrative") or {}
        pipeline._clips_list = [TrailerClip(**c) for c in raw.get("clips_list", [])]
        vp = raw.get("visual_plans")
        pipeline._visual_plans_cache = vp if isinstance(vp, dict) else {}

    return pipeline, state_path, raw


def _hydrate_reel_job_detail(project_id: str, job_id: str) -> dict:
    """Unisce reel_jobs.json + checkpoint + file su disco per la UI dettaglio."""
    from src.core.workflow.reel_jobs import job_storage_project_id
    from src.core.workflow.reel_pipeline import _reel_clip_sse_payload
    from urllib.parse import quote

    job = _find_reel_job_record(project_id, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    out = job.model_dump()
    out["storage_project_id"] = job_storage_project_id(job)
    result = dict(out.get("result") or {})

    loaded = _load_reel_pipeline_from_checkpoint(project_id, job_id)
    pipeline = loaded[0] if loaded else None
    raw = loaded[2] if loaded else {}

    if pipeline:
        result["vision"] = pipeline._vision or result.get("vision")
        result["director_narrative"] = (
            pipeline._director_narrative or result.get("director_narrative")
        )
        vp = getattr(pipeline, "_visual_plans_cache", None) or raw.get("visual_plans") or {}
        if isinstance(vp, dict):
            result["visual_plans"] = list(vp.values())
        elif isinstance(vp, list):
            result["visual_plans"] = vp

        storyboard = pipeline._storyboard_frames_payload()
        if storyboard:
            result["storyboard"] = storyboard

        visual_plans = vp if isinstance(vp, dict) else {}
        clips_ui = []
        api = pipeline._media_api_prefix()
        storage = pipeline._storage_project_id

        for clip in pipeline._clips_list:
            row = _reel_clip_sse_payload(clip, storage, pipeline, visual_plans)
            clip_dest = pipeline._clips_dir / f"{clip.clip_id}.mp4"
            if clip.clip_path and Path(clip.clip_path).is_file():
                p = Path(clip.clip_path)
                row["clip_url"] = f"/api/{api}/clips/{storage}/{p.name}"
                row["status"] = "done"
            elif clip_dest.is_file() and clip_dest.stat().st_size > 50_000:
                row["clip_url"] = f"/api/{api}/clips/{storage}/{clip_dest.name}"
                row["status"] = "done"
            elif clip.storyboard_path and Path(clip.storyboard_path).is_file():
                row["status"] = "storyboard"
                row["storyboard_ok"] = True
            elif pipeline._resolve_storyboard_file(
                clip, pipeline._storyboard_dir / f"{clip.clip_id}_sb.png",
            ):
                row["status"] = "storyboard"
                row["storyboard_ok"] = True
            else:
                row["status"] = row.get("status") or "waiting"

            ff = pipeline._frames_dir / f"{clip.clip_id}_first.png"
            if clip.first_frame_path:
                ff = Path(clip.first_frame_path)
            if ff.is_file() and ff.stat().st_size > 4096:
                row["first_frame_path"] = str(ff)
                row["hd_frame_ready"] = True
                row["frame_url"] = f"/api/{api}/frames-clip/{storage}/{clip.clip_id}"
                if row["status"] not in ("done",):
                    row["clip_phase"] = "frame_gen"

            lf = pipeline._frames_dir / f"{clip.clip_id}_last.png"
            if clip.last_frame_path:
                lf = Path(clip.last_frame_path)
            lf_is_distinct = False
            if lf.is_file() and lf.stat().st_size > 4096:
                try:
                    import filecmp

                    lf_is_distinct = not (
                        ff.is_file()
                        and (
                            lf.resolve() == ff.resolve()
                            or filecmp.cmp(str(lf), str(ff), shallow=False)
                        )
                    )
                except Exception:
                    lf_is_distinct = lf.name.endswith("_last.png") and lf != ff
            if lf_is_distinct:
                row["last_frame_path"] = str(lf)

            sb = pipeline._resolve_storyboard_file(
                clip, pipeline._storyboard_dir / f"{clip.clip_id}_sb.png",
            )
            if sb:
                path_str = str(sb)
                row["storyboard_path"] = path_str
                row["storyboard_filename"] = sb.name
                row["preview_url"] = f"/api/{api}/source?path={quote(path_str, safe='')}"
                row["storyboard_clip_url"] = f"/api/{api}/storyboard-clip/{storage}/{clip.clip_id}"

            clips_ui.append(row)

        if clips_ui:
            result["clips"] = clips_ui

        cfg_root = get_config()
        out["project_dir"] = str(
            (cfg_root.app.data_path / "projects" / storage).resolve(),
        )

    out["result"] = result
    out["has_checkpoint"] = pipeline is not None

    if raw:
        phase_num = int(raw.get("phase") or 0)
        sb_ok = bool(raw.get("storyboard_approved"))
        out["checkpoint_phase"] = phase_num
        out["storyboard_approved"] = sb_ok
        if sb_ok and phase_num >= 6:
            out["pipeline_ui_phase"] = "production"
            out["progress_pct"] = max(
                46,
                min(99, 46 + max(0, phase_num - 55 if phase_num >= 55 else phase_num)),
            )
        elif phase_num >= 55:
            out["pipeline_ui_phase"] = "storyboard"
            out["progress_pct"] = 45
        else:
            out["pipeline_ui_phase"] = "llm"
            _phase_pct = {1: 8, 2: 14, 3: 22, 4: 30, 5: 40}
            out["progress_pct"] = _phase_pct.get(phase_num, min(42, phase_num * 8))

    if job.status == "running" and out.get("progress_pct") is None:
        out["progress_pct"] = 5

    task_live = pipeline_registry.is_task_running(job_id)
    out["task_running"] = task_live
    out["paused"] = pipeline_registry.is_job_paused(job_id)
    if job.status in ("running", "paused") and not task_live:
        out["stale_running"] = True
        out["can_stop"] = True
        out["can_pause"] = False
        out["can_resume_pause"] = False
        out["can_continue"] = bool(raw.get("phase"))
    else:
        out["stale_running"] = False
        out["can_stop"] = task_live
        out["can_pause"] = task_live and not pipeline_registry.is_job_paused(job_id)
        out["can_resume_pause"] = task_live and pipeline_registry.is_job_paused(job_id)
        out["can_continue"] = False

    if job.status in ("interrupted", "failed"):
        resumable = bool(
            raw.get("phase")
            or pipeline is not None
            or result.get("clips")
            or result.get("storyboard")
        )
        if task_live:
            out["can_continue"] = False
            out["stale_running"] = False
            out["can_stop"] = True
            out["can_pause"] = not pipeline_registry.is_job_paused(job_id)
            out["can_resume_pause"] = pipeline_registry.is_job_paused(job_id)
        elif resumable:
            out["can_continue"] = True
            out["stale_running"] = job.status == "interrupted"

    return out


@router.get("/jobs/{project_id}/{job_id}")
async def get_reel_job(project_id: str, job_id: str):
    """Dettaglio job con clip, storyboard e regia ricostruiti da checkpoint e disco."""
    return _hydrate_reel_job_detail(project_id, job_id)


@router.post("/jobs/{project_id}/{job_id}/stop")
async def stop_reel_job(project_id: str, job_id: str):
    """Ferma pipeline reel (task asyncio) e marca job interrupted su disco."""
    from src.core.workflow.reel_jobs import interrupt_job_everywhere

    stop_info = pipeline_registry.force_stop_job(job_id)
    interrupt_job_everywhere(job_id, error="Pipeline interrotta dall'utente")
    return {"ok": True, "job_id": job_id, **stop_info}


@router.post("/jobs/{project_id}/{job_id}/pause")
async def pause_reel_job(project_id: str, job_id: str):
    if not pipeline_registry.pause_job(job_id):
        raise HTTPException(
            status_code=404,
            detail="Job non in esecuzione o già terminato — impossibile mettere in pausa",
        )
    return {"ok": True, "job_id": job_id, "paused": True}


@router.post("/jobs/{project_id}/{job_id}/resume-pause")
async def resume_pause_reel_job(project_id: str, job_id: str):
    if not pipeline_registry.resume_job(job_id):
        raise HTTPException(status_code=404, detail="Job non in pausa o non attivo")
    return {"ok": True, "job_id": job_id, "paused": False}


@router.delete("/jobs/{project_id}/{job_id}")
async def delete_reel_job(project_id: str, job_id: str, cleanup: bool = False):
    from src.core.workflow.reel_jobs import remove_job, interrupt_job_everywhere
    from src.core import pipeline_registry

    # Force-stop any running task before removing the record
    pipeline_registry.force_stop_job(job_id)
    interrupt_job_everywhere(job_id, error="Job eliminato dall'utente")

    # Try the given project_id first, then fall back to all candidate directories
    if not remove_job(project_id, job_id, cleanup_files=cleanup):
        from src.core.config import get_config as _gc
        _cfg = _gc()
        projects_root = _cfg.app.data_path / "projects"
        removed = False
        if projects_root.exists():
            for cat_dir in projects_root.iterdir():
                if cat_dir.is_dir() and cat_dir.name != project_id:
                    if remove_job(cat_dir.name, job_id, cleanup_files=cleanup):
                        removed = True
                        break
        if not removed:
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


@router.get("/source")
async def serve_reel_source(path: str):
    """Serve file locale per anteprima (stesso comportamento di /api/trailer/source)."""
    from src.core.api.trailer_routes import serve_source_audio

    return await serve_source_audio(path)


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


@router.get("/frames/{project_id}/{filename:path}")
async def serve_frame(project_id: str, filename: str):
    """Serve frame images (first/last) for reel clips."""
    from src.core.api.trailer_routes import _find_frame_file
    from src.core.utils.project_paths import reel_media_search_project_ids

    for pid in reel_media_search_project_ids(project_id):
        fp = _find_frame_file(pid, filename)
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


def _reel_state_search_ids(project_id: str, job_id: str) -> list[str]:
    """All candidate project-folder IDs where reel_state_{job_id}.json might live."""
    from src.core.utils.project_paths import reel_media_search_project_ids
    ids = list(reel_media_search_project_ids(project_id))
    storage_id = f"reel_{job_id}"
    if storage_id not in ids:
        ids.insert(0, storage_id)
    return ids


def _find_reel_checkpoint(project_id: str, job_id: str) -> Optional[Path]:
    cfg = get_config()
    for pid in _reel_state_search_ids(project_id, job_id):
        p = cfg.app.data_path / "projects" / pid / f"reel_state_{job_id}.json"
        if p.exists():
            return p
    return None


def _persist_clips_to_checkpoint(state_path: Path, pipeline) -> None:
    import json as _json

    raw = _json.loads(state_path.read_text(encoding="utf-8"))
    by_id = {c.clip_id: c for c in pipeline._clips_list}
    for clip in raw.get("clips_list", []):
        tc = by_id.get(clip.get("clip_id"))
        if not tc:
            continue
        if tc.storyboard_path:
            clip["storyboard_path"] = tc.storyboard_path
        if tc.first_frame_path:
            clip["first_frame_path"] = tc.first_frame_path
    state_path.write_text(
        _json.dumps(raw, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


class ClipPatchRequest(BaseModel):
    first_frame_prompt: Optional[str] = None
    last_frame_prompt: Optional[str] = None
    motion_prompt: Optional[str] = None
    ltx_video_prompt: Optional[str] = None
    scene_prompt: Optional[str] = None


@router.patch("/jobs/{project_id}/{job_id}/clips/{clip_id}")
async def patch_clip_prompt(project_id: str, job_id: str, clip_id: str, body: ClipPatchRequest):
    """Aggiorna i prompt di una singola clip nel checkpoint del job."""
    from src.core.config import get_config
    import json as _json
    cfg = get_config()
    state_path: Optional[Path] = None
    for pid in _reel_state_search_ids(project_id, job_id):
        p = cfg.app.data_path / "projects" / pid / f"reel_state_{job_id}.json"
        if p.exists():
            state_path = p
            break

    if not state_path:
        raise HTTPException(status_code=404, detail="Checkpoint non trovato")

    raw = _json.loads(state_path.read_text(encoding="utf-8"))
    clips = raw.get("clips_list", [])
    found = False
    for clip in clips:
        if clip.get("clip_id") == clip_id:
            if body.first_frame_prompt is not None:
                clip["first_frame_prompt"] = body.first_frame_prompt
            if body.last_frame_prompt is not None:
                clip["last_frame_prompt"] = body.last_frame_prompt
            if body.motion_prompt is not None:
                clip["motion_prompt"] = body.motion_prompt
            if body.ltx_video_prompt is not None:
                clip["ltx_video_prompt"] = body.ltx_video_prompt
            if body.scene_prompt is not None:
                clip["scene_prompt"] = body.scene_prompt
            found = True
            break

    if not found:
        raise HTTPException(status_code=404, detail=f"Clip {clip_id} non trovata")

    raw["clips_list"] = clips
    state_path.write_text(_json.dumps(raw, indent=2, ensure_ascii=False), encoding="utf-8")
    return {"ok": True, "clip_id": clip_id}


@router.post("/jobs/{project_id}/{job_id}/regenerate-prompts")
async def regenerate_job_prompts(project_id: str, job_id: str):
    """
    Rigenera prompt distinti per ogni clip da checkpoint (fix slot/motion identici).
    Non rigenera immagini o video — solo testi prompt nel checkpoint.
    """
    loaded = _load_reel_pipeline_from_checkpoint(project_id, job_id)
    if not loaded[0]:
        raise HTTPException(status_code=404, detail="Checkpoint non trovato")

    pipeline, state_path, _raw = loaded
    try:
        clips = pipeline.regenerate_all_clip_prompts()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    if state_path:
        _persist_clips_to_checkpoint(state_path, pipeline)
        if pipeline._edl:
            raw = json.loads(state_path.read_text(encoding="utf-8"))
            raw["edl"] = pipeline._edl.model_dump()
            raw["director_narrative"] = pipeline._director_narrative
            raw["visual_plans"] = list(
                (getattr(pipeline, "_visual_plans_cache", None) or {}).values()
            )
            state_path.write_text(
                json.dumps(raw, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )

    return {"ok": True, "job_id": job_id, "clips": clips}


@router.post("/jobs/{project_id}/{job_id}/reconcile")
async def reconcile_job_clips(
    project_id: str,
    job_id: str,
    storyboard: bool = True,
    hd_frames: bool = False,
    videos: bool = False,
):
    """
    Recupera clip senza file locale: cerca su disco e scarica da ComfyUI (/view)
    quando il job remoto è già completato.
    """
    from src.core.workflow.media_reconcile_service import reconcile_reel_or_trailer_job

    result = await reconcile_reel_or_trailer_job(
        project_id, job_id, "reel",
        storyboard=storyboard,
        hd_frames=hd_frames,
        videos=videos,
    )
    if not result.get("ok") and result.get("error") == "Checkpoint non trovato":
        raise HTTPException(status_code=404, detail="Checkpoint non trovato")
    return result


@router.get("/jobs/{project_id}/{job_id}/clips/{clip_id}/regen")
async def regen_single_clip(project_id: str, job_id: str, clip_id: str):
    """SSE: rigenera il frame storyboard di una singola clip dal checkpoint salvato."""
    from fastapi.responses import StreamingResponse as _SSE
    import json as _json
    from src.core.workflow.reel_pipeline import ReelPipeline, ReelRequest
    from src.core.workflow.trailer_pipeline import TrailerClip

    cfg = get_config()
    state_path: Optional[Path] = None
    for pid in _reel_state_search_ids(project_id, job_id):
        p = cfg.app.data_path / "projects" / pid / f"reel_state_{job_id}.json"
        if p.exists():
            state_path = p
            break

    if not state_path:
        raise HTTPException(status_code=404, detail="Checkpoint non trovato")

    raw = _json.loads(state_path.read_text(encoding="utf-8"))
    clip_data = next((c for c in raw.get("clips_list", []) if c.get("clip_id") == clip_id), None)
    if not clip_data:
        raise HTTPException(status_code=404, detail=f"Clip {clip_id} non trovata")

    req_data = raw.get("request", {})
    req_data.setdefault("description", "")
    req_data.setdefault("project_id", project_id)

    async def _stream():
        try:
            reel_req = ReelRequest(**req_data)
        except Exception as exc:
            yield f"data: {_json.dumps({'error': str(exc)})}\n\n"
            return

        pipeline = ReelPipeline(reel_req)
        # Use the actual folder the state file lives in as storage project ID
        storage_id = state_path.parent.name
        pipeline.job_id = job_id
        pipeline._storage_project_id = storage_id

        pipeline._storyboard_dir = cfg.app.data_path / "projects" / storage_id / "storyboard"
        pipeline._storyboard_dir.mkdir(parents=True, exist_ok=True)

        clip = TrailerClip(**clip_data)
        dest = pipeline._storyboard_dir / f"{clip.clip_id}_sb.png"

        q: asyncio.Queue = asyncio.Queue()

        async def emit(ev: dict):
            await q.put(ev)

        async def run():
            try:
                await pipeline._gen_storyboard_frame(clip, dest, emit=emit)
                # Build storyboard path event
                sb_path = pipeline._resolve_storyboard_file(clip, dest) or dest
                clip.storyboard_path = str(sb_path)
                ev = pipeline._storyboard_frame_event(clip, sb_path, ok=True)
                await q.put(ev)
            except Exception as exc:
                await q.put({"error": str(exc), "clip_id": clip_id})
            finally:
                await q.put(None)

        task = asyncio.create_task(run())
        while True:
            ev = await q.get()
            if ev is None:
                break
            yield f"data: {_json.dumps(ev)}\n\n"

        yield f"data: {_json.dumps({'done': True, 'clip_id': clip_id})}\n\n"

    return _SSE(_stream(), media_type="text/event-stream")


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
