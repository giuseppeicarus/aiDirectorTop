"""Pydantic models for created characters."""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field

CharacterStatus = Literal["bozza", "in_creazione", "pronto", "completato", "errore"]
CharacterProfile = Literal["Low", "Medium", "High"]
CaptionMode = Literal["auto", "manuale", "mista"]


class CharacterImage(BaseModel):
    id: str
    filename: str
    filepath: str
    sha256: str
    valid: bool = True
    duplicate: bool = False
    error: Optional[str] = None
    manual_caption: str = ""
    auto_caption: str = ""
    final_caption: str = ""
    width: int = 0
    height: int = 0


class CharacterRecord(BaseModel):
    id: str
    owner_id: str = "local_user"
    name: str
    profile: CharacterProfile = "Low"
    caption_mode: CaptionMode = "mista"
    status: CharacterStatus = "bozza"
    created_at: datetime
    updated_at: datetime
    progress: int = 0
    logs: list[str] = Field(default_factory=list)
    error: Optional[str] = None
    preview_path: Optional[str] = None
    output_path: Optional[str] = None
    media_item_id: Optional[str] = None
    active: bool = True
    images: list[CharacterImage] = Field(default_factory=list)
    config: dict = Field(default_factory=dict)

    @property
    def valid_image_count(self) -> int:
        return sum(1 for image in self.images if image.valid and not image.duplicate)


class CharacterSummary(BaseModel):
    id: str
    owner_id: str
    name: str
    profile: CharacterProfile
    status: CharacterStatus
    created_at: datetime
    updated_at: datetime
    progress: int
    preview_path: Optional[str] = None
    media_item_id: Optional[str] = None
    valid_image_count: int = 0
    active: bool = True


class CharacterLoraFile(BaseModel):
    id: str
    filename: str
    filepath: str
    size_bytes: int
    created_at: datetime
    primary: bool = False


class CharacterUpdate(BaseModel):
    name: Optional[str] = None
    profile: Optional[CharacterProfile] = None
    caption_mode: Optional[CaptionMode] = None
    captions: dict[str, str] = Field(default_factory=dict)
    active: Optional[bool] = None
