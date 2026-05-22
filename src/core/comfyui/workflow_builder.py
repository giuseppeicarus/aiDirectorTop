"""
ComfyUI Workflow Builder — carica workflow JSON dal manifest e inietta parametri pipeline.
I workflow vengono cercati in config/workflows/ relativo alla root del progetto.
"""

import copy
import json
import random
from pathlib import Path
from typing import Optional

from src.core.models.cinematic import FramePrompt, CinematicShot


PROJECT_ROOT = Path(__file__).parent.parent.parent.parent
WORKFLOWS_DIR = PROJECT_ROOT / "config" / "workflows"
BASE_WORKFLOWS_DIR = PROJECT_ROOT / "base_workflow_comfyui"
_MANIFEST_CACHE: Optional[dict] = None


def _manifest() -> dict:
    global _MANIFEST_CACHE
    if _MANIFEST_CACHE is not None:
        return _MANIFEST_CACHE
    p = WORKFLOWS_DIR / "manifest.json"
    if p.exists():
        _MANIFEST_CACHE = json.loads(p.read_text(encoding="utf-8"))
    else:
        _MANIFEST_CACHE = {"workflows": []}
    return _MANIFEST_CACHE


def sync_workflows_from_base() -> int:
    """Copia i workflow canonici da base_workflow_comfyui/ → config/workflows/."""
    if not BASE_WORKFLOWS_DIR.is_dir():
        return 0
    WORKFLOWS_DIR.mkdir(parents=True, exist_ok=True)
    updated = 0
    for src in sorted(BASE_WORKFLOWS_DIR.glob("*.json")):
        dest = WORKFLOWS_DIR / src.name
        data = src.read_bytes()
        if not dest.exists() or dest.read_bytes() != data:
            dest.write_bytes(data)
            updated += 1
    if updated:
        reload_manifest()
    return updated


def reload_manifest():
    global _MANIFEST_CACHE
    _MANIFEST_CACHE = None
    return _manifest()


def _get_wf_meta(workflow_id: Optional[str], wf_type: str) -> dict:
    m = _manifest()
    if workflow_id:
        found = next((w for w in m["workflows"] if w["id"] == workflow_id), None)
        if found:
            return found
    found = next((w for w in m["workflows"] if w["type"] == wf_type), None)
    if not found:
        raise RuntimeError(f"Nessun workflow di tipo '{wf_type}' nel manifest. Configurare in Servizi > Workflow.")
    return found


