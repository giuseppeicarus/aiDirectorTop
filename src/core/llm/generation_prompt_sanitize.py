"""
Pulisce prompt immagine/video da chain-of-thought e meta-testo LLM.
I modelli con thinking spesso mettono ragionamento o JSON nelle stringhe first_frame_prompt.
"""

from __future__ import annotations

import json
import re
from typing import Any, Optional

# Tag e blocchi reasoning (Qwen3, DeepSeek-R1, Claude extended, ecc.)
_THINKING_BLOCK_RE = re.compile(
    r"<(?:think(?:ing)?|reasoning|thought|analysis|redacted_thinking)"
    r"[^>]*>.*?</(?:think(?:ing)?|reasoning|thought|analysis|redacted_thinking)>",
    re.DOTALL | re.IGNORECASE,
)
# Variante Qwen3 / DeepSeek: `...`
_QWEN_THINK_RE = re.compile(r"`.*?`", re.DOTALL | re.IGNORECASE)
# Blocco `thinking` aperto senza chiusura (resto del testo)
_OPEN_THINK_RE = re.compile(r"`[^`]*$", re.DOTALL | re.IGNORECASE)

_PROMPT_FIELD_KEYS = (
    "first_frame_prompt",
    "last_frame_prompt",
    "scene_prompt",
    "motion_prompt",
    "prompt",
    "positive_prompt",
    "enhanced",
    "text",
    "description",
    "content",
)

_META_LINE_RE = re.compile(
    r"^\s*(?:OUTPUT|RULES|FORMAT|MANDATORY|JSON|slot_id|visual_plans|prompts|"
    r"FRAME PROMPT|DP VISUAL|Here is|Let me|I will|I need to|Step \d+|"
    r"Analysis:|Reasoning:|Chain of thought|Valid JSON|No markdown)\b",
    re.IGNORECASE | re.MULTILINE,
)

_VISUAL_START_RE = re.compile(
    r"\b(cinematic|film still|wide shot|medium shot|close[- ]?up|extreme wide|"
    r"photorealistic|8k|35mm|drone shot)\b",
    re.IGNORECASE,
)

# Negative condiviso — riduce testo illeggibile e malformazioni su Z-Image / SDXL
CINEMATIC_NEGATIVE_PROMPT = (
    "ugly, deformed, blurry, low quality, watermark, logo, brand mark, "
    "text, letters, words, numbers, typography, caption, subtitle, speech bubble, "
    "signage with text, billboard text, screen text, UI overlay, gibberish writing, "
    "unreadable text, scrambled letters, misspelled words, "
    "extra fingers, extra limbs, malformed hands, fused fingers, "
    "distorted face, asymmetrical eyes, crossed eyes, bad anatomy, disfigured, "
    "cartoon, anime, illustration, painting, CGI, 3d render, plastic skin, oversaturated"
)

_VISUAL_QUALITY_SUFFIX = ", photorealistic cinematic realism, natural skin texture"

# Negative-only phrases that must NOT appear in positive prompts
_NEGATIVE_PHRASES_IN_POSITIVE = re.compile(
    r",?\s*no\s+(?:visible\s+)?(?:text|words?|captions?|logos?|watermarks?|brands?|UI|overlay|letters?)[^,]*",
    re.IGNORECASE,
)

_GIBBERISH_RE = re.compile(
    r"\b(?:lorem ipsum|asdf|TODO|FIXME|slot_\d+|first_frame_prompt|"
    r"the user wants|make sure to|we need to|I will create|OUTPUT JSON)\b",
    re.IGNORECASE,
)


def _trim_to_visual_start(text: str) -> str:
    """Taglia prefissi di ragionamento prima della descrizione visiva."""
    m = _VISUAL_START_RE.search(text)
    if m and m.start() > 0:
        prefix = text[: m.start()].strip()
        # Prosa strutturata reel: la scena inizia prima della keyword camera
        if re.match(
            r"^(?:Inside|In a|At a|On a|A |The |Steel |Dark |Background|"
            r"[\w\s]{12,}(?:\.|,))",
            prefix,
            re.I,
        ):
            return text
        return text[m.start() :].strip()
    return text


