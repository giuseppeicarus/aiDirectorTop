"""Verifica modelli sul provider: load (LM Studio), prompt di test, unload."""

from __future__ import annotations

import asyncio
import time
from typing import Any, Optional

import httpx

from src.core.config import LLMConfig, get_config
from src.core.llm.resolve_config import resolve_llm_config

TEST_SYSTEM = (
    "/no_think\n"
    "You are a connectivity test. Reply with exactly this JSON and nothing else: "
    '{"status":"ok","role":"probe"}'
)
TEST_USER = '{"status":"ok","role":"probe"}'
PROBE_MAX_TOKENS = 128

LMSTUDIO_LOAD_POLL_INTERVAL = 1.5
LMSTUDIO_LOAD_TIMEOUT = 300.0
LMSTUDIO_POST_LOAD_SETTLE_SEC = 2.0
LMSTUDIO_LOAD_ACK_GRACE_SEC = 8.0
LMSTUDIO_CHAT_MAX_ATTEMPTS = 12
LMSTUDIO_CHAT_RETRY_BASE_SEC = 2.0
LMSTUDIO_CHAT_TIMEOUT = 180.0
_LMSTUDIO_LOAD_LOCKS: dict[str, asyncio.Lock] = {}
# One-at-a-time semaphore per endpoint: serializes load + inference so LM Studio
# never receives concurrent requests while switching or loading models.
_LMSTUDIO_INFERENCE_SEMS: dict[str, asyncio.Semaphore] = {}


def get_lmstudio_inference_sem(native_base: str) -> asyncio.Semaphore:
    return _LMSTUDIO_INFERENCE_SEMS.setdefault(native_base, asyncio.Semaphore(1))


def lmstudio_native_base(base_url: Optional[str]) -> str:
    """Base URL REST nativa LM Studio (senza suffisso /v1 OpenAI)."""
    u = (base_url or "http://127.0.0.1:1234/v1").rstrip("/")
    if u.endswith("/v1"):
        return u[:-3]
    return u


def _auth_headers(api_key: Optional[str]) -> dict[str, str]:
    h: dict[str, str] = {"Content-Type": "application/json"}
    if api_key:
        h["Authorization"] = f"Bearer {api_key}"
    return h


def _openai_chat_url(base_url: Optional[str]) -> str:
    u = (base_url or "http://127.0.0.1:1234/v1").rstrip("/")
    return f"{u}/chat/completions"


def _extract_message_text(message: Any) -> str:
    """
    Testo risposta da messaggio chat (dict o oggetto).
    Qwen3 / modelli reasoning spesso lasciano content vuoto e usano reasoning_content.
    """
    if message is None:
        return ""
    if isinstance(message, dict):
        content = message.get("content")
        if isinstance(content, str) and content.strip():
            return content.strip()
        if isinstance(content, list):
            parts = []
            for block in content:
                if isinstance(block, dict):
                    t = block.get("text") or block.get("content")
                    if t:
                        parts.append(str(t))
            joined = "\n".join(parts).strip()
            if joined:
                return joined
        for key in ("reasoning_content", "text", "output"):
            val = message.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
        return str(content or "").strip()

    content = getattr(message, "content", None)
    if isinstance(content, str) and content.strip():
        return content.strip()
    for attr in ("reasoning_content", "text", "output"):
        val = getattr(message, attr, None)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return str(content or "").strip()


def _probe_chat_payload(model: str) -> dict[str, Any]:
    """Payload test connectivity — disabilita thinking dove supportato (Qwen3, ecc.)."""
    payload: dict[str, Any] = {
        "model": model,
        "temperature": 0.1,
        "max_tokens": PROBE_MAX_TOKENS,
        "messages": [
            {"role": "system", "content": TEST_SYSTEM},
            {"role": "user", "content": TEST_USER},
        ],
    }
    payload["chat_template_kwargs"] = {"enable_thinking": False}
    return payload


