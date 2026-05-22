"""ORM — verifiche modelli LLM e blacklist per provider."""

import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel
from sqlalchemy import Boolean, DateTime, Float, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from src.core.database import Base


class LlmModelVerificationORM(Base):
    __tablename__ = "llm_model_verifications"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    provider: Mapped[str] = mapped_column(String(32), index=True)
    model_id: Mapped[str] = mapped_column(String(512), index=True)
    ok: Mapped[bool] = mapped_column(Boolean, default=False)
    message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    load_time_seconds: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    verified_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class LlmModelBlacklistORM(Base):
    __tablename__ = "llm_model_blacklist"
    __table_args__ = (UniqueConstraint("provider", "model_id", name="uq_llm_blacklist_provider_model"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    provider: Mapped[str] = mapped_column(String(32), index=True)
    model_id: Mapped[str] = mapped_column(String(512), index=True)
    reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    blacklisted_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class LlmVerificationSchema(BaseModel):
    id: str
    provider: str
    model_id: str
    ok: bool
    message: Optional[str] = None
    load_time_seconds: Optional[float] = None
    verified_at: datetime

    model_config = {"from_attributes": True}


class LlmBlacklistSchema(BaseModel):
    id: str
    provider: str
    model_id: str
    reason: Optional[str] = None
    blacklisted_at: datetime

    model_config = {"from_attributes": True}
