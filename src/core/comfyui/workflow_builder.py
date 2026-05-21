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


# ── Public API — manifest-based ───────────────────────────────────────────────

def build_txt2img_workflow(
    frame: FramePrompt,
    output_prefix: str,
    width: int = 1024,
    height: int = 1024,
    steps: int = 25,
    workflow_id: Optional[str] = None,
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
        "prompt": shot.motion_prompt or (shot.first_frame.prompt if shot.first_frame else ""),
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
    _set_output_prefixes(wf, meta, output_prefix)
    return wf


def extract_output_files(history: dict) -> list[dict]:
    """Estrae file di output dalla history ComfyUI (images, videos, gifs)."""
    files = []
    for node_output in history.get("outputs", {}).values():
        for key in ("images", "videos", "gifs"):
            files.extend(node_output.get(key, []))
    return files


def extract_history_error(history: dict) -> str | None:
    """Messaggio errore ComfyUI da history (status_str=error)."""
    status = history.get("status")
    if not isinstance(status, dict):
        return None
    if status.get("status_str") != "error":
        return None
    parts: list[str] = []
    for msg in status.get("messages") or []:
        if isinstance(msg, (list, tuple)) and len(msg) >= 2:
            parts.append(str(msg[1]))
        elif isinstance(msg, str):
            parts.append(msg)
    detail = " | ".join(parts).strip()
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
