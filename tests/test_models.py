"""Tests for ORM and Pydantic models."""

import uuid

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from src.core.database import Base
from src.core.models.project import (
    FrameSchema,
    ProjectCreate,
    ProjectORM,
    ProjectResponse,
    SceneSchema,
    ShotSchema,
    StoryboardSchema,
)


@pytest_asyncio.fixture(scope="module")
async def db_session():
    """In-memory SQLite session for model tests."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session

    await engine.dispose()


async def test_create_project(db_session):
    project = ProjectORM(
        id=str(uuid.uuid4()),
        title="Test Film",
        genre="cinematic",
        style="noir, high contrast",
        aspect_ratio="16:9",
        duration_sec=60,
        user_prompt="A story about time",
        status="draft",
    )
    db_session.add(project)
    await db_session.commit()

    result = await db_session.execute(select(ProjectORM).where(ProjectORM.title == "Test Film"))
    fetched = result.scalar_one()
    assert fetched.genre == "cinematic"
    assert fetched.duration_sec == 60
    assert fetched.status == "draft"


async def test_project_storyboard_json(db_session):
    import json
    project_id = str(uuid.uuid4())
    storyboard = {"scenes": [{"id": "s001", "title": "Opening"}]}
    project = ProjectORM(
        id=project_id,
        title="Storyboard Test",
        genre="drama",
        style="cinematic",
        user_prompt="A tale",
        storyboard_json=json.dumps(storyboard),
    )
    db_session.add(project)
    await db_session.commit()

    result = await db_session.execute(select(ProjectORM).where(ProjectORM.id == project_id))
    fetched = result.scalar_one()
    parsed = json.loads(fetched.storyboard_json)
    assert parsed["scenes"][0]["title"] == "Opening"


async def test_project_pipeline_state(db_session):
    project_id = str(uuid.uuid4())
    project = ProjectORM(
        id=project_id,
        title="Pipeline Test",
        genre="action",
        style="gritty",
        user_prompt="Heist story",
        pipeline_state={"stage": "frame_gen", "progress": 0.5},
    )
    db_session.add(project)
    await db_session.commit()

    result = await db_session.execute(select(ProjectORM).where(ProjectORM.id == project_id))
    fetched = result.scalar_one()
    assert fetched.pipeline_state["stage"] == "frame_gen"
    assert fetched.pipeline_state["progress"] == 0.5


def test_project_create_schema_defaults():
    data = ProjectCreate(title="My Film", user_prompt="A dramatic story")
    assert data.genre == "cinematic"
    assert data.aspect_ratio == "16:9"
    assert data.duration_sec == 60
    assert data.user_prompt == "A dramatic story"


def test_frame_schema_defaults():
    frame = FrameSchema(
        prompt="A beautiful sunset over the ocean, golden hour, cinematic photography"
    )
    assert frame.cfg_scale == 7.0
    assert frame.steps == 30
    assert frame.seed is None
    assert frame.negative_prompt == ""


def test_shot_schema_structure():
    frame = FrameSchema(prompt="Opening wide shot")
    shot = ShotSchema(
        id="shot_001",
        description="Wide establishing shot",
        shot_type="wide",
        camera_movement="static",
        duration_sec=4.0,
        first_frame=frame,
        last_frame=frame,
    )
    assert shot.status == "pending"
    assert shot.lens_mm == 35
    assert shot.first_frame.prompt == "Opening wide shot"


def test_scene_schema_structure():
    frame = FrameSchema(prompt="test")
    shot = ShotSchema(
        id="s001", description="desc", shot_type="medium", camera_movement="pan",
        duration_sec=3.0, first_frame=frame, last_frame=frame
    )
    scene = SceneSchema(
        id="scene_001", title="Opening", description="Dark alley",
        duration_sec=10.0, shots=[shot]
    )
    assert scene.time_of_day == "afternoon"
    assert len(scene.shots) == 1


def test_project_response_from_orm():
    import json
    from datetime import datetime
    orm = ProjectORM(
        id="abc-123",
        title="Test",
        genre="drama",
        style="cinematic",
        user_prompt="story",
        aspect_ratio="16:9",
        duration_sec=60,
        status="draft",
        created_at=datetime.now(),
        updated_at=datetime.now(),
    )
    # ProjectResponse requires from_attributes=True
    resp = ProjectResponse.model_validate(orm)
    assert resp.id == "abc-123"
    assert resp.title == "Test"
