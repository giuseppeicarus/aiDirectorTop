"""API routes for Create Personaggio."""

from __future__ import annotations

import asyncio
import json
import re
import time
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.database import get_db
from src.core.models.character import (
    CaptionMode,
    CharacterLoraFile,
    CharacterProfile,
    CharacterRecord,
    CharacterSummary,
    CharacterUpdate,
)
from src.core.workflow.character_service import (
    MIN_CHARACTER_IMAGES,
    create_character_from_uploads,
    get_lora_file,
    get_record,
    hide_character_media,
    list_lora_files,
    list_records,
    owner_from_header,
    publish_character_media,
    run_character_creation,
    save_record,
    to_summary,
    validate_dataset,
)
from src.core.workflow.ai_toolkit_adapter import discover_toolkit_dir, docker_available
from src.core.workflow.character_captioning import recommend_caption_provider
from src.core.config import get_config
from src.core.utils.http_files import file_response

router = APIRouter()


class CharacterValidationResponse(BaseModel):
    valid_count: int
    duplicate_count: int
    invalid_count: int
    can_create: bool
    min_required: int
    errors: list[str]


class ContinueTrainingRequest(BaseModel):
    checkpoint_filename: str
    additional_steps: int = 500
    lr: float = 5e-5
    noise_offset: Optional[float] = None
    phase_name: str = ""


def _scan_character_training(record: CharacterRecord) -> Optional[dict]:
    """Scan the training directory for a character and return live progress info.

    Returns None if there is no active or partially-complete training to report.
    """
    from src.core.workflow.character_service import character_training_root
    import yaml as _yaml
    from datetime import datetime, timezone
    from urllib.parse import quote

    training_dir = character_training_root() / record.id
    if not training_dir.is_dir():
        return None

    lora_name = f"character_{record.id}_{record.profile.lower()}"
    config_path = training_dir / "config" / f"{lora_name}.yaml"

    # Read total_steps and save_every from YAML config
    total_steps = 0
    save_every = 200
    if config_path.is_file():
        try:
            with config_path.open("r", encoding="utf-8") as fh:
                cfg_yaml = _yaml.safe_load(fh) or {}
            # ai-toolkit YAML: config.process[0].train.steps
            train_cfg = (
                cfg_yaml.get("config", {})
                .get("process", [{}])[0]
                .get("train", {})
            )
            total_steps = int(train_cfg.get("steps", 0))
            save_every = int(train_cfg.get("save_every_n_steps", 200))
        except Exception:
            pass

    # Fall back to record config if YAML didn't yield steps
    if total_steps == 0:
        total_steps = record.config.get("training_steps", 0)
    if total_steps == 0:
        return None

    # Find checkpoint files matching  *_XXXXXXXX.safetensors
    output_dir = training_dir / "output" / lora_name
    checkpoint_files: list[tuple[int, Path]] = []
    if output_dir.is_dir():
        for p in output_dir.glob("*.safetensors"):
            m = re.search(r"_(\d+)\.safetensors$", p.name)
            if m:
                checkpoint_files.append((int(m.group(1)), p))

    checkpoint_files.sort(key=lambda t: t[0])
    current_step = checkpoint_files[-1][0] if checkpoint_files else 0

    # Determine whether training is actively running
    is_running = False
    try:
        from src.core.workflow.ai_toolkit_adapter import _ACTIVE_PROCESSES
        is_running = record.id in _ACTIVE_PROCESSES
    except Exception:
        pass

    # Nothing interesting to report
    if current_step == 0 or current_step >= total_steps:
        return None

    percent = round(current_step / total_steps * 100, 1) if total_steps > 0 else 0.0

    # ETA estimation: use mtime delta between the last two checkpoints
    eta_seconds: Optional[int] = None
    if len(checkpoint_files) >= 2 and save_every > 0:
        try:
            mtime1 = checkpoint_files[-2][1].stat().st_mtime
            mtime2 = checkpoint_files[-1][1].stat().st_mtime
            seconds_per_save_block = mtime2 - mtime1
            if seconds_per_save_block > 0:
                remaining_blocks = (total_steps - current_step) / save_every
                eta_seconds = int(remaining_blocks * seconds_per_save_block)
        except Exception:
            pass

    # Build checkpoints list
    checkpoints_out = []
    for step, path in checkpoint_files:
        try:
            stat = path.stat()
            size_bytes = stat.st_size
            created_at = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()
        except Exception:
            size_bytes = 0
            created_at = None
        checkpoints_out.append({
            "step": step,
            "filename": path.name,
            "size_bytes": size_bytes,
            "created_at": created_at,
        })

    # Latest sample image
    latest_sample_url: Optional[str] = None
    samples_dir = training_dir / "output" / lora_name / "samples"
    if not samples_dir.is_dir():
        samples_dir = training_dir / "output" / "samples"
    if samples_dir.is_dir() and current_step > 0:
        for ext in ("jpg", "png"):
            candidate = samples_dir / f"{lora_name}_{current_step:08d}_0.{ext}"
            if candidate.is_file():
                latest_sample_url = f"/api/reel/source?path={quote(str(candidate.resolve()))}"
                break
        # Fallback: most-recently-modified sample
        if not latest_sample_url:
            all_samples = sorted(
                [p for p in samples_dir.glob("*") if p.suffix.lower() in {".jpg", ".png"}],
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )
            if all_samples:
                latest_sample_url = f"/api/reel/source?path={quote(str(all_samples[0].resolve()))}"

    return {
        "character_id": record.id,
        "name": record.name,
        "profile": record.profile,
        "current_step": current_step,
        "total_steps": total_steps,
        "percent": percent,
        "is_running": is_running,
        "eta_seconds": eta_seconds,
        "checkpoints": checkpoints_out,
        "latest_sample_url": latest_sample_url,
    }


