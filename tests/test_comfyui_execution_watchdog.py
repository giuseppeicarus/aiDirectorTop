"""Test watchdog attività ComfyUI e stato coda/history."""

import pytest
from unittest.mock import AsyncMock, MagicMock

from src.core.comfyui.client import ComfyUIClient
from src.core.comfyui.execution_watchdog import ExecutionWatchdog, resolve_execution_timeouts
from src.core.config import ComfyUINodeConfig


def _node() -> ComfyUINodeConfig:
    return ComfyUINodeConfig(host="localhost", port=8188, name="Test")


def test_watchdog_extends_on_touch():
    w = ExecutionWatchdog(max_timeout_sec=3600, idle_timeout_sec=10)
    assert not w.idle_exceeded()
    w.touch("progress")
    assert w.idle_sec < 0.5


def test_watchdog_idle_exceeded_without_touch():
    w = ExecutionWatchdog(max_timeout_sec=3600, idle_timeout_sec=0)
    assert w.idle_exceeded()


def test_resolve_execution_timeouts_uses_config_defaults():
    max_sec, idle_sec = resolve_execution_timeouts()
    assert max_sec >= 3600
    assert idle_sec >= 30


async def test_get_prompt_run_state_running_in_queue():
    client = ComfyUIClient(_node())
    pid = "abc-123"

    mock_response = MagicMock()
    mock_response.json.return_value = {
        "queue_running": [[1, pid, {}]],
        "queue_pending": [],
    }
    mock_response.raise_for_status = MagicMock()

    mock_http = MagicMock()
    mock_http.request = AsyncMock(return_value=mock_response)
    mock_http.cookies = {}
    client._http = mock_http
    client._resolved_paths["queue"] = "/queue"
    client._resolved_paths["history"] = f"/history/{pid}"

    hist_resp = MagicMock()
    hist_resp.json.return_value = {pid: {}}
    hist_resp.raise_for_status = MagicMock()

    async def _request(method, key, default, **kwargs):
        if key == "history":
            return hist_resp
        return mock_response

    client._request = AsyncMock(side_effect=_request)

    active, state = await client.get_prompt_run_state(pid)
    assert active is True
    assert state == "running"


async def test_get_prompt_run_state_completed_with_outputs():
    client = ComfyUIClient(_node())
    pid = "done-1"

    hist_resp = MagicMock()
    hist_resp.json.return_value = {
        pid: {"outputs": {"7": {"images": [{"filename": "out.png"}]}}},
    }
    hist_resp.raise_for_status = MagicMock()

    client._request = AsyncMock(return_value=hist_resp)
    client._resolved_paths["history"] = f"/history/{pid}"

    active, state = await client.get_prompt_run_state(pid)
    assert active is False
    assert state == "completed"
