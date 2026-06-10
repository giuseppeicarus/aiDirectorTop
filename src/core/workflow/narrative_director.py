"""
LLM 2 — Narrative Director
Genera StoryArc gerarchico (sequences → scenes → shot placeholders)
"""

import structlog
from src.core.llm.factory import get_llm_adapter
from src.core.llm.cinematic_prompts import NARRATIVE_DIRECTOR_SYSTEM, build_narrative_director_prompt
from src.core.models.cinematic import StoryAnalysis, StoryArc, ProjectInput
from src.core.config import get_config

log = structlog.get_logger()

_STORY_ARC_KEYS = {"title", "logline", "sequences", "visual_motifs", "color_palette"}


def _unwrap_story_arc(raw: object) -> dict:
    """Handle wrapper patterns local LLMs often produce: {"story_arc": {...}}, etc."""
    if not isinstance(raw, dict):
        log.warning("narrative_director_raw_not_dict", type=type(raw).__name__)
        return {}

    # Already flat — has at least one known StoryArc key
    if _STORY_ARC_KEYS & raw.keys():
        return raw

    # Single-key wrapper: {"story_arc": {...}} or {"result": {...}} or {"data": {...}}
    for v in raw.values():
        if isinstance(v, dict) and (_STORY_ARC_KEYS & v.keys()):
            log.info("narrative_director_unwrapped_wrapper")
            return v

    # Two-level nesting: {"response": {"story_arc": {...}}}
    for v in raw.values():
        if isinstance(v, dict):
            for vv in v.values():
                if isinstance(vv, dict) and (_STORY_ARC_KEYS & vv.keys()):
                    log.info("narrative_director_unwrapped_2level")
                    return vv

    log.warning("narrative_director_no_arc_keys_found", raw_keys=list(raw.keys()))
    return raw


async def generate_narrative_arc(
    analysis: StoryAnalysis,
    inp: ProjectInput,
    vault_context: str = "",
) -> StoryArc:
    """LLM 2: genera l'arco narrativo completo."""
    config = get_config()
    role_cfg = config.get_llm_for_role("narrative_director")
    adapter = get_llm_adapter(role_cfg)

    log.info("narrative_director_start")
    try:
        raw = await adapter.generate_json(
            system=NARRATIVE_DIRECTOR_SYSTEM,
            user=(vault_context or "") + build_narrative_director_prompt(analysis, inp),
            temperature=getattr(role_cfg, "temperature", 0.70),
            max_tokens=getattr(role_cfg, "max_tokens", 6000),
        )
    except Exception as e:
        log.error("narrative_director_llm_failed", error=str(e))
        raise RuntimeError(f"LLM narrative director – {e}") from e

    data = _unwrap_story_arc(raw)
    log.info("narrative_director_raw_keys", keys=list(data.keys()) if isinstance(data, dict) else "non-dict")

    try:
        result = StoryArc(**data)
    except Exception as e:
        log.error("narrative_director_parse_failed", error=str(e), raw_keys=list(data.keys()) if isinstance(data, dict) else [])
        # Fallback: construct with whatever valid data we have
        try:
            result = StoryArc.model_construct(**{k: v for k, v in (data.items() if isinstance(data, dict) else []) if k in StoryArc.model_fields})
        except Exception:
            result = StoryArc()
        log.warning("narrative_director_used_fallback_construct", sequences=len(result.sequences))

    if not result.sequences:
        log.error("narrative_director_empty_sequences", title=result.title,
                  raw_keys=list(data.keys()) if isinstance(data, dict) else [])
        raise RuntimeError(
            "LLM 2 (Narrative Director) ha restituito 0 sequenze. "
            "L'LLM non ha generato la struttura narrativa richiesta. "
            f"Arc title: '{result.title}'. "
            "Controlla il log del backend e prova a resettare 'narrative_arc'."
        )

    log.info("narrative_director_done", sequences=len(result.sequences))
    return result