@router.get("/active-trainings")
async def get_active_trainings(x_user_id: Optional[str] = Header(None)):
    """Return all characters that have an active or partially-complete training job.

    This endpoint is intentionally independent of the character's `status` field so
    that externally-running jobs (e.g. PID started outside the app) are still surfaced
    in the GlobalActivityBanner.
    """
    owner_id = owner_from_header(x_user_id)
    records = list_records(owner_id)
    results = []
    for record in records:
        try:
            info = _scan_character_training(record)
            if info is not None and info["is_running"]:
                results.append(info)
        except Exception:
            pass
    return results


@router.get("/ai-toolkit/status")
async def ai_toolkit_status():
    cfg = get_config().ai_toolkit
    docker_image_present = False
    docker_error = ""
    if docker_available():
        try:
            from src.core.workflow.ai_toolkit_adapter import create_subprocess_exec_compatible
            proc = await create_subprocess_exec_compatible(
                "docker",
                "image",
                "inspect",
                cfg.docker_image,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _stdout, stderr = await proc.communicate(timeout=8)
            docker_image_present = proc.returncode == 0
            docker_error = stderr.decode("utf-8", errors="replace")[-1000:] if stderr else ""
        except Exception as exc:
            docker_error = str(exc)
    local_dir = discover_toolkit_dir()
    return {
        "mode": cfg.mode,
        "backend": cfg.backend,
        "docker": {
            "available": docker_available(),
            "image": cfg.docker_image,
            "image_present": docker_image_present,
            "gpus": cfg.docker_gpus,
            "error": docker_error,
        },
        "local": {
            "toolkit_dir": str(local_dir) if local_dir else "",
            "available": local_dir is not None,
        },
        "remote": {
            "url": cfg.remote_url,
            "configured": bool(cfg.remote_url),
            "has_api_key": bool(cfg.remote_api_key),
        },
    }


@router.get("/caption-provider/recommendation")
async def caption_provider_recommendation():
    rec = recommend_caption_provider()
    return {
        "provider": rec.provider,
        "model": rec.model,
        "role": rec.role,
        "available": rec.available,
        "reason": rec.reason,
        "warning": rec.warning,
    }


@router.post("/{character_id}/images/{image_id}/autocaption")
async def autocaption_single_image(
    character_id: str,
    image_id: str,
    x_user_id: Optional[str] = Header(None),
):
    owner_id = owner_from_header(x_user_id)
    record = get_record(owner_id, character_id)
    if not record:
        raise HTTPException(status_code=404, detail="Personaggio non trovato")

    target_image = None
    for img in record.images:
        if img.id == image_id:
            target_image = img
            break

    if not target_image:
        raise HTTPException(status_code=404, detail="Immagine non trovata nel personaggio")

    from src.core.workflow.character_captioning import (
        recommend_caption_provider,
        _generate_caption_chunk,
        _generate_caption_chunk_lmstudio,
    )
    from src.core.llm.factory import get_llm_adapter
    from src.core.llm.style_improve import friendly_llm_error

    rec = recommend_caption_provider()
    if not rec.available:
        raise HTTPException(status_code=400, detail=rec.reason)

    cfg = get_config().get_llm_for_role(rec.role) if rec.role != "global" else get_config().llm

    try:
        if (cfg.provider or "").lower() in {"lmstudio", "lm_studio"}:
            generated_map = await _generate_caption_chunk_lmstudio(cfg, record, [target_image])
        else:
            adapter = get_llm_adapter(cfg)
            generated_map = await asyncio.wait_for(
                _generate_caption_chunk(adapter, record, [target_image]),
                timeout=max(30, min(int(cfg.timeout_sec), 90)),
            )

        caption = generated_map.get(target_image.id, "")
        if not caption:
            raise ValueError("Il provider vision non ha restituito una caption valida")

        return {"caption": caption}
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Errore durante l'autocaption: {friendly_llm_error(exc)}",
        )


