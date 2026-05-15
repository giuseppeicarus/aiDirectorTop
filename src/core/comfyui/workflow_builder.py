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


WORKFLOWS_DIR = Path(__file__).parent.parent.parent.parent / "config" / "workflows"
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
        raise RuntimeError(f"Nessun workflow di tipo '{wf_type}' nel manifest. Configurare in Servizi → Workflow.")
    return found


def _load_wf_json(meta: dict) -> dict:
    path = WORKFLOWS_DIR / meta["file"]
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


# ── Public API ────────────────────────────────────────────────────────────────

def build_txt2img_workflow(
    frame: FramePrompt,
    output_prefix: str,
    width: int = 1024,
    height: int = 1024,
    workflow_id: Optional[str] = None,
) -> dict:
    meta = _get_wf_meta(workflow_id or "z_image_txt2img", "txt2img")
    wf   = _load_wf_json(meta)
    wf   = _inject(wf, meta.get("inject", {}), {
        "prompt":          frame.prompt,
        "negative_prompt": frame.negative_prompt or "",
        "width":           width,
        "height":          height,
        "seed":            frame.seed if frame.seed is not None else random.randint(0, 2**32),
    })
    _set_output_prefixes(wf, meta, output_prefix)
    return wf


def build_txt2video_workflow(
    prompt: str,
    output_prefix: str,
    width: int = 1280,
    height: int = 720,
    duration_sec: float = 6.0,
    fps: int = 25,
    workflow_id: Optional[str] = None,
) -> dict:
    meta = _get_wf_meta(workflow_id or "ltx_txt2video", "txt2video")
    wf   = _load_wf_json(meta)
    wf   = _inject(wf, meta.get("inject", {}), {
        "prompt":       prompt,
        "width":        width,
        "height":       height,
        "duration_sec": duration_sec,
        "fps":          fps,
        "seed":         random.randint(0, 2**32),
    })
    _set_output_prefixes(wf, meta, output_prefix)
    return wf


def build_img2video_workflow(
    shot: CinematicShot,
    first_frame_name: str,
    last_frame_name: str,
    output_prefix: str,
    audio_filename: Optional[str] = None,
    width: int = 1280,
    height: int = 720,
    duration_sec: float = 6.0,
    fps: int = 24,
    workflow_id: Optional[str] = None,
) -> dict:
    if audio_filename:
        wf_type = "img_audio2video"
        wf_id   = workflow_id or "ltx_img_audio2video"
    else:
        wf_type = "img2video"
        wf_id   = workflow_id or "ltx_txt2video"

    meta = _get_wf_meta(wf_id, wf_type)
    wf   = _load_wf_json(meta)
    wf   = _inject(wf, meta.get("inject", {}), {
        "first_image":  first_frame_name,
        "audio":        audio_filename or "",
        "prompt":       shot.motion_prompt or (shot.first_frame.prompt if shot.first_frame else ""),
        "width":        width,
        "height":       height,
        "duration_sec": duration_sec,
        "fps":          fps,
        "seed":         random.randint(0, 2**32),
    })
    _set_output_prefixes(wf, meta, output_prefix)
    return wf


def extract_output_files(history: dict) -> list[dict]:
    """Estrae file di output dalla history ComfyUI (images, videos, gifs)."""
    files = []
    for node_output in history.get("outputs", {}).values():
        for key in ("images", "videos", "gifs"):
            files.extend(node_output.get(key, []))
    return files


def list_workflows() -> list[dict]:
    return _manifest().get("workflows", [])


def get_workflow(workflow_id: str) -> tuple[dict, dict]:
    """Returns (meta, workflow_json)."""
    m = _manifest()
    meta = next((w for w in m["workflows"] if w["id"] == workflow_id), None)
    if not meta:
        raise KeyError(f"Workflow '{workflow_id}' non trovato")
    return meta, _load_wf_json(meta)
