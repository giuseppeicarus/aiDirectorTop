"""Estrazione stile visivo da risposte LLM (improve-style)."""

from __future__ import annotations

import json
import re
from typing import Any, Optional, Tuple

_STYLE_KEYS = (
    "style",
    "stile",
    "visual_style",
    "visualStyle",
    "style_string",
    "improved_style",
    "refined_style",
)

_RATIONALE_KEYS = ("rationale", "reason", "motivation", "note", "explanation")


def _try_parse_json(text: str) -> Any | None:
    t = (text or "").strip()
    if not t:
        return None
    clean = re.sub(r"```json?\s*", "", t).replace("```", "").strip()
    for candidate in (t, clean):
        if not candidate.startswith(("{", "[")):
            continue
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass
    # Primo oggetto JSON nel testo
    start = clean.find("{")
    if start >= 0:
        depth = 0
        in_str = False
        esc = False
        for i, ch in enumerate(clean[start:], start):
            if esc:
                esc = False
                continue
            if ch == "\\" and in_str:
                esc = True
                continue
            if ch == '"':
                in_str = not in_str
                continue
            if in_str:
                continue
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(clean[start : i + 1])
                    except json.JSONDecodeError:
                        break
    return None


def extract_improved_style(result: Any) -> Tuple[str, str]:
    """Normalizza output LLM in (style, rationale)."""
    if isinstance(result, str):
        parsed = _try_parse_json(result)
        if parsed is not None:
            return extract_improved_style(parsed)
        text = result.strip()
        return text, ""

    if not isinstance(result, dict):
        return "", ""

    style = ""
    for key in _STYLE_KEYS:
        val = result.get(key)
        if isinstance(val, str) and val.strip():
            style = val.strip()
            break
        if isinstance(val, dict):
            inner = val.get("prompt") or val.get("text") or val.get("description")
            if isinstance(inner, str) and inner.strip():
                style = inner.strip()
                break

    rationale = ""
    for key in _RATIONALE_KEYS:
        val = result.get(key)
        if isinstance(val, str) and val.strip():
            rationale = val.strip()
            break

    return style, rationale


def openai_message_text(message: Any) -> str:
    """Testo risposta da messaggio OpenAI-compatibile (anche modelli reasoning)."""
    if message is None:
        return ""
    content = getattr(message, "content", None)
    if isinstance(content, str) and content.strip():
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict):
                t = block.get("text") or block.get("content")
                if t:
                    parts.append(str(t))
            else:
                t = getattr(block, "text", None)
                if t:
                    parts.append(str(t))
        joined = "\n".join(parts).strip()
        if joined:
            return joined
    for attr in ("reasoning_content", "text", "output"):
        val = getattr(message, attr, None)
        if isinstance(val, str) and val.strip():
            return val
    return str(content or "").strip()


def friendly_llm_error(exc: BaseException) -> str:
    """Messaggio leggibile per l'UI."""
    try:
        from tenacity import RetryError

        if isinstance(exc, RetryError) and exc.last_attempt is not None:
            exc = exc.last_attempt.exception() or exc
    except ImportError:
        pass
    msg = str(exc).strip()
    if "No valid JSON" in msg or "Empty LLM response" in msg:
        return (
            "Il modello non ha restituito JSON valido. "
            "Riprova o usa un modello chat in Servizi (es. GPT-4o-mini, non solo reasoning)."
        )
    if "RetryError" in msg:
        return "Il modello LLM non ha risposto correttamente dopo vari tentativi. Riprova."
    return msg or "Errore LLM sconosciuto"
