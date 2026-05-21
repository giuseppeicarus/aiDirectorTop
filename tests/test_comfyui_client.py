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
    mock_client.request = AsyncMock(return_value=mock_response)

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
    mock_client.request = AsyncMock(return_value=mock_response)

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
    mock_client.request = AsyncMock(return_value=mock_response)

    with patch("httpx.AsyncClient", return_value=mock_client):
        client = ComfyUIClient(_node())
        assert await client.is_alive() is True


async def test_is_alive_false_on_connection_error():
    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.request = AsyncMock(side_effect=ConnectionError("refused"))

    with patch("httpx.AsyncClient", return_value=mock_client):
        client = ComfyUIClient(_node())
        assert await client.is_alive() is False


async def test_get_queue_depth_empty():
    mock_response = MagicMock()
    mock_response.json.return_value = {"queue_running": [], "queue_pending": []}

    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.request = AsyncMock(return_value=mock_response)

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
    mock_client.request = AsyncMock(return_value=mock_response)

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


async def test_download_output_single_headers_kwarg():
    """Evita TypeError: got multiple values for keyword argument 'headers'."""
    node = ComfyUINodeConfig(
        host="62.0.0.1",
        port=58539,
        name="RunPod",
        auth_type="token",
        token="secret-token",
    )
    client = ComfyUIClient(node)
    client._session_ready = True

    mock_response = MagicMock()
    mock_response.content = b"\x89PNG\r\n"
    mock_response.status_code = 200
    mock_response.raise_for_status = MagicMock()

    mock_http = MagicMock()
    mock_http.request = AsyncMock(return_value=mock_response)
    mock_http.cookies = {}
    client._http = mock_http
    client._resolved_paths["view"] = "/view"

    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        dest = Path(tmp.name)

    await client.download_output("ComfyUI_00001_.png", dest)

    mock_http.request.assert_called_once()
    _, call_kwargs = mock_http.request.call_args
    assert "headers" in call_kwargs
    assert call_kwargs["headers"]["Authorization"] == "Bearer secret-token"
    assert call_kwargs["params"]["filename"] == "ComfyUI_00001_.png"
    dest.unlink(missing_ok=True)


def test_token_node_uses_bearer_not_query_params():
    """RunPod proxy: Bearer su API, non ?token= su POST."""
    node = ComfyUINodeConfig(
        host="62.0.0.1",
        port=58539,
        name="RunPod",
        auth_type="token",
        token="secret-token",
    )
    client = ComfyUIClient(node)
    extra = client._http_extra()
    assert extra["headers"]["Authorization"] == "Bearer secret-token"
    assert "params" not in extra
    assert "token=" not in client._ws_connect_url()


def test_node_token_query_params_only_with_auth_type():
    node = ComfyUINodeConfig(
        host="62.107.25.198",
        port=58539,
        auth_type="token",
        token="secret-token",
        name="Remote",
    )
    assert node.query_params() == {"token": "secret-token"}

    ignored = ComfyUINodeConfig(
        host="62.107.25.198",
        port=58539,
        auth_type="none",
        token="secret-token",
        name="Remote",
    )
    assert ignored.query_params() == {}
    assert ignored.token is None


def test_url_with_token_reinjects_on_redirect():
    node = ComfyUINodeConfig(
        host="62.107.25.198",
        port=58539,
        auth_type="token",
        token="secret",
        name="Remote",
    )
    client = ComfyUIClient(node)
    url = client._url_with_token("/system-stats")
    assert "token=secret" in url
    assert url.endswith("/system-stats?token=secret") or "system-stats?token=secret" in url


async def test_health_check_with_token_params():
    ok = MagicMock()
    ok.status_code = 200
    ok.json.return_value = {"devices": []}
    ok.raise_for_status = MagicMock()

    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.get = AsyncMock(return_value=ok)
    mock_client.request = AsyncMock(return_value=ok)

    node = ComfyUINodeConfig(
        host="62.107.25.198",
        port=58539,
        auth_type="token",
        token="abc",
        name="Remote",
    )
    with patch("httpx.AsyncClient", return_value=mock_client):
        client = ComfyUIClient(node)
        result = await client.health_check()

    assert result == {"devices": []}
    call = mock_client.request.call_args_list[-1]
    assert call.kwargs.get("params") == {"token": "abc"}


def test_normalize_host_from_pasted_url_without_credentials():
    node = ComfyUINodeConfig(
        host="http://62.107.25.198:58539/?token=abc123",
        port=8188,
        auth_type="none",
        name="Remote",
    )
    assert node.host == "62.107.25.198"
    assert node.port == 58539
    assert node.token is None


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
