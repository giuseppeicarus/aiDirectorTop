"""Download e validazione output ComfyUI su disco locale."""

from __future__ import annotations

import re
import structlog
from pathlib import Path

_log = structlog.get_logger("comfyui.outputs")

# Placeholder FFmpeg (gradiente) ~800–900 byte; immagini ComfyUI reali sono molto più grandi
COMFY_REAL_IMAGE_MIN_BYTES = 5000
# Storyboard 320px: tipicamente 8–90 KB; sotto ~3 KB è quasi sempre placeholder/error
STORYBOARD_IMAGE_MIN_BYTES = 3000

# Magic bytes minimi per rifiutare risposte HTML/JSON dei proxy
_IMAGE_MAGICS = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"RIFF", "image/webp"),  # WebP: RIFF....WEBP
)
_VIDEO_MAGICS = (
    (b"\x00\x00\x00", "video/mp4"),  # ftyp at offset 4 — controllo debole sotto
    (b"ftyp", "video/mp4"),
)


def _looks_like_html_or_json(data: bytes) -> bool:
    if len(data) < 8:
        return True
    head = data[:256].lstrip()
    if head.startswith(b"<") or head.startswith(b"{"):
        return True
    return False


def validate_downloaded_bytes(data: bytes, *, expect: str = "image") -> None:
    """Solleva ValueError se il body non sembra un file media valido."""
    if not data or len(data) < 200:
        raise ValueError(
            f"Download ComfyUI vuoto o troppo piccolo ({len(data)} bytes). "
            "Verifica auth Bearer / nodo corretto."
        )
    if _looks_like_html_or_json(data):
        preview = data[:120].decode("utf-8", errors="replace")
        raise ValueError(
            f"Download ComfyUI non è un file media (risposta proxy/HTML?): {preview!r}"
        )

    if expect == "image":
        if any(data.startswith(m) for m, _ in _IMAGE_MAGICS):
            return
        if len(data) > 12 and data[8:12] == b"WEBP":
            return
        raise ValueError(
            "File scaricato non riconosciuto come immagine PNG/JPEG/WebP."
        )

    if expect == "video":
        # MP4/MOV: ftyp box typically at byte 4 or near start
        if b"ftyp" in data[:32]:
            return
        # MP4 starting with 00 00 00 XX ftyp
        if len(data) > 8 and data[4:8] == b"ftyp":
            return
        # WebM/MKV magic
        if data[:4] == b"\x1a\x45\xdf\xa3":
            return
        # RIFF WebM
        if data.startswith(b"RIFF") and b"WEBM" in data[:16]:
            return
        # MPEG-TS / partial MP4 without ftyp — accept if large enough and not HTML
        if not _looks_like_html_or_json(data) and len(data) > 50_000:
            return
        raise ValueError(
            f"File scaricato non riconosciuto come video ({len(data)} bytes, "
            f"header: {data[:16].hex()!r})"
        )


