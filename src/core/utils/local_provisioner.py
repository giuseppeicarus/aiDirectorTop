"""
Local Provisioner — scarica modelli ComfyUI direttamente sul filesystem locale.
Usa httpx per streaming con progress tracking senza dipendenze esterne.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import AsyncGenerator, Optional

import structlog

log = structlog.get_logger("local.provisioner")

# Path comuni per ComfyUI su Windows e Linux
_COMMON_PATHS = [
    # Windows
    r"C:\ComfyUI",
    r"C:\Users\{user}\ComfyUI",
    r"D:\ComfyUI",
    r"C:\AI\ComfyUI",
    r"C:\stable-diffusion-webui\ComfyUI",
    # Linux / WSL / Docker
    "/workspace/ComfyUI",
    "/root/ComfyUI",
    "/home/user/ComfyUI",
    "/opt/ComfyUI",
    "/ComfyUI",
]


def find_local_comfyui() -> Optional[str]:
    """Cerca l'installazione ComfyUI locale. Ritorna il path o None."""
    import os

    candidates = list(_COMMON_PATHS)
    # Sostituisce {user} con l'utente corrente
    username = os.environ.get("USERNAME") or os.environ.get("USER") or "user"
    candidates = [p.replace("{user}", username) for p in candidates]

    for p in candidates:
        path = Path(p)
        if (path / "main.py").exists() or (path / "comfy").is_dir():
            return str(path)

    # Cerca anche nella directory corrente e nei parenti
    cwd = Path.cwd()
    for up in [cwd, cwd.parent, cwd.parent.parent]:
        for name in ["ComfyUI", "comfyui"]:
            candidate = up / name
            if (candidate / "main.py").exists():
                return str(candidate)

    return None


def _hf_headers(url: str) -> dict[str, str]:
    """Aggiunge Authorization HuggingFace se il token è configurato e l'URL è HF."""
    if "huggingface.co" not in url:
        return {}
    try:
        from src.core.config import get_config
        token = get_config().app.hf_token
        if token:
            return {"Authorization": f"Bearer {token}"}
    except Exception:
        pass
    return {}


async def download_model(
    url: str,
    dest_path: Path,
    on_progress: Optional[callable] = None,
    timeout: float = 3600.0,
) -> dict:
    """
    Scarica un file con httpx streaming.
    on_progress(downloaded_bytes, total_bytes) chiamato ogni chunk.
    Ritorna {ok, size_bytes, elapsed_sec, error}.
    """
    try:
        import httpx
    except ImportError:
        return {"ok": False, "error": "httpx non installato — pip install httpx"}

    dest_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = dest_path.with_suffix(dest_path.suffix + ".tmp")
    t0 = time.monotonic()

    try:
        headers = _hf_headers(url)
        async with httpx.AsyncClient(
            follow_redirects=True,
            timeout=httpx.Timeout(connect=30, read=timeout, write=timeout, pool=timeout),
        ) as client:
            async with client.stream("GET", url, headers=headers) as resp:
                resp.raise_for_status()
                total = int(resp.headers.get("content-length", 0))
                downloaded = 0
                with open(tmp_path, "wb") as f:
                    async for chunk in resp.aiter_bytes(chunk_size=1024 * 256):
                        f.write(chunk)
                        downloaded += len(chunk)
                        if on_progress:
                            try:
                                on_progress(downloaded, total)
                            except Exception:
                                pass

        tmp_path.rename(dest_path)
        elapsed = round(time.monotonic() - t0, 1)
        return {"ok": True, "size_bytes": downloaded, "elapsed_sec": elapsed, "error": None}

    except Exception as exc:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)
        return {"ok": False, "error": str(exc), "elapsed_sec": round(time.monotonic() - t0, 1)}


