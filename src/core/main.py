"""
CinematicAI Studio — FastAPI Backend Entry Point
Avviare con: uvicorn src.core.main:app --port 8765 --reload
"""

import asyncio
import io
import logging
import sys
import warnings
from contextlib import asynccontextmanager

# Paramiko/cryptography deprecation noise (transitive, e.g. demucs/torch on conda)
warnings.filterwarnings("ignore", category=DeprecationWarning, module=r"paramiko.*")
try:
    from cryptography.utils import CryptographyDeprecationWarning

    warnings.filterwarnings("ignore", category=CryptographyDeprecationWarning)
except ImportError:
    pass

# Force UTF-8 stdout/stderr on Windows to avoid charmap errors with LLM output
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

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
from src.core.api.tools_routes import router as tools_router
from src.core.api.director_routes import router as director_router
from src.core.api.trailer_routes import router as trailer_router
from src.core.api.reel_routes import router as reel_router
from src.core.api.obsidian_routes import router as obsidian_router
from src.core.api.admin_routes import router as admin_router
from src.core.api.nav_routes import router as nav_router
from src.core.api.dashboard_routes import router as dashboard_router

log = structlog.get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup e shutdown dell'applicazione."""
    config = get_config()
    log.info("cinematic_studio_starting", version=config.app.version, port=config.app.backend_port)
    await init_db()
    await migrate_db()
    await migrate_media_db()
    from src.core.llm.model_registry import refresh_blacklist_cache
    await refresh_blacklist_cache()
    from src.core.comfyui.workflow_builder import sync_workflows_from_base
    n = sync_workflows_from_base()
    if n:
        log.info("workflows_synced_from_base", count=n)
    log.info("database_ready")
    obs_cfg = config.obsidian
    if obs_cfg.enabled:
        from src.core.obsidian.vault_manager import get_vault_manager
        mgr = get_vault_manager()
        log.info("obsidian_vault_ready", path=str(mgr.vault_path))
        if obs_cfg.start_docker_on_app_boot:
            from src.core.obsidian.docker_service import docker_available, start_container

            async def _boot_obsidian_docker() -> None:
                await asyncio.to_thread(start_container)

            if docker_available():
                asyncio.create_task(_boot_obsidian_docker())
            else:
                log.warning("obsidian_docker_skip", reason="docker CLI not in PATH")
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
    allow_origins=["*"],  # Electron + Vite dev (5300/5173)
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

app.include_router(project_router,  prefix="/api/projects",  tags=["projects"])
app.include_router(llm_router,      prefix="/api/llm",       tags=["llm"])
app.include_router(comfyui_router,  prefix="/api/comfyui",   tags=["comfyui"])
app.include_router(pipeline_router, prefix="/api/pipeline",  tags=["pipeline"])
app.include_router(media_router,    prefix="/api/media",     tags=["media"])
app.include_router(services_router, prefix="/api/services",  tags=["services"])
app.include_router(queue_router,    prefix="/api/queue",     tags=["queue"])
app.include_router(workflow_router, prefix="/api/workflows", tags=["workflows"])
app.include_router(tools_router,    prefix="/api/tools",     tags=["tools"])
app.include_router(director_router, prefix="/api/director",  tags=["director"])
app.include_router(trailer_router,  prefix="/api/trailer",   tags=["trailer"])
app.include_router(reel_router,     prefix="/api/reel",      tags=["reel"])
app.include_router(obsidian_router, prefix="/api/obsidian",  tags=["obsidian"])
app.include_router(admin_router,    tags=["admin"])
app.include_router(nav_router,      prefix="/api/nav",      tags=["nav"])
app.include_router(dashboard_router, prefix="/api/dashboard", tags=["dashboard"])


@app.get("/health")
async def health():
    return {"status": "ok", "service": "cinematic-ai-studio"}
