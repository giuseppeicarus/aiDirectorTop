"""
API routes Servizi — status aggregato di tutti i servizi (LLM, ComfyUI, DB, FFmpeg).
"""

import asyncio
import shutil
import sqlite3
from pathlib import Path

from fastapi import APIRouter

from src.core.config import get_config

router = APIRouter()


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

    return {
        "llm":     llm_result,
        "comfyui": comfyui_result,
        "database": _check_db(),
        "ffmpeg":  _check_ffmpeg(),
        "storage": _check_storage(),
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
