"""API routes per monitoraggio code pipeline e audit log."""
import asyncio
from fastapi import APIRouter, HTTPException
from pathlib import Path
import json
from src.core import pipeline_registry
from src.core.config import get_config

router = APIRouter()


# ── Active / unified ──────────────────────────────────────────────────────────

@router.get("/active")
async def get_active_pipelines():
    """Lista pipeline cinematic attivamente in esecuzione (legacy)."""
    return {"active": pipeline_registry.get_active()}


@router.get("/all")
async def get_all_active():
    """Tutti i run attivi: cinematic + reel + trailer."""
    return {"runs": pipeline_registry.get_all_active()}


@router.post("/cancel/{job_id}")
async def cancel_job(job_id: str, force: bool = False):
    """Annulla un job reel/trailer in corso."""
    cancelled = pipeline_registry.cancel_job(job_id)
    if not cancelled and not force:
        raise HTTPException(status_code=404, detail="Job not found or already finished")
    if force:
        from src.core.workflow.reel_jobs import interrupt_job_everywhere

        stop_info = pipeline_registry.force_stop_job(job_id)
        interrupt_job_everywhere(job_id, error="Pipeline interrotta dall'utente")
        return {"ok": True, "job_id": job_id, "status": "interrupted", **stop_info}
    return {"ok": True, "job_id": job_id, "status": "cancelling"}


# ── ComfyUI queue ─────────────────────────────────────────────────────────────

def _extract_queue_item_meta(wf: dict) -> dict:
    """Estrae prefix, clip_id, project_id da un workflow ComfyUI in coda."""
    prefixes = []
    for node in wf.values():
        if not isinstance(node, dict):
            continue
        inp = node.get("inputs", {})
        for field in ("filename_prefix", "audio"):
            val = inp.get(field, "")
            if isinstance(val, str) and val:
                prefixes.append(val)
    # Prendi il primo prefix significativo
    prefix = next((p for p in prefixes if p and "/" not in p), prefixes[0] if prefixes else "")
    # Ricostruisci clip_id dal prefix (es. "clip_003_slot_003_8ae74b_first" → "clip_003_slot_003_8ae74b")
    clip_id = ""
    project_id = ""
    if prefix:
        import re
        m = re.match(r"(clip_\d+_slot_\d+(?:_[0-9a-f]+)?)", prefix)
        if m:
            clip_id = m.group(1)
        # Cerca il progetto nei job attivi o su disco
        try:
            active = pipeline_registry.get_all_active()
            for run in active:
                jid = run.get("job_id", "")
                if jid and clip_id:
                    storage = run.get("storage_project_id") or run.get("project_id", "")
                    frames_dir = Path.home() / ".cinematic-studio" / "projects" / storage / "frames"
                    if frames_dir.exists():
                        for f in frames_dir.iterdir():
                            if clip_id in f.name:
                                project_id = storage
                                break
        except Exception:
            pass
        # Fallback: cerca nei file system
        if not project_id and clip_id:
            projects_root = Path.home() / ".cinematic-studio" / "projects"
            for proj_dir in projects_root.iterdir():
                if not proj_dir.is_dir():
                    continue
                for sub in ("frames", "storyboard"):
                    target = proj_dir / sub
                    if target.exists() and any(clip_id in f.name for f in target.iterdir()):
                        project_id = proj_dir.name
                        break
                if project_id:
                    break
    kind = "storyboard" if "_sb" in prefix else ("frame" if "_first" in prefix or "_last" in prefix else "video" if ".mp4" in prefix else "unknown")
    return {"prefix": prefix, "clip_id": clip_id, "project_id": project_id, "kind": kind}


def _simplify_queue_items(raw_items: list) -> list:
    """Converte lista raw ComfyUI queue in formato semplice con attribuzione progetto."""
    out = []
    for item in raw_items:
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            continue
        prompt_id = item[1] if len(item) > 1 else ""
        wf = item[2] if len(item) > 2 else {}
        meta = _extract_queue_item_meta(wf) if isinstance(wf, dict) else {}
        out.append({
            "prompt_id": str(prompt_id)[:16],
            "clip_id": meta.get("clip_id", ""),
            "project_id": meta.get("project_id", ""),
            "kind": meta.get("kind", "unknown"),
            "prefix": meta.get("prefix", ""),
        })
    return out


