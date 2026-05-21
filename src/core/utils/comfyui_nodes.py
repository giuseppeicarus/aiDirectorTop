"""Helpers for ComfyUI node configuration (primary / fallback)."""

from __future__ import annotations

from typing import Optional


def normalize_nodes_primary(
    nodes: list[dict],
    *,
    prefer_index: Optional[int] = None,
) -> list[dict]:
    """
    Garantisce un solo nodo `primary=True` tra i nodi abilitati.
    Se nessuno è marcato, il primo abilitato diventa principale.
    Se prefer_index è impostato e primary=True, solo quell'indice resta principale.
    """
    if not nodes:
        return nodes

    out = [dict(n) for n in nodes]

    if prefer_index is not None and 0 <= prefer_index < len(out):
        if out[prefer_index].get("primary"):
            for i, n in enumerate(out):
                n["primary"] = i == prefer_index
            return out
        out[prefer_index]["primary"] = False

    primaries = [i for i, n in enumerate(out) if n.get("primary")]
    enabled = [i for i, n in enumerate(out) if n.get("enabled", True)]

    if len(primaries) > 1:
        keep = primaries[-1]
        for i, n in enumerate(out):
            n["primary"] = i == keep
        return out

    if len(primaries) == 1:
        return out

    if enabled:
        out[enabled[0]]["primary"] = True
    elif out:
        out[0]["primary"] = True

    return out
