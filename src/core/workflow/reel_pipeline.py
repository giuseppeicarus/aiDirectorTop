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
    REEL_SUBJECT_SYSTEM,
    build_reel_director_user_prompt,
    build_reel_cinematographer_prompt,
    build_reel_prompt_engineer_user,
)
from src.core.llm.vision import analyze_reference_images

log = structlog.get_logger()

_REEL_COMFYUI_GENERATION_LOCK = asyncio.Lock()

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
    hd_w = int(pipeline._reel_req.width)
    hd_h = int(pipeline._reel_req.height)
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
        "use_prev_last_frame": clip.use_prev_last_frame,
        "scene_transition": clip.scene_transition,
    })
    # Storyboard fields: populate so UI can show previews without detail API call
    if clip.storyboard_path and Path(clip.storyboard_path).exists():
        sb_path = Path(clip.storyboard_path)
        api = pipeline._media_api_prefix() if pipeline else "reel"
        out["storyboard_ok"] = True
        out["storyboard_filename"] = sb_path.name
        out["storyboard_clip_url"] = f"/api/{api}/storyboard-clip/{storage_project_id}/{clip.clip_id}"
        if not out.get("storyboard_url"):
            out["storyboard_url"] = f"/api/{api}/storyboard/{storage_project_id}/{sb_path.name}"
        if out.get("status") is None:
            out["status"] = "storyboard"
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
    img_audio2video_workflow: str = "ltx_img_audio2video"
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
    regen_clip_id: Optional[str] = None      # fase regen_clip: clip_id da rigenerare
    regen_asset: Optional[str] = None        # first | last | video


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
    prev_scene_id: str = ""
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
        subject_ctx = anchor_str if anchor_str else (brief[:80].split(".")[0].strip() or "the primary subject")
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

        scene_id = s.get("scene_id") or slot_id
        same_scene_as_prev = bool(scene_id and scene_id == prev_scene_id and slot_i > 0)
        prev_scene_id = scene_id

        plan = {
            "slot_id": slot_id,
            "scene_id": scene_id,
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
            "use_prev_last_frame": same_scene_as_prev,
            "scene_transition": "continuity" if same_scene_as_prev else "scene_cut",
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

    async def _run_comfy_live(
        self,
        *args,
        emit=None,
        clip_id: str = "",
        kind: str = "frame",
        **kwargs,
    ):
        if _REEL_COMFYUI_GENERATION_LOCK.locked() and emit:
            await emit({
                "event": "progress",
                "msg": f"ComfyUI in coda sequenziale - {clip_id or kind}",
                "clip_id": clip_id,
                "kind": kind,
            })
        async with _REEL_COMFYUI_GENERATION_LOCK:
            return await super()._run_comfy_live(
                *args,
                emit=emit,
                clip_id=clip_id,
                kind=kind,
                **kwargs,
            )

    def __init__(self, request: ReelRequest) -> None:
        from src.core.utils.project_paths import (
            ensure_project_directory,
            resolve_reel_storage_project_id,
            reel_catalog_project_id,
        )
        from src.core.workflow.reel_jobs import job_storage_project_id

        request.concurrent_jobs = 1
        # Force comfyui backend to skip the txt2img probe that would load
        # z-image before LTX, causing OOM.
        if request.clip_backend == "auto":
            request.clip_backend = "comfyui"
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
            img2video_wf = request.img_audio2video_workflow or "ltx_img_audio2video"
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
        self._subject_card: Optional[str] = None
        self._subject_approved: bool = False
        self._recover_cooldown: dict[str, float] = {}
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
                dur = max(1.0, target - t)
            # Arrotonda la durata slot a interi (min 1s)
            dur = max(1.0, float(round(dur)))
            end = min(t + dur, target)
            edl_slots.append(EDLSlot(
                slot_id=s.get("slot_id") or f"slot_{i+1:03d}",
                section_id="reel_main",
                start_sec=float(round(t)),
                end_sec=float(round(end)),
                duration_sec=max(1.0, float(round(end - t))),
                section_type="verse",
                energy=s.get("energy") or "medium",
                emotion=s.get("emotion") or "cinematic",
                visual_hint=s.get("visual_hint") or self._reel_req.description[:100],
                scene_id=s.get("scene_id") or f"scene_{i:03d}",
                narrative_role=s.get("narrative_role") or "",
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
                    max_tokens=2500,
                ),
                timeout=240.0,
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
            # Build a more cinematographic fallback narrative instead of copying the brief raw
            _motifs = (vis.get("environment_anchors") or [])[:6] or self._extract_visual_motifs_from_brief()
            _style_hint = (self._reel_req.style or "").split(",")[0].strip()[:60]
            _logline_fallback = (
                f"A {_style_hint or 'cinematic'} journey through irony and isolation, "
                f"told through {_motifs[0] if _motifs else 'light and shadow'}.".strip()
            )
            self._director_narrative = {
                "logline":       _logline_fallback,
                "mood":          "intense",
                "visual_theme":  (vis.get("combined_style") or self._reel_req.style or "")[:200],
                "narrative_arc": (
                    f"The reel opens with restless intimacy and builds to ironic revelation, "
                    f"closing on a quiet moment of self-awareness. "                    f"The viewer moves from detached observer to complicit witness."
                ),
                "visual_motifs": _motifs,
            }
            yield _reel_agent_event(
                "narrative_director",
                "done",
                f"Piano fallback — {len(self._edl.slots)} slot",
                pct=0.21,
            )
            yield {"event": "reel_plan_fallback", "pct": 0.22}

    async def _phase_reel_audio_compositor(self) -> AsyncGenerator[dict, None]:
        """Estrae la finestra audio continua dalla sorgente (audio_start_sec → +duration_sec).

        Usa un singolo cut ffmpeg invece di slicing per slot — garantisce audio continuo
        senza artefatti alle giunture. I fade in/out vengono applicati sull'intera traccia.
        """
        yield {"event": "phase", "phase": "audio_compositor", "pct": 0.26}
        audio_src = Path(self.req.audio_path)
        if not audio_src.exists():
            raise FileNotFoundError(f"Audio source missing: {audio_src}")

        target_dur = float(self._reel_req.duration_sec)
        FADE_IN = 0.15
        FADE_OUT = 0.35
        fo_start = max(0.0, target_dur - FADE_OUT)
        trailer_audio = self._audio_dir / f"reel_audio_{self.job_id}.wav"

        rc, err = await _run_ffmpeg(
            "-y",
            "-ss", f"{self._audio_start_sec:.3f}",
            "-t", f"{target_dur:.3f}",
            "-i", str(audio_src),
            "-af", (
                f"afade=t=in:st=0:d={FADE_IN},"
                f"afade=t=out:st={fo_start:.3f}:d={FADE_OUT}"
            ),
            "-ar", "44100", "-ac", "2",
            str(trailer_audio),
        )
        if rc != 0:
            raise RuntimeError(f"reel audio composite failed: {err[-200:]}")
        self._trailer_audio_path = trailer_audio
        yield {
            "event": "audio_ready",
            "path": str(trailer_audio),
            "source_start_sec": round(self._audio_start_sec, 2),
            "source_end_sec": round(self._audio_start_sec + target_dur, 2),
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
                "scene_id": getattr(slot, "scene_id", "") or slot.slot_id,
                "section_type": slot.section_type,
                "energy": slot.energy,
                "emotion": slot.emotion,
                "visual_hint": hint,
                "duration_sec": slot.duration_sec,
                "style": self.req.style,
                "narrative_role": getattr(slot, "narrative_role", ""),
                "lyrics_segment": lyr,
            })

        # Restore visual_plans from checkpoint cache (avoids re-running cinematographer if already done)
        visual_plans: Dict[str, dict] = dict(getattr(self, "_visual_plans_cache", None) or {})
        if visual_plans:
            log.info("reel_dop_from_cache", slots=len(visual_plans))
            yield _reel_agent_event("cinematographer", "done", f"Piano DP da cache ({len(visual_plans)} slot)", pct=0.37)
            yield {"event": "dop_plan_ready", "plans": list(visual_plans.values()), "pct": 0.38, "source": "cache"}
        if not visual_plans:
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
                    timeout=360.0,
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

        # Persist visual_plans to checkpoint (phase 4) so prompt_engineer restarts don't redo cinematographer
        if visual_plans:
            self._visual_plans_cache = visual_plans
            self._save_checkpoint(4)  # Re-save phase 4 checkpoint with visual_plans populated

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
                            brief=self._reel_req.description,
                        ),
                        role="prompt_engineer",
                        temperature=0.60,
                        max_tokens=6000,
                    ),
                    timeout=420.0,
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
                clip_dur = max(1.0, float(round(clip_end - clip_start)))
                clip_id = f"clip_{clip_global_idx:03d}_{slot.slot_id}_{self.job_id[-6:]}"

                # First sub-clip of a slot: inherit director continuity decision.
                # Override: if this slot shares scene_id with the previous slot,
                # force continuity regardless of LLM output (same scene = shared frames).
                is_first_subclip = c_idx == 0
                use_prev = False
                scene_trans = "scene_cut"
                if is_first_subclip and clip_global_idx > 0:
                    _raw_upf = dop.get("use_prev_last_frame", False)
                    use_prev = (
                        _raw_upf is True
                        or str(_raw_upf).lower() == "true"
                    )
                    # Scene-id based override: same scene_id means visual continuity
                    if not use_prev and slot_i > 0:
                        prev_slot = self._edl.slots[slot_i - 1]
                        if (
                            slot.scene_id
                            and slot.scene_id == prev_slot.scene_id
                        ):
                            use_prev = True
                    scene_trans = "continuity" if use_prev else "scene_cut"
                elif not is_first_subclip:
                    use_prev = True
                    scene_trans = "continuity"

                clips.append(TrailerClip(
                    clip_id=clip_id,
                    slot_id=slot.slot_id,
                    start_sec=clip_start,
                    end_sec=clip_end,
                    duration_sec=int(clip_dur),
                    clip_index=clip_global_idx,
                    scene_prompt=clean["scene_prompt"],
                    first_frame_prompt=clean["first_frame_prompt"],
                    last_frame_prompt=clean["last_frame_prompt"],
                    motion_prompt=clean["motion_prompt"],
                    ltx_video_prompt=clean.get("ltx_video_prompt", ""),
                    negative_prompt=clean["negative_prompt"],
                    use_prev_last_frame=use_prev,
                    scene_transition=scene_trans,
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

    def _validate_frames_before_production(self) -> None:
        """Invalida clip il cui frame è un placeholder (<4KB) così viene rigenerato."""
        from src.core.utils.comfyui_outputs import is_real_comfy_image, COMFY_REAL_IMAGE_MIN_BYTES
        for clip in self._clips_list:
            ff_path = self._frames_dir / f"{clip.clip_id}_first.png"
            # Se il frame è placeholder/mancante azzera il path per forzare rigenera
            if not is_real_comfy_image(ff_path, min_bytes=COMFY_REAL_IMAGE_MIN_BYTES):
                clip.first_frame_path = None
                clip.last_frame_path = None
            # Se il video è un placeholder (<50KB) azzeralo per forzare rigenera
            if clip.clip_path:
                from src.core.utils.comfyui_outputs import is_real_comfy_video
                if not is_real_comfy_video(Path(clip.clip_path)):
                    clip.clip_path = None

    def _propagate_prev_last_frames(self) -> None:
        """For clips with use_prev_last_frame=True, copy the previous clip's last frame
        as this clip's first frame (if the previous frame exists and is valid)."""
        import shutil
        from src.core.utils.comfyui_outputs import is_real_comfy_image, COMFY_REAL_IMAGE_MIN_BYTES
        for i, clip in enumerate(self._clips_list):
            if not clip.use_prev_last_frame or i == 0:
                continue
            prev = self._clips_list[i - 1]
            # Find the previous clip's last frame (prefer explicit path, fall back to canon file)
            prev_lf: Optional[Path] = None
            if prev.last_frame_path:
                p = Path(prev.last_frame_path)
                if is_real_comfy_image(p, min_bytes=COMFY_REAL_IMAGE_MIN_BYTES):
                    prev_lf = p
            if prev_lf is None:
                canon = self._frames_dir / f"{prev.clip_id}_last.png"
                if is_real_comfy_image(canon, min_bytes=COMFY_REAL_IMAGE_MIN_BYTES):
                    prev_lf = canon
            if prev_lf is None:
                # Last frame file missing — try to extract it from the existing video clip.
                # This recovers from runs where video was generated but last-frame extraction
                # failed silently (e.g. ffmpeg error or _hd_frame_ok wrongly rejected it).
                if prev.clip_path:
                    video_p = Path(prev.clip_path)
                    if video_p.is_file() and video_p.stat().st_size > 50_000:
                        canon = self._frames_dir / f"{prev.clip_id}_last.png"
                        try:
                            import subprocess as _sp
                            _sp.run(
                                [
                                    "ffmpeg", "-y", "-sseof", "-0.1",
                                    "-i", str(video_p),
                                    "-vframes", "1", "-q:v", "2", str(canon),
                                ],
                                capture_output=True,
                                timeout=30,
                            )
                        except Exception as _exc:
                            log.warning("propagate_last_frame_extract_failed",
                                        clip_id=prev.clip_id, error=str(_exc))
                        if is_real_comfy_image(canon, min_bytes=COMFY_REAL_IMAGE_MIN_BYTES):
                            prev.last_frame_path = str(canon)
                            prev_lf = canon
                            log.info("last_frame_extracted_from_video",
                                     clip_id=prev.clip_id, dest=str(canon))
            if prev_lf is None:
                # Last frame not ready yet — skip (will inherit during generation if available)
                continue
            dest = self._frames_dir / f"{clip.clip_id}_first.png"
            if is_real_comfy_image(dest, min_bytes=COMFY_REAL_IMAGE_MIN_BYTES):
                # First frame already generated — no override needed
                continue
            try:
                shutil.copy2(prev_lf, dest)
                clip.first_frame_path = str(dest)
                clip.first_frame_comfy = None  # force re-upload to ComfyUI
                log.info("prev_last_frame_propagated",
                         clip_id=clip.clip_id, src=str(prev_lf), dest=str(dest))
            except Exception as exc:
                log.warning("prev_last_frame_propagate_failed",
                            clip_id=clip.clip_id, error=str(exc))

    async def run(self) -> AsyncGenerator[dict, None]:
        self._save_job(status="running")
        phase = self._reel_req.phase
        production = phase == "production" and self._load_checkpoint()
        storyboard_only = phase == "storyboard" and self._load_checkpoint()
        assemble_only = phase == "assemble_only" and self._load_checkpoint()
        regen_clip = phase == "regen_clip" and bool(self._reel_req.regen_clip_id) and self._load_checkpoint()
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
                    self.req.img2video_workflow = self._reel_req.img_audio2video_workflow or "ltx_img_audio2video"
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
                # Give ComfyUI time to unload the storyboard txt2img model before
                # Free storyboard model from VRAM before HD+video phase starts.
                # This avoids OOM when z-image and LTX would overlap in VRAM.
                yield _reel_agent_event(
                    "comfyui",
                    "working",
                    "Scarico modello storyboard da VRAM…",
                    pct=0.46,
                )
                await self._comfyui_free_vram(wait_sec=5.0)
                # Invalida frame/video placeholder prima della generazione HD
                self._validate_frames_before_production()
                # Propaga last frame precedente come first frame per clip in continuità
                self._propagate_prev_last_frames()
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

            elif assemble_only:
                # Solo riassembla le clip esistenti → nuovo video finale
                self._validate_frames_before_production()
                yield {"event": "resume", "job_id": self.job_id, "phase": "assemble_only", "pct": 0.88}
                async for ev in self._phase7_video_assembler():
                    yield ev
                pipeline_completed = True

            elif regen_clip:
                # Rigenera una singola clip e poi riassembla il video finale
                regen_id = self._reel_req.regen_clip_id
                clip_obj = next((c for c in self._clips_list if c.clip_id == regen_id), None)
                if clip_obj is None:
                    yield {"event": "error", "msg": f"clip_id {regen_id!r} non trovata nel checkpoint", "pct": 0}
                else:
                    regen_asset = (self._reel_req.regen_asset or "video").lower()
                    if regen_asset not in {"first", "last", "video"}:
                        regen_asset = "video"
                    yield {
                        "event": "resume",
                        "job_id": self.job_id,
                        "phase": "regen_clip",
                        "clip_id": regen_id,
                        "regen_asset": regen_asset,
                        "pct": 0.50,
                    }
                    # Invalida solo l'asset richiesto. Se cambia un frame,
                    # il video della clip va rigenerato perché usa quei frame.
                    if regen_asset == "first":
                        clip_obj.first_frame_path = None
                        clip_obj.first_frame_comfy = None
                        clip_obj.clip_path = None
                    elif regen_asset == "last":
                        clip_obj.last_frame_path = None
                        clip_obj.last_frame_comfy = None
                        clip_obj.clip_path = None
                    else:
                        clip_obj.clip_path = None
                    if self._has_source_audio:
                        self.req.img2video_workflow = self._reel_req.img_audio2video_workflow or "ltx_img_audio2video"
                    # For continuity clips (use_prev_last_frame) Phase A is skipped:
                    # propagate the previous clip's last frame so Phase C has a valid input.
                    self._propagate_prev_last_frames()
                    yield _reel_agent_event("comfyui", "working", f"Rigenero clip {regen_id}…", pct=0.52)
                    await self._comfyui_free_vram(wait_sec=3.0)
                    clip_dest = self._clips_dir / f"{clip_obj.clip_id}.mp4"
                    try:
                        clip_dest.unlink(missing_ok=True)
                    except OSError as exc:
                        log.warning(
                            "regen_clip_delete_old_video_failed",
                            clip_id=clip_obj.clip_id,
                            path=str(clip_dest),
                            error=str(exc),
                        )
                    all_clips = self._clips_list
                    self._clips_list = [clip_obj]
                    self._regen_asset_filter = regen_asset
                    try:
                        async for ev in self._phase6_comfyui_generation():
                            yield ev
                    finally:
                        self._regen_asset_filter = None
                        self._clips_list = all_clips
                    self._save_checkpoint(6)
                    if regen_asset in {"first", "last", "video"}:
                        yield _reel_agent_event("comfyui", "working", "Riassemblo video finale…", pct=0.88)
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
                self._save_job(status="done", result=self._job_result_snapshot())
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
                "subject_card": getattr(self, "_subject_card", None) or "",
                "subject_approved": getattr(self, "_subject_approved", False),
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
        self._audio_start_sec = float(data.get("audio_start_sec") or 0.0)
        self._lyric_beats = data.get("lyric_beats") or []
        self._slot_lyrics = data.get("slot_lyrics") or {}
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
        self._subject_card = data.get("subject_card") or None
        self._subject_approved = bool(data.get("subject_approved", False))

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

    def _extract_visual_motifs_from_brief(self) -> list[str]:
        """Extract key visual motifs from brief + style when LLM director fails."""
        import re as _re

        brief = (self._reel_req.description or "").lower()
        style = (self._reel_req.style or "").lower()
        combined = f"{brief} {style}"
        motifs: list[str] = []

        _MOTIF_PATTERNS: list[tuple[str, str]] = [
            (r"\b(?:circo|circus|tendone|big top)\b", "decaying circus tent under stormy light"),
            (r"\b(?:clown|pagliaccio)\b", "clown with smeared white makeup and hollow eyes"),
            (r"\b(?:specchi?|mirror)\b", "warped funhouse mirrors distorting reality"),
            (r"\b(?:neon|insegne al neon)\b", "broken neon signs flickering red and blue"),
            (r"\b(?:fumo|smoke|nebbia|fog)\b", "volumetric fog and smoke drifting through the space"),
            (r"\b(?:pioggia|rain)\b", "rain-soaked surfaces reflecting crimson light"),
            (r"\b(?:acrobat|acrobata|ballerina)\b", "acrobatic performer suspended mid-air on ropes"),
            (r"\b(?:rouge|crimson|rosso|red)\b", "deep crimson color bleeding through shadows"),
            (r"\b(?:industrial|glitch|noise)\b", "industrial glitch textures and distorted percussive light"),
            (r"\b(?:noir)\b", "noir chiaroscuro with hard shadows and wet streets"),
            (r"\b(?:surreal|allucinazion)\b", "surreal visual logic where gravity and scale break"),
            (r"\b(?:horror|horreur|spettro)\b", "horror spectacle staging with theatrical excess"),
            (r"\b(?:marionette?|puppet)\b", "puppet or marionette figures with broken joints"),
            (r"\b(?:sangue|blood)\b", "blood-red visual symbolism in costume and set detail"),
            (r"\b(?:fuoco|fire|fiamma)\b", "controlled fire and ember light in the background"),
        ]
        for pattern, motif in _MOTIF_PATTERNS:
            if _re.search(pattern, combined, _re.I):
                motifs.append(motif)
            if len(motifs) >= 6:
                break

        if not motifs:
            # Generic fallback from style keywords
            style_words = [w.strip().rstrip(",") for w in self._reel_req.style.split() if len(w) > 4]
            motifs = style_words[:5]

        return motifs[:6]

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
