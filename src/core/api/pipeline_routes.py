"""
API routes Pipeline — usa SSE (Server-Sent Events) per streaming del progresso.
"""

import asyncio
import json
from typing import AsyncGenerator, List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.responses import FileResponse as FastAPIFileResponse
from pydantic import BaseModel

from src.core.models.cinematic import (
    AudioAnalysis, CharacterDef, ProjectInput,
)
from src.core.workflow.pipeline import CinematicPipeline, PipelineProgress

router = APIRouter()


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
    mode: str = "full_auto"
    phase: str = "all"


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
            )

            pipeline = CinematicPipeline(req.project_id)
            queue: asyncio.Queue = asyncio.Queue()

            def on_progress(p: PipelineProgress):
                queue.put_nowait(p)

            async def run():
                try:
                    final = await pipeline.run(inp, on_progress, phase=req.phase)
                    queue.put_nowait({"done": True, "output_path": final})
                except Exception as e:
                    queue.put_nowait({"error": str(e)})

            task = asyncio.create_task(run())

            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=25.0)
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"   # commento SSE — mantiene viva la connessione TCP
                    continue

                if isinstance(item, dict):
                    yield "data: " + json.dumps(item) + "\n\n"
                    if "done" in item or "error" in item:
                        break
                elif isinstance(item, PipelineProgress):
                    yield "data: " + json.dumps(item.to_dict()) + "\n\n"

            await task

        except GeneratorExit:
            pass   # client disconnesso — normale
        except Exception as e:
            yield "data: " + json.dumps({"error": str(e)}) + "\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",   # disabilita buffering nginx/proxy
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
    return json.loads(state_path.read_text())


@router.delete("/{project_id}/state")
async def reset_pipeline_state(project_id: str):
    """Reset dello stato pipeline per ri-eseguire dall'inizio."""
    from pathlib import Path
    from src.core.config import get_config
    state_path = get_config().app.data_path / "projects" / project_id / "pipeline_state.json"
    if state_path.exists():
        state_path.unlink()
    return {"reset": True, "project_id": project_id}


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


# ── Static file serving ──────────────────────────────────────────────────────

@router.get("/{project_id}/frames/{filename:path}")
async def serve_frame_file(project_id: str, filename: str):
    """Serve pipeline frame image files."""
    from src.core.config import get_config
    path = get_config().app.data_path / "projects" / project_id / "frames" / filename
    if not path.exists():
        raise HTTPException(404, "Frame non trovato")
    return FastAPIFileResponse(str(path))


@router.get("/{project_id}/clips/{filename:path}")
async def serve_clip_file(project_id: str, filename: str):
    """Serve pipeline video clip files."""
    from src.core.config import get_config
    path = get_config().app.data_path / "projects" / project_id / "clips" / filename
    if not path.exists():
        raise HTTPException(404, "Clip non trovata")
    return FastAPIFileResponse(str(path))
