"""Async file-backed character creation service.

The current app already persists long-running reel jobs as JSON catalogues.
Characters use the same lightweight pattern and publish completed outputs into
the existing media_items table.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.config import get_config
from src.core.models.character import (
    CaptionMode,
    CharacterImage,
    CharacterLoraFile,
    CharacterProfile,
    CharacterRecord,
    CharacterSummary,
)
from src.core.models.media import MediaItemORM

MIN_CHARACTER_IMAGES = 20
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
LORA_EXTENSIONS = {".safetensors", ".pt", ".ckpt"}

PROFILE_CONFIGS: dict[CharacterProfile, dict] = {
    "Low": {
        "training_steps": 600,
        "resolution": 768,
        "batch_size": 1,
        "caption_strength": 0.65,
        "workflow": "character_low",
    },
    "Medium": {
        "training_steps": 1400,
        "resolution": 1024,
        "batch_size": 1,
        "caption_strength": 0.8,
        "workflow": "character_medium",
    },
    "High": {
        "training_steps": 2600,
        "resolution": 1024,
        "batch_size": 1,
        "caption_strength": 0.95,
        "workflow": "character_high",
    },
}


def utc_now() -> datetime:
    return datetime.now(tz=timezone.utc)


def owner_from_header(value: Optional[str]) -> str:
    return (value or "local_user").strip() or "local_user"


def character_root(owner_id: str) -> Path:
    root = get_config().app.data_path / "characters" / owner_id
    root.mkdir(parents=True, exist_ok=True)
    return root


def character_dir(owner_id: str, character_id: str) -> Path:
    return character_root(owner_id) / character_id


def manifest_path(owner_id: str, character_id: str) -> Path:
    return character_dir(owner_id, character_id) / "character.json"


def _read_record(path: Path) -> CharacterRecord | None:
    if not path.exists():
        return None
    try:
        return CharacterRecord(**json.loads(path.read_text(encoding="utf-8")))
    except Exception:
        return None


def save_record(record: CharacterRecord) -> None:
    record.updated_at = utc_now()
    out = manifest_path(record.owner_id, record.id)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(record.model_dump_json(indent=2), encoding="utf-8")


def list_records(owner_id: str, *, include_inactive: bool = False) -> list[CharacterRecord]:
    records: list[CharacterRecord] = []
    root = character_root(owner_id)
    for path in root.glob("*/character.json"):
        rec = _read_record(path)
        if rec and (include_inactive or rec.active):
            records.append(rec)
    return sorted(records, key=lambda r: r.created_at, reverse=True)


def get_record(owner_id: str, character_id: str) -> CharacterRecord | None:
    rec = _read_record(manifest_path(owner_id, character_id))
    if rec and rec.owner_id == owner_id and rec.active:
        return rec
    return None


def to_summary(record: CharacterRecord) -> CharacterSummary:
    return CharacterSummary(
        id=record.id,
        owner_id=record.owner_id,
        name=record.name,
        profile=record.profile,
        status=record.status,
        created_at=record.created_at,
        updated_at=record.updated_at,
        progress=record.progress,
        preview_path=record.preview_path,
        media_item_id=record.media_item_id,
        valid_image_count=record.valid_image_count,
        active=record.active,
    )


def validate_image_file(path: Path) -> tuple[bool, str, int, int]:
    if path.suffix.lower() not in IMAGE_EXTENSIONS:
        return False, "Formato immagine non supportato", 0, 0
    try:
        from PIL import Image as PILImage

        with PILImage.open(path) as img:
            img.verify()
        with PILImage.open(path) as img:
            width, height = img.size
        if width < 128 or height < 128:
            return False, "Immagine troppo piccola", width, height
        return True, "", width, height
    except Exception as exc:
        return False, f"Immagine non valida: {exc}", 0, 0


def image_digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _path_digest(path: Path) -> str:
    return hashlib.sha256(str(path.resolve()).encode("utf-8")).hexdigest()[:16]


def character_training_root() -> Path:
    from src.core.workflow.ai_toolkit_adapter import training_root

    return training_root()


def _allowed_character_file_roots(record: CharacterRecord) -> list[Path]:
    roots = [
        character_dir(record.owner_id, record.id),
        character_training_root() / record.id,
    ]
    return [root.resolve() for root in roots if root.exists()]


def _is_allowed_character_file(record: CharacterRecord, path: Path) -> bool:
    try:
        resolved = path.resolve()
    except Exception:
        return False
    for root in _allowed_character_file_roots(record):
        try:
            resolved.relative_to(root)
            return True
        except ValueError:
            continue
    return False


def list_lora_files(record: CharacterRecord) -> list[CharacterLoraFile]:
    """Return LoRA artifacts owned by this character and safe to download."""
    candidates: list[Path] = []
    ai_cfg = record.config.get("ai_toolkit") if isinstance(record.config, dict) else {}
    if isinstance(ai_cfg, dict):
        for key in ("lora_path", "output_dir"):
            raw = ai_cfg.get(key)
            if not raw:
                continue
            path = Path(str(raw)).expanduser()
            if path.is_file():
                candidates.append(path)
            elif path.is_dir():
                for ext in LORA_EXTENSIONS:
                    candidates.extend(path.rglob(f"*{ext}"))

    if record.output_path:
        output_path = Path(record.output_path).expanduser()
        if output_path.is_file():
            candidates.append(output_path)

    character_output = character_dir(record.owner_id, record.id) / "output"
    training_output = character_training_root() / record.id / "output"
    for folder in (character_output, training_output):
        if folder.is_dir():
            for ext in LORA_EXTENSIONS:
                candidates.extend(folder.rglob(f"*{ext}"))

    primary_path = ""
    if isinstance(ai_cfg, dict) and ai_cfg.get("lora_path"):
        primary_path = str(Path(str(ai_cfg["lora_path"])).expanduser().resolve())

    seen: set[str] = set()
    files: list[CharacterLoraFile] = []
    for path in candidates:
        if path.suffix.lower() not in LORA_EXTENSIONS or not path.is_file():
            continue
        if not _is_allowed_character_file(record, path):
            continue
        resolved = str(path.resolve())
        if resolved in seen:
            continue
        seen.add(resolved)
        stat = path.stat()
        files.append(
            CharacterLoraFile(
                id=_path_digest(path),
                filename=path.name,
                filepath=resolved,
                size_bytes=stat.st_size,
                created_at=datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc),
                primary=bool(primary_path and resolved == primary_path),
            )
        )
    return sorted(files, key=lambda item: (item.primary, item.created_at), reverse=True)


def get_lora_file(record: CharacterRecord, lora_id: str) -> Path | None:
    for item in list_lora_files(record):
        if item.id == lora_id:
            return Path(item.filepath)
    return None


def final_caption(mode: CaptionMode, manual: str, auto: str) -> str:
    manual = (manual or "").strip()
    auto = (auto or "").strip()
    if mode == "manuale":
        return manual
    if mode == "auto":
        return auto
    return manual or auto


def validate_dataset(images: Iterable[CharacterImage]) -> dict:
    items = list(images)
    valid = [img for img in items if img.valid and not img.duplicate]
    duplicates = [img for img in items if img.duplicate]
    invalid = [img for img in items if not img.valid]
    return {
        "valid_count": len(valid),
        "duplicate_count": len(duplicates),
        "invalid_count": len(invalid),
        "can_create": len(valid) >= MIN_CHARACTER_IMAGES,
        "min_required": MIN_CHARACTER_IMAGES,
        "errors": [img.error for img in invalid if img.error],
    }


def build_profile_config(profile: CharacterProfile) -> dict:
    return dict(PROFILE_CONFIGS.get(profile, PROFILE_CONFIGS["Low"]))


def auto_caption_for_image(character_name: str, image: CharacterImage) -> str:
    return (
        f"{character_name}, consistent character reference, "
        f"portrait dataset photo, natural identity details, image {image.width}x{image.height}"
    )


async def create_character_from_uploads(
    *,
    owner_id: str,
    name: str,
    profile: CharacterProfile,
    caption_mode: CaptionMode,
    uploads: list[tuple[str, bytes]],
    captions: list[str],
) -> CharacterRecord:
    character_id = uuid.uuid4().hex[:12]
    now = utc_now()
    base = character_dir(owner_id, character_id)
    image_dir = base / "images"
    image_dir.mkdir(parents=True, exist_ok=True)

    seen: set[str] = set()
    images: list[CharacterImage] = []
    for idx, (filename, content) in enumerate(uploads):
        suffix = Path(filename).suffix.lower() or ".jpg"
        dest = image_dir / f"img_{idx:03d}{suffix}"
        dest.write_bytes(content)
        digest = image_digest(dest)
        valid, error, width, height = validate_image_file(dest)
        duplicate = digest in seen
        seen.add(digest)
        manual = captions[idx].strip() if idx < len(captions) and captions[idx] else ""
        image = CharacterImage(
            id=uuid.uuid4().hex[:10],
            filename=filename,
            filepath=str(dest),
            sha256=digest,
            valid=valid,
            duplicate=duplicate,
            error="Duplicato" if duplicate else (error or None),
            manual_caption=manual,
            width=width,
            height=height,
        )
        image.auto_caption = auto_caption_for_image(name, image) if caption_mode in ("auto", "mista") else ""
        image.final_caption = final_caption(caption_mode, image.manual_caption, image.auto_caption)
        images.append(image)

    record = CharacterRecord(
        id=character_id,
        owner_id=owner_id,
        name=name.strip(),
        profile=profile or "Low",
        caption_mode=caption_mode or "mista",
        status="bozza",
        created_at=now,
        updated_at=now,
        progress=0,
        images=images,
        config=build_profile_config(profile or "Low"),
    )
    validation = validate_dataset(images)
    if not validation["can_create"]:
        record.status = "errore"
        record.error = f"Servono almeno {MIN_CHARACTER_IMAGES} immagini valide. Valide: {validation['valid_count']}."
        record.logs.append(record.error)
    else:
        record.status = "in_creazione"
        record.logs.append(f"Dataset validato: {validation['valid_count']} immagini valide.")
        if record.caption_mode in ("auto", "mista"):
            try:
                from src.core.workflow.character_captioning import recommend_caption_provider

                rec = recommend_caption_provider()
                record.logs.append(f"Caption automatiche: provider consigliato {rec.provider}/{rec.model} ({rec.role}).")
            except Exception as exc:
                from src.core.llm.style_improve import friendly_llm_error

                record.status = "errore"
                record.error = f"Caption automatiche LLM fallite: {friendly_llm_error(exc)}"
                record.logs.append(record.error)
    save_record(record)
    return record


async def publish_character_media(record: CharacterRecord, db: AsyncSession) -> CharacterRecord:
    media_path = record.preview_path or record.output_path
    if not media_path:
        return record
    existing = None
    if record.media_item_id:
        existing = await db.get(MediaItemORM, record.media_item_id)
    if existing is None:
        result = await db.execute(
            select(MediaItemORM).where(
                MediaItemORM.project_id == f"character:{record.id}",
                MediaItemORM.source == "character",
            )
        )
        existing = result.scalars().first()
    path = Path(media_path)
    width = height = 0
    if path.exists():
        try:
            from PIL import Image as PILImage

            with PILImage.open(path) as img:
                width, height = img.size
        except Exception:
            pass
    lora_path = (record.config.get("ai_toolkit") or {}).get("lora_path")
    tags = json.dumps(["Personaggi", "character", record.profile, record.status], ensure_ascii=False)
    if existing is None:
        existing = MediaItemORM(
            id=str(uuid.uuid4()),
            filename=path.name,
            filepath=str(path),
            type="image",
            project_id=f"character:{record.id}",
            project_title=record.name,
            source="character",
            tags=tags,
            description=f"Personaggio creato: {record.name} ({record.profile})" + (f"\nLoRA: {lora_path}" if lora_path else ""),
            width=width,
            height=height,
            size_bytes=path.stat().st_size if path.exists() else 0,
        )
        db.add(existing)
        await db.flush()
    else:
        existing.filename = path.name
        existing.filepath = str(path)
        existing.project_title = record.name
        existing.tags = tags
        existing.description = f"Personaggio creato: {record.name} ({record.profile})" + (f"\nLoRA: {lora_path}" if lora_path else "")
        existing.width = width
        existing.height = height
        existing.size_bytes = path.stat().st_size if path.exists() else 0
        await db.flush()
    record.media_item_id = existing.id
    save_record(record)
    return record


async def hide_character_media(record: CharacterRecord, db: AsyncSession) -> None:
    if record.media_item_id:
        item = await db.get(MediaItemORM, record.media_item_id)
        if item:
            await db.delete(item)
            await db.flush()
        record.media_item_id = None
    save_record(record)


async def run_character_creation(owner_id: str, character_id: str) -> None:
    from src.core.database import AsyncSessionLocal

    record = get_record(owner_id, character_id)
    if not record or record.status != "in_creazione":
        return
    try:
        stages = [
            (12, "Preparazione configurazione profilo"),
            (30, "Generazione caption finali"),
            (55, "Creazione identita visiva"),
            (78, "Validazione coerenza personaggio"),
            (92, "Preparazione anteprima e pubblicazione"),
        ]
        for progress, message in stages:
            await asyncio.sleep(0.05)
            record = get_record(owner_id, character_id) or record
            record.progress = progress
            record.logs.append(message)
            save_record(record)
            if message == "Generazione caption finali" and record.caption_mode in ("auto", "mista"):
                from src.core.workflow.character_captioning import generate_missing_auto_captions

                try:
                    generated = await generate_missing_auto_captions(record)
                    record.logs.append(f"Caption automatiche LLM generate: {generated}.")
                except Exception as exc:
                    record.logs.append(
                        f"Avviso non-critico: Generazione caption LLM non riuscita ({exc}). "
                        "Procedo con la generazione locale di caption di ripiego per non bloccare il training."
                    )
                    for image in record.images:
                        if not (image.auto_caption or "").strip():
                            image.auto_caption = f"{record.name}, cinematic portrait of {record.name}, high quality"
            for image in record.images:
                image.final_caption = final_caption(record.caption_mode, image.manual_caption, image.auto_caption)
            save_record(record)

        valid_images = [img for img in record.images if img.valid and not img.duplicate]
        if len(valid_images) < MIN_CHARACTER_IMAGES:
            raise RuntimeError(f"Dataset non valido: {len(valid_images)} immagini valide")

        from src.core.config import get_config
        from src.core.workflow.ai_toolkit_adapter import run_lora_start

        toolkit_mode = get_config().ai_toolkit.mode
        if toolkit_mode != "disabled":
            record.logs.append("Preparazione dataset ai-toolkit LoRA")
            save_record(record)
            try:
                lora_result = await run_lora_start(record, smoke_test=False)
            except Exception as exc:
                record.config["ai_toolkit"] = {
                    "status": "failed",
                    "error": str(exc) or exc.__class__.__name__,
                }
                record.logs.append(f"ai-toolkit fallito: {record.config['ai_toolkit']['error']}")
                if toolkit_mode == "required":
                    raise
                lora_result = None
            if lora_result is None:
                save_record(record)
            else:
                record.config["ai_toolkit"] = {
                    "status": lora_result.status,
                    "command": lora_result.command,
                    "config_path": lora_result.config_path,
                    "dataset_dir": lora_result.dataset_dir,
                    "output_dir": lora_result.output_dir,
                    "lora_path": lora_result.lora_path,
                    "stdout_tail": lora_result.stdout_tail,
                    "stderr_tail": lora_result.stderr_tail,
                    "error": lora_result.error,
                }
                if lora_result.ok and lora_result.lora_path:
                    record.logs.append(f"LoRA creato: {lora_result.lora_path}")
                    record.output_path = lora_result.lora_path
                else:
                    record.logs.append(f"ai-toolkit non disponibile o fallito: {lora_result.error}")
                    if toolkit_mode == "required":
                        raise RuntimeError(lora_result.error or "ai-toolkit training fallito")
                save_record(record)

        output_dir = character_dir(owner_id, character_id) / "output"
        output_dir.mkdir(parents=True, exist_ok=True)
        preview_src = Path(valid_images[0].filepath)
        preview_dest = output_dir / "preview.png"
        try:
            from PIL import Image as PILImage

            with PILImage.open(preview_src) as img:
                img.thumbnail((768, 768))
                img.convert("RGB").save(preview_dest, "PNG")
        except Exception:
            shutil.copy2(preview_src, preview_dest)

        record.preview_path = str(preview_dest)
        record.output_path = record.output_path or str(preview_dest)
        record.status = "completato"
        record.progress = 100
        record.logs.append("Personaggio completato")
        save_record(record)
        async with AsyncSessionLocal() as db:
            await publish_character_media(record, db)
            await db.commit()
    except Exception as exc:
        record = get_record(owner_id, character_id) or record
        record.status = "errore"
        record.error = str(exc)
        record.logs.append(f"Errore: {exc}")
        save_record(record)


def character_prompt_context(record: CharacterRecord) -> dict:
    valid_images = [img for img in record.images if img.valid and not img.duplicate]
    captions = [img.final_caption for img in valid_images if img.final_caption]
    return {
        "id": record.id,
        "name": record.name,
        "profile": record.profile,
        "reference_image_paths": [img.filepath for img in valid_images[:12]],
        "prompt_anchor": (
            f"Use created character '{record.name}' with strict visual identity consistency "
            f"across every clip. Preserve face, body proportions, hair, wardrobe anchors, "
            f"and recurring identity details."
        ),
        "caption_summary": "; ".join(captions[:8]),
        "continuity_rules": [
            f"{record.name} must keep the same face and identity in every clip",
            "do not change wardrobe anchors unless explicitly requested",
            "use the selected character dataset as the primary identity reference",
        ],
    }
