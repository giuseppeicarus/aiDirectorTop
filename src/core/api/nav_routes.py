"""Navigazione sidebar — progetti recenti unificati (cinematic, reel, trailer)."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Query
from sqlalchemy import select

from src.core.config import get_config
from src.core.database import AsyncSessionLocal
from src.core.models.project import ProjectORM

router = APIRouter()


def _parse_ts(iso: str | None) -> float:
    if not iso:
        return 0.0
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def _reel_path(catalog_id: str, job_id: str) -> str:
    if catalog_id == "reel_standalone":
        return f"/createreel?job={job_id}"
    return f"/projects/{catalog_id}/reel?job={job_id}"


def _trailer_path(catalog_id: str, job_id: str) -> str:
    if catalog_id == "trailer_standalone":
        return f"/trailer?job={job_id}"
    return f"/projects/{catalog_id}/trailer?job={job_id}"


def _jobs_from_file(jobs_path: Path, *, kind: str) -> list[dict]:
    catalog_id = jobs_path.parent.name
    try:
        raw = json.loads(jobs_path.read_text(encoding="utf-8"))
    except Exception:
        return []
    if not isinstance(raw, list):
        return []

    path_fn = _reel_path if kind == "reel" else _trailer_path
    out: list[dict] = []
    for j in raw:
        if not isinstance(j, dict):
            continue
        job_id = j.get("job_id")
        if not job_id:
            continue
        title = (
            j.get("title")
            or j.get("description")
            or j.get("audio_name")
            or f"{kind} {job_id[:8]}"
        )
        out.append({
            "kind": kind,
            "id": job_id,
            "catalog_id": catalog_id,
            "title": str(title).strip()[:120] or kind,
            "updated_at": j.get("updated_at") or j.get("created_at") or "",
            "path": path_fn(catalog_id, job_id),
        })
    return out


@router.get("/recent")
async def recent_nav_items(limit: int = Query(3, ge=1, le=10)):
    """Ultimi N elementi tra progetti DB, job reel e job trailer."""
    items: list[dict] = []

    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(ProjectORM).order_by(ProjectORM.updated_at.desc()).limit(50),
        )
        for p in result.scalars().all():
            ts = p.updated_at or p.created_at
            items.append({
                "kind": "project",
                "id": p.id,
                "catalog_id": p.id,
                "title": (p.title or "Progetto").strip()[:120],
                "updated_at": ts.isoformat() if ts else "",
                "path": f"/projects/{p.id}",
            })

    root = get_config().app.data_path / "projects"
    if root.is_dir():
        for jobs_path in root.rglob("reel_jobs.json"):
            items.extend(_jobs_from_file(jobs_path, kind="reel"))
        for jobs_path in root.rglob("trailer_jobs.json"):
            items.extend(_jobs_from_file(jobs_path, kind="trailer"))

    items.sort(key=lambda x: _parse_ts(x.get("updated_at")), reverse=True)
    seen: set[tuple[str, str, str]] = set()
    deduped: list[dict] = []
    for it in items:
        key = (it["kind"], it.get("catalog_id", ""), it["id"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(it)
        if len(deduped) >= limit:
            break

    return {"items": deduped}
