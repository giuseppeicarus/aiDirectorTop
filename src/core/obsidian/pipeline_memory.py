"""
Costruzione memoria Obsidian da checkpoint pipeline — tutto ciò che serve alla regia AI.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Optional

from src.core.obsidian.memory_format import (
    format_edl_md,
    format_execution_journal_append,
    format_final_deliverable_md,
    format_lyric_timing_md,
    format_production_config_md,
    format_shot_list_overview_md,
)

REEL_PHASE_LABELS: dict[int, str] = {
    1: "audio_analysis",
    2: "vision_analysis",
    3: "reel_director",
    4: "prompt_generator",
    5: "storyboard",
    55: "storyboard_or_production",
    99: "completed",
}

TRAILER_PHASE_LABELS: dict[int, str] = {
    1: "audio_analysis",
    3: "director_llm",
    4: "edl_validator",
    5: "audio_compositor",
    6: "assembly",
    55: "storyboard_or_production",
    99: "completed",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def phase_label(pipeline_kind: str, phase_num: int | None) -> str:
    if phase_num is None:
        return "unknown"
    if pipeline_kind == "reel":
        return REEL_PHASE_LABELS.get(int(phase_num), f"phase_{phase_num}")
    return TRAILER_PHASE_LABELS.get(int(phase_num), f"phase_{phase_num}")


def merge_slot_lyrics_into_edl(edl: Optional[dict], slot_lyrics: dict[str, str]) -> Optional[dict]:
    if not edl or not slot_lyrics:
        return edl
    out = dict(edl)
    slots_out: list[dict] = []
    for raw in out.get("slots") or []:
        if not isinstance(raw, dict):
            continue
        s = dict(raw)
        sid = s.get("slot_id") or s.get("id")
        if sid and sid in slot_lyrics:
            s["lyrics_segment"] = slot_lyrics[sid]
        slots_out.append(s)
    out["slots"] = slots_out
    return out


def visual_plan_for_slot(visual_plans: Any, slot_id: str) -> Optional[dict]:
    if not visual_plans or not slot_id:
        return None
    if isinstance(visual_plans, dict):
        vp = visual_plans.get(slot_id)
        if isinstance(vp, dict):
            return vp
        for v in visual_plans.values():
            if isinstance(v, dict) and v.get("slot_id") == slot_id:
                return v
    if isinstance(visual_plans, list):
        for v in visual_plans:
            if isinstance(v, dict) and v.get("slot_id") == slot_id:
                return v
    return None


def enrich_clip_with_visual_plan(clip: dict, visual_plans: Any) -> dict:
    """Unisce piano DP nello snapshot clip per la nota Obsidian."""
    out = dict(clip)
    sid = clip.get("slot_id") or ""
    vp = visual_plan_for_slot(visual_plans, sid)
    if not vp:
        return out
    for key in (
        "shot_type",
        "camera_shot",
        "camera_movement",
        "movement",
        "lens_mm",
        "lighting",
        "scene_description",
        "first_frame_state",
        "last_frame_state",
        "transition_in",
        "transition_out",
    ):
        if vp.get(key) and not out.get(key):
            out[key] = vp[key]
    return out


def build_journal_entry(
    *,
    pipeline_kind: str,
    project_id: str,
    job_id: str,
    checkpoint: dict[str, Any],
) -> str:
    phase_num = checkpoint.get("phase") or checkpoint.get("phase_completed")
    label = checkpoint.get("phase_label") or phase_label(pipeline_kind, phase_num)
    clips = checkpoint.get("clips_list") or []
    ready = sum(1 for c in clips if c.get("clip_path") or c.get("hd_frame_ready"))
    return format_execution_journal_append(
        ts=_now_iso(),
        phase_label=label,
        phase_num=phase_num,
        pipeline=pipeline_kind,
        project_id=project_id,
        job_id=job_id,
        clips_total=len(clips),
        clips_ready=ready,
        storyboard_approved=bool(checkpoint.get("storyboard_approved")),
        extra={
            "bpm": (checkpoint.get("audio_analysis_summary") or {}).get("bpm"),
            "lyric_lines": len(checkpoint.get("lyric_beats") or []),
            "edl_slots": len((checkpoint.get("edl") or {}).get("slots") or []),
        },
    )


def notes_from_reel_trailer_checkpoint(
    checkpoint: dict[str, Any],
    *,
    pipeline_kind: str,
    project_id: str,
    job_id: str,
    extra: Optional[dict[str, Any]] = None,
) -> list[tuple[str, dict[str, Any], str]]:
    """
    Ritorna [(rel_path, frontmatter, body), ...] da scrivere nel vault.
    """
    extra = extra or {}
    req = checkpoint.get("request") or extra.get("config") or {}
    if isinstance(req, dict) and extra.get("config"):
        req = {**req, **extra["config"]}

    out: list[tuple[str, dict[str, Any], str]] = []
    base_meta = {
        "project_id": project_id,
        "job_id": job_id,
        "pipeline": pipeline_kind,
        "tags": ["memory", pipeline_kind],
    }

    summary = checkpoint.get("audio_analysis_summary") or {}
    if summary or checkpoint.get("sections"):
        out.append((
            "Memory/02-Audio-Analysis.md",
            {**base_meta, "type": "audio_analysis"},
            _audio_analysis_body(checkpoint, summary),
        ))

    lyric_beats = checkpoint.get("lyric_beats") or []
    if lyric_beats:
        out.append((
            "Memory/03-Lyric-Timing.md",
            {**base_meta, "type": "lyric_timing", "line_count": len(lyric_beats)},
            format_lyric_timing_md(lyric_beats),
        ))

    lyrics = checkpoint.get("lyrics") or req.get("lyrics")
    if lyrics and str(lyrics).strip():
        out.append((
            "Memory/03-Lyrics-Source.md",
            {**base_meta, "type": "lyrics_source"},
            f"# Testo sorgente (utente)\n\n```\n{str(lyrics).strip()[:8000]}\n```\n",
        ))

    slot_lyrics = checkpoint.get("slot_lyrics") or {}
    if slot_lyrics:
        lines = ["# Lirica per slot EDL\n\n"]
        for sid, text in sorted(slot_lyrics.items()):
            lines.append(f"## `{sid}`\n{text}\n\n")
        out.append((
            "Memory/03-Slot-Lyrics.md",
            {**base_meta, "type": "slot_lyrics"},
            "".join(lines),
        ))

    if req:
        out.append((
            "Memory/06-Production-Config.md",
            {**base_meta, "type": "production_config"},
            format_production_config_md(req, pipeline=pipeline_kind),
        ))

    refs = checkpoint.get("reference_image_paths") or checkpoint.get("ref_paths") or []
    if refs:
        out.append((
            "Memory/07-Reference-Images.md",
            {**base_meta, "type": "references"},
            "# Immagini di riferimento\n\n" + "\n".join(f"- `{p}`" for p in refs[:40]) + "\n",
        ))

    final = checkpoint.get("final_deliverable")
    if final:
        out.append((
            "Memory/08-Final-Deliverable.md",
            {**base_meta, "type": "final_deliverable"},
            format_final_deliverable_md(final, pipeline=pipeline_kind),
        ))

    return out


def notes_from_cinematic_state(
    pipeline_state: dict[str, Any],
    *,
    project_id: str,
) -> list[tuple[str, dict[str, Any], str]]:
    out: list[tuple[str, dict[str, Any], str]] = []
    base_meta = {
        "project_id": project_id,
        "pipeline": "cinematic",
        "tags": ["memory", "cinematic"],
    }
    data = pipeline_state.get("data") or {}
    completed = pipeline_state.get("completed_stages") or []

    shot_list = data.get("shot_list") or []
    if shot_list:
        out.append((
            "Memory/03-Shot-List.md",
            {**base_meta, "type": "shot_list", "shot_count": len(shot_list)},
            format_shot_list_overview_md(shot_list),
        ))

    final = pipeline_state.get("final_deliverable")
    if final:
        out.append((
            "Memory/08-Final-Deliverable.md",
            {**base_meta, "type": "final_deliverable"},
            format_final_deliverable_md(final, pipeline="cinematic"),
        ))

    if completed:
        out.append((
            "Memory/09-Pipeline-Stages.md",
            {**base_meta, "type": "pipeline_stages"},
            "# Stage completati\n\n" + "\n".join(f"- `{s}`" for s in completed) + "\n",
        ))

    return out


def _audio_analysis_body(checkpoint: dict[str, Any], summary: dict) -> str:
    sections = checkpoint.get("sections") or []
    return (
        "# Analisi audio (librosa)\n\n"
        f"- BPM: {summary.get('bpm', '—')}\n"
        f"- Durata reel: {summary.get('duration_sec', checkpoint.get('audio_duration', '—'))}s\n"
        f"- Sezioni: {summary.get('sections', len(sections))}\n"
        f"- Beat lirici: {summary.get('lyric_lines', len(checkpoint.get('lyric_beats') or []))}\n"
        f"- Audio start (sorgente): {checkpoint.get('audio_start_sec', 0)}s\n\n"
        f"## Sezioni (JSON)\n```json\n"
        f"{json.dumps(sections[:25], indent=2, ensure_ascii=False)[:10000]}\n```\n"
    )
