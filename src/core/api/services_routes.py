"""
API routes Servizi — status aggregato di tutti i servizi (LLM, ComfyUI, DB, FFmpeg).
"""

import asyncio
import json
import shutil
import sqlite3
from pathlib import Path
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from src.core.config import get_config
from src.core.api.user_tools_routes import router as user_tools_router

router = APIRouter()
router.include_router(user_tools_router)


async def _check_llm() -> dict:
    try:
        from src.core.llm.factory import get_llm_adapter
        adapter = get_llm_adapter()
        ok = await asyncio.wait_for(adapter.health_check(), timeout=8.0)
        cfg = get_config().llm
        return {"ok": ok, "provider": cfg.provider, "model": cfg.model}
    except Exception as e:
        return {"ok": False, "error": str(e)}


async def _check_comfyui() -> dict:
    try:
        from src.core.comfyui.pool import ComfyUINodePool
        pool = ComfyUINodePool()
        statuses = await asyncio.wait_for(pool.status(), timeout=10.0)
        online = sum(1 for s in statuses if s["online"])
        return {"ok": online > 0, "nodes_total": len(statuses), "nodes_online": online, "nodes": statuses}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _check_db() -> dict:
    try:
        cfg = get_config()
        db_path = cfg.app.data_path / "studio.db"
        if not db_path.exists():
            return {"ok": False, "error": "Database non inizializzato"}
        conn = sqlite3.connect(str(db_path))
        tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
        conn.close()
        return {"ok": True, "path": str(db_path), "tables": tables}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _check_ffmpeg() -> dict:
    cfg = get_config()
    ffmpeg_path = cfg.output.ffmpeg_path or shutil.which("ffmpeg")
    if ffmpeg_path:
        return {"ok": True, "path": ffmpeg_path}
    return {"ok": False, "error": "ffmpeg non trovato in PATH"}