async def run_local_provision(
    comfyui_path: str,
    models: list[dict],
) -> AsyncGenerator[dict, None]:
    """
    Async generator: scarica ogni modello e streamma eventi progresso.
    Formato eventi: {type, text, filename, pct, downloaded_mb, total_mb, elapsed_sec, tag}
    """
    base = Path(comfyui_path)
    if not base.exists():
        yield {
            "type": "error",
            "text": f"Path ComfyUI non trovato: {comfyui_path}",
            "filename": None, "pct": 0.0, "elapsed_sec": 0.0, "tag": "ERROR",
        }
        return

    total = len(models)
    done = 0
    t_global = time.monotonic()

    yield {
        "type": "system",
        "text": f"=== Local Provisioning START — {total} modelli ===",
        "filename": None, "pct": 0.0, "elapsed_sec": 0.0, "tag": "INFO",
    }

    for model in models:
        filename = model["filename"]
        target_dir = model.get("target_dir", "models/checkpoints")
        url = model.get("url") or ""
        name = model.get("name", filename)
        dest = base / target_dir / filename

        elapsed = round(time.monotonic() - t_global, 1)

        # Già presente
        if dest.exists() and dest.stat().st_size > 1024:
            done += 1
            yield {
                "type": "skip",
                "text": f"[SKIP] {filename} — già presente",
                "filename": filename, "name": name,
                "pct": round(done / total, 3),
                "elapsed_sec": elapsed, "tag": "SKIP",
            }
            continue

        # URL mancante
        if not url:
            done += 1
            yield {
                "type": "line",
                "text": f"[SKIP] {filename} — URL non configurato nel catalog",
                "filename": filename, "name": name,
                "pct": round(done / total, 3),
                "elapsed_sec": elapsed, "tag": "SKIP",
            }
            continue

        yield {
            "type": "downloading",
            "text": f"[DOWNLOAD] {name}",
            "filename": filename, "name": name,
            "pct": round(done / total, 3),
            "elapsed_sec": elapsed, "tag": "DOWNLOAD",
        }

        # Progress callback — usa una queue per passare i dati all'async generator
        progress_queue: asyncio.Queue = asyncio.Queue()

        def _on_progress(dl: int, tot: int) -> None:
            progress_queue.put_nowait((dl, tot))

        # Avvia download
        dl_task = asyncio.create_task(
            download_model(url, dest, on_progress=_on_progress)
        )

        # Streamma progress ogni 0.5s mentre il download è attivo
        last_dl = 0
        last_tot = 0
        while not dl_task.done():
            await asyncio.sleep(0.5)
            # Svuota la queue prendendo l'ultimo valore
            while not progress_queue.empty():
                last_dl, last_tot = await progress_queue.get()
            if last_tot > 0:
                dl_mb = round(last_dl / 1024 / 1024, 1)
                tot_mb = round(last_tot / 1024 / 1024, 1)
                speed = ""
                elapsed_now = round(time.monotonic() - t_global, 1)
                yield {
                    "type": "progress",
                    "text": f"  {dl_mb} / {tot_mb} MB",
                    "filename": filename, "name": name,
                    "downloaded_mb": dl_mb, "total_mb": tot_mb,
                    "pct": round((done + last_dl / max(last_tot, 1)) / total, 3),
                    "elapsed_sec": elapsed_now, "tag": "PROGRESS",
                }

        result = await dl_task
        done += 1
        elapsed = round(time.monotonic() - t_global, 1)

        if result["ok"]:
            size_mb = round(result["size_bytes"] / 1024 / 1024, 1)
            yield {
                "type": "line",
                "text": f"[DONE] {filename} — {size_mb} MB in {result['elapsed_sec']}s",
                "filename": filename, "name": name,
                "pct": round(done / total, 3),
                "elapsed_sec": elapsed, "tag": "DONE",
            }
        else:
            yield {
                "type": "line",
                "text": f"[ERROR] {filename} — {result['error']}",
                "filename": filename, "name": name,
                "pct": round(done / total, 3),
                "elapsed_sec": elapsed, "tag": "ERROR",
            }

    elapsed = round(time.monotonic() - t_global, 1)
    yield {
        "type": "complete",
        "text": f"=== Local Provisioning COMPLETE — {elapsed}s ===",
        "filename": None, "pct": 1.0, "elapsed_sec": elapsed, "tag": "DONE",
    }
