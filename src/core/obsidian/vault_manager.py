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
        (self.vault_path / "Templates").mkdir(exist_ok=True)

    @property
    def projects_dir(self) -> Path:
        return self.vault_path / "Projects"

    def project_dir(self, project_id: str) -> Path:
        d = self.projects_dir / _safe_name(project_id)
        d.mkdir(parents=True, exist_ok=True)
        for sub in ("Clips", "Shots", "Workflows", "Versions", "Frames"):
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

        for clip in clips:
            cid = clip.get("clip_id") or "clip_unknown"
            safe_cid = _safe_name(cid)
            rel = f"Projects/{pid}/Clips/{safe_cid}.md"
            clip_links.append(f"- [[{_wikilink(rel)}]]")

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
                "tags": [pipeline_kind, "clip", "ltx"],
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
                f"Parent: [[Projects/{pid}/_Project]]\n\n"
                f"## Timeline\n"
                f"- Reel: {clip.get('start_sec')}s → {clip.get('end_sec')}s\n"
                f"- Audio traccia: {clip.get('audio_src_start_sec')} → {clip.get('audio_src_end_sec')}s\n\n"
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
                    "tags": [pipeline_kind, "narrative"],
                },
                f"# Story Arc\n\n```json\n{json.dumps(narrative, indent=2, ensure_ascii=False)}\n```\n",
            )

        vision = checkpoint.get("vision")
        if vision:
            self._write_note(
                f"Projects/{pid}/Vision.md",
                {"type": "vision", "project_id": project_id, "tags": [pipeline_kind, "vision"]},
                f"# Vision\n\n```json\n{json.dumps(vision, indent=2, ensure_ascii=False)}\n```\n",
            )

        for wf_id in workflows_seen:
            self._sync_workflow_note(pid, wf_id, project_id)

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
        """Sincronizza pipeline_state.json (5 LLM + shot list)."""
        self.ensure_scaffold()
        pid = _safe_name(project_id)
        data = pipeline_state.get("data") or {}
        shot_list = data.get("shot_list") or []

        for shot in shot_list:
            sid = shot.get("shot_id") or "shot_unknown"
            safe_sid = _safe_name(sid)
            ff = shot.get("first_frame") or {}
            lf = shot.get("last_frame") or {}
            rel = f"Projects/{pid}/Shots/{safe_sid}.md"
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
                "tags": ["cinematic", "shot"],
            }
            body = (
                f"# {sid}\n\n"
                f"[[Projects/{pid}/_Project]]\n\n"
                f"## Regia\n"
                f"- Location: {shot.get('location')}\n"
                f"- Emotion: {shot.get('emotion')}\n"
                f"- Workflow: `{shot.get('comfyui_workflow') or '—'}`\n\n"
                f"## First frame (seed {ff.get('seed')})\n{ff.get('prompt') or ''}\n\n"
                f"## Last frame (seed {lf.get('seed')})\n{lf.get('prompt') or ''}\n\n"
                f"## Motion\n{shot.get('motion_prompt') or ''}\n\n"
                f"## LTX global\n{shot.get('ltx_global_prompt') or ''}\n"
            )
            self._write_note(rel, meta, body)
            wf = shot.get("comfyui_workflow")
            if wf:
                self._sync_workflow_note(pid, str(wf), project_id)

        self._write_note(
            f"Projects/{pid}/_Project.md",
            {"type": "project", "project_id": project_id, "pipeline": "cinematic", "tags": ["cinematic"]},
            f"# Progetto cinematic `{project_id}`\n\n"
            f"Shots: {len(shot_list)}\n",
        )
        return {"shots_synced": len(shot_list)}

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
        max_chars: int = 12000,
    ) -> str:
        """Bundle markdown per injection LLM (retrieval)."""
        pid = _safe_name(project_id)
        parts: list[str] = []
        for name in ("_Project.md", "Story-Arc.md", "Audio-Timeline.md", "Vision.md"):
            p = self.vault_path / "Projects" / pid / name
            if p.exists():
                parts.append(p.read_text(encoding="utf-8")[:3000])
        if clip_id:
            p = self.vault_path / "Projects" / pid / "Clips" / f"{_safe_name(clip_id)}.md"
            if p.exists():
                parts.append(p.read_text(encoding="utf-8"))
        if shot_id:
            p = self.vault_path / "Projects" / pid / "Shots" / f"{_safe_name(shot_id)}.md"
            if p.exists():
                parts.append(p.read_text(encoding="utf-8"))
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
