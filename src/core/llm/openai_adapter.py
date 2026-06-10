"""
Adapter OpenAI — supporta GPT-4o, GPT-4o-mini, GPT-4-turbo.
Usabile anche per LM Studio e qualsiasi endpoint OpenAI-compatibile.
"""

import json
import re
import asyncio
import threading
from contextlib import asynccontextmanager
from typing import AsyncIterator, Optional

import httpx
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception

from src.core.llm.base import BaseLLMAdapter, StoryboardRequest
from src.core.config import get_config, LLMConfig

# ── Ollama per-host semaphore (serializza load+inference su stessa istanza) ───
_ollama_sems: dict[str, asyncio.Semaphore] = {}
_ollama_sems_mu: threading.Lock = threading.Lock()


def _get_ollama_sem(host_key: str) -> asyncio.Semaphore:
    with _ollama_sems_mu:
        if host_key not in _ollama_sems:
            _ollama_sems[host_key] = asyncio.Semaphore(1)
        return _ollama_sems[host_key]


def _ollama_root_url(base_url: str) -> str:
    u = base_url.rstrip("/")
    if u.endswith("/v1"):
        u = u[:-3]
    return u


def _ollama_same_model(a: str, b: str) -> bool:
    """Confronto robusto nomi Ollama: llama3 == llama3:latest."""
    def _norm(s: str) -> str:
        s = s.strip().lower()
        if ":" not in s:
            s += ":latest"
        return s
    return _norm(a) == _norm(b)


def _openai_retryable(exc: BaseException) -> bool:
    """400/401/403 e CancelledError/TimeoutError non devono essere riprovati.
    Eccezione: 'Model is unloaded' è temporaneo (LM Studio sta caricando) — va ritentato.
    """
    if isinstance(exc, (asyncio.CancelledError, asyncio.TimeoutError, TimeoutError)):
        return False
    try:
        from openai import BadRequestError, AuthenticationError, PermissionDeniedError, NotFoundError
        if isinstance(exc, (AuthenticationError, PermissionDeniedError, NotFoundError)):
            return False
        if isinstance(exc, BadRequestError):
            msg = str(exc).lower()
            # "Model is unloaded" or "model loading" = LM Studio loading → retry
            if "unload" in msg or "loading" in msg or "not loaded" in msg:
                return True
            return False
    except ImportError:
        pass
    return True


