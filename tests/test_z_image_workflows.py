import json
from pathlib import Path

from src.core.comfyui.workflow_builder import (
    build_img2img_workflow,
    build_txt2img_workflow,
    scan_model_nodes,
)
from src.core.models.cinematic import FramePrompt
from src.core.utils.workflow_model_scanner import scan_workflow_models


ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / "config" / "workflows"


def _workflow(name: str) -> dict:
    return json.loads((WORKFLOWS / name).read_text(encoding="utf-8"))


def _assert_links_resolve(workflow: dict) -> None:
    node_ids = set(workflow)
    for node_id, node in workflow.items():
        for value in (node.get("inputs") or {}).values():
            if isinstance(value, list) and value and isinstance(value[0], str):
                assert value[0] in node_ids, f"{node_id} links missing node {value[0]}"


def test_z_image_turbo_txt2img_has_realism_lora_and_valid_links():
    workflow = _workflow("z_image_turbo_txt2img.json")
    _assert_links_resolve(workflow)

    loras = scan_model_nodes(workflow)["lora_nodes"]
    assert loras
    assert loras[0]["current_value"] == "skin\\zit_fdpo_v1.safetensors"
    assert workflow["57:11"]["inputs"]["model"] == ["57:31", 0]
    assert workflow["57:27"]["inputs"]["clip"] == ["57:31", 1]


def test_z_image_turbo_img2img_preserves_original_autoprompt_workflow():
    workflow = _workflow("z_image_turbo_img2img.json")
    manifest = _workflow("manifest.json")
    meta = next(w for w in manifest["workflows"] if w["id"] == "z_image_turbo_img2img")
    _assert_links_resolve(workflow)

    assert workflow["75"]["class_type"] == "LoadImage"
    assert workflow["102"]["class_type"] == "Textbox"
    assert workflow["127"]["class_type"] == "aistudynow_QwenVL"
    assert workflow["127"]["inputs"]["image"] == ["75", 0]
    assert workflow["127"]["inputs"]["custom_prompt"] == ["70", 0]
    assert workflow["124"]["inputs"]["any_01"] == ["68", 0]
    assert workflow["124"]["inputs"]["any_02"] == ["76", 0]
    assert workflow["90"]["inputs"]["text"] == ["124", 0]
    assert workflow["91"]["class_type"] == "CLIPTextEncode"
    assert workflow["125"]["inputs"]["any_01"] == ["12", 0]
    assert "any_02" not in workflow["125"]["inputs"]
    assert workflow["126"]["class_type"] == "ZImageTurboLoraStackV4"
    assert workflow["126"]["inputs"]["lora_name_1"] == "skin\\zit_fdpo_v1.safetensors"
    assert workflow["129"]["inputs"]["any_01"] == ["123", 0]
    assert workflow["129"]["inputs"]["any_02"] == ["130", 0]
    assert meta["output_nodes"] == ["139", "86"]
    assert meta["primary_output_node"] == "86"


def test_build_z_image_workflows_inject_parameters():
    txt = build_txt2img_workflow(
        FramePrompt(prompt="cinematic portrait", negative_prompt="watermark", seed=42),
        output_prefix="unit_txt",
        width=768,
        height=1280,
        steps=8,
        workflow_id="z_image_turbo_txt2img",
    )
    assert txt["57:27"]["inputs"]["text"].startswith("cinematic portrait")
    assert txt["57:13"]["inputs"]["width"] == 768
    assert txt["57:3"]["inputs"]["seed"] == 42
    assert txt["9"]["inputs"]["filename_prefix"] == "unit_txt"

    img = build_img2img_workflow(
        "reference.png",
        "make it more realistic",
        output_prefix="unit_img",
        steps=7,
        seed=99,
        negative_prompt="watermark",
        workflow_id="z_image_turbo_img2img",
    )
    assert img["75"]["inputs"]["image"] == "reference.png"
    assert img["102"]["inputs"]["text"] == "make it more realistic"
    assert img["91"]["inputs"]["text"] == "watermark"
    assert img["127"]["inputs"]["custom_prompt"] == ["70", 0]
    assert img["139"]["inputs"]["filename_prefix"] == "unit_img"
    assert img["86"]["inputs"]["filename_prefix"] == "unit_img"


def test_flux2_klein_reference_workflow_is_registered_and_injectable():
    workflow = _workflow("image_flux2_klein_9b_kv_image_reference_api.json")
    manifest = _workflow("manifest.json")
    meta = next(
        w for w in manifest["workflows"]
        if w["id"] == "flux2_klein_9b_kv_image_reference"
    )
    _assert_links_resolve(workflow)

    assert meta["type"] == "img2img"
    assert workflow["126"]["inputs"]["unet_name"] == "flux-2-klein-9b-kv-fp8.safetensors"
    assert workflow["133"]["inputs"]["clip_name"] == "qwen_3_8b_fp8mixed.safetensors"
    assert workflow["127"]["inputs"]["vae_name"] == "flux2-vae.safetensors"

    built = build_img2img_workflow(
        "uploaded_reference.png",
        "cinematic wardrobe transformation",
        output_prefix="unit_flux2_ref",
        steps=6,
        cfg=1.2,
        seed=1234,
        workflow_id="flux2_klein_9b_kv_image_reference",
    )
    assert built["76"]["inputs"]["image"] == "uploaded_reference.png"
    assert built["81"]["inputs"]["image"] == "uploaded_reference.png"
    assert built["135"]["inputs"]["text"] == "cinematic wardrobe transformation"
    assert built["125"]["inputs"]["noise_seed"] == 1234
    assert built["137"]["inputs"]["steps"] == 6
    assert built["138"]["inputs"]["cfg"] == 1.2
    assert built["94"]["inputs"]["filename_prefix"] == "unit_flux2_ref"


def test_flux2_klein_models_are_available_to_dynamic_provisioning():
    refs = {
        item["filename"]: item
        for item in scan_workflow_models(WORKFLOWS)
    }
    assert refs["flux-2-klein-9b-kv-fp8.safetensors"]["target_dir"] == "models/diffusion_models"
    assert refs["qwen_3_8b_fp8mixed.safetensors"]["target_dir"] == "models/text_encoders"
    assert refs["flux2-vae.safetensors"]["target_dir"] == "models/vae"