def ensure_parent_dir(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


async def download_comfyui_file(
    client,
    file_info: dict,
    dest: Path,
    *,
    expect: str = "image",
    min_image_bytes: int | None = COMFY_REAL_IMAGE_MIN_BYTES,
    download_retries: int = 3,
) -> Path:
    """Scarica un output ComfyUI, valida e scrive su disco."""
    import asyncio

    import httpx

    from src.core.comfyui.client import ComfyUIClient

    if not isinstance(client, ComfyUIClient):
        raise TypeError("client deve essere ComfyUIClient")

    filename = file_info.get("filename")
    if not filename:
        raise ValueError("Output ComfyUI senza filename")

    ensure_parent_dir(dest)
    last_err: Exception | None = None
    for attempt in range(max(1, download_retries)):
        try:
            await client.download_output(
                filename,
                dest,
                subfolder=file_info.get("subfolder") or "",
                ftype=file_info.get("type") or "output",
            )
            if not dest.exists():
                raise ValueError(f"File non scritto su disco: {dest}")
            size = dest.stat().st_size
            if size == 0:
                raise ValueError(f"File vuoto su disco dopo download: {dest}")
            if expect == "image" and min_image_bytes is not None and size < min_image_bytes:
                raise ValueError(
                    f"Immagine ComfyUI troppo piccola ({size} bytes) — "
                    "probabile placeholder o download incompleto."
                )
            _log.info("download_ok", filename=filename, dest=str(dest), size=size, attempt=attempt)
            return dest
        except httpx.HTTPStatusError as exc:
            last_err = exc
            if exc.response.status_code == 404:
                _log.debug(
                    "download_not_found",
                    filename=filename,
                    subfolder=file_info.get("subfolder"),
                    ftype=file_info.get("type"),
                )
                raise exc
            _log.warning(
                "download_attempt_failed",
                filename=filename,
                dest=str(dest),
                attempt=attempt,
                error=str(exc),
            )
            if dest.exists():
                try:
                    dest.unlink()
                except OSError:
                    pass
            if attempt < download_retries - 1:
                await asyncio.sleep(1.5 * (attempt + 1))
        except Exception as exc:
            last_err = exc
            _log.warning(
                "download_attempt_failed",
                filename=filename,
                dest=str(dest),
                attempt=attempt,
                error=str(exc),
            )
            if dest.exists():
                try:
                    dest.unlink()
                except OSError:
                    pass
            if attempt < download_retries - 1:
                await asyncio.sleep(1.5 * (attempt + 1))
    if last_err:
        raise last_err
    raise RuntimeError("download_comfyui_file failed without exception")


def find_local_image_by_prefix(
    folders: list[Path],
    prefix: str,
    *,
    min_bytes: int = STORYBOARD_IMAGE_MIN_BYTES,
) -> Path | None:
    """Cerca PNG/JPEG su disco il cui stem coincide con il filename_prefix ComfyUI."""
    if not prefix:
        return None
    image_ext = {".png", ".jpg", ".jpeg", ".webp"}
    matches: list[Path] = []
    for folder in folders:
        if not folder.is_dir():
            continue
        for p in folder.iterdir():
            if not p.is_file() or p.suffix.lower() not in image_ext:
                continue
            stem = p.stem
            if stem != prefix and not stem.startswith(f"{prefix}_"):
                continue
            if is_real_comfy_image(p, min_bytes=min_bytes):
                matches.append(p)
    return pick_largest_real_image(matches, min_bytes=min_bytes)


async def history_image_outputs_for_prefix(client, prefix: str, *, limit: int = 40) -> list[dict]:
    """
    Elenca output immagine in /history il cui filename inizia con prefix
    (subfolder/type corretti per /view).
    """
    from src.core.comfyui.workflow_builder import extract_output_files

    if not prefix:
        return []

    try:
        prompt_ids = await client._history_prompt_ids()
    except Exception:
        return []

    ordered = list(prompt_ids)[-limit:]
    out: list[dict] = []
    seen: set[str] = set()
    for pid in reversed(ordered):
        try:
            hist = await client.get_history(pid)
        except Exception:
            continue
        for entry in extract_output_files(hist):
            name = entry.get("filename") or ""
            if not name.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
                continue
            stem = Path(name).stem
            if stem != prefix and not stem.startswith(f"{prefix}_"):
                continue
            key = f"{name}|{entry.get('subfolder')}|{entry.get('type')}"
            if key in seen:
                continue
            seen.add(key)
            out.append(entry)
    return out


def _image_output_rank(entry: dict, index: int) -> tuple:
    """Ordina candidati: preferisci output finali, poi indice workflow."""
    name = (entry.get("filename") or "").lower()
    s = index
    for bad in ("preview", "thumb", "temp", "latent", "mask", "depth"):
        if bad in name:
            s -= 80
    for good in (".png", ".jpg", "proge", "z-image", "clip_", "frame", "output", "_sb"):
        if good in name:
            s += 8
    if entry.get("type") == "output":
        s += 5
    return (s, index)


async def download_best_comfyui_image(
    client,
    files: list[dict],
    dest: Path,
    *,
    min_image_bytes: int = STORYBOARD_IMAGE_MIN_BYTES,
) -> Path:
    """
    Prova a scaricare ogni output immagine dalla history (migliori prima).
    Utile quando pick_best_image_output punta a un file non ancora disponibile sul proxy.
    """
    if not files:
        raise ValueError("Nessun output immagine in history ComfyUI")

    ordered = sorted(enumerate(files), key=lambda pair: _image_output_rank(pair[1], pair[0]), reverse=True)
    errors: list[str] = []
    for _, entry in ordered:
        name = entry.get("filename") or ""
        if not name.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
            continue
        target = dest.parent / Path(name).name
        try:
            return await download_comfyui_file(
                client,
                entry,
                target,
                expect="image",
                min_image_bytes=min_image_bytes,
                download_retries=4,
            )
        except Exception as exc:
            errors.append(f"{name}: {exc}")
            if target.exists():
                try:
                    target.unlink()
                except OSError:
                    pass
    raise RuntimeError(
        f"Impossibile scaricare immagine ComfyUI su {dest} "
        f"({len(errors)} tentativi): {'; '.join(errors[:4])}"
    )


async def download_image_by_prefix_probe(
    client,
    prefix: str,
    dest: Path,
    *,
    min_image_bytes: int = STORYBOARD_IMAGE_MIN_BYTES,
    max_index: int = 32,
    local_folders: list[Path] | None = None,
) -> Path:
    """
    Recupera immagine ComfyUI: disco locale → history (/view con path esatto) → probe minimo.
    """
    if not prefix:
        raise ValueError("prefix vuoto per probe ComfyUI")

    folders = local_folders or [dest.parent]
    local_hit = find_local_image_by_prefix(folders, prefix, min_bytes=min_image_bytes)
    if local_hit:
        import shutil

        ensure_parent_dir(dest)
        if local_hit.resolve() != dest.resolve():
            shutil.copy2(local_hit, dest)
        elif not dest.exists():
            shutil.copy2(local_hit, dest)
        _log.info("download_local_prefix_hit", prefix=prefix, path=str(local_hit))
        return dest

    history_files = await history_image_outputs_for_prefix(client, prefix)
    if history_files:
        try:
            return await download_best_comfyui_image(
                client,
                history_files,
                dest,
                min_image_bytes=min_image_bytes,
            )
        except Exception as hist_err:
            _log.debug("history_prefix_download_failed", prefix=prefix, error=str(hist_err))

    seen_names: set[str] = set()
    candidates: list[str] = []

    def _add(name: str) -> None:
        if name not in seen_names:
            seen_names.add(name)
            candidates.append(name)

    _add(f"{prefix}.png")
    for i in range(max_index, 0, -1):
        _add(f"{prefix}_{i:05d}_.png")

    view_triples = (
        ("", "output"),
        ("output", "output"),
        ("", "temp"),
        ("output", "temp"),
    )
    errors: list[str] = []
    for filename in candidates:
        for subfolder, ftype in view_triples:
            target = dest.parent / Path(filename).name
            try:
                return await download_comfyui_file(
                    client,
                    {"filename": filename, "subfolder": subfolder, "type": ftype},
                    target,
                    expect="image",
                    min_image_bytes=min_image_bytes,
                    download_retries=1,
                )
            except Exception as exc:
                err_s = str(exc)
                if "404" not in err_s and "Not Found" not in err_s:
                    errors.append(f"{filename}@{subfolder}/{ftype}: {exc}")
                if target.exists():
                    try:
                        target.unlink()
                    except OSError:
                        pass

    raise RuntimeError(
        f"Nessun file ComfyUI trovato con prefisso {prefix!r} "
        f"(history={len(history_files)}, probe={len(errors)} miss)"
    )


async def download_comfyui_image_resilient(
    client,
    history: dict,
    *,
    output_prefix: str,
    dest: Path,
    prompt_id: str = "",
    min_image_bytes: int = STORYBOARD_IMAGE_MIN_BYTES,
) -> Path:
    """
    Scarica output immagine: history → refresh → probe per prefisso filename_prefix.
    Esce subito se la history segnala errore (evita polling infinito su job falliti).
    """
    from src.core.comfyui.workflow_builder import extract_history_error, extract_output_files

    # Fail fast: se la history riporta già un errore, non probare download
    initial_err = extract_history_error(history)
    if initial_err:
        raise RuntimeError(f"ComfyUI job fallito (no download): {initial_err}")
    status = history.get("status") if isinstance(history.get("status"), dict) else {}
    if status.get("status_str") in ("error", "cancelled") and not extract_output_files(history):
        raise RuntimeError(
            f"ComfyUI job terminato senza output (status={status.get('status_str')})"
        )

    files = extract_output_files(history)
    if not files and prompt_id:
        history = await client.refresh_history_until_outputs(prompt_id, timeout=45.0)
        files = extract_output_files(history)

    if files:
        try:
            best = pick_best_image_output(files)
            target = dest.parent / (Path(best.get("filename") or dest.name).name)
            return await download_best_comfyui_image(
                client, files, target, min_image_bytes=min_image_bytes,
            )
        except Exception as hist_err:
            _log.warning(
                "history_download_failed_try_prefix",
                prefix=output_prefix,
                error=str(hist_err),
            )

    return await download_image_by_prefix_probe(
        client, output_prefix, dest, min_image_bytes=min_image_bytes,
    )


def pick_best_image_output(files: list[dict]) -> dict:
    """
    Sceglie l'output immagine finale (evita anteprime/latent spesso tinta blu/vuota).
    Con più nodi SaveImage, extract_output_files() restituisce anche preview non finali.
    """
    if not files:
        raise ValueError("Nessun output immagine in history ComfyUI")
    if len(files) == 1:
        return files[0]

    def score(entry: dict, index: int) -> tuple:
        name = (entry.get("filename") or "").lower()
        s = index  # a parità, preferisci output successivi nel workflow
        for bad in ("preview", "thumb", "temp", "latent", "mask", "depth"):
            if bad in name:
                s -= 80
        for good in (".png", ".jpg", "proge", "z-image", "clip_", "frame", "output"):
            if good in name:
                s += 8
        if entry.get("type") == "output":
            s += 5
        return (s, index)

    return max(enumerate(files), key=lambda pair: score(pair[1], pair[0]))[1]


_VIDEO_EXTS = {".mp4", ".webm", ".avi", ".mov", ".mkv"}
COMFY_REAL_VIDEO_MIN_BYTES = 50_000


def is_real_comfy_video(path: Path, *, min_bytes: int = COMFY_REAL_VIDEO_MIN_BYTES) -> bool:
    if not path or not path.is_file():
        return False
    try:
        size = path.stat().st_size
    except OSError:
        return False
    if size < min_bytes:
        return False
    if path.suffix.lower() not in _VIDEO_EXTS:
        return False
    try:
        head = path.read_bytes()[:64]
        validate_downloaded_bytes(head, expect="video")
        return True
    except ValueError:
        return size >= min_bytes


def find_local_video_by_prefix(
    folders: list[Path],
    prefix: str,
    *,
    min_bytes: int = COMFY_REAL_VIDEO_MIN_BYTES,
) -> Path | None:
    """Cerca MP4/WebM su disco il cui stem coincide con output_prefix ComfyUI (clip_id)."""
    if not prefix:
        return None
    matches: list[Path] = []
    for folder in folders:
        if not folder.is_dir():
            continue
        for p in folder.iterdir():
            if not p.is_file() or p.suffix.lower() not in _VIDEO_EXTS:
                continue
            stem = p.stem
            if stem != prefix and not stem.startswith(f"{prefix}_"):
                continue
            if is_real_comfy_video(p, min_bytes=min_bytes):
                matches.append(p)
    if not matches:
        return None
    matches.sort(key=lambda x: x.stat().st_size, reverse=True)
    return matches[0]


async def history_video_outputs_for_prefix(client, prefix: str, *, limit: int = 40) -> list[dict]:
    """Elenca output video in /history il cui filename inizia con prefix."""
    from src.core.comfyui.workflow_builder import extract_output_files

    if not prefix:
        return []

    try:
        prompt_ids = await client._history_prompt_ids()
    except Exception:
        return []

    ordered = list(prompt_ids)[-limit:]
    out: list[dict] = []
    seen: set[str] = set()
    for pid in reversed(ordered):
        try:
            hist = await client.get_history(pid)
        except Exception:
            continue
        for entry in extract_output_files(hist):
            name = entry.get("filename") or ""
            if Path(name).suffix.lower() not in _VIDEO_EXTS:
                continue
            stem = Path(name).stem
            if stem != prefix and not stem.startswith(f"{prefix}_"):
                continue
            key = f"{name}|{entry.get('subfolder')}|{entry.get('type')}"
            if key in seen:
                continue
            seen.add(key)
            out.append(entry)
    return out


async def download_best_comfyui_video(
    client,
    files: list[dict],
    dest: Path,
    *,
    min_video_bytes: int = COMFY_REAL_VIDEO_MIN_BYTES,
) -> Path:
    if not files:
        raise ValueError("Nessun output video in history ComfyUI")

    best = pick_best_video_output(files)
    ordered = [best] + [f for f in files if f is not best]
    errors: list[str] = []
    for entry in ordered:
        name = entry.get("filename") or ""
        if Path(name).suffix.lower() not in _VIDEO_EXTS:
            continue
        ext = Path(name).suffix or ".mp4"
        target = dest.with_suffix(ext)
        try:
            saved = await download_comfyui_file(
                client,
                entry,
                target,
                expect="video",
                min_image_bytes=None,
                download_retries=4,
            )
            if saved.exists() and saved.stat().st_size >= min_video_bytes:
                if saved.resolve() != dest.resolve():
                    if dest.exists():
                        dest.unlink()
                    saved.rename(dest)
                return dest if dest.exists() else saved
            raise ValueError(f"Video troppo piccolo dopo download: {saved}")
        except Exception as exc:
            errors.append(f"{name}: {exc}")
            if target.exists():
                try:
                    target.unlink()
                except OSError:
                    pass
    raise RuntimeError(
        f"Impossibile scaricare video ComfyUI su {dest} "
        f"({len(errors)} tentativi): {'; '.join(errors[:4])}"
    )


async def download_video_by_prefix_probe(
    client,
    prefix: str,
    dest: Path,
    *,
    min_video_bytes: int = COMFY_REAL_VIDEO_MIN_BYTES,
    local_folders: list[Path] | None = None,
) -> Path:
    """Recupera video ComfyUI: disco locale → history → download miglior candidato."""
    if not prefix:
        raise ValueError("prefix vuoto per probe video ComfyUI")

    folders = local_folders or [dest.parent]
    local_hit = find_local_video_by_prefix(folders, prefix, min_bytes=min_video_bytes)
    if local_hit:
        import shutil

        ensure_parent_dir(dest)
        if local_hit.resolve() != dest.resolve():
            shutil.copy2(local_hit, dest)
        elif not dest.exists():
            shutil.copy2(local_hit, dest)
        return dest

    history_files = await history_video_outputs_for_prefix(client, prefix)
    if history_files:
        try:
            return await download_best_comfyui_video(
                client,
                history_files,
                dest,
                min_video_bytes=min_video_bytes,
            )
        except Exception as hist_err:
            _log.debug("history_video_prefix_download_failed", prefix=prefix, error=str(hist_err))

    raise RuntimeError(
        f"Nessun video ComfyUI trovato con prefisso {prefix!r} "
        f"(history={len(history_files)})"
    )


def pick_best_video_output(files: list[dict]) -> dict:
    """Sceglie il miglior output video da history ComfyUI (evita thumbnail/preview)."""
    if not files:
        raise ValueError("Nessun output video in history ComfyUI")

    video_files = [
        f for f in files
        if Path(f.get("filename") or "").suffix.lower() in _VIDEO_EXTS
    ]
    if not video_files:
        return files[0]
    if len(video_files) == 1:
        return video_files[0]

    def score(entry: dict, index: int) -> tuple:
        name = (entry.get("filename") or "").lower()
        s = index
        for bad in ("preview", "thumb", "temp", "mask"):
            if bad in name:
                s -= 80
        for good in (".mp4", "clip_", "output", "video"):
            if good in name:
                s += 8
        if entry.get("type") == "output":
            s += 5
        return (s, index)

    return max(enumerate(video_files), key=lambda pair: score(pair[1], pair[0]))[1]


def is_ffmpeg_placeholder_image(path: Path) -> bool:
    """True se il file è un PNG/JPEG valido ma troppo piccolo per essere un frame ComfyUI."""
    if not path or not path.exists():
        return False
    try:
        size = path.stat().st_size
    except OSError:
        return False
    if size >= STORYBOARD_IMAGE_MIN_BYTES:
        return False
    try:
        validate_downloaded_bytes(path.read_bytes()[:512], expect="image")
        return True
    except ValueError:
        return False


def pick_largest_real_image(paths: list[Path], *, min_bytes: int = STORYBOARD_IMAGE_MIN_BYTES) -> Path | None:
    """Preferisce il file più grande che supera la soglia (evita placeholder FFmpeg)."""
    real = [p for p in paths if is_real_comfy_image(p, min_bytes=min_bytes)]
    if not real:
        return None
    real.sort(key=lambda p: p.stat().st_size, reverse=True)
    return real[0]


# ComfyUI SaveImage: filename_prefix + _00004_.png accanto a clip_XXX_sb.png canonico
_STORYBOARD_CANON_RE = re.compile(
    r"^(?P<base>clip_\d+_slot_\S+_sb)\.(png|jpe?g|webp)$",
    re.IGNORECASE,
)
_STORYBOARD_SIDECAR_RE = re.compile(
    r"^(?P<base>clip_\d+_slot_\S+_sb)_\d+_\.(png|jpe?g|webp)$",
    re.IGNORECASE,
)


def prune_storyboard_folder(folder: Path) -> list[str]:
    """
    Rimuove duplicati ComfyUI (es. clip_000_slot_001_sb_00004_.png) se esiste
    il file canonico clip_000_slot_001_sb.png nella stessa cartella.
    """
    if not folder.is_dir():
        return []
    canon_bases: set[str] = set()
    sidecars: list[tuple[str, Path]] = []
    for p in folder.iterdir():
        if not p.is_file():
            continue
        m_canon = _STORYBOARD_CANON_RE.match(p.name)
        if m_canon:
            canon_bases.add(m_canon.group("base"))
            continue
        m_side = _STORYBOARD_SIDECAR_RE.match(p.name)
        if m_side:
            sidecars.append((m_side.group("base"), p))
    removed: list[str] = []
    for base, path in sidecars:
        if base not in canon_bases:
            continue
        try:
            path.unlink()
            removed.append(path.name)
            _log.info("storyboard_sidecar_removed", file=path.name, canonical=f"{base}.png")
        except OSError as exc:
            _log.warning("storyboard_sidecar_remove_failed", file=path.name, error=str(exc))
    return removed


def prune_storyboard_sidecars_for_stem(folder: Path, stem: str) -> list[str]:
    """Elimina sidecar ComfyUI per un singolo stem (es. clip_000_slot_001_sb)."""
    if not folder.is_dir() or not stem:
        return []
    canon = folder / f"{stem}.png"
    if not canon.is_file():
        canon = next(
            (folder / f"{stem}.{ext}" for ext in ("png", "jpg", "jpeg", "webp") if (folder / f"{stem}.{ext}").is_file()),
            None,
        )
    if canon is None:
        return []
    removed: list[str] = []
    for p in folder.iterdir():
        if not p.is_file():
            continue
        m = _STORYBOARD_SIDECAR_RE.match(p.name)
        if m and m.group("base") == stem:
            try:
                p.unlink()
                removed.append(p.name)
            except OSError:
                pass
    return removed


def is_real_comfy_image(path: Path, *, min_bytes: int = COMFY_REAL_IMAGE_MIN_BYTES) -> bool:
    """True se il file esiste, supera la soglia dimensione e ha magic bytes immagine."""
    if not path or not path.exists():
        return False
    try:
        if path.stat().st_size < min_bytes:
            return False
        sample = path.read_bytes()[:512]
    except OSError:
        return False
    try:
        validate_downloaded_bytes(sample, expect="image")
        return True
    except ValueError:
        return False
