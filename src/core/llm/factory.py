"""
Factory per ottenere l'adapter LLM corretto in base alla configurazione.
"""

from typing import Optional

from src.core.llm.base import BaseLLMAdapter
from src.core.config import get_config, LLMConfig


def get_llm_adapter(config: Optional[LLMConfig] = None) -> BaseLLMAdapter:
    """
    Restituisce l'adapter LLM configurato.
    Accetta una LLMConfig opzionale per supportare i ruoli per-LLM della pipeline cinematic.
    """
    cfg = config or get_config().llm
    provider = cfg.provider.lower()

    if provider == "openai":
        from src.core.llm.openai_adapter import OpenAIAdapter
        return OpenAIAdapter(cfg)

    if provider == "anthropic":
        from src.core.llm.anthropic_adapter import AnthropicAdapter
        return AnthropicAdapter(cfg)

    if provider == "ollama":
        from src.core.llm.ollama_adapter import OllamaAdapter
        return OllamaAdapter(cfg)

    if provider in ("lmstudio", "lm_studio"):
        from src.core.llm.openai_adapter import OpenAIAdapter
        return OpenAIAdapter(cfg)

    if provider == "groq":
        from src.core.llm.openai_adapter import OpenAIAdapter
        return OpenAIAdapter(cfg)

    raise ValueError(
        f"Provider LLM non supportato: '{provider}'. "
        f"Scegli tra: openai, anthropic, ollama, lmstudio, groq"
    )
