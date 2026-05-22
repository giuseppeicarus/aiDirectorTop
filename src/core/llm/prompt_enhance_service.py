"""
Migliora prompt — routing al modello LLM della pipeline cinematografica più adatto al contesto.
"""

from __future__ import annotations

from typing import Any, Optional

from src.core.config import get_config
from src.core.llm.cinematic_prompts import (
    CINEMATOGRAPHER_SYSTEM,
    NARRATIVE_DIRECTOR_SYSTEM,
    PROMPT_ENGINEER_SYSTEM,
)
from src.core.llm.factory import get_llm_adapter
from src.core.llm.prompt_enhance import (
    NEGATIVE_BLOCK_MARKER,
    needs_negative_prompt,
    parse_enhance_llm_result,
)

# Contesto UI / campo → ruolo LLM (config Servizi → LLM Pipeline)
CONTEXT_TO_ROLE: dict[str, str] = {
    # Reel / trailer — campi clip
    "scene_prompt": "narrative_director",
    "first_frame_prompt": "prompt_engineer",
    "last_frame_prompt": "prompt_engineer",
    "motion_prompt": "cinematographer",
    "ltx_video_prompt": "prompt_engineer",
    # Tools
    "txt2img": "prompt_engineer",
    "txt2video": "prompt_engineer",
    "img2video": "cinematographer",
    "img_audio2video": "cinematographer",
    # Director Cinema
    "director_clip": "cinematographer",
    "director_global": "narrative_director",
}

# Per negative prompt in coda (ComfyUI)
CONTEXT_TO_TOOL: dict[str, str] = {
    "scene_prompt": "txt2img",
    "first_frame_prompt": "txt2img",
    "last_frame_prompt": "txt2img",
    "motion_prompt": "img2video",
    "ltx_video_prompt": "img_audio2video",
    "director_clip": "img2video",
    "director_global": "txt2img",
}

ROLE_LABELS: dict[str, str] = {
    "story_analyst": "Story Analyst",
    "narrative_director": "Regia narrativa",
    "cinematographer": "Direttore della fotografia",
    "prompt_engineer": "Prompt Engineer",
    "continuity_checker": "Continuity",
    "vision_analyst": "Vision Analyst",
}

_CONTEXT_HINTS: dict[str, str] = {
    "scene_prompt": (
        "Migliora la descrizione di scena per coerenza narrativa, mood e intento visivo dello slot. "
        "Non scrivere prompt ComfyUI tecnici — solo direzione scenica chiara."
    ),
    "first_frame_prompt": (
        "Migliora il prompt txt2img del FIRST FRAME. Formato: "
        "[STYLE], [SHOT TYPE], [SUBJECT+ACTION], [ENVIRONMENT], [LIGHTING], [MOOD], [TECHNICAL]. "
        "Mantieni personaggi e wardrobe coerenti con il brief."
    ),
    "last_frame_prompt": (
        "Migliora il prompt txt2img del LAST FRAME (stato finale dello shot, dopo il movimento). "
        "Stesso formato del first frame; deve essere coerente con il motion successivo."
    ),
    "motion_prompt": (
        "Migliora il motion prompt img2video: max 15–20 parole, solo movimento camera + soggetto + atmosfera. "
        "Niente descrizione statica da still."
    ),
    "ltx_video_prompt": (
        "Migliora il prompt LTX image+audio→video: movimento camera, azione soggetto, sync con musica/voce. "
        "Compatto, cinematografico, adatto a LTX."
    ),
    "txt2img": "Migliora per generazione immagine statica (dettaglio, luce, composizione).",
    "txt2video": "Migliora per generazione video da testo.",
    "img2video": "Migliora motion prompt: camera + soggetto, max ~20 parole.",
    "img_audio2video": "Migliora motion prompt con ritmo audio (LTX): camera, azione, energia.",
    "director_clip": (
        "Migliora il prompt motion della clip LTX Director: camera, azione, atmosfera, max ~30 parole."
    ),
    "director_global": (
        "Migliora la descrizione globale della scena/progetto: mood, stile visivo, tema, coerenza narrativa."
    ),
}


def resolve_enhance_context(
    context: str,
    *,
    tool: Optional[str] = None,
) -> tuple[str, str, str]:
    """
    Returns (llm_role, context_key, tool_for_negative).
    tool arg (Tools UI) ha priorità sul context se è un id tool noto.
    """
    ctx = (tool or context or "txt2img").strip()
    if tool and tool in CONTEXT_TO_ROLE:
        context_key = tool
    elif context in CONTEXT_TO_ROLE:
        context_key = context
    elif tool:
        context_key = tool
    else:
        context_key = context or "txt2img"

    role = CONTEXT_TO_ROLE.get(context_key, "prompt_engineer")
    tool_for_parse = CONTEXT_TO_TOOL.get(context_key, context_key)
    if tool_for_parse not in ("txt2img", "txt2video", "img2video", "img_audio2video"):
        tool_for_parse = "txt2img"
    return role, context_key, tool_for_parse


def _role_system_preamble(role: str) -> str:
    if role == "narrative_director":
        return NARRATIVE_DIRECTOR_SYSTEM.split("OUTPUT")[0].strip()
    if role == "cinematographer":
        return CINEMATOGRAPHER_SYSTEM.split("OUTPUT")[0].strip()
    if role == "prompt_engineer":
        return PROMPT_ENGINEER_SYSTEM.split("CHARACTER CONSISTENCY")[0].strip()
    return (
        "You are an expert AI prompt engineer for professional cinematic image and video generation."
    )


