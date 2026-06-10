"""LLM vision captioning for Create Personaggio datasets."""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import httpx

from src.core.config import LLMConfig, get_config
from src.core.llm.factory import get_llm_adapter
from src.core.llm.style_improve import friendly_llm_error
from src.core.llm.vision import _encode_image
from src.core.models.character import CharacterImage, CharacterRecord

VISION_PROVIDERS = {"openai", "anthropic", "lmstudio", "lm_studio"}

CAPTION_SYSTEM = """You are a professional dataset captioner for character LoRA training.
Analyze each attached image and write concise, factual captions.
Output ONLY valid JSON with this shape:
{"captions":[{"filename":"...", "caption":"..."}]}

CRITICAL RULES:
1. The caption for each image MUST start exactly with the character name provided in the user message (e.g., "[Character Name], ...").
2. Write in a factual, clean, and highly descriptive style.
3. Describe: face features, facial expression, hair style and color, wardrobe (clothes, colors), pose/action, framing type, lighting condition, and background elements.
4. Do not invent age, ethnicity, emotions, brands, or unseen details. Keep it objective and visual.
5. Keep each caption to one descriptive sentence, between 25 and 55 words.
6. Emphasize stable visual anchors that aid LoRA character consistency.
"""


@dataclass(frozen=True)
class CaptionProviderRecommendation:
    provider: str
    model: str
    role: str
    available: bool
    reason: str
    warning: str = ""


def _is_vision_provider(cfg: LLMConfig) -> bool:
    provider = (cfg.provider or "").lower()
    return provider in VISION_PROVIDERS


def recommend_caption_provider() -> CaptionProviderRecommendation:
    cfg = get_config()
    candidates: list[tuple[str, LLMConfig]] = []
    try:
        candidates.append(("vision_analyst", cfg.get_llm_for_role("vision_analyst")))
    except Exception:
        pass
    for role in ("prompt_engineer", "cinematographer", "narrative_director"):
        try:
            candidates.append((role, cfg.get_llm_for_role(role)))
        except Exception:
            continue
    candidates.append(("global", cfg.llm))

    seen: set[tuple[str, str, str | None]] = set()
    unique: list[tuple[str, LLMConfig]] = []
    for role, llm_cfg in candidates:
        key = (llm_cfg.provider, llm_cfg.model, llm_cfg.base_url)
        if key in seen:
            continue
        seen.add(key)
        unique.append((role, llm_cfg))

    for role, llm_cfg in unique:
        if _is_vision_provider(llm_cfg):
            warning = ""
            provider = (llm_cfg.provider or "").lower()
            if provider in {"lmstudio", "lm_studio"}:
                warning = "Verifica che il modello caricato in LM Studio sia realmente vision-capable."
            elif provider in {"openai", "anthropic"} and not llm_cfg.api_key:
                warning = "API key non configurata: la caption automatica fallira finche non viene impostata."
            return CaptionProviderRecommendation(
                provider=llm_cfg.provider,
                model=llm_cfg.model,
                role=role,
                available=True,
                reason=f"Selezionato {role}: provider compatibile con input immagine.",
                warning=warning,
            )

    global_cfg = cfg.llm
    return CaptionProviderRecommendation(
        provider=global_cfg.provider,
        model=global_cfg.model,
        role="global",
        available=False,
        reason="Nessun provider vision configurato. Usa OpenAI, Anthropic o LM Studio con modello vision.",
    )


def _caption_targets(record: CharacterRecord, images: Iterable[CharacterImage]) -> list[CharacterImage]:
    targets: list[CharacterImage] = []
    for image in images:
        if not image.valid or image.duplicate:
            continue
        if record.caption_mode == "auto":
            targets.append(image)
        elif record.caption_mode == "mista" and not (image.manual_caption or "").strip():
            targets.append(image)
    return targets


def _captions_by_image(raw: dict, chunk: list[CharacterImage]) -> dict[str, str]:
    captions = raw.get("captions") if isinstance(raw, dict) else []
    by_name = {
        str(item.get("filename", "")).strip(): str(item.get("caption", "")).strip()
        for item in captions
        if isinstance(item, dict)
    }
    fallback_items = [str(item.get("caption", "")).strip() for item in captions if isinstance(item, dict)]
    resolved: dict[str, str] = {}
    for idx, image in enumerate(chunk):
        caption = by_name.get(image.filename) or (fallback_items[idx] if idx < len(fallback_items) else "")
        if caption:
            resolved[image.id] = caption
    return resolved


