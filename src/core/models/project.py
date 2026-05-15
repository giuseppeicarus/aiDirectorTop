"""
Modelli ORM (SQLAlchemy) e Pydantic per Project, Scene, Shot, Frame.
"""

import uuid
from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, Field
from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from src.core.database import Base


# ── ORM Models ────────────────────────────────────────────────────────────────

class ProjectORM(Base):
    __tablename__ = "projects"

    id:               Mapped[str]           = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    title:            Mapped[str]           = mapped_column(String(255))
    genre:            Mapped[str]           = mapped_column(String(50))
    style:            Mapped[str]           = mapped_column(Text)
    user_prompt:      Mapped[str]           = mapped_column(Text)
    aspect_ratio:     Mapped[str]           = mapped_column(String(10), default="16:9")
    duration_sec:     Mapped[int]           = mapped_column(Integer, default=60)
    status:           Mapped[str]           = mapped_column(String(30), default="draft")
    storyboard_json:  Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    final_video_path: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at:       Mapped[datetime]      = mapped_column(DateTime, server_default=func.now())
    updated_at:       Mapped[datetime]      = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
    pipeline_state:   Mapped[Optional[str]] = mapped_column(JSON, nullable=True)
    # Extended production settings
    max_clip_sec:           Mapped[int]           = mapped_column(Integer, default=8)
    video_resolution:       Mapped[str]           = mapped_column(String(20), default="1920x1080")
    frame_resolution_mult:  Mapped[int]           = mapped_column(Integer, default=2)
    audio_path:             Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    lyrics:                 Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    audio_analysis_json:    Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    mode:                   Mapped[str]           = mapped_column(String(20), default="full_auto")


# ── Pydantic Schemas ──────────────────────────────────────────────────────────

class FrameSchema(BaseModel):
    prompt: str
    negative_prompt: str = ""
    seed: Optional[int] = None
    cfg_scale: float = 7.0
    steps: int = 30
    image_path: Optional[str] = None


class ShotSchema(BaseModel):
    id: str
    description: str
    shot_type: str
    camera_movement: str
    lens_mm: int = 35
    depth_of_field: str = "medium"
    duration_sec: float
    first_frame: FrameSchema
    last_frame: FrameSchema
    motion_prompt: str = ""
    comfyui_workflow: str = "img2video_wan21"
    clip_path: Optional[str] = None
    status: str = "pending"  # pending|generating_frames|generating_video|done|failed
    error: Optional[str] = None


class SceneSchema(BaseModel):
    id: str
    title: str
    description: str
    location: str = ""
    time_of_day: str = "afternoon"
    mood: str = ""
    color_palette: List[str] = Field(default_factory=list)
    duration_sec: float
    shots: List[ShotSchema] = Field(default_factory=list)


class StoryboardSchema(BaseModel):
    project: dict
    scenes: List[SceneSchema]


class ProjectCreate(BaseModel):
    title: str
    genre: str = "cinematic"
    style: str = "photorealistic, dramatic lighting"
    user_prompt: str
    aspect_ratio: str = "16:9"
    duration_sec: int = 60
    max_clip_sec: int = 8
    video_resolution: str = "1920x1080"
    frame_resolution_mult: int = 2
    lyrics: Optional[str] = None
    mode: str = "full_auto"


class ProjectResponse(BaseModel):
    id: str
    title: str
    genre: str
    style: str
    user_prompt: str
    aspect_ratio: str
    duration_sec: int
    status: str
    storyboard_json: Optional[str]
    final_video_path: Optional[str]
    created_at: datetime
    updated_at: datetime
    max_clip_sec: int = 8
    video_resolution: str = "1920x1080"
    frame_resolution_mult: int = 2
    audio_path: Optional[str] = None
    lyrics: Optional[str] = None
    audio_analysis_json: Optional[str] = None
    mode: str = "full_auto"

    model_config = {"from_attributes": True}