_META_SUBSTRINGS = (
    "valid json only",
    "no markdown",
    "no explanations",
    "output json",
    '"visual_plans"',
    '"prompts"',
    "frame prompt format",
    "comfyui-ready",
    "translate each",
    "for each plan",
    "slot_id",
)


def strip_llm_reasoning(text: str) -> str:
    """Rimuove blocchi thinking/reasoning dal testo."""
    if not text:
        return ""
    raw = str(text)
    for pat in (_THINKING_BLOCK_RE, _QWEN_THINK_RE, _OPEN_THINK_RE):
        raw = pat.sub("", raw)
    # Testo prima del primo blocco visivo utile (spesso tutto thinking senza tag)
    raw = re.sub(
        r"^(?:\s*(?:Okay|Alright|Sure|Let me|I will|First,|Step \d+)[^\n]*\n)+",
        "",
        raw,
        flags=re.IGNORECASE | re.MULTILINE,
    )
    return raw.strip()


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


def _pick_from_dict(data: dict) -> Optional[str]:
    for key in _PROMPT_FIELD_KEYS:
        val = data.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
        if isinstance(val, dict):
            inner = val.get("prompt") or val.get("text") or val.get("description")
            if isinstance(inner, str) and inner.strip():
                return inner.strip()
    return None


def coerce_prompt_string(value: Any) -> str:
    """Converte valori LLM eterogenei in una stringa prompt."""
    if value is None:
        return ""
    if isinstance(value, str):
        s = strip_llm_reasoning(value)
        parsed = _try_parse_json(s)
        if isinstance(parsed, dict):
            picked = _pick_from_dict(parsed)
            if picked:
                return strip_llm_reasoning(picked)
        if isinstance(parsed, list) and parsed:
            first = parsed[0]
            if isinstance(first, dict):
                picked = _pick_from_dict(first)
                if picked:
                    return strip_llm_reasoning(picked)
        return s
    if isinstance(value, dict):
        picked = _pick_from_dict(value)
        return strip_llm_reasoning(picked) if picked else ""
    return strip_llm_reasoning(str(value))


def looks_like_gibberish_or_instruction(text: str) -> bool:
    """Testo che causa artefatti testuali o non è una scena fotografica."""
    if not text:
        return True
    if _GIBBERISH_RE.search(text):
        return True
    # Troppi token con maiuscole alternate (spesso leak del modello)
    tokens = text.split()
    if len(tokens) >= 8:
        weird = sum(1 for w in tokens if len(w) > 14 and not w.islower())
        if weird >= 3:
            return True
    return False


def finalize_positive_prompt(text: str) -> str:
    """Aggiunge qualità fotografica al prompt positivo e rimuove frasi negative errate."""
    if not text:
        return text
    # Strip any "no X" negative phrases that may have leaked into positive prompt
    t = _NEGATIVE_PHRASES_IN_POSITIVE.sub("", text)
    t = re.sub(r"\b8k\b", "", t, flags=re.I)
    t = t.rstrip("., ")
    # Re-collapse double commas/spaces left by removal
    t = re.sub(r",\s*,", ",", t)
    t = re.sub(r"\s{2,}", " ", t).strip()
    if not t:
        return text.rstrip("., ")
    low = t.lower()
    if "shallow depth of field" in low or "shallow dof" in low:
        t = re.sub(r",?\s*sharp focus(?:\s+on\s+everything)?", "", t, flags=re.I)
        if "bokeh" not in low and "background blur" not in low and "soft background" not in low:
            t += ", subject in focus with soft bokeh background"
    if "photorealistic" not in low:
        t += _VISUAL_QUALITY_SUFFIX
    return t


