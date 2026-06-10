"""
Scansiona i workflow ComfyUI installati ed estrae tutti i modelli referenziati.
Output: lista di ModelRef con filename, folder ComfyUI, class_type, workflow che lo usano.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

# Mapping class_type → (input_key, cartella ComfyUI)
_LOADER_MAP: dict[str, list[tuple[str, str]]] = {
    "CheckpointLoaderSimple":    [("ckpt_name",     "models/checkpoints")],
    "CheckpointLoader":          [("ckpt_name",     "models/checkpoints")],
    "LTXVLoader":                [("ckpt_name",     "models/video_models")],
    "LTXVAudioVAELoader":        [("ckpt_name",     "models/video_models")],
    "LTXAVTextEncoderLoader":    [("ckpt_name",     "models/video_models"),
                                  ("text_encoder",  "models/text_encoders")],
    "LoraLoader":                [("lora_name",     "models/loras")],
    "LoraLoaderModelOnly":       [("lora_name",     "models/loras")],
    "VAELoader":                 [("vae_name",      "models/vae")],
    "UpscaleModelLoader":        [("model_name",    "models/upscale_models")],
    "LatentUpscaleModelLoader":  [("model_name",    "models/upscale_models")],
    "CLIPLoader":                [("clip_name",     "models/text_encoders")],
    "DualCLIPLoader":            [("clip_name1",    "models/text_encoders"),
                                  ("clip_name2",    "models/text_encoders")],
    "UNETLoader":                [("unet_name",     "models/diffusion_models")],
    "ControlNetLoader":          [("control_net_name", "models/controlnet")],
    "IPAdapterModelLoader":      [("ipadapter",     "models/ipadapter")],
}


def _workflow_files(workflow_dir: Path) -> list[Path]:
    return [
        f for f in sorted(workflow_dir.glob("*.json"))
        if f.name != "manifest.json"
    ]


def scan_workflow_models(workflow_dir: Optional[Path] = None) -> list[dict]:
    """
    Scansiona tutti i workflow JSON e ritorna la lista de-duplicata di modelli.

    Ogni entry:
      {
        "filename":   "ltx-2.3-22b-dev-fp8.safetensors",
        "target_dir": "models/video_models",
        "class_type": "LTXVAudioVAELoader",
        "workflows":  ["workflow_a.json", "workflow_b.json"],
      }
    """
    if workflow_dir is None:
        workflow_dir = Path(__file__).parents[3] / "config" / "workflows"

    # filename → aggregated entry
    index: dict[str, dict] = {}

    for wf_path in _workflow_files(workflow_dir):
        try:
            data = json.loads(wf_path.read_text(encoding="utf-8"))
        except Exception:
            continue

        for node in data.values():
            if not isinstance(node, dict):
                continue
            ct = node.get("class_type", "")
            inputs = node.get("inputs", {})

            for loader_ct, fields in _LOADER_MAP.items():
                if ct != loader_ct:
                    continue
                for input_key, target_dir in fields:
                    val = inputs.get(input_key)
                    if not isinstance(val, str) or not val.strip():
                        continue
                    # Normalize Windows backslashes to forward slashes
                    fname = val.strip().replace("\\", "/")
                    if fname not in index:
                        index[fname] = {
                            "filename":   fname,
                            "target_dir": target_dir,
                            "class_type": ct,
                            "workflows":  [],
                        }
                    if wf_path.name not in index[fname]["workflows"]:
                        index[fname]["workflows"].append(wf_path.name)

    return sorted(index.values(), key=lambda x: (x["target_dir"], x["filename"]))