class OpenAIAdapter(BaseLLMAdapter):

    def __init__(self, config: Optional[LLMConfig] = None):
        try:
            from openai import AsyncOpenAI
        except ImportError:
            raise ImportError("Installa openai: pip install openai")

        cfg = config or get_config().llm
        # 180 s floor: enough for slow local models, avoids 10-minute hangs per scene call.
        # Model loading has its own timeout (300 s) inside ensure_lmstudio_model_loaded.
        adapter_timeout = max(cfg.timeout_sec, 180)
        self._client = AsyncOpenAI(
            api_key=cfg.api_key or "sk-no-key",
            base_url=cfg.base_url,
            timeout=adapter_timeout,
        )
        self._model = cfg.model
        self._temperature = cfg.temperature
        self._max_tokens = cfg.max_tokens
        self._config = cfg
        self._provider = (cfg.provider or "").lower()
        # json_object mode: only openai and groq guarantee it; ollama/lmstudio vary by model
        _p = (cfg.provider or "").lower()
        self._use_json_format = _p in ("openai", "groq") or cfg.base_url is None

    @asynccontextmanager
    async def _lmstudio_lock(self):
        """Backward-compat alias → _local_model_lock."""
        async with self._local_model_lock():
            yield

    @asynccontextmanager
    async def _local_model_lock(self):
        """
        Serializza load+inference per provider locali.
        - LM Studio: semaphore globale per host + ensure model loaded
        - Ollama:    semaphore globale per host + unload modelli diversi
        """
        if self._provider in ("lmstudio", "lm_studio"):
            from src.core.llm.model_probe import get_lmstudio_inference_sem, lmstudio_native_base
            sem = get_lmstudio_inference_sem(lmstudio_native_base(self._config.base_url))
            async with sem:
                yield
        elif self._provider == "ollama":
            root = _ollama_root_url(self._config.base_url or "http://localhost:11434/v1")
            sem = _get_ollama_sem(root)
            async with sem:
                await self._ensure_ollama_exclusive(root)
                yield
        else:
            yield

    async def _ensure_ollama_exclusive(self, root: str) -> None:
        """
        Scarica dalla VRAM qualsiasi modello Ollama che non sia quello richiesto.
        Usa GET /api/ps per vedere cosa è caricato, POST /api/generate keep_alive=0 per scaricare.
        """
        if not self._model:
            return
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                r = await client.get(f"{root}/api/ps")
                if r.status_code != 200:
                    return
                running: list[dict] = r.json().get("models", [])
                for m in running:
                    name = m.get("name") or m.get("model") or ""
                    if name and not _ollama_same_model(name, self._model):
                        # keep_alive=0 → Ollama scarica subito il modello dalla VRAM
                        await client.post(
                            f"{root}/api/generate",
                            json={"model": name, "keep_alive": 0},
                            timeout=15.0,
                        )
        except Exception:
            pass  # non-critical: se non riesce a scaricare, procede comunque

    async def _chat_create(self, **kwargs):
        """Chiama chat.completions.create con fallback automatico se response_format è rifiutato."""
        try:
            return await self._client.chat.completions.create(**kwargs)
        except Exception as _exc:
            if "response_format" in kwargs:
                _msg = str(_exc).lower()
                if any(k in _msg for k in ("response_format", "format", "unrecognized", "json_object", "unsupported")):
                    kwargs.pop("response_format")
                    self._use_json_format = False
                    return await self._client.chat.completions.create(**kwargs)
            raise

    async def _ensure_model_ready(self) -> None:
        if self._provider in ("lmstudio", "lm_studio"):
            from src.core.llm.model_probe import ensure_lmstudio_model_loaded
            await ensure_lmstudio_model_loaded(self._config)
        # Ollama: l'unload esclusivo è già gestito in _local_model_lock prima dell'inferenza

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=2, min=2, max=30),
        retry=retry_if_exception(_openai_retryable),
    )
    async def generate_json(
        self,
        system: str,
        user: str,
        temperature: float = 0.7,
        max_tokens: int = 2000,
    ) -> dict:
        async with self._lmstudio_lock():
            await self._ensure_model_ready()
            system = self._inject_language(system)
            kwargs = dict(
                model=self._model,
                temperature=temperature,
                max_tokens=max_tokens,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user",   "content": user},
                ],
            )
            if self._use_json_format:
                kwargs["response_format"] = {"type": "json_object"}
            response = await self._chat_create(**kwargs)
            from src.core.llm.style_improve import openai_message_text

            raw = openai_message_text(response.choices[0].message)
            return self._parse_json(raw)

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=2, min=2, max=30),
        retry=retry_if_exception(_openai_retryable),
    )
    async def generate_json_with_images(
        self,
        system: str,
        user: str,
        *,
        images: list[dict],
        temperature: float = 0.7,
        max_tokens: int = 4096,
    ) -> dict:
        async with self._lmstudio_lock():
            await self._ensure_model_ready()
            system = self._inject_language(system)
            content: list = [{"type": "text", "text": user}]
            for img in images:
                mime = img.get("mime") or "image/png"
                b64 = img.get("b64") or ""
                if not b64:
                    continue
                content.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:{mime};base64,{b64}", "detail": "high"},
                })
            kwargs = dict(
                model=self._model,
                temperature=temperature,
                max_tokens=max_tokens,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": content},
                ],
            )
            if self._use_json_format:
                kwargs["response_format"] = {"type": "json_object"}
            response = await self._chat_create(**kwargs)
            from src.core.llm.style_improve import openai_message_text

            raw = openai_message_text(response.choices[0].message)
            return self._parse_json(raw)

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=2, min=2, max=30),
        retry=retry_if_exception(_openai_retryable),
    )
    async def generate_storyboard(self, req: StoryboardRequest) -> dict:
        return await self.generate_json(
            system=self.SYSTEM_PROMPT,
            user=self.build_user_prompt(req),
            temperature=self._temperature,
            max_tokens=self._max_tokens,
        )

    async def stream_storyboard(self, req: StoryboardRequest) -> AsyncIterator[str]:
        # Use explicit acquire/release so the semaphore is always released
        # even if the caller abandons the generator mid-stream.
        sem = None
        if self._provider in ("lmstudio", "lm_studio"):
            from src.core.llm.model_probe import get_lmstudio_inference_sem, lmstudio_native_base
            sem = get_lmstudio_inference_sem(lmstudio_native_base(self._config.base_url))
            await sem.acquire()
        elif self._provider == "ollama":
            root = _ollama_root_url(self._config.base_url or "http://localhost:11434/v1")
            sem = _get_ollama_sem(root)
            await sem.acquire()
            await self._ensure_ollama_exclusive(root)
        try:
            await self._ensure_model_ready()
            stream = await self._client.chat.completions.create(
                model=self._model,
                temperature=self._temperature,
                max_tokens=self._max_tokens,
                stream=True,
                messages=[
                    {"role": "system", "content": self.SYSTEM_PROMPT},
                    {"role": "user",   "content": self.build_user_prompt(req)},
                ],
            )
            async for chunk in stream:
                delta = chunk.choices[0].delta.content
                if delta:
                    yield delta
        finally:
            if sem is not None:
                sem.release()

    async def health_check_detail(self) -> tuple[bool, str | None]:
        """Verifica che il server sia raggiungibile e il modello sia installato.
        Per LM Studio NON carica il modello in RAM: il caricamento avviene solo
        al momento dell'inferenza, per evitare istanze duplicate tra health poll.
        """
        try:
            if self._provider in ("lmstudio", "lm_studio"):
                from src.core.llm.model_probe import (
                    lmstudio_native_base,
                    _auth_headers,
                    _lmstudio_list_models,
                    _find_lmstudio_catalog_model,
                )
                native_base = lmstudio_native_base(self._config.base_url)
                headers = _auth_headers(self._config.api_key)
                async with httpx.AsyncClient() as client:
                    catalog = await asyncio.wait_for(
                        _lmstudio_list_models(client, native_base, headers),
                        timeout=12.0,
                    )
                if self._model:
                    entry = _find_lmstudio_catalog_model(catalog, self._model)
                    if entry is None:
                        available = [str(e.get("key") or "") for e in catalog[:5]]
                        return False, (
                            f"Modello '{self._model}' non installato in LM Studio. "
                            f"Disponibili: {', '.join(available)}"
                        )
            else:
                await asyncio.wait_for(self._client.models.list(), timeout=12.0)
            return True, None
        except Exception as e:
            base = getattr(self._client, "base_url", None) or "?"
            return False, f"{type(e).__name__}: {e} (base_url={base})"

    async def health_check(self) -> bool:
        """Fast ping — verifies the server is reachable WITHOUT loading the model.
        Used by the services status poll (8 s timeout) so it must not block on model loading.
        """
        try:
            if self._provider in ("lmstudio", "lm_studio"):
                import httpx
                from src.core.llm.model_probe import lmstudio_native_base, _auth_headers
                native_base = lmstudio_native_base(self._config.base_url)
                headers = _auth_headers(self._config.api_key)
                async with httpx.AsyncClient() as client:
                    r = await client.get(
                        f"{native_base}/api/v1/models",
                        headers=headers,
                        timeout=8.0,
                    )
                    return r.status_code < 400
            else:
                ok, _ = await self.health_check_detail()
                return ok
        except Exception:
            return False

    def _parse_json(self, raw: str | None):
        if raw is None or not str(raw).strip():
            raise ValueError("Empty LLM response content")
        raw = self._strip_reasoning(str(raw))
        # Strip markdown fences
        clean = re.sub(r"```json?\s*", "", raw).replace("```", "").strip()
        # First try direct parse
        try:
            return json.loads(clean)
        except json.JSONDecodeError:
            pass
        # Extract first JSON object or array from surrounding text
        for start_char, end_char in [('{', '}'), ('[', ']')]:
            start = clean.find(start_char)
            if start == -1:
                continue
            # Find matching closing bracket (balanced)
            depth = 0
            in_str = False
            esc = False
            for i, ch in enumerate(clean[start:], start):
                if esc:
                    esc = False
                    continue
                if ch == '\\' and in_str:
                    esc = True
                    continue
                if ch == '"':
                    in_str = not in_str
                    continue
                if in_str:
                    continue
                if ch == start_char:
                    depth += 1
                elif ch == end_char:
                    depth -= 1
                    if depth == 0:
                        try:
                            return json.loads(clean[start:i + 1])
                        except json.JSONDecodeError:
                            break
        exc = ValueError(f"No valid JSON found in LLM response: {raw[:200]!r}")
        exc.raw_response = raw  # type: ignore[attr-defined]
        raise exc
