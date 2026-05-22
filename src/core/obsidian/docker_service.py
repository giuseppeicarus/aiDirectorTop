"""
Gestione container Obsidian (LinuxServer) via Docker Compose.
GUI via browser: https://localhost:3001 (noVNC).
Vault montato in /vault — aprire quella cartella in Obsidian al primo avvio.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Optional

import structlog

from src.core.config import get_config

log = structlog.get_logger()


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _compose_file() -> Path:
    cfg = get_config().obsidian
    custom = Path(cfg.compose_file).expanduser()
    if custom.is_file():
        return custom.resolve()
    return _repo_root() / "docker" / "obsidian" / "docker-compose.yml"


def _vault_host_path() -> Path:
    cfg = get_config().obsidian
    vault = Path(cfg.vault_dir).expanduser()
    if not vault.is_absolute():
        vault = get_config().app.data_path / vault
    vault.mkdir(parents=True, exist_ok=True)
    return vault.resolve()


def docker_available() -> bool:
    return shutil.which("docker") is not None


def _run_compose(args: list[str], timeout: int = 120) -> tuple[int, str]:
    compose = _compose_file()
    if not compose.is_file():
        return 1, f"Compose file missing: {compose}"
    vault = _vault_host_path()
    env = {
        **os.environ,
        "CINEMATIC_OBSIDIAN_VAULT": str(vault),
        "OBSIDIAN_WEB_PORT": str(get_config().obsidian.web_port),
        "OBSIDIAN_WEB_HTTPS_PORT": str(get_config().obsidian.web_https_port),
    }
    cmd = ["docker", "compose", "-f", str(compose), *args]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
            cwd=str(compose.parent),
        )
        out = (proc.stdout or "") + (proc.stderr or "")
        return proc.returncode, out.strip()
    except subprocess.TimeoutExpired:
        return 1, "docker compose timeout"
    except FileNotFoundError:
        return 1, "docker CLI not found"
    except Exception as exc:
        return 1, str(exc)


def container_status() -> dict[str, Any]:
    cfg = get_config().obsidian
    if not docker_available():
        return {
            "docker_ok": False,
            "running": False,
            "error": "Docker non trovato nel PATH",
            "web_url": None,
            "vault_path": str(_vault_host_path()),
        }
    code, out = _run_compose(["ps", "--format", "json"], timeout=30)
    running = "running" in out.lower() if code == 0 else False
    return {
        "docker_ok": True,
        "running": running,
        "compose_output": out[:500] if out else "",
        "web_url": f"https://127.0.0.1:{cfg.web_https_port}/",
        "web_url_http": f"http://127.0.0.1:{cfg.web_port}/",
        "vault_path": str(_vault_host_path()),
        "compose_file": str(_compose_file()),
        "note": "In Obsidian (container): Apri vault come cartella → /vault",
    }


def start_container() -> dict[str, Any]:
    if not docker_available():
        return {"ok": False, "error": "Installa Docker Desktop e abilita WSL2/backend Linux"}
    code, out = _run_compose(["up", "-d"], timeout=180)
    st = container_status()
    return {"ok": code == 0, "output": out[-800:], **st}


def stop_container() -> dict[str, Any]:
    if not docker_available():
        return {"ok": False, "error": "Docker non disponibile"}
    code, out = _run_compose(["down"], timeout=90)
    return {"ok": code == 0, "output": out[-500:]}
