"""
LLM 4 — Prompt Engineer
Arricchisce lo shot list con first_frame, last_frame e motion_prompt per ogni shot.
"""

import structlog
from typing import List
from src.core.llm.factory import get_llm_adapter
from src.core.llm.cinematic_prompts import PROMPT_ENGINEER_SYSTEM, build_prompt_engineer_prompt
from src.core.models.cinematic import CinematicShot, ProjectInput, FramePrompt
from src.core.config import get_config

log = structlog.get_logger()

CHUNK_SIZE = 5  # shot per chiamata LLM (risparmio token)


async def generate_frame_prompts(
    shot_list: List[CinematicShot],
    inp: ProjectInput,
) -> List[CinematicShot]:
    """LLM 4: genera prompt immagine/video per ogni shot."""
    config = get_config()
    role_cfg = config.get_llm_for_role("prompt_engineer")
    adapter = get_llm_adapter(role_cfg)

    log.info("prompt_engineer_start", shots=len(shot_list))

    enriched: List[CinematicShot] = []

    # Processa in chunk per non superare context window
    for i in range(0, len(shot_list), CHUNK_SIZE):
        chunk = shot_list[i:i + CHUNK_SIZE]
        chunk_dicts = [s.model_dump(exclude={"first_frame", "last_frame", "motion_prompt"})
                       for s in chunk]

        raw = await adapter.generate_json(
            system=PROMPT_ENGINEER_SYSTEM,
            user=build_prompt_engineer_prompt(chunk_dicts, inp.characters, inp.style_references),
            temperature=getattr(role_cfg, "temperature", 0.65),
            max_tokens=4000,
        )

        enriched_chunk = raw if isinstance(raw, list) else raw.get("shots", [])
        for j, shot_data in enumerate(enriched_chunk):
            original = chunk[j]
            if "first_frame" in shot_data:
                original.first_frame = FramePrompt(**shot_data["first_frame"])
            if "last_frame" in shot_data:
                original.last_frame = FramePrompt(**shot_data["last_frame"])
            if "motion_prompt" in shot_data:
                original.motion_prompt = shot_data["motion_prompt"]
            enriched.append(original)

        log.info("prompt_engineer_chunk", done=len(enriched), total=len(shot_list))

    return enriched
