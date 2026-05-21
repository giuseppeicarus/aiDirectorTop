"""
Estrazione del testo prompt da risposte LLM del feature "Migliora prompt".
I modelli con thinking spesso ignorano lo schema e restituiscono
{"prompt": "...", "negative_prompt": "..."} o JSON annidato/stringificato.
"""

from __future__ import annotations

import json
import re
from typing import Any, Optional


_PROMPT_KEYS = (
    "enhanced",
    "prompt",
    "improved_prompt",
    "improved",
    "positive_prompt",
    "text",
    "description",
)

_NEGATIVE_KEYS = ("negative_prompt", "negative", "neg_prompt")

# Suffisso standard (UI + parsing in generate)
NEGATIVE_BLOCK_MARKER = "--- Negative prompt ---"

DEFAULT_NEGATIVE_TXT2IMG = (
    "cartoon, anime, painting, drawing, sketch, deformed, blurry, bad anatomy, "
    "extra limbs, poorly drawn face, mutation, mutated, ugly, tiling, watermark, "
    "signature, text, error, low quality, jpeg artifacts"
)

DEFAULT_NEGATIVE_VIDEO = (
    "static, frozen, blurry, distorted, morphing, flickering, watermark, text, "
    "low quality, deformed, ugly"
)


def _try_parse_json(text: str) -> Any | None:
    t = text.strip()
    if not t.startswith(("{", "[")):
        return None
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        pass
    clean = re.sub(r"```json?\s*", "", t).replace("```", "").strip()
    try:
        return json.loads(clean)
    except json.JSONDecodeError:
        return None


def _pick_prompt_string(data: dict) -> Optional[str]:
    for key in _PROMPT_KEYS:
        val = data.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
        if isinstance(val, dict):
            nested = extract_enhanced_prompt(val, "")
            if nested:
                return nested
    return None


def _pick_negative_string(data: dict) -> Optional[str]:
    for key in _NEGATIVE_KEYS:
        val = data.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return None


def extract_enhanced_prompt(result: Any, fallback: str) -> str:
    """Restituisce solo il testo del prompt migliorato (mai JSON grezzo)."""
    if result is None:
        return fallback

    if isinstance(result, str):
        s = result.strip()
        if not s:
            return fallback
        parsed = _try_parse_json(s)
        if isinstance(parsed, dict):
            return extract_enhanced_prompt(parsed, fallback)
        return s

    if isinstance(result, dict):
        picked = _pick_prompt_string(result)
        if picked:
            parsed = _try_parse_json(picked)
            if isinstance(parsed, dict):
                inner = _pick_prompt_string(parsed)
                if inner:
                    return inner
            return picked
        return fallback

    return fallback


def extract_negative_prompt(result: Any) -> Optional[str]:
    """Estrae negative prompt se presente nella risposta LLM."""
    if result is None:
        return None
    if isinstance(result, str):
        parsed = _try_parse_json(result.strip())
        if isinstance(parsed, dict):
            return extract_negative_prompt(parsed)
        return None
    if isinstance(result, dict):
        neg = _pick_negative_string(result)
        if neg:
            return neg
        for key in _PROMPT_KEYS:
            val = result.get(key)
            if isinstance(val, str):
                parsed = _try_parse_json(val)
                if isinstance(parsed, dict):
                    return _pick_negative_string(parsed)
            if isinstance(val, dict):
                nested = _pick_negative_string(val)
                if nested:
                    return nested
    return None


def default_negative_for_tool(tool: str) -> str:
    if tool in ("img2video", "img_audio2video"):
        return DEFAULT_NEGATIVE_VIDEO
    return DEFAULT_NEGATIVE_TXT2IMG


def needs_negative_prompt(tool: str) -> bool:
    return tool in ("txt2img", "txt2video", "img2video", "img_audio2video")


def append_negative_block(positive: str, negative: str) -> str:
    """Aggiunge il blocco negazione in coda al prompt (visibile in UI)."""
    pos = (positive or "").strip()
    neg = (negative or "").strip()
    if not neg:
        return pos
    if NEGATIVE_BLOCK_MARKER in pos:
        base = pos.split(NEGATIVE_BLOCK_MARKER, 1)[0].strip()
        return f"{base}\n\n{NEGATIVE_BLOCK_MARKER}\n{neg}"
    return f"{pos}\n\n{NEGATIVE_BLOCK_MARKER}\n{neg}"


def split_positive_and_negative(
    combined: str,
    fallback_negative: str = "",
) -> tuple[str, str]:
    """Separa prompt positivo e negative dal testo del textarea."""
    text = (combined or "").strip()
    if not text:
        return "", (fallback_negative or "").strip()

    marker = NEGATIVE_BLOCK_MARKER
    if marker in text:
        base, _, neg_part = text.partition(marker)
        pos = base.strip()
        neg = neg_part.strip() or (fallback_negative or "").strip()
        return pos, neg

    return text, (fallback_negative or "").strip()


def parse_enhance_llm_result(
    result: Any,
    original: str,
    *,
    original_negative: str = "",
    tool: str = "txt2img",
) -> dict[str, Optional[str]]:
    """
    Normalizza output LLM.
    enhanced = testo UNICO per UI (positivo + blocco negative se applicabile).
    positive / negative_prompt = parti estratte per ComfyUI.
    """
    raw = extract_enhanced_prompt(result, original)
    negative = extract_negative_prompt(result) or (original_negative or "").strip()
    llm_provided = isinstance(result, dict) and any(
        result.get(k) is not None for k in (*_PROMPT_KEYS, *_NEGATIVE_KEYS)
    )

    # LLM ha già incluso il blocco negative nel campo enhanced
    if NEGATIVE_BLOCK_MARKER in raw:
        positive, negative = split_positive_and_negative(raw, negative)
        unified = raw.strip()
    else:
        positive = raw
        if needs_negative_prompt(tool):
            if not negative and llm_provided:
                negative = default_negative_for_tool(tool)
            unified = append_negative_block(positive, negative) if negative else positive
        else:
            unified = positive
            negative = ""

    return {
        "enhanced": unified,
        "positive": positive,
        "negative_prompt": (negative or None) if needs_negative_prompt(tool) else None,
    }
