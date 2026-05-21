"""
API routes Pipeline — usa SSE (Server-Sent Events) per streaming del progresso.
"""

import asyncio
import json
from typing import AsyncGenerator, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from src.core.utils.http_files import file_response
from pydantic import BaseModel

from src.core.models.cinematic import (
    AudioAnalysis, CharacterDef, ProjectInput,
)
from src.core.workflow.pipeline import CinematicPipeline, PipelineProgress

router = APIRouter()

# Per-project active task and pause event registry
_active_tasks: Dict[str, asyncio.Task] = {}
_pause_events: Dict[str, asyncio.Event] = {}


class PipelineRunRequest(BaseModel):
    """Input semplificato per avviare la pipeline. Costruisce un ProjectInput internamente."""
    project_id: str
    title: str
    story_brief: str
    genre: str = "cinematic"
    style_references: List[str] = []
    mood_references: List[str] = []
    runtime_target_sec: int = 60
    aspect_ratio: str = "16:9"
    lyrics: Optional[str] = None
    characters: List[CharacterDef] = []
    audio_analysis: Optional[AudioAnalysis] = None
    audio_start_sec: float = 0.0
    mode: str = "full_auto"
    phase: str = "all"
    workflows: Optional[dict] = None   # {"txt2img": "...", "img2video": "...", "img_audio2video": "..."}


@router.post("/run")
async def run_pipeline(req: PipelineRunRequest):
    """
    Avvia la pipeline cinematografica e streamma il progresso via SSE.
    Invia heartbeat ogni 25 s per mantenere viva la connessione durante le chiamate LLM lente.

    phase="all"         — pipeline completa (FullAuto mode)
    phase="storyboard"  — solo stage LLM; si ferma dopo continuity_check
    phase="production"  — salta stage LLM (già checkpointed); parte da frame_gen
    """
    async def event_stream() -> AsyncGenerator[str, None]:
        project_id = req.project_id
        try:
            inp = ProjectInput(
                title=req.title,
                story_brief=req.story_brief,
                genre=req.genre,
                style_references=req.style_references,
                mood_references=req.mood_references,
                runtime_target_sec=req.runtime_target_sec,
                aspect_ratio=req.aspect_ratio,
                lyrics=req.lyrics,
                characters=req.characters,
                audio_analysis=req.audio_analysis,
                audio_start_sec=req.audio_start_sec,
            )

            pipeline = CinematicPipeline(project_id)
            queue: asyncio.Queue = asyncio.Queue()

            pause_event = asyncio.Event()
            pause_event.set()  # starts unpaused
            _pause_events[project_id] = pause_event

            def on_progress(p: PipelineProgress):
                queue.put_nowait(p)

            async def run():
                try:
                    final = await pipeline.run(inp, on_progress, phase=req.phase, pause_event=pause_event, workflows=req.workflows)
                    if final == "storyboard_complete":
                        queue.put_nowait({"done": True, "output_path": None, "storyboard_complete": True})
                    else:
                        queue.put_nowait({"done": True, "output_path": final})
                except asyncio.CancelledError:
                    queue.put_nowait({"stopped": True})
                except Exception as e:
                    queue.put_nowait({"error": str(e)})
                finally:
                    _active_tasks.pop(project_id, None)
                    _pause_events.pop(project_id, None)

            task = asyncio.create_task(run())
            _active_tasks[project_id] = task

            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=25.0)
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
                    continue

                if isinstance(item, dict):
                    yield "data: " + json.dumps(item) + "\n\n"
                    if "done" in item or "error" in item or "stopped" in item:
                        break
                elif isinstance(item, PipelineProgress):
                    yield "data: " + json.dumps(item.to_dict()) + "\n\n"

            await task

        except GeneratorExit:
            pass
        except Exception as e:
            yield "data: " + json.dumps({"error": str(e)}) + "\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/{project_id}/state")
async def get_pipeline_state(project_id: str):
    """Stato corrente della pipeline (per riprendere dopo un crash)."""
    from pathlib import Path
    from src.core.config import get_config
    state_path = get_config().app.data_path / "projects" / project_id / "pipeline_state.json"
    if not state_path.exists():
        return {"project_id": project_id, "completed_stages": [], "shot_states": {}}
    text = state_path.read_text(encoding='utf-8').strip()
    if not text:
        return {"project_id": project_id, "completed_stages": [], "shot_states": {}}
    return json.loads(text)


