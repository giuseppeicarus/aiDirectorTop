"""Registro verifiche / blacklist modelli LLM per provider."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import delete, select

from src.core.database import AsyncSessionLocal
from src.core.models.llm_registry import LlmModelBlacklistORM, LlmModelVerificationORM

# provider -> set(model_id)
_blacklist_cache: dict[str, set[str]] = {}


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def is_blacklisted_sync(provider: str, model_id: str) -> bool:
    p = (provider or "").lower()
    m = (model_id or "").strip()
    if not p or not m:
        return False
    return m in _blacklist_cache.get(p, set())


def filter_models_sync(provider: str, models: list[str]) -> list[str]:
    p = (provider or "").lower()
    blocked = _blacklist_cache.get(p, set())
    if not blocked:
        return list(models)
    return [m for m in models if m not in blocked]


async def refresh_blacklist_cache() -> None:
    global _blacklist_cache
    async with AsyncSessionLocal() as session:
        rows = (await session.execute(select(LlmModelBlacklistORM))).scalars().all()
        cache: dict[str, set[str]] = {}
        for row in rows:
            cache.setdefault(row.provider.lower(), set()).add(row.model_id)
        _blacklist_cache = cache


async def record_probe_result(
    provider: str,
    model_id: str,
    *,
    ok: bool,
    message: str = "",
    load_time_seconds: Optional[float] = None,
) -> None:
    """Salva esito verifica; ok=True rimuove blacklist, ok=False aggiunge."""
    p = (provider or "").lower()
    m = (model_id or "").strip()
    if not p or not m:
        return

    async with AsyncSessionLocal() as session:
        session.add(
            LlmModelVerificationORM(
                provider=p,
                model_id=m,
                ok=ok,
                message=(message or "")[:2000] or None,
                load_time_seconds=load_time_seconds,
                verified_at=_now(),
            )
        )

        if ok:
            await session.execute(
                delete(LlmModelBlacklistORM).where(
                    LlmModelBlacklistORM.provider == p,
                    LlmModelBlacklistORM.model_id == m,
                )
            )
        else:
            existing = (
                await session.execute(
                    select(LlmModelBlacklistORM).where(
                        LlmModelBlacklistORM.provider == p,
                        LlmModelBlacklistORM.model_id == m,
                    )
                )
            ).scalar_one_or_none()
            if existing:
                existing.reason = (message or "")[:2000] or existing.reason
                existing.blacklisted_at = _now()
            else:
                session.add(
                    LlmModelBlacklistORM(
                        provider=p,
                        model_id=m,
                        reason=(message or "")[:2000] or None,
                        blacklisted_at=_now(),
                    )
                )
        await session.commit()

    await refresh_blacklist_cache()


async def remove_from_blacklist(provider: str, model_id: str) -> bool:
    p = (provider or "").lower()
    m = (model_id or "").strip()
    if not p or not m:
        return False

    async with AsyncSessionLocal() as session:
        result = await session.execute(
            delete(LlmModelBlacklistORM).where(
                LlmModelBlacklistORM.provider == p,
                LlmModelBlacklistORM.model_id == m,
            )
        )
        await session.commit()
        removed = result.rowcount > 0

    await refresh_blacklist_cache()
    return removed


async def list_registry(provider: Optional[str] = None, *, limit: int = 100) -> dict:
    p = (provider or "").lower() if provider else None

    async with AsyncSessionLocal() as session:
        bl_q = select(LlmModelBlacklistORM).order_by(LlmModelBlacklistORM.blacklisted_at.desc())
        if p:
            bl_q = bl_q.where(LlmModelBlacklistORM.provider == p)
        blacklist = (await session.execute(bl_q)).scalars().all()

        ver_q = (
            select(LlmModelVerificationORM)
            .where(LlmModelVerificationORM.ok.is_(True))
            .order_by(LlmModelVerificationORM.verified_at.desc())
            .limit(limit)
        )
        if p:
            ver_q = ver_q.where(LlmModelVerificationORM.provider == p)
        verified_rows = (await session.execute(ver_q)).scalars().all()

    seen_ok: set[tuple[str, str]] = set()
    verified: list = []
    for row in verified_rows:
        key = (row.provider, row.model_id)
        if key in seen_ok:
            continue
        seen_ok.add(key)
        verified.append(row)

    return {
        "blacklist": [
            {
                "id": row.id,
                "provider": row.provider,
                "model_id": row.model_id,
                "reason": row.reason,
                "blacklisted_at": row.blacklisted_at.isoformat(),
            }
            for row in blacklist
        ],
        "verified_ok": [
            {
                "id": row.id,
                "provider": row.provider,
                "model_id": row.model_id,
                "message": row.message,
                "load_time_seconds": row.load_time_seconds,
                "verified_at": row.verified_at.isoformat(),
            }
            for row in verified
        ],
    }
