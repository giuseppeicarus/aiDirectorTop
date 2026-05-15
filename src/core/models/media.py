"""
Modello ORM e Pydantic per MediaItem — immagini e video generati.
Ogni item è collegato a un progetto tramite project_id.
"""

import uuid
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel
from sqlalchemy import DateTime, Float, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from src.core.database import Base


class MediaItemORM(Base):
    __tablename__ = "media_items"

    id:            Mapped[str]            = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    filename:      Mapped[str]            = mapped_column(String(512))
    filepath:      Mapped[str]            = mapped_column(String(1024))
    type:          Mapped[str]            = mapped_column(String(10))   # "image" | "video" | "audio"
    project_id:    Mapped[str]            = mapped_column(String(36))
    project_title: Mapped[str]            = mapped_column(String(255))
    shot_id:       Mapped[Optional[str]]  = mapped_column(String(50), nullable=True)
    frame_type:    Mapped[Optional[str]]  = mapped_column(String(10), nullable=True)  # first|last|final
    width:         Mapped[int]            = mapped_column(Integer, default=0)
    height:        Mapped[int]            = mapped_column(Integer, default=0)
    size_bytes:    Mapped[int]            = mapped_column(Integer, default=0)
    duration_sec:  Mapped[Optional[float]]= mapped_column(Float, nullable=True)
    created_at:    Mapped[datetime]       = mapped_column(DateTime, server_default=func.now())
    source:        Mapped[str]            = mapped_column(String(20), default="generated")
    tags:          Mapped[Optional[str]]  = mapped_column(String(2048), nullable=True)
    description:   Mapped[Optional[str]]  = mapped_column(String(2048), nullable=True)


class MediaItemSchema(BaseModel):
    id: str
    filename: str
    filepath: str
    type: Literal["image", "video", "audio"]
    project_id: str
    project_title: str
    shot_id: Optional[str] = None
    frame_type: Optional[Literal["first", "last", "final"]] = None
    width: int = 0
    height: int = 0
    size_bytes: int = 0
    duration_sec: Optional[float] = None
    created_at: datetime
    source: str = "generated"
    tags: Optional[str] = None
    description: Optional[str] = None

    model_config = {"from_attributes": True}

    @property
    def size_mb(self) -> float:
        return round(self.size_bytes / 1024 / 1024, 1)


class MediaUploadResult(BaseModel):
    id: str
    filename: str
    type: str
    source: str
    filepath: str
    width: int
    height: int
    size_bytes: int
    duration_sec: Optional[float]
    created_at: datetime

    model_config = {"from_attributes": True}