def looks_like_meta_or_schema(text: str) -> bool:
    """True se il testo non è una descrizione visiva ma istruzioni/JSON/ragionamento."""
    if not text or len(text.strip()) < 12:
        return True
    if looks_like_gibberish_or_instruction(text):
        return True
    t = text.strip()
    lower = t.lower()
    if t.startswith(("{", "[")) and any(k in lower for k in ('"slot_id"', '"prompts"', '"visual_plans"')):
        return True
    if sum(1 for m in _META_SUBSTRINGS if m in lower) >= 2:
        return True
    if _META_LINE_RE.search(t):
        return True
    # Troppo JSON-like
    if t.count('"') >= 8 and t.count(":") >= 4:
        return True
    # Quasi solo istruzioni (poche parole visive)
    visual_hints = ("shot", "camera", "light", "cinematic", "frame", "subject", "lens", "mood")
    if len(t) > 80 and sum(1 for h in visual_hints if h in lower) < 2:
        return True
    return False


def sanitize_motion_prompt(
    value: Any,
    *,
    fallback: str = "",
    max_len: int = 120,
) -> str:
    """Motion/img2video: breve, senza suffisso qualità frame né euristica meta da still."""
    text = coerce_prompt_string(value)
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r",?\s*photorealistic cinematic realism[^,]*", "", text, flags=re.I)
    text = re.sub(r",?\s*natural skin texture", "", text, flags=re.I)
    text = text.strip(" ,.")
    if len(text) < 10:
        text = coerce_prompt_string(fallback)
        text = re.sub(r"\s+", " ", text).strip()
    if len(text) > max_len:
        cut = text[: max_len - 3].rsplit(",", 1)[0]
        text = cut.strip() if len(cut) >= 10 else text[:max_len].strip()
    return text


def sanitize_generation_prompt(
    value: Any,
    *,
    fallback: str = "",
    min_len: int = 24,
    max_len: int = 1200,
) -> str:
    """
    Restituisce un prompt pronto per ComfyUI (solo descrizione visiva).
    Usa fallback se il testo è meta/JSON/thinking.
    """
    text = coerce_prompt_string(value)
    text = _META_LINE_RE.sub("", text)
    text = re.sub(r"\n{3,}", "\n", text).strip()
    # Rimuovi righe che sembrano chiavi JSON
    lines = [
        ln for ln in text.splitlines()
        if not re.match(r'^\s*["\']?\w+["\']?\s*:\s*', ln.strip())
    ]
    text = " ".join(ln.strip() for ln in lines if ln.strip())
    text = re.sub(r"\s+", " ", text).strip()
    text = _trim_to_visual_start(text)

    if looks_like_meta_or_schema(text) or len(text) < min_len:
        fb = coerce_prompt_string(fallback)
        fb = re.sub(r"\s+", " ", fb).strip()
        if fb and not looks_like_meta_or_schema(fb) and len(fb) >= min_len:
            text = fb
        elif fallback:
            text = re.sub(r"\s+", " ", str(fallback)).strip()[:max_len]
        else:
            text = ""

    if len(text) > max_len:
        text = text[: max_len - 3].rsplit(",", 1)[0] + "..."

    return finalize_positive_prompt(text)


def ensure_detailed_frame_prompt(
    raw: str,
    *,
    scene_prompt: str = "",
    style: str = "cinematic",
    shot_type: str = "medium",
    frame_state: str = "",
    role: str = "first",
    min_chars: int = 80,
) -> str:
    """
    Garantisce prompt first/last frame abbastanza ricchi per txt2img (evita output vaghi/monocromatici).
    """
    state = frame_state or scene_prompt
    fb = (
        f"Cinematic film still. {state}. {style}. "
        f"Single coherent {shot_type} framing, 35mm lens, shallow depth of field with soft background bokeh. "
        f"Photorealistic skin texture, dramatic lighting, subtle film grain."
    )
    if role == "last":
        fb += ", end frame, subtle change in pose and light"

    coerced = coerce_prompt_string(raw)
    coerced = re.sub(r"\s+", " ", coerced).strip()
    if looks_like_meta_or_schema(coerced) or len(coerced) < 40:
        text = sanitize_generation_prompt(coerced, fallback=fb, min_len=40)
    else:
        text = coerced

    if len(text) < min_chars:
        scene = sanitize_generation_prompt(scene_prompt, min_len=24) if scene_prompt else ""
        merged = f"{text} {scene}".strip() if scene else text
        if looks_like_meta_or_schema(merged):
            text = sanitize_generation_prompt(merged, fallback=fb, min_len=min_chars)
        else:
            text = merged
    return finalize_positive_prompt(text)


