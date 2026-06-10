"""
Adapter Google Gemini — supporta gemini-2.0-flash, gemini-1.5-pro, ecc.
Usa la REST API nativa di Google AI Studio (generativelanguage.googleapis.com).
Chiave API: ottenibile su https://aistudio.google.com/app/apikey
"""

import asyncio
import json
import re
from typing import AsyncIterator, Optional

import httpx
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception

from src.core.llm.base import BaseLLMAdapter, StoryboardRequest
from src.core.config import LLMConfig, get_config

GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta"

GEMINI_MODELS = [
    "gemini-2.5-pro-preview-06-05",
    "gemini-2.5-flash-preview-05-20",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
    "gemini-1.5-flash-8b",
]


def _gemini_retryable(exc: BaseException) -> bool:
    if isinstance(exc, (asyncio.CancelledError, asyncio.TimeoutError, TimeoutError)):
        return False
    if isinstance(exc, httpx.HTTPStatusError):
        # 400 bad request, 401 auth, 403 forbidden — non ritentare
        if exc.response.status_code in (400, 401, 403):
            return False
    return True


class GeminiAdapter(BaseLLMAdapter):

    def __init__(self, config: Optional[LLMConfig] = None):
        cfg = config or get_config().llm
        self._api_key = cfg.api_key or ""
        self._model = cfg.model or "gemini-2.0-flash"
        self._temperature = cfg.temperature
        self._max_tokens = cfg.max_tokens
        self._timeout = max(cfg.timeout_sec, 120)
        # base può essere overridato (es. Vertex AI proxy)
        self._base = (cfg.base_url or GEMINI_BASE).rstrip("/")

    def _url(self, path: str) -> str:
        return f"{self._base}/{path}"

    def _headers(self) -> dict:
        h = {"Content-Type": "application/json"}
        if self._api_key:
            h["x-goog-api-key"] = self._api_key
        return h

    def _build_body(self, system: str, user: str, temperature: float, max_tokens: int) -> dict:
        return {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {
                "temperature": temperature,
                "maxOutputTokens": max_tokens,
                "responseMimeType": "application/json",
            },
        }

    @staticmethod
    def _extract_text(response: dict) -> str:
        candidates = response.get("candidates", [])
        if not candidates:
            raise ValueError("Gemini: nessun candidato nella risposta")
        parts = candidates[0].get("content", {}).get("parts", [])
        if not parts:
            raise ValueError("Gemini: parti vuote nella risposta")
        return parts[0].get("text", "")

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=2, min=2, max=30),
        retry=retry_if_exception(_gemini_retryable),
    )
    async def generate_json(
        self,
        system: str,
        user: str,
        temperature: float = 0.7,
        max_tokens: int = 2000,
    ) -> dict:
        system = self._inject_language(system)
        url = self._url(f"models/{self._model}:generateContent")
        body = self._build_body(system, user, temperature, max_tokens)
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            r = await client.post(url, headers=self._headers(), json=body)
            r.raise_for_status()
        raw = self._extract_text(r.json())
        raw = self._strip_reasoning(raw)
        return self._parse_json(raw)

    async def generate_storyboard(self, req: StoryboardRequest) -> dict:
        return await self.generate_json(
            system=self.SYSTEM_PROMPT,
            user=self.build_user_prompt(req),
            temperature=self._temperature,
            max_tokens=self._max_tokens,
        )

    async def stream_storyboard(self, req: StoryboardRequest) -> AsyncIterator[str]:
        # Gemini streaming (server-sent events) — per ora accumula e restituisce tutto
        result = await self.generate_storyboard(req)
        yield json.dumps(result)

    async def health_check(self) -> bool:
        ok, _ = await self.health_check_detail()
        return ok

    async def health_check_detail(self) -> tuple[bool, Optional[str]]:
        if not self._api_key:
            return False, "API key mancante — inseriscila in Impostazioni → Provider LLM"
        try:
            url = self._url(f"models/{self._model}:generateContent")
            body = {
                "contents": [{"role": "user", "parts": [{"text": "ping"}]}],
                "generationConfig": {"maxOutputTokens": 8},
            }
            async with httpx.AsyncClient(timeout=15.0) as client:
                r = await client.post(url, headers=self._headers(), json=body)
            if r.status_code == 401:
                return False, "API key non valida (401 Unauthorized)"
            if r.status_code == 403:
                return False, "Accesso negato (403) — verifica quota o permessi API key"
            if r.status_code >= 400:
                try:
                    msg = r.json().get("error", {}).get("message", r.text[:200])
                except Exception:
                    msg = r.text[:200]
                return False, f"Errore Gemini {r.status_code}: {msg}"
            return True, None
        except httpx.ConnectError:
            return False, "Impossibile contattare Google AI — verifica connessione internet"
        except Exception as e:
            return False, str(e)

    @staticmethod
    def _parse_json(raw: str) -> dict:
        raw = raw.strip()
        # strip markdown fences
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
        return json.loads(raw)