def _load_wf_json(meta: dict) -> dict:
    sync_workflows_from_base()
    path = WORKFLOWS_DIR / meta["file"]
    if not path.exists() and BASE_WORKFLOWS_DIR.is_dir():
        alt = BASE_WORKFLOWS_DIR / meta["file"]
        if alt.exists():
            path = alt
    if not path.exists():
        raise FileNotFoundError(f"File workflow non trovato: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def _inject(wf: dict, inject_map: dict, params: dict) -> dict:
    """Deep-copy workflow e inietta params nei nodi specificati nel manifest."""
    wf = copy.deepcopy(wf)
    for param_key, mapping in inject_map.items():
        val = params.get(param_key)
        if val is None:
            continue
        node_id = str(mapping["node"])
        field = mapping["field"]
        if node_id in wf:
            wf[node_id]["inputs"][field] = val
    return wf


def _set_output_prefixes(wf: dict, meta: dict, prefix: str):
    for node_id in meta.get("output_nodes", []):
        node_id = str(node_id)
        if node_id in wf:
            inp = wf[node_id].get("inputs", {})
            if "filename_prefix" in inp:
                inp["filename_prefix"] = prefix


# ── Model / LoRA override injection ──────────────────────────────────────────

_CHECKPOINT_LOADERS = frozenset({
    "CheckpointLoaderSimple", "CheckpointLoader",
})
_VIDEO_MODEL_LOADERS = frozenset({
    "LTXVModelLoader", "LTXVideoModelLoader", "WanVideoModelLoader",
    "UnetLoader", "UNETLoader",
})
_LORA_LOADERS = frozenset({
    "LoraLoader", "LoRALoader", "LtxvLoraLoader",
})


def scan_model_nodes(wf: dict) -> dict:
    """
    Scans a workflow dict and returns which nodes are model/LoRA loaders.

    Returns::
        {
          "checkpoint_nodes":   [{"node_id", "class_type", "current_value"}],
          "video_model_nodes":  [{"node_id", "class_type", "current_value"}],
          "lora_nodes":         [{"node_id", "class_type", "current_value", "strength_model", "strength_clip"}],
        }
    """
    checkpoint_nodes = []
    video_model_nodes = []
    lora_nodes = []

    for node_id, node in wf.items():
        ct = node.get("class_type", "")
        inputs = node.get("inputs", {})
        if ct in _CHECKPOINT_LOADERS:
            checkpoint_nodes.append({
                "node_id": node_id,
                "class_type": ct,
                "current_value": inputs.get("ckpt_name", ""),
            })
        elif ct in _VIDEO_MODEL_LOADERS:
            field = "unet_name" if ct in ("UnetLoader", "UNETLoader") else "model"
            video_model_nodes.append({
                "node_id": node_id,
                "class_type": ct,
                "current_value": inputs.get(field, ""),
            })
        elif ct in _LORA_LOADERS:
            lora_nodes.append({
                "node_id": node_id,
                "class_type": ct,
                "current_value": inputs.get("lora_name", ""),
                "strength_model": inputs.get("strength_model", 1.0),
                "strength_clip":  inputs.get("strength_clip",  1.0),
            })

    return {
        "checkpoint_nodes":  checkpoint_nodes,
        "video_model_nodes": video_model_nodes,
        "lora_nodes":        lora_nodes,
    }


def apply_model_overrides(wf: dict, overrides: Optional[dict]) -> dict:
    """
    Apply model / LoRA overrides to a workflow (in-place on a deep copy).

    overrides format::
        {
          "checkpoint":  "v1-5-pruned.ckpt",
          "video_model": "ltx-video-2b.safetensors",
          "loras": [
            {"lora_name": "film_grain.safetensors", "strength_model": 0.7, "strength_clip": 0.7}
          ]
        }

    Nodes are matched by class_type; LoRAs are applied in order of encounter
    within the workflow dict (i.e. by node_id sort order as returned by scan).
    """
    if not overrides:
        return wf

    wf = copy.deepcopy(wf)
    lora_node_ids: list[str] = []

    for node_id, node in wf.items():
        ct = node.get("class_type", "")
        inputs = node.get("inputs", {})

        if overrides.get("checkpoint") and ct in _CHECKPOINT_LOADERS:
            inputs["ckpt_name"] = overrides["checkpoint"]

        if overrides.get("video_model") and ct in _VIDEO_MODEL_LOADERS:
            field = "unet_name" if ct in ("UnetLoader", "UNETLoader") else "model"
            inputs[field] = overrides["video_model"]

        if ct in _LORA_LOADERS:
            lora_node_ids.append(node_id)

    lora_overrides: list[dict] = overrides.get("loras") or []
    for i, lo in enumerate(lora_overrides):
        if i >= len(lora_node_ids):
            break
        n_inputs = wf[lora_node_ids[i]]["inputs"]
        if lo.get("lora_name"):
            n_inputs["lora_name"] = lo["lora_name"]
        if lo.get("strength_model") is not None:
            n_inputs["strength_model"] = float(lo["strength_model"])
        clip_str = lo.get("strength_clip")
        if clip_str is None:
            clip_str = lo.get("strength_model")
        if clip_str is not None:
            n_inputs["strength_clip"] = float(clip_str)

    return wf


# ── Public API — manifest-based ───────────────────────────────────────────────

def build_txt2img_workflow(
    frame: FramePrompt,
    output_prefix: str,
    width: int = 1024,
    height: int = 1024,
    steps: int = 25,
    workflow_id: Optional[str] = None,
    model_overrides: Optional[dict] = None,
) -> dict:
    meta = _get_wf_meta(workflow_id or "z_image_txt2img", "txt2img")
    wf   = _load_wf_json(meta)
    wf   = _inject(wf, meta.get("inject", {}), {
        "prompt":          frame.prompt,
        "negative_prompt": frame.negative_prompt or "",
        "width":           width,
        "height":          height,
        "steps":           steps,
        "cfg":             4.0,
        "seed":            frame.seed if frame.seed is not None else random.randint(0, 2**32),
    })
    wf = apply_model_overrides(wf, model_overrides)
    _set_output_prefixes(wf, meta, output_prefix)
    return wf


def build_txt2video_workflow(
    prompt: str,
    output_prefix: str,
    width: int = 1280,
    height: int = 720,
    duration_sec: float = 6.0,
    fps: int = 25,
    steps: int = 25,
    workflow_id: Optional[str] = None,
    model_overrides: Optional[dict] = None,
) -> dict:
    meta = _get_wf_meta(workflow_id or "ltx_txt2video", "txt2video")
    wf   = _load_wf_json(meta)
    wf   = _inject(wf, meta.get("inject", {}), {
        "prompt":       prompt,
        "width":        width,
        "height":       height,
        "duration_sec": duration_sec,
        "fps":          fps,
        "steps":        steps,
        "seed":         random.randint(0, 2**32),
    })
    wf = apply_model_overrides(wf, model_overrides)
    _set_output_prefixes(wf, meta, output_prefix)
    return wf


def build_img2video_workflow(
    shot: CinematicShot,
    first_frame_name: str,
    last_frame_name: str,
    output_prefix: str,
    audio_filename: Optional[str] = None,
    audio_start_sec: float = 0.0,
    width: int = 1280,
    height: int = 720,
    duration_sec: float = 6.0,
    fps: int = 24,
    workflow_id: Optional[str] = None,
    *,
    use_audio_track: bool = False,
    model_overrides: Optional[dict] = None,
) -> dict:
    """
    use_audio_track=True → workflow con LoadAudio (music video / trailer).
    use_audio_track=False → solo immagine + prompt (AI Tools img2video).
    """
    wants_audio_wf = use_audio_track and bool(audio_filename)

    if workflow_id:
        wf_id = workflow_id
    elif wants_audio_wf:
        wf_id = "ltx_img_audio2video"
    else:
        wf_id = "ltx_img2video"

    wf_type = "img_audio2video" if wants_audio_wf else "img2video"
    meta = _get_wf_meta(wf_id, wf_type)
    wf   = _load_wf_json(meta)

    # LTX 2.3 "Length" (267:225) è in frame, non secondi
    length_frames = max(8, int(round(duration_sec * fps)))

    inject_params: dict = {
        "first_image": first_frame_name,
        "prompt": getattr(shot, 'ltx_video_prompt', None) or shot.motion_prompt or (shot.first_frame.prompt if shot.first_frame else ""),
        "width": width,
        "height": height,
        "duration_sec": length_frames,
        "fps": fps,
        "seed": random.randint(0, 2**32),
    }
    if wants_audio_wf:
        inject_params["audio"] = audio_filename
        inject_params["audio_start_sec"] = audio_start_sec

    wf = _inject(wf, meta.get("inject", {}), inject_params)
    wf = apply_model_overrides(wf, model_overrides)
    _set_output_prefixes(wf, meta, output_prefix)
    return wf


def extract_output_files(history: dict) -> list[dict]:
    """Estrae file di output dalla history ComfyUI (images, videos, gifs)."""
    files: list[dict] = []
    seen: set[str] = set()

    def _add(entry: dict) -> None:
        fn = entry.get("filename")
        if not fn or not isinstance(fn, str):
            return
        key = f"{fn}|{entry.get('subfolder', '')}|{entry.get('type', 'output')}"
        if key in seen:
            return
        seen.add(key)
        files.append({
            "filename": fn,
            "subfolder": entry.get("subfolder") or "",
            "type": entry.get("type") or "output",
        })

    for node_output in history.get("outputs", {}).values():
        if not isinstance(node_output, dict):
            continue
        for media_key in ("images", "videos", "gifs"):
            for item in node_output.get(media_key, []) or []:
                if isinstance(item, dict):
                    _add(item)

    def _walk(obj) -> None:
        if isinstance(obj, dict):
            if "filename" in obj and isinstance(obj.get("filename"), str):
                fn = obj["filename"].lower()
                if fn.endswith((".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")):
                    _add(obj)
            for v in obj.values():
                _walk(v)
        elif isinstance(obj, list):
            for item in obj:
                _walk(item)

    _walk(history.get("outputs", {}))
    return files


def inject_ws_executed_output(history: dict, node: str | None, output: dict) -> dict:
    """Unisce l'output del messaggio WS `executed` nella history (proxy spesso senza GET /history)."""
    if not output or not isinstance(output, dict):
        return history
    merged_hist = dict(history or {})
    outputs = dict(merged_hist.get("outputs") or {})
    key = str(node) if node else "executed_ws"
    node_out = dict(outputs.get(key) or {})
    for media_key, items in output.items():
        if isinstance(items, list):
            prev = node_out.get(media_key) or []
            node_out[media_key] = [*prev, *items]
        else:
            node_out[media_key] = items
    outputs[key] = node_out
    merged_hist["outputs"] = outputs
    return merged_hist


def extract_history_error(history: dict) -> str | None:
    """Messaggio errore ComfyUI da history (status_str=error)."""
    status = history.get("status")
    if not isinstance(status, dict):
        return None
    if status.get("status_str") != "error":
        return None
    parts: list[str] = []
    for msg in status.get("messages") or []:
        if not isinstance(msg, (list, tuple)) or len(msg) < 2:
            continue
        kind, payload = msg[0], msg[1]
        if kind != "execution_error" or not isinstance(payload, dict):
            continue
        node_type = payload.get("node_type") or "nodo"
        node_id = payload.get("node_id") or "?"
        exc = (payload.get("exception_message") or "").strip()
        exc_type = (payload.get("exception_type") or "").strip()
        head = f"{node_type} [{node_id}]"
        if exc_type:
            head = f"{head} ({exc_type})"
        parts.append(f"{head}: {exc}" if exc else head)
    detail = " | ".join(p for p in parts if p).strip()
    if detail and "VAELoader" in detail and (
        "shape" in detail.lower() or "invalid" in detail.lower()
    ):
        detail += (
            " — Verifica che ae.safetensors sia il VAE ufficiale Z-Image "
            "(Comfy-Org/z_image_turbo), non un file SD generico."
        )
    return detail or "ComfyUI execution error"


def list_workflows() -> list[dict]:
    return _manifest().get("workflows", [])


def get_workflow(workflow_id: str) -> tuple[dict, dict]:
    """Returns (meta, workflow_json)."""
    m = _manifest()
    meta = next((w for w in m["workflows"] if w["id"] == workflow_id), None)
    if not meta:
        raise KeyError(f"Workflow '{workflow_id}' non trovato")
    return meta, _load_wf_json(meta)


# ── Public API — LTX Director (programmatic) ──────────────────────────────────

def build_ltx_director_shot_workflow(
    shot: CinematicShot,
    first_frame_comfyui_name: str,
    last_frame_comfyui_name: str,
    output_prefix: str,
    **kwargs,
) -> dict:
    """
    Build an LTX Director 2.3 per-shot workflow.

    Delegates to ltx_director_builder to keep this module lean.
    Accepted kwargs: audio_comfyui_name, audio_start_sec, width, height, fps, cfg.
    """
    from src.core.comfyui.ltx_director_builder import (
        build_ltx_director_shot_workflow as _build,
    )
    return _build(shot, first_frame_comfyui_name, last_frame_comfyui_name,
                  output_prefix, **kwargs)


def build_ltx_director_full_video_workflow(
    shots: list[CinematicShot],
    story_arc,
    audio_analysis,
    audio_comfyui_name: Optional[str],
    output_prefix: str,
    **kwargs,
) -> dict:
    """
    Build an LTX Director 2.3 full-video (timeline) workflow.

    Delegates to ltx_director_builder.
    Accepted kwargs: width, height, fps, cfg.
    """
    from src.core.comfyui.ltx_director_builder import (
        build_ltx_director_full_video_workflow as _build,
    )
    return _build(shots, story_arc, audio_analysis,
                  audio_comfyui_name, output_prefix, **kwargs)
