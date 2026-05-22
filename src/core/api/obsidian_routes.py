"""
API Obsidian — vault SSOT, sync, retrieval per agent LLM, Docker service.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from src.core.config import get_config

router = APIRouter()


class SyncProjectRequest(BaseModel):
    project_id: str
    job_id: Optional[str] = None
    pipeline_kind: str = "trailer"  # trailer | reel | cinematic


class SearchRequest(BaseModel):
    query: str
    project_id: Optional[str] = None
    limit: int = Field(default=20, ge=1, le=50)


class SyncDirectorRequest(BaseModel):
    project_id: str
    project: dict[str, Any]


@router.get("/status")
async def obsidian_status():
    from src.core.obsidian.docker_service import container_status
    from src.core.obsidian.vault_manager import get_vault_manager

    cfg = get_config().obsidian
    mgr = get_vault_manager()
    docker = container_status()
    return {
        "enabled": cfg.enabled,
        "auto_sync": cfg.auto_sync_on_checkpoint,
        "vault_path": str(mgr.vault_path),
        "projects": mgr.list_projects(),
        "docker": docker,
    }


@router.post("/docker/start")
async def obsidian_docker_start():
    from src.core.obsidian.docker_service import start_container
    return start_container()


@router.post("/docker/stop")
async def obsidian_docker_stop():
    from src.core.obsidian.docker_service import stop_container
    return stop_container()


@router.get("/docker/status")
async def obsidian_docker_status():
    from src.core.obsidian.docker_service import container_status
    return container_status()


@router.post("/sync/project")
async def sync_project(req: SyncProjectRequest):
    """Forza sync da checkpoint su disco → vault."""
    from src.core.obsidian.vault_manager import get_vault_manager

    cfg = get_config()
    data_path = cfg.app.data_path / "projects" / req.project_id
    mgr = get_vault_manager()

    if req.pipeline_kind == "cinematic":
        state = data_path / "pipeline_state.json"
        if not state.exists():
            raise HTTPException(404, f"No pipeline_state.json for {req.project_id}")
        pipeline_state = json.loads(state.read_text(encoding="utf-8"))
        result = mgr.sync_cinematic_pipeline(
            project_id=req.project_id,
            pipeline_state=pipeline_state,
        )
        return {"ok": True, **result}

    if not req.job_id:
        raise HTTPException(400, "job_id required for trailer/reel sync")

    prefix = "reel_state_" if req.pipeline_kind == "reel" else "trailer_state_"
    cp = data_path / f"{prefix}{req.job_id}.json"
    if not cp.exists():
        raise HTTPException(404, f"Checkpoint not found: {cp}")

    checkpoint = json.loads(cp.read_text(encoding="utf-8"))
    extra: dict[str, Any] = {}
    if req.pipeline_kind == "reel":
        jobs_file = data_path / "reel_jobs.json"
        if jobs_file.exists():
            jobs = json.loads(jobs_file.read_text(encoding="utf-8"))
            for j in jobs if isinstance(jobs, list) else jobs.get("jobs", []):
                if j.get("job_id") == req.job_id:
                    extra["config"] = j.get("config") or {}
                    break

    result = mgr.sync_trailer_or_reel_checkpoint(
        project_id=req.project_id,
        job_id=req.job_id,
        pipeline_kind=req.pipeline_kind,
        checkpoint=checkpoint,
        extra=extra,
    )
    return {"ok": True, **result}


@router.post("/sync/director")
async def sync_director(req: SyncDirectorRequest):
    """Sync progetto Director Cinema (UI locale) → vault Obsidian."""
    from src.core.obsidian.vault_manager import get_vault_manager

    cfg = get_config()
    if not cfg.obsidian.enabled:
        return {"ok": False, "reason": "obsidian_disabled"}
    mgr = get_vault_manager()
    result = mgr.sync_director_cinema(
        project_id=req.project_id,
        project=req.project,
    )
    return {"ok": True, **result}


@router.post("/search")
async def obsidian_search(req: SearchRequest):
    from src.core.obsidian.vault_manager import get_vault_manager

    mgr = get_vault_manager()
    return {"hits": mgr.search(req.query, project_id=req.project_id, limit=req.limit)}


@router.get("/context")
async def obsidian_context(
    project_id: str,
    clip_id: Optional[str] = None,
    shot_id: Optional[str] = None,
    max_chars: int = 12000,
):
    """Bundle markdown per agent LLM (retrieval coerenza / stili)."""
    from src.core.obsidian.vault_manager import get_vault_manager

    mgr = get_vault_manager()
    bundle = mgr.get_context_bundle(
        project_id=project_id,
        clip_id=clip_id,
        shot_id=shot_id,
        max_chars=max_chars,
    )
    return {"project_id": project_id, "chars": len(bundle), "context": bundle}


@router.get("/projects")
async def obsidian_projects():
    from src.core.obsidian.vault_manager import get_vault_manager
    mgr = get_vault_manager()
    return {"projects": mgr.list_projects(), "vault_path": str(mgr.vault_path)}
