"""Dashboard — panoramica studio (stats, servizi, run attivi, media recenti)."""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core import pipeline_registry
from src.core.utils.media_registry import cleanup_missing_media
from src.core.api.services_routes import services_status
from src.core.comfyui.gen_stats import _load_all, get_averages
from src.core.comfyui.workflow_builder import WORKFLOWS_DIR
from src.core.database import get_db
from src.core.models.media import MediaItemORM
from src.core.utils.media_prompt_resolver import MediaPromptResolver

router = APIRouter()


def _generation_summary() -> dict[str, Any]:
    entries = _load_all()
    by_kind = {"image": 0, "video": 0}
    for e in entries:
        k = e.get("kind", "image")
        if k in by_kind:
            by_kind[k] += 1
    averages = get_averages()
    workflow_keys = set()
    for kind_map in averages.values():
        if isinstance(kind_map, dict):
            workflow_keys.update(kind_map.keys())
    return {
        "comfyui_jobs_total": len(entries),
        "comfyui_jobs_image": by_kind["image"],
        "comfyui_jobs_video": by_kind["video"],
        "tracked_workflows": len(workflow_keys),
        "averages": averages,
    }


@router.get("/overview")
async def dashboard_overview(db: AsyncSession = Depends(get_db)):
    """Dati aggregati per la home Dashboard."""
    await cleanup_missing_media(db)

    media_result = await db.execute(
        select(MediaItemORM)
        .where(MediaItemORM.type.in_(("image", "video")))
        .order_by(MediaItemORM.created_at.desc())
        .limit(10),
    )
    recent_rows = media_result.scalars().all()
    prompt_resolver = MediaPromptResolver()

    all_result = await db.execute(select(MediaItemORM))
    all_items = all_result.scalars().all()
    total_size = sum(i.size_bytes for i in all_items)

    manifest_path = WORKFLOWS_DIR / "manifest.json"
    workflow_count = 0
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            workflow_count = len(manifest.get("workflows") or [])
        except Exception:
            pass

    services = await services_status()
    gen = _generation_summary()

    import httpx
    from src.core.config import get_config

    queue_depth = 0
    cfg = get_config()
    raw_nodes = getattr(cfg.comfyui, "nodes", [])
    if raw_nodes:
        primary = next((n for n in raw_nodes if getattr(n, "primary", False)), raw_nodes[0])
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                r = await client.get(f"http://{primary.host}:{primary.port}/queue")
                data = r.json()
                queue_depth = len(data.get("queue_running", [])) + len(data.get("queue_pending", []))
        except Exception:
            pass

    recent_media = []
    for row in recent_rows:
        recent_media.append({
            "id": row.id,
            "type": row.type,
            "filename": row.filename,
            "project_id": row.project_id,
            "project_title": row.project_title or row.project_id,
            "shot_id": row.shot_id,
            "frame_type": row.frame_type,
            "width": row.width,
            "height": row.height,
            "size_bytes": row.size_bytes,
            "duration_sec": row.duration_sec,
            "created_at": row.created_at.isoformat() if row.created_at else None,
            "source": row.source,
            "generation_prompt": (row.description or "").strip() or prompt_resolver.resolve(row),
        })

    return {
        "media": {
            "total": len(all_items),
            "images": sum(1 for i in all_items if i.type == "image"),
            "videos": sum(1 for i in all_items if i.type == "video"),
            "audios": sum(1 for i in all_items if i.type == "audio"),
            "size_bytes": total_size,
            "size_gb": round(total_size / 1024**3, 2),
        },
        "generation": gen,
        "workflows_count": workflow_count,
        "queue_depth": queue_depth,
        "services": services,
        "active_runs": pipeline_registry.get_all_active(),
        "recent_media": recent_media,
    }
