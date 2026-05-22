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

CHUNK_SIZE = 3  # smaller chunks: prompt now includes full shot JSON (more tokens per call)


async def generate_frame_prompts(
    shot_list: List[CinematicShot],
    inp: ProjectInput,
    vault_context: str = "",
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
        chunk_dicts = [s.model_dump(exclude={"first_frame", "last_frame", "motion_prompt", "ltx_global_prompt"})
                       for s in chunk]

        raw = await adapter.generate_json(
            system=PROMPT_ENGINEER_SYSTEM,
            user=(vault_context or "") + build_prompt_engineer_prompt(
                chunk_dicts, inp.characters, inp.style_references,
            ),
            temperature=getattr(role_cfg, "temperature", 0.65),
            max_tokens=6000,
        )

        # Unwrap common LLM response wrapper patterns
        if isinstance(raw, list):
            enriched_chunk = raw
        else:
            # Try common keys first
            enriched_chunk = None
            for key in ("shots", "result", "data", "enriched_shots", "items", "frames"):
                if key in raw and isinstance(raw[key], list):
                    enriched_chunk = raw[key]
                    break
            if enriched_chunk is None:
                # Try any list value in the top-level dict
                for v in raw.values():
                    if isinstance(v, list) and v:
                        enriched_chunk = v
                        break
            if enriched_chunk is None:
                enriched_chunk = []

        matched = 0
        for j, shot_data in enumerate(enriched_chunk):
            if j >= len(chunk):
                break
            original = chunk[j]
            ff = shot_data.get("first_frame")
            lf = shot_data.get("last_frame")
            if ff and isinstance(ff, dict):
                try:
                    original.first_frame = FramePrompt(**ff)
                except Exception:
                    pass
            if lf and isinstance(lf, dict):
                try:
                    original.last_frame = FramePrompt(**lf)
                except Exception:
                    pass
            if shot_data.get("motion_prompt"):
                original.motion_prompt = str(shot_data["motion_prompt"])
            if shot_data.get("ltx_global_prompt"):
                original.ltx_global_prompt = str(shot_data["ltx_global_prompt"])
            enriched.append(original)
            matched += 1

        # Shots the LLM didn't return prompts for: keep them as-is
        for j in range(matched, len(chunk)):
            enriched.append(chunk[j])

        log.info("prompt_engineer_chunk", done=len(enriched), total=len(shot_list))

    return enriched