def build_ltx_video_prompt_fallback(
    dop: dict,
    *,
    style: str,
    slot_emotion: str = "",
    duration_sec: float = 5.0,
    brief: str = "",
) -> str:
    """LTX 2.3 img2video — vedi ltx23_prompt_builder.py."""
    from src.core.llm.ltx23_prompt_builder import build_ltx_video_prompt_fallback as _build

    return _build(
        dop,
        style=style,
        slot_emotion=slot_emotion,
        duration_sec=duration_sec,
        brief=brief,
    )


def sanitize_trailer_clip_prompts(
    pdata: dict,
    dop: dict,
    *,
    style: str,
    slot_emotion: str = "",
) -> dict[str, str]:
    """Normalizza i campi prompt di uno slot trailer dopo risposta LLM."""
    shot = dop.get("shot_type") or "medium"
    scene_fb = (
        dop.get("scene_description")
        or f"{slot_emotion}, {style}"
    )
    first_fb = (
        f"cinematic film still, {shot}, "
        f"{dop.get('first_frame_state') or scene_fb}, {style}, "
        f"35mm lens, shallow depth of field, photorealistic, 8k"
    )
    last_fb = (
        f"cinematic film still, {shot}, "
        f"{dop.get('last_frame_state') or scene_fb}, end frame, {style}, "
        f"photorealistic, 8k"
    )
    motion_fb = dop.get("motion_intent") or "camera slowly pushes forward"

    neg_default = CINEMATIC_NEGATIVE_PROMPT

    from src.core.llm.ltx23_prompt_builder import refine_ltx23_video_prompt

    ltx_final = refine_ltx23_video_prompt(
        pdata.get("ltx_video_prompt") or "",
        dop,
        style=style,
        slot_emotion=slot_emotion,
        duration_sec=float(dop.get("duration_sec") or 5.0),
    )
    return {
        "scene_prompt": sanitize_generation_prompt(
            pdata.get("scene_prompt"), fallback=scene_fb,
        ),
        "first_frame_prompt": ensure_detailed_frame_prompt(
            pdata.get("first_frame_prompt"),
            scene_prompt=scene_fb,
            style=style,
            shot_type=shot,
            frame_state=dop.get("first_frame_state") or "",
            role="first",
        ),
        "last_frame_prompt": ensure_detailed_frame_prompt(
            pdata.get("last_frame_prompt"),
            scene_prompt=scene_fb,
            style=style,
            shot_type=shot,
            frame_state=dop.get("last_frame_state") or "",
            role="last",
        ),
        "motion_prompt": sanitize_motion_prompt(
            pdata.get("motion_prompt"),
            fallback=motion_fb,
            max_len=120,
        ),
        "negative_prompt": sanitize_generation_prompt(
            pdata.get("negative_prompt"),
            fallback=neg_default,
            min_len=20,
            max_len=400,
        ) or neg_default,
        "ltx_video_prompt": sanitize_generation_prompt(
            ltx_final, fallback=ltx_final, min_len=60, max_len=950,
        ) or ltx_final,
    }


def sanitize_slot_dict_from_llm(entry: dict) -> dict:
    """Rimuove chiavi thinking e pulisce stringhe in un oggetto slot DP/prompt."""
    if not isinstance(entry, dict):
        return {}
    skip = {
        "thinking", "thought", "reasoning", "analysis", "chain_of_thought",
        "reflection", "commentary", "explanation", "notes",
    }
    out = {}
    for k, v in entry.items():
        if k.lower() in skip:
            continue
        if isinstance(v, str):
            out[k] = strip_llm_reasoning(v)
        else:
            out[k] = v
    return out
