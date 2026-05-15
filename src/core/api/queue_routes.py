"""API routes per monitoraggio code pipeline e audit log."""
from fastapi import APIRouter, HTTPException
from pathlib import Path
import json
from src.core import pipeline_registry
from src.core.config import get_config

router = APIRouter()


@router.get("/active")
async def get_active_pipelines():
    """Lista pipeline attivamente in esecuzione (in-memory)."""
    return {"active": pipeline_registry.get_active()}


@router.get("/audit")
async def get_audit_log(limit: int = 100):
    """Storico esecuzioni pipeline (da file JSONL)."""
    return {"entries": pipeline_registry.get_audit_log(limit=limit)}


@router.delete("/audit")
async def clear_audit_log():
    """Cancella il file audit log."""
    pipeline_registry.clear_audit_log()
    return {"ok": True}


@router.get("/projects")
async def list_pipeline_projects():
    """Lista tutti i progetti che hanno uno stato pipeline salvato."""
    cfg = get_config()
    projects_dir = cfg.app.data_path / "projects"
    result = []
    if not projects_dir.exists():
        return {"projects": []}

    for p in projects_dir.iterdir():
        if not p.is_dir():
            continue
        state_path = p / "pipeline_state.json"
        if not state_path.exists():
            continue
        try:
            state = json.loads(state_path.read_text())
            completed = state.get("completed_stages", [])
            all_stages = [
                "story_analysis", "narrative_arc", "shot_list",
                "prompt_generation", "continuity_check",
                "frame_gen", "video_gen", "assembly",
            ]
            status = "completed" if len(completed) == len(all_stages) else "incomplete"
            result.append({
                "project_id": p.name,
                "completed_stages": completed,
                "total_stages": len(all_stages),
                "status": status,
                "has_state": True,
            })
        except Exception:
            pass

    return {"projects": result}


@router.delete("/projects/{project_id}/state")
async def reset_project_pipeline(project_id: str):
    """Cancella lo stato pipeline di un progetto (permette ri-esecuzione dall'inizio)."""
    cfg = get_config()
    state_path = cfg.app.data_path / "projects" / project_id / "pipeline_state.json"
    if state_path.exists():
        state_path.unlink()
        return {"ok": True, "project_id": project_id, "message": "Stato pipeline cancellato"}
    return {"ok": False, "project_id": project_id, "message": "Nessuno stato da cancellare"}


@router.delete("/projects/{project_id}/frames")
async def clear_project_frames(project_id: str):
    """Cancella tutti i frame generati per un progetto."""
    cfg = get_config()
    frames_dir = cfg.app.data_path / "projects" / project_id / "frames"
    count = 0
    if frames_dir.exists():
        for f in frames_dir.iterdir():
            if f.is_file():
                f.unlink()
                count += 1
    return {"ok": True, "deleted": count}
