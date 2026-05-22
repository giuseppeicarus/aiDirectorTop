"""
Script utente scaricabili (modelli ComfyUI) — serviti da scripts/user_tools/.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

router = APIRouter()

ScriptKey = Literal["linux", "macos", "windows_ps1", "windows_bat"]

_SCRIPT_META: dict[str, dict[str, str]] = {
    "linux": {
        "filename": "download_model_comfyui_linux.sh",
        "label": "Linux (Bash)",
        "platform": "linux",
        "hint": "chmod +x poi esegui dalla cartella ComfyUI: ./download_model_comfyui_linux.sh",
    },
    "macos": {
        "filename": "download_model_comfyui_macos.sh",
        "label": "macOS (Bash)",
        "platform": "darwin",
        "hint": "chmod +x poi esegui dalla cartella ComfyUI: ./download_model_comfyui_macos.sh",
    },
    "windows_ps1": {
        "filename": "download_model_comfyui_windows.ps1",
        "label": "Windows (PowerShell)",
        "platform": "win32",
        "hint": "powershell -ExecutionPolicy Bypass -File download_model_comfyui_windows.ps1",
    },
    "windows_bat": {
        "filename": "download_model_comfyui_windows.bat",
        "label": "Windows (Batch)",
        "platform": "win32",
        "hint": "Doppio click o cmd dalla cartella ComfyUI",
    },
}


def _user_tools_dir() -> Path:
    root = Path(__file__).resolve().parents[3]
    return root / "scripts" / "user_tools"


def _script_path(key: str) -> Path:
    meta = _SCRIPT_META.get(key)
    if not meta:
        raise HTTPException(status_code=404, detail=f"Script sconosciuto: {key}")
    path = _user_tools_dir() / meta["filename"]
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"File non trovato: {meta['filename']}")
    return path


@router.get("/comfyui-model-scripts")
async def list_comfyui_model_scripts():
    """Elenco script download modelli per piattaforma."""
    base = _user_tools_dir()
    scripts = []
    for key, meta in _SCRIPT_META.items():
        path = base / meta["filename"]
        scripts.append({
            "id": key,
            "label": meta["label"],
            "platform": meta["platform"],
            "filename": meta["filename"],
            "hint": meta["hint"],
            "available": path.is_file(),
            "size_bytes": path.stat().st_size if path.is_file() else 0,
        })
    return {
        "title": "SCRIPT MODEL COMFYUI",
        "description": (
            "Scarica lo script per la tua piattaforma, copialo nella root di ComfyUI "
            "e avvialo: crea la cartella models/ con checkpoint, LoRA, VAE e upscaler."
        ),
        "models_base_dir": "./models",
        "scripts": scripts,
    }


@router.get("/comfyui-model-scripts/{script_id}")
async def download_comfyui_model_script(script_id: str):
    """Download del file script (attachment)."""
    path = _script_path(script_id)
    meta = _SCRIPT_META[script_id]
    media = "application/octet-stream"
    if path.suffix == ".sh":
        media = "text/x-shellscript"
    elif path.suffix == ".ps1":
        media = "text/plain"
    elif path.suffix == ".bat":
        media = "application/x-bat"
    return FileResponse(
        path,
        media_type=media,
        filename=meta["filename"],
        headers={"Content-Disposition": f'attachment; filename="{meta["filename"]}"'},
    )
