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
        system = self._inject_language(system)
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

    def _parse_json(self, raw: str):
        raw = self._strip_reasoning(raw)
        clean = re.sub(r"```json?\s*", "", raw).replace("```", "").strip()
        try:
            return json.loads(clean)
        except json.JSONDecodeError:
            pass
        for start_char, end_char in [('{', '}'), ('[', ']')]:
            start = clean.find(start_char)
            if start == -1:
                continue
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
        raise ValueError(f"No valid JSON found in LLM response: {raw[:200]!r}")
