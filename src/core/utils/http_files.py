"""MIME e FileResponse per file generati localmente (ComfyUI, pipeline, trailer)."""

from pathlib import Path

from fastapi.responses import FileResponse

_IMAGE_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
}

_VIDEO_MIME = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
}

_AUDIO_MIME = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
}


def guess_media_type(path: Path, default: str = "application/octet-stream") -> str:
    ext = path.suffix.lower()
    if ext in _IMAGE_MIME:
        return _IMAGE_MIME[ext]
    if ext in _VIDEO_MIME:
        return _VIDEO_MIME[ext]
    if ext in _AUDIO_MIME:
        return _AUDIO_MIME[ext]
    return default


def file_response(
    path: Path,
    *,
    download_name: str | None = None,
    inline: bool = False,
) -> FileResponse:
    """FileResponse con Content-Type corretto per browser/Electron."""
    media_type = guess_media_type(path)
    headers = {"Accept-Ranges": "bytes"}
    if media_type.startswith(("video/", "audio/")):
        headers["Cache-Control"] = "no-cache"

    if inline:
        return FileResponse(
            str(path),
            media_type=media_type,
            content_disposition_type="inline",
            headers=headers,
        )

    return FileResponse(
        str(path),
        media_type=media_type,
        filename=download_name or path.name,
        headers=headers,
    )
