"""
Adapter Anthropic — supporta claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5.
"""

import json
import re
import asyncio
from typing import AsyncIterator, Optional

from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception

from src.core.llm.base import BaseLLMAdapter, StoryboardRequest
from src.core.config import get_config, LLMConfig


def _anthropic_retryable(exc: BaseException) -> bool:
    """400/401/403 e CancelledError/TimeoutError non devono essere riprovati."""
    if isinstance(exc, (asyncio.CancelledError, asyncio.TimeoutError, TimeoutError)):
        return False
    try:
        from anthropic import BadRequestError, AuthenticationError, PermissionDeniedError
        if isinstance(exc, (BadRequestError, AuthenticationError, PermissionDeniedError)):
            return False
    except ImportError:
        pass
    return True


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

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=2, min=2, max=30), retry=retry_if_exception(_anthropic_retryable))
    async def generate_json(
        self,
        system: str,
        user: str,
        temperature: float = 0.7,
        max_tokens: int = 2000,
    ) -> dict:
        system = self._inject_language(system)
        response = await self._client.messages.create(
            model=self._model,
            max_tokens=max_tokens,
            temperature=temperature,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        return self._parse_json(response.content[0].text)

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=2, min=2, max=30), retry=retry_if_exception(_anthropic_retryable))
    async def generate_json_with_images(
        self,
        system: str,
        user: str,
        *,
        images: list[dict],
        temperature: float = 0.7,
        max_tokens: int = 4096,
    ) -> dict:
        system = self._inject_language(system)
        blocks: list = [{"type": "text", "text": user}]
        for img in images:
            mime = img.get("mime") or "image/png"
            b64 = img.get("b64") or ""
            if not b64:
                continue
            blocks.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": mime,
                    "data": b64,
                },
            })
        response = await self._client.messages.create(
            model=self._model,
            max_tokens=max_tokens,
            temperature=temperature,
            system=system,
            messages=[{"role": "user", "content": blocks}],
        )
        text = "".join(
            b.text for b in response.content if getattr(b, "type", None) == "text"
        )
        return self._parse_json(text)

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=2, min=2, max=30), retry=retry_if_exception(_anthropic_retryable))
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
        exc = ValueError(f"No valid JSON found in LLM response: {raw[:200]!r}")
        exc.raw_response = raw  # type: ignore[attr-defined]
        raise exc
