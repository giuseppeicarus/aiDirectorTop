"""
Database SQLite asincrono via SQLAlchemy.
Inizializzare con: await init_db()
"""

from pathlib import Path
from typing import AsyncGenerator

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from src.core.config import get_config


class Base(DeclarativeBase):
    pass


def _get_db_url() -> str:
    config = get_config()
    db_path = config.app.data_path / "studio.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    return f"sqlite+aiosqlite:///{db_path}"


engine = create_async_engine(_get_db_url(), echo=False)
AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)


async def init_db() -> None:
    """Crea tutte le tabelle se non esistono."""
    # Import modelli per registrarli in Base.metadata
    from src.core.models import project  # noqa: F401
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


_NEW_COLUMNS = [
    ("max_clip_sec",          "INTEGER DEFAULT 8"),
    ("video_resolution",      "TEXT DEFAULT '1920x1080'"),
    ("frame_resolution_mult", "INTEGER DEFAULT 2"),
    ("audio_path",            "TEXT"),
    ("lyrics",                "TEXT"),
    ("audio_analysis_json",   "TEXT"),
    ("mode",                  "TEXT DEFAULT 'full_auto'"),
]


async def migrate_db() -> None:
    """Add missing columns to existing projects table (safe, idempotent)."""
    async with engine.begin() as conn:
        result = await conn.execute(text("PRAGMA table_info(projects)"))
        existing = {row[1] for row in result}
        for col, definition in _NEW_COLUMNS:
            if col not in existing:
                await conn.execute(text(f"ALTER TABLE projects ADD COLUMN {col} {definition}"))


_NEW_MEDIA_COLUMNS = [
    ("source",      "TEXT DEFAULT 'generated'"),
    ("tags",        "TEXT"),
    ("description", "TEXT"),
]


async def migrate_media_db() -> None:
    """Add missing columns to existing media_items table (safe, idempotent)."""
    async with engine.begin() as conn:
        result = await conn.execute(text("PRAGMA table_info(media_items)"))
        existing = {row[1] for row in result}
        for col, definition in _NEW_MEDIA_COLUMNS:
            if col not in existing:
                await conn.execute(text(f"ALTER TABLE media_items ADD COLUMN {col} {definition}"))


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Dependency FastAPI per ottenere una sessione DB."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
