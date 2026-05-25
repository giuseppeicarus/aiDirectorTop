"""
CreateReel pipeline — brief testuale + immagini di riferimento (LLM vision)
→ regia → prompt → storyboard bassa risoluzione → pausa approvazione → HD + video.
"""

from __future__ import annotations

import asyncio
import json
import math
import shutil
import uuid
from pathlib import Path
from typing import Any, AsyncGenerator, Dict, List, Optional

import structlog
from pydantic import BaseModel, Field

from src.core.workflow.trailer_pipeline import (
    TrailerPipeline,
    TrailerRequest,
    TrailerClip,
    EDL,
    EDLSlot,
    AudioSection,
    _llm_json,
    _run_ffmpeg,
    _clip_prompt_payload,
    _normalize_dop_llm_result,
    _normalize_prompt_llm_result,
)
from src.core.workflow.reel_jobs import ReelJobRecord, upsert_job, now_iso, load_jobs

# Gap tra fine audio clip N e inizio clip N+1 nella traccia sorgente (es. 10.00 → 10.01)
REEL_CLIP_AUDIO_GAP_SEC = 0.01
from src.core.llm.reel_prompts import (
    REEL_DIRECTOR_SYSTEM,
    REEL_DIRECTOR_SYSTEM_WITH_AUDIO,
    REEL_CINEMATOGRAPHER_SYSTEM,
    REEL_PROMPT_ENGINEER_SYSTEM,
    build_reel_director_user_prompt,
    build_reel_cinematographer_prompt,
    build_reel_prompt_engineer_user,
)
from src.core.llm.vision import analyze_reference_images

log = structlog.get_logger()

REEL_AGENT_LABELS = {
    "vision_analyst": "Analista Vision",
    "story_analyst": "Analisi Audio",
    "narrative_director": "Regista Narrativo",
    "cinematographer": "Direttore della Fotografia",
    "prompt_engineer": "Prompt Engineer",
    "comfyui": "ComfyUI",
}


def _reel_agent_event(
    role: str,
    status: str,
    msg: str,
    *,
    pct: Optional[float] = None,
    clip_id: Optional[str] = None,
    clip_index: Optional[int] = None,
    clip_total: Optional[int] = None,
) -> dict[str, Any]:
    from src.core.config import get_config

    cfg_role = role if role in (
        "narrative_director",
        "cinematographer",
        "prompt_engineer",
        "story_analyst",
        "continuity_checker",
    ) else "narrative_director"
    if role == "vision_analyst":
        try:
            cfg = get_config().get_llm_for_role("vision_analyst")
        except Exception:
            cfg = get_config().get_llm_for_role("narrative_director")
    elif role == "comfyui":
        cfg = get_config().llm
    else:
        cfg = get_config().get_llm_for_role(cfg_role)

    out: dict[str, Any] = {
        "event": "agent_progress",
        "agent_role": role,
        "agent_label": REEL_AGENT_LABELS.get(role, role),
        "agent_status": status,
        "msg": msg,
        "model": cfg.model or "",
        "provider": cfg.provider or "",
    }
    if pct is not None:
        out["pct"] = pct
    if clip_id:
        out["clip_id"] = clip_id
    if clip_index is not None:
        out["clip_index"] = clip_index
        out["clip_total"] = clip_total
    return out


def _reel_clip_sse_payload(
    clip: TrailerClip,
    storage_project_id: str,
    pipeline: "ReelPipeline",
    visual_plans: Optional[Dict[str, dict]] = None,
) -> dict[str, Any]:
    """Payload SSE/UI con prompt, regia e risoluzioni."""
    out = _clip_prompt_payload(clip, storage_project_id)
    dop = (visual_plans or {}).get(clip.slot_id) or {}
    sb_w, sb_h = pipeline._storyboard_dimensions()
    hd_w = int(pipeline._reel_req.width) * 2
    hd_h = int(pipeline._reel_req.height) * 2
    out.update({
        "slot_id": clip.slot_id,
        "start_sec": round(clip.start_sec, 2),
        "end_sec": round(clip.end_sec, 2),
        "negative_prompt": clip.negative_prompt,
        "ltx_video_prompt": clip.ltx_video_prompt,
        "width": pipeline._reel_req.width,
        "height": pipeline._reel_req.height,
        "hd_width": hd_w,
        "hd_height": hd_h,
        "storyboard_width": sb_w,
        "storyboard_height": sb_h,
        "fps": pipeline._reel_req.fps,
        "aspect_ratio": pipeline._reel_req.aspect_ratio,
        "shot_type": dop.get("shot_type"),
        "lens_mm": dop.get("lens_mm"),
        "camera_movement": dop.get("camera_movement"),
        "depth_of_field": dop.get("depth_of_field"),
        "lighting": dop.get("lighting"),
        "emotion": dop.get("emotion") or dop.get("slot_emotion"),
        "scene_description": (dop.get("scene_description") or "")[:500],
    })
    if clip.audio_src_start_sec is not None:
        out["audio_src_start_sec"] = clip.audio_src_start_sec
        out["audio_src_end_sec"] = clip.audio_src_end_sec
    return out


class ReelRequest(BaseModel):
    project_id: str = "reel_standalone"
    description: str
    reference_image_paths: List[str] = Field(default_factory=list)
    title: str = ""
    duration_sec: int = Field(default=30, ge=8, le=180)
    style: str = "cinematic, photorealistic, dramatic lighting"
    aspect_ratio: str = "9:16"
    width: int = 1080
    height: int = 1920
    fps: int = 30
    txt2img_workflow: str = "z_image_turbo_txt2img"
    img2video_workflow: str = "ltx_img2video"
    concurrent_jobs: int = 1
    max_clip_sec: float = 5.0
    num_slots: int = Field(default=0, ge=0, le=12)
    resume_job_id: Optional[str] = None
    phase: str = "full"
    clip_backend: str = "auto"
    allow_ffmpeg_fallback: bool = True
    storyboard_max_side: int = Field(default=320, ge=96, le=768)
    storyboard_steps: int = Field(default=10, ge=4, le=40)
    hd_frame_steps: int = Field(default=25, ge=4, le=50)
    model_overrides: Optional[dict] = None  # {checkpoint?, video_model?, loras?: [...]}
    audio_path: Optional[str] = None
    audio_name: str = ""
    audio_start_sec: float = Field(default=0.0, ge=0.0)
    lyrics: Optional[str] = None
    character_mode: str = "none"  # none | reference | character | character_reference
    character_id: Optional[str] = None
    character_owner_id: str = "local_user"


