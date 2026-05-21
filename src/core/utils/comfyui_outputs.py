"""Download e validazione output ComfyUI su disco locale."""

from __future__ import annotations

from pathlib import Path

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
        if b"ftyp" in data[:32] or data.startswith(b"\x00\x00\x00"):
            return
        if data.startswith(b"RIFF") and b"WEBM" in data[:16]:
            return
        # Alcuni mp4 iniziano diversamente — accetta se non è HTML
        if not _looks_like_html_or_json(data) and len(data) > 10_000:
            return
        raise ValueError("File scaricato non riconosciuto come video.")


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
            data = dest.read_bytes()
            validate_downloaded_bytes(data, expect=expect)
            if expect == "image" and min_image_bytes is not None and len(data) < min_image_bytes:
                raise ValueError(
                    f"Immagine ComfyUI troppo piccola ({len(data)} bytes) — "
                    "probabile placeholder o download incompleto."
                )
            return dest
        except Exception as exc:
            last_err = exc
            if attempt < download_retries - 1:
                await asyncio.sleep(1.5 * (attempt + 1))
    if last_err:
        raise last_err
    raise RuntimeError("download_comfyui_file failed without exception")


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
