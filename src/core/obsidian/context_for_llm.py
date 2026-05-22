"""
Contesto Obsidian per agenti regia (5 LLM + enhance prompt).
"""

from __future__ import annotations

from typing import Optional

from src.core.obsidian.vault_manager import get_vault_manager

# Stage LLM → note da includere (ordine = priorità)
_STAGE_INCLUDES: dict[str, tuple[str, ...]] = {
    "story_analyst": (
        "memory_index",
        "execution_journal",
        "project_brief",
        "story_arc_reel",
        "vision",
        "audio",
        "audio_analysis",
    ),
    "narrative_director": (
        "memory_index",
        "execution_journal",
        "project_brief",
        "story_analysis",
        "story_arc_reel",
        "vision",
        "audio",
        "audio_analysis",
        "lyric_timing",
        "edl",
    ),
    "cinematographer": (
        "memory_index",
        "execution_journal",
        "story_analysis",
        "story_arc",
        "visual_plans",
        "edl",
        "lyric_timing",
        "continuity",
        "production_config",
    ),
    "prompt_engineer": (
        "memory_index",
        "ltx_prompt_guide",
        "execution_journal",
        "story_arc",
        "story_analysis",
        "visual_plans",
        "edl",
        "continuity",
        "shot",
        "clip",
        "final_deliverable",
    ),
    "continuity_checker": (
        "memory_index",
        "story_arc",
        "story_analysis",
        "shots_summary",
        "continuity",
    ),
    "narrative_director_enhance": (
        "memory_index",
        "execution_journal",
        "story_arc_reel",
        "visual_plans",
        "edl",
        "lyric_timing",
        "clip",
    ),
    "cinematographer_enhance": (
        "memory_index",
        "execution_journal",
        "visual_plans",
        "edl",
        "clip",
        "shot",
    ),
    "prompt_engineer_enhance": (
        "memory_index",
        "story_arc",
        "clip",
        "shot",
    ),
    "director_clip_enhance": (
        "memory_index",
        "project_brief",
        "clip",
    ),
    "director_global_enhance": (
        "memory_index",
        "project_brief",
        "story_arc_reel",
    ),
    # Video LTX 2.3 — Migliora prompt (Tools + reel ltx_video_prompt)
    "ltx_video_enhance": (
        "ltx_prompt_guide",
        "memory_index",
        "clip",
        "shot",
        "visual_plans",
    ),
    "txt2video_enhance": (
        "ltx_prompt_guide",
        "memory_index",
        "project_brief",
    ),
    "img2video_enhance": (
        "ltx_prompt_guide",
        "memory_index",
        "clip",
        "shot",
        "visual_plans",
    ),
    "img_audio2video_enhance": (
        "ltx_prompt_guide",
        "memory_index",
        "clip",
        "shot",
        "audio",
        "visual_plans",
    ),
}


def resolve_enhance_memory_stage(context_key: str) -> str:
    """Mappa contesto UI enhance → stage memoria Obsidian."""
    key = (context_key or "").strip()
    if key in ("ltx_video_prompt",):
        return "ltx_video_enhance"
    if key in ("txt2video", "txt2video_lastframe"):
        return "txt2video_enhance"
    if key in ("img2video", "img2video_lastframe", "director_clip"):
        return "img2video_enhance"
    if key in ("img_audio2video", "img2video_audio"):
        return "img_audio2video_enhance"
    return f"{key}_enhance" if key else "prompt_engineer_enhance"


def get_ltx23_guide_memory(*, max_chars: int = 5500) -> str:
    """Guida LTX globale (vault studio), anche senza project_id."""
    try:
        from src.core.config import get_config

        if not get_config().obsidian.enabled:
            return ""
        from src.core.obsidian.vault_manager import get_vault_manager

        mgr = get_vault_manager()
        mgr.ensure_scaffold()
        from src.core.obsidian.ltx23_guide import read_ltx23_guide_from_vault

        body = read_ltx23_guide_from_vault(mgr.vault_path, max_chars=max_chars)
        if not body.strip():
            return ""
        return f"LTX 2.3 PROMPT GUIDE (Obsidian SSOT — follow strictly):\n{body}\n\n"
    except Exception:
        return ""


def get_regia_memory_for_stage(
    project_id: str,
    llm_stage: str,
    *,
    clip_id: Optional[str] = None,
    shot_id: Optional[str] = None,
    max_chars: int = 8000,
) -> str:
    """
    Bundle markdown filtrato per ruolo LLM.
    Ritorna stringa vuota se vault disabilitato o progetto assente.
    """
    if not project_id:
        return ""
    try:
        from src.core.config import get_config

        if not get_config().obsidian.enabled:
            return ""
    except Exception:
        return ""

    keys = _STAGE_INCLUDES.get(llm_stage)
    if keys is None and llm_stage.endswith("_enhance"):
        keys = ("ltx_prompt_guide", "memory_index")
    keys = keys or _STAGE_INCLUDES["prompt_engineer"]
    mgr = get_vault_manager()
    mgr.ensure_scaffold()
    bundle = mgr.get_context_bundle(
        project_id=project_id,
        clip_id=clip_id,
        shot_id=shot_id,
        include=keys,
        max_chars=max_chars,
    )
    if not bundle.strip():
        return ""
    return f"VAULT MEMORY (Obsidian — SSOT regia, stage={llm_stage}):\n{bundle}\n\n"