def _normalize_model_key(value: str) -> str:
    return (value or "").strip().lower().replace("\\", "/").replace("_", "/")


def _model_keys_match(requested: str, catalog_key: str) -> bool:
    """Confronto tollerante tra ID richiesto e chiave catalogo LM Studio."""
    a = _normalize_model_key(requested)
    b = _normalize_model_key(catalog_key)
    if not a or not b:
        return False
    if a == b or a in b or b in a:
        return True
    a_tail = a.rsplit("/", 1)[-1]
    b_tail = b.rsplit("/", 1)[-1]
    return a_tail == b_tail or a_tail in b_tail or b_tail in a_tail


def _instance_matches(
    instance_id: str,
    inst: dict[str, Any],
    model: str,
) -> bool:
    iid = str(inst.get("id") or "").strip()
    if not iid:
        return False
    if instance_id and (iid == instance_id or _model_keys_match(instance_id, iid)):
        return True
    return _model_keys_match(model, iid)


def _collect_loaded_instance_ids(catalog: list[dict[str, Any]]) -> list[str]:
    """Tutti gli instance_id attualmente in RAM su LM Studio."""
    seen: set[str] = set()
    ordered: list[str] = []
    for entry in catalog:
        for inst in entry.get("loaded_instances") or []:
            iid = str(inst.get("id") or "").strip()
            if iid and iid not in seen:
                seen.add(iid)
                ordered.append(iid)
    return ordered


def _model_loaded_in_list(
    models: list[dict[str, Any]],
    model: str,
    instance_id: Optional[str] = None,
) -> bool:
    for entry in models:
        key = str(entry.get("key") or "")
        variant = str(entry.get("selected_variant") or "")
        display = str(entry.get("display_name") or "")
        if not (
            _model_keys_match(model, key)
            or (variant and _model_keys_match(model, variant))
            or (display and _model_keys_match(model, display))
        ):
            continue
        instances = entry.get("loaded_instances") or []
        if not instances:
            return False
        if instance_id:
            return any(
                _instance_matches(instance_id, inst, model) for inst in instances
            )
        return True
    return False


def _instance_loaded_anywhere(
    catalog: list[dict[str, Any]],
    model: str,
    instance_id: Optional[str] = None,
) -> bool:
    """
    True se un'istanza caricata corrisponde (qualsiasi voce catalogo).
    Utile per modelli multimodali dove loaded_instances non coincide con la key richiesta.
    """
    loaded_ids = _collect_loaded_instance_ids(catalog)
    if not loaded_ids:
        return False

    for iid in loaded_ids:
        if instance_id and _model_keys_match(instance_id, iid):
            return True
        if _model_keys_match(model, iid):
            return True

    return _model_loaded_in_list(catalog, model, instance_id)


def _openai_models_url(base_url: Optional[str]) -> str:
    u = (base_url or "http://127.0.0.1:1234/v1").rstrip("/")
    return f"{u}/models"


async def _openai_list_model_ids(
    client: httpx.AsyncClient,
    base_url: Optional[str],
    headers: dict[str, str],
) -> list[str]:
    r = await client.get(
        _openai_models_url(base_url),
        headers=headers,
        timeout=30.0,
    )
    if r.status_code >= 400:
        return []
    data = r.json()
    return [
        str(m.get("id") or "").strip()
        for m in (data.get("data") or [])
        if str(m.get("id") or "").strip()
    ]


def _openai_model_ready(
    model_ids: list[str],
    model: str,
    instance_id: Optional[str] = None,
) -> bool:
    for mid in model_ids:
        if _model_keys_match(model, mid):
            return True
        if instance_id and _model_keys_match(instance_id, mid):
            return True
    return False


