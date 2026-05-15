"""API routes ComfyUI — status nodi, modelli, workflow, configurazione CRUD."""

import time
from pathlib import Path
from typing import List, Optional

import yaml
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from src.core.comfyui.client import ComfyUIClient
from src.core.comfyui.pool import ComfyUINodePool
from src.core.config import ComfyUINodeConfig, get_config, reload_config

router = APIRouter()


# ── Config CRUD helpers ───────────────────────────────────────────────────────

_USER_CONFIG = Path("~/.cinematic-studio/config.yaml").expanduser()


def _read_user_config() -> dict:
    if _USER_CONFIG.exists():
        return yaml.safe_load(_USER_CONFIG.read_text(encoding="utf-8")) or {}
    return {}


def _write_user_config(data: dict) -> None:
    _USER_CONFIG.parent.mkdir(parents=True, exist_ok=True)
    _USER_CONFIG.write_text(
        yaml.dump(data, allow_unicode=True, default_flow_style=False, sort_keys=False),
        encoding="utf-8",
    )


def _save_nodes(nodes: list) -> None:
    """Salva la lista di nodi nel config utente e ricarica la cache."""
    cfg = _read_user_config()
    cfg.setdefault("comfyui", {})["nodes"] = nodes
    _write_user_config(cfg)
    reload_config()


def _current_nodes_raw() -> list[dict]:
    """Restituisce la lista nodi come dict serializzabili."""
    return [
        {
            "name":    n.name,
            "host":    n.host,
            "port":    n.port,
            "enabled": n.enabled,
            "auth":    n.auth,
        }
        for n in get_config().comfyui.nodes
    ]


class NodeConfigIn(BaseModel):
    name: str = "GPU Node"
    host: str = "localhost"
    port: int = 8188
    enabled: bool = True
    auth: Optional[str] = None


# ── Node config CRUD ──────────────────────────────────────────────────────────

@router.get("/nodes/config")
async def list_node_configs():
    """Restituisce la lista di nodi configurati (host, port, name, enabled)."""
    return {"nodes": _current_nodes_raw()}


@router.post("/nodes/config", status_code=201)
async def add_node(body: NodeConfigIn):
    """Aggiunge un nuovo nodo ComfyUI alla configurazione."""
    nodes = _current_nodes_raw()
    nodes.append(body.model_dump())
    _save_nodes(nodes)
    return {"nodes": nodes, "added_index": len(nodes) - 1}


@router.put("/nodes/config/{index}")
async def update_node(index: int, body: NodeConfigIn):
    """Aggiorna la configurazione di un nodo esistente."""
    nodes = _current_nodes_raw()
    if index < 0 or index >= len(nodes):
        raise HTTPException(status_code=404, detail=f"Nodo {index} non trovato")
    nodes[index] = body.model_dump()
    _save_nodes(nodes)
    return {"nodes": nodes}


@router.delete("/nodes/config/{index}")
async def delete_node(index: int):
    """Rimuove un nodo dalla configurazione."""
    nodes = _current_nodes_raw()
    if index < 0 or index >= len(nodes):
        raise HTTPException(status_code=404, detail=f"Nodo {index} non trovato")
    removed = nodes.pop(index)
    _save_nodes(nodes)
    return {"removed": removed, "nodes": nodes}


@router.post("/nodes/config/test")
async def test_node_connection(body: NodeConfigIn):
    """
    Verifica la connessione a un nodo (anche se non ancora in config).
    Restituisce online, latency_ms, vram, queue_depth.
    """
    node_cfg = ComfyUINodeConfig(
        host=body.host, port=body.port, name=body.name,
        enabled=True, auth=body.auth,
    )
    return await _probe_node(node_cfg)


# ── Node runtime status ────────────────────────────────────────────────────────

@router.get("/nodes")
async def nodes_status():
    """Status di tutti i nodi ComfyUI configurati."""
    try:
        pool = ComfyUINodePool()
        return await pool.status()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/nodes/{node_index}/models")
async def node_models(node_index: int):
    """Elenco checkpoint e modelli disponibili su un nodo specifico."""
    try:
        pool = ComfyUINodePool()
        if node_index >= len(pool._nodes):
            raise HTTPException(status_code=404, detail="Nodo non trovato")
        entry = pool._nodes[node_index]
        info = await entry.client.get_object_info()
        checkpoints = list(
            info.get("CheckpointLoaderSimple", {})
            .get("input", {})
            .get("required", {})
            .get("ckpt_name", [[]])[0]
        )
        video_models = list(
            info.get("WanVideoModelLoader", {})
            .get("input", {})
            .get("required", {})
            .get("model", [[]])[0]
        )
        return {
            "name": entry.config.name,
            "checkpoints": checkpoints,
            "video_models": video_models,
            "total_node_types": len(info),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/nodes/{node_index}/queue")
async def node_queue(node_index: int):
    """Profondità coda e stato del nodo."""
    try:
        pool = ComfyUINodePool()
        if node_index >= len(pool._nodes):
            raise HTTPException(status_code=404, detail="Nodo non trovato")
        entry = pool._nodes[node_index]
        depth = await entry.client.get_queue_depth()
        alive = await entry.client.is_alive()
        return {
            "name": entry.config.name,
            "online": alive,
            "queue_depth": depth,
            "quarantined": not entry.is_available,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/nodes/{node_index}/health")
async def node_health(node_index: int):
    """Health check dettagliato per un singolo nodo: latency, VRAM, queue."""
    cfg = get_config().comfyui
    if node_index < 0 or node_index >= len(cfg.nodes):
        raise HTTPException(status_code=404, detail=f"Nodo {node_index} non trovato")
    return await _probe_node(cfg.nodes[node_index])


async def _probe_node(node_cfg: ComfyUINodeConfig) -> dict:
    """Esegue un ping + system_stats + queue su un nodo e restituisce le info."""
    client = ComfyUIClient(node_cfg)
    result = {
        "name":          node_cfg.name,
        "host":          node_cfg.host,
        "port":          node_cfg.port,
        "online":        False,
        "latency_ms":    None,
        "queue_depth":   None,
        "vram_total_mb": None,
        "vram_free_mb":  None,
        "gpu_name":      None,
        "error":         None,
    }
    try:
        t0 = time.monotonic()
        stats = await client.health_check()
        result["latency_ms"] = round((time.monotonic() - t0) * 1000)
        result["online"] = True

        devices = stats.get("devices", [])
        if devices:
            dev = devices[0]
            result["gpu_name"]      = dev.get("name")
            result["vram_total_mb"] = dev.get("vram_total")
            result["vram_free_mb"]  = dev.get("vram_free")

        result["queue_depth"] = await client.get_queue_depth()
    except Exception as e:
        result["error"] = str(e)

    return result


@router.get("/workflows")
async def list_workflows():
    """Elenco template workflow disponibili."""
    from pathlib import Path
    wf_dir = Path(__file__).parent.parent.parent.parent / "config" / "workflows"
    templates = []
    for f in sorted(wf_dir.glob("*.json")):
        if not f.name.startswith("_"):
            templates.append({"name": f.stem, "filename": f.name})
    return {"workflows": templates}
