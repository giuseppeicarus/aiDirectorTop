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
from src.core.llm.reel_prompts import (
    REEL_DIRECTOR_SYSTEM,
    REEL_CINEMATOGRAPHER_SYSTEM,
    REEL_PROMPT_ENGINEER_SYSTEM,
    build_reel_director_user_prompt,
    build_reel_cinematographer_prompt,
    build_reel_prompt_engineer_user,
)
from src.core.llm.vision import analyze_reference_images

log = structlog.get_logger()


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
    txt2img_workflow: str = "z_image_txt2img"
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


def _build_visual_plans_from_edl(
    slot_descs: list[dict],
    *,
    style: str,
    director_narrative: dict,
    vision: dict,
) -> dict[str, dict]:
    """Build DP visual plans directly from director's EDL when cinematographer LLM fails."""
    from src.core.llm.generation_prompt_sanitize import finalize_positive_prompt

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

    plans: dict[str, dict] = {}
    for s in slot_descs:
        slot_id = s["slot_id"]
        visual_hint = (s.get("visual_hint") or "").strip()
        emotion = (s.get("emotion") or "cinematic").strip()
        energy = (s.get("energy") or "medium").lower()
        shot = _energy_to_shot.get(energy, "medium")
        move = _energy_to_move.get(energy, "slow dolly in")
        lens = _energy_to_lens.get(energy, 50)

        # Build scene description from director's visual_hint + mood + motifs
        scene_parts = [visual_hint]
        if anchor_str:
            scene_parts.append(anchor_str)
        if motif_str:
            scene_parts.append(motif_str)
        scene_desc = ". ".join(p for p in scene_parts if p)

        # First frame: opening of the visual hint
        first_state = f"{visual_hint}, {emotion} mood, {style}" if visual_hint else f"{emotion} mood, {style}"
        if anchor_str:
            first_state = f"{anchor_str}, {first_state}"

        # Last frame: progression from first
        last_state = f"{visual_hint}, moment of resolution, {mood}, {style}"
        if anchor_str:
            last_state = f"{anchor_str}, {last_state}"

        plans[slot_id] = {
            "slot_id": slot_id,
            "shot_type": shot,
            "lens_mm": lens,
            "depth_of_field": "shallow" if energy in ("high", "peak") else "medium",
            "camera_movement": move,
            "lighting": f"warm directional light, {mood}",
            "composition": "rule of thirds, subject in focus",
            "scene_description": scene_desc[:400],
            "first_frame_state": first_state[:300],
            "last_frame_state": last_state[:300],
            "motion_intent": f"{move}, {emotion}",
            "color_grade_note": f"cinematic grade, {mood}",
        }
    return plans


