"""
Tests adapter LLM — usa mock per evitare chiamate reali alle API.
Verifica: costruzione adapter, health_check, generate_json, factory routing.
"""

import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from src.core.config import LLMConfig
from src.core.llm.base import BaseLLMAdapter, StoryboardRequest
from src.core.llm.factory import get_llm_adapter
from src.core.llm.openai_adapter import OpenAIAdapter
from src.core.llm.anthropic_adapter import AnthropicAdapter
from src.core.llm.ollama_adapter import OllamaAdapter


# ── Config helpers ────────────────────────────────────────────────────────────

def _openai_cfg(**kw) -> LLMConfig:
    return LLMConfig(provider="openai", model="gpt-4o", api_key="sk-test", **kw)

def _anthropic_cfg(**kw) -> LLMConfig:
    return LLMConfig(provider="anthropic", model="claude-sonnet-4-6", api_key="test-key", **kw)

def _ollama_cfg(**kw) -> LLMConfig:
    return LLMConfig(provider="ollama", model="llama3", base_url="http://localhost:11434", **kw)


# ── Base class ────────────────────────────────────────────────────────────────

def test_base_is_abstract():
    required = {"generate_json", "generate_storyboard", "stream_storyboard", "health_check"}
    assert BaseLLMAdapter.__abstractmethods__ >= required


def test_storyboard_request_defaults():
    req = StoryboardRequest(user_prompt="A sunset over the ocean")
    assert req.genre == "cinematic"
    assert req.duration_sec == 60
    assert req.num_scenes == 3


# ── Factory routing ───────────────────────────────────────────────────────────

def test_factory_openai():
    mock_client = MagicMock()
    with patch("openai.AsyncOpenAI", return_value=mock_client):
        adapter = get_llm_adapter(_openai_cfg())
    assert isinstance(adapter, OpenAIAdapter)


def test_factory_anthropic():
    mock_client = MagicMock()
    with patch("anthropic.AsyncAnthropic", return_value=mock_client):
        adapter = get_llm_adapter(_anthropic_cfg())
    assert isinstance(adapter, AnthropicAdapter)


def test_factory_lmstudio_uses_openai():
    cfg = LLMConfig(provider="lmstudio", model="llama3", base_url="http://localhost:1234/v1")
    mock_client = MagicMock()
    with patch("openai.AsyncOpenAI", return_value=mock_client):
        adapter = get_llm_adapter(cfg)
    assert isinstance(adapter, OpenAIAdapter)


def test_factory_groq_uses_openai():
    cfg = LLMConfig(provider="groq", model="llama3-8b-8192", api_key="gsk_test")
    mock_client = MagicMock()
    with patch("openai.AsyncOpenAI", return_value=mock_client):
        adapter = get_llm_adapter(cfg)
    assert isinstance(adapter, OpenAIAdapter)


def test_factory_unknown_provider_raises():
    with pytest.raises(ValueError, match="non supportato"):
        get_llm_adapter(LLMConfig(provider="unknown_xyz", model="test"))


# ── OpenAI Adapter ────────────────────────────────────────────────────────────

async def test_openai_generate_json():
    mock_response = MagicMock()
    mock_response.choices[0].message.content = '{"title": "Test Film", "scenes": []}'
    mock_client = MagicMock()
    mock_client.chat.completions.create = AsyncMock(return_value=mock_response)

    with patch("openai.AsyncOpenAI", return_value=mock_client):
        adapter = OpenAIAdapter(_openai_cfg())
        result = await adapter.generate_json(
            system="You are a director.",
            user="Create a scene list as JSON.",
        )

    assert result["title"] == "Test Film"
    assert "scenes" in result


async def test_openai_health_check_ok():
    mock_client = MagicMock()
    mock_client.models.list = AsyncMock(return_value=MagicMock())
    with patch("openai.AsyncOpenAI", return_value=mock_client):
        adapter = OpenAIAdapter(_openai_cfg())
        ok = await adapter.health_check()
    assert ok is True


async def test_openai_health_check_fail():
    mock_client = MagicMock()
    mock_client.models.list = AsyncMock(side_effect=ConnectionError("refused"))
    with patch("openai.AsyncOpenAI", return_value=mock_client):
        adapter = OpenAIAdapter(_openai_cfg())
        ok = await adapter.health_check()
    assert ok is False