@router.get("/", response_model=list[CharacterSummary])
async def list_characters(
    ready_only: bool = False,
    x_user_id: Optional[str] = Header(None),
):
    owner_id = owner_from_header(x_user_id)
    records = list_records(owner_id)
    if ready_only:
        records = [r for r in records if r.status == "completato" and r.active]
    return [to_summary(r) for r in records]


@router.get("/{character_id}", response_model=CharacterRecord)
async def get_character(character_id: str, x_user_id: Optional[str] = Header(None)):
    owner_id = owner_from_header(x_user_id)
    record = get_record(owner_id, character_id)
    if not record:
        raise HTTPException(status_code=404, detail="Personaggio non trovato")
    return record


@router.get("/{character_id}/loras", response_model=list[CharacterLoraFile])
async def list_character_loras(character_id: str, x_user_id: Optional[str] = Header(None)):
    owner_id = owner_from_header(x_user_id)
    record = get_record(owner_id, character_id)
    if not record:
        raise HTTPException(status_code=404, detail="Personaggio non trovato")
    return list_lora_files(record)


@router.get("/{character_id}/checkpoints")
async def list_character_checkpoints(character_id: str, x_user_id: Optional[str] = Header(None)):
    owner_id = owner_from_header(x_user_id)
    record = get_record(owner_id, character_id)
    if not record:
        raise HTTPException(status_code=404, detail="Personaggio non trovato")

    from src.core.workflow.character_service import list_lora_files, character_training_root, character_dir
    from urllib.parse import quote
    from datetime import datetime, timezone

    lora_files = list_lora_files(record)

    samples_dir = character_training_root() / record.id / "output" / "samples"
    if not samples_dir.exists():
        samples_dir = character_dir(owner_id, record.id) / "output" / "samples"

    sample_images = {}
    if samples_dir.is_dir():
        for p in samples_dir.glob("*.png"):
            name_parts = p.stem.split('_')
            for part in name_parts:
                if len(part) == 8 and part.isdigit():
                    step = int(part)
                    sample_images[step] = str(p.resolve())
                    break

    steps = record.config.get("training_steps", 600)
    if steps <= 600:
        save_every = 200
    elif steps <= 1500:
        save_every = 350
    else:
        save_every = 500
    save_every = min(save_every, steps)

    expected_steps = list(range(save_every, steps + 1, save_every))
    if not expected_steps or expected_steps[-1] < steps:
        expected_steps.append(steps)

    checkpoints = []
    lora_map = {item.filename: item for item in lora_files}
    name = f"character_{record.id}_{record.profile.lower()}"

    for step in expected_steps:
        is_final = (step == steps)
        filename = f"{name}.safetensors" if is_final else f"{name}_{step:08d}.safetensors"

        lora_item = lora_map.get(filename)
        if not lora_item and is_final:
            for fname, item in lora_map.items():
                if fname == f"{name}.safetensors" or (name in fname and "000" not in fname):
                    lora_item = item
                    break

        sample_path = sample_images.get(step)

        checkpoints.append({
            "step": step,
            "total_steps": steps,
            "filename": filename,
            "exists": lora_item is not None,
            "lora_id": lora_item.id if lora_item else None,
            "size_bytes": lora_item.size_bytes if lora_item else 0,
            "created_at": lora_item.created_at if lora_item else None,
            "sample_path": sample_path,
            "sample_url": f"/api/reel/source?path={quote(sample_path)}" if sample_path else None,
        })

    found_steps = {cp["step"] for cp in checkpoints}
    for item in lora_files:
        name_parts = item.filename.split('_')
        step_val = None
        for part in name_parts:
            clean_part = part.replace(".safetensors", "").replace(".pt", "")
            if clean_part.isdigit() and len(clean_part) >= 3:
                step_val = int(clean_part)
                break

        if step_val and step_val not in found_steps:
            sample_path = sample_images.get(step_val)
            checkpoints.append({
                "step": step_val,
                "total_steps": steps,
                "filename": item.filename,
                "exists": True,
                "lora_id": item.id,
                "size_bytes": item.size_bytes,
                "created_at": item.created_at,
                "sample_path": sample_path,
                "sample_url": f"/api/reel/source?path={quote(sample_path)}" if sample_path else None,
            })

    checkpoints.sort(key=lambda cp: cp["step"])

    return {
        "current_step": record.config.get("ai_toolkit_current_step", 0),
        "total_steps": steps,
        "checkpoints": checkpoints,
    }