async def _generate_caption_chunk(adapter, record: CharacterRecord, chunk: list[CharacterImage]) -> dict[str, str]:
    images_payload = []
    names = []
    valid_chunk = []
    for image in chunk:
        path = Path(image.filepath)
        if not path.is_file():
            continue
        images_payload.append(_encode_image(path))
        names.append(image.filename)
        valid_chunk.append(image)
    if not images_payload:
        return {}

    user = (
        f"Character name: {record.name}\n"
        f"Profile: {record.profile}\n"
        f"Images in order: {', '.join(names)}\n"
        f"Return one caption per image, preserving the exact filename values. "
        f"CRITICAL: Each caption MUST begin exactly with: '{record.name}, ' followed by the visual description."
    )
    try:
        raw = await adapter.generate_json_with_images(
            CAPTION_SYSTEM,
            user,
            images=images_payload,
            temperature=0.25,
            max_tokens=2400,
        )
        resolved = _captions_by_image(raw, valid_chunk)
    except Exception as exc:
        if len(valid_chunk) == 1:
            # Fallback 1: Extract from the JSON parsing ValueError if raised by the adapter
            error_msg = str(exc)
            extracted = _extract_raw_llm_response_from_error(error_msg)
            if extracted:
                resolved = {valid_chunk[0].id: _normalize_caption_prefix(extracted, record.name)}
            else:
                # Fallback 2: Make a direct text-only multimodal API call avoiding JSON
                try:
                    text_caption = await _generate_single_image_caption_fallback(adapter, record, valid_chunk[0])
                    resolved = {valid_chunk[0].id: text_caption}
                except Exception:
                    raise exc
        else:
            raise

    # Post-process: enforce character name prefix
    for img_id, caption in resolved.items():
        resolved[img_id] = _normalize_caption_prefix(caption, record.name)
    return resolved


def _parse_llm_json_text(raw: str) -> dict:
    clean = re.sub(r"```json?\s*", "", raw or "").replace("```", "").strip()
    try:
        return json.loads(clean)
    except json.JSONDecodeError:
        pass
    start = clean.find("{")
    end = clean.rfind("}")
    if start >= 0 and end > start:
        return json.loads(clean[start:end + 1])
    raise ValueError(f"No valid JSON found in LLM response: {raw[:200]!r}")


async def _generate_caption_chunk_lmstudio(cfg: LLMConfig, record: CharacterRecord, chunk: list[CharacterImage]) -> dict[str, str]:
    content: list[dict] = []
    names = []
    valid_chunk = []
    for image in chunk:
        path = Path(image.filepath)
        if not path.is_file():
            continue
        encoded = _encode_image(path)
        names.append(image.filename)
        valid_chunk.append(image)
        content.append({
            "type": "image_url",
            "image_url": {
                "url": f"data:{encoded['mime']};base64,{encoded['b64']}",
                "detail": "high",
            },
        })
    if not content:
        return {}

    user = (
        f"Character name: {record.name}\n"
        f"Profile: {record.profile}\n"
        f"Images in order: {', '.join(names)}\n"
        f"Return one caption per image, preserving the exact filename values. "
        f"CRITICAL: Each caption MUST begin exactly with: '{record.name}, ' followed by the visual description."
    )
    content.insert(0, {"type": "text", "text": user})
    base = (cfg.base_url or "http://localhost:1234/v1").rstrip("/")
    payload = {
        "model": cfg.model,
        "temperature": 0.25,
        "max_tokens": 2400,
        "messages": [
            {"role": "system", "content": CAPTION_SYSTEM},
            {"role": "user", "content": content},
        ],
    }
    headers = {}
    if cfg.api_key:
        headers["Authorization"] = f"Bearer {cfg.api_key}"
    async with httpx.AsyncClient(timeout=httpx.Timeout(max(30, min(int(cfg.timeout_sec), 120)))) as client:
        res = await client.post(f"{base}/chat/completions", json=payload, headers=headers)
        res.raise_for_status()
    data = res.json()
    message = ((data.get("choices") or [{}])[0].get("message") or {})
    raw = message.get("content") or message.get("reasoning_content") or ""
    
    try:
        resolved = _captions_by_image(_parse_llm_json_text(raw), valid_chunk)
    except Exception as exc:
        if len(valid_chunk) == 1:
            # Fallback 1: Treat the raw output as the caption directly (highly robust for local LLMs)
            clean_caption = _strip_reasoning_and_cleanup(raw)
            resolved = {valid_chunk[0].id: _normalize_caption_prefix(clean_caption, record.name)}
        else:
            raise

    # Post-process: enforce character name prefix
    for img_id, caption in resolved.items():
        resolved[img_id] = _normalize_caption_prefix(caption, record.name)
    return resolved


def _strip_reasoning_and_cleanup(raw: str) -> str:
    from src.core.llm.generation_prompt_sanitize import strip_llm_reasoning
    clean = strip_llm_reasoning(raw)
    clean = re.sub(r"```json?\s*", "", clean).replace("```", "").strip()
    
    # If the response happens to be JSON, try to extract from keys
    try:
        data = json.loads(clean)
        if isinstance(data, dict):
            if "caption" in data:
                return str(data["caption"])
            elif "captions" in data and isinstance(data["captions"], list) and len(data["captions"]) > 0:
                item = data["captions"][0]
                if isinstance(item, dict) and "caption" in item:
                    return str(item["caption"])
    except Exception:
        pass
        
    clean = clean.strip('{}[]"\' \t\n\r')
    if '"caption":' in clean:
        parts = clean.split('"caption":')
        if len(parts) > 1:
            caption_part = parts[1].split(',')[0].split('}')[0].strip(' \t\n\r"\'')
            if caption_part:
                return caption_part
    return clean


