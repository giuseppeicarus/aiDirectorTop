"""
API routes per la gestione dei workflow ComfyUI.
GET/POST/PUT/DELETE /api/workflows/
"""

import json
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from src.core.comfyui.workflow_builder import WORKFLOWS_DIR, reload_manifest

router = APIRouter()


def _manifest_path() -> Path:
    return WORKFLOWS_DIR / "manifest.json"


def _load_manifest() -> dict:
    p = _manifest_path()
    if not p.exists():
        return {"workflows": []}
    return json.loads(p.read_text(encoding="utf-8"))


def _save_manifest(m: dict):
    _manifest_path().write_text(json.dumps(m, indent=2, ensure_ascii=False), encoding="utf-8")
    reload_manifest()   # invalida la cache in-process


@router.get("")
async def list_workflows():
    """Elenco di tutti i workflow con metadati."""
    return _load_manifest()


@router.get("/{workflow_id}/download")
async def download_workflow(workflow_id: str):
    """Scarica il file JSON del workflow pronto per import su ComfyUI."""
    m = _load_manifest()
    meta = next((w for w in m["workflows"] if w["id"] == workflow_id), None)
    if not meta:
        raise HTTPException(404, f"Workflow '{workflow_id}' non trovato")
    json_path = WORKFLOWS_DIR / meta["file"]
    if not json_path.exists():
        raise HTTPException(404, f"File workflow non trovato: {meta['file']}")
    return FileResponse(
        path=str(json_path),
        media_type="application/json",
        filename=meta["file"],
        headers={"Content-Disposition": f'attachment; filename="{meta["file"]}"'},
    )


@router.get("/{workflow_id}")
async def get_workflow(workflow_id: str):
    """Restituisce metadati + JSON del workflow."""
    m = _load_manifest()
    meta = next((w for w in m["workflows"] if w["id"] == workflow_id), None)
    if not meta:
        raise HTTPException(404, f"Workflow '{workflow_id}' non trovato")
    json_path = WORKFLOWS_DIR / meta["file"]
    wf_json = json.loads(json_path.read_text(encoding="utf-8")) if json_path.exists() else {}
    return {"meta": meta, "workflow": wf_json}


@router.post("")
async def create_workflow(body: dict):
    """Crea un nuovo workflow (incolla JSON)."""
    m = _load_manifest()
    wf_id    = body.get("id") or str(uuid.uuid4())[:8]
    filename = body.get("file") or f"{wf_id}.json"

    if not filename.endswith(".json"):
        filename += ".json"

    meta = {
        "id":           wf_id,
        "name":         body.get("name", "Nuovo workflow"),
        "file":         filename,
        "type":         body.get("type", "txt2img"),
        "description":  body.get("description", ""),
        "inject":       body.get("inject", {}),
        "output_nodes": body.get("output_nodes", []),
    }

    wf_json = body.get("workflow", {})
    (WORKFLOWS_DIR / filename).write_text(
        json.dumps(wf_json, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    existing_idx = next((i for i, w in enumerate(m["workflows"]) if w["id"] == wf_id), None)
    if existing_idx is not None:
        m["workflows"][existing_idx] = meta
    else:
        m["workflows"].append(meta)

    _save_manifest(m)
    return {"ok": True, "id": wf_id, "meta": meta}


@router.put("/{workflow_id}")
async def update_workflow(workflow_id: str, body: dict):
    """Aggiorna metadati e/o JSON di un workflow esistente."""
    m = _load_manifest()
    idx = next((i for i, w in enumerate(m["workflows"]) if w["id"] == workflow_id), None)
    if idx is None:
        raise HTTPException(404, f"Workflow '{workflow_id}' non trovato")

    wf = m["workflows"][idx]
    for k in ("name", "type", "description", "inject", "output_nodes"):
        if k in body:
            wf[k] = body[k]

    if "workflow" in body:
        json_path = WORKFLOWS_DIR / wf["file"]
        json_path.write_text(
            json.dumps(body["workflow"], indent=2, ensure_ascii=False), encoding="utf-8"
        )

    m["workflows"][idx] = wf
    _save_manifest(m)
    return {"ok": True, "meta": wf}


@router.delete("/{workflow_id}")
async def delete_workflow(workflow_id: str):
    """Elimina un workflow (file JSON + voce nel manifest)."""
    m = _load_manifest()
    idx = next((i for i, w in enumerate(m["workflows"]) if w["id"] == workflow_id), None)
    if idx is None:
        raise HTTPException(404, f"Workflow '{workflow_id}' non trovato")

    wf = m["workflows"].pop(idx)
    json_path = WORKFLOWS_DIR / wf["file"]
    if json_path.exists():
        json_path.unlink()

    _save_manifest(m)
    return {"ok": True, "deleted": workflow_id}
