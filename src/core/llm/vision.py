"""Analisi immagini di riferimento tramite LLM vision (OpenAI / Anthropic)."""

from __future__ import annotations

import base64
import mimetypes
from pathlib import Path
from typing import Any

import structlog

from src.core.config import get_config
from src.core.llm.factory import get_llm_adapter
from src.core.llm.reel_prompts import (
    REEL_VISION_SYSTEM,
    build_reel_vision_user_prompt,
)

log = structlog.get_logger()

_MAX_IMAGES = 12
_MAX_IMAGE_BYTES = 4_500_000  # bytes ceiling for LLM vision API
_MAX_LONG_SIDE = 2048         # px — resize larger images before base64 encoding


def _encode_image(path: Path) -> dict[str, str]:
    """Read, optionally downscale, and base64-encode an image for the vision API.

    Large files are resized in-memory so the original on disk is untouched.
    Falls back to raw bytes if Pillow is unavailable and the file is small enough.
    """
    data = path.read_bytes()
    mime, _ = mimetypes.guess_type(path.name)
    if not mime or not mime.startswith("image/"):
        mime = "image/png"

    if len(data) > _MAX_IMAGE_BYTES:
        try:
            import io
            from PIL import Image as PILImage

            with PILImage.open(io.BytesIO(data)) as img:
                img = img.convert("RGB")
                w, h = img.size
                if max(w, h) > _MAX_LONG_SIDE:
                    scale = _MAX_LONG_SIDE / max(w, h)
                    img = img.resize((int(w * scale), int(h * scale)), PILImage.LANCZOS)
                buf = io.BytesIO()
                img.save(buf, format="JPEG", quality=88, optimize=True)
                data = buf.getvalue()
                mime = "image/jpeg"
        except ImportError:
            log.warning("vision_pillow_unavailable_large_image", path=path.name, size=len(data))
            if len(data) > _MAX_IMAGE_BYTES:
                raise ValueError(
                    f"Immagine troppo grande ({len(data) // 1024} KB) e Pillow non disponibile "
                    f"per ridimensionare: {path.name}. Installa Pillow: pip install Pillow"
                )

    b64 = base64.standard_b64encode(data).decode("ascii")
    return {"mime": mime, "b64": b64}


async def analyze_reference_images(
    image_paths: list[Path],
    *,
    brief: str,
    style: str = "",
) -> dict[str, Any]:
    """
    Analizza fino a 12 immagini di riferimento e restituisce JSON strutturato
    per la pipeline CreateReel.
    """
    valid = [p.resolve() for p in image_paths if p.is_file()][: _MAX_IMAGES]
    if not valid:
        # No reference images: extract character anchors from brief via text-only LLM
        if brief and len(brief.strip()) > 20:
            try:
                from src.core.workflow.trailer_pipeline import _llm_json

                user_text_brief = build_reel_vision_user_prompt(
                    brief=brief,
                    style=style,
                    image_names=[],
                )
                raw = await asyncio.wait_for(
                    _llm_json(
                        REEL_VISION_SYSTEM,
                        user_text_brief + "\n\n(No reference images provided — synthesize character_anchors and environment_anchors strictly from the brief text above.)",
                        role="narrative_director",
                        temperature=0.4,
                        max_tokens=1024,
                    ),
                    timeout=60.0,
                )
                raw.setdefault("images", [])
                raw.setdefault("combined_style", style or "cinematic, photorealistic")
                raw.setdefault("character_anchors", [])
                raw.setdefault("environment_anchors", [])
                raw.setdefault("palette_hex", [])
                raw.setdefault("wardrobe_notes", "")
                raw.setdefault("continuity_rules", [])
                return raw
            except Exception as exc:
                log.warning("vision_brief_extraction_failed", error=str(exc))
        return {
            "images": [],
            "combined_style": style or "cinematic, photorealistic",
            "character_anchors": [],
            "environment_anchors": [],
            "palette_hex": [],
            "wardrobe_notes": "",
            "continuity_rules": [],
        }

    cfg = get_config()
    role = "vision_analyst"
    try:
        role_cfg = cfg.get_llm_for_role(role)
    except Exception:
        role_cfg = cfg.get_llm_for_role("narrative_director")

    adapter = get_llm_adapter(role_cfg)
    encoded = [_encode_image(p) for p in valid]
    user_text = build_reel_vision_user_prompt(
        brief=brief,
        style=style,
        image_names=[p.name for p in valid],
    )

    _text_fallback_note = "\n\n(Vision non disponibile su questo provider — inferisci solo dal brief.)"

    if hasattr(adapter, "generate_json_with_images"):
        try:
            raw = await adapter.generate_json_with_images(
                REEL_VISION_SYSTEM,
                user_text,
                images=encoded,
                temperature=0.4,
                max_tokens=4096,
            )
        except Exception as vision_err:
            log.warning(
                "vision_adapter_image_failed_fallback",
                provider=role_cfg.provider,
                model=role_cfg.model,
                error=str(vision_err),
            )
            from src.core.workflow.trailer_pipeline import _llm_json

            raw = await _llm_json(
                REEL_VISION_SYSTEM,
                user_text + _text_fallback_note,
                role="narrative_director",
                temperature=0.5,
                max_tokens=2048,
            )
    else:
        log.warning("vision_adapter_no_multimodal", provider=role_cfg.provider)
        from src.core.workflow.trailer_pipeline import _llm_json

        raw = await _llm_json(
            REEL_VISION_SYSTEM,
            user_text + _text_fallback_note,
            role="narrative_director",
            temperature=0.5,
            max_tokens=2048,
        )

    raw.setdefault("image_count", len(valid))
    return raw
