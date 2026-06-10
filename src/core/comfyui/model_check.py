"""
Verifica che i modelli referenziati nei workflow ComfyUI esistano sul nodo.
"""

from __future__ import annotations

from typing import Any

from src.core.comfyui.workflow_builder import _get_wf_meta, _load_wf_json, _manifest

_LOADER_FIELDS: dict[str, tuple[str, str]] = {
    "VAELoader": ("vae_name", "vae"),
    "UNETLoader": ("unet_name", "unet"),
    "CLIPLoader": ("clip_name", "clip"),
    "CheckpointLoaderSimple": ("ckpt_name", "checkpoint"),
    "LoraLoader": ("lora_name", "lora"),
    "LoRALoader": ("lora_name", "lora"),
}

_Z_IMAGE_VAE_HINT = (
    "Il VAE ae.safetensors su questo nodo spesso non è quello ufficiale Z-Image "
    "(errore: shape invalid su VAELoader). "
    "Installa il ae.safetensors dal bundle Comfy-Org/z_image_turbo in ComfyUI/models/vae/."
)


def _options_from_object_info(info: dict, class_type: str, field: str) -> set[str]:
    cls = info.get(class_type) or {}
    required = cls.get("input", {}).get("required", {})
    raw = required.get(field)
    if raw is None:
        return set()
    if isinstance(raw, list):
        if raw and isinstance(raw[0], list):
            return {str(x) for x in raw[0]}
        return {str(x) for x in raw}
    return {str(raw)}


def collect_workflow_assets(workflow: dict) -> list[dict[str, str]]:
    """Estrae loader → nome file dal JSON workflow API."""
    assets: list[dict[str, str]] = []
    for node in workflow.values():
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type") or ""
        mapping = _LOADER_FIELDS.get(class_type)
        if not mapping:
            continue
        field, kind = mapping
        name = (node.get("inputs") or {}).get(field)
        if isinstance(name, str) and name.strip():
            assets.append({"kind": kind, "class_type": class_type, "name": name.strip()})
    return assets


def bypass_missing_loras(workflow: dict, missing: list[dict[str, str]]) -> list[str]:
    """
    Rimuove dal grafo le LoRA non disponibili e ricollega i consumer agli input
    model/clip originali. Checkpoint, UNet, CLIP e VAE restano obbligatori.
    """
    missing_names = {
        asset["name"]
        for asset in missing
        if asset.get("kind") == "lora" and asset.get("name")
    }
    if not missing_names:
        return []

    removed: list[str] = []
    for node_id, node in list(workflow.items()):
        if not isinstance(node, dict):
            continue
        if node.get("class_type") not in ("LoraLoader", "LoRALoader"):
            continue
        inputs = node.get("inputs") or {}
        if inputs.get("lora_name") not in missing_names:
            continue

        replacements = {
            0: inputs.get("model"),
            1: inputs.get("clip"),
        }
        for consumer in workflow.values():
            if not isinstance(consumer, dict):
                continue
            consumer_inputs = consumer.get("inputs") or {}
            for key, value in list(consumer_inputs.items()):
                if (
                    isinstance(value, list)
                    and len(value) == 2
                    and str(value[0]) == str(node_id)
                    and value[1] in replacements
                    and replacements[value[1]] is not None
                ):
                    consumer_inputs[key] = replacements[value[1]]

        del workflow[node_id]
        removed.append(str(inputs["lora_name"]))

    return removed


def validate_workflow_models(
    object_info: dict,
    workflow: dict,
    *,
    workflow_id: str | None = None,
) -> dict[str, Any]:
    """
    Confronta asset del workflow con object_info del nodo.
    Restituisce ok, missing[], present[], hints[].
    """
    assets = collect_workflow_assets(workflow)
    missing: list[dict[str, str]] = []
    present: list[dict[str, str]] = []

    for asset in assets:
        field, _ = _LOADER_FIELDS[asset["class_type"]]
        opts = _options_from_object_info(object_info, asset["class_type"], field)
        if asset["name"] in opts:
            present.append(asset)
        else:
            missing.append(asset)

    hints: list[str] = []
    if workflow_id == "z_image_txt2img" and any(
        a["name"] == "ae.safetensors" for a in assets if a["kind"] == "vae"
    ):
        hints.append(_Z_IMAGE_VAE_HINT)

    return {
        "ok": len(missing) == 0,
        "workflow_id": workflow_id,
        "missing": missing,
        "present": present,
        "hints": hints,
    }


def _meta_type_for_id(workflow_id: str) -> str:
    entry = next((w for w in _manifest().get("workflows", []) if w["id"] == workflow_id), None)
    return entry.get("type", "txt2img") if entry else "txt2img"


async def validate_workflow_on_node(client, workflow_id: str) -> dict[str, Any]:
    """Carica meta workflow + object_info nodo e valida."""
    meta = _get_wf_meta(workflow_id, _meta_type_for_id(workflow_id))
    wf = _load_wf_json(meta)
    info = await client.get_object_info()
    return validate_workflow_models(info, wf, workflow_id=workflow_id)