async def _lmstudio_ping_ready(
    client: httpx.AsyncClient,
    openai_base_url: Optional[str],
    model: str,
    headers: dict[str, str],
) -> bool:
    """Verifica readiness con un prompt minimo (fallback se il catalogo non aggiorna loaded_instances)."""
    try:
        r = await client.post(
            _openai_chat_url(openai_base_url),
            json=_probe_chat_payload(model),
            headers=headers,
            timeout=90.0,
        )
        if r.status_code >= 400:
            return False
        message = r.json().get("choices", [{}])[0].get("message", {})
        return bool(_extract_message_text(message))
    except Exception:
        return False


def _load_ack_deadline(load_data: Optional[dict[str, Any]]) -> Optional[float]:
    """Momento dopo cui, se il load API ha risposto OK, accettiamo istanze in RAM."""
    if not load_data:
        return None
    status = (load_data.get("status") or "").lower()
    if status not in ("loaded", "ready"):
        return None
    try:
        load_sec = float(load_data.get("load_time_seconds") or 0)
    except (TypeError, ValueError):
        load_sec = 0.0
    return time.monotonic() + max(load_sec, 3.0) + LMSTUDIO_LOAD_ACK_GRACE_SEC


async def _lmstudio_list_models(
    client: httpx.AsyncClient,
    native_base: str,
    headers: dict[str, str],
) -> list[dict[str, Any]]:
    r = await client.get(
        f"{native_base}/api/v1/models",
        headers=headers,
        timeout=30.0,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"Lista modelli HTTP {r.status_code}: {r.text[:300]}")
    data = r.json()
    return list(data.get("models") or [])


def _find_lmstudio_catalog_model(
    catalog: list[dict[str, Any]],
    model: str,
) -> Optional[dict[str, Any]]:
    for entry in catalog:
        key = str(entry.get("key") or "")
        variant = str(entry.get("selected_variant") or "")
        display = str(entry.get("display_name") or "")
        if (
            _model_keys_match(model, key)
            or (variant and _model_keys_match(model, variant))
            or (display and _model_keys_match(model, display))
        ):
            return entry
    return None


async def ensure_lmstudio_model_loaded(cfg) -> dict[str, Any]:
    """Load the configured LM Studio model if installed but not currently in RAM."""
    model = str(cfg.model or "").strip()
    if not model:
        raise RuntimeError("Nessun modello LM Studio configurato")

    native_base = lmstudio_native_base(cfg.base_url)
    headers = _auth_headers(cfg.api_key)
    lock = _LMSTUDIO_LOAD_LOCKS.setdefault(native_base, asyncio.Lock())

    async with lock:
        async with httpx.AsyncClient(timeout=LMSTUDIO_LOAD_TIMEOUT) as client:
            catalog = await _lmstudio_list_models(client, native_base, headers)
            entry = _find_lmstudio_catalog_model(catalog, model)
            if entry is None:
                available = [
                    str(item.get("key") or "").strip()
                    for item in catalog
                    if str(item.get("key") or "").strip()
                ]
                preview = ", ".join(available[:8]) or "nessuno"
                raise RuntimeError(
                    f"Modello LM Studio '{model}' non installato. "
                    f"Seleziona un modello disponibile in Impostazioni > LLM. "
                    f"Disponibili: {preview}"
                )
            # Scarica tutti i modelli caricati che NON sono il modello richiesto
            unloaded_count = await _lmstudio_unload_others(client, native_base, headers, model)

            # Ri-leggi il catalogo dopo l'unload per avere lo stato fresco
            if unloaded_count > 0:
                catalog = await _lmstudio_list_models(client, native_base, headers)
                entry = _find_lmstudio_catalog_model(catalog, model) or entry

            if entry.get("loaded_instances"):
                return {
                    "loaded": False,
                    "already_loaded": True,
                    "model": model,
                    "unloaded_others": unloaded_count,
                }

            data = await _lmstudio_load(
                client,
                native_base,
                model,
                headers,
                openai_base_url=cfg.base_url,
            )
            return {
                "loaded": True,
                "already_loaded": False,
                "model": model,
                "instance_id": data.get("instance_id"),
            }