@router.delete("/{project_id}/state")
async def reset_pipeline_state(project_id: str):
    """Reset dello stato pipeline per ri-eseguire dall'inizio."""
    from pathlib import Path
    from src.core.config import get_config
    state_path = get_config().app.data_path / "projects" / project_id / "pipeline_state.json"
    if state_path.exists():
        state_path.unlink()
    return {"reset": True, "project_id": project_id}


STAGE_ORDER = [
    "story_analysis", "narrative_arc", "shot_list",
    "prompt_generation", "continuity_check",
    "frame_gen", "video_gen", "assembly",
]


@router.delete("/{project_id}/state/from/{stage}")
async def reset_pipeline_from_stage(project_id: str, stage: str):
    """Rimuove `stage` e tutti gli stage successivi da completed_stages, preservando i dati precedenti."""
    if stage not in STAGE_ORDER:
        raise HTTPException(status_code=400, detail=f"Stage sconosciuto: {stage}. Validi: {STAGE_ORDER}")
    from src.core.config import get_config
    state_path = get_config().app.data_path / "projects" / project_id / "pipeline_state.json"
    if not state_path.exists():
        return {"reset": True, "project_id": project_id, "from_stage": stage, "completed_stages": []}
    state = json.loads(state_path.read_text(encoding="utf-8"))
    idx = STAGE_ORDER.index(stage)
    keep = STAGE_ORDER[:idx]
    state["completed_stages"] = [s for s in state.get("completed_stages", []) if s in keep]
    # Remove data for reset stages
    data = state.get("data", {})
    for s in STAGE_ORDER[idx:]:
        data.pop(s, None)
        # Map stage keys to data keys
        key_map = {
            "shot_list": "shot_list",
            "prompt_generation": "shot_list",  # prompt_gen updates shot_list
            "continuity_check": "continuity_report",
            "frame_gen": "shot_states",
            "video_gen": "shot_states",
        }
        if s in key_map and key_map[s] in data:
            # For shot_list/prompt_generation, only clear if stage is shot_list
            if s == "shot_list":
                data.pop("shot_list", None)
            elif s == "continuity_check":
                data.pop("continuity_report", None)
    # Also clear shot_states when resetting frame_gen or later
    if idx >= STAGE_ORDER.index("frame_gen"):
        state["shot_states"] = {}
    state["data"] = data
    state_path.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding='utf-8')
    return {"reset": True, "project_id": project_id, "from_stage": stage, "completed_stages": state["completed_stages"]}


@router.post("/{project_id}/stop")
async def stop_pipeline(project_id: str):
    """Interrompe la pipeline in esecuzione per questo progetto."""
    task = _active_tasks.get(project_id)
    if not task or task.done():
        raise HTTPException(status_code=404, detail="Nessuna pipeline attiva per questo progetto")
    task.cancel()
    return {"stopped": True, "project_id": project_id}


@router.post("/{project_id}/pause")
async def pause_pipeline(project_id: str):
    """Mette in pausa la pipeline (si fermerà al prossimo checkpoint tra stage)."""
    evt = _pause_events.get(project_id)
    if not evt:
        raise HTTPException(status_code=404, detail="Nessuna pipeline attiva per questo progetto")
    evt.clear()
    return {"paused": True, "project_id": project_id}


@router.post("/{project_id}/resume")
async def resume_pipeline(project_id: str):
    """Riprende la pipeline da dove era in pausa."""
    evt = _pause_events.get(project_id)
    if not evt:
        raise HTTPException(status_code=404, detail="Nessuna pipeline attiva per questo progetto")
    evt.set()
    return {"resumed": True, "project_id": project_id}


# ── Copilot mode endpoints ───────────────────────────────────────────────────

@router.post("/{project_id}/copilot/frame/{shot_id}")
async def copilot_frame(project_id: str, shot_id: str):
    """SSE: genera first_frame per uno shot (copilot mode)."""
    async def stream():
        try:
            pipeline = CinematicPipeline(project_id)
            q: asyncio.Queue = asyncio.Queue()

            def on_p(p):
                q.put_nowait(p)

            async def run():
                try:
                    path = await pipeline.copilot_gen_frame(shot_id, on_p)
                    q.put_nowait({"done": True, "frame_path": path})
                except Exception as e:
                    q.put_nowait({"error": str(e)})

            asyncio.create_task(run())

            while True:
                try:
                    item = await asyncio.wait_for(q.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
                    continue
                if isinstance(item, dict):
                    yield "data: " + json.dumps(item) + "\n\n"
                    if "done" in item or "error" in item:
                        break
                elif isinstance(item, PipelineProgress):
                    yield "data: " + json.dumps(item.to_dict()) + "\n\n"
        except Exception as e:
            yield "data: " + json.dumps({"error": str(e)}) + "\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/{project_id}/copilot/clip/{shot_id}")
