"""Normalizza configurazioni LLM (base URL, credenziali, fallback globale)."""

from __future__ import annotations

from typing import Optional

from src.core.config import LLMConfig, get_config

PROVIDER_DEFAULT_BASE_URL: dict[str, str] = {
    "lmstudio": "http://127.0.0.1:1234/v1",
    "ollama": "http://127.0.0.1:11434",
    "openai": "https://api.openai.com/v1",
    "groq": "https://api.groq.com/openai/v1",
}


def blank_to_none(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    s = str(value).strip()
    return s or None


def normalize_base_url(provider: str, base_url: Optional[str]) -> Optional[str]:
    """Applica default per provider e assicura suffisso /v1 per endpoint OpenAI-compatibili."""
    p = provider.lower()
    url = blank_to_none(base_url)
    if not url:
        return PROVIDER_DEFAULT_BASE_URL.get(p)

    if p in ("lmstudio", "openai", "groq"):
        u = url.rstrip("/")
        if not u.endswith("/v1"):
            u = f"{u}/v1"
        return u
    return url


def resolve_llm_config(
    cfg_data,
    *,
    fallback: Optional[LLMConfig] = None,
) -> LLMConfig:
    """
    Unisce campi vuoti con la config globale salvata e normalizza base_url.
    Accetta LLMConfigUpdate o dict (es. da model_dump).
    """
    fb = fallback or get_config().llm
    if isinstance(cfg_data, LLMConfig):
        raw = cfg_data.model_dump()
    elif hasattr(cfg_data, "model_dump"):
        raw = cfg_data.model_dump()
    else:
        raw = dict(cfg_data)

    raw["api_key"] = blank_to_none(raw.get("api_key"))
    raw["base_url"] = blank_to_none(raw.get("base_url"))

    if not raw.get("api_key") and fb.api_key:
        raw["api_key"] = fb.api_key
    if not raw.get("base_url") and fb.base_url:
        raw["base_url"] = fb.base_url

    cfg = LLMConfig(**raw)
    norm_url = normalize_base_url(cfg.provider, cfg.base_url)
    if norm_url != cfg.base_url:
        cfg = cfg.model_copy(update={"base_url": norm_url})
    return cfg
