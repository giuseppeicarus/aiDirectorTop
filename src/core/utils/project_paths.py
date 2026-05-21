"""Percorsi e creazione cartelle progetto su disco."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from src.core.config import get_config

# Sottocartelle standard (pipeline + trailer + reel)
PROJECT_SUBDIRS = ("frames", "clips", "final", "audio", "storyboard", "references")

# ID «catalogo» job trailer (menu /trailer) — i file vanno in trailer_{job_id}
TRAILER_CATALOG_IDS = frozenset({"", "trailer", "trailer_standalone"})
REEL_CATALOG_IDS = frozenset({"", "reel", "reel_standalone", "createreel"})


def is_trailer_catalog_id(project_id: str | None) -> bool:
    return not (project_id or "").strip() or (project_id or "").strip() in TRAILER_CATALOG_IDS


def resolve_trailer_storage_project_id(requested_project_id: str, job_id: str) -> str:
    """
    Cartella disco dedicata per un job trailer.
    - Progetto collegato (UUID da /projects/:id/trailer): stesso UUID
    - Menu Trailer: trailer_{job_id} (non condividere trailer_standalone)
    """
    pid = (requested_project_id or "").strip()
    if pid and pid not in TRAILER_CATALOG_IDS and pid != "__analyze__":
        return pid
    return f"trailer_{job_id}"


def trailer_catalog_project_id(requested_project_id: str | None) -> str:
    """Chiave per trailer_jobs.json (lista job nella UI)."""
    pid = (requested_project_id or "").strip()
    if pid and pid not in TRAILER_CATALOG_IDS and pid != "__analyze__":
        return pid
    return "trailer_standalone"


def trailer_storage_project_id_for_job(
    catalog_project_id: str,
    job_id: str,
    *,
    storage_project_id: str = "",
) -> str:
    """ID cartella artefatti (esplicito, trailer_{job}, o UUID progetto)."""
    explicit = (storage_project_id or "").strip()
    if explicit:
        return explicit
    if is_trailer_catalog_id(catalog_project_id):
        return f"trailer_{job_id}"
    return catalog_project_id


def is_reel_catalog_id(project_id: str | None) -> bool:
    return not (project_id or "").strip() or (project_id or "").strip() in REEL_CATALOG_IDS


def resolve_reel_storage_project_id(requested_project_id: str, job_id: str) -> str:
    pid = (requested_project_id or "").strip()
    if pid and pid not in REEL_CATALOG_IDS and pid != "__analyze__":
        return pid
    return f"reel_{job_id}"


def reel_catalog_project_id(requested_project_id: str | None) -> str:
    pid = (requested_project_id or "").strip()
    if pid and pid not in REEL_CATALOG_IDS and pid != "__analyze__":
        return pid
    return "reel_standalone"


def reel_storage_project_id_for_job(
    catalog_project_id: str,
    job_id: str,
    *,
    storage_project_id: str = "",
) -> str:
    explicit = (storage_project_id or "").strip()
    if explicit:
        return explicit
    if is_reel_catalog_id(catalog_project_id):
        return f"reel_{job_id}"
    return catalog_project_id


def reel_media_search_project_ids(project_id: str) -> list[str]:
    pid = (project_id or "").strip()
    if not pid:
        return ["reel_standalone"]
    ids: list[str] = [pid]
    if pid.startswith("reel_") and pid != "reel_standalone":
        if "reel_standalone" not in ids:
            ids.append("reel_standalone")
    return ids


def trailer_media_search_project_ids(project_id: str) -> list[str]:
    """
    ID cartelle da cercare per servire anteprime (compatibilità file in trailer_standalone).
    """
    pid = (project_id or "").strip()
    if not pid:
        return ["trailer_standalone"]
    ids: list[str] = [pid]
    if pid.startswith("trailer_") and pid != "trailer_standalone":
        if "trailer_standalone" not in ids:
            ids.append("trailer_standalone")
    return ids


def projects_root() -> Path:
    """Root dati applicazione e cartella projects (creata se manca)."""
    cfg = get_config()
    data = cfg.app.data_path
    data.mkdir(parents=True, exist_ok=True)
    root = data / "projects"
    root.mkdir(parents=True, exist_ok=True)
    return root


def project_base_path(project_id: str) -> Path:
    return projects_root() / project_id


def ensure_project_directory(
    project_id: str,
    *,
    title: Optional[str] = None,
) -> Path:
    """
    Crea (se assente) la struttura cartelle del progetto.
    Scrive project.json con id/titolo per riconoscere la cartella in Esplora file.
    """
    base = project_base_path(project_id)
    for name in PROJECT_SUBDIRS:
        (base / name).mkdir(parents=True, exist_ok=True)

    meta_path = base / "project.json"
    meta = {"id": project_id, "title": title or project_id}
    if meta_path.exists():
        try:
            existing = json.loads(meta_path.read_text(encoding="utf-8"))
            if isinstance(existing, dict):
                meta["title"] = title or existing.get("title") or project_id
                meta.setdefault("id", project_id)
        except (json.JSONDecodeError, OSError):
            pass
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
    return base


def list_project_dirs() -> list[dict]:
    """Elenco cartelle in projects/ (per UI storage)."""
    root = projects_root()
    out: list[dict] = []
    for p in sorted(root.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
        if not p.is_dir():
            continue
        title = p.name
        meta = p / "project.json"
        if meta.is_file():
            try:
                data = json.loads(meta.read_text(encoding="utf-8"))
                title = data.get("title") or data.get("id") or p.name
            except (json.JSONDecodeError, OSError):
                pass
        out.append({"id": p.name, "title": title, "path": str(p.resolve())})
    return out
