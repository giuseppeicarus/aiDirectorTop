"""
Adapter Anthropic — supporta claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5.
"""

import json
import re
import asyncio
from typing import AsyncIterator, Optional

from tenacity import retry, stop_after_attempt, wait_exponential

from src.core.llm.base import BaseLLMAdapter, StoryboardRequest
from src.core.config import get_config, LLMConfig


class AnthropicAdapter(BaseLLMAdapter):

    def __init__(self, config: Optional[LLMConfig] = None):
        try:
            import anthropic as _anthropic
            self._anthropic = _anthropic
        except ImportError:
            raise ImportError("Installa anthropic: pip install anthropic")

        cfg = config or get_config().llm
        self._client = _anthropic.AsyncAnthropic(
            api_key=cfg.api_key or "",
            timeout=cfg.timeout_sec,
        )
        self._model = cfg.model
        self._temperature = cfg.temperature
        self._max_tokens = cfg.max_tokens

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=2, min=2, max=30))
    async def generate_json(
        self,
        system: str,
        user: str,
        temperature: float = 0.7,
        max_tokens: int = 2000,
    ) -> dict:
        response = await self._client.messages.create(
            model=self._model,
            max_tokens=max_tokens,
            temperature=temperature,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        return self._parse_json(response.content[0].text)

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=2, min=2, max=30))
    async def generate_storyboard(self, req: StoryboardRequest) -> dict:
        return await self.generate_json(
            system=self.SYSTEM_PROMPT,
            user=self.build_user_prompt(req),
            temperature=self._temperature,
            max_tokens=self._max_tokens,
        )

    async def stream_storyboard(self, req: StoryboardRequest) -> AsyncIterator[str]:
        async with self._client.messages.stream(
            model=self._model,
            max_tokens=self._max_tokens,
            system=self.SYSTEM_PROMPT,
            messages=[{"role": "user", "content": self.build_user_prompt(req)}],
        ) as stream:
            async for text in stream.text_stream:
                yield text

    async def health_check(self) -> bool:
        try:
            await asyncio.wait_for(
                self._client.messages.create(
                    model=self._model,
                    max_tokens=10,
                    messages=[{"role": "user", "content": "hi"}],
                ),
                timeout=8.0,
            )
            return True
        except Exception:
            return False

    def _parse_json(self, raw: str) -> dict:
        clean = re.sub(r"```json?\n?", "", raw).replace("```", "").strip()
        return json.loads(clean)