def _build_prompt_map_from_visual_plans(
    visual_plans: dict[str, dict],
    *,
    style: str,
    director_narrative: dict,
    vision: dict,
) -> dict[str, dict]:
    """Build final generation prompts directly from visual_plans when prompt_engineer LLM fails."""
    from src.core.llm.generation_prompt_sanitize import (
        CINEMATIC_NEGATIVE_PROMPT,
        finalize_positive_prompt,
    )

    dn = director_narrative or {}
    mood = dn.get("mood", "cinematic")
    anchors = (vision.get("character_anchors") or [])[:4]
    anchor_str = ", ".join(anchors) if anchors else ""

    result: dict[str, dict] = {}
    for slot_id, plan in visual_plans.items():
        shot = plan.get("shot_type", "medium")
        lens = plan.get("lens_mm", 50)
        dof = plan.get("depth_of_field", "shallow")
        lighting = plan.get("lighting", "cinematic lighting")
        color = plan.get("color_grade_note", "")
        first_state = plan.get("first_frame_state", plan.get("scene_description", ""))
        last_state = plan.get("last_frame_state", plan.get("scene_description", ""))
        motion = plan.get("motion_intent", "camera slowly pushes forward")
        scene_desc = plan.get("scene_description", "")

        tech = f"{lens}mm lens, {dof} depth of field, photorealistic, 8k, sharp focus"

        def _build_frame(state: str, role: str) -> str:
            parts = [
                f"{style}, {shot} shot",
                anchor_str if anchor_str else "",
                state,
                lighting,
                f"{color}, {mood}",
                tech,
            ]
            prompt = ", ".join(p.strip() for p in parts if p.strip())
            return finalize_positive_prompt(prompt)

        scene_prompt = finalize_positive_prompt(
            f"{style}, {shot} shot, {scene_desc[:120]}, {lighting}, {mood}, {tech}"
        )
        motion_clean = motion.split(",")[0].strip()[:80]

        result[slot_id] = {
            "slot_id": slot_id,
            "scene_prompt": scene_prompt,
            "first_frame_prompt": _build_frame(first_state, "first"),
            "last_frame_prompt": _build_frame(last_state, "last"),
            "motion_prompt": motion_clean,
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

        silent = base / "audio" / "source_silent.wav"
        silent.parent.mkdir(parents=True, exist_ok=True)

        trailer_req = TrailerRequest(
            project_id=self._storage_project_id,
            audio_path=str(silent),
            audio_name="reel_silent.wav",
            lyrics=None,
            duration_sec=request.duration_sec,
            style=request.style,
            aspect_ratio=request.aspect_ratio,
            width=request.width,
            height=request.height,
            fps=request.fps,
            txt2img_workflow=request.txt2img_workflow,
            img2video_workflow=request.img2video_workflow,
            concurrent_jobs=request.concurrent_jobs,
            max_clip_sec=request.max_clip_sec,
            resume_job_id=request.resume_job_id,
            phase=request.phase,
            clip_backend=request.clip_backend,
            allow_ffmpeg_fallback=request.allow_ffmpeg_fallback,
            storyboard_max_side=request.storyboard_max_side,
            storyboard_steps=request.storyboard_steps,
        )

        self.req = trailer_req
        self._frames_dir = base / "frames"
        self._clips_dir = base / "clips"
        self._final_dir = base / "final"
        self._audio_dir = base / "audio"
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
        self._vision: dict[str, Any] = {}
        self._director_narrative: dict[str, Any] = {}
        self._ref_paths: List[Path] = []

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
        for i, raw in enumerate(self._reel_req.reference_image_paths):
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
        yield {
            "event": "progress",
            "msg": f"Analisi vision — {len(refs)} immagini di riferimento…",
            "pct": 0.06,
        }
        self._vision = await analyze_reference_images(
            refs,
            brief=self._reel_req.description,
            style=self._reel_req.style,
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

    def _edl_from_director_slots(self, slots_raw: list[dict]) -> EDL:
        target = float(self._reel_req.duration_sec)
        if not slots_raw:
            n = max(3, min(8, int(math.ceil(target / self.req.max_clip_sec))))
            weights = [1.0] * n
            slots_raw = [
                {
                    "slot_id": f"slot_{i+1:03d}",
                    "emotion": "cinematic",
                    "visual_hint": self._reel_req.description[:120],
                    "duration_weight": 1.0,
                }
                for i in range(n)
            ]
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
        n_hint = self._reel_req.num_slots or max(
            3, min(10, int(math.ceil(self._reel_req.duration_sec / self.req.max_clip_sec))),
        )
        user = build_reel_director_user_prompt(
            brief=self._reel_req.description,
            style=self._reel_req.style,
            aspect_ratio=self._reel_req.aspect_ratio,
            duration_sec=self._reel_req.duration_sec,
            vision=self._vision,
        ) + f"\n\nTarget approximately {n_hint} slots."
        try:
            raw = await asyncio.wait_for(
                _llm_json(
                    REEL_DIRECTOR_SYSTEM,
                    user,
                    role="narrative_director",
                    temperature=0.65,
                    max_tokens=2048,
                ),
                timeout=300.0,
            )
            slots_raw = raw.get("slots") or []
            self._edl = self._edl_from_director_slots(slots_raw)
            self._director_narrative = {
                "logline":       raw.get("logline", ""),
                "mood":          raw.get("mood", ""),
                "visual_theme":  raw.get("visual_theme", ""),
                "narrative_arc": raw.get("narrative_arc", ""),
                "visual_motifs": raw.get("visual_motifs") or [],
            }
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
            yield {"event": "reel_plan_fallback", "pct": 0.22}

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

        slot_descs = [
            {
                "slot_id": slot.slot_id,
                "section_type": slot.section_type,
                "energy": slot.energy,
                "emotion": slot.emotion,
                "visual_hint": slot.visual_hint,
                "duration_sec": slot.duration_sec,
                "style": self.req.style,
            }
            for slot in self._edl.slots
        ]

        visual_plans: Dict[str, dict] = {}
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
                    max_tokens=2500,
                ),
                timeout=360.0,
            )
            visual_plans = _normalize_dop_llm_result(raw_dop)
            if visual_plans:
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
            )
            yield {"event": "dop_plan_ready", "plans": list(visual_plans.values()), "pct": 0.38, "source": "director_fallback"}

        prompt_map: Dict[str, dict] = {}
        if visual_plans:
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
                        max_tokens=3500,
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
            )
            yield {"event": "progress", "msg": "Prompt map built from visual plans", "pct": 0.40, "source": "visual_plans_fallback"}

        from src.core.llm.generation_prompt_sanitize import sanitize_trailer_clip_prompts
        from src.core.workflow.trailer_pipeline import _nearest_downbeat

        clips: List[TrailerClip] = []
        clip_global_idx = 0

        for slot in self._edl.slots:
            pdata = prompt_map.get(slot.slot_id, {})
            dop = visual_plans.get(slot.slot_id, {})
            clean = sanitize_trailer_clip_prompts(
                pdata, dop, style=self.req.style, slot_emotion=slot.emotion,
            )
            clip_count = max(1, math.ceil(slot.duration_sec / self.req.max_clip_sec))
            for c_idx in range(clip_count):
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
                    negative_prompt=clean["negative_prompt"],
                ))
                clip_global_idx += 1
                payload = _clip_prompt_payload(clips[-1], self._storage_project_id)
                payload["event"] = "clip_prompt_ready"
                payload["pct"] = round(0.40 + 0.02 * (clip_global_idx / max(len(self._edl.slots), 1)), 3)
                yield payload

        self._clips_list = clips
        yield {"event": "prompts_ready", "clip_count": len(clips), "pct": 0.42}

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
                self._save_checkpoint(55)
                yield {"event": "resume", "job_id": self.job_id, "phase": "production", "pct": 0.46}
                for clip in self._clips_list:
                    yield {**_clip_prompt_payload(clip, self._storage_project_id), "event": "clip_queued", "pct": 0.46}
                if self._trailer_audio_path is None or not self._trailer_audio_path.exists():
                    async for ev in self._phase_reel_silent_audio():
                        yield ev
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
                async for ev in self._phase_reel_vision():
                    yield ev
                self._save_checkpoint(1)
                self._bootstrap_timeline()
                async for ev in self._phase_reel_director():
                    yield ev
                self._save_checkpoint(3)
                async for ev in self._phase_reel_silent_audio():
                    yield ev
                self._save_checkpoint(4)
                async for ev in self._phase5_reel_prompts():
                    yield ev
                self._save_checkpoint(5)
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
                    "edl": self._edl.model_dump() if self._edl else None,
                    "vision_summary": (self._vision.get("combined_style") or "")[:400],
                    "director_narrative": self._director_narrative,
                    "pct": 0.45,
                    "terminal": True,
                }

            if pipeline_completed:
                self._save_job(status="done", result=self._last_result)
                cp = self._checkpoint_path()
                if cp.exists():
                    cp.unlink(missing_ok=True)
        except asyncio.CancelledError:
            self._save_job(status="interrupted", error="Pipeline annullata")
            raise
        except Exception as exc:
            log.exception("reel_pipeline_fatal", error=str(exc))
            self._save_job(status="failed", error=str(exc))
            yield {"error": str(exc), "phase": "fatal"}

    def _save_checkpoint(self, phase_num: int) -> None:
        try:
            payload = {
                "phase": phase_num,
                "reel_description": self._reel_req.description,
                "vision": self._vision,
                "director_narrative": self._director_narrative,
                "ref_paths": [str(p) for p in self._ref_paths],
                "sections": [s.model_dump() for s in self._sections],
                "downbeats": self._downbeats,
                "audio_duration": self._audio_duration,
                "edl": self._edl.model_dump() if self._edl else None,
                "clips_list": [c.model_dump() for c in self._clips_list],
                "trailer_audio_path": str(self._trailer_audio_path) if self._trailer_audio_path else None,
                "storyboard_approved": getattr(self, "_storyboard_approved", False),
            }
            self._checkpoint_path().write_text(
                json.dumps(payload, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
        except Exception as e:
            log.warning("reel_checkpoint_save_failed", error=str(e))

    def _load_checkpoint(self) -> bool:
        path = next((p for p in self._checkpoint_path_candidates() if p.exists()), None)
        if not path:
            return False
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
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
            return bool(self._edl and self._clips_list)
        except Exception as e:
            log.warning("reel_checkpoint_load_failed", error=str(e))
            return False
