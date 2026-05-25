from pathlib import Path

from src.core.models.character import CharacterImage, CharacterRecord
import src.core.workflow.character_service as character_service
from src.core.workflow.character_service import (
    MIN_CHARACTER_IMAGES,
    build_profile_config,
    final_caption,
    get_lora_file,
    list_lora_files,
    utc_now,
    validate_dataset,
    validate_image_file,
)


def test_character_profile_defaults_to_low_shape():
    cfg = build_profile_config("Low")
    assert cfg["workflow"] == "character_low"
    assert cfg["training_steps"] < build_profile_config("High")["training_steps"]


def test_caption_mista_prefers_manual_then_auto():
    assert final_caption("mista", "manual caption", "auto caption") == "manual caption"
    assert final_caption("mista", "", "auto caption") == "auto caption"
    assert final_caption("manuale", "", "auto caption") == ""
    assert final_caption("auto", "manual caption", "auto caption") == "auto caption"


def test_dataset_blocks_under_twenty_valid_images():
    images = [
        CharacterImage(
            id=str(i),
            filename=f"{i}.jpg",
            filepath=f"/tmp/{i}.jpg",
            sha256=str(i),
            valid=True,
        )
        for i in range(MIN_CHARACTER_IMAGES - 1)
    ]
    result = validate_dataset(images)
    assert result["valid_count"] == MIN_CHARACTER_IMAGES - 1
    assert result["can_create"] is False


def test_dataset_excludes_duplicates_and_invalid_images():
    images = [
        CharacterImage(id="1", filename="1.jpg", filepath="1.jpg", sha256="a", valid=True),
        CharacterImage(id="2", filename="2.jpg", filepath="2.jpg", sha256="a", valid=True, duplicate=True),
        CharacterImage(id="3", filename="3.jpg", filepath="3.jpg", sha256="b", valid=False, error="bad"),
    ]
    result = validate_dataset(images)
    assert result["valid_count"] == 1
    assert result["duplicate_count"] == 1
    assert result["invalid_count"] == 1
    assert result["errors"] == ["bad"]


def test_validate_image_file_rejects_non_image_extension(tmp_path: Path):
    path = tmp_path / "sample.txt"
    path.write_text("not an image", encoding="utf-8")
    valid, error, width, height = validate_image_file(path)
    assert valid is False
    assert "Formato" in error
    assert width == 0
    assert height == 0


def test_lora_files_are_listed_for_single_character(tmp_path: Path, monkeypatch):
    train_root = tmp_path / "training"
    character_root = tmp_path / "characters" / "u1" / "c1"
    output_dir = train_root / "c1" / "output"
    output_dir.mkdir(parents=True)
    lora_path = output_dir / "personaggio.safetensors"
    lora_path.write_bytes(b"lora")
    outside = tmp_path / "outside.safetensors"
    outside.write_bytes(b"outside")

    monkeypatch.setattr(character_service, "character_training_root", lambda: train_root)
    monkeypatch.setattr(character_service, "character_dir", lambda owner_id, character_id: character_root)

    record = CharacterRecord(
        id="c1",
        owner_id="u1",
        name="Test",
        created_at=utc_now(),
        updated_at=utc_now(),
        config={
            "ai_toolkit": {
                "lora_path": str(lora_path),
                "output_dir": str(output_dir),
            }
        },
        output_path=str(outside),
    )

    files = list_lora_files(record)

    assert [f.filename for f in files] == ["personaggio.safetensors"]
    assert files[0].primary is True
    assert get_lora_file(record, files[0].id) == lora_path


def test_caption_prefix_normalization():
    from src.core.workflow.character_captioning import _normalize_caption_prefix

    # Case 1: Name is not present at all
    assert _normalize_caption_prefix("wearing a red scarf", "Harry") == "Harry, wearing a red scarf"

    # Case 2: Name is present but lowercase
    assert _normalize_caption_prefix("harry wearing a red scarf", "Harry") == "Harry, wearing a red scarf"

    # Case 3: Name is present and starts with comma
    assert _normalize_caption_prefix("Harry, wearing a red scarf", "Harry") == "Harry, wearing a red scarf"

    # Case 4: Name is present but no comma
    assert _normalize_caption_prefix("Harry wearing a red scarf", "Harry") == "Harry, wearing a red scarf"


def test_captioning_robustness():
    from src.core.workflow.character_captioning import (
        _strip_reasoning_and_cleanup,
        _extract_raw_llm_response_from_error,
    )

    # Test reasoning block removal
    raw_with_think = "<think>Let's think. The image shows a boy.</think>Harry, a boy wearing a scarf"
    assert _strip_reasoning_and_cleanup(raw_with_think) == "Harry, a boy wearing a scarf"

    # Test JSON string parsing fallback
    raw_json_str = '{"caption": "Harry, wearing a red scarf"}'
    assert _strip_reasoning_and_cleanup(raw_json_str) == "Harry, wearing a red scarf"

    # Test raw text cleanup of surrounding braces/quotes
    raw_dirty = '{"Harry wearing a scarf"}'
    assert _strip_reasoning_and_cleanup(raw_dirty) == "Harry wearing a scarf"

    # Test ValueError raw text extraction
    err_msg = "No valid JSON found in LLM response: 'Harry wearing a scarf'"
    assert _extract_raw_llm_response_from_error(err_msg) == "Harry wearing a scarf"


def test_parse_and_update_progress():
    from src.core.workflow.ai_toolkit_adapter import parse_and_update_progress
    record = CharacterRecord(
        id="c1",
        owner_id="u1",
        name="Test",
        created_at=utc_now(),
        updated_at=utc_now(),
        config={"training_steps": 1000},
    )

    # Test tqdm parsing
    parse_and_update_progress(" 15%|█▍        | 150/1000 [00:10<00:54, 15.60it/s]", record)
    assert record.config["ai_toolkit_current_step"] == 150
    assert record.config["ai_toolkit_total_steps"] == 1000
    assert record.progress == 15 + int(0.15 * 80)  # 15 + 12 = 27

    # Test standard "step X/Y" parsing
    parse_and_update_progress("[ai-toolkit] step 500/1000", record)
    assert record.config["ai_toolkit_current_step"] == 500
    assert record.progress == 15 + int(0.50 * 80)  # 15 + 40 = 55

    # Test single step number parsing fallback
    parse_and_update_progress("Loss: 0.1234, Step: 750", record)
    assert record.config["ai_toolkit_current_step"] == 750
    assert record.progress == 15 + int(0.75 * 80)  # 15 + 60 = 75


