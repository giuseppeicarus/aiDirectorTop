from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.core.llm.model_probe import ensure_lmstudio_model_loaded


def _cfg(model: str = "llama-3.3-8b-instruct-128k"):
    return SimpleNamespace(
        model=model,
        base_url="http://localhost:1234/v1",
        api_key=None,
    )


@pytest.mark.asyncio
async def test_ensure_lmstudio_model_loaded_skips_loaded_model():
    catalog = [{
        "key": "llama-3.3-8b-instruct-128k",
        "loaded_instances": [{"id": "llama-3.3-8b-instruct-128k"}],
    }]
    client = MagicMock()
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)

    with (
        patch("httpx.AsyncClient", return_value=client),
        patch(
            "src.core.llm.model_probe._lmstudio_list_models",
            new=AsyncMock(return_value=catalog),
        ),
        patch(
            "src.core.llm.model_probe._lmstudio_load",
            new=AsyncMock(),
        ) as load,
    ):
        result = await ensure_lmstudio_model_loaded(_cfg())

    assert result["already_loaded"] is True
    load.assert_not_awaited()


@pytest.mark.asyncio
async def test_ensure_lmstudio_model_loaded_loads_installed_model():
    catalog = [{
        "key": "llama-3.3-8b-instruct-128k",
        "loaded_instances": [],
    }]
    client = MagicMock()
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)

    with (
        patch("httpx.AsyncClient", return_value=client),
        patch(
            "src.core.llm.model_probe._lmstudio_list_models",
            new=AsyncMock(return_value=catalog),
        ),
        patch(
            "src.core.llm.model_probe._lmstudio_load",
            new=AsyncMock(return_value={"instance_id": "instance-1"}),
        ) as load,
    ):
        result = await ensure_lmstudio_model_loaded(_cfg())

    assert result["loaded"] is True
    load.assert_awaited_once()


@pytest.mark.asyncio
async def test_ensure_lmstudio_model_loaded_rejects_missing_model():
    client = MagicMock()
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)

    with (
        patch("httpx.AsyncClient", return_value=client),
        patch(
            "src.core.llm.model_probe._lmstudio_list_models",
            new=AsyncMock(return_value=[{"key": "qwen/qwen3.5-9b"}]),
        ),
    ):
        with pytest.raises(RuntimeError, match="non installato"):
            await ensure_lmstudio_model_loaded(_cfg("missing/model"))