async def copilot_clip(project_id: str, shot_id: str):
    """SSE: genera video clip per uno shot (copilot mode)."""
    async def stream():
        try:
            pipeline = CinematicPipeline(project_id)
            q: asyncio.Queue = asyncio.Queue()

            def on_p(p):
                q.put_nowait(p)

            async def run():
                try:
                    path = await pipeline.copilot_gen_clip(shot_id, on_p)
                    q.put_nowait({"done": True, "clip_path": path})
                except Exception as e:
                    q.put_nowait({"error": str(e)})

            asyncio.create_task(run())

            while True:
                try:
                    item = await asyncio.wait_for(q.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
                    continue
                if isinstance(item, dict):
                    yield "data: " + json.dumps(item) + "\n\n"
                    if "done" in item or "error" in item:
                        break
                elif isinstance(item, PipelineProgress):
                    yield "data: " + json.dumps(item.to_dict()) + "\n\n"
        except Exception as e:
            yield "data: " + json.dumps({"error": str(e)}) + "\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/{project_id}/copilot/assemble")
async def copilot_assemble(project_id: str):
    """SSE: assembla il video finale da tutte le clip approvate."""
    async def stream():
        try:
            pipeline = CinematicPipeline(project_id)
            q: asyncio.Queue = asyncio.Queue()

            def on_p(p):
                q.put_nowait(p)

            async def run():
                try:
                    path = await pipeline.copilot_assemble(on_p)
                    q.put_nowait({"done": True, "final_path": path})
                except Exception as e:
                    q.put_nowait({"error": str(e)})

            asyncio.create_task(run())

            while True:
                try:
                    item = await asyncio.wait_for(q.get(), timeout=30.0)
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
                    continue
                if isinstance(item, dict):
                    yield "data: " + json.dumps(item) + "\n\n"
                    if "done" in item or "error" in item:
                        break
                elif isinstance(item, PipelineProgress):
                    yield "data: " + json.dumps(item.to_dict()) + "\n\n"
        except Exception as e:
            yield "data: " + json.dumps({"error": str(e)}) + "\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Thumbnail generation endpoint ────────────────────────────────────────────

class ThumbnailRequest(BaseModel):
    width: int = 512
    height: int = 288


@router.post("/{project_id}/thumbnails")
async def generate_thumbnails(project_id: str, req: ThumbnailRequest):
    """SSE: genera anteprime first-frame a bassa risoluzione per revisione storyboard."""
    async def stream():
        try:
            pipeline = CinematicPipeline(project_id)
            q: asyncio.Queue = asyncio.Queue()

            def on_p(p):
                q.put_nowait(p)

            async def run():
                try:
                    results = await pipeline.generate_thumbnails(req.width, req.height, on_p)
                    q.put_nowait({"done": True, "thumbnails": results})
                except Exception as e:
                    q.put_nowait({"error": str(e)})

            asyncio.create_task(run())

            while True:
                try:
                    item = await asyncio.wait_for(q.get(), timeout=25.0)
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
                    continue
                if isinstance(item, dict):
                    yield "data: " + json.dumps(item) + "\n\n"
                    if "done" in item or "error" in item:
                        break
                elif isinstance(item, PipelineProgress):
                    yield "data: " + json.dumps(item.to_dict()) + "\n\n"
        except Exception as e:
            yield "data: " + json.dumps({"error": str(e)}) + "\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Static file serving ──────────────────────────────────────────────────────

@router.get("/{project_id}/frames/{filename:path}")
async def serve_frame_file(project_id: str, filename: str):
    """Serve pipeline frame image files."""
    from src.core.config import get_config
    path = get_config().app.data_path / "projects" / project_id / "frames" / filename
    if not path.exists():
        raise HTTPException(404, "Frame non trovato")
    return file_response(path, inline=True)


@router.get("/{project_id}/clips/{filename:path}")
async def serve_clip_file(project_id: str, filename: str):
    """Serve pipeline video clip files."""
    from src.core.config import get_config
    path = get_config().app.data_path / "projects" / project_id / "clips" / filename
    if not path.exists():
        raise HTTPException(404, "Clip non trovata")
    return file_response(path, inline=True)
