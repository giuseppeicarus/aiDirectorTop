"""ComfyUI node manager, custom node registry and workflow compatibility API."""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from src.core.utils import comfy_manager_service as mgr

router = APIRouter()


class ScanNodeRequest(BaseModel):
    comfy_root_path: Optional[str] = None
    custom_nodes_path: Optional[str] = None
    python_path: Optional[str] = None


class CatalogPackageRequest(BaseModel):
    id: Optional[str] = None
    name: str
    description: str = ""
    github_url: str = ""
    branch: str = "main"
    folder_name: Optional[str] = None
    tags: list[str] = []
    supported_os: list[str] = ["windows", "linux", "macos"]
    trusted: bool = False
    enabled: bool = True
    known_node_types: list[str] = []


class UnknownToRegistryRequest(BaseModel):
    node_id: str
    folder_name: str
    name: Optional[str] = None
    description: str = ""
    github_url: Optional[str] = None
    branch: Optional[str] = None
    tags: list[str] = []
    supported_os: list[str] = ["windows", "linux", "macos"]
    trusted: bool = False


class WorkflowAnalyzeRequest(BaseModel):
    workflow: Optional[dict[str, Any]] = None
    workflow_path: Optional[str] = None
    workflow_id: Optional[str] = None
    name: str = "workflow"


class CustomNodeActionRequest(BaseModel):
    node_id: str
    package_id: str
    confirm_untrusted: bool = False
    mode: str = "disable"
    confirm_delete: bool = False


@router.get("/comfy/nodes")
async def list_comfy_nodes():
    return {"nodes": mgr.list_comfy_nodes()}


@router.get("/comfy/nodes/{node_id}")
async def get_comfy_node(node_id: str):
    try:
        node = mgr.get_node_ref(node_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return node


@router.post("/comfy/nodes/{node_id}/test")
async def test_comfy_node(node_id: str, body: ScanNodeRequest | None = None):
    payload = body or ScanNodeRequest()
    result = mgr.scan_node(
        node_id,
        comfy_root_path=payload.comfy_root_path,
        custom_nodes_path=payload.custom_nodes_path,
        python_path=payload.python_path,
    )
    if not result.get("ok"):
        raise HTTPException(status_code=422, detail=result)
    return result


@router.post("/comfy/nodes/{node_id}/scan")
async def scan_comfy_node(node_id: str, body: ScanNodeRequest | None = None):
    payload = body or ScanNodeRequest()
    result = mgr.scan_node(
        node_id,
        comfy_root_path=payload.comfy_root_path,
        custom_nodes_path=payload.custom_nodes_path,
        python_path=payload.python_path,
    )
    if not result.get("ok"):
        raise HTTPException(status_code=422, detail=result)
    return result


@router.post("/comfy/nodes/{node_id}/restart")
async def restart_comfy_node(node_id: str):
    raise HTTPException(status_code=501, detail="Restart controllato non ancora configurato per questo nodo")


@router.get("/comfy/nodes/{node_id}/custom-nodes")
async def get_node_custom_nodes(node_id: str):
    state = mgr.load_state()
    return {
        "installed": [i for i in state["node_custom_installations"] if str(i.get("node_id")) == str(node_id)],
        "unknown": [i for i in state["detected_custom_nodes"] if str(i.get("node_id")) == str(node_id)],
        "node_types": [i for i in state["custom_node_types"] if str(i.get("node_id")) == str(node_id)],
    }


@router.get("/comfy/nodes/{node_id}/logs")
async def get_node_logs(node_id: str):
    state = mgr.load_state()
    return {"logs": [l for l in state["provisioning_logs"] if str(l.get("node_id", "")) == str(node_id)]}


@router.get("/custom-nodes/catalog")
async def get_custom_node_catalog():
    return {"packages": mgr.load_state()["custom_node_packages"]}


@router.post("/custom-nodes/catalog", status_code=201)
async def add_custom_node_catalog(body: CatalogPackageRequest):
    state = mgr.load_state()
    item = body.model_dump()
    item["id"] = item.get("id") or mgr.package_id_from_name(item["name"])
    item["folder_name"] = item.get("folder_name") or item["name"]
    state["custom_node_packages"] = [p for p in state["custom_node_packages"] if p.get("id") != item["id"]]
    state["custom_node_packages"].append(item)
    mgr.save_state(state)
    return item


@router.put("/custom-nodes/catalog/{package_id}")
async def update_custom_node_catalog(package_id: str, body: CatalogPackageRequest):
    state = mgr.load_state()
    current = next((p for p in state["custom_node_packages"] if p.get("id") == package_id), None)
    if not current:
        raise HTTPException(status_code=404, detail="Package not found")
    updated = {**current, **body.model_dump(), "id": package_id}
    updated["folder_name"] = updated.get("folder_name") or updated["name"]
    state["custom_node_packages"] = [p for p in state["custom_node_packages"] if p.get("id") != package_id]
    state["custom_node_packages"].append(updated)
    mgr.save_state(state)
    return updated


@router.delete("/custom-nodes/catalog/{package_id}")
async def delete_custom_node_catalog(package_id: str):
    state = mgr.load_state()
    before = len(state["custom_node_packages"])
    state["custom_node_packages"] = [p for p in state["custom_node_packages"] if p.get("id") != package_id]
    if len(state["custom_node_packages"]) == before:
        raise HTTPException(status_code=404, detail="Package not found")
    mgr.save_state(state)
    return {"ok": True, "deleted": package_id}


@router.post("/custom-nodes/add-unknown-to-registry", status_code=201)
async def add_unknown_to_registry(body: UnknownToRegistryRequest):
    try:
        return mgr.add_unknown_to_registry(body.node_id, body.folder_name, body.model_dump())
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/custom-nodes/install")
async def install_custom_node(body: CustomNodeActionRequest):
    try:
        return mgr.install_package(body.node_id, body.package_id, confirm_untrusted=body.confirm_untrusted)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.post("/custom-nodes/update")
async def update_custom_node(body: CustomNodeActionRequest):
    try:
        return mgr.update_package(body.node_id, body.package_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.post("/custom-nodes/remove")
async def remove_custom_node(body: CustomNodeActionRequest):
    try:
        return mgr.remove_package(body.node_id, body.package_id, mode=body.mode, confirm_delete=body.confirm_delete)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.post("/custom-nodes/fix-dependencies")
async def fix_custom_node_dependencies(body: CustomNodeActionRequest):
    try:
        return mgr.fix_dependencies(body.node_id, body.package_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.post("/workflows/analyze")
async def analyze_workflow(body: WorkflowAnalyzeRequest):
    try:
        if body.workflow is not None:
            return mgr.analyze_workflow(body.workflow, body.name)
        target = body.workflow_path or body.workflow_id
        if not target:
            raise HTTPException(status_code=400, detail="workflow, workflow_path o workflow_id richiesto")
        return mgr.analyze_workflow_path(target)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Workflow not found")


@router.post("/workflows/{workflow_id}/fix")
async def fix_workflow(workflow_id: str):
    analysis = mgr.analyze_workflow_path(workflow_id)
    return {
        "ok": False,
        "workflow_id": workflow_id,
        "analysis": analysis,
        "message": "Fix automatico pronto per la fase provisioning; nessuna installazione eseguita senza conferma trusted/admin.",
    }
