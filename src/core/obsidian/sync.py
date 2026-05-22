"""Hook asincroni: sincronizza checkpoint → vault Obsidian."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Optional

import structlog

log = structlog.get_logger()


def _obsidian_enabled() -> bool:
    try:
        from src.core.config import get_config
        return bool(get_config().obsidian.enabled)
    except Exception:
        return False


async def _sync_checkpoint_async(
    *,
    project_id: str,
    job_id: str,
    pipeline_kind: str,
    checkpoint: dict[str, Any],
    extra: Optional[dict[str, Any]] = None,
) -> None:
    if not _obsidian_enabled():
        return
    try:
        from src.core.obsidian.vault_manager import get_vault_manager

        mgr = get_vault_manager()
        await asyncio.to_thread(
            mgr.sync_trailer_or_reel_checkpoint,
            project_id=project_id,
            job_id=job_id,
            pipeline_kind=pipeline_kind,
            checkpoint=checkpoint,
            extra=extra,
        )
    except Exception as exc:
        log.warning("obsidian_sync_failed", error=str(exc))


async def _sync_cinematic_async(project_id: str, state_path: Path) -> None:
    if not _obsidian_enabled() or not state_path.exists():
        return
    try:
        from src.core.obsidian.vault_manager import get_vault_manager

        data = json.loads(state_path.read_text(encoding="utf-8"))
        mgr = get_vault_manager()
        await asyncio.to_thread(
            mgr.sync_cinematic_pipeline,
            project_id=project_id,
            pipeline_state=data,
        )
    except Exception as exc:
        log.warning("obsidian_cinematic_sync_failed", error=str(exc))


def _schedule_coro(coro) -> None:
    """Esegue coroutine in background (async loop o thread di fallback)."""
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(coro)
        return
    except RuntimeError:
        pass

    import threading

    def _runner() -> None:
        try:
            asyncio.run(coro)
        except Exception as exc:
            log.warning("obsidian_sync_thread_failed", error=str(exc))

    threading.Thread(target=_runner, daemon=True).start()


def schedule_obsidian_sync_from_checkpoint(
    *,
    project_id: str,
    job_id: str,
    pipeline_kind: str,
    checkpoint: dict[str, Any],
    extra: Optional[dict[str, Any]] = None,
) -> None:
    """Schedula sync non bloccante dopo salvataggio checkpoint."""
    if not _obsidian_enabled():
        return
    _schedule_coro(
        _sync_checkpoint_async(
            project_id=project_id,
            job_id=job_id,
            pipeline_kind=pipeline_kind,
            checkpoint=checkpoint,
            extra=extra,
        )
    )


def schedule_obsidian_sync_cinematic(project_id: str, state_path: Path) -> None:
    if not _obsidian_enabled():
        return
    _schedule_coro(_sync_cinematic_async(project_id, state_path))
