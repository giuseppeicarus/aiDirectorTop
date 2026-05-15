"""
Adapter Ollama — modelli locali (llama3, mistral, mixtral, ecc.).
Endpoint di default: http://localhost:11434
"""

import json
import re
from typing import AsyncIterator, Optional

import httpx
from tenacity import retry, stop_after_attempt, wait_exponential

from src.core.llm.base import BaseLLMAdapter, StoryboardRequest
from src.core.config import get_config, LLMConfig


class OllamaAdapter(BaseLLMAdapter):

    def __init__(self, config: Optional[LLMConfig] = None):
        cfg = config or get_config().llm
        self._base_url = (cfg.base_url or "http://localhost:11434").rstrip("/")
        self._model = cfg.model
        self._temperature = cfg.temperature
        self._timeout = cfg.timeout_sec

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=2, min=2, max=30))
    async def generate_json(
        self,
        system: str,
        user: str,
        temperature: float = 0.7,
        max_tokens: int = 2000,
    ) -> dict:
        prompt = f"{system}\n\n{user}"
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            response = await client.post(
                f"{self._base_url}/api/generate",
                json={
                    "model": self._model,
                    "prompt": prompt,
                    "format": "json",
                    "stream": False,
                    "options": {
                        "temperature": temperature,
                        "num_predict": max_tokens,
                    },
                },
            )
            response.raise_for_status()
            raw = response.json()["response"]
            return self._parse_json(raw)

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=2, min=2, max=30))
    async def generate_storyboard(self, req: StoryboardRequest) -> dict:
        return await self.generate_json(
            system=self.SYSTEM_PROMPT,
            user=self.build_user_prompt(req),
            temperature=self._temperature,
            max_tokens=self._max_tokens if hasattr(self, "_max_tokens") else 4096,
        )

    async def stream_storyboard(self, req: StoryboardRequest) -> AsyncIterator[str]:
        prompt = f"{self.SYSTEM_PROMPT}\n\n{self.build_user_prompt(req)}"
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            async with client.stream(
                "POST",
                f"{self._base_url}/api/generate",
                json={"model": self._model, "prompt": prompt, "stream": True},
            ) as response:
                async for line in response.aiter_lines():
                    if line:
                        data = json.loads(line)
                        if token := data.get("response"):
                            yield token
                        if data.get("done"):
                            break

    async def health_check(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                r = await client.get(f"{self._base_url}/api/tags")
                return r.status_code == 200
        except Exception:
            return False

    def _parse_json(self, raw: str) -> dict:
        clean = re.sub(r"```json?\n?", "", raw).replace("```", "").strip()
        return json.loads(clean)