@router.get("/{character_id}/loras/{lora_id}/download")
async def download_character_lora(
    character_id: str,
    lora_id: str,
    x_user_id: Optional[str] = Header(None),
):
    owner_id = owner_from_header(x_user_id)
    record = get_record(owner_id, character_id)
    if not record:
        raise HTTPException(status_code=404, detail="Personaggio non trovato")
    path = get_lora_file(record, lora_id)
    if path is None or not Path(path).is_file():
        raise HTTPException(status_code=404, detail="LoRA non trovato")
    return file_response(Path(path), download_name=f"{record.name}_{Path(path).name}")


@router.post("/", response_model=CharacterRecord)
async def create_character(
    name: str = Form(...),
    profile: CharacterProfile = Form("Low"),
    caption_mode: CaptionMode = Form("mista"),
    captions_json: str = Form("[]"),
    files: List[UploadFile] = File(...),
    x_user_id: Optional[str] = Header(None),
):
    owner_id = owner_from_header(x_user_id)
    try:
        raw_captions = json.loads(captions_json or "[]")
        captions = [str(c or "") for c in raw_captions] if isinstance(raw_captions, list) else []
    except Exception:
        captions = []
    uploads = [(uf.filename or f"image_{i}.jpg", await uf.read()) for i, uf in enumerate(files)]
    record = await create_character_from_uploads(
        owner_id=owner_id,
        name=name,
        profile=profile or "Low",
        caption_mode=caption_mode or "mista",
        uploads=uploads,
        captions=captions,
    )
    if record.valid_image_count < MIN_CHARACTER_IMAGES:
        return record
    asyncio.create_task(run_character_creation(owner_id, record.id))
    return record


@router.post("/{character_id}/validate", response_model=CharacterValidationResponse)
async def validate_character(character_id: str, x_user_id: Optional[str] = Header(None)):
    owner_id = owner_from_header(x_user_id)
    record = get_record(owner_id, character_id)
    if not record:
        raise HTTPException(status_code=404, detail="Personaggio non trovato")
    return validate_dataset(record.images)


@router.patch("/{character_id}", response_model=CharacterRecord)
async def update_character(
    character_id: str,
    body: CharacterUpdate,
    x_user_id: Optional[str] = Header(None),
):
    owner_id = owner_from_header(x_user_id)
    record = get_record(owner_id, character_id)
    if not record:
        raise HTTPException(status_code=404, detail="Personaggio non trovato")
    if body.name is not None:
        record.name = body.name.strip() or record.name
    if body.profile is not None:
        record.profile = body.profile
    if body.caption_mode is not None:
        record.caption_mode = body.caption_mode
    if body.active is not None:
        record.active = body.active
    for image in record.images:
        if image.id in body.captions:
            image.manual_caption = body.captions[image.id]
        image.final_caption = image.manual_caption or image.auto_caption
    save_record(record)
    return record


@router.post("/{character_id}/continue-training", response_model=CharacterRecord)
async def continue_character_training(
    character_id: str,
    body: ContinueTrainingRequest,
    x_user_id: Optional[str] = Header(None),
):
    owner_id = owner_from_header(x_user_id)
    record = get_record(owner_id, character_id)
    if not record:
        raise HTTPException(status_code=404, detail="Personaggio non trovato")

    if record.status == "in_creazione":
        raise HTTPException(status_code=409, detail="Training già in corso — attendi il completamento")

    if body.additional_steps < 50 or body.additional_steps > 5000:
        raise HTTPException(status_code=400, detail="additional_steps deve essere tra 50 e 5000")

    from src.core.workflow.character_service import character_training_root
    from src.core.workflow.ai_toolkit_adapter import run_continue_lora

    training_dir = character_training_root() / character_id
    lora_name = f"character_{character_id}_{record.profile.lower()}"
    checkpoint_path = training_dir / "output" / lora_name / body.checkpoint_filename

    if not checkpoint_path.is_file():
        raise HTTPException(status_code=404, detail=f"Checkpoint non trovato: {body.checkpoint_filename}")

    # Determine continuation index (count existing cont configs)
    config_dir = training_dir / "config"
    existing_conts = list(config_dir.glob(f"{lora_name}_cont*.yaml")) if config_dir.exists() else []
    cont_index = len(existing_conts) + 1

    record.status = "in_creazione"
    record.progress = 0
    record.error = None
    save_record(record)

    asyncio.create_task(
        run_continue_lora(
            record, checkpoint_path, body.additional_steps, cont_index,
            lr=body.lr,
            noise_offset=body.noise_offset,
            phase_name=body.phase_name,
        )
    )

    return record


