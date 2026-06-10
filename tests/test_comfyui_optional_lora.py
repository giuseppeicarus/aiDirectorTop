from src.core.comfyui.model_check import (
    bypass_missing_loras,
    validate_workflow_models,
)


def test_missing_lora_is_bypassed_and_consumers_are_rewired():
    workflow = {
        "model": {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": "model.safetensors"},
        },
        "clip": {
            "class_type": "CLIPLoader",
            "inputs": {"clip_name": "clip.safetensors"},
        },
        "lora": {
            "class_type": "LoraLoader",
            "inputs": {
                "model": ["model", 0],
                "clip": ["clip", 0],
                "lora_name": "optional.safetensors",
            },
        },
        "sampler": {
            "class_type": "KSampler",
            "inputs": {"model": ["lora", 0]},
        },
        "encode": {
            "class_type": "CLIPTextEncode",
            "inputs": {"clip": ["lora", 1]},
        },
    }
    object_info = {
        "UNETLoader": {
            "input": {"required": {"unet_name": [["model.safetensors"]]}},
        },
        "CLIPLoader": {
            "input": {"required": {"clip_name": [["clip.safetensors"]]}},
        },
        "LoraLoader": {
            "input": {"required": {"lora_name": [[]]}},
        },
    }

    initial = validate_workflow_models(object_info, workflow)
    assert initial["ok"] is False

    removed = bypass_missing_loras(workflow, initial["missing"])

    assert removed == ["optional.safetensors"]
    assert "lora" not in workflow
    assert workflow["sampler"]["inputs"]["model"] == ["model", 0]
    assert workflow["encode"]["inputs"]["clip"] == ["clip", 0]
    assert validate_workflow_models(object_info, workflow)["ok"] is True


def test_missing_required_model_is_not_bypassed():
    workflow = {
        "model": {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": "missing.safetensors"},
        },
    }
    object_info = {
        "UNETLoader": {
            "input": {"required": {"unet_name": [["available.safetensors"]]}},
        },
    }
    check = validate_workflow_models(object_info, workflow)

    assert bypass_missing_loras(workflow, check["missing"]) == []
    assert "model" in workflow
