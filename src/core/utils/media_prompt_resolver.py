"""
Risolve il prompt di generazione per un MediaItemORM (description, checkpoint, shot list).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

from src.core.config import get_config
from src.core.models.media import MediaItemORM

_PROMPT_KEYS = (
    "prompt",
    "ltx_video_prompt",
    "motion_prompt",
    "first_frame_prompt",
    "last_frame_prompt",
    "scene_prompt",
    "ltx_global_prompt",
    "scene_description",
    "negative_prompt",
)


def _parse_tags(raw: Optional[str]) -> list[str]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            return [str(x) for x in parsed]
        if isinstance(parsed, dict):
            return []
    except json.JSONDecodeError:
        pass
    return [t.strip() for t in str(raw).split(",") if t.strip()]


def _clip_ref_from_tags(tags: list[str]) -> tuple[Optional[str], Optional[str]]:
    """Ritorna (clip_id, ruolo frame|clip)."""
    for i, tag in enumerate(tags):
        if tag in ("frame", "clip") and i + 1 < len(tags):
            return tags[i + 1], tag
    return None, None


def _first_non_empty(*values: Any, max_len: int = 2000) -> str:
    for v in values:
        if v is None:
            continue
        s = str(v).strip()
        if s:
            return s[:max_len]
    return ""


def _shot_id_from_filename(filename: str) -> tuple[Optional[str], Optional[str]]:
    stem = Path(filename).stem
    for ft in ("first", "last", "final"):
        if stem.endswith(f"_{ft}"):
            return stem[: -(len(ft) + 1)], ft
    return stem or None, None


def _index_project(project_id: str) -> dict[str, Any]:
    """Carica shot list cinematografica e clip reel/trailer da checkpoint."""
    root = get_config().app.data_path / "projects" / project_id
    shots: dict[str, dict] = {}
    clips: dict[str, dict] = {}

    state_path = root / "pipeline_state.json"
    if state_path.is_file():
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
            for shot in state.get("data", {}).get("shot_list") or []:
                sid = shot.get("shot_id")
                if sid:
                    shots[str(sid)] = shot
        except Exception:
            pass

    if root.is_dir():
        patterns = (
            "trailer_state_*.json",
            "reel_state_*.json",
            "reel_checkpoint_*.json",
        )
        for pattern in patterns:
            for cp_path in root.glob(pattern):
                try:
                    payload = json.loads(cp_path.read_text(encoding="utf-8"))
                except Exception:
                    continue
                clip_list = payload.get("clips")
                if not clip_list and isinstance(payload.get("data"), dict):
                    clip_list = payload["data"].get("clips")
                if not clip_list and isinstance(payload.get("result"), dict):
                    clip_list = payload["result"].get("clips")
                for clip in clip_list or []:
                    if not isinstance(clip, dict):
                        continue
                    cid = clip.get("clip_id")
                    if cid:
                        clips[str(cid)] = clip

    jobs_path = root / "reel_jobs.json"
    if jobs_path.is_file():
        try:
            jobs = json.loads(jobs_path.read_text(encoding="utf-8"))
            if isinstance(jobs, dict):
                for job in jobs.values():
                    if not isinstance(job, dict):
                        continue
                    res = job.get("result") or {}
                    for clip in res.get("clips") or []:
                        if isinstance(clip, dict) and clip.get("clip_id"):
                            clips[str(clip["clip_id"])] = clip
        except Exception:
            pass

    return {"shots": shots, "clips": clips}


class MediaPromptResolver:
    """Cache indici per progetto durante una richiesta dashboard."""

    def __init__(self) -> None:
        self._cache: dict[str, dict[str, Any]] = {}

    def _get_index(self, project_id: str) -> dict[str, Any]:
        if project_id not in self._cache:
            self._cache[project_id] = _index_project(project_id) if project_id else {"shots": {}, "clips": {}}
        return self._cache[project_id]

    def resolve(self, item: MediaItemORM) -> str:
        if item.description and str(item.description).strip():
            return str(item.description).strip()[:2000]

        tags = _parse_tags(item.tags)
        if tags:
            for tag in tags:
                if tag.startswith("prompt:"):
                    return tag[7:].strip()[:2000]

        clip_id, tag_role = _clip_ref_from_tags(tags)
        shot_id = item.shot_id or clip_id
        frame_type = item.frame_type
        if not shot_id:
            shot_id, inferred_ft = _shot_id_from_filename(item.filename)
            if inferred_ft and not frame_type:
                frame_type = inferred_ft

        if not shot_id or not item.project_id or item.project_id == "__tools__":
            return _prompt_from_tags_dict(item.tags)

        idx = self._get_index(item.project_id)
        clip = idx["clips"].get(str(shot_id))
        if clip:
            if item.type == "video" or tag_role == "clip":
                return _first_non_empty(
                    clip.get("ltx_video_prompt"),
                    clip.get("motion_prompt"),
                    clip.get("scene_prompt"),
                )
            if frame_type == "last" or tag_role == "last":
                return _first_non_empty(
                    clip.get("last_frame_prompt"),
                    clip.get("scene_prompt"),
                )
            return _first_non_empty(
                clip.get("first_frame_prompt"),
                clip.get("scene_prompt"),
            )

        shot = idx["shots"].get(str(shot_id))
        if shot:
            if item.type == "video":
                return _first_non_empty(
                    shot.get("ltx_video_prompt"),
                    shot.get("motion_prompt"),
                    shot.get("ltx_global_prompt"),
                )
            if frame_type == "last":
                lf = shot.get("last_frame") or {}
                return _first_non_empty(lf.get("prompt"), shot.get("scene_description"))
            ff = shot.get("first_frame") or {}
            return _first_non_empty(ff.get("prompt"), shot.get("scene_description"))

        return ""


def _prompt_from_tags_dict(tags_raw: Optional[str]) -> str:
    if not tags_raw:
        return ""
    try:
        parsed = json.loads(tags_raw)
        if isinstance(parsed, dict):
            return _first_non_empty(*(parsed.get(k) for k in _PROMPT_KEYS))
    except json.JSONDecodeError:
        pass
    return ""


def resolve_generation_prompt(item: MediaItemORM, resolver: Optional[MediaPromptResolver] = None) -> str:
    r = resolver or MediaPromptResolver()
    return r.resolve(item)


def resolve_fields(
    *,
    project_id: str,
    shot_id: Optional[str] = None,
    frame_type: Optional[str] = None,
    media_type: str = "image",
    tags: Optional[str] = None,
    filename: str = "",
    description: Optional[str] = None,
) -> str:
    """Risolve prompt da checkpoint/shot list senza ORM (fallback registrazione media)."""

    class _Fields:
        pass

    item = _Fields()
    item.description = description
    item.tags = tags
    item.project_id = project_id
    item.shot_id = shot_id
    item.frame_type = frame_type
    item.type = media_type
    item.filename = filename
    return MediaPromptResolver().resolve(item)  # type: ignore[arg-type]
