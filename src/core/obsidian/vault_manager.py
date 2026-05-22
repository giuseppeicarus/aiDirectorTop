"""
Vault Obsidian su filesystem — note Markdown con frontmatter YAML e wikilink.

Struttura:
  {vault}/00-Studio/Dashboard.md
  {vault}/Projects/{project_id}/_Project.md
  {vault}/Projects/{project_id}/Clips/{clip_id}.md
  {vault}/Projects/{project_id}/Shots/{shot_id}.md
  {vault}/Projects/{project_id}/Audio-Timeline.md
  {vault}/Projects/{project_id}/Workflows/{workflow_id}.md
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

import structlog
import yaml

from src.core.config import get_config
from src.core.obsidian.memory_format import (
    format_continuity_md,
    format_director_narrative_md,
    format_edl_md,
    format_project_brief,
    format_regia_memory_index,
    format_shot_regia_md,
    format_story_analysis_md,
    format_story_arc_md,
    format_visual_plans_md,
)
from src.core.obsidian.pipeline_memory import (
    build_journal_entry,
    enrich_clip_with_visual_plan,
    merge_slot_lyrics_into_edl,
    notes_from_cinematic_state,
    notes_from_reel_trailer_checkpoint,
    phase_label,
)

log = structlog.get_logger()

_SAFE = re.compile(r"[^\w.\-]+", re.UNICODE)


def _safe_name(value: str) -> str:
    return _SAFE.sub("_", (value or "unknown").strip())[:120] or "unknown"


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _fm(meta: dict[str, Any]) -> str:
    body = yaml.safe_dump(meta, allow_unicode=True, sort_keys=False, default_flow_style=False)
    return f"---\n{body}---\n\n"


def _wikilink(path_stem: str) -> str:
    """Link Obsidian senza estensione .md."""
    return path_stem.replace("\\", "/").removesuffix(".md")


class ObsidianVaultManager:
    def __init__(self, vault_path: Path) -> None:
        self.vault_path = vault_path.resolve()
        self.vault_path.mkdir(parents=True, exist_ok=True)

    def ensure_scaffold(self) -> None:
        studio = self.vault_path / "00-Studio"
        studio.mkdir(parents=True, exist_ok=True)
        dash = studio / "Dashboard.md"
        if not dash.exists():
            dash.write_text(
                _fm({
                    "type": "studio",
                    "tags": ["studio", "moc"],
                    "updated": _now_iso(),
                })
                + "# CinematicAI Studio — Vault\n\n"
                "Single Source of Truth per prompt, seed, workflow, frame, audio e metadata LTX.\n\n"
                "## Mappe\n"
                "- [[00-Studio/MOC-Projects]]\n",
                encoding="utf-8",
            )
        moc = studio / "MOC-Projects.md"
        if not moc.exists():
            moc.write_text(
                _fm({"type": "moc", "tags": ["moc"], "updated": _now_iso()})
                + "# Progetti\n\nIndice automatico sotto `Projects/`.\n",
                encoding="utf-8",
            )
        (self.vault_path / "Projects").mkdir(exist_ok=True)
        templates = self.vault_path / "Templates"
        templates.mkdir(exist_ok=True)
        tpl_clip = templates / "Clip-Memory.md"
        if not tpl_clip.exists():
            tpl_clip.write_text(
                _fm({"type": "template", "tags": ["template", "clip"]})
                + "# Template Clip\n\n"
                "## Prompts\n### Scena\n### First frame\n### Motion\n",
                encoding="utf-8",
            )
        from src.core.obsidian.ltx23_guide import ensure_ltx23_guide_in_vault

        ensure_ltx23_guide_in_vault(self.vault_path)

    @property
    def projects_dir(self) -> Path:
        return self.vault_path / "Projects"

    def project_dir(self, project_id: str) -> Path:
        d = self.projects_dir / _safe_name(project_id)
        d.mkdir(parents=True, exist_ok=True)
        for sub in ("Clips", "Shots", "Workflows", "Versions", "Frames", "Memory"):
            (d / sub).mkdir(exist_ok=True)
        return d

    def _write_note(self, rel_path: str, meta: dict[str, Any], body: str) -> Path:
        full = self.vault_path / rel_path
        full.parent.mkdir(parents=True, exist_ok=True)
        meta = {**meta, "updated": _now_iso()}
        full.write_text(_fm(meta) + body, encoding="utf-8")
        return full

    def sync_trailer_or_reel_checkpoint(
        self,
        *,
        project_id: str,
        job_id: str,
        pipeline_kind: str,
        checkpoint: dict[str, Any],
        extra: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        """Sincronizza checkpoint trailer/reel nel vault."""
        self.ensure_scaffold()
        pid = _safe_name(project_id)
        req = checkpoint.get("request") or {}
        if not req and extra:
            req = extra.get("config") or {}

        proj_meta = {
            "type": "project",
            "project_id": project_id,
            "job_id": job_id,
            "pipeline": pipeline_kind,
            "tags": [pipeline_kind, "project"],
        }
        proj_body = (
            f"# Progetto `{project_id}`\n\n"
            f"- Job: `{job_id}`\n"
            f"- Pipeline: **{pipeline_kind}**\n\n"
            f"## Collegamenti\n"
            f"- [[Projects/{pid}/Audio-Timeline]]\n"
            f"- [[Projects/{pid}/Story-Arc]]\n\n"
            f"## Clip\n"
        )

        clips = checkpoint.get("clips_list") or []
        clip_links: list[str] = []
        workflows_seen: set[str] = set()

        txt2img_wf = req.get("txt2img_workflow") or (extra or {}).get("txt2img_workflow")
        img2video_wf = req.get("img2video_workflow") or (extra or {}).get("img2video_workflow")
        visual_plans = checkpoint.get("visual_plans") or {}
        slot_lyrics = checkpoint.get("slot_lyrics") or {}

        for clip in clips:
            clip = enrich_clip_with_visual_plan(clip, visual_plans)
            cid = clip.get("clip_id") or "clip_unknown"
            safe_cid = _safe_name(cid)
            rel = f"Projects/{pid}/Clips/{safe_cid}.md"
            clip_links.append(f"- [[{_wikilink(rel)}]]")
            slot_id = clip.get("slot_id") or ""
            lyr_seg = slot_lyrics.get(slot_id) or clip.get("lyrics_segment") or ""

            wf_txt = txt2img_wf or ""
            wf_vid = img2video_wf or clip.get("comfyui_workflow") or ""
            if wf_txt:
                workflows_seen.add(wf_txt)
            if wf_vid:
                workflows_seen.add(wf_vid)

            meta = {
                "type": "clip",
                "project_id": project_id,
                "job_id": job_id,
                "clip_id": cid,
                "slot_id": clip.get("slot_id"),
                "clip_index": clip.get("clip_index"),
                "duration_sec": clip.get("duration_sec"),
                "timeline_start_sec": clip.get("start_sec"),
                "timeline_end_sec": clip.get("end_sec"),
                "audio_src_start_sec": clip.get("audio_src_start_sec"),
                "audio_src_end_sec": clip.get("audio_src_end_sec"),
                "txt2img_workflow": wf_txt,
                "img2video_workflow": wf_vid,
                "seed": clip.get("seed"),
                "status": clip.get("status"),
                "clip_phase": clip.get("clip_phase"),
                "storyboard_ok": clip.get("storyboard_ok"),
                "hd_frame_ready": clip.get("hd_frame_ready"),
                "tags": [pipeline_kind, "clip", "ltx", "memory"],
            }
            paths = {
                "first_frame": clip.get("first_frame_path"),
                "last_frame": clip.get("last_frame_path"),
                "storyboard": clip.get("storyboard_path"),
                "clip_video": clip.get("clip_path"),
                "audio_slice": clip.get("audio_slice_path"),
            }
            body = (
                f"# {cid}\n\n"
                f"Parent: [[Projects/{pid}/_Project]] | Memoria: [[Projects/{pid}/Memory/Regia-Memory]]\n\n"
                f"## Stato\n"
                f"- status: `{clip.get('status') or '—'}`\n"
                f"- phase: `{clip.get('clip_phase') or '—'}`\n"
                f"- storyboard_ok: `{clip.get('storyboard_ok')}`\n\n"
                f"## Timeline\n"
                f"- Reel: {clip.get('start_sec')}s → {clip.get('end_sec')}s\n"
                f"- Audio traccia: {clip.get('audio_src_start_sec')} → {clip.get('audio_src_end_sec')}s\n\n"
            )
            if lyr_seg:
                body += f"## Lirica (slot)\n{lyr_seg}\n\n"
            dp_bits = []
            if clip.get("shot_type") or clip.get("camera_shot"):
                dp_bits.append(f"- Inquadratura: {clip.get('shot_type') or clip.get('camera_shot')}")
            if clip.get("camera_movement") or clip.get("movement"):
                dp_bits.append(f"- Movimento: {clip.get('camera_movement') or clip.get('movement')}")
            if clip.get("lens_mm"):
                dp_bits.append(f"- Lens: {clip.get('lens_mm')}mm")
            if clip.get("lighting"):
                dp_bits.append(f"- Luce: {clip.get('lighting')}")
            if dp_bits:
                body += "## Piano DP (slot)\n" + "\n".join(dp_bits) + "\n\n"
            body += (
                f"## Workflow ComfyUI\n"
                f"- txt2img: `{wf_txt or '—'}`\n"
                f"- img2video: `{wf_vid or '—'}`\n"
                f"- Seed: `{clip.get('seed') or 'random-at-gen'}`\n\n"
                f"## Prompts\n"
                f"### Scena\n{clip.get('scene_prompt') or ''}\n\n"
                f"### First frame\n{clip.get('first_frame_prompt') or ''}\n\n"
                f"### Last frame\n{clip.get('last_frame_prompt') or ''}\n\n"
                f"### Motion\n{clip.get('motion_prompt') or ''}\n\n"
                f"### LTX video\n{clip.get('ltx_video_prompt') or ''}\n\n"
                f"### Negative\n{clip.get('negative_prompt') or ''}\n\n"
                f"## File\n"
            )
            for label, p in paths.items():
                if p:
                    body += f"- **{label}**: `{p}`\n"
            self._write_note(rel, meta, body)

            ver_rel = f"Projects/{pid}/Versions/{safe_cid}.jsonl"
            ver_path = self.vault_path / ver_rel
            ver_path.parent.mkdir(parents=True, exist_ok=True)
            entry = {"ts": _now_iso(), "clip": clip}
            with ver_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")

        proj_body += "\n".join(clip_links) + "\n"
        proj_body += (
            f"\n\n## Memoria regia\n"
            f"- [[Projects/{pid}/Memory/Regia-Memory]]\n"
            f"- [[Projects/{pid}/Memory/10-Execution-Journal]]\n"
            f"- [[Projects/{pid}/Story-Arc]]\n"
            f"- [[Projects/{pid}/Visual-Plans]]\n"
            f"- [[Projects/{pid}/EDL]]\n"
            f"- [[Projects/{pid}/Memory/08-Final-Deliverable]]\n"
        )
        phase = checkpoint.get("phase")
        if phase is not None:
            proj_meta["phase"] = phase
        proj_meta["storyboard_approved"] = bool(checkpoint.get("storyboard_approved"))
        self._write_note(f"Projects/{pid}/_Project.md", proj_meta, proj_body)

        audio_path = checkpoint.get("trailer_audio_path") or req.get("audio_path")
        sections = checkpoint.get("sections") or []
        downbeats = checkpoint.get("downbeats") or []
        audio_body = (
            f"# Audio Timeline\n\n"
            f"Progetto: [[Projects/{pid}/_Project]]\n\n"
            f"- Master: `{audio_path or '—'}`\n"
            f"- Durata analisi: {checkpoint.get('audio_duration', '—')}s\n\n"
            f"## Sezioni\n```json\n{json.dumps(sections[:40], indent=2, ensure_ascii=False)}\n```\n\n"
            f"## Downbeats (primi 80)\n`{downbeats[:80]}`\n"
        )
        self._write_note(
            f"Projects/{pid}/Audio-Timeline.md",
            {
                "type": "audio",
                "project_id": project_id,
                "job_id": job_id,
                "audio_path": audio_path,
                "tags": [pipeline_kind, "audio"],
            },
            audio_body,
        )

        narrative = checkpoint.get("director_narrative") or {}
        if narrative:
            self._write_note(
                f"Projects/{pid}/Story-Arc.md",
                {
                    "type": "story_arc",
                    "project_id": project_id,
                    "job_id": job_id,
                    "tags": [pipeline_kind, "narrative", "memory"],
                },
                format_director_narrative_md(narrative, pipeline=pipeline_kind),
            )

        vision = checkpoint.get("vision")
        if vision:
            self._write_note(
                f"Projects/{pid}/Vision.md",
                {"type": "vision", "project_id": project_id, "tags": [pipeline_kind, "vision", "memory"]},
                f"# Vision\n\n```json\n{json.dumps(vision, indent=2, ensure_ascii=False)}\n```\n",
            )

        visual_plans = checkpoint.get("visual_plans")
        if visual_plans:
            self._write_note(
                f"Projects/{pid}/Visual-Plans.md",
                {
                    "type": "visual_plans",
                    "project_id": project_id,
                    "tags": [pipeline_kind, "dp", "memory"],
                },
                format_visual_plans_md(visual_plans),
            )

        edl = merge_slot_lyrics_into_edl(checkpoint.get("edl"), slot_lyrics)
        if edl and isinstance(edl, dict):
            self._write_note(
                f"Projects/{pid}/EDL.md",
                {"type": "edl", "project_id": project_id, "tags": [pipeline_kind, "edl", "memory"]},
                format_edl_md(edl),
            )

        reel_desc = checkpoint.get("reel_description") or req.get("description") or ""
        if reel_desc:
            self._write_note(
                f"Projects/{pid}/Memory/00-Project-Brief.md",
                {"type": "brief", "project_id": project_id, "tags": ["brief", "memory"]},
                f"# Brief reel/trailer\n\n{reel_desc}\n",
            )

        phase_num = checkpoint.get("phase") or checkpoint.get("phase_completed")
        plabel = checkpoint.get("phase_label") or phase_label(pipeline_kind, phase_num)
        completed = [plabel] if plabel else []
        if checkpoint.get("storyboard_approved"):
            completed.append("storyboard_approved")

        self._write_note(
            f"Projects/{pid}/Memory/Regia-Memory.md",
            {
                "type": "regia_memory",
                "project_id": project_id,
                "job_id": job_id,
                "pipeline": pipeline_kind,
                "phase": phase_num,
                "phase_label": plabel,
                "tags": ["memory", "regia", pipeline_kind],
            },
            format_regia_memory_index(
                pipeline=pipeline_kind,
                project_id=project_id,
                job_id=job_id,
                completed_stages=completed,
                phase_label=plabel,
            ),
        )

        self._write_extended_memory_notes(
            project_id=project_id,
            job_id=job_id,
            pipeline_kind=pipeline_kind,
            checkpoint=checkpoint,
            extra=extra,
        )
        self._append_execution_journal(
            project_id=project_id,
            job_id=job_id,
            pipeline_kind=pipeline_kind,
            checkpoint=checkpoint,
        )

        for wf_id in workflows_seen:
            self._sync_workflow_note(pid, wf_id, project_id)

        self._refresh_moc_projects()

        log.info(
            "obsidian_vault_synced",
            project_id=project_id,
            job_id=job_id,
            clips=len(clips),
        )
        return {
            "vault_path": str(self.vault_path),
            "project_note": f"Projects/{pid}/_Project.md",
            "clips_synced": len(clips),
        }

    def sync_cinematic_pipeline(
        self,
        *,
        project_id: str,
        pipeline_state: dict[str, Any],
    ) -> dict[str, Any]:
        """Sincronizza pipeline_state.json (5 LLM + shot list) — memoria regia completa."""
        self.ensure_scaffold()
        pid = _safe_name(project_id)
        self.project_dir(project_id)
        data = pipeline_state.get("data") or {}
        shot_list = data.get("shot_list") or []
        completed = pipeline_state.get("completed_stages") or []
        project_input = pipeline_state.get("project_input") or data.get("project_input") or {}

        if project_input:
            self._write_note(
                f"Projects/{pid}/Memory/00-Project-Brief.md",
                {"type": "brief", "project_id": project_id, "tags": ["cinematic", "brief", "memory"]},
                format_project_brief(project_input),
            )

        story_analysis = data.get("story_analysis")
        if story_analysis:
            self._write_note(
                f"Projects/{pid}/Memory/01-Story-Analysis.md",
                {"type": "story_analysis", "project_id": project_id, "tags": ["cinematic", "memory", "llm1"]},
                format_story_analysis_md(story_analysis),
            )

        story_arc = data.get("story_arc")
        if story_arc:
            self._write_note(
                f"Projects/{pid}/Story-Arc.md",
                {"type": "story_arc", "project_id": project_id, "tags": ["cinematic", "memory", "llm2"]},
                format_story_arc_md(story_arc),
            )

        continuity = data.get("continuity_report")
        if continuity:
            self._write_note(
                f"Projects/{pid}/Memory/04-Continuity.md",
                {"type": "continuity", "project_id": project_id, "tags": ["cinematic", "memory", "llm5"]},
                format_continuity_md(continuity),
            )

        shot_links: list[str] = []
        for shot in shot_list:
            sid = shot.get("shot_id") or "shot_unknown"
            safe_sid = _safe_name(sid)
            ff = shot.get("first_frame") or {}
            lf = shot.get("last_frame") or {}
            rel = f"Projects/{pid}/Shots/{safe_sid}.md"
            shot_links.append(f"- [[{_wikilink(rel)}]]")
            meta = {
                "type": "shot",
                "project_id": project_id,
                "shot_id": sid,
                "sequence_id": shot.get("sequence_id"),
                "scene_id": shot.get("scene_id"),
                "duration_sec": shot.get("duration_sec"),
                "time_start": shot.get("time_start"),
                "time_end": shot.get("time_end"),
                "comfyui_workflow": shot.get("comfyui_workflow"),
                "seed_first": ff.get("seed"),
                "seed_last": lf.get("seed"),
                "tags": ["cinematic", "shot", "memory"],
            }
            self._write_note(rel, meta, format_shot_regia_md(shot))
            wf = shot.get("comfyui_workflow")
            if wf:
                self._sync_workflow_note(pid, str(wf), project_id)
            if ff.get("image_path"):
                frame_name = _safe_name(sid) + "_first"
                self._write_note(
                    f"Projects/{pid}/Frames/{frame_name}.md",
                    {"type": "frame", "shot_id": sid, "tags": ["frame"]},
                    f"# Frame first — {sid}\n\nPath: `{ff.get('image_path')}`\n",
                )

        self._write_note(
            f"Projects/{pid}/Memory/Regia-Memory.md",
            {
                "type": "regia_memory",
                "project_id": project_id,
                "pipeline": "cinematic",
                "tags": ["memory", "regia", "cinematic"],
            },
            format_regia_memory_index(
                pipeline="cinematic",
                project_id=project_id,
                completed_stages=completed,
                phase_label=completed[-1] if completed else "",
            ),
        )

        for rel, meta, body in notes_from_cinematic_state(pipeline_state, project_id=project_id):
            self._write_note(f"Projects/{pid}/{rel}", meta, body)

        self._append_execution_journal(
            project_id=project_id,
            job_id="",
            pipeline_kind="cinematic",
            checkpoint={
                "phase_label": completed[-1] if completed else "sync",
                "clips_list": shot_list,
                "final_deliverable": pipeline_state.get("final_deliverable"),
            },
        )

        proj_body = (
            f"# Progetto cinematic `{project_id}`\n\n"
            f"- Stage completati: {', '.join(completed) if completed else '—'}\n"
            f"- Shots: {len(shot_list)}\n\n"
            f"## Memoria\n"
            f"- [[Projects/{pid}/Memory/Regia-Memory]]\n"
            f"- [[Projects/{pid}/Memory/01-Story-Analysis]]\n"
            f"- [[Projects/{pid}/Story-Arc]]\n"
            f"- [[Projects/{pid}/Memory/04-Continuity]]\n\n"
            f"## Shot list\n"
            + "\n".join(shot_links)
            + "\n"
        )
        self._write_note(
            f"Projects/{pid}/_Project.md",
            {
                "type": "project",
                "project_id": project_id,
                "pipeline": "cinematic",
                "tags": ["cinematic", "memory"],
                "completed_stages": completed,
            },
            proj_body,
        )
        self._refresh_moc_projects()
        return {"shots_synced": len(shot_list), "stages": completed}

    def sync_director_cinema(
        self,
        *,
        project_id: str,
        project: dict[str, Any],
    ) -> dict[str, Any]:
        """Sincronizza progetto Director Cinema (localStorage) nel vault."""
        self.ensure_scaffold()
        pid = _safe_name(project_id)
        self.project_dir(project_id)

        clips = project.get("clips") or []
        clip_links: list[str] = []

        for clip in clips:
            cid = clip.get("id") or "clip_unknown"
            safe_cid = _safe_name(str(cid))
            rel = f"Projects/{pid}/Clips/{safe_cid}.md"
            clip_links.append(f"- [[{_wikilink(rel)}]]")
            meta = {
                "type": "clip",
                "project_id": project_id,
                "clip_id": cid,
                "duration_sec": clip.get("durationSec") or clip.get("duration_sec"),
                "tags": ["director_cinema", "clip", "memory"],
            }
            body = (
                f"# Clip `{cid}`\n\n"
                f"[[Projects/{pid}/_Project]]\n\n"
                f"## Prompt motion\n{clip.get('prompt') or ''}\n\n"
                f"## Immagine\n"
                f"- path: `{clip.get('image', {}).get('path') if isinstance(clip.get('image'), dict) else clip.get('image_path') or '—'}`\n"
            )
            self._write_note(rel, meta, body)

        brief = (
            f"# Director Cinema — {project.get('name', project_id)}\n\n"
            f"## Prompt globale\n{project.get('globalPrompt') or ''}\n\n"
            f"## Setup\n"
            f"- Mode: `{project.get('mode', 'txt2video')}`\n"
            f"- Aspect: `{project.get('aspectRatio', '')}`\n"
            f"- Resolution: {project.get('width', '')}×{project.get('height', '')}\n"
            f"- FPS: {project.get('fps', '')}\n"
            f"- Workflow: `{project.get('workflowId') or '—'}`\n"
        )
        self._write_note(
            f"Projects/{pid}/Memory/00-Project-Brief.md",
            {"type": "brief", "project_id": project_id, "tags": ["director_cinema", "memory"]},
            brief,
        )

        self._write_note(
            f"Projects/{pid}/Memory/Regia-Memory.md",
            {
                "type": "regia_memory",
                "project_id": project_id,
                "pipeline": "director_cinema",
                "tags": ["memory", "regia"],
            },
            format_regia_memory_index(
                pipeline="director_cinema",
                project_id=project_id,
                completed_stages=["workspace"],
            ),
        )

        proj_body = (
            f"# Director Cinema `{project.get('name', project_id)}`\n\n"
            f"- Clip: {len(clips)}\n\n"
            f"## Memoria\n- [[Projects/{pid}/Memory/Regia-Memory]]\n\n"
            f"## Clip\n"
            + "\n".join(clip_links)
            + "\n"
        )
        self._write_note(
            f"Projects/{pid}/_Project.md",
            {
                "type": "project",
                "project_id": project_id,
                "pipeline": "director_cinema",
                "tags": ["director_cinema", "memory"],
            },
            proj_body,
        )
        self._append_execution_journal(
            project_id=project_id,
            job_id="",
            pipeline_kind="director_cinema",
            checkpoint={
                "phase_label": "workspace_sync",
                "clips_list": clips,
            },
        )
        self._refresh_moc_projects()
        return {"clips_synced": len(clips), "project_note": f"Projects/{pid}/_Project.md"}

    def _write_extended_memory_notes(
        self,
        *,
        project_id: str,
        job_id: str,
        pipeline_kind: str,
        checkpoint: dict[str, Any],
        extra: Optional[dict[str, Any]] = None,
    ) -> None:
        pid = _safe_name(project_id)
        for rel, meta, body in notes_from_reel_trailer_checkpoint(
            checkpoint,
            pipeline_kind=pipeline_kind,
            project_id=project_id,
            job_id=job_id,
            extra=extra,
        ):
            self._write_note(f"Projects/{pid}/{rel}", meta, body)

    def _append_execution_journal(
        self,
        *,
        project_id: str,
        job_id: str,
        pipeline_kind: str,
        checkpoint: dict[str, Any],
    ) -> None:
        pid = _safe_name(project_id)
        rel = f"Projects/{pid}/Memory/10-Execution-Journal.md"
        full = self.vault_path / rel
        entry = build_journal_entry(
            pipeline_kind=pipeline_kind,
            project_id=project_id,
            job_id=job_id,
            checkpoint=checkpoint,
        )
        if full.exists():
            prev = full.read_text(encoding="utf-8")
            if prev.startswith("---"):
                parts = prev.split("---\n\n", 2)
                body = parts[-1] if len(parts) >= 3 else prev
            else:
                body = prev
            if len(body) > 120_000:
                body = body[-80_000:]
            new_body = body.rstrip() + entry
        else:
            new_body = (
                "# Execution journal\n\n"
                "Storico automatico: fasi pipeline, clip pronte, scelte di regia.\n"
                + entry
            )
        self._write_note(
            rel,
            {
                "type": "execution_journal",
                "project_id": project_id,
                "job_id": job_id,
                "pipeline": pipeline_kind,
                "tags": ["memory", "journal", pipeline_kind],
            },
            new_body,
        )

    def _refresh_moc_projects(self) -> None:
        """Aggiorna MOC-Projects con wikilink a ogni progetto."""
        projects = self.list_projects()
        lines = ["# Progetti\n", f"_Aggiornato: {_now_iso()}_\n"]
        for p in projects:
            pid = p.get("project_id", "")
            if pid:
                lines.append(f"- [[Projects/{pid}/_Project|{pid}]]")
        moc = self.vault_path / "00-Studio" / "MOC-Projects.md"
        moc.write_text(
            _fm({"type": "moc", "tags": ["moc"], "updated": _now_iso(), "project_count": len(projects)})
            + "\n".join(lines)
            + "\n",
            encoding="utf-8",
        )

    def _sync_workflow_note(self, pid: str, workflow_id: str, project_id: str) -> None:
        safe_wf = _safe_name(workflow_id)
        rel = f"Projects/{pid}/Workflows/{safe_wf}.md"
        try:
            from src.core.comfyui.workflow_builder import get_workflow

            meta_wf, wf_json = get_workflow(workflow_id)
            summary = json.dumps(meta_wf, indent=2, ensure_ascii=False)[:4000]
            nodes = len(wf_json) if isinstance(wf_json, dict) else 0
        except Exception as exc:
            summary = str(exc)
            nodes = 0
        body = (
            f"# Workflow `{workflow_id}`\n\n"
            f"[[Projects/{pid}/_Project]]\n\n"
            f"- Nodi template: {nodes}\n\n"
            f"## Manifest\n```json\n{summary}\n```\n"
        )
        self._write_note(
            rel,
            {
                "type": "workflow",
                "workflow_id": workflow_id,
                "project_id": project_id,
                "tags": ["comfyui", "workflow"],
            },
            body,
        )

    def search(
        self,
        query: str,
        *,
        project_id: Optional[str] = None,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        """Ricerca testuale nel vault (retrieval stili / contesto agent)."""
        q = (query or "").strip().lower()
        if not q:
            return []
        root = self.projects_dir
        if project_id:
            root = root / _safe_name(project_id)
        if not root.exists():
            return []
        hits: list[dict[str, Any]] = []
        for md in root.rglob("*.md"):
            try:
                text = md.read_text(encoding="utf-8")
            except OSError:
                continue
            if q in text.lower():
                rel = md.relative_to(self.vault_path).as_posix()
                hits.append({
                    "path": rel,
                    "title": md.stem,
                    "excerpt": text[:500],
                })
            if len(hits) >= limit:
                break
        return hits

    def get_context_bundle(
        self,
        *,
        project_id: str,
        clip_id: Optional[str] = None,
        shot_id: Optional[str] = None,
        include: Optional[tuple[str, ...]] = None,
        max_chars: int = 12000,
    ) -> str:
        """Bundle markdown per injection LLM (retrieval / memoria regia)."""
        pid = _safe_name(project_id)
        base = self.vault_path / "Projects" / pid

        def _read(rel: str, cap: int = 3500) -> Optional[str]:
            p = base / rel
            if p.exists():
                return p.read_text(encoding="utf-8")[:cap]
            return None

        keys = include or (
            "memory_index",
            "project_brief",
            "story_analysis",
            "story_arc",
            "story_arc_reel",
            "vision",
            "audio",
            "visual_plans",
            "edl",
            "continuity",
            "clip",
            "shot",
            "shots_summary",
        )

        parts: list[str] = []
        for key in keys:
            if key == "memory_index":
                t = _read("Memory/Regia-Memory.md", 2000)
            elif key == "project_brief":
                t = _read("Memory/00-Project-Brief.md", 3500)
            elif key == "story_analysis":
                t = _read("Memory/01-Story-Analysis.md", 4000)
            elif key in ("story_arc", "story_arc_reel"):
                t = _read("Story-Arc.md", 4500)
            elif key == "vision":
                t = _read("Vision.md", 2500)
            elif key == "audio":
                t = _read("Audio-Timeline.md", 2500)
            elif key == "visual_plans":
                t = _read("Visual-Plans.md", 4000)
            elif key == "edl":
                t = _read("EDL.md", 3500)
            elif key == "continuity":
                t = _read("Memory/04-Continuity.md", 3500)
            elif key == "audio_analysis":
                t = _read("Memory/02-Audio-Analysis.md", 3000)
            elif key == "lyric_timing":
                t = _read("Memory/03-Lyric-Timing.md", 3500)
            elif key == "production_config":
                t = _read("Memory/06-Production-Config.md", 2500)
            elif key == "execution_journal":
                t = _read("Memory/10-Execution-Journal.md", 3500)
            elif key == "final_deliverable":
                t = _read("Memory/08-Final-Deliverable.md", 2000)
            elif key == "clip" and clip_id:
                t = _read(f"Clips/{_safe_name(clip_id)}.md", 5000)
            elif key == "shot" and shot_id:
                t = _read(f"Shots/{_safe_name(shot_id)}.md", 5000)
            elif key == "shots_summary":
                shots_dir = base / "Shots"
                if shots_dir.is_dir():
                    lines = ["# Shots summary\n"]
                    for md in sorted(shots_dir.glob("*.md"))[:40]:
                        text = md.read_text(encoding="utf-8")
                        head = text.split("\n", 8)[:8]
                        lines.append(f"### {md.stem}\n" + "\n".join(head))
                    t = "\n".join(lines)[:6000]
                else:
                    t = None
            elif key == "ltx_prompt_guide":
                from src.core.obsidian.ltx23_guide import read_ltx23_guide_from_vault

                t = read_ltx23_guide_from_vault(self.vault_path, max_chars=5500)
            else:
                t = None

            if t:
                parts.append(t)

        if not parts:
            for name in ("_Project.md", "Story-Arc.md", "Memory/Regia-Memory.md"):
                t = _read(name, 3000)
                if t:
                    parts.append(t)

        bundle = "\n\n---\n\n".join(parts)
        return bundle[:max_chars]

    def list_projects(self) -> list[dict[str, str]]:
        out: list[dict[str, str]] = []
        base = self.projects_dir
        if not base.exists():
            return out
        for d in sorted(base.iterdir()):
            if d.is_dir():
                note = d / "_Project.md"
                out.append({
                    "project_id": d.name,
                    "project_note": note.relative_to(self.vault_path).as_posix() if note.exists() else "",
                })
        return out


@lru_cache
def get_vault_manager() -> ObsidianVaultManager:
    cfg = get_config().obsidian
    vault = Path(cfg.vault_dir).expanduser()
    if not vault.is_absolute():
        vault = get_config().app.data_path / vault
    mgr = ObsidianVaultManager(vault)
    mgr.ensure_scaffold()
    return mgr
