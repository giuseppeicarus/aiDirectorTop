"""Parse and normalize ComfyUI node host/port from user input."""

from __future__ import annotations

from typing import Any, Literal, Optional
from urllib.parse import urlparse

ComfyAuthType = Literal["none", "token", "basic"]


def infer_auth_type(
    auth_type: Optional[str],
    *,
    token: Optional[str] = None,
    auth: Optional[str] = None,
) -> ComfyAuthType:
    """Backward compatibility for configs without auth_type."""
    if auth_type in ("none", "token", "basic"):
        return auth_type  # type: ignore[return-value]
    if (token or "").strip():
        return "token"
    if (auth or "").strip():
        return "basic"
    return "none"


def parse_comfyui_url(raw: str) -> dict[str, Any]:
    """
    Parse a pasted ComfyUI URL into host, port, and optional token (if present in query).
    Used only when the user explicitly applies a pasted URL in the UI.
    """
    text = (raw or "").strip()
    if not text:
        raise ValueError("URL vuota")

    if "://" not in text:
        text = f"http://{text}"

    parsed = urlparse(text)
    host = parsed.hostname
    if not host:
        raise ValueError("Host non valido nell'URL")

    port = parsed.port or 8188
    from urllib.parse import parse_qs

    token = (parse_qs(parsed.query).get("token") or [None])[0]

    return {"host": host, "port": port, "token": token}


def normalize_host_port(host: str, port: int) -> tuple[str, int]:
    """
    Fix host/port when a full URL or host:port was pasted into the host field.
    Does not read or set credentials — auth_type controls those separately.
    """
    h = (host or "").strip()
    p = int(port)

    if "://" in h or h.startswith("//"):
        parsed = urlparse(h if "://" in h else f"http://{h}")
        if parsed.hostname:
            h = parsed.hostname
        if parsed.port:
            p = parsed.port
    elif ":" in h:
        host_part, _, port_part = h.rpartition(":")
        if port_part.isdigit():
            h = host_part
            p = int(port_part)

    return h, p
