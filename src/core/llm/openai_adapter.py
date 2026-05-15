"""
Adapter OpenAI — supporta GPT-4o, GPT-4o-mini, GPT-4-turbo.
Usabile anche per LM Studio e qualsiasi endpoint OpenAI-compatibile.
"""

import json
import re
import asyncio
from typing import AsyncIterator, Optional

from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type

from src.core.llm.base import BaseLLMAdapter, StoryboardRequest
from src.core.config import get_config, LLMConfig


class OpenAIAdapter(BaseLLMAdapter):

    def __init__(self, config: Optional[LLMConfig] = None):
        try:
            from openai import AsyncOpenAI
        except ImportError:
            raise ImportError("Installa openai: pip install openai")

        cfg = config or get_config().llm
        self._client = AsyncOpenAI(
            api_key=cfg.api_key or "sk-no-key",
            base_url=cfg.base_url,
            timeout=cfg.timeout_sec,
        )
        self._model = cfg.model
        self._temperature = cfg.temperature
        self._max_tokens = cfg.max_tokens
        # Local endpoints (LM Studio, Ollama proxy, etc.) don't support json_object mode
        self._use_json_format = cfg.base_url is None

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=2, min=2, max=30),
        retry=retry_if_exception_type(Exception),
    )
    async def generate_json(
        self,
        system: str,
        user: str,
        temperature: float = 0.7,
        max_tokens: int = 2000,
    ) -> dict:
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
        response = await self._client.chat.completions.create(**kwargs)
        return self._parse_json(response.choices[0].message.content)

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=2, min=2, max=30),
        retry=retry_if_exception_type(Exception),
    )
    async def generate_storyboard(self, req: StoryboardRequest) -> dict:
        return await self.generate_json(
            system=self.SYSTEM_PROMPT,
            user=self.build_user_prompt(req),
            temperature=self._temperature,
            max_tokens=self._max_tokens,
        )

    async def stream_storyboard(self, req: StoryboardRequest) -> AsyncIterator[str]:
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

    async def health_check(self) -> bool:
        try:
            await asyncio.wait_for(self._client.models.list(), timeout=8.0)
            return True
        except Exception:
            return False

    def _parse_json(self, raw: str) -> dict:
        clean = re.sub(r"```json?\n?", "", raw).replace("```", "").strip()
        return json.loads(clean)
