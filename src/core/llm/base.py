"""
Interfaccia base per tutti gli adapter LLM.
Ogni provider implementa questa classe astratta.
"""

from abc import ABC, abstractmethod
from typing import AsyncIterator, Optional

from pydantic import BaseModel


class StoryboardRequest(BaseModel):
    user_prompt: str
    genre: str = "cinematic"
    style: str = "photorealistic, dramatic lighting"
    duration_sec: int = 60
    num_scenes: int = 3
    aspect_ratio: str = "16:9"


class BaseLLMAdapter(ABC):

    SYSTEM_PROMPT = """You are a professional cinematographer and screenwriter.
Generate a detailed cinematic storyboard as valid JSON.
Follow the exact schema provided. No markdown, no explanation, no code fences.
Focus on visual storytelling, cinematic camera work, and emotional arcs.
Each shot must have distinct first_frame and last_frame prompts that imply clear motion between them.
Respond ONLY with a valid JSON object starting with { and ending with }."""

    @abstractmethod
    async def generate_json(
        self,
        system: str,
        user: str,
        temperature: float = 0.7,
        max_tokens: int = 2000,
    ) -> dict:
        """Genera JSON generico con i prompt forniti. Base di tutta la pipeline cinematic."""
        ...

    async def generate_json_with_images(
        self,
        system: str,
        user: str,
        *,
        images: list[dict],
        temperature: float = 0.7,
        max_tokens: int = 4096,
    ) -> dict:
        """JSON con input multimodale (images: [{mime, b64}]). Override nei provider vision-capable."""
        raise NotImplementedError(
            f"{self.__class__.__name__} non supporta analisi immagini — usa OpenAI o Anthropic."
        )

    @abstractmethod
    async def generate_storyboard(self, req: StoryboardRequest) -> dict:
        """Genera uno storyboard completo e restituisce il dict JSON validato."""
        ...

    @abstractmethod
    async def stream_storyboard(self, req: StoryboardRequest) -> AsyncIterator[str]:
        """Streamma la generazione token per token."""
        ...

    @abstractmethod
    async def health_check(self) -> bool:
        """Ritorna True se il provider è raggiungibile."""
        ...

    @staticmethod
    def _strip_reasoning(raw: str) -> str:
        """Remove reasoning/thinking blocks emitted by Qwen3, DeepSeek-R1, etc."""
        from src.core.llm.generation_prompt_sanitize import strip_llm_reasoning
        return strip_llm_reasoning(raw)

    @staticmethod
    def _inject_language(system: str) -> str:
        """Append language directive to system prompt based on global config."""
        try:
            from src.core.config import get_config
            lang = get_config().language.llm_language
            if not lang:
                return system
        except Exception:
            return system
        directive = (
            f"\n\nLANGUAGE DIRECTIVE — MANDATORY: "
            f"Write ALL narrative text in {lang}: scene descriptions, emotional notes, "
            f"story analysis, visual direction, character actions, continuity reports, "
            f"titles, themes, and any human-readable annotations. "
            f"EXCEPTION: Image/video generation prompts (first_frame_prompt, last_frame_prompt, "
            f"motion_prompt, negative_prompt) must remain in English for optimal AI model output. "
            f"JSON keys must always remain in English."
        )
        return system + directive

    def build_user_prompt(self, req: StoryboardRequest) -> str:
        return f"""Create a {req.duration_sec}-second cinematic storyboard.

Genre: {req.genre}
Style: {req.style}
Story: {req.user_prompt}
Number of scenes: {req.num_scenes}
Aspect ratio: {req.aspect_ratio}

Requirements:
- Each scene has multiple shots
- Every shot has first_frame and last_frame image prompts (detailed, 30+ words each)
- Shot durations must sum to scene duration
- Scene durations must sum to {req.duration_sec} seconds
- Use realistic camera angles and cinematographic language
- first_frame and last_frame should imply motion (dolly, pan, subject movement)

Return ONLY the JSON storyboard object, no other text."""
