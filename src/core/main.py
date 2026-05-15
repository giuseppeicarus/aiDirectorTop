"""
CinematicAI Studio — FastAPI Backend Entry Point
Avviare con: uvicorn src.core.main:app --port 8765 --reload
"""

import asyncio
import logging
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.core.config import get_config
from src.core.database import init_db, migrate_db, migrate_media_db
from src.core.api.project_routes import router as project_router
from src.core.api.llm_routes import router as llm_router
from src.core.api.comfyui_routes import router as comfyui_router
from src.core.api.pipeline_routes import router as pipeline_router
from src.core.api.media_routes import router as media_router
from src.core.api.services_routes import router as services_router
from src.core.api.queue_routes import router as queue_router
from src.core.api.workflow_routes import router as workflow_router

log = structlog.get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup e shutdown dell'applicazione."""
    config = get_config()
    log.info("cinematic_studio_starting", version=config.app.version, port=config.app.backend_port)
    await init_db()
    await migrate_db()
    await migrate_media_db()
    log.info("database_ready")
    yield
    log.info("cinematic_studio_shutdown")


app = FastAPI(
    title="CinematicAI Studio",
    description="Backend API per la generazione automatica di video cinematografici",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Electron locale
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(project_router,  prefix="/api/projects",  tags=["projects"])
app.include_router(llm_router,      prefix="/api/llm",       tags=["llm"])
app.include_router(comfyui_router,  prefix="/api/comfyui",   tags=["comfyui"])
app.include_router(pipeline_router, prefix="/api/pipeline",  tags=["pipeline"])
app.include_router(media_router,    prefix="/api/media",     tags=["media"])
app.include_router(services_router, prefix="/api/services",  tags=["services"])
app.include_router(queue_router,    prefix="/api/queue",     tags=["queue"])
app.include_router(workflow_router, prefix="/api/workflows", tags=["workflows"])


@app.get("/health")
async def health():
    return {"status": "ok", "service": "cinematic-ai-studio"}