def _build_enhance_system(role: str, context_key: str, *, wants_neg: bool) -> str:
    hint = _CONTEXT_HINTS.get(context_key, _CONTEXT_HINTS.get("txt2img", ""))
    if wants_neg:
        schema = (
            f'{{"enhanced": "<positive>\\n\\n{NEGATIVE_BLOCK_MARKER}\\n<negative tags English>"}}'
        )
        neg_rules = (
            f" Include in 'enhanced' a blank line, then '{NEGATIVE_BLOCK_MARKER}', "
            "then comma-separated negative tags (English). No extra JSON keys."
        )
    else:
        schema = '{"enhanced": "<single improved prompt plain text>"}'
        neg_rules = ""

    return (
        f"{_role_system_preamble(role)}\n\n"
        "TASK: Improve ONE user prompt for the specific production context below. "
        "Keep the same creative intent; make it more cinematic, precise and production-ready.\n"
        f"CONTEXT: {hint}\n"
        f"Respond with EXACTLY one JSON object: {schema}. "
        "The 'enhanced' value must be ONE plain-text string — never nested JSON, no markdown, "
        f"no thinking tags, no explanation.{neg_rules}"
    )


def _format_project_context(ctx: Optional[dict[str, Any]]) -> str:
    if not ctx:
        return ""
    lines: list[str] = []
    mapping = [
        ("brief", "BRIEF"),
        ("description", "BRIEF"),
        ("style", "STYLE"),
        ("director_narrative", "DIRECTOR NARRATIVE"),
        ("visual_theme", "VISUAL THEME"),
        ("logline", "LOGLINE"),
        ("slot_id", "SLOT"),
        ("clip_id", "CLIP"),
        ("shot_type", "SHOT TYPE"),
        ("camera_movement", "CAMERA"),
        ("lens_mm", "LENS MM"),
        ("lighting", "LIGHTING"),
        ("emotion", "EMOTION"),
        ("energy", "ENERGY"),
        ("lyrics_segment", "LYRICS SEGMENT"),
        ("scene_description", "SCENE"),
    ]
    for key, label in mapping:
        val = ctx.get(key)
        if val is None or val == "":
            continue
        if isinstance(val, (list, tuple)):
            val = ", ".join(str(x) for x in val)
        lines.append(f"{label}: {val}")
    if not lines:
        return ""
    return "PRODUCTION CONTEXT:\n" + "\n".join(lines) + "\n\n"


def _build_enhance_user(
    prompt: str,
    context_key: str,
    *,
    project_context: Optional[dict[str, Any]] = None,
    wants_neg: bool,
    original_negative: str = "",
) -> str:
    ctx_block = _format_project_context(project_context)
    neg_extra = ""
    if wants_neg:
        neg_extra = (
            f"\nOriginal negative (if any): {original_negative or '(use standard quality exclusions)'}"
        )
    return (
        f"{ctx_block}"
        f"Improve this prompt ({context_key}).\n"
        f"Original:\n{prompt.strip()}\n"
        f"{neg_extra}\n\n"
        'Return only JSON with key "enhanced".'
    )


async def run_prompt_enhance(
    *,
    prompt: str,
    context: str = "txt2img",
    tool: Optional[str] = None,
    negative_prompt: str = "",
    project_context: Optional[dict[str, Any]] = None,
    temperature: float = 0.75,
    max_tokens: int = 700,
) -> dict[str, Any]:
    """Chiama il LLM configurato per il ruolo più adatto al contesto."""
    if not (prompt or "").strip():
        raise ValueError("Prompt vuoto")

    role, context_key, tool_for_parse = resolve_enhance_context(context, tool=tool)
    cfg = get_config()
    try:
        role_cfg = cfg.get_llm_for_role(role)
    except Exception as exc:
        raise RuntimeError("Nessun LLM configurato per la regia") from exc

    adapter = get_llm_adapter(role_cfg)
    wants_neg = needs_negative_prompt(tool_for_parse)

    from src.core.llm.prompt_enhance import split_positive_and_negative

    orig_pos, orig_neg = split_positive_and_negative(prompt, negative_prompt)

    obsidian_ctx = ""
    if project_context and project_context.get("project_id"):
        try:
            from src.core.obsidian.vault_manager import get_vault_manager

            mgr = get_vault_manager()
            obsidian_ctx = mgr.get_context_bundle(
                project_id=str(project_context["project_id"]),
                clip_id=project_context.get("clip_id"),
                shot_id=project_context.get("shot_id"),
                max_chars=6000,
            )
        except Exception:
            obsidian_ctx = ""

    user_prompt = _build_enhance_user(
        orig_pos,
        context_key,
        project_context=project_context,
        wants_neg=wants_neg,
        original_negative=orig_neg,
    )
    if obsidian_ctx:
        user_prompt = f"VAULT CONTEXT (Obsidian SSOT):\n{obsidian_ctx}\n\n{user_prompt}"

    result = await adapter.generate_json(
        system=_build_enhance_system(role, context_key, wants_neg=wants_neg),
        user=user_prompt,
        temperature=temperature,
        max_tokens=max_tokens,
    )
    parsed = parse_enhance_llm_result(
        result,
        orig_pos,
        original_negative=orig_neg,
        tool=tool_for_parse,
    )
    parsed["role"] = role
    parsed["role_label"] = ROLE_LABELS.get(role, role)
    parsed["context"] = context_key
    return parsed
