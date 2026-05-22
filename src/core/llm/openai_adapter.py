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
        # Use a generous timeout for slow local/remote LM Studio endpoints
        adapter_timeout = max(cfg.timeout_sec, 600)
        self._client = AsyncOpenAI(
            api_key=cfg.api_key or "sk-no-key",
            base_url=cfg.base_url,
            timeout=adapter_timeout,
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
        response = await self._client.chat.completions.create(**kwargs)
        from src.core.llm.style_improve import openai_message_text

        raw = openai_message_text(response.choices[0].message)
        return self._parse_json(raw)

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=2, min=2, max=30),
        retry=retry_if_exception_type(Exception),
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
        response = await self._client.chat.completions.create(**kwargs)
        from src.core.llm.style_improve import openai_message_text

        raw = openai_message_text(response.choices[0].message)
        return self._parse_json(raw)

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

    async def health_check_detail(self) -> tuple[bool, str | None]:
        try:
            await asyncio.wait_for(self._client.models.list(), timeout=12.0)
            return True, None
        except Exception as e:
            base = getattr(self._client, "base_url", None) or "?"
            return False, f"{type(e).__name__}: {e} (base_url={base})"

    async def health_check(self) -> bool:
        ok, _ = await self.health_check_detail()
        return ok

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
        raise ValueError(f"No valid JSON found in LLM response: {raw[:200]!r}")
