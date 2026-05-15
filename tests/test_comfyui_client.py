"""
Tests ComfyUI client — usa mock httpx/websockets per evitare connessioni reali.
Verifica: queue_prompt, upload_image, extract_output_files, workflow_builder.
"""

import json
import pytest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch, mock_open

from src.core.config import ComfyUINodeConfig
from src.core.comfyui.client import ComfyUIClient
from src.core.comfyui.workflow_builder import extract_output_files, _substitute


# ── Helpers ────────────────────────────────────────────────────────────────────

def _node(host="localhost", port=8188) -> ComfyUINodeConfig:
    return ComfyUINodeConfig(host=host, port=port, name="Test Node", enabled=True)


# ── Client ─────────────────────────────────────────────────────────────────────

async def test_queue_prompt_returns_id():
    mock_response = MagicMock()
    mock_response.json.return_value = {"prompt_id": "abc-123"}
    mock_response.raise_for_status = MagicMock()

    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.post = AsyncMock(return_value=mock_response)

    with patch("httpx.AsyncClient", return_value=mock_client):
        client = ComfyUIClient(_node())
        pid = await client.queue_prompt({"node1": {}})

    assert pid == "abc-123"


async def test_health_check_returns_stats():
    mock_response = MagicMock()
    mock_response.json.return_value = {"system": {"vram_total": 8192}}
    mock_response.raise_for_status = MagicMock()

    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.get = AsyncMock(return_value=mock_response)

    with patch("httpx.AsyncClient", return_value=mock_client):
        client = ComfyUIClient(_node())
        result = await client.health_check()

    assert "system" in result


async def test_is_alive_true():
    mock_response = MagicMock()
    mock_response.json.return_value = {}
    mock_response.raise_for_status = MagicMock()

    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.get = AsyncMock(return_value=mock_response)

    with patch("httpx.AsyncClient", return_value=mock_client):
        client = ComfyUIClient(_node())
        assert await client.is_alive() is True


async def test_is_alive_false_on_connection_error():
    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.get = AsyncMock(side_effect=ConnectionError("refused"))

    with patch("httpx.AsyncClient", return_value=mock_client):
        client = ComfyUIClient(_node())
        assert await client.is_alive() is False


async def test_get_queue_depth_empty():
    mock_response = MagicMock()
    mock_response.json.return_value = {"queue_running": [], "queue_pending": []}

    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.get = AsyncMock(return_value=mock_response)

    with patch("httpx.AsyncClient", return_value=mock_client):
        client = ComfyUIClient(_node())
        depth = await client.get_queue_depth()

    assert depth == 0


async def test_get_history_returns_output():
    pid = "test-prompt-id"
    mock_response = MagicMock()
    mock_response.json.return_value = {pid: {"outputs": {"7": {"images": [{"filename": "out.png"}]}}}}
    mock_response.raise_for_status = MagicMock()

    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.get = AsyncMock(return_value=mock_response)

    with patch("httpx.AsyncClient", return_value=mock_client):
        client = ComfyUIClient(_node())
        hist = await client.get_history(pid)

    assert "outputs" in hist


# ── Node base URLs ────────────────────────────────────────────────────────────

def test_node_base_url():
    node = _node("10.0.0.1", 8188)
    assert node.base_url == "http://10.0.0.1:8188"


def test_node_ws_url():
    node = _node("10.0.0.1", 8188)
    assert node.ws_url == "ws://10.0.0.1:8188/ws"


# ── Workflow builder ──────────────────────────────────────────────────────────

def test_substitute_string_var():
    result = _substitute('{"model": "{{MODEL}}"}', {"MODEL": "my_model.ckpt"})
    assert '"my_model.ckpt"' in result


def test_substitute_int_var():
    result = _substitute('{"steps": {{STEPS}}}', {"STEPS": 30})
    assert '"steps": 30' in result


def test_substitute_missing_var_stays():
    result = _substitute('{"x": "{{MISSING}}"}', {})
    assert "{{MISSING}}" in result


def test_extract_output_files_images():
    history = {
        "outputs": {
            "7": {"images": [{"filename": "out_00001_.png", "subfolder": "", "type": "output"}]}
        }
    }
    files = extract_output_files(history)
    assert len(files) == 1
    assert files[0]["filename"] == "out_00001_.png"


def test_extract_output_files_videos():
    history = {
        "outputs": {
            "10": {"videos": [{"filename": "clip_001.mp4", "subfolder": "videos", "type": "output"}]}
        }
    }
    files = extract_output_files(history)
    assert len(files) == 1
    assert files[0]["filename"] == "clip_001.mp4"


def test_extract_output_files_empty():
    assert extract_output_files({}) == []
    assert extract_output_files({"outputs": {}}) == []


def test_workflow_templates_exist():
    wf_dir = Path(__file__).parent.parent / "config" / "workflows"
    assert (wf_dir / "txt2img_base.json").exists()
    assert (wf_dir / "img2video_wan21.json").exists()


def test_workflow_templates_valid_after_substitution():
    """I template sono JSON valido dopo sostituzione variabili dummy."""
    from src.core.comfyui.workflow_builder import _substitute
    wf_dir = Path(__file__).parent.parent / "config" / "workflows"
    # Valori dummy per tutte le variabili usate nei template
    dummy = {
        "MODEL": "test.ckpt", "POSITIVE_PROMPT": "test", "NEGATIVE_PROMPT": "bad",
        "SEED": 42, "STEPS": 20, "CFG": 7.0, "WIDTH": 512, "HEIGHT": 512,
        "SAMPLER": "euler", "SCHEDULER": "normal", "OUTPUT_PREFIX": "test", "VAE": "",
        "VIDEO_MODEL": "wan.safetensors", "FIRST_FRAME": "frame_a.png",
        "LAST_FRAME": "frame_b.png", "MOTION_PROMPT": "camera push in",
        "DURATION_FRAMES": 24, "FPS": 24,
    }
    for f in wf_dir.glob("*.json"):
        if f.name.startswith("_"):
            continue
        raw = f.read_text(encoding="utf-8")
        substituted = _substitute(raw, dummy)
        try:
            data = json.loads(substituted)
            assert isinstance(data, dict)
        except json.JSONDecodeError as e:
            pytest.fail(f"{f.name} non è JSON valido dopo sostituzione: {e}")
