"""API routes LLM — health, config, generazione storyboard."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional

import httpx

from src.core.llm.factory import get_llm_adapter
from src.core.llm.base import StoryboardRequest
from src.core.llm.resolve_config import resolve_llm_config
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


async def _llm_health_result(cfg: LLMConfig) -> dict:
    adapter = get_llm_adapter(cfg)
    detail_fn = getattr(adapter, "health_check_detail", None)
    if detail_fn:
        ok, err = await detail_fn()
    else:
        ok = await adapter.health_check()
        err = None if ok else "Non raggiungibile"
    out = {
        "ok": ok,
        "provider": cfg.provider,
        "model": cfg.model,
        "base_url": cfg.base_url,
    }
    if not ok:
        out["error"] = err or (
            f"Impossibile contattare {cfg.provider} "
            f"({cfg.base_url or 'base_url non configurato'})"
        )
    return out


@router.get("/health")
async def llm_health_get():
    """Verifica che il provider LLM attualmente salvato sia raggiungibile."""
    try:
        cfg = resolve_llm_config(get_config().llm)
        return await _llm_health_result(cfg)
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.post("/health")
async def llm_health_post(cfg_data: LLMConfigUpdate):
    """Verifica che la configurazione passata nel body sia raggiungibile."""
    try:
        cfg = resolve_llm_config(cfg_data)
        return await _llm_health_result(cfg)
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.post("/config")
async def save_global_llm_config(req: LLMConfigUpdate):
    """Salva la configurazione LLM globale nel file config utente."""
    cfg = resolve_llm_config(req)
    save_llm_config(cfg.model_dump())
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
        cfg = resolve_llm_config(cfg_data)
        models = await _fetch_provider_models(
            cfg.provider,
            cfg.base_url or "",
            cfg.api_key or "",
        )
        from src.core.llm.model_registry import filter_models_sync
        filtered = filter_models_sync(cfg.provider, models)
        return {
            "ok": True,
            "models": filtered,
            "blocked_count": max(0, len(models) - len(filtered)),
        }
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


@router.post("/roles/studio")
async def role_studio():
    """
    Studio Regia AI: usa il provider LLM globale per assegnare un modello a ogni agente
    tra quelli disponibili sul provider.
    """
    from src.core.llm.role_studio import (
        build_role_studio_prompt,
        call_role_studio_llm,
        parse_role_studio_result,
    )
    from src.core.llm.style_improve import friendly_llm_error

    cfg = resolve_llm_config(get_config().llm)
    health = await _llm_health_result(cfg)
    if not health.get("ok"):
        return {
            "ok": False,
            "error": health.get("error") or "Provider LLM globale non raggiungibile",
        }

    try:
        models = await _fetch_provider_models(
            cfg.provider,
            cfg.base_url or "",
            cfg.api_key or "",
        )
    except Exception as e:
        return {"ok": False, "error": f"Impossibile elencare i modelli: {e}"}

    if not models:
        return {"ok": False, "error": "Nessun modello disponibile sul provider configurato"}

    from src.core.llm.model_registry import filter_models_sync
    usable = filter_models_sync(cfg.provider, models)
    if not usable:
        return {
            "ok": False,
            "error": "Tutti i modelli del provider sono in blacklist — rimuovi voci in Impostazioni",
        }

    try:
        adapter = get_llm_adapter(cfg)
        prompt = build_role_studio_prompt(cfg.provider, usable)
        raw = await call_role_studio_llm(adapter, prompt)
        parsed = parse_role_studio_result(raw, usable)
        return {
            "ok": True,
            "provider": cfg.provider,
            "base_url": cfg.base_url,
            "models_count": len(usable),
            "models_available": usable[:30],
            "models_blocked": max(0, len(models) - len(usable)),
            "summary": parsed["summary"],
            "assignments": parsed["assignments"],
        }
    except Exception as e:
        return {"ok": False, "error": friendly_llm_error(e)}


class StudioAssignmentItem(BaseModel):
    role: str
    role_label: Optional[str] = None
    model: str
    rationale: Optional[str] = None
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None


class StudioVerifyRequest(BaseModel):
    assignments: list[StudioAssignmentItem]


class StudioVerifyModelRequest(BaseModel):
    """Verifica un singolo modello (una alla volta)."""
    model: str
    assignments: list[StudioAssignmentItem]


@router.get("/models/registry")
async def llm_models_registry(provider: Optional[str] = None):
    """Blacklist e ultimi modelli verificati OK per provider."""
    from src.core.llm.model_registry import list_registry
    data = await list_registry(provider)
    return {"ok": True, **data}


@router.delete("/models/blacklist")
async def llm_remove_blacklist(provider: str, model: str):
    """Rimuove un modello dalla blacklist del provider."""
    from src.core.llm.model_registry import remove_from_blacklist
    removed = await remove_from_blacklist(provider, model)
    if not removed:
        return {"ok": False, "error": "Voce non trovata in blacklist"}
    return {"ok": True, "provider": provider.lower(), "model": model}


@router.post("/roles/studio/verify-model")
async def role_studio_verify_model(req: StudioVerifyModelRequest):
    """Verifica un modello alla volta — per aggiornamento progressivo UI."""
    from src.core.llm.model_probe import verify_single_model
    from src.core.llm.style_improve import friendly_llm_error

    if not req.model or not req.assignments:
        return {"ok": False, "error": "Modello o assegnazioni mancanti", "results": []}

    cfg = resolve_llm_config(get_config().llm)
    health = await _llm_health_result(cfg)
    if not health.get("ok"):
        return {
            "ok": False,
            "error": health.get("error") or "Provider LLM globale non raggiungibile",
            "results": [],
        }

    try:
        payload = [a.model_dump() for a in req.assignments]
        return await verify_single_model(req.model, payload, cfg)
    except Exception as e:
        return {"ok": False, "error": friendly_llm_error(e), "model": req.model, "results": []}


@router.post("/roles/studio/verify")
async def role_studio_verify(req: StudioVerifyRequest):
    """
    Verifica ogni modello proposto dallo studio: load (LM Studio), prompt di test, unload.
    """
    from src.core.llm.model_probe import verify_studio_assignments
    from src.core.llm.style_improve import friendly_llm_error

    if not req.assignments:
        return {"ok": False, "error": "Nessuna assegnazione da verificare"}

    cfg = resolve_llm_config(get_config().llm)
    health = await _llm_health_result(cfg)
    if not health.get("ok"):
        return {
            "ok": False,
            "error": health.get("error") or "Provider LLM globale non raggiungibile",
        }

    try:
        payload = [a.model_dump() for a in req.assignments]
        return await verify_studio_assignments(payload, cfg)
    except Exception as e:
        return {"ok": False, "error": friendly_llm_error(e), "results": []}


@router.post("/roles/{role}/test")
async def test_role_config(role: str, cfg_data: LLMConfigUpdate):
    """Testa la connessione LLM per un ruolo specifico."""
    try:
        if role not in PIPELINE_ROLES:
            raise HTTPException(status_code=400, detail=f"Ruolo sconosciuto: {role}")
        cfg = resolve_llm_config(cfg_data)
        result = await _llm_health_result(cfg)
        return {
            "ok": result["ok"],
            "provider": result["provider"],
            "model": result["model"],
            "error": result.get("error"),
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


class ImproveStyleRequest(BaseModel):
    title: str = ""
    description: str = ""
    genre: str = "cinematic"
    current_style: str = ""


def _build_improve_style_prompt(req: ImproveStyleRequest) -> str:
    parts = [
        f"Title: {req.title or 'Reel'}",
        f"Genre: {req.genre}",
        f"Brief:\n{(req.description or '').strip()[:4000]}",
    ]
    if (req.current_style or "").strip():
        parts.append(f"Current style to refine:\n{req.current_style.strip()[:1200]}")
    parts.append(
        "Task: output ONE improved cinematic visual style for AI image/video.\n"
        "English, comma-separated, max 220 chars.\n"
        'JSON only: {"style":"...","rationale":"one sentence in Italian"}'
    )
    return "\n\n".join(parts)


async def _improve_style_llm_call(adapter, user_prompt: str) -> dict:
    """Chiamata LLM senza retry aggressivo; parsing tollerante."""
    from src.core.llm.style_improve import (
        extract_improved_style,
        openai_message_text,
        _try_parse_json,
    )

    system = (
        "You are a professional cinematographer. "
        "Respond with a single JSON object only, keys: style, rationale."
    )
    if hasattr(adapter, "_inject_language"):
        system = adapter._inject_language(system)

    if hasattr(adapter, "_client"):
        kwargs = dict(
            model=adapter._model,
            temperature=0.7,
            max_tokens=512,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user_prompt},
            ],
        )
        if getattr(adapter, "_use_json_format", False):
            kwargs["response_format"] = {"type": "json_object"}
        response = await adapter._client.chat.completions.create(**kwargs)
        raw = openai_message_text(response.choices[0].message)
        parsed = _try_parse_json(raw)
        if isinstance(parsed, dict):
            return parsed
        if raw.strip():
            style, _ = extract_improved_style(raw)
            if style:
                return {"style": style, "rationale": ""}
        raise ValueError("Empty or invalid LLM response")

    return await adapter.generate_json(
        system=system,
        user=user_prompt,
        temperature=0.7,
        max_tokens=512,
    )


@router.post("/improve-style")
async def improve_style(req: ImproveStyleRequest):
    """Adatta e migliora lo stile visivo in base a brief e stile già inserito dall'utente."""
    from src.core.llm.style_improve import extract_improved_style, friendly_llm_error

    if not (req.description or "").strip() and not (req.current_style or "").strip():
        return {"ok": False, "error": "Inserisci una descrizione o uno stile da migliorare", "style": ""}
    try:
        adapter = get_llm_adapter()
        user_prompt = _build_improve_style_prompt(req)
        result = await _improve_style_llm_call(adapter, user_prompt)
        style, rationale = extract_improved_style(result)
        if not style:
            return {
                "ok": False,
                "error": "Il modello non ha restituito uno stile valido. Riprova.",
                "style": "",
            }
        return {"ok": True, "style": style, "rationale": rationale}
    except Exception as e:
        return {"ok": False, "error": friendly_llm_error(e), "style": ""}


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

class PromptEnhanceRequest(BaseModel):
    prompt: str
    context: str = "txt2img"
    tool: Optional[str] = None
    negative_prompt: str = ""
    project_context: Optional[dict] = None


@router.post("/enhance-prompt")
async def llm_enhance_prompt(req: PromptEnhanceRequest):
    """Migliora un prompt usando il modello LLM della pipeline più adatto al contesto."""
    from src.core.llm.prompt_enhance_service import run_prompt_enhance

    try:
        return await run_prompt_enhance(
            prompt=req.prompt,
            context=req.context,
            tool=req.tool,
            negative_prompt=req.negative_prompt,
            project_context=req.project_context,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(500, str(exc)) from exc


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
