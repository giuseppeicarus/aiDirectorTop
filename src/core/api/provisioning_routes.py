"""
Provisioning Routes — SSH e locale per nodi ComfyUI.
I modelli provengono dinamicamente dalla scansione dei workflow installati.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import Optional

import httpx
import structlog
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from src.core.utils.ssh_provisioner import provisioner

log = structlog.get_logger("api.provisioning")

router = APIRouter(prefix="/provisioning", tags=["provisioning"])

_CATALOG_PATH  = Path(__file__).parents[3] / "config" / "model_url_catalog.json"
_WORKFLOW_DIR  = Path(__file__).parents[3] / "config" / "workflows"

# ── Helpers ───────────────────────────────────────────────────────────────────

def _load_catalog() -> dict[str, dict]:
    """Carica il catalog URL modelli (filename → {name, url, size_gb, category})."""
    if not _CATALOG_PATH.exists():
        return {}
    try:
        raw = json.loads(_CATALOG_PATH.read_text(encoding="utf-8"))
        return {k: v for k, v in raw.items() if not k.startswith("_")}
    except Exception as exc:
        log.error("catalog_read_error", error=str(exc))
        return {}


def _build_manifest() -> list[dict]:
    """
    Scansiona i workflow installati e costruisce la lista modelli
    arricchita con URL dal catalog.
    Ritorna lista di dict pronti per il frontend.
    """
    from src.core.utils.workflow_model_scanner import scan_workflow_models

    catalog = _load_catalog()
    refs = scan_workflow_models(_WORKFLOW_DIR)

    result = []
    for ref in refs:
        fname = ref["filename"]
        cat_entry = catalog.get(fname, {})
        result.append({
            "id":          fname,           # id univoco = filename
            "filename":    fname,
            "name":        cat_entry.get("name") or fname,
            "category":    cat_entry.get("category") or _infer_category(ref["target_dir"]),
            "target_dir":  ref["target_dir"],
            "url":         cat_entry.get("url"),       # None se non nel catalog
            "size_gb":     cat_entry.get("size_gb"),
            "workflows":   ref["workflows"],
            "class_type":  ref["class_type"],
            "has_url":     bool(cat_entry.get("url")),
        })
    return result


def _infer_category(target_dir: str) -> str:
    mapping = {
        "video_models": "video", "checkpoints": "checkpoint",
        "loras": "lora", "vae": "vae", "upscale_models": "upscale",
        "text_encoders": "text_encoder", "clip": "clip",
        "controlnet": "controlnet", "unet": "unet", "ipadapter": "ipadapter",
    }
    for key, cat in mapping.items():
        if key in target_dir:
            return cat
    return "other"


# ── Request models ────────────────────────────────────────────────────────────

class SSHCredentials(BaseModel):
    host: str
    port: int = 22
    user: str
    password: Optional[str] = None
    private_key: Optional[str] = None


class ProvisionRequest(BaseModel):
    host: str
    port: int = 22
    user: str
    password: Optional[str] = None
    private_key: Optional[str] = None
    comfyui_path: str
    model_ids: list[str] = []


class SaveSSHConfigRequest(BaseModel):
    global_idx: int
    ssh_port: int = 22
    ssh_user: str = "root"
    ssh_password: Optional[str] = None
    ssh_private_key: Optional[str] = None
    ssh_comfyui_path: Optional[str] = None
    provisioning_enabled: bool = True


class LocalProvisionRequest(BaseModel):
    comfyui_path: str
    model_ids: list[str] = []


class UpdateUrlRequest(BaseModel):
    filename: str
    url: Optional[str] = None
    name: Optional[str] = None
    size_gb: Optional[float] = None
    category: Optional[str] = None


# ── Endpoints ─────────────────────────────────────────────────────────────────

class HFTokenRequest(BaseModel):
    hf_token: Optional[str] = None


@router.get("/hf-token")
async def get_hf_token():
    """Ritorna il token HuggingFace (mascherato) e se è configurato."""
    from src.core.config import get_config
    token = get_config().app.hf_token or ""
    return {
        "configured": bool(token),
        "token_preview": f"hf_...{token[-4:]}" if len(token) > 6 else ("***" if token else ""),
    }


@router.put("/hf-token")
async def save_hf_token(body: HFTokenRequest):
    """Salva il token HuggingFace in config.yaml."""
    import yaml
    _USER_CONFIG = Path("~/.cinematic-studio/config.yaml").expanduser()

    def _read():
        if _USER_CONFIG.exists():
            return yaml.safe_load(_USER_CONFIG.read_text(encoding="utf-8")) or {}
        return {}

    try:
        cfg = _read()
        cfg.setdefault("app", {})["hf_token"] = (body.hf_token or "").strip() or None
        _USER_CONFIG.parent.mkdir(parents=True, exist_ok=True)
        _USER_CONFIG.write_text(
            yaml.dump(cfg, allow_unicode=True, default_flow_style=False, sort_keys=False),
            encoding="utf-8",
        )
        from src.core.config import reload_config
        reload_config()
        return {"ok": True}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


@router.post("/test-ssh")
async def test_ssh(body: SSHCredentials):
    return await provisioner.test_connection(
        host=body.host, port=body.port, user=body.user,
        password=body.password, private_key=body.private_key,
    )


@router.post("/find-comfyui")
async def find_comfyui_remote(body: SSHCredentials):
    return await provisioner.find_comfyui(
        host=body.host, port=body.port, user=body.user,
        password=body.password, private_key=body.private_key,
    )


@router.post("/save-ssh-config")
async def save_ssh_config(body: SaveSSHConfigRequest):
    """
    Salva i campi SSH di un nodo (usato dall'auto-save del ProvisioningScreen).
    Aggiorna solo i campi SSH senza toccare host/port/name/token.
    """
    from src.core.api.comfyui_routes import _current_nodes_raw, _save_nodes

    nodes = _current_nodes_raw()
    idx = body.global_idx
    if idx < 0 or idx >= len(nodes):
        return {"ok": False, "error": f"Nodo {idx} non trovato"}

    node = dict(nodes[idx])
    node["provisioning_enabled"] = body.provisioning_enabled
    node["ssh_port"]         = body.ssh_port
    node["ssh_user"]         = body.ssh_user
    node["ssh_password"]     = body.ssh_password or None
    node["ssh_private_key"]  = body.ssh_private_key or None
    node["ssh_comfyui_path"] = body.ssh_comfyui_path or None
    nodes[idx] = node
    try:
        _save_nodes(nodes)
        return {"ok": True}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


@router.get("/find-local-comfyui")
async def find_local_comfyui():
    """Cerca l'installazione ComfyUI locale."""
    from src.core.utils.local_provisioner import find_local_comfyui as _find
    path = await asyncio.to_thread(_find)
    return {"found": path is not None, "path": path}


@router.get("/nodes")
async def get_provisioning_nodes():
    """Tutti i nodi ComfyUI non-locali con config SSH."""
    from src.core.config import get_config
    LOCAL = {"localhost", "127.0.0.1", "::1", "0.0.0.0"}
    out = []
    for idx, n in enumerate(get_config().comfyui.nodes):
        if n.host.lower() in LOCAL:
            continue
        out.append({
            "global_idx":           idx,
            "name":                 n.name,
            "host":                 n.host,
            "port":                 n.port,
            "provisioning_enabled": n.provisioning_enabled,
            "ssh_port":             n.ssh_port,
            "ssh_user":             n.ssh_user,
            "ssh_password":         n.ssh_password,
            "ssh_private_key":      n.ssh_private_key,
            "ssh_comfyui_path":     n.ssh_comfyui_path,
        })
    return out


@router.get("/models")
async def get_models():
    """
    Lista modelli dinamica: scansione workflow + URL dal catalog.
    Include categorie aggregate e flag has_url.
    """
    models = _build_manifest()
    cats: dict[str, dict] = {}
    for m in models:
        c = m["category"]
        if c not in cats:
            _COLOR = {
                "video": "gold", "checkpoint": "blue", "lora": "text2",
                "vae": "green", "upscale": "text2", "text_encoder": "amber",
                "clip": "amber", "controlnet": "blue", "unet": "blue",
            }
            cats[c] = {"label": c.replace("_", " ").title(), "color": _COLOR.get(c, "text2")}
    return {
        "version": "dynamic",
        "source":  "workflows",
        "categories": cats,
        "models": models,
    }


@router.put("/models/url")
async def update_model_url(body: UpdateUrlRequest):
    """Aggiorna URL (e metadati) di un modello nel catalog."""
    catalog = _load_catalog()
    entry = catalog.get(body.filename, {})
    if body.url is not None:
        entry["url"] = body.url or None
    if body.name is not None:
        entry["name"] = body.name
    if body.size_gb is not None:
        entry["size_gb"] = body.size_gb
    if body.category is not None:
        entry["category"] = body.category
    catalog[body.filename] = entry
    try:
        _CATALOG_PATH.write_text(
            json.dumps(catalog, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "entry": entry}


@router.post("/start")
async def start_ssh_provisioning(body: ProvisionRequest):
    """Provisioning SSH su nodo remoto — SSE stream."""
    all_models = _build_manifest()
    selected = (
        [m for m in all_models if m["id"] in body.model_ids]
        if body.model_ids else all_models
    )
    # Rimuove modelli senza URL
    selected = [m for m in selected if m.get("url")]

    if not selected:
        async def _empty():
            yield f"data: {json.dumps({'type':'error','text':'Nessun modello con URL selezionato','pct':0,'tag':'ERROR'})}\n\n"
        return StreamingResponse(_empty(), media_type="text/event-stream")

    async def _stream():
        try:
            async for ev in provisioner.run_provision(
                host=body.host, port=body.port, user=body.user,
                comfyui_path=body.comfyui_path, models=selected,
                password=body.password, private_key=body.private_key,
            ):
                yield f"data: {json.dumps(ev)}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'type':'error','text':str(exc),'pct':0,'tag':'ERROR'})}\n\n"

    return StreamingResponse(_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/start-local")
async def start_local_provisioning(body: LocalProvisionRequest):
    """Provisioning locale — scarica modelli direttamente nella cartella ComfyUI. SSE stream."""
    from src.core.utils.local_provisioner import run_local_provision

    all_models = _build_manifest()
    selected = (
        [m for m in all_models if m["id"] in body.model_ids]
        if body.model_ids else all_models
    )

    if not selected:
        async def _empty():
            yield f"data: {json.dumps({'type':'error','text':'Nessun modello selezionato','pct':0,'tag':'ERROR'})}\n\n"
        return StreamingResponse(_empty(), media_type="text/event-stream")

    async def _stream():
        try:
            async for ev in run_local_provision(body.comfyui_path, selected):
                yield f"data: {json.dumps(ev)}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'type':'error','text':str(exc),'pct':0,'tag':'ERROR'})}\n\n"

    return StreamingResponse(_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/health-stream/{node_idx}")
async def health_stream(node_idx: int, request: Request):
    """SSE live health check per un nodo ComfyUI ogni 3s."""
    from src.core.config import get_config
    nodes = get_config().comfyui.nodes
    if node_idx < 0 or node_idx >= len(nodes):
        async def _err():
            yield f"data: {json.dumps({'error': 'Node not found'})}\n\n"
        return StreamingResponse(_err(), media_type="text/event-stream")

    node_cfg = nodes[node_idx]
    base_url = node_cfg.base_url
    auth_headers: dict[str, str] = {}
    if node_cfg.auth_type == "token" and node_cfg.token:
        auth_headers["Authorization"] = f"Bearer {node_cfg.token}"

    async def _stream():
        async with httpx.AsyncClient(timeout=5.0, follow_redirects=True) as client:
            while True:
                if await request.is_disconnected():
                    break
                payload: dict = {
                    "online": False, "vram_total": None, "vram_free": None,
                    "vram_used_pct": None, "queue_running": 0, "queue_pending": 0,
                    "gpu_name": None, "timestamp": time.time(),
                    "node_name": node_cfg.name, "node_idx": node_idx,
                }
                try:
                    r = await client.get(f"{base_url}/system_stats", headers=auth_headers)
                    if r.status_code == 200:
                        devs = r.json().get("devices", [])
                        if devs:
                            d = devs[0]
                            vt, vf = d.get("vram_total", 0), d.get("vram_free", 0)
                            payload.update({
                                "online": True, "vram_total": vt, "vram_free": vf,
                                "vram_used_pct": round((vt - vf) / max(vt, 1) * 100, 1),
                                "gpu_name": d.get("name", "GPU"),
                            })
                        else:
                            payload["online"] = True
                except Exception:
                    pass
                if payload["online"]:
                    try:
                        r = await client.get(f"{base_url}/queue", headers=auth_headers)
                        if r.status_code == 200:
                            q = r.json()
                            payload["queue_running"] = len(q.get("queue_running", []))
                            payload["queue_pending"] = len(q.get("queue_pending", []))
                    except Exception:
                        pass
                yield f"data: {json.dumps(payload)}\n\n"
                for _ in range(6):
                    await asyncio.sleep(0.5)
                    if await request.is_disconnected():
                        return

    return StreamingResponse(_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
