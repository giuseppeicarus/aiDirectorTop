"""Tests per priorità nodi ComfyUI (primary / fallback)."""

from src.core.utils.comfyui_nodes import normalize_nodes_primary


def test_normalize_assigns_first_when_no_primary():
    nodes = [
        {"name": "A", "enabled": True, "primary": False},
        {"name": "B", "enabled": True, "primary": False},
    ]
    out = normalize_nodes_primary(nodes)
    assert out[0]["primary"] is True
    assert out[1]["primary"] is False


def test_normalize_single_primary_on_prefer_index():
    nodes = [
        {"name": "A", "enabled": True, "primary": True},
        {"name": "B", "enabled": True, "primary": False},
    ]
    out = normalize_nodes_primary(
        [{"name": "A", "enabled": True, "primary": False},
         {"name": "B", "enabled": True, "primary": True}],
        prefer_index=1,
    )
    assert out[0]["primary"] is False
    assert out[1]["primary"] is True


def test_normalize_clears_duplicate_primaries():
    nodes = [
        {"name": "A", "enabled": True, "primary": True},
        {"name": "B", "enabled": True, "primary": True},
    ]
    out = normalize_nodes_primary(nodes)
    assert sum(1 for n in out if n["primary"]) == 1
