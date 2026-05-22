"""
LLM 1 — Story Analyst
Analizza brief + lyrics + audio → StoryAnalysis
"""

import json
import re
from typing import Callable, Optional
from src.core.llm.factory import get_llm_adapter
from src.core.llm.cinematic_prompts import STORY_ANALYST_SYSTEM, build_story_analyst_prompt
from src.core.models.cinematic import ProjectInput, StoryAnalysis
from src.core.config import get_config
import structlog

log = structlog.get_logger()


async def analyze_story(
    inp: ProjectInput,
    on_event: Optional[Callable] = None,
    vault_context: str = "",
) -> StoryAnalysis:
    """LLM 1: analizza il brief e restituisce StoryAnalysis."""
    config = get_config()
    role_cfg = config.get_llm_for_role("story_analyst")

    adapter = get_llm_adapter(role_cfg)
    user_prompt = (vault_context or "") + build_story_analyst_prompt(inp)

    if on_event:
        on_event({
            "type": "llm_prompt_detail",
            "system_preview": STORY_ANALYST_SYSTEM[:250],
            "prompt_preview": user_prompt[:600],
            "msg": "Prompt inviato a LLM 1",
        })

    log.info("story_analyst_start", project=inp.title)

    try:
        raw = await adapter.generate_json(
            system=STORY_ANALYST_SYSTEM,
            user=user_prompt,
            temperature=getattr(role_cfg, "temperature", 0.85),
            max_tokens=2000,
        )
    except Exception as e:
        log.error("story_analyst_llm_failed", error=str(e),
                  provider=getattr(role_cfg, "provider", "?"),
                  model=getattr(role_cfg, "model", "?"))
        raise RuntimeError(f"LLM ({role_cfg.provider}/{role_cfg.model}) – {e}") from e

    # Unwrap wrapper keys local LLMs often add
    _ANALYSIS_KEYS = {"themes", "visual_metaphors", "emotion_progression", "narrative_summary", "pacing_notes"}
    if isinstance(raw, dict) and not (_ANALYSIS_KEYS & raw.keys()):
        for v in raw.values():
            if isinstance(v, dict) and (_ANALYSIS_KEYS & v.keys()):
                raw = v
                break

    try:
        result = StoryAnalysis(**raw) if isinstance(raw, dict) else StoryAnalysis()
    except Exception as e:
        log.warning("story_analyst_parse_failed", error=str(e))
        result = StoryAnalysis()

    # Ensure minimal useful output even if LLM returned mostly empty
    if not result.narrative_summary and inp.story_brief:
        result.narrative_summary = inp.story_brief[:500]
    if not result.themes and inp.mood_references:
        result.themes = inp.mood_references[:4]
    if not result.themes and inp.style_references:
        result.themes = inp.style_references[:4]
    if not result.suggested_motifs and inp.visual_references:
        result.suggested_motifs = inp.visual_references[:4]

    if on_event:
        on_event({
            "type": "llm_output_detail",
            "msg": f"Ricevuto: {len(result.themes)} temi, {len(result.emotion_progression)} emozioni",
        })

    log.info("story_analyst_done", themes=result.themes[:3])
    return result