def _build_visual_plans_from_edl(
    slot_descs: list[dict],
    *,
    style: str,
    director_narrative: dict,
    vision: dict,
    brief: str = "",
) -> dict[str, dict]:
    """Build DP visual plans directly from director's EDL when cinematographer LLM fails."""
    from src.core.llm.reel_slot_variety import enrich_visual_plan_for_slot

    dn = director_narrative or {}
    mood = dn.get("mood", "cinematic")
    visual_theme = dn.get("visual_theme", "")
    motifs = dn.get("visual_motifs") or []
    motif_str = "; ".join(motifs[:3]) if motifs else ""
    anchors = (vision.get("character_anchors") or [])[:3]
    anchor_str = ". ".join(anchors) if anchors else ""

    # Map energy level to shot type / camera movement
    _energy_to_shot = {"low": "medium", "medium": "medium_close", "high": "close_up", "peak": "extreme_close"}
    _energy_to_move = {"low": "slow dolly in", "medium": "gentle tracking", "high": "handheld", "peak": "rapid push in"}
    _energy_to_lens = {"low": 85, "medium": 50, "high": 35, "peak": 24}
    # Map director narrative_role to energy when explicit energy is absent
    _role_to_energy = {"intro": "low", "build": "medium", "buildup": "medium", "peak": "high", "climax": "peak", "resolution": "low", "outro": "low"}

    plans: dict[str, dict] = {}
    slot_total = len(slot_descs)
    for slot_i, s in enumerate(slot_descs):
        slot_id = s["slot_id"]
        visual_hint = (s.get("visual_hint") or "").strip()
        emotion = (s.get("emotion") or "cinematic").strip()
        # Use explicit energy if present, otherwise derive from narrative_role
        raw_energy = (s.get("energy") or "").lower().strip()
        if not raw_energy:
            role = (s.get("narrative_role") or "").lower().strip()
            raw_energy = _role_to_energy.get(role, "medium")
        energy = raw_energy
        shot = _energy_to_shot.get(energy, "medium")
        move = _energy_to_move.get(energy, "slow dolly in")
        lens = _energy_to_lens.get(energy, 50)

        # Build English-first first_frame_state from structured fields
        # (visual_hint may be in user's language; use it only as scene_description context)
        role = (s.get("narrative_role") or "").lower().strip()
        _shot_desc = {
            "extreme_close": "extreme close-up, macro detail",
            "close_up": "close-up, intimate framing",
            "medium_close": "medium close-up, subject-focused",
            "medium": "medium shot, establishing subject",
            "wide": "wide shot, environment revealed",
        }.get(shot, f"{shot} shot")
        subject_ctx = anchor_str if anchor_str else "the primary subject"
        hint_body = visual_hint or motif_str or visual_theme
        first_state = (
            f"{_shot_desc}, {subject_ctx}, {hint_body[:280]}, "
            f"{mood} atmosphere, {lens}mm lens, opening frame"
        )
        last_state = (
            f"{_shot_desc}, {subject_ctx}, narrative beat {role or 'resolution'}, "
            f"{hint_body[:200]}, evolved pose and light, {mood} atmosphere"
        )

        scene_parts = [visual_hint, motif_str, visual_theme]
        if motif_str:
            scene_parts.append(motif_str)
        # Truncate at last sentence boundary to avoid mid-sentence cuts
        raw_scene = ". ".join(p for p in scene_parts if p)
        if len(raw_scene) > 400:
            cut = raw_scene[:400].rfind(".")
            raw_scene = raw_scene[:cut + 1] if cut > 100 else raw_scene[:400]

        plan = {
            "slot_id": slot_id,
            "shot_type": shot,
            "lens_mm": lens,
            "depth_of_field": "shallow" if energy in ("high", "peak") else "medium",
            "camera_movement": move,
            "lighting": f"warm directional light, {mood}",
            "composition": "rule of thirds, subject in focus",
            "scene_description": raw_scene,
            "first_frame_state": first_state,
            "last_frame_state": last_state,
            "motion_intent": f"{move}, {emotion} mood",
            "color_grade_note": f"cinematic grade, {mood}",
        }
        plans[slot_id] = enrich_visual_plan_for_slot(
            plan,
            slot_index=slot_i,
            slot_total=slot_total,
            brief=brief,
            base_hint=visual_hint,
            force_variety=slot_total > 1,
        )
    return plans


def _build_prompt_map_from_visual_plans(
    visual_plans: dict[str, dict],
    *,
    style: str,
    director_narrative: dict,
    vision: dict,
    brief: str = "",
) -> dict[str, dict]:
    """Build final generation prompts directly from visual_plans when prompt_engineer LLM fails."""
    from src.core.llm.generation_prompt_sanitize import CINEMATIC_NEGATIVE_PROMPT
    from src.core.llm.reel_prompt_enrich import build_rich_frame_prompt, build_rich_ltx_video_prompt
    from src.core.llm.reel_slot_variety import motion_for_clip

    dn = director_narrative or {}
    mood = dn.get("mood", "cinematic")
    slot_ids = list(visual_plans.keys())
    slot_total = len(slot_ids)

    result: dict[str, dict] = {}
    for slot_i, slot_id in enumerate(slot_ids):
        plan = visual_plans[slot_id]
        scene_desc = plan.get("scene_description", "")
        motion = motion_for_clip(
            dop=plan,
            slot_index=slot_i,
            slot_total=slot_total,
            brief=brief,
        )
        hint = scene_desc[:220]

        from src.core.llm.generation_prompt_sanitize import finalize_positive_prompt, sanitize_generation_prompt

        scene_prompt = finalize_positive_prompt(
            sanitize_generation_prompt(
                f"{style}, {plan.get('shot_type', 'medium')} shot, {scene_desc[:280]}, {mood} mood",
                min_len=45,
            )
        )
        result[slot_id] = {
            "slot_id": slot_id,
            "scene_prompt": scene_prompt,
            "first_frame_prompt": build_rich_frame_prompt(
                role="first",
                style=style,
                dop=plan,
                visual_hint=hint,
                mood=mood,
                vision=vision,
                director_narrative=dn,
                brief=brief,
            ),
            "last_frame_prompt": build_rich_frame_prompt(
                role="last",
                style=style,
                dop=plan,
                visual_hint=hint,
                mood=mood,
                vision=vision,
                director_narrative=dn,
                brief=brief,
            ),
            "motion_prompt": motion,
            "ltx_video_prompt": build_rich_ltx_video_prompt(
                style=style,
                dop=plan,
                visual_hint=hint,
                mood=mood,
                vision=vision,
                director_narrative=dn,
                brief=brief,
            ),
            "negative_prompt": CINEMATIC_NEGATIVE_PROMPT,
        }
    return result