def _check_storage() -> dict:
    try:
        data_path = get_config().app.data_path
        data_path.mkdir(parents=True, exist_ok=True)
        total, used, free = shutil.disk_usage(data_path)
        return {
            "ok": True,
            "data_dir": str(data_path),
            "free_gb": round(free / 1e9, 1),
            "total_gb": round(total / 1e9, 1),
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.get("/status")
async def services_status():
    """Status aggregato di tutti i servizi in parallelo."""
    llm_task = asyncio.create_task(_check_llm())
    comfyui_task = asyncio.create_task(_check_comfyui())

    llm_result, comfyui_result = await asyncio.gather(llm_task, comfyui_task)

    obsidian_result: dict = {"ok": False, "enabled": False}
    try:
        cfg = get_config()
        if cfg.obsidian.enabled:
            from src.core.obsidian.docker_service import container_status
            from src.core.obsidian.vault_manager import get_vault_manager

            mgr = get_vault_manager()
            docker = container_status()
            obsidian_result = {
                "ok": True,
                "enabled": True,
                "vault_path": str(mgr.vault_path),
                "projects_count": len(mgr.list_projects()),
                "docker_running": docker.get("running", False),
            }
    except Exception as e:
        obsidian_result = {"ok": False, "enabled": True, "error": str(e)}

    return {
        "llm":     llm_result,
        "comfyui": comfyui_result,
        "database": _check_db(),
        "ffmpeg":  _check_ffmpeg(),
        "storage": _check_storage(),
        "obsidian": obsidian_result,
    }


@router.get("/llm")
async def llm_service_status():
    return await _check_llm()


@router.get("/comfyui")
async def comfyui_service_status():
    return await _check_comfyui()


@router.get("/database")
async def db_service_status():
    return _check_db()


@router.get("/ffmpeg")
async def ffmpeg_service_status():
    return _check_ffmpeg()


@router.get("/storage")
async def storage_detail():
    """Percorsi dati su disco e elenco cartelle progetto."""
    from src.core.utils.project_paths import list_project_dirs, projects_root

    storage = _check_storage()
    projects_dir = projects_root()
    return {
        **storage,
        "projects_dir": str(projects_dir.resolve()),
        "projects": list_project_dirs(),
        "project_count": sum(1 for p in projects_dir.iterdir() if p.is_dir()) if projects_dir.is_dir() else 0,
    }


# ── AI-Toolkit config ─────────────────────────────────────────────────────────

@router.get("/ai-toolkit")
def ai_toolkit_config_get():
    """Legge la configurazione cartelle AI-Toolkit."""
    cfg = get_config().ai_toolkit
    # Resolve effective training_folder (same logic as adapter)
    training_folder = cfg.training_folder or str(
        Path("~/.cinematic-studio/ai-toolkit-training").expanduser()
    )
    toolkit_dir = cfg.toolkit_dir or ""
    return {
        "training_folder": training_folder,
        "toolkit_dir": toolkit_dir,
        "backend": cfg.backend,
        "mode": cfg.mode,
        "base_model": cfg.base_model,
        "docker_hf_cache": cfg.docker_hf_cache,
        "hf_token": cfg.hf_token,
        "remote_url": cfg.remote_url,
        "remote_api_key": cfg.remote_api_key,
    }


@router.post("/ai-toolkit")
async def ai_toolkit_config_save(body: dict):
    """
    Salva la configurazione cartelle AI-Toolkit in ~/.cinematic-studio/config.yaml.
    Accetta: training_folder, toolkit_dir, backend, mode, base_model, docker_hf_cache, hf_token, remote_url, remote_api_key.
    """
    import yaml
    from src.core.config import reload_config

    allowed = {
        "training_folder",
        "toolkit_dir",
        "backend",
        "mode",
        "base_model",
        "docker_hf_cache",
        "hf_token",
        "remote_url",
        "remote_api_key",
    }
    update = {k: v for k, v in body.items() if k in allowed}

    user_path = Path("~/.cinematic-studio/config.yaml").expanduser()
    user_path.parent.mkdir(parents=True, exist_ok=True)

    existing: dict = {}
    if user_path.exists():
        with open(user_path, encoding="utf-8") as f:
            existing = yaml.safe_load(f) or {}

    existing.setdefault("ai_toolkit", {}).update(update)

    # Create effective training folder immediately
    if "training_folder" in update and update["training_folder"]:
        Path(update["training_folder"]).mkdir(parents=True, exist_ok=True)

    with open(user_path, "w", encoding="utf-8") as f:
        yaml.dump(existing, f, default_flow_style=False, allow_unicode=True)

    reload_config()
    return {"ok": True, "saved": update}


@router.get("/ai-toolkit/disk")
def ai_toolkit_disk_info(path: str = ""):
    """Spazio disco per il path specificato (drive della training_folder)."""
    try:
        check_path = Path(path) if path else Path("~/.cinematic-studio").expanduser()
        # Walk up to find an existing parent
        while not check_path.exists() and check_path.parent != check_path:
            check_path = check_path.parent
        total, used, free = shutil.disk_usage(check_path)
        return {
            "ok": True,
            "free_gb": round(free / 1e9, 1),
            "total_gb": round(total / 1e9, 1),
            "used_gb": round(used / 1e9, 1),
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ── Whisper config ────────────────────────────────────────────────────────────

_WHISPER_CONFIG_PATH = Path("~/.cinematic-studio/whisper_config.json").expanduser()


class WhisperConfig(BaseModel):
    model_size: str = "base"   # tiny / base / small / medium / large
    language: Optional[str] = None
    mode: str = "local"        # "local" | "remote"
    remote_url: Optional[str] = None


def _read_whisper_config() -> WhisperConfig:
    """Legge whisper_config.json; ritorna defaults se assente o corrotto."""
    if _WHISPER_CONFIG_PATH.exists():
        try:
            raw = json.loads(_WHISPER_CONFIG_PATH.read_text(encoding="utf-8"))
            return WhisperConfig(**raw)
        except Exception:
            pass
    return WhisperConfig()


@router.get("/whisper-config")
def whisper_config_get():
    """Legge la configurazione Whisper da ~/.cinematic-studio/whisper_config.json."""
    return _read_whisper_config().model_dump()


@router.post("/whisper-config")
def whisper_config_save(body: WhisperConfig):
    """Salva la configurazione Whisper in ~/.cinematic-studio/whisper_config.json."""
    _WHISPER_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    _WHISPER_CONFIG_PATH.write_text(
        json.dumps(body.model_dump(), indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    return {"ok": True}