@router.get("/comfyui")
async def get_comfyui_queue():
    """
    Interroga tutti i nodi ComfyUI configurati e restituisce lo stato della coda
    con attribuzione a progetto e clip.
    """
    import httpx

    cfg = get_config()
    raw_nodes = getattr(cfg.comfyui, "nodes", [])
    nodes_info = [
        {
            "index": i,
            "name": getattr(n, "name", f"Node {i}"),
            "host": getattr(n, "host", "localhost"),
            "port": getattr(n, "port", 8188),
            "primary": getattr(n, "primary", i == 0),
        }
        for i, n in enumerate(raw_nodes)
    ]

    results = []
    async with httpx.AsyncClient(timeout=5.0) as client:
        for node in nodes_info:
            base_url = f"http://{node['host']}:{node['port']}"
            entry = {
                "index": node["index"],
                "name": node["name"],
                "host": node["host"],
                "port": node["port"],
                "primary": node["primary"],
                "online": False,
                "queue_running": [],
                "queue_pending": [],
                "total_running": 0,
                "total_pending": 0,
                "error": None,
            }
            try:
                r = await client.get(f"{base_url}/queue")
                r.raise_for_status()
                data = r.json()
                entry["online"] = True
                running_raw = data.get("queue_running", [])
                pending_raw = data.get("queue_pending", [])
                entry["queue_running"] = _simplify_queue_items(running_raw)
                entry["queue_pending"] = _simplify_queue_items(pending_raw)
                entry["total_running"] = len(running_raw)
                entry["total_pending"] = len(pending_raw)
            except Exception as exc:
                entry["error"] = str(exc)
            results.append(entry)

    total_running = sum(e["total_running"] for e in results)
    total_pending = sum(e["total_pending"] for e in results)
    return {"nodes": results, "total_running": total_running, "total_pending": total_pending}


@router.post("/comfyui/interrupt")
async def interrupt_comfyui(node_index: int = 0):
    """Invia POST /interrupt al nodo ComfyUI specificato."""
    import httpx
    from src.core.config import get_config

    cfg = get_config()
    raw_nodes = getattr(cfg.comfyui, "nodes", [])
    if node_index >= len(raw_nodes):
        raise HTTPException(status_code=404, detail=f"Node {node_index} not found")

    node = raw_nodes[node_index]
    base_url = f"http://{node.host}:{node.port}"
    async with httpx.AsyncClient(timeout=5.0) as client:
        try:
            r = await client.post(f"{base_url}/interrupt")
            return {"ok": True, "status_code": r.status_code}
        except Exception as exc:
            raise HTTPException(status_code=502, detail=str(exc))


@router.delete("/comfyui/queue")
async def clear_comfyui_queue(node_index: int = 0):
    """Cancella tutta la coda pending di un nodo ComfyUI."""
    import httpx
    from src.core.config import get_config

    cfg = get_config()
    raw_nodes = getattr(cfg.comfyui, "nodes", [])
    if node_index >= len(raw_nodes):
        raise HTTPException(status_code=404, detail=f"Node {node_index} not found")

    node = raw_nodes[node_index]
    base_url = f"http://{node.host}:{node.port}"
    async with httpx.AsyncClient(timeout=5.0) as client:
        try:
            r = await client.post(
                f"{base_url}/queue",
                json={"clear": True},
                headers={"Content-Type": "application/json"},
            )
            return {"ok": True, "status_code": r.status_code}
        except Exception as exc:
            raise HTTPException(status_code=502, detail=str(exc))


# ── Generation stats & estimates ─────────────────────────────────────────────

@router.get("/gen-stats")
async def get_gen_stats():
    """
    Rolling averages per kind (image/video) x workflow.
    Also queries primary ComfyUI node queue depth for ETA estimates.
    """
    import httpx
    from src.core.comfyui.gen_stats import get_averages

    averages = get_averages()

    # Try to get live queue depth from primary node
    cfg = get_config()
    raw_nodes = getattr(cfg.comfyui, "nodes", [])
    queue_depth = 0
    if raw_nodes:
        primary = next((n for n in raw_nodes if getattr(n, "primary", False)), raw_nodes[0])
        base_url = f"http://{primary.host}:{primary.port}"
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                r = await client.get(f"{base_url}/queue")
                data = r.json()
                queue_depth = len(data.get("queue_running", [])) + len(data.get("queue_pending", []))
        except Exception:
            pass

    return {
        "averages": averages,
        "queue_depth": queue_depth,
    }


# ── Audit log ─────────────────────────────────────────────────────────────────

@router.get("/audit")
async def get_audit_log(limit: int = 100):
    """Storico esecuzioni pipeline (da file JSONL)."""
    return {"entries": pipeline_registry.get_audit_log(limit=limit)}


@router.delete("/audit")
async def clear_audit_log():
    """Cancella il file audit log."""
    pipeline_registry.clear_audit_log()
    return {"ok": True}


# ── Cinematic pipeline projects (legacy) ─────────────────────────────────────

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
    """Cancella lo stato pipeline di un progetto."""
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