async def _lmstudio_wait_ready(
    client: httpx.AsyncClient,
    native_base: str,
    model: str,
    instance_id: Optional[str],
    headers: dict[str, str],
    timeout: float = LMSTUDIO_LOAD_TIMEOUT,
    *,
    openai_base_url: Optional[str] = None,
    load_data: Optional[dict[str, Any]] = None,
) -> None:
    """Attende che LM Studio esponga il modello pronto (catalogo nativo o OpenAI /v1/models)."""
    deadline = time.monotonic() + timeout
    ack_deadline = _load_ack_deadline(load_data)
    last_error: Optional[str] = None

    while time.monotonic() < deadline:
        try:
            catalog = await _lmstudio_list_models(client, native_base, headers)
            if _instance_loaded_anywhere(catalog, model, instance_id):
                await asyncio.sleep(LMSTUDIO_POST_LOAD_SETTLE_SEC)
                return

            openai_ids = await _openai_list_model_ids(
                client, openai_base_url, headers
            )
            if _openai_model_ready(openai_ids, model, instance_id):
                await asyncio.sleep(LMSTUDIO_POST_LOAD_SETTLE_SEC)
                return

            loaded_ids = _collect_loaded_instance_ids(catalog)
            if ack_deadline and time.monotonic() >= ack_deadline:
                if loaded_ids:
                    await asyncio.sleep(LMSTUDIO_POST_LOAD_SETTLE_SEC)
                    return
                if openai_base_url and await _lmstudio_ping_ready(
                    client, openai_base_url, model, headers
                ):
                    await asyncio.sleep(LMSTUDIO_POST_LOAD_SETTLE_SEC)
                    return

            last_error = (
                f"nessuna istanza in RAM (ids catalogo: {len(loaded_ids)}, "
                f"openai: {len(openai_ids)})"
            )
        except Exception as e:
            last_error = str(e)
        await asyncio.sleep(LMSTUDIO_LOAD_POLL_INTERVAL)

    raise RuntimeError(
        f"Timeout caricamento LM Studio ({int(timeout)}s) per '{model}': {last_error}"
    )


async def _lmstudio_wait_unloaded(
    client: httpx.AsyncClient,
    native_base: str,
    model: str,
    instance_id: Optional[str],
    headers: dict[str, str],
    timeout: float = 120.0,
) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            catalog = await _lmstudio_list_models(client, native_base, headers)
            if not _model_loaded_in_list(catalog, model, instance_id):
                return
        except Exception:
            pass
        await asyncio.sleep(LMSTUDIO_LOAD_POLL_INTERVAL)


