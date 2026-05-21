"""API routes LLM — health, config, generazione storyboard."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional

import httpx

from src.core.llm.factory import get_llm_adapter
from src.core.llm.base import StoryboardRequest
from src.core.config import get_config, reload_config, LLMConfig, save_roles_config, save_llm_config, save_language_config

ANTHROPIC_MODELS = [
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
    "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-20241022",
    "claude-3-opus-20240229",
]


async def _fetch_provider_models(provider: str, base_url: str, api_key: str) -> List[str]:
    """Recupera la lista modelli dal provider. Restituisce lista di ID/nomi."""
    p = provider.lower()
    if p == "anthropic":
        return ANTHROPIC_MODELS

    headers: dict = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    async with httpx.AsyncClient(timeout=8.0) as client:
        if p == "ollama":
            url = base_url.rstrip("/") + "/api/tags"
            r = await client.get(url)
            r.raise_for_status()
            return [m["name"] for m in r.json().get("models", [])]
        else:
            # OpenAI-compatible: /models
            url = base_url.rstrip("/") + "/models"
            r = await client.get(url, headers=headers)
            r.raise_for_status()
            return sorted(m["id"] for m in r.json().get("data", []))

router = APIRouter()

PIPELINE_ROLES = [
    "story_analyst",
    "narrative_director",
    "cinematographer",
    "prompt_engineer",
    "continuity_checker",
    "vision_analyst",
]


class LLMConfigUpdate(BaseModel):
    provider: str
    model: str
    api_key: Optional[str] = None
    base_url: Optional[str] = None
    temperature: float = 0.7
    max_tokens: int = 4096


class RoleConfig(BaseModel):
    custom: bool = False
    provider: str = "lmstudio"
    model: str = ""
    api_key: str = ""
    base_url: str = ""
    temperature: float = 0.7
    max_tokens: int = 4096


class SaveRolesRequest(BaseModel):
    roles: dict[str, RoleConfig]


class LanguageConfigUpdate(BaseModel):
    ui_language: str = "it"
    llm_language: str = "Italian"


@router.get("/health")
async def llm_health_get():
    """Verifica che il provider LLM attualmente salvato sia raggiungibile."""
    try:
        adapter = get_llm_adapter()
        ok = await adapter.health_check()
        cfg = get_config().llm
        return {"ok": ok, "provider": cfg.provider, "model": cfg.model}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.post("/health")
async def llm_health_post(cfg_data: LLMConfigUpdate):
    """Verifica che la configurazione passata nel body sia raggiungibile."""
    try:
        cfg = LLMConfig(**cfg_data.model_dump())
        adapter = get_llm_adapter(cfg)
        ok = await adapter.health_check()
        return {"ok": ok, "provider": cfg.provider, "model": cfg.model}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.post("/config")
async def save_global_llm_config(req: LLMConfigUpdate):
    """Salva la configurazione LLM globale nel file config utente."""
    save_llm_config(req.model_dump())
    return {"ok": True}


@router.get("/config")
async def get_llm_config():
    """Restituisce la configurazione LLM corrente (senza API key)."""
    cfg = get_config().llm
    return {
        "provider": cfg.provider,
        "model": cfg.model,
        "base_url": cfg.base_url,
        "temperature": cfg.temperature,
        "max_tokens": cfg.max_tokens,
        "timeout_sec": cfg.timeout_sec,
    }


@router.post("/models")
async def get_available_models(cfg_data: LLMConfigUpdate):
    """Recupera la lista dei modelli disponibili dal provider configurato."""
    try:
        global_cfg = get_config().llm
        base_url = cfg_data.base_url or global_cfg.base_url or ""
        api_key  = cfg_data.api_key  or global_cfg.api_key  or ""

        # Normalizza base_url per provider standard
        if not base_url:
            provider = cfg_data.provider.lower()
            if provider == "openai":
                base_url = "https://api.openai.com/v1"
            elif provider == "groq":
                base_url = "https://api.groq.com/openai/v1"
            elif provider == "ollama":
                base_url = "http://localhost:11434"

        models = await _fetch_provider_models(cfg_data.provider, base_url, api_key)
        return {"ok": True, "models": models}
    except Exception as e:
        return {"ok": False, "models": [], "error": str(e)}


@router.post("/test")
async def test_llm(prompt: str = "Say 'ok' in JSON: {\"status\": \"ok\"}"):
    """Invia un prompt di test e verifica la risposta JSON."""
    try:
        adapter = get_llm_adapter()
        result = await adapter.generate_json(
            system="Respond with valid JSON only.",
            user=prompt,
            temperature=0.1,
            max_tokens=50,
        )
        return {"ok": True, "response": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/roles")
async def get_llm_roles():
    """Restituisce la configurazione per-ruolo della pipeline cinematografica."""
    import yaml
    from pathlib import Path

    cfg = get_config()

    # Leggi il file utente per sapere quali ruoli sono esplicitamente personalizzati
    user_path = Path("~/.cinematic-studio/config.yaml").expanduser()
    user_roles: dict = {}
    if user_path.exists():
        with open(user_path, encoding="utf-8") as f:
            user_cfg = yaml.safe_load(f) or {}
            user_roles = user_cfg.get("llm_roles", {})

    result = {}
    for role in PIPELINE_ROLES:
        is_custom = role in user_roles
        if is_custom:
            # Usa i valori dal file utente (non quelli risolti/merged)
            raw = user_roles[role]
            result[role] = {
                "custom": True,
                "provider": raw.get("provider", cfg.llm.provider),
                "model": raw.get("model", cfg.llm.model),
                "api_key": "",   # mai esporre la chiave
                "base_url": raw.get("base_url", "") or "",
                "temperature": raw.get("temperature", cfg.llm.temperature),
                "max_tokens": raw.get("max_tokens", cfg.llm.max_tokens),
            }
        else:
            # Mostra i valori del provider globale come anteprima
            global_cfg = cfg.llm
            result[role] = {
                "custom": False,
                "provider": global_cfg.provider,
                "model": global_cfg.model,
                "api_key": "",
                "base_url": global_cfg.base_url or "",
                "temperature": global_cfg.temperature,
                "max_tokens": global_cfg.max_tokens,
            }
    return result


@router.post("/roles")
async def save_llm_roles(req: SaveRolesRequest):
    """Salva la configurazione per-ruolo nel file config utente."""
    roles_to_save = {}
    for role, data in req.roles.items():
        if data.custom:
            entry: dict = {
                "provider": data.provider,
                "model": data.model,
                "temperature": data.temperature,
                "max_tokens": data.max_tokens,
            }
            if data.api_key:
                entry["api_key"] = data.api_key
            if data.base_url:
                entry["base_url"] = data.base_url
            roles_to_save[role] = entry
        # se non custom → non incluso (userà il globale)
    save_roles_config(roles_to_save)
    return {"ok": True}


@router.post("/roles/{role}/test")
async def test_role_config(role: str, cfg_data: LLMConfigUpdate):
    """Testa la connessione LLM per un ruolo specifico."""
    try:
        if role not in PIPELINE_ROLES:
            raise HTTPException(status_code=400, detail=f"Ruolo sconosciuto: {role}")
        cfg = LLMConfig(**cfg_data.model_dump())
        if not cfg.api_key:
            cfg = cfg.model_copy(update={"api_key": get_config().llm.api_key})
        if not cfg.base_url:
            cfg = cfg.model_copy(update={"base_url": get_config().llm.base_url})
        adapter = get_llm_adapter(cfg)
        ok = await adapter.health_check()
        return {"ok": ok, "provider": cfg_data.provider, "model": cfg_data.model,
                "error": None if ok else "Non raggiungibile"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


class ImproveStyleRequest(BaseModel):
    title: str
    description: str
    genre: str = "cinematic"


@router.post("/improve-style")
async def improve_style(req: ImproveStyleRequest):
    """Usa LLM per suggerire uno stile visivo basato su titolo e descrizione."""
    try:
        adapter = get_llm_adapter()
        user_prompt = (
            f"Project title: {req.title}\n"
            f"Genre: {req.genre}\n"
            f"Description: {req.description}\n\n"
            "Suggest a detailed cinematic visual style string for this video project.\n"
            "Focus on: film look, lighting style, color palette, camera work, visual mood.\n"
            "Examples of good style strings:\n"
            "- 'anamorphic lens, teal and orange grade, film grain, dramatic chiaroscuro, neon reflections'\n"
            "- 'overexposed 35mm, soft golden hour, handheld, shallow DoF, warm analog tones'\n"
            "Return JSON: {\"style\": \"<style string>\", \"rationale\": \"<1 sentence why>\"}"
        )
        result = await adapter.generate_json(
            system="You are a professional cinematographer. Return ONLY valid JSON.",
            user=user_prompt,
            temperature=0.85,
            max_tokens=200,
        )
        style = result.get("style", "") if isinstance(result, dict) else str(result)
        rationale = result.get("rationale", "") if isinstance(result, dict) else ""
        return {"ok": True, "style": style, "rationale": rationale}
    except Exception as e:
        return {"ok": False, "error": str(e), "style": ""}


@router.get("/ollama/models")
async def list_ollama_models():
    """Elenca i modelli Ollama installati localmente."""
    cfg = get_config().llm
    base = (cfg.base_url if cfg.provider == "ollama" else None) or "http://localhost:11434"
    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            r = await client.get(base.rstrip("/") + "/api/tags")
            r.raise_for_status()
            models = [m["name"] for m in r.json().get("models", [])]
            return {"ok": True, "models": models, "base_url": base}
    except Exception as e:
        return {"ok": False, "models": [], "error": str(e), "base_url": base}


class OllamaPullRequest(BaseModel):
    model: str


@router.post("/ollama/pull")
async def pull_ollama_model(req: OllamaPullRequest):
    """Avvia il download di un modello Ollama (bloccante fino al completamento)."""
    cfg = get_config().llm
    base = (cfg.base_url if cfg.provider == "ollama" else None) or "http://localhost:11434"
    try:
        async with httpx.AsyncClient(timeout=600.0) as client:
            r = await client.post(
                base.rstrip("/") + "/api/pull",
                json={"name": req.model, "stream": False},
            )
            r.raise_for_status()
            data = r.json()
            return {"ok": True, "status": data.get("status", "done"), "model": req.model}
    except httpx.TimeoutException:
        return {"ok": False, "error": "Timeout — il download è molto lento o Ollama non è avviato"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.post("/generate-storyboard")
async def generate_storyboard(req: StoryboardRequest):
    """Genera uno storyboard completo con il provider LLM configurato."""
    try:
        adapter = get_llm_adapter()
        result = await adapter.generate_storyboard(req)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Language settings ─────────────────────────────────────────────────────────

@router.get("/language")
async def get_language_config():
    """Restituisce la configurazione lingua corrente."""
    cfg = get_config().language
    return {"ui_language": cfg.ui_language, "llm_language": cfg.llm_language}


@router.post("/language")
async def update_language_config(data: LanguageConfigUpdate):
    """Salva la configurazione lingua e aggiorna il config runtime."""
    save_language_config({"ui_language": data.ui_language, "llm_language": data.llm_language})
    return {"ok": True}
