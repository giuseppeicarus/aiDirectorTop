"""
Tests MediaItem ORM e Pydantic schema.
"""

import uuid
import pytest
import pytest_asyncio
from datetime import datetime
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from src.core.database import Base
from src.core.models.media import MediaItemORM, MediaItemSchema


@pytest_asyncio.fixture(scope="module")
async def db_session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


async def test_create_media_item(db_session):
    item = MediaItemORM(
        id=str(uuid.uuid4()),
        filename="frame_001_first.png",
        filepath="/projects/abc/frames/frame_001_first.png",
        type="image",
        project_id="proj-123",
        project_title="Test Film",
        shot_id="shot_001_001",
        frame_type="first",
        width=1024,
        height=576,
        size_bytes=512000,
    )
    db_session.add(item)
    await db_session.commit()

    from sqlalchemy import select
    result = await db_session.execute(
        select(MediaItemORM).where(MediaItemORM.project_id == "proj-123")
    )
    fetched = result.scalars().all()
    assert len(fetched) >= 1
    assert fetched[0].filename == "frame_001_first.png"
    assert fetched[0].frame_type == "first"


async def test_create_video_media_item(db_session):
    item = MediaItemORM(
        id=str(uuid.uuid4()),
        filename="clip_001.mp4",
        filepath="/projects/abc/clips/clip_001.mp4",
        type="video",
        project_id="proj-456",
        project_title="Another Film",
        shot_id="shot_001_001",
        frame_type="final",
        width=1920,
        height=1080,
        size_bytes=20_000_000,
        duration_sec=4.5,
    )
    db_session.add(item)
    await db_session.commit()

    from sqlalchemy import select
    result = await db_session.execute(
        select(MediaItemORM).where(MediaItemORM.type == "video")
    )
    videos = result.scalars().all()
    assert any(v.filename == "clip_001.mp4" for v in videos)


def test_media_item_schema_size_mb():
    schema = MediaItemSchema(
        id=str(uuid.uuid4()),
        filename="test.png",
        filepath="/test/test.png",
        type="image",
        project_id="proj-001",
        project_title="Test",
        width=1024,
        height=576,
        size_bytes=2_097_152,  # 2 MB
        created_at=datetime.now(),
    )
    assert schema.size_mb == 2.0


def test_media_item_schema_from_orm():
    orm = MediaItemORM(
        id=str(uuid.uuid4()),
        filename="out.png",
        filepath="/data/out.png",
        type="image",
        project_id="p1",
        project_title="Film",
        width=512,
        height=512,
        size_bytes=100_000,
    )
    # Simula created_at per il test
    orm.created_at = datetime.now()
    schema = MediaItemSchema.model_validate(orm)
    assert schema.filename == "out.png"
    assert schema.type == "image"