async def _lmstudio_wait_all_unloaded(
    client: httpx.AsyncClient,
    native_base: str,
    headers: dict[str, str],
    timeout: float = 120.0,
) -> None:
    """Attende che non resti alcun modello in loaded_instances."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            catalog = await _lmstudio_list_models(client, native_base, headers)
            if not _collect_loaded_instance_ids(catalog):
                return
        except Exception:
            pass
        await asyncio.sleep(LMSTUDIO_LOAD_POLL_INTERVAL)


async def _lmstudio_unload_all_loaded(
    client: httpx.AsyncClient,
    native_base: str,
    headers: dict[str, str],
) -> int:
    """
    Scarica dalla RAM ogni modello attualmente caricato (prima di un nuovo load/test).
    Ritorna il numero di istanze scaricate.
    """
    catalog = await _lmstudio_list_models(client, native_base, headers)
    instance_ids = _collect_loaded_instance_ids(catalog)
    if not instance_ids:
        return 0

    for iid in instance_ids:
        await _lmstudio_unload(client, native_base, iid, headers)

    await _lmstudio_wait_all_unloaded(client, native_base, headers)
    return len(instance_ids)


async def _lmstudio_unload_others(
    client: httpx.AsyncClient,
    native_base: str,
    headers: dict[str, str],
    keep_model: str,
    timeout: float = 120.0,
) -> int:
    """Scarica dalla RAM tutti i modelli caricati tranne keep_model.
    Itera per catalog ENTRY (non per instance_id) per evitare falsi non-match
    tra il nome modello configurato e gli instance_id interni di LM Studio.
    """
    catalog = await _lmstudio_list_models(client, native_base, headers)
    to_unload: list[str] = []
    for entry in catalog:
        key = str(entry.get("key") or "")
        variant = str(entry.get("selected_variant") or "")
        display = str(entry.get("display_name") or "")
        # Se questa entry è il modello da tenere, lascia tutte le sue istanze
        if (
            _model_keys_match(keep_model, key)
            or (variant and _model_keys_match(keep_model, variant))
            or (display and _model_keys_match(keep_model, display))
        ):
            continue
        # Scarica tutte le istanze caricate di altri modelli
        for inst in entry.get("loaded_instances") or []:
            iid = str(inst.get("id") or "").strip()
            if iid:
                to_unload.append(iid)

    if not to_unload:
        return 0

    for iid in to_unload:
        await _lmstudio_unload(client, native_base, iid, headers)

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            updated = await _lmstudio_list_models(client, native_base, headers)
            remaining_ids: set[str] = set()
            for entry in updated:
                for inst in entry.get("loaded_instances") or []:
                    iid = str(inst.get("id") or "").strip()
                    if iid:
                        remaining_ids.add(iid)
            if not any(iid in remaining_ids for iid in to_unload):
                return len(to_unload)
        except Exception:
            pass
        await asyncio.sleep(LMSTUDIO_LOAD_POLL_INTERVAL)
    return len(to_unload)


def _is_retryable_probe_error(exc: BaseException) -> bool:
    msg = str(exc).lower()
    markers = (
        "not loaded",
        "no model",
        "model is loading",
        "still loading",
        "loading",
        "503",
        "502",
        "504",
        "connection",
        "timeout",
        "econnrefused",
        "server error",
        "empty response",
        "risposta vuota",
    )
    return any(m in msg for m in markers)


async def _chat_probe_with_retry(
    client: httpx.AsyncClient,
    cfg: LLMConfig,
    model: str,
) -> str:
    last_exc: Optional[Exception] = None
    for attempt in range(LMSTUDIO_CHAT_MAX_ATTEMPTS):
        try:
            return await _chat_probe(client, cfg, model)
        except Exception as e:
            last_exc = e
            if attempt >= LMSTUDIO_CHAT_MAX_ATTEMPTS - 1 or not _is_retryable_probe_error(e):
                raise
            delay = min(
                LMSTUDIO_CHAT_RETRY_BASE_SEC * (2 ** attempt),
                20.0,
            )
            await asyncio.sleep(delay)
    if last_exc:
        raise last_exc
    raise RuntimeError("Chat probe fallito senza eccezione")


async def _lmstudio_load(
    client: httpx.AsyncClient,
    native_base: str,
    model: str,
    headers: dict[str, str],
    *,
    openai_base_url: Optional[str] = None,
) -> dict[str, Any]:
    r = await client.post(
        f"{native_base}/api/v1/models/load",
        json={"model": model},
        headers=headers,
        timeout=LMSTUDIO_LOAD_TIMEOUT,
    )
    if r.status_code >= 400:
        text = r.text[:400]
        raise RuntimeError(f"Load fallito HTTP {r.status_code}: {text}")
    data = r.json()
    status = (data.get("status") or "").lower()
    if data.get("error"):
        raise RuntimeError(str(data["error"]))
    if status not in ("loaded", "ready", "loading", ""):
        raise RuntimeError(f"Load stato inatteso: {status}")

    instance_id = data.get("instance_id") or model
    await _lmstudio_wait_ready(
        client,
        native_base,
        model,
        instance_id,
        headers,
        openai_base_url=openai_base_url,
        load_data=data,
    )
    data["instance_id"] = instance_id
    return data


async def _lmstudio_unload(
    client: httpx.AsyncClient,
    native_base: str,
    instance_id: str,
    headers: dict[str, str],
) -> bool:
    try:
        r = await client.post(
            f"{native_base}/api/v1/models/unload",
            json={"instance_id": instance_id},
            headers=headers,
            timeout=60.0,
        )
        return r.status_code < 400
    except Exception:
        return False


async def _chat_probe(
    client: httpx.AsyncClient,
    cfg: LLMConfig,
    model: str,
) -> str:
    """Prompt minimo via API OpenAI-compatibile; ritorna snippet risposta."""
    headers = _auth_headers(cfg.api_key)
    r = await client.post(
        _openai_chat_url(cfg.base_url),
        json=_probe_chat_payload(model),
        headers=headers,
        timeout=LMSTUDIO_CHAT_TIMEOUT,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"Chat test HTTP {r.status_code}: {r.text[:300]}")
    data = r.json()
    message = data.get("choices", [{}])[0].get("message", {})
    text = _extract_message_text(message)
    if not text:
        raise RuntimeError("Risposta vuota dal modello")
    return text[:200]


async def _ollama_probe(
    client: httpx.AsyncClient,
    cfg: LLMConfig,
    model: str,
) -> str:
    base = (cfg.base_url or "http://127.0.0.1:11434").rstrip("/")
    r = await client.post(
        f"{base}/api/generate",
        json={
            "model": model,
            "prompt": f"{TEST_SYSTEM}\n\n{TEST_USER}",
            "stream": False,
            "options": {"temperature": 0.1, "num_predict": 64},
        },
        timeout=180.0,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"Ollama HTTP {r.status_code}: {r.text[:300]}")
    text = r.json().get("response", "")
    if not str(text).strip():
        raise RuntimeError("Risposta Ollama vuota")
    return str(text).strip()[:200]


async def _anthropic_probe(
    client: httpx.AsyncClient,
    cfg: LLMConfig,
    model: str,
) -> str:
    if not cfg.api_key:
        raise RuntimeError("API key Anthropic mancante")
    r = await client.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": cfg.api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": model,
            "max_tokens": 64,
            "system": TEST_SYSTEM,
            "messages": [{"role": "user", "content": TEST_USER}],
        },
        timeout=120.0,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"Anthropic HTTP {r.status_code}: {r.text[:300]}")
    blocks = r.json().get("content", [])
    text = next((b.get("text", "") for b in blocks if b.get("type") == "text"), "")
    if not text.strip():
        raise RuntimeError("Risposta Anthropic vuota")
    return text.strip()[:200]


async def probe_single_model(cfg: LLMConfig, model: str) -> dict[str, Any]:
    """
    Carica (LM Studio), esegue prompt di test, scarica modello dalla RAM.
    Ritorna dict con ok, message, load_time_seconds, unloaded, sample.
    """
    provider = cfg.provider.lower()
    headers = _auth_headers(cfg.api_key)
    result: dict[str, Any] = {
        "model": model,
        "ok": False,
        "message": "",
        "loaded": False,
        "load_time_seconds": None,
        "prompt_ok": False,
        "unloaded": False,
        "sample": "",
    }

    async with httpx.AsyncClient() as client:
        instance_id = model
        try:
            if provider in ("lmstudio", "lm_studio"):
                native = lmstudio_native_base(cfg.base_url)
                await _lmstudio_unload_all_loaded(client, native, headers)
                load_data = await _lmstudio_load(
                    client, native, model, headers, openai_base_url=cfg.base_url
                )
                result["loaded"] = True
                result["load_time_seconds"] = load_data.get("load_time_seconds")
                instance_id = load_data.get("instance_id") or model

            if provider == "anthropic":
                sample = await _anthropic_probe(client, cfg, model)
            elif provider == "ollama":
                sample = await _ollama_probe(client, cfg, model)
            elif provider in ("lmstudio", "lm_studio"):
                sample = await _chat_probe_with_retry(client, cfg, model)
            else:
                sample = await _chat_probe(client, cfg, model)

            result["prompt_ok"] = True
            result["sample"] = sample
            result["ok"] = True
            result["message"] = "Modello caricato, prompt OK, scaricato" if provider in (
                "lmstudio",
                "lm_studio",
            ) else "Prompt di test OK"

        except Exception as e:
            result["message"] = str(e)
            result["ok"] = False

        finally:
            if provider in ("lmstudio", "lm_studio") and result.get("loaded"):
                native = lmstudio_native_base(cfg.base_url)
                result["unloaded"] = await _lmstudio_unload(
                    client, native, instance_id, headers
                )
                if result["unloaded"]:
                    try:
                        await _lmstudio_wait_unloaded(
                            client, native, model, instance_id, headers
                        )
                    except Exception:
                        pass
                if result["ok"] and result["unloaded"]:
                    result["message"] = "Caricato, test OK, modello scaricato dalla RAM"
                elif result["ok"] and not result["unloaded"]:
                    result["message"] = "Test OK; unload non confermato (verifica LM Studio)"

    return result


async def verify_studio_assignments(
    assignments: list[dict[str, Any]],
    cfg: Optional[LLMConfig] = None,
) -> dict[str, Any]:
    """Verifica ogni modello unico suggerito dallo studio (in sequenza)."""
    cfg = resolve_llm_config(cfg or get_config().llm)

    role_labels = {
        str(a.get("role") or ""): str(a.get("role_label") or a.get("role") or "")
        for a in assignments
    }
    by_model: dict[str, list[str]] = {}
    for item in assignments:
        role = str(item.get("role") or "")
        model = str(item.get("model") or "").strip()
        if role and model:
            by_model.setdefault(model, []).append(role)

    results: list[dict[str, Any]] = []

    from src.core.llm.model_registry import record_probe_result

    for model, roles in by_model.items():
        probe = await probe_single_model(cfg, model)
        await record_probe_result(
            cfg.provider,
            model,
            ok=bool(probe.get("ok")),
            message=str(probe.get("message") or ""),
            load_time_seconds=probe.get("load_time_seconds"),
        )
        for role in roles:
            results.append({
                "role": role,
                "role_label": role_labels.get(role) or role,
                **probe,
            })

    all_ok = all(r.get("ok") for r in results)
    return {
        "ok": all_ok,
        "provider": cfg.provider,
        "results": results,
        "passed": sum(1 for r in results if r.get("ok")),
        "total": len(results),
    }


async def verify_single_model(
    model: str,
    assignments: list[dict[str, Any]],
    cfg: Optional[LLMConfig] = None,
) -> dict[str, Any]:
    """Verifica un solo modello (load/test/unload) e aggiorna il registro DB."""
    from src.core.llm.model_registry import record_probe_result

    cfg = resolve_llm_config(cfg or get_config().llm)
    m = (model or "").strip()
    if not m:
        return {"ok": False, "error": "Modello non specificato", "model": model, "results": []}

    probe = await probe_single_model(cfg, m)
    await record_probe_result(
        cfg.provider,
        m,
        ok=bool(probe.get("ok")),
        message=str(probe.get("message") or ""),
        load_time_seconds=probe.get("load_time_seconds"),
    )

    results = []
    for item in assignments:
        role = str(item.get("role") or "")
        results.append({
            "role": role,
            "role_label": item.get("role_label") or role,
            "model": m,
            **probe,
        })

    return {
        "ok": bool(probe.get("ok")),
        "model": m,
        "provider": cfg.provider,
        "message": probe.get("message"),
        "load_time_seconds": probe.get("load_time_seconds"),
        "loaded": probe.get("loaded"),
        "unloaded": probe.get("unloaded"),
        "results": results,
    }