class ReelPipeline(TrailerPipeline):
    """Estende TrailerPipeline: vision + regia reel, poi storyboard/ComfyUI ereditati."""

    def _media_api_prefix(self) -> str:
        return "reel"

    def _after_storyboard_frame_saved(self, clip: TrailerClip) -> None:
        self._save_checkpoint(55)

    def __init__(self, request: ReelRequest) -> None:
        from src.core.utils.project_paths import (
            ensure_project_directory,
            resolve_reel_storage_project_id,
            reel_catalog_project_id,
        )
        from src.core.workflow.reel_jobs import job_storage_project_id

        self._reel_req = request
        self._created_at = now_iso()
        self.job_id = request.resume_job_id or uuid.uuid4().hex[:10]
        self._catalog_project_id = reel_catalog_project_id(request.project_id)

        storage_id: str | None = None
        if request.resume_job_id:
            for cat in {self._catalog_project_id, request.project_id, "reel_standalone"}:
                if not cat:
                    continue
                rec = next(
                    (j for j in load_jobs(cat) if j.job_id == self.job_id),
                    None,
                )
                if rec:
                    storage_id = job_storage_project_id(rec)
                    self._catalog_project_id = rec.project_id
                    break

        self._storage_project_id = storage_id or resolve_reel_storage_project_id(
            request.project_id, self.job_id,
        )

        base = ensure_project_directory(
            self._storage_project_id,
            title=request.title or f"Reel {self.job_id}",
        )
        self._references_dir = base / "references"
        self._references_dir.mkdir(parents=True, exist_ok=True)

        self._audio_dir = base / "audio"
        self._audio_dir.mkdir(parents=True, exist_ok=True)
        self._audio_start_sec = max(0.0, float(request.audio_start_sec or 0))
        self._lyric_beats: list[dict] = []
        self._slot_lyrics: dict[str, str] = {}
        self._audio_analysis_summary: dict = {}

        has_audio = bool(request.audio_path and Path(request.audio_path).is_file())
        if has_audio:
            src = Path(request.audio_path)
            dest = self._audio_dir / f"source{src.suffix.lower() or '.wav'}"
            if src.resolve() != dest.resolve():
                shutil.copy2(src, dest)
            audio_path_str = str(dest)
            audio_name = request.audio_name or src.name
        else:
            audio_path_str = str(self._audio_dir / "source_silent.wav")
            audio_name = "reel_silent.wav"

        img2video_wf = request.img2video_workflow
        if has_audio:
            img2video_wf = "ltx_img_audio2video"
        elif img2video_wf == "ltx_img_audio2video":
            img2video_wf = "ltx_img2video"

        trailer_req = TrailerRequest(
            project_id=self._storage_project_id,
            audio_path=audio_path_str,
            audio_name=audio_name,
            lyrics=request.lyrics,
            duration_sec=request.duration_sec,
            style=request.style,
            aspect_ratio=request.aspect_ratio,
            width=request.width,
            height=request.height,
            fps=request.fps,
            txt2img_workflow=request.txt2img_workflow,
            img2video_workflow=img2video_wf,
            concurrent_jobs=request.concurrent_jobs,
            max_clip_sec=request.max_clip_sec,
            resume_job_id=request.resume_job_id,
            phase=request.phase,
            clip_backend=request.clip_backend,
            allow_ffmpeg_fallback=request.allow_ffmpeg_fallback,
            storyboard_max_side=request.storyboard_max_side,
            storyboard_steps=request.storyboard_steps,
            hd_frame_steps=request.hd_frame_steps,
            model_overrides=request.model_overrides,
        )

        self.req = trailer_req
        self._has_source_audio = has_audio
        self._frames_dir = base / "frames"
        self._clips_dir = base / "clips"
        self._final_dir = base / "final"
        self._storyboard_dir = base / "storyboard"
        from src.core.comfyui.pool import ComfyUINodePool
        self._pool = ComfyUINodePool()
        self._sections: List[AudioSection] = []
        self._downbeats: list = []
        self._audio_duration: float = float(request.duration_sec)
        self._edl: Optional[EDL] = None
        self._clips_list: List[TrailerClip] = []
        self._trailer_audio_path: Optional[Path] = None
        self._last_result: Optional[dict] = None
        self._use_ffmpeg_clips: bool = False
        self._storyboard_approved: bool = False
        self._visual_plans_cache: dict[str, dict] = {}
        self._vision: dict[str, Any] = {}
        self._director_narrative: dict[str, Any] = {}
        self._ref_paths: List[Path] = []
        self._character_context: dict[str, Any] = self._load_character_context()

    def _load_character_context(self) -> dict[str, Any]:
        mode = (self._reel_req.character_mode or "none").strip()
        if mode not in ("character", "character_reference") or not self._reel_req.character_id:
            return {}
        try:
            from src.core.workflow.character_service import character_prompt_context, get_record

            record = get_record(self._reel_req.character_owner_id or "local_user", self._reel_req.character_id)
            if record and record.status == "completato":
                return character_prompt_context(record)
        except Exception:
            return {}
        return {}

    def _checkpoint_path(self) -> Path:
        from src.core.config import get_config
        base = get_config().app.data_path / "projects" / self._storage_project_id
        return base / f"reel_state_{self.job_id}.json"

    def _checkpoint_path_candidates(self) -> list[Path]:
        from src.core.config import get_config
        cfg = get_config()
        roots = [self._storage_project_id]
        if (
            self._catalog_project_id == "reel_standalone"
            and self._storage_project_id != "reel_standalone"
        ):
            roots.append("reel_standalone")
        return [
            cfg.app.data_path / "projects" / root / f"reel_state_{self.job_id}.json"
            for root in roots
        ]

    def _job_config(self) -> dict:
        return self._reel_req.model_dump(exclude={"project_id", "reference_image_paths"})

    def _job_result_snapshot(self) -> dict:
        """Snapshot parziale per reel_jobs.json — ripristino UI se si esce dal dettaglio."""
        out: dict = {}
        if self._vision:
            out["vision"] = self._vision
        if self._director_narrative:
            out["director_narrative"] = self._director_narrative
        vp = getattr(self, "_visual_plans_cache", None) or {}
        if isinstance(vp, dict) and vp:
            out["visual_plans"] = list(vp.values())
        sb = self._storyboard_frames_payload()
        if sb:
            out["storyboard"] = sb
        if self._clips_list:
            out["clips"] = [
                _reel_clip_sse_payload(
                    c,
                    self._storage_project_id,
                    self,
                    vp if isinstance(vp, dict) else None,
                )
                for c in self._clips_list
            ]
        if self._last_result:
            out.update({k: v for k, v in self._last_result.items() if k not in out})
        return out

    def _persist_job_snapshot(self, phase_num: int) -> None:
        """Aggiorna reel_jobs.json con progresso e artefatti già prodotti."""
        status = "running"
        if phase_num >= 55 and not getattr(self, "_storyboard_approved", False):
            status = "awaiting_storyboard"
        snap = self._job_result_snapshot()
        self._save_job(status=status, result=snap or None)

    def _save_job(self, status: str, result: Optional[dict] = None, error: Optional[str] = None) -> None:
        try:
            upsert_job(ReelJobRecord(
                job_id=self.job_id,
                project_id=self._catalog_project_id,
                storage_project_id=self._storage_project_id,
                created_at=self._created_at,
                updated_at=now_iso(),
                status=status,
                title=self._reel_req.title or f"Reel {self.job_id}",
                description=self._reel_req.description[:500],
                reference_count=len(self._ref_paths),
                config=self._job_config(),
                result=result,
                error=error,
            ))
        except Exception as e:
            log.warning("reel_job_save_failed", error=str(e))

    async def _ingest_references(self) -> list[Path]:
        saved: list[Path] = []
        raw_refs = list(self._reel_req.reference_image_paths)
        if (self._reel_req.character_mode or "none") in ("character", "character_reference"):
            raw_refs.extend(self._character_context.get("reference_image_paths") or [])
        for i, raw in enumerate(raw_refs):
            src = Path(raw)
            if not src.is_file():
                continue
            dest = self._references_dir / f"ref_{i:03d}{src.suffix.lower() or '.png'}"
            if src.resolve() != dest.resolve():
                shutil.copy2(src, dest)
            saved.append(dest)
        self._ref_paths = saved
        return saved

    async def _phase_reel_vision(self) -> AsyncGenerator[dict, None]:
        yield {"event": "phase", "phase": "vision_analysis", "pct": 0.04}
        refs = await self._ingest_references()
        yield _reel_agent_event(
            "vision_analyst",
            "working",
            f"Analizzo {len(refs)} immagini di riferimento…",
            pct=0.05,
        )
        yield {
            "event": "progress",
            "msg": f"Analisi vision — {len(refs)} immagini di riferimento…",
            "pct": 0.06,
        }
        from src.core.config import get_config as _cfg

        vision_timeout = max(120.0, float(_cfg().llm.timeout_sec or 120) * 2)
        try:
            self._vision = await asyncio.wait_for(
                analyze_reference_images(
                    refs,
                    brief=self._character_augmented_brief(),
                    style=self._reel_req.style,
                ),
                timeout=vision_timeout,
            )
        except asyncio.TimeoutError:
            msg = (
                f"Analisi vision scaduta dopo {int(vision_timeout)}s — "
                "verifica il provider LLM vision o riduci le immagini di riferimento."
            )
            log.warning("reel_vision_timeout", timeout=vision_timeout)
            yield {"event": "error", "error": msg, "phase": "vision_analysis"}
            raise RuntimeError(msg) from None
        yield _reel_agent_event(
            "vision_analyst",
            "done",
            "Analisi vision completata",
            pct=0.11,
        )
        yield {
            "event": "vision_analysis_done",
            "pct": 0.12,
            "image_count": len(refs),
            "combined_style":      (self._vision.get("combined_style") or "")[:400],
            "character_anchors":   self._vision.get("character_anchors") or [],
            "environment_anchors": self._vision.get("environment_anchors") or [],
            "palette_hex":         self._vision.get("palette_hex") or [],
            "wardrobe_notes":      (self._vision.get("wardrobe_notes") or "")[:300],
            "continuity_rules":    self._vision.get("continuity_rules") or [],
        }

    def _character_augmented_brief(self) -> str:
        ctx = self._character_context or {}
        if not ctx:
            return self._reel_req.description
        parts = [
            self._reel_req.description,
            "",
            "CREATED CHARACTER CONTINUITY:",
            ctx.get("prompt_anchor", ""),
            ctx.get("caption_summary", ""),
        ]
        return "\n".join(p for p in parts if p)

    def _bootstrap_timeline(self) -> None:
        """Timeline sintetica (reel senza musica) per EDL e downbeat."""
        duration = float(self._reel_req.duration_sec)
        self._audio_duration = duration
        self._sections = [
            AudioSection(
                section_id="reel_main",
                start_sec=0.0,
                end_sec=duration,
                duration_sec=duration,
                section_type="verse",
                energy="medium",
                bpm_local=120.0,
                has_vocal=False,
                hook_score=0.8,
            )
        ]
        step = 0.5
        self._downbeats = [round(i * step, 3) for i in range(int(duration / step) + 1)]

    async def _phase_reel_audio_analysis(self) -> AsyncGenerator[dict, None]:
        yield {"event": "phase", "phase": "audio_analysis", "pct": 0.12}
        yield _reel_agent_event(
            "story_analyst",
            "working",
            "Analisi traccia audio (BPM, sezioni, mood)…",
            pct=0.13,
        )
        from src.core.utils.reel_audio import analyze_reel_audio_window

        src = Path(self._reel_req.audio_path or self.req.audio_path)
        audio_timeout = max(180.0, float(self._reel_req.duration_sec) * 4)
        try:
            sections, downbeats, duration, lyric_beats = await asyncio.wait_for(
                analyze_reel_audio_window(
                    src,
                    start_sec=self._audio_start_sec,
                    duration_sec=float(self._reel_req.duration_sec),
                    work_dir=self._audio_dir,
                    lyrics=self._reel_req.lyrics,
                ),
                timeout=audio_timeout,
            )
        except asyncio.TimeoutError:
            msg = (
                f"Analisi audio scaduta dopo {int(audio_timeout)}s — "
                "verifica il file audio o riduci la durata del reel."
            )
            log.warning("reel_audio_analysis_timeout", timeout=audio_timeout)
            yield {"event": "error", "error": msg, "phase": "audio_analysis"}
            raise RuntimeError(msg) from None
        self._sections = sections
        self._downbeats = downbeats
        self._audio_duration = duration
        self._lyric_beats = lyric_beats
        self._audio_analysis_summary = {
            "bpm": sections[0].bpm_local if sections else 0,
            "duration_sec": duration,
            "sections": len(sections),
            "lyric_lines": len(lyric_beats),
            "audio_start_sec": self._audio_start_sec,
        }
        yield _reel_agent_event(
            "story_analyst",
            "done",
            f"Audio analizzato — {len(sections)} sezioni"
            + (f", {len(lyric_beats)} beat lirici" if lyric_beats else ""),
            pct=0.16,
        )
        yield {
            "event": "audio_analysis_done",
            "pct": 0.17,
            "sections": len(sections),
            "duration_sec": round(duration, 2),
            "bpm": sections[0].bpm_local if sections else 0,
            "lyric_beats": len(lyric_beats),
            "audio_start_sec": self._audio_start_sec,
        }

    def _reel_sequential_audio_seek(self, clips: List[TrailerClip]) -> dict[str, tuple[float, float]]:
        """
        Mappa clip_id → (start, dur) sulla traccia sorgente in ordine di produzione.

        L'audio LTX non segue clip.start_sec sulla timeline: parte da audio_start_sec
        e avanza per durata clip (es. clip1 0→10s, clip2 10.01→20.01, clip3 20.02→30.02)
        anche se la prima clip visiva inizia a t=10s sul reel.
        """
        ordered = sorted(clips, key=lambda c: (c.clip_index, c.clip_id))
        cursor = self._audio_start_sec
        plan: dict[str, tuple[float, float]] = {}
        for clip in ordered:
            dur = max(0.1, float(clip.duration_sec))
            plan[clip.clip_id] = (cursor, dur)
            cursor += dur + REEL_CLIP_AUDIO_GAP_SEC
        return plan

    async def _slice_reel_clip_audio(
        self,
        clip: TrailerClip,
        src_ss: float,
        dur: float,
    ) -> Optional[str]:
        audio_src = Path(self.req.audio_path)
        if not audio_src.exists():
            return None
        slice_path = self._audio_dir / f"{clip.clip_id}_audio.wav"
        rc, err = await _run_ffmpeg(
            "-y",
            "-ss", f"{src_ss:.3f}",
            "-t", f"{dur:.3f}",
            "-i", str(audio_src),
            "-ar", "44100", "-ac", "2",
            str(slice_path),
        )
        if rc == 0 and slice_path.exists():
            clip.audio_src_start_sec = round(src_ss, 3)
            clip.audio_src_end_sec = round(src_ss + dur, 3)
            clip.audio_slice_path = str(slice_path)
            return str(slice_path)
        log.warning(
            "reel_clip_audio_slice_failed",
            clip_id=clip.clip_id,
            src_ss=src_ss,
            dur=dur,
            err=(err or "")[-200:],
        )
        return None

    async def _ensure_clip_audio_slices(self) -> None:
        """Taglia WAV per clip (LTX img+audio) se mancanti o seek non sequenziale."""
        if not self._has_source_audio or not self._clips_list:
            return
        plan = self._reel_sequential_audio_seek(self._clips_list)
        for clip in self._clips_list:
            src_ss, dur = plan[clip.clip_id]
            if (
                clip.audio_slice_path
                and Path(clip.audio_slice_path).exists()
                and clip.audio_src_start_sec is not None
                and abs(clip.audio_src_start_sec - src_ss) < 0.02
            ):
                continue
            await self._slice_reel_clip_audio(clip, src_ss, dur)

    def _map_lyrics_to_slots(self) -> None:
        if not self._lyric_beats or not self._edl:
            return
        for slot in self._edl.slots:
            lines = [
                b["lyric_line"]
                for b in self._lyric_beats
                if b["time_sec"] < slot.end_sec and b["end_sec"] > slot.start_sec
            ]
            if lines:
                self._slot_lyrics[slot.slot_id] = " / ".join(lines)

    def _edl_from_director_slots(self, slots_raw: list[dict]) -> EDL:
        from src.core.llm.reel_slot_variety import (
            _hints_too_similar,
            build_differentiated_slot_hints,
        )

        target = float(self._reel_req.duration_sec)
        if not slots_raw:
            n = max(3, min(8, int(math.ceil(target / self.req.max_clip_sec))))
            slots_raw = build_differentiated_slot_hints(
                self._reel_req.description,
                n,
                vision=getattr(self, "_vision", None) or {},
            )
        elif _hints_too_similar(slots_raw):
            n = len(slots_raw)
            diff = build_differentiated_slot_hints(
                self._reel_req.description,
                n,
                vision=getattr(self, "_vision", None) or {},
            )
            for i, s in enumerate(slots_raw):
                d = diff[i] if i < len(diff) else diff[-1]
                s.setdefault("narrative_role", d.get("narrative_role"))
                s.setdefault("emotion", d.get("emotion"))
                s["visual_hint"] = d.get("visual_hint") or s.get("visual_hint")
                s.setdefault("energy", d.get("energy"))
        total_w = sum(max(0.1, float(s.get("duration_weight", 1.0))) for s in slots_raw)
        edl_slots: List[EDLSlot] = []
        t = 0.0
        for i, s in enumerate(slots_raw):
            w = max(0.1, float(s.get("duration_weight", 1.0)))
            dur = target * (w / total_w)
            if i == len(slots_raw) - 1:
                dur = max(1.5, target - t)
            end = min(t + dur, target)
            edl_slots.append(EDLSlot(
                slot_id=s.get("slot_id") or f"slot_{i+1:03d}",
                section_id="reel_main",
                start_sec=round(t, 3),
                end_sec=round(end, 3),
                duration_sec=round(end - t, 3),
                section_type="verse",
                energy="medium",
                emotion=s.get("emotion") or "cinematic",
                visual_hint=s.get("visual_hint") or self._reel_req.description[:100],
            ))
            t = end
        return EDL(
            total_duration_sec=round(sum(s.duration_sec for s in edl_slots), 3),
            slots=edl_slots,
            cut_points=[0.0] + [round(sum(x.duration_sec for x in edl_slots[: i + 1]), 3) for i in range(len(edl_slots))],
        )

    async def _phase_reel_director(self) -> AsyncGenerator[dict, None]:
        yield {"event": "phase", "phase": "reel_director", "pct": 0.14}
        yield _reel_agent_event(
            "narrative_director",
            "working",
            "Definisco piano narrativo e numero di clip…",
            pct=0.15,
        )
        n_hint = self._reel_req.num_slots or max(
            3, min(10, int(math.ceil(self._reel_req.duration_sec / self.req.max_clip_sec))),
        )
        director_system = (
            REEL_DIRECTOR_SYSTEM_WITH_AUDIO
            if self._has_source_audio
            else REEL_DIRECTOR_SYSTEM
        )
        user = build_reel_director_user_prompt(
            brief=self._reel_req.description,
            style=self._reel_req.style,
            aspect_ratio=self._reel_req.aspect_ratio,
            duration_sec=self._reel_req.duration_sec,
            vision=self._vision,
            audio_analysis={
                "bpm": self._sections[0].bpm_local if self._sections else 0,
                "sections_list": self._sections,
            } if self._has_source_audio else None,
            lyric_beats=self._lyric_beats if self._has_source_audio else None,
            lyrics=self._reel_req.lyrics if self._has_source_audio else None,
            audio_start_sec=self._audio_start_sec,
        ) + f"\n\nTarget approximately {n_hint} slots."
        try:
            raw = await asyncio.wait_for(
                _llm_json(
                    director_system,
                    user,
                    role="narrative_director",
                    temperature=0.65,
                    max_tokens=2048,
                ),
                timeout=300.0,
            )
            slots_raw = raw.get("slots") or []
            self._edl = self._edl_from_director_slots(slots_raw)
            self._map_lyrics_to_slots()
            self._director_narrative = {
                "logline":       raw.get("logline", ""),
                "mood":          raw.get("mood", ""),
                "visual_theme":  raw.get("visual_theme", ""),
                "narrative_arc": raw.get("narrative_arc", ""),
                "visual_motifs": raw.get("visual_motifs") or [],
            }
            yield _reel_agent_event(
                "narrative_director",
                "done",
                f"Piano pronto — {len(self._edl.slots)} slot narrativi",
                pct=0.21,
            )
            yield {
                "event": "reel_plan_ready",
                "logline":       self._director_narrative["logline"],
                "mood":          self._director_narrative["mood"],
                "visual_theme":  self._director_narrative["visual_theme"],
                "narrative_arc": self._director_narrative["narrative_arc"],
                "visual_motifs": self._director_narrative["visual_motifs"],
                "slots": len(self._edl.slots),
                "slot_details": [
                    {
                        "slot_id":      s.slot_id,
                        "narrative_role": getattr(s, "narrative_role", ""),
                        "emotion":      s.emotion,
                        "visual_hint":  s.visual_hint,
                        "duration_sec": round(s.duration_sec, 2),
                        "energy":       s.energy,
                    }
                    for s in self._edl.slots
                ],
                "pct": 0.22,
            }
        except Exception as exc:
            log.warning("reel_director_failed", error=str(exc))
            self._edl = self._edl_from_director_slots([])
            self._map_lyrics_to_slots()
            vis = getattr(self, "_vision", None) or {}
            self._director_narrative = {
                "logline":       self._reel_req.description[:220],
                "mood":          "intense",
                "visual_theme":  (vis.get("combined_style") or self._reel_req.description)[:200],
                "narrative_arc": self._reel_req.description[:400],
                "visual_motifs": (vis.get("environment_anchors") or [])[:6],
            }
            yield _reel_agent_event(
                "narrative_director",
                "done",
                f"Piano fallback — {len(self._edl.slots)} slot",
                pct=0.21,
            )
            yield {"event": "reel_plan_fallback", "pct": 0.22}

    async def _phase_reel_audio_compositor(self) -> AsyncGenerator[dict, None]:
        """Monta audio reale dalla traccia sorgente (offset audio_start_sec)."""
        yield {"event": "phase", "phase": "audio_compositor", "pct": 0.26}
        audio_src = Path(self.req.audio_path)
        if not audio_src.exists():
            raise FileNotFoundError(f"Audio source missing: {audio_src}")

        target_dur = float(self._reel_req.duration_sec)
        n_slots = len(self._edl.slots) if self._edl else 0
        FADE_IN = 0.15
        FADE_OUT = 0.35
        XFADE = 0.12 if n_slots > 1 else 0.0
        offset = self._audio_start_sec
        slot_wavs: list[Path] = []

        from src.core.workflow.trailer_pipeline import _run_ffmpeg

        for i, slot in enumerate(self._edl.slots):
            s, e = self._snap_slot_bounds(slot.start_sec, slot.end_sec)
            s += offset
            e += offset
            dur = max(0.5, e - s)
            out_wav = self._audio_dir / f"slot_{i:03d}_{slot.slot_id}.wav"
            rc, err = await _run_ffmpeg(
                "-y", "-ss", f"{s:.3f}", "-t", f"{dur:.3f}",
                "-i", str(audio_src),
                "-af", "dynaudnorm=f=75:g=15",
                "-ar", "44100", "-ac", "2",
                str(out_wav),
            )
            if rc != 0:
                raise RuntimeError(f"ffmpeg audio slice failed: {err[-300:]}")
            slot_wavs.append(out_wav)
            yield {
                "event": "audio_slice",
                "slot": slot.slot_id,
                "source_start_sec": round(s, 2),
                "source_end_sec": round(e, 2),
                "duration_sec": round(dur, 2),
                "pct": round(0.26 + 0.02 * (i / max(n_slots, 1)), 3),
            }

        trailer_audio = self._audio_dir / f"reel_audio_{self.job_id}.wav"
        if not slot_wavs:
            raise RuntimeError("No audio slots to composite")

        if len(slot_wavs) == 1:
            fo_start = max(0.0, target_dur - FADE_OUT)
            rc, err = await _run_ffmpeg(
                "-y", "-i", str(slot_wavs[0]),
                "-af",
                f"afade=t=in:st=0:d={FADE_IN},afade=t=out:st={fo_start:.3f}:d={FADE_OUT},"
                f"atrim=0:{target_dur:.3f}",
                "-ar", "44100", "-ac", "2",
                str(trailer_audio),
            )
        else:
            concat_list = self._audio_dir / f"concat_{self.job_id}.txt"
            concat_list.write_text(
                "\n".join(f"file '{p.as_posix()}'" for p in slot_wavs),
                encoding="utf-8",
            )
            rc, err = await _run_ffmpeg(
                "-y", "-f", "concat", "-safe", "0", "-i", str(concat_list),
                "-af",
                f"afade=t=in:st=0:d={FADE_IN},afade=t=out:st={max(0, target_dur - FADE_OUT):.3f}:d={FADE_OUT},"
                f"atrim=0:{target_dur:.3f}",
                "-ar", "44100", "-ac", "2",
                str(trailer_audio),
            )
        if rc != 0:
            raise RuntimeError(f"reel audio composite failed: {err[-200:]}")
        self._trailer_audio_path = trailer_audio
        yield {
            "event": "audio_ready",
            "path": str(trailer_audio),
            "duration_sec": target_dur,
            "pct": 0.30,
        }

    async def _phase_reel_silent_audio(self) -> AsyncGenerator[dict, None]:
        yield {"event": "phase", "phase": "audio_compositor", "pct": 0.26}
        target = float(self._reel_req.duration_sec)
        silent_src = Path(self.req.audio_path)
        if not silent_src.exists() or silent_src.stat().st_size < 100:
            rc, err = await _run_ffmpeg(
                "-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
                "-t", f"{target:.3f}",
                "-ar", "44100", "-ac", "2",
                str(silent_src),
            )
            if rc != 0:
                raise RuntimeError(f"Silent audio failed: {err[-200:]}")

        trailer_audio = self._audio_dir / f"reel_audio_{self.job_id}.wav"
        rc, err = await _run_ffmpeg(
            "-y", "-i", str(silent_src),
            "-t", f"{target:.3f}",
            "-ar", "44100", "-ac", "2",
            str(trailer_audio),
        )
        if rc != 0:
            raise RuntimeError(f"reel audio failed: {err[-200:]}")
        self._trailer_audio_path = trailer_audio
        yield {"event": "audio_ready", "path": str(trailer_audio), "duration_sec": target, "pct": 0.30}

    async def _phase5_reel_prompts(self) -> AsyncGenerator[dict, None]:
        yield {"event": "phase", "phase": "prompt_generator", "pct": 0.32}
        if not self._edl:
            raise RuntimeError("EDL mancante")

        slot_descs = []
        for slot in self._edl.slots:
            hint = slot.visual_hint or ""
            lyr = self._slot_lyrics.get(slot.slot_id, "")
            if lyr and lyr not in hint:
                hint = f"{hint}\nLyrics in this window: {lyr}"
            slot_descs.append({
                "slot_id": slot.slot_id,
                "section_type": slot.section_type,
                "energy": slot.energy,
                "emotion": slot.emotion,
                "visual_hint": hint,
                "duration_sec": slot.duration_sec,
                "style": self.req.style,
                "narrative_role": getattr(slot, "narrative_role", ""),
                "lyrics_segment": lyr,
            })

        visual_plans: Dict[str, dict] = {}
        yield _reel_agent_event(
            "cinematographer",
            "working",
            "Piano visivo e inquadrature per ogni slot…",
            pct=0.33,
        )
        yield {"event": "progress", "msg": "Cinematographer — piano visivo reel…", "pct": 0.34}
        try:
            raw_dop = await asyncio.wait_for(
                _llm_json(
                    REEL_CINEMATOGRAPHER_SYSTEM,
                    build_reel_cinematographer_prompt(
                        slot_descs,
                        style=self.req.style,
                        aspect_ratio=self.req.aspect_ratio,
                        vision=self._vision,
                        brief=self._reel_req.description,
                        director_narrative=self._director_narrative,
                    ),
                    role="cinematographer",
                    temperature=0.65,
                    max_tokens=4096,
                ),
                timeout=420.0,
            )
            visual_plans = _normalize_dop_llm_result(raw_dop)
            if visual_plans:
                from src.core.llm.reel_slot_variety import (
                    _hints_too_similar,
                    enrich_visual_plan_for_slot,
                )
                if _hints_too_similar(slot_descs):
                    for i, desc in enumerate(slot_descs):
                        sid = desc["slot_id"]
                        if sid in visual_plans:
                            visual_plans[sid] = enrich_visual_plan_for_slot(
                                visual_plans[sid],
                                slot_index=i,
                                slot_total=len(slot_descs),
                                brief=self._reel_req.description,
                                base_hint=desc.get("visual_hint") or "",
                                force_variety=True,
                            )
                yield _reel_agent_event(
                    "cinematographer",
                    "done",
                    f"Piano DP pronto ({len(visual_plans)} slot)",
                    pct=0.37,
                )
                yield {"event": "dop_plan_ready", "plans": list(visual_plans.values()), "pct": 0.38}
        except Exception as exc:
            log.warning("reel_dop_failed", error=str(exc))

        # Fallback: build visual_plans from director's visual_hint when LLM times out
        if not visual_plans:
            log.info("reel_dop_fallback_from_director", slots=len(slot_descs))
            visual_plans = _build_visual_plans_from_edl(
                slot_descs,
                style=self.req.style,
                director_narrative=self._director_narrative,
                vision=self._vision,
                brief=self._reel_req.description,
            )
            yield {"event": "dop_plan_ready", "plans": list(visual_plans.values()), "pct": 0.38, "source": "director_fallback"}

        prompt_map: Dict[str, dict] = {}
        if visual_plans:
            yield _reel_agent_event(
                "prompt_engineer",
                "working",
                "Genero prompt immagine e video per le clip…",
                pct=0.385,
            )
            yield {"event": "progress", "msg": "Prompt Engineer — prompt da riferimenti…", "pct": 0.39}
            try:
                raw_pe = await asyncio.wait_for(
                    _llm_json(
                        REEL_PROMPT_ENGINEER_SYSTEM,
                        build_reel_prompt_engineer_user(
                            list(visual_plans.values()),
                            style=self.req.style,
                            aspect_ratio=self.req.aspect_ratio,
                            vision=self._vision,
                            director_narrative=self._director_narrative,
                        ),
                        role="prompt_engineer",
                        temperature=0.60,
                        max_tokens=6000,
                    ),
                    timeout=480.0,
                )
                prompt_map = _normalize_prompt_llm_result(raw_pe)
            except Exception as exc:
                log.warning("reel_prompt_engineer_failed", error=str(exc))

        # Fallback: build prompts directly from visual_plans when LLM prompt_engineer times out
        if not prompt_map and visual_plans:
            log.info("reel_pe_fallback_from_visual_plans", slots=len(visual_plans))
            prompt_map = _build_prompt_map_from_visual_plans(
                visual_plans,
                style=self.req.style,
                director_narrative=self._director_narrative,
                vision=self._vision,
                brief=self._reel_req.description,
            )
            yield {"event": "progress", "msg": "Prompt map built from visual plans", "pct": 0.40, "source": "visual_plans_fallback"}

        from src.core.llm.reel_prompt_enrich import enrich_reel_clip_prompts
        from src.core.workflow.trailer_pipeline import _nearest_downbeat

        clips: List[TrailerClip] = []
        audio_src = Path(self.req.audio_path) if self._has_source_audio else None
        audio_cursor = self._audio_start_sec
        clip_global_idx = 0
        total_clips_planned = sum(
            max(1, math.ceil(s.duration_sec / self.req.max_clip_sec))
            for s in self._edl.slots
        )

        slot_order = {s.slot_id: i for i, s in enumerate(self._edl.slots)}
        slot_total = len(self._edl.slots)

        for slot in self._edl.slots:
            pdata = prompt_map.get(slot.slot_id, {})
            dop = visual_plans.get(slot.slot_id, {})
            slot_i = slot_order.get(slot.slot_id, 0)
            clip_count = max(1, math.ceil(slot.duration_sec / self.req.max_clip_sec))
            for c_idx in range(clip_count):
                clean = enrich_reel_clip_prompts(
                    pdata,
                    dop,
                    style=self.req.style,
                    brief=self._reel_req.description,
                    visual_hint=slot.visual_hint or "",
                    slot_emotion=slot.emotion,
                    vision=self._vision,
                    director_narrative=self._director_narrative,
                    slot_index=slot_i,
                    slot_total=slot_total,
                    clip_index_in_slot=c_idx,
                    clips_in_slot=clip_count,
                )
                frac_s = c_idx / clip_count
                frac_e = (c_idx + 1) / clip_count
                raw_s = slot.start_sec + frac_s * slot.duration_sec
                raw_e = slot.start_sec + frac_e * slot.duration_sec
                clip_start = _nearest_downbeat(raw_s, self._downbeats)
                clip_end = _nearest_downbeat(raw_e, self._downbeats)
                if clip_end <= clip_start:
                    clip_end = raw_e
                clip_dur = max(0.5, clip_end - clip_start)
                clip_id = f"clip_{clip_global_idx:03d}_{slot.slot_id}"

                clips.append(TrailerClip(
                    clip_id=clip_id,
                    slot_id=slot.slot_id,
                    start_sec=clip_start,
                    end_sec=clip_end,
                    duration_sec=round(clip_dur, 3),
                    clip_index=clip_global_idx,
                    scene_prompt=clean["scene_prompt"],
                    first_frame_prompt=clean["first_frame_prompt"],
                    last_frame_prompt=clean["last_frame_prompt"],
                    motion_prompt=clean["motion_prompt"],
                    ltx_video_prompt=clean.get("ltx_video_prompt", ""),
                    negative_prompt=clean["negative_prompt"],
                ))
                if self._has_source_audio and audio_src and audio_src.exists():
                    src_ss = audio_cursor
                    slice_dur = max(0.1, clip_dur)
                    await self._slice_reel_clip_audio(clips[-1], src_ss, slice_dur)
                    audio_cursor += slice_dur + REEL_CLIP_AUDIO_GAP_SEC
                clip_global_idx += 1
                yield _reel_agent_event(
                    "prompt_engineer",
                    "working",
                    f"Prompt clip {clip_global_idx}/{total_clips_planned}: {clip_id}",
                    pct=round(0.40 + 0.02 * (clip_global_idx / max(total_clips_planned, 1)), 3),
                    clip_id=clip_id,
                    clip_index=clip_global_idx,
                    clip_total=total_clips_planned,
                )
                payload = _reel_clip_sse_payload(
                    clips[-1],
                    self._storage_project_id,
                    self,
                    visual_plans,
                )
                payload["event"] = "clip_prompt_ready"
                payload["pct"] = round(0.40 + 0.02 * (clip_global_idx / max(total_clips_planned, 1)), 3)
                yield payload

        self._clips_list = clips
        self._visual_plans_cache = visual_plans
        yield _reel_agent_event(
            "prompt_engineer",
            "done",
            f"{len(clips)} clip con prompt pronti",
            pct=0.42,
        )
        yield {
            "event": "prompts_ready",
            "clip_count": len(clips),
            "clips": [
                _reel_clip_sse_payload(c, self._storage_project_id, self, visual_plans)
                for c in clips
            ],
            "pct": 0.42,
        }

    def regenerate_all_clip_prompts(self) -> list[dict]:
        """
        Rigenera prompt distinti per ogni clip (fix slot omogenei da checkpoint).
        Aggiorna EDL hints, piani DP e arricchimento motion/LTX.
        """
        from src.core.llm.reel_slot_variety import (
            _hints_too_similar,
            build_differentiated_slot_hints,
        )

        if not self._edl or not self._clips_list:
            return []

        if not self._director_narrative:
            vis = self._vision or {}
            self._director_narrative = {
                "logline":       self._reel_req.description[:220],
                "mood":          "intense",
                "visual_theme":  (vis.get("combined_style") or self._reel_req.description)[:200],
                "narrative_arc": self._reel_req.description[:400],
                "visual_motifs": (vis.get("environment_anchors") or [])[:6],
            }

        slot_descs = [
            {
                "slot_id": s.slot_id,
                "visual_hint": s.visual_hint,
                "emotion": s.emotion,
                "energy": s.energy,
                "narrative_role": getattr(s, "narrative_role", ""),
            }
            for s in self._edl.slots
        ]
        if _hints_too_similar(slot_descs):
            diff = build_differentiated_slot_hints(
                self._reel_req.description,
                len(self._edl.slots),
                vision=self._vision,
            )
            new_slots = []
            for i, slot in enumerate(self._edl.slots):
                d = diff[i] if i < len(diff) else diff[-1]
                new_slots.append(slot.model_copy(update={
                    "visual_hint": d.get("visual_hint") or slot.visual_hint,
                    "emotion": d.get("emotion") or slot.emotion,
                    "energy": d.get("energy") or slot.energy,
                }))
            self._edl = self._edl.model_copy(update={"slots": new_slots})
            slot_descs = [
                {
                    "slot_id": s.slot_id,
                    "visual_hint": s.visual_hint,
                    "emotion": s.emotion,
                    "energy": s.energy,
                    "narrative_role": getattr(s, "narrative_role", ""),
                }
                for s in self._edl.slots
            ]

        self._visual_plans_cache = _build_visual_plans_from_edl(
            slot_descs,
            style=self.req.style,
            director_narrative=self._director_narrative,
            vision=self._vision,
            brief=self._reel_req.description,
        )
        prompt_map = _build_prompt_map_from_visual_plans(
            self._visual_plans_cache,
            style=self.req.style,
            director_narrative=self._director_narrative,
            vision=self._vision,
            brief=self._reel_req.description,
        )
        slot_by_id = {s.slot_id: s for s in self._edl.slots}
        slot_order = {s.slot_id: i for i, s in enumerate(self._edl.slots)}
        slot_total = len(self._edl.slots)

        from src.core.llm.reel_prompt_enrich import enrich_reel_clip_prompts

        for clip in self._clips_list:
            slot = slot_by_id.get(clip.slot_id)
            if not slot:
                continue
            dop = self._visual_plans_cache.get(slot.slot_id, {})
            pdata = prompt_map.get(slot.slot_id, {})
            clips_in_slot = sum(1 for c in self._clips_list if c.slot_id == clip.slot_id)
            clip_index_in_slot = sum(
                1 for c in self._clips_list
                if c.slot_id == clip.slot_id and c.clip_index < clip.clip_index
            )
            clean = enrich_reel_clip_prompts(
                pdata,
                dop,
                style=self.req.style,
                brief=self._reel_req.description,
                visual_hint=slot.visual_hint or "",
                slot_emotion=slot.emotion,
                vision=self._vision,
                director_narrative=self._director_narrative,
                slot_index=slot_order.get(slot.slot_id, 0),
                slot_total=slot_total,
                clip_index_in_slot=clip_index_in_slot,
                clips_in_slot=clips_in_slot,
            )
            clip.scene_prompt = clean["scene_prompt"]
            clip.first_frame_prompt = clean["first_frame_prompt"]
            clip.last_frame_prompt = clean["last_frame_prompt"]
            clip.motion_prompt = clean["motion_prompt"]
            clip.ltx_video_prompt = clean["ltx_video_prompt"]
            clip.negative_prompt = clean["negative_prompt"]

        return [
            {
                "clip_id": c.clip_id,
                "slot_id": c.slot_id,
                "shot_type": self._visual_plans_cache.get(c.slot_id, {}).get("shot_type"),
                "motion_prompt": c.motion_prompt,
                "first_frame_prompt": (c.first_frame_prompt or "")[:120],
            }
            for c in self._clips_list
        ]

    def _re_enrich_clips_for_production(self) -> None:
        """Rigenera prompt densi su clip già in checkpoint (approvazione → produzione)."""
        self.regenerate_all_clip_prompts()

    async def run(self) -> AsyncGenerator[dict, None]:
        self._save_job(status="running")
        phase = self._reel_req.phase
        production = phase == "production" and self._load_checkpoint()
        storyboard_only = phase == "storyboard" and self._load_checkpoint()
        pipeline_completed = False

        from src.core.utils.project_paths import ensure_project_directory as _ensure_proj

        try:
            _proj_base = _ensure_proj(
                self._storage_project_id,
                title=self._reel_req.title or f"Reel {self.job_id}",
            )
            yield {
                "event": "start",
                "job_id": self.job_id,
                "mode": "createreel",
                "project_id": self._storage_project_id,
                "catalog_project_id": self._catalog_project_id,
                "storage_project_id": self._storage_project_id,
                "project_dir": str(_proj_base.resolve()),
            }

            if production:
                self._storyboard_approved = True
                self._re_enrich_clips_for_production()
                if self._has_source_audio:
                    self.req.img2video_workflow = "ltx_img_audio2video"
                    await self._ensure_clip_audio_slices()
                self._save_checkpoint(55)
                yield {"event": "resume", "job_id": self.job_id, "phase": "production", "pct": 0.46}
                for clip in self._clips_list:
                    yield {
                        **_reel_clip_sse_payload(
                            clip,
                            self._storage_project_id,
                            self,
                            getattr(self, "_visual_plans_cache", None),
                        ),
                        "event": "clip_queued",
                        "pct": 0.46,
                    }
                if self._trailer_audio_path is None or not self._trailer_audio_path.exists():
                    if self._has_source_audio:
                        async for ev in self._phase_reel_audio_compositor():
                            yield ev
                    else:
                        async for ev in self._phase_reel_silent_audio():
                            yield ev
                yield _reel_agent_event(
                    "comfyui",
                    "working",
                    f"Produzione HD + video — {len(self._clips_list)} clip",
                    pct=0.47,
                )
                async for ev in self._phase6_comfyui_generation():
                    yield ev
                async for ev in self._phase7_video_assembler():
                    yield ev
                pipeline_completed = True

            elif storyboard_only:
                yield {"event": "resume", "job_id": self.job_id, "phase": "storyboard", "pct": 0.42}
                async for ev in self._phase5b_storyboard_preview():
                    yield ev
                self._save_checkpoint(55)
                sb = self._storyboard_frames_payload()
                self._save_job(
                    status="awaiting_storyboard",
                    result={
                        "storyboard": sb,
                        "vision": self._vision,
                        "director_narrative": self._director_narrative,
                        "awaiting_storyboard": True,
                    },
                )
                yield {
                    "event": "awaiting_storyboard_approval",
                    "job_id": self.job_id,
                    "storyboard": sb,
                    "director_narrative": self._director_narrative,
                    "vision_summary": (self._vision.get("combined_style") or "")[:400],
                    "pct": 0.45,
                    "terminal": True,
                }

            else:
                cp_phase = 0
                if self._reel_req.resume_job_id:
                    cp_phase = self._restore_from_checkpoint_file()
                    if cp_phase > 0:
                        yield {
                            "event": "resume",
                            "job_id": self.job_id,
                            "checkpoint_phase": cp_phase,
                            "pct": 0.05,
                        }
                        async for ev in self._emit_checkpoint_catchup_events(cp_phase):
                            yield ev

                if cp_phase < 1:
                    async for ev in self._phase_reel_vision():
                        yield ev
                    self._save_checkpoint(1)
                async for ev in self._check_pause():
                    yield ev

                if self._has_source_audio:
                    if cp_phase < 2:
                        async for ev in self._phase_reel_audio_analysis():
                            yield ev
                        self._save_checkpoint(2)
                else:
                    if cp_phase < 2:
                        self._bootstrap_timeline()
                async for ev in self._check_pause():
                    yield ev

                if cp_phase < 3 or not self._director_ready():
                    async for ev in self._phase_reel_director():
                        yield ev
                self._save_checkpoint(3)
                async for ev in self._check_pause():
                    yield ev
                if cp_phase < 4:
                    if self._has_source_audio:
                        async for ev in self._phase_reel_audio_compositor():
                            yield ev
                    else:
                        async for ev in self._phase_reel_silent_audio():
                            yield ev
                    self._save_checkpoint(4)
                async for ev in self._check_pause():
                    yield ev
                if cp_phase < 5:
                    async for ev in self._phase5_reel_prompts():
                        yield ev
                self._save_checkpoint(5)
                async for ev in self._check_pause():
                    yield ev
                yield _reel_agent_event(
                    "comfyui",
                    "working",
                    f"Genero storyboard LD per {len(self._clips_list)} clip…",
                    pct=0.43,
                )
                async for ev in self._phase5b_storyboard_preview():
                    if ev.get("event") == "storyboard_frame" and ev.get("clip_id"):
                        yield _reel_agent_event(
                            "comfyui",
                            "working",
                            f"Storyboard anteprima: {ev.get('clip_id')}",
                            pct=ev.get("pct"),
                            clip_id=ev.get("clip_id"),
                        )
                    yield ev
                yield _reel_agent_event(
                    "comfyui",
                    "done",
                    "Storyboard LD completato — in attesa approvazione",
                    pct=0.45,
                )
                self._save_checkpoint(55)
                sb = self._storyboard_frames_payload()
                self._save_job(
                    status="awaiting_storyboard",
                    result={
                        "storyboard": sb,
                        "vision": self._vision,
                        "director_narrative": self._director_narrative,
                        "awaiting_storyboard": True,
                    },
                )
                yield {
                    "event": "awaiting_storyboard_approval",
                    "job_id": self.job_id,
                    "storyboard": sb,
                    "edl": self._edl.model_dump() if self._edl else None,
                    "vision_summary": (self._vision.get("combined_style") or "")[:400],
                    "director_narrative": self._director_narrative,
                    "pct": 0.45,
                    "terminal": True,
                }

            if pipeline_completed:
                self._save_checkpoint(99)
                self._save_job(status="done", result=self._last_result)
                cp = self._checkpoint_path()
                if cp.exists():
                    cp.unlink(missing_ok=True)
        except asyncio.CancelledError:
            self._save_job(
                status="interrupted",
                result=self._job_result_snapshot() or None,
                error="Pipeline annullata",
            )
            raise
        except Exception as exc:
            log.exception("reel_pipeline_fatal", error=str(exc))
            self._save_job(
                status="failed",
                result=self._job_result_snapshot() or None,
                error=str(exc),
            )
            yield {"error": str(exc), "phase": "fatal"}

    def _save_checkpoint(self, phase_num: int) -> None:
        try:
            from src.core.obsidian.pipeline_memory import phase_label as obs_phase_label

            payload = {
                "phase": phase_num,
                "phase_label": obs_phase_label("reel", phase_num),
                "job_id": self.job_id,
                "reel_description": self._reel_req.description,
                "request": self._reel_req.model_dump(),
                "vision": self._vision,
                "director_narrative": self._director_narrative,
                "ref_paths": [str(p) for p in self._ref_paths],
                "reference_image_paths": [str(p) for p in self._ref_paths],
                "sections": [s.model_dump() for s in self._sections],
                "downbeats": self._downbeats,
                "audio_duration": self._audio_duration,
                "audio_analysis_summary": getattr(self, "_audio_analysis_summary", None) or {},
                "lyric_beats": getattr(self, "_lyric_beats", None) or [],
                "slot_lyrics": getattr(self, "_slot_lyrics", None) or {},
                "lyrics": self._reel_req.lyrics,
                "audio_start_sec": self._audio_start_sec,
                "edl": self._edl.model_dump() if self._edl else None,
                "clips_list": [c.model_dump() for c in self._clips_list],
                "trailer_audio_path": str(self._trailer_audio_path) if self._trailer_audio_path else None,
                "storyboard_approved": getattr(self, "_storyboard_approved", False),
                "visual_plans": getattr(self, "_visual_plans_cache", None) or {},
                "final_deliverable": getattr(self, "_last_result", None),
            }
            self._checkpoint_path().write_text(
                json.dumps(payload, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
            self._persist_job_snapshot(phase_num)
            try:
                from src.core.config import get_config
                from src.core.obsidian.sync import schedule_obsidian_sync_from_checkpoint

                if get_config().obsidian.enabled and get_config().obsidian.auto_sync_on_checkpoint:
                    extra = {"config": self._reel_req.model_dump()}
                    schedule_obsidian_sync_from_checkpoint(
                        project_id=self._storage_project_id,
                        job_id=self.job_id,
                        pipeline_kind="reel",
                        checkpoint=payload,
                        extra=extra,
                    )
            except Exception:
                pass
        except Exception as e:
            log.warning("reel_checkpoint_save_failed", error=str(e))

    def _load_checkpoint(self) -> bool:
        path = next((p for p in self._checkpoint_path_candidates() if p.exists()), None)
        if not path:
            return False
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            self._apply_checkpoint_data(data)
            return bool(self._edl and self._clips_list)
        except Exception as e:
            log.warning("reel_checkpoint_load_failed", error=str(e))
            return False

    def _apply_checkpoint_data(self, data: dict) -> None:
        self._vision = data.get("vision") or {}
        self._director_narrative = data.get("director_narrative") or {}
        self._ref_paths = [Path(p) for p in data.get("ref_paths", []) if p]
        self._sections = [AudioSection(**s) for s in data.get("sections", [])]
        self._downbeats = data.get("downbeats", [])
        self._audio_duration = float(data.get("audio_duration", 0))
        edl_raw = data.get("edl")
        if edl_raw:
            self._edl = EDL(**edl_raw)
        self._clips_list = [TrailerClip(**c) for c in data.get("clips_list", [])]
        tap = data.get("trailer_audio_path")
        if tap:
            p = Path(tap)
            if p.exists():
                self._trailer_audio_path = p
        self._storyboard_approved = bool(data.get("storyboard_approved", False))
        vp = data.get("visual_plans")
        self._visual_plans_cache = vp if isinstance(vp, dict) else {}

    def _restore_from_checkpoint_file(self) -> int:
        """Ripristina stato parziale da checkpoint; ritorna numero fase (0 se assente)."""
        path = next((p for p in self._checkpoint_path_candidates() if p.exists()), None)
        if not path:
            return 0
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            self._apply_checkpoint_data(data)
            return int(data.get("phase") or 0)
        except Exception as e:
            log.warning("reel_checkpoint_restore_failed", error=str(e))
            return 0

    async def _check_pause(self) -> AsyncGenerator[dict, None]:
        from src.core import pipeline_registry

        ev = pipeline_registry.get_pause_event(self.job_id)
        if ev is None or ev.is_set():
            return
        yield {"event": "paused", "job_id": self.job_id, "msg": "Pipeline in pausa"}
        await ev.wait()
        yield {"event": "resumed", "job_id": self.job_id, "msg": "Pipeline ripresa"}

    def _director_ready(self) -> bool:
        dn = self._director_narrative or {}
        return bool(
            dn.get("logline")
            or dn.get("mood")
            or dn.get("narrative_arc")
            or (dn.get("visual_motifs") or [])
        )

    async def _emit_checkpoint_catchup_events(self, cp_phase: int) -> AsyncGenerator[dict, None]:
        """Eventi SSE sintetici dopo resume da checkpoint (allinea UI fasi)."""
        if cp_phase >= 1 and self._vision:
            yield {
                "event": "vision_analysis_done",
                "pct": 0.12,
                "image_count": len(self._ref_paths),
                "combined_style": (self._vision.get("combined_style") or "")[:400],
                "character_anchors": self._vision.get("character_anchors") or [],
                "environment_anchors": self._vision.get("environment_anchors") or [],
                "palette_hex": self._vision.get("palette_hex") or [],
                "wardrobe_notes": (self._vision.get("wardrobe_notes") or "")[:300],
                "continuity_rules": self._vision.get("continuity_rules") or [],
            }
        if cp_phase >= 2 and self._sections:
            yield {
                "event": "audio_analysis_done",
                "pct": 0.17,
                "sections": len(self._sections),
                "duration_sec": round(self._audio_duration, 2),
                "bpm": self._sections[0].bpm_local if self._sections else 0,
                "lyric_beats": len(getattr(self, "_lyric_beats", []) or []),
                "audio_start_sec": self._audio_start_sec,
            }
        if cp_phase >= 3 and self._edl and self._director_ready():
            yield {
                "event": "reel_plan_ready",
                "logline": self._director_narrative.get("logline", ""),
                "mood": self._director_narrative.get("mood", ""),
                "visual_theme": self._director_narrative.get("visual_theme", ""),
                "narrative_arc": self._director_narrative.get("narrative_arc", ""),
                "visual_motifs": self._director_narrative.get("visual_motifs") or [],
                "slots": len(self._edl.slots),
                "pct": 0.22,
            }
        if cp_phase >= 5 and self._clips_list:
            vp = getattr(self, "_visual_plans_cache", None) or {}
            for clip in self._clips_list:
                yield {
                    **_reel_clip_sse_payload(clip, self._storage_project_id, self, vp),
                    "event": "clip_queued",
                    "pct": 0.42,
                }
            yield {
                "event": "prompts_ready",
                "clips": [_reel_clip_sse_payload(c, self._storage_project_id, self, vp) for c in self._clips_list],
                "clip_count": len(self._clips_list),
                "pct": 0.42,
            }