async def test_lmstudio_generate_json_ensures_model_is_loaded():
    mock_response = MagicMock()
    mock_response.choices[0].message.content = '{"ok": true}'
    mock_client = MagicMock()
    mock_client.chat.completions.create = AsyncMock(return_value=mock_response)
    cfg = LLMConfig(
        provider="lmstudio",
        model="llama-3.3-8b-instruct-128k",
        base_url="http://localhost:1234/v1",
    )

    with (
        patch("openai.AsyncOpenAI", return_value=mock_client),
        patch(
            "src.core.llm.model_probe.ensure_lmstudio_model_loaded",
            new=AsyncMock(return_value={"loaded": True}),
        ) as ensure,
    ):
        adapter = OpenAIAdapter(cfg)
        result = await adapter.generate_json("system", "user")

    assert result == {"ok": True}
    ensure.assert_awaited_once()


def test_openai_parse_json_strips_fence():
    mock_client = MagicMock()
    with patch("openai.AsyncOpenAI", return_value=mock_client):
        adapter = OpenAIAdapter(_openai_cfg())
    raw = '```json\n{"key": "value"}\n```'
    result = adapter._parse_json(raw)
    assert result == {"key": "value"}


async def test_openai_generate_storyboard_delegates_to_generate_json():
    mock_response = MagicMock()
    mock_response.choices[0].message.content = '{"scenes": []}'
    mock_client = MagicMock()
    mock_client.chat.completions.create = AsyncMock(return_value=mock_response)

    with patch("openai.AsyncOpenAI", return_value=mock_client):
        adapter = OpenAIAdapter(_openai_cfg())
        req = StoryboardRequest(user_prompt="A detective story in Venice")
        result = await adapter.generate_storyboard(req)

    assert "scenes" in result
    mock_client.chat.completions.create.assert_called_once()


# ── Anthropic Adapter ─────────────────────────────────────────────────────────

async def test_anthropic_generate_json():
    mock_msg = MagicMock()
    mock_msg.content[0].text = '{"themes": ["love", "loss"]}'
    mock_client = MagicMock()
    mock_client.messages.create = AsyncMock(return_value=mock_msg)

    with patch("anthropic.AsyncAnthropic", return_value=mock_client):
        adapter = AnthropicAdapter(_anthropic_cfg())
        result = await adapter.generate_json(
            system="You are a story analyst.",
            user="Analyze this brief.",
        )

    assert "themes" in result
    assert "love" in result["themes"]


async def test_anthropic_health_check_fail():
    mock_client = MagicMock()
    mock_client.messages.create = AsyncMock(side_effect=Exception("api_error"))
    with patch("anthropic.AsyncAnthropic", return_value=mock_client):
        adapter = AnthropicAdapter(_anthropic_cfg())
        ok = await adapter.health_check()
    assert ok is False


# ── Ollama Adapter ────────────────────────────────────────────────────────────

async def test_ollama_generate_json():
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {"response": '{"sequences": []}'}
    mock_response.raise_for_status = MagicMock()

    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.post = AsyncMock(return_value=mock_response)

    with patch("httpx.AsyncClient", return_value=mock_client):
        adapter = OllamaAdapter(_ollama_cfg())
        result = await adapter.generate_json(
            system="You are a director.",
            user="Generate a story arc.",
        )

    assert "sequences" in result


async def test_ollama_health_check_ok():
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.get = AsyncMock(return_value=mock_response)

    with patch("httpx.AsyncClient", return_value=mock_client):
        adapter = OllamaAdapter(_ollama_cfg())
        ok = await adapter.health_check()
    assert ok is True


async def test_ollama_health_check_fail():
    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.get = AsyncMock(side_effect=ConnectionError("refused"))

    with patch("httpx.AsyncClient", return_value=mock_client):
        adapter = OllamaAdapter(_ollama_cfg())
        ok = await adapter.health_check()
    assert ok is False


def test_ollama_parse_json_with_fence():
    adapter = OllamaAdapter(_ollama_cfg())
    raw = '```json\n{"key": "val"}\n```'
    assert adapter._parse_json(raw) == {"key": "val"}