def _extract_raw_llm_response_from_error(error_msg: str) -> str:
    prefix = "No valid JSON found in LLM response:"
    if prefix in error_msg:
        idx = error_msg.find(prefix)
        raw_part = error_msg[idx + len(prefix):].strip()
        if (raw_part.startswith("'") and raw_part.endswith("'")) or (raw_part.startswith('"') and raw_part.endswith('"')):
            try:
                import ast
                return str(ast.literal_eval(raw_part))
            except Exception:
                return raw_part[1:-1]
        return raw_part
    return ""


async def _generate_single_image_caption_fallback(adapter, record: CharacterRecord, image: CharacterImage) -> str:
    path = Path(image.filepath)
    if not path.is_file():
        return ""
    encoded = _encode_image(path)
    
    fallback_system = (
        'You are a professional dataset captioner for character LoRA training. '
        'Analyze the image and write a concise, factual caption. '
        'RULES: caption MUST start with the character name. '
        'Describe face, hair, wardrobe, pose, framing, background. '
        'One sentence, 25-55 words. '
        'Respond with exactly: {"caption": "<text>"}'
    )
    user_prompt = (
        f"Character name: {record.name}\n"
        f"Profile: {record.profile}\n"
        f"Generate a caption starting with: '{record.name}, '"
    )

    try:
        result = await adapter.generate_json_with_images(
            fallback_system,
            user_prompt,
            images=[{"mime": encoded["mime"], "b64": encoded["b64"]}],
            temperature=0.25,
            max_tokens=300,
        )
        raw_text = result.get("caption", "") if isinstance(result, dict) else str(result)
        return _normalize_caption_prefix(raw_text, record.name)
    except NotImplementedError:
        pass
    return ""



def _normalize_caption_prefix(caption: str, character_name: str) -> str:
    c_strip = caption.strip()
    if not c_strip:
        return ""
    # Case-insensitive start check
    if not c_strip.lower().startswith(character_name.lower()):
        return f"{character_name}, {c_strip}"

    # If it already starts with the name, ensure correct capitalization and comma formatting
    name_len = len(character_name)
    after_name = c_strip[name_len:].strip()
    if after_name.startswith(","):
        after_name = after_name[1:].strip()
    return f"{character_name}, {after_name}"


async def generate_missing_auto_captions(record: CharacterRecord, *, chunk_size: int = 8) -> int:
    targets = _caption_targets(record, record.images)
    if not targets:
        return 0

    recommendation = recommend_caption_provider()
    if not recommendation.available:
        raise RuntimeError(recommendation.reason)

    cfg = get_config().get_llm_for_role(recommendation.role) if recommendation.role != "global" else get_config().llm
    if (cfg.provider or "").lower() in {"lmstudio", "lm_studio"}:
        chunk_size = min(chunk_size, 4)
        adapter = None
    else:
        adapter = get_llm_adapter(cfg)
    generated = 0
    errors: list[str] = []
    for start in range(0, len(targets), chunk_size):
        chunk = targets[start:start + chunk_size]
        try:
            if adapter is None:
                generated_map = await _generate_caption_chunk_lmstudio(cfg, record, chunk)
            else:
                generated_map = await asyncio.wait_for(
                    _generate_caption_chunk(adapter, record, chunk),
                    timeout=max(30, min(int(cfg.timeout_sec), 120)),
                )
        except Exception as exc:
            record.logs.append(f"Batch caption LLM fallito, riprovo singole immagini: {friendly_llm_error(exc)}")
            generated_map = {}
            for image in chunk:
                try:
                    if adapter is None:
                        generated_map.update(await _generate_caption_chunk_lmstudio(cfg, record, [image]))
                    else:
                        generated_map.update(await asyncio.wait_for(
                            _generate_caption_chunk(adapter, record, [image]),
                            timeout=max(30, min(int(cfg.timeout_sec), 90)),
                        ))
                except Exception as inner_exc:
                    errors.append(f"{image.filename}: {friendly_llm_error(inner_exc)}")
        for image in chunk:
            caption = generated_map.get(image.id, "")
            if caption:
                image.auto_caption = caption
                image.final_caption = image.manual_caption.strip() if record.caption_mode == "mista" and image.manual_caption.strip() else caption
                generated += 1
    if generated < len(targets):
        details = "; ".join(errors[:3])
        raise RuntimeError(
            f"Caption LLM incomplete: generate {generated}/{len(targets)} caption."
            + (f" Dettagli: {details}" if details else "")
        )
    return generated