@router.post("/{character_id}/start", response_model=CharacterRecord)
async def start_character(
    character_id: str,
    x_user_id: Optional[str] = Header(None),
):
    owner_id = owner_from_header(x_user_id)
    record = get_record(owner_id, character_id)
    if not record:
        raise HTTPException(status_code=404, detail="Personaggio non trovato")
    validation = validate_dataset(record.images)
    if not validation["can_create"]:
        raise HTTPException(
            status_code=400,
            detail=f"Servono almeno {MIN_CHARACTER_IMAGES} immagini valide",
        )
    record.status = "in_creazione"
    record.progress = max(1, record.progress)
    record.error = None
    save_record(record)
    asyncio.create_task(run_character_creation(owner_id, record.id))
    return record


@router.delete("/{character_id}", status_code=204)
async def delete_character(
    character_id: str,
    db: AsyncSession = Depends(get_db),
    x_user_id: Optional[str] = Header(None),
):
    owner_id = owner_from_header(x_user_id)
    record = get_record(owner_id, character_id)
    if not record:
        raise HTTPException(status_code=404, detail="Personaggio non trovato")
    record.active = False
    record.status = "bozza" if record.status == "completato" else record.status
    await hide_character_media(record, db)


@router.post("/{character_id}/publish", response_model=CharacterRecord)
async def publish_character(
    character_id: str,
    db: AsyncSession = Depends(get_db),
    x_user_id: Optional[str] = Header(None),
):
    owner_id = owner_from_header(x_user_id)
    record = get_record(owner_id, character_id)
    if not record:
        raise HTTPException(status_code=404, detail="Personaggio non trovato")
    if record.status != "completato":
        raise HTTPException(status_code=400, detail="Solo personaggi completati possono essere pubblicati")
    return await publish_character_media(record, db)


@router.post("/{character_id}/pause", response_model=CharacterRecord)
async def pause_character(
    character_id: str,
    x_user_id: Optional[str] = Header(None),
):
    owner_id = owner_from_header(x_user_id)
    record = get_record(owner_id, character_id)
    if not record:
        raise HTTPException(status_code=404, detail="Personaggio non trovato")
    if record.status != "in_creazione":
        raise HTTPException(status_code=400, detail="Solo l'addestramento attivo può essere messo in pausa")

    from src.core.workflow.ai_toolkit_adapter import pause_training_process
    success = await pause_training_process(character_id)
    if not success:
        raise HTTPException(status_code=500, detail="Impossibile sospendere il processo di addestramento")

    record.status = "sospeso"
    record.logs.append("Addestramento sospeso dall'utente.")
    save_record(record)
    return record


@router.post("/{character_id}/resume", response_model=CharacterRecord)
async def resume_character(
    character_id: str,
    x_user_id: Optional[str] = Header(None),
):
    owner_id = owner_from_header(x_user_id)
    record = get_record(owner_id, character_id)
    if not record:
        raise HTTPException(status_code=404, detail="Personaggio non trovato")
    if record.status != "sospeso":
        raise HTTPException(status_code=400, detail="Solo l'addestramento sospeso può essere ripreso")

    from src.core.workflow.ai_toolkit_adapter import resume_training_process
    success = await resume_training_process(character_id)
    if not success:
        raise HTTPException(status_code=500, detail="Impossibile riprendere il processo di addestramento")

    record.status = "in_creazione"
    record.logs.append("Addestramento ripreso dall'utente.")
    save_record(record)
    return record


@router.post("/{character_id}/loras/{lora_id}/export")
async def export_character_lora(
    character_id: str,
    lora_id: str,
    target_dir: str,
    x_user_id: Optional[str] = Header(None),
):
    import shutil
    owner_id = owner_from_header(x_user_id)
    record = get_record(owner_id, character_id)
    if not record:
        raise HTTPException(status_code=404, detail="Personaggio non trovato")
    path = get_lora_file(record, lora_id)
    if path is None or not Path(path).is_file():
        raise HTTPException(status_code=404, detail="LoRA non trovato")

    dest_dir = Path(target_dir).expanduser()
    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest_path = dest_dir / Path(path).name
        shutil.copy2(path, dest_path)
        return {"ok": True, "message": f"Checkpoint copiato con successo in {dest_path}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Errore durante la copia del file: {str(e)}")
