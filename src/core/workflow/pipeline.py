"""
CinematicPipeline — orchestra tutti gli stage:
LLM1 Story Analysis → LLM2 Narrative Arc → LLM3 Shot List →
LLM4 Prompt Generation → LLM5 Continuity Check →
Frame Gen (ComfyUI) → Video Gen (ComfyUI) → Assembly (FFmpeg)
"""

import asyncio, json, time, uuid
from pathlib import Path
from typing import Callable, List, Literal, Optional
import structlog

from src.core.config import get_config
from src.core.models.cinematic import (
    CinematicProject, CinematicShot, ProjectInput, StoryAnalysis, StoryArc,
)
from src.core.workflow.story_analyst      import analyze_story
from src.core.workflow.narrative_director import generate_narrative_arc
from src.core.workflow.cinematographer    import generate_shot_list
from src.core.workflow.prompt_engineer    import generate_frame_prompts
from src.core.workflow.continuity_checker import check_continuity
from src.core.comfyui.pool                import ComfyUINodePool
from src.core.comfyui.workflow_builder    import (
    build_txt2img_workflow, build_img2video_workflow, extract_output_files,
    build_ltx_director_shot_workflow, build_ltx_director_full_video_workflow,
)
from src.core import pipeline_registry
from src.core.utils.media_registry import (
    register_media,
    prompt_for_assembly_final,
    prompt_for_cinematic_shot,
    prompt_for_shots_summary,
)

log = structlog.get_logger()

# Keep strong references to background media-registration tasks so Python's GC
# cannot collect them before they complete (fire-and-forget pattern).
_bg_tasks: set = set()


def _fire_register(coro) -> None:
    """Schedule a coroutine as a background task with a GC-safe reference."""
    task = asyncio.create_task(coro)
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)

Stage = Literal[
    "story_analysis","narrative_arc","shot_list",
    "prompt_generation","continuity_check",
    "frame_gen","video_gen","assembly",
]

STAGE_WEIGHTS: dict = {
    "story_analysis":    0.06,
    "narrative_arc":     0.08,
    "shot_list":         0.08,
    "prompt_generation": 0.08,
    "continuity_check":  0.05,
    "frame_gen":         0.35,
    "video_gen":         0.25,
    "assembly":          0.05,
}


class PipelineProgress:
    def __init__(self, stage, stage_progress, message,
                 shot_id=None, artifact_path=None, error=None,
                 event_type="progress", extra=None):
        self.stage = stage
        self.stage_progress = stage_progress
        self.total_progress = self._total(stage, stage_progress)
        self.message = message
        self.shot_id = shot_id
        self.artifact_path = artifact_path
        self.error = error
        self.event_type = event_type   # "progress"|"llm_prompt"|"llm_thinking"|"llm_output"|"stage_complete"
        self.extra = extra or {}

    def _total(self, stage, sp):
        if sp < 0:
            sp = 0
        keys = list(STAGE_WEIGHTS)
        done = sum(w for s, w in STAGE_WEIGHTS.items() if keys.index(s) < keys.index(stage))
        return min(1.0, done + STAGE_WEIGHTS[stage] * sp)

    def to_dict(self):
        return {
            "stage": self.stage,
            "stage_progress": round(max(0, self.stage_progress), 3),
            "total_progress": round(self.total_progress, 3),
            "message": self.message,
            "shot_id": self.shot_id,
            "artifact_path": self.artifact_path,
            "error": self.error,
            "event_type": self.event_type,
            "extra": self.extra,
        }


async def _with_heartbeat(
    coro,
    stage: str,
    pct: float,
    on_progress: Callable,
    interval: float = 6.0,
):
    """Run coro, emit llm_thinking heartbeat every `interval` seconds while waiting."""
    start = time.time()

    async def _hb():
        while True:
            await asyncio.sleep(interval)
            elapsed = int(time.time() - start)
            on_progress(PipelineProgress(
                stage, pct,
                f"LLM in elaborazione... {elapsed}s",
                event_type="llm_thinking",
                extra={"elapsed_sec": elapsed},
            ))

    hb_task = asyncio.create_task(_hb())
    try:
        return await coro
    finally:
        hb_task.cancel()
        try:
            await hb_task
        except asyncio.CancelledError:
            pass


class CinematicPipeline:

    def __init__(self, project_id: str):
        self.project_id = project_id
        self._run_id = str(uuid.uuid4())
        cfg = get_config()
        self._cfg = cfg
        from src.core.utils.project_paths import ensure_project_directory

        base = ensure_project_directory(project_id)
        self._frames = base / "frames"
        self._clips  = base / "clips"
        self._final  = base / "final"
        self._state_path = base / "pipeline_state.json"
        self._pool = ComfyUINodePool()
        self._project_title: str = ""
        self._workflows: dict = {}   # populated by run() from PipelineRunRequest.workflows

    async def _load_project_title(self) -> str:
        """Load project title from pipeline state or DB (for copilot mode)."""
        # Try pipeline_state.json first (fast, no DB)
        state = self._load_state()
        inp_data = state.get("data", {}).get("story_analysis", {})
        if not inp_data:
            # Try from arc title
            arc = state.get("data", {}).get("story_arc", {})
            if arc.get("title"):
                return arc["title"]
        # Fall back to DB
        try:
            from src.core.database import AsyncSessionLocal
            from src.core.models.project import ProjectORM
            async with AsyncSessionLocal() as session:
                proj = await session.get(ProjectORM, self.project_id)
                if proj:
                    return proj.title
        except Exception:
            pass
        return self.project_id

    def _load_state(self):
        return json.loads(self._state_path.read_text(encoding='utf-8')) if self._state_path.exists() \
               else {"completed_stages": [], "shot_states": {}, "data": {}}

    def _vault_memory(self, llm_stage: str, shot_id: Optional[str] = None) -> str:
        try:
            from src.core.obsidian.context_for_llm import get_regia_memory_for_stage

            return get_regia_memory_for_stage(
                self.project_id, llm_stage, shot_id=shot_id, max_chars=8000,
            )
        except Exception:
            return ""

    def _save_state(self, s):
        # Atomic write: write to temp file then rename to avoid empty state on crash
        tmp = self._state_path.with_suffix('.tmp')
        tmp.write_text(json.dumps(s, indent=2, ensure_ascii=False), encoding='utf-8')
        tmp.replace(self._state_path)
        try:
            from src.core.config import get_config
            from src.core.obsidian.sync import schedule_obsidian_sync_cinematic

            if get_config().obsidian.enabled and get_config().obsidian.auto_sync_on_checkpoint:
                schedule_obsidian_sync_cinematic(self.project_id, self._state_path)
        except Exception:
            pass

    async def _check_pause(self, pause_event, on_progress, stage: str, pct: float):
        """If pause_event is cleared, emit a paused event and wait until resumed."""
        if pause_event is None or pause_event.is_set():
            return
        on_progress(PipelineProgress(stage, pct, "Pipeline in pausa — in attesa di ripresa...", event_type="paused"))
        await pause_event.wait()
        on_progress(PipelineProgress(stage, pct, "Pipeline ripresa", event_type="resumed"))

    async def run(self, inp: ProjectInput, on_progress: Callable, phase: str = "all",
                  pause_event: asyncio.Event = None,
                  workflows: Optional[dict] = None) -> str:
        """
        Execute the pipeline.

        phase="all"         — run every stage end-to-end (default / FullAuto mode)
        phase="storyboard"  — run only the five LLM stages; stop after continuity_check
                              and return "storyboard_complete"
        phase="production"  — skip LLM stages (already checkpointed); start at frame_gen

        workflows — dict with keys: txt2img, img2video, img_audio2video
                    each value is a workflow ID from the catalog
        """
        state = self._load_state()
        done = state["completed_stages"]
        state["project_input"] = inp.model_dump()
        cfg = get_config()
        self._workflows = workflows or {}

        self._project_title = inp.title
        pipeline_registry.register_run(self.project_id, inp.title, self._run_id)

        def emit(stage, pct, msg, event_type="progress", extra=None, **kw):
            p = PipelineProgress(stage, pct, msg, event_type=event_type, extra=extra or {}, **kw)
            on_progress(p)
            pipeline_registry.update_run(self.project_id, stage, p.total_progress)

        try:
            # ── LLM stages (skipped when phase=="production") ────────────────
            if phase != "production":

                # LLM 1 — Story Analysis
                if "story_analysis" not in done:
                    role_cfg = cfg.get_llm_for_role("story_analyst")
                    emit("story_analysis", 0.0, "LLM 1 — Analista Narrativo: preparazione prompt...",
                         event_type="llm_prompt",
                         extra={
                             "role": "story_analyst",
                             "label": "Analista Narrativo",
                             "provider": role_cfg.provider,
                             "model": role_cfg.model,
                             "description": "Analizza brief, liriche e audio -> estrae temi, emozioni, metafore visive",
                         })

                    def on_event_sa(data):
                        emit("story_analysis", 0.5, data.get("msg", "LLM 1 in elaborazione"),
                             event_type=data.get("type", "progress"), extra=data)

                    sa = await _with_heartbeat(
                        analyze_story(
                            inp,
                            on_event=on_event_sa,
                            vault_context=self._vault_memory("story_analyst"),
                        ),
                        "story_analysis", 0.3, on_progress,
                    )
                    state["data"]["story_analysis"] = sa.model_dump()
                    done.append("story_analysis"); self._save_state(state)
                    emit("story_analysis", 1.0, "Analisi narrativa completata",
                         event_type="llm_output",
                         extra={
                             "themes": sa.themes[:6],
                             "visual_metaphors": (sa.visual_metaphors or [])[:4],
                             "emotion_count": len(sa.emotion_progression),
                             "narrative_summary": (sa.narrative_summary or "")[:400],
                             "color_mood": sa.color_mood or "",
                         })
                    emit("story_analysis", 1.0, "Stage completato: Analisi narrativa", event_type="stage_complete")
                else:
                    sa = StoryAnalysis(**state["data"]["story_analysis"])

                await self._check_pause(pause_event, on_progress, "narrative_arc", 0.0)
                # LLM 2 — Narrative Arc
                if "narrative_arc" not in done:

                    role_cfg = cfg.get_llm_for_role("narrative_director")
                    emit("narrative_arc", 0.0, "LLM 2 — Regista Narrativo: costruzione arco narrativo...",
                         event_type="llm_prompt",
                         extra={
                             "role": "narrative_director",
                             "label": "Regista Narrativo",
                             "provider": role_cfg.provider,
                             "model": role_cfg.model,
                             "description": "Genera sequenze, scene e shot placeholder con continuità narrativa",
                             "input_themes": sa.themes[:4],
                         })

                    arc = await _with_heartbeat(
                        generate_narrative_arc(
                            sa, inp,
                            vault_context=self._vault_memory("narrative_director"),
                        ),
                        "narrative_arc", 0.3, on_progress,
                    )
                    state["data"]["story_arc"] = arc.model_dump()
                    done.append("narrative_arc"); self._save_state(state)
                    total_scenes = sum(len(seq.scenes) for seq in arc.sequences)
                    total_shots_planned = sum(len(sc.shots) for seq in arc.sequences for sc in seq.scenes)
                    emit("narrative_arc", 1.0, f"{len(arc.sequences)} sequenze — {total_scenes} scene",
                         event_type="llm_output",
                         extra={
                             "title": arc.title,
                             "logline": arc.logline or "",
                             "sequences": len(arc.sequences),
                             "total_scenes": total_scenes,
                             "planned_shots": total_shots_planned,
                             "visual_motifs": (arc.visual_motifs or [])[:5],
                             "color_palette": (arc.color_palette or [])[:6],
                         })
                    emit("narrative_arc", 1.0, "Stage completato: Arco narrativo", event_type="stage_complete")
                else:
                    arc = StoryArc(**state["data"]["story_arc"])

                await self._check_pause(pause_event, on_progress, "shot_list", 0.0)
                # LLM 3 — Shot List
                if "shot_list" not in done:
                    role_cfg = cfg.get_llm_for_role("cinematographer")
                    total_shots_planned = sum(len(sc.shots) for seq in arc.sequences for sc in seq.scenes)
                    emit("shot_list", 0.0, "LLM 3 — Direttore Fotografia: progettazione shot list...",
                         event_type="llm_prompt",
                         extra={
                             "role": "cinematographer",
                             "label": "Direttore della Fotografia",
                             "provider": role_cfg.provider,
                             "model": role_cfg.model,
                             "description": "Assegna camera, movimento, lente, illuminazione e transizioni a ogni shot",
                             "planned_shots": total_shots_planned,
                         })

                    shots = await _with_heartbeat(
                        generate_shot_list(
                            arc, inp, inp.audio_analysis,
                            vault_context=self._vault_memory("cinematographer"),
                        ),
                        "shot_list", 0.3, on_progress,
                    )
                    # Post-process: assign lyrics_segment based on computed lyric timing
                    if inp.audio_analysis and inp.audio_analysis.lyric_beats:
                        from src.core.utils.lyric_analyzer import assign_lyrics_to_shots
                        shots = assign_lyrics_to_shots(shots, inp.audio_analysis.lyric_beats)
                        log.info("lyrics_segments_assigned", shots=len(shots),
                                 with_lyrics=sum(1 for s in shots if s.lyrics_segment))
                    state["data"]["shot_list"] = [s.model_dump() for s in shots]
                    done.append("shot_list"); self._save_state(state)
                    shot_types = list({s.camera.shot_type for s in shots if s.camera})[:8]
                    lyrics_segments = sum(1 for s in shots if s.lyrics_segment)
                    emit("shot_list", 1.0, f"{len(shots)} inquadrature cinematografiche",
                         event_type="llm_output",
                         extra={
                             "shot_count": len(shots),
                             "shot_types": shot_types,
                             "transitions": list({s.transition_in for s in shots if s.transition_in})[:6],
                             "duration_total": round(sum(s.duration_sec or 0 for s in shots), 1),
                             "lyrics_segments": lyrics_segments,
                         })
                    emit("shot_list", 1.0, "Stage completato: Shot list cinematografica", event_type="stage_complete")
                else:
                    shots = [CinematicShot(**s) for s in state["data"]["shot_list"]]

                await self._check_pause(pause_event, on_progress, "prompt_generation", 0.0)
                # LLM 4 — Prompt Generation
                if "prompt_generation" not in done:
                    role_cfg = cfg.get_llm_for_role("prompt_engineer")
                    emit("prompt_generation", 0.0, "LLM 4 — Prompt Engineer: generazione prompt visivi...",
                         event_type="llm_prompt",
                         extra={
                             "role": "prompt_engineer",
                             "label": "Prompt Engineer",
                             "provider": role_cfg.provider,
                             "model": role_cfg.model,
                             "description": "Genera first_frame, last_frame e motion_prompt per ogni shot",
                             "shots_to_process": len(shots),
                         })

                    def on_prompt_progress(idx, total):
                        pct = idx / total if total else 0
                        on_progress(PipelineProgress("prompt_generation", pct,
                            f"Prompt shot {idx}/{total}...", event_type="progress"))

                    shots = await _with_heartbeat(
                        generate_frame_prompts(
                            shots, inp,
                            vault_context=self._vault_memory("prompt_engineer"),
                        ),
                        "prompt_generation", 0.3, on_progress,
                    )
                    state["data"]["shot_list"] = [s.model_dump() for s in shots]
                    done.append("prompt_generation"); self._save_state(state)
                    prompt_count = sum(1 for s in shots if s.first_frame and s.first_frame.prompt)
                    emit("prompt_generation", 1.0, f"Prompt generati per {prompt_count} shot",
                         event_type="llm_output",
                         extra={
                             "prompts_generated": prompt_count,
                             "shots_total": len(shots),
                             "sample_prompt": (shots[0].first_frame.prompt[:300] if shots and shots[0].first_frame else ""),
                         })
                    emit("prompt_generation", 1.0, "Stage completato: Prompt visivi generati", event_type="stage_complete")
                else:
                    shots = [CinematicShot(**s) for s in state["data"]["shot_list"]]

                await self._check_pause(pause_event, on_progress, "continuity_check", 0.0)
                # LLM 5 — Continuity Check
                if "continuity_check" not in done:
                    role_cfg = cfg.get_llm_for_role("continuity_checker")
                    emit("continuity_check", 0.0, "LLM 5 — Supervisore Continuità: analisi errori...",
                         event_type="llm_prompt",
                         extra={
                             "role": "continuity_checker",
                             "label": "Supervisore Continuità",
                             "provider": role_cfg.provider,
                             "model": role_cfg.model,
                             "description": "Verifica coerenza visiva, wardrobe, illuminazione e continuità narrativa",
                             "shots_to_check": len(shots),
                         })

                    report = await _with_heartbeat(
                        check_continuity(
                            shots,
                            vault_context=self._vault_memory("continuity_checker"),
                        ),
                        "continuity_check", 0.3, on_progress,
                    )
                    state["data"]["continuity_report"] = report.model_dump()
                    done.append("continuity_check"); self._save_state(state)
                    status = "approvata" if report.approved else f"{report.critical_count} errori critici"
                    emit("continuity_check", 1.0, f"Continuita': {status}",
                         event_type="llm_output",
                         extra={
                             "approved": report.approved,
                             "errors": len(report.errors or []),
                             "critical": report.critical_count,
                             "status": status,
                         })
                    emit("continuity_check", 1.0, "Stage completato: Controllo continuita'", event_type="stage_complete")

                # Copilot / storyboard-only mode: stop here
                if phase == "storyboard":
                    pipeline_registry.complete_run(self.project_id, status="storyboard_complete", stages_done=len(done))
                    return "storyboard_complete"

            else:
                # phase == "production": reload shots from checkpoint
                shots = [CinematicShot(**s) for s in state.get("data", {}).get("shot_list", [])]

            # ── ComfyUI stages ───────────────────────────────────────────────
            await self._check_pause(pause_event, on_progress, "frame_gen", 0.0)

            # Frame Gen
            if "frame_gen" not in done:
                await self._frame_gen(shots, state, on_progress)
                done.append("frame_gen"); self._save_state(state)

            # Video Gen
            if "video_gen" not in done:
                await self._video_gen(shots, state, on_progress, inp)
                done.append("video_gen"); self._save_state(state)

            # Assembly
            emit("assembly", 0.0, "Assemblaggio finale con FFmpeg...")
            final = await self._assembly(shots)
            done.append("assembly")
            state["final_deliverable"] = {
                "video_path": str(final),
                "pipeline": "cinematic",
            }
            self._save_state(state)
            emit("assembly", 1.0, "Video finale pronto!", artifact_path=str(final))

            _arc = state.get("data", {}).get("story_arc") or {}
            _assembly_prompt = prompt_for_assembly_final(
                self._project_title,
                project_input=state.get("project_input"),
                shots=shots,
                logline=_arc.get("logline"),
            )
            _fire_register(register_media(
                final, "video", self.project_id, self._project_title,
                frame_type="final",
                tags=["pipeline", "final", self._project_title],
                generation_prompt=_assembly_prompt,
            ))

            pipeline_registry.complete_run(self.project_id, status="completed", stages_done=len(done))
            return str(final)

        except asyncio.CancelledError:
            pipeline_registry.complete_run(self.project_id, status="stopped", stages_done=len(done))
            on_progress(PipelineProgress("assembly", 0.0, "Pipeline interrotta dall'utente", event_type="stopped"))
            raise
        except Exception as exc:
            pipeline_registry.complete_run(self.project_id, status="failed", error=str(exc), stages_done=len(done))
            raise

    async def _frame_gen(self, shots, state, on_progress):
        sem = asyncio.Semaphore(self._cfg.comfyui.max_parallel_frame_jobs)
        total = len(shots) * 2
        done_count = 0

        async def gen(shot, ftype):
            nonlocal done_count
            async with sem:
                ss = state["shot_states"].setdefault(shot.shot_id, {})
                key = f"frame_{ftype}"
                if ss.get(key) == "done":
                    done_count += 1; return

                # Handle from_prev_last: copy previous shot's last frame as this shot's first frame
                if ftype == "first" and shot.first_frame_source == "from_prev_last":
                    shot_idx = next((i for i, s in enumerate(shots) if s.shot_id == shot.shot_id), -1)
                    if shot_idx > 0:
                        prev_shot = shots[shot_idx - 1]
                        if prev_shot.last_frame and prev_shot.last_frame.image_path:
                            import shutil
                            src = Path(prev_shot.last_frame.image_path)
                            prefix = f"{shot.shot_id}_{ftype}"
                            dest = self._frames / f"{prefix}.png"
                            if src.exists():
                                shutil.copy2(src, dest)
                                if shot.first_frame is None:
                                    from src.core.models.cinematic import FramePrompt
                                    shot.first_frame = FramePrompt()
                                shot.first_frame.image_path = str(dest)
                                ss[key] = "done"
                                done_count += 1
                                state["data"]["shot_list"] = [s.model_dump() for s in shots]
                                self._save_state(state)
                                on_progress(PipelineProgress(
                                    "frame_gen", done_count / total,
                                    f"Frame first (from prev) {shot.shot_id}",
                                    shot_id=shot.shot_id, artifact_path=str(dest),
                                ))
                                return
                    # If no prev last frame available, fall through to normal generation

                frame = shot.first_frame if ftype == "first" else shot.last_frame
                if not frame or not frame.prompt:
                    log.warning("frame_gen_skip_no_prompt", shot=shot.shot_id, ftype=ftype)
                    done_count += 1; return
                prefix = f"{shot.shot_id}_{ftype}"
                wf = build_txt2img_workflow(frame, prefix)

                def _comfy_cb(value: int, max_val: int, node=None, _sid=shot.shot_id, _ft=ftype):
                    inner = value / max(max_val, 1) if max_val else 0
                    node_s = f" · {node}" if node else ""
                    on_progress(PipelineProgress(
                        "frame_gen", inner,
                        f"ComfyUI {value}/{max_val}{node_s} — {_sid} {_ft}",
                        shot_id=_sid,
                        extra={
                            "comfyui_value": value,
                            "comfyui_max": max_val,
                            "comfyui_pct": round(inner * 100, 1),
                        },
                    ))

                try:
                    run = await self._pool.run_with_fallback(
                        wf,
                        timeout=self._cfg.comfyui.execution_timeout_sec,
                        progress_cb=_comfy_cb,
                    )
                    files = extract_output_files(run.history)
                    dest = None
                    if files:
                        from src.core.utils.comfyui_outputs import download_comfyui_file, pick_best_image_output
                        best = pick_best_image_output(files)
                        dest = self._frames / f"{prefix}.png"
                        await download_comfyui_file(run.client, best, dest, expect="image")
                        (shot.first_frame if ftype=="first" else shot.last_frame).image_path = str(dest)
                        ss[key] = "done"
                        _fire_register(register_media(
                            dest, "image", self.project_id, self._project_title,
                            shot_id=shot.shot_id, frame_type=ftype,
                            tags=["pipeline", self._project_title],
                            generation_prompt=prompt_for_cinematic_shot(shot, "image", ftype),
                        ))
                    done_count += 1
                    on_progress(PipelineProgress("frame_gen", done_count/total, f"Frame {ftype} {shot.shot_id}", shot_id=shot.shot_id, artifact_path=str(dest) if dest else None))
                except Exception as e:
                    ss[key] = "failed"; shot.error = str(e); done_count += 1
                    log.error("frame_gen_failed", shot=shot.shot_id, error=str(e))
                state["data"]["shot_list"] = [s.model_dump() for s in shots]
                self._save_state(state)

        # Process shot-by-shot in order so from_prev_last can safely use the previous shot's last frame
        for shot in shots:
            await asyncio.gather(gen(shot, "first"), gen(shot, "last"))
            # When parallel_frame_jobs > 1, both frames of a shot run together;
            # the next shot only starts after this shot's pair is complete,
            # ensuring from_prev_last has the previous last_frame available.

    async def _video_gen(self, shots, state, on_progress,
                         inp: Optional[ProjectInput] = None):
        """
        Video generation stage.

        Dispatch is driven by self._workflows (set during run()):
          img_audio2video: "ltx_director_full_video"     → LTX Director full-timeline + audio
          img_audio2video: "ltx_director_per_shot_audio" → LTX Director per-shot + audio
          img2video:       "ltx_director_per_shot"       → LTX Director per-shot, no audio
          (default)                                       → standard WAN/CogVideoX per-shot

        Falls back to standard per-shot on any LTX Director error.
        """
        has_audio = bool(_resolve_audio_path(inp))
        wf = self._workflows

        # ── LTX Director full-video (audio-synced) ────────────────────────────
        if has_audio and wf.get("img_audio2video") == "ltx_director_full_video":
            all_frames_ready = all(
                s.first_frame and s.first_frame.image_path
                and s.last_frame and s.last_frame.image_path
                for s in shots
            )
            if not all_frames_ready:
                log.warning("ltx_full_video_skipped_missing_frames",
                            reason="Not all shots have both first/last frames — using per-shot fallback")
            else:
                on_progress(PipelineProgress(
                    "video_gen", 0.0,
                    f"LTX Director 2.3: generazione full-video ({len(shots)} shot, audio sincronizzato)...",
                    event_type="progress",
                ))
                try:
                    arc_data = state.get("data", {}).get("story_arc")
                    story_arc = StoryArc(**arc_data) if arc_data else None
                    final_clip = await self._ltx_director_full_video(
                        shots=shots,
                        story_arc=story_arc,
                        audio_analysis=inp.audio_analysis if inp else None,
                        audio_path=_resolve_audio_path(inp),
                        on_progress=on_progress,
                    )
                    for shot in shots:
                        shot.clip_path = str(final_clip)
                        state["shot_states"].setdefault(shot.shot_id, {})["video"] = "done"
                    state["data"]["shot_list"] = [s.model_dump() for s in shots]
                    self._save_state(state)
                    on_progress(PipelineProgress(
                        "video_gen", 1.0,
                        "LTX Director: video completo con audio generato",
                        artifact_path=str(final_clip), event_type="progress",
                    ))
                    return
                except Exception as exc:
                    log.error("ltx_director_full_video_failed", error=str(exc))
                    on_progress(PipelineProgress(
                        "video_gen", 0.0,
                        f"LTX Director fallito — fallback standard: {exc}",
                        event_type="progress", error=str(exc),
                    ))
                # Fall through to standard per-shot on error

        # ── LTX Director per-shot con audio ───────────────────────────────────
        elif has_audio and wf.get("img_audio2video") == "ltx_director_per_shot_audio":
            on_progress(PipelineProgress(
                "video_gen", 0.0,
                "LTX Director 2.3: generazione per-shot con audio...",
                event_type="progress",
            ))
            try:
                await self._video_gen_ltx_per_shot(shots, state, on_progress, inp)
                return
            except Exception as exc:
                log.error("ltx_per_shot_audio_failed", error=str(exc))
                on_progress(PipelineProgress(
                    "video_gen", 0.0,
                    f"LTX Director per-shot fallito — fallback standard: {exc}",
                    event_type="progress", error=str(exc),
                ))

        # ── LTX Director per-shot senza audio ────────────────────────────────
        elif wf.get("img2video") in ("ltx_director_per_shot", "ltx_director_img2video"):
            on_progress(PipelineProgress(
                "video_gen", 0.0,
                "LTX Director 2.3: generazione per-shot...",
                event_type="progress",
            ))
            try:
                await self._video_gen_ltx_per_shot(shots, state, on_progress, None)
                return
            except Exception as exc:
                log.error("ltx_per_shot_failed", error=str(exc))
                on_progress(PipelineProgress(
                    "video_gen", 0.0,
                    f"LTX Director per-shot fallito — fallback standard: {exc}",
                    event_type="progress", error=str(exc),
                ))

        # ── WAN 2.1 img2video ────────────────────────────────────────────────
        elif wf.get("img2video") == "wan21_img2video":
            await self._video_gen_per_shot(shots, state, on_progress,
                                           workflow_id="wan21_img2video", inp=inp)
            return

        # ── Default: LTX per-shot manifest (ltx_img_audio2video) ─────────────
        await self._video_gen_per_shot(shots, state, on_progress, inp=inp)

    async def _video_gen_per_shot(self, shots, state, on_progress,
                                   workflow_id: Optional[str] = None,
                                   inp: Optional[ProjectInput] = None):
        """Per-shot img2video via manifest workflow (WAN 2.1, LTX I2V, etc.)."""
        sem = asyncio.Semaphore(self._cfg.comfyui.max_parallel_video_jobs)
        total = len(shots); done_count = 0

        # Build per-shot audio start offsets: base_offset + sum of previous durations
        base_offset = getattr(inp, "audio_start_sec", 0.0) if inp else 0.0
        cumulative = 0.0
        audio_offsets: dict = {}
        for shot in shots:
            audio_offsets[shot.shot_id] = base_offset + cumulative
            cumulative += max(0.0, shot.duration_sec)

        async def gen(shot):
            nonlocal done_count
            async with sem:
                ss = state["shot_states"].setdefault(shot.shot_id, {})
                if ss.get("video") == "done":
                    done_count += 1; return
                if not (shot.first_frame and shot.first_frame.image_path and shot.last_frame and shot.last_frame.image_path):
                    done_count += 1; return
                try:
                    c = await self._pool.get_client()
                    fn = await c.upload_image(Path(shot.first_frame.image_path))
                    ln = await c.upload_image(Path(shot.last_frame.image_path))
                    wf = build_img2video_workflow(shot, fn, ln, shot.shot_id,
                                                  audio_start_sec=audio_offsets.get(shot.shot_id, 0.0),
                                                  workflow_id=workflow_id)

                    def _comfy_cb(value: int, max_val: int, node=None, _sid=shot.shot_id):
                        inner = value / max(max_val, 1) if max_val else 0
                        node_s = f" · {node}" if node else ""
                        on_progress(PipelineProgress(
                            "video_gen", inner,
                            f"ComfyUI {value}/{max_val}{node_s} — {_sid}",
                            shot_id=_sid,
                            extra={
                                "comfyui_value": value,
                                "comfyui_max": max_val,
                                "comfyui_pct": round(inner * 100, 1),
                            },
                        ))

                    hist, _pid = await self._pool.run_workflow_on(
                        c, wf,
                        timeout=self._cfg.comfyui.execution_timeout_sec,
                        progress_cb=_comfy_cb,
                    )
                    files = extract_output_files(hist)
                    if files:
                        from src.core.utils.comfyui_outputs import download_comfyui_file, pick_best_video_output
                        best_v = pick_best_video_output(files)
                        ext = Path(best_v["filename"]).suffix or ".mp4"
                        dest = self._clips / f"{shot.shot_id}{ext}"
                        await download_comfyui_file(c, best_v, dest, expect="video")
                        shot.clip_path = str(dest); ss["video"] = "done"
                        _fire_register(register_media(
                            dest, "video", self.project_id, self._project_title,
                            shot_id=shot.shot_id, frame_type=None,
                            tags=["pipeline", self._project_title],
                            generation_prompt=prompt_for_cinematic_shot(shot, "video"),
                        ))
                    done_count += 1
                    on_progress(PipelineProgress("video_gen", done_count/total, f"Clip {shot.shot_id}", shot_id=shot.shot_id, artifact_path=shot.clip_path))
                except Exception as e:
                    ss["video"] = "failed"; shot.error = str(e); done_count += 1
                    log.error("video_gen_failed", shot=shot.shot_id, error=str(e))
                self._save_state(state)

        await asyncio.gather(*[gen(s) for s in shots])

    async def _video_gen_ltx_per_shot(self, shots, state, on_progress,
                                       inp: Optional[ProjectInput] = None):
        """
        LTX Director per-shot mode: one LTXDirector workflow per CinematicShot.
        Each shot needs its first_frame and last_frame images uploaded.
        """
        from src.core.config import get_ltx_director_config

        ltx_cfg_obj = get_ltx_director_config()
        cfg         = get_config()
        sem         = asyncio.Semaphore(cfg.comfyui.max_parallel_video_jobs)
        total       = len(shots)
        done_count  = 0

        # Compute cumulative audio offsets (base + accumulated shot durations)
        base_offset = getattr(inp, "audio_start_sec", 0.0) if inp else 0.0
        cumulative_sec = 0.0
        audio_offsets: list[float] = []
        for shot in shots:
            audio_offsets.append(base_offset + cumulative_sec)
            cumulative_sec += max(0.0, shot.duration_sec)

        audio_path = _resolve_audio_path(inp)

        async def gen(shot: CinematicShot, audio_start_sec: float):
            nonlocal done_count
            async with sem:
                ss = state["shot_states"].setdefault(shot.shot_id, {})
                if ss.get("video") == "done":
                    done_count += 1
                    return
                if not (
                    shot.first_frame and shot.first_frame.image_path
                    and shot.last_frame and shot.last_frame.image_path
                ):
                    log.warning("ltx_per_shot_skip_no_frames", shot=shot.shot_id)
                    done_count += 1
                    return
                try:
                    c = await self._pool.get_client()
                    fn = await c.upload_image(Path(shot.first_frame.image_path))
                    ln = await c.upload_image(Path(shot.last_frame.image_path))

                    audio_name: Optional[str] = None
                    if audio_path and audio_path.exists():
                        audio_name = await c.upload_image(audio_path)

                    wf = build_ltx_director_shot_workflow(
                        shot                   = shot,
                        first_frame_comfyui_name = fn,
                        last_frame_comfyui_name  = ln,
                        output_prefix          = f"ltx_director/{shot.shot_id}",
                        audio_comfyui_name     = audio_name,
                        audio_start_sec        = audio_start_sec,
                        width                  = cfg.ltx_director.width,
                        height                 = cfg.ltx_director.height,
                        fps                    = cfg.ltx_director.frame_rate,
                        cfg                    = ltx_cfg_obj,
                    )
                    def _comfy_cb(value: int, max_val: int, node=None, _sid=shot.shot_id):
                        inner = value / max(max_val, 1) if max_val else 0
                        node_s = f" · {node}" if node else ""
                        on_progress(PipelineProgress(
                            "video_gen", inner,
                            f"LTX {value}/{max_val}{node_s} — {_sid}",
                            shot_id=_sid,
                            extra={
                                "comfyui_value": value,
                                "comfyui_max": max_val,
                                "comfyui_pct": round(inner * 100, 1),
                            },
                        ))

                    hist, _pid = await self._pool.run_workflow_on(
                        c, wf,
                        timeout=cfg.comfyui.execution_timeout_sec,
                        progress_cb=_comfy_cb,
                    )
                    files = extract_output_files(hist)
                    if files:
                        from src.core.utils.comfyui_outputs import download_comfyui_file, pick_best_video_output
                        best_v = pick_best_video_output(files)
                        ext  = Path(best_v["filename"]).suffix or ".mp4"
                        dest = self._clips / f"{shot.shot_id}{ext}"
                        await download_comfyui_file(c, best_v, dest, expect="video")
                        shot.clip_path = str(dest)
                        ss["video"]    = "done"
                        _fire_register(register_media(
                            dest, "video", self.project_id, self._project_title,
                            shot_id=shot.shot_id, frame_type=None,
                            tags=["ltx_director", self._project_title],
                            generation_prompt=prompt_for_cinematic_shot(shot, "video"),
                        ))
                    done_count += 1
                    on_progress(PipelineProgress(
                        "video_gen", done_count / total,
                        f"LTX Director clip {shot.shot_id}",
                        shot_id=shot.shot_id,
                        artifact_path=shot.clip_path,
                    ))
                except Exception as e:
                    ss["video"] = "failed"
                    shot.error  = str(e)
                    done_count += 1
                    log.error("ltx_per_shot_failed", shot=shot.shot_id, error=str(e))
                state["data"]["shot_list"] = [s.model_dump() for s in shots]
                self._save_state(state)

        await asyncio.gather(*[
            gen(shot, offset)
            for shot, offset in zip(shots, audio_offsets)
        ])

    async def _ltx_director_full_video(
        self,
        shots: list[CinematicShot],
        story_arc: Optional[StoryArc],
        audio_analysis: Optional,
        audio_path: Optional[Path],
        on_progress: Callable,
    ) -> Path:
        """
        Generate the entire video in a single LTX Director timeline pass.

        Steps:
        1. Verify all first_frame and last_frame image paths exist.
        2. Upload all guide images to ComfyUI.
        3. Upload audio (if available).
        4. Build the full-video workflow.
        5. Submit and wait for ComfyUI.
        6. Download the output video.
        7. Save to self._final / "ltx_director_full.mp4".
        8. Return the path.
        """
        from src.core.config import get_ltx_director_config

        cfg         = get_config()
        ltx_cfg_obj = get_ltx_director_config()

        # 1 — Verify frames
        missing: list[str] = []
        for shot in shots:
            for ftype, fp in (
                ("first_frame", shot.first_frame.image_path if shot.first_frame else None),
                ("last_frame",  shot.last_frame.image_path  if shot.last_frame  else None),
            ):
                if not fp or not Path(fp).exists():
                    missing.append(f"{shot.shot_id}.{ftype}")
        if missing:
            raise RuntimeError(
                f"LTX Director full-video: missing frame images for: {', '.join(missing[:10])}"
            )

        # 2 — Upload guide images
        c = await self._pool.get_client()
        on_progress(PipelineProgress(
            "video_gen", 0.05,
            f"Upload {len(shots) * 2} guide frames a ComfyUI...",
        ))

        # We need the ComfyUI-side filenames to inject into the workflow.
        # Upload them and record the mapping: local_path → comfyui_name
        uploaded_names: dict[str, str] = {}
        for shot in shots:
            for fp in (
                shot.first_frame.image_path if shot.first_frame else None,
                shot.last_frame.image_path  if shot.last_frame  else None,
            ):
                if fp and fp not in uploaded_names:
                    comfy_name = await c.upload_image(Path(fp))
                    uploaded_names[fp] = comfy_name

        # Patch shots with uploaded names so the builder can use them
        patched_shots = []
        for shot in shots:
            import copy as _copy
            ps = _copy.deepcopy(shot)
            if ps.first_frame and ps.first_frame.image_path:
                ps.first_frame.image_path = uploaded_names.get(
                    ps.first_frame.image_path, ps.first_frame.image_path
                )
            if ps.last_frame and ps.last_frame.image_path:
                ps.last_frame.image_path = uploaded_names.get(
                    ps.last_frame.image_path, ps.last_frame.image_path
                )
            patched_shots.append(ps)

        # 3 — Upload audio
        audio_comfyui_name: Optional[str] = None
        if audio_path and audio_path.exists():
            on_progress(PipelineProgress("video_gen", 0.10, "Upload audio a ComfyUI..."))
            audio_comfyui_name = await c.upload_image(audio_path)

        # 4 — Build workflow
        on_progress(PipelineProgress("video_gen", 0.12, "Costruzione workflow LTX Director..."))
        output_prefix = "ltx_director/full_video"
        wf = build_ltx_director_full_video_workflow(
            shots              = patched_shots,
            story_arc          = story_arc,
            audio_analysis     = audio_analysis,
            audio_comfyui_name = audio_comfyui_name,
            output_prefix      = output_prefix,
            width              = cfg.ltx_director.width,
            height             = cfg.ltx_director.height,
            fps                = cfg.ltx_director.frame_rate,
            cfg                = ltx_cfg_obj,
        )

        # 5 — Submit and wait
        on_progress(PipelineProgress(
            "video_gen", 0.15,
            f"LTX Director: invio workflow ({len(patched_shots)} shot, "
            f"{sum(max(1, round(s.duration_sec * cfg.ltx_director.frame_rate)) for s in shots)} frame totali)...",
        ))

        def _progress_cb(value: int, max_val: int, node=None):
            inner = value / max(max_val, 1) if max_val else 0
            pct = 0.15 + 0.75 * inner
            node_s = f" · {node}" if node else ""
            on_progress(PipelineProgress(
                "video_gen", pct,
                f"LTX Director: {value}/{max_val}{node_s}",
                extra={
                    "comfyui_value": value,
                    "comfyui_max": max_val,
                    "comfyui_pct": round(inner * 100, 1),
                },
            ))

        run  = await self._pool.run_with_fallback(
            wf,
            timeout     = cfg.comfyui.execution_timeout_sec,
            progress_cb = _progress_cb,
        )
        files = extract_output_files(run.history)
        if not files:
            raise RuntimeError("LTX Director full-video: ComfyUI non ha prodotto output files")

        # 6 — Download
        on_progress(PipelineProgress("video_gen", 0.92, "Download video LTX Director..."))
        ext  = Path(files[0]["filename"]).suffix or ".mp4"
        dest = self._final / f"ltx_director_full{ext}"
        await run.client.download_output(
            files[0]["filename"], dest,
            subfolder=files[0].get("subfolder", ""),
        )

        # 7 — Register in media library
        _ltx_prompt = prompt_for_shots_summary(patched_shots) or prompt_for_assembly_final(
            self._project_title,
            logline=getattr(story_arc, "logline", None) if story_arc else None,
            shots=patched_shots,
        )
        _fire_register(register_media(
            dest, "video", self.project_id, self._project_title,
            frame_type="final",
            tags=["ltx_director", "full_video", self._project_title],
            generation_prompt=_ltx_prompt,
        ))

        return dest

    async def _assembly(self, shots) -> Path:
        clips = [Path(s.clip_path) for s in shots if s.clip_path and Path(s.clip_path).exists()]
        if not clips:
            raise RuntimeError("Nessuna clip per assemblaggio")
        cfg = self._cfg.output
        ffmpeg = cfg.ffmpeg_path or "ffmpeg"
        out = self._final / f"final_{int(time.time())}.mp4"
        if len(clips) == 1:
            cmd = [ffmpeg,"-y","-i",str(clips[0]),"-c:v",cfg.video_codec,"-crf",str(cfg.video_crf),str(out)]
        else:
            inputs = [x for c in clips for x in ["-i", str(c)]]
            td = cfg.transition_duration_sec
            parts = [f"[{i}][{i+1}]xfade=transition={cfg.transition_type}:duration={td}:offset={round(i*4.0,2)}[v{i}]" for i in range(len(clips)-1)]
            cmd = [ffmpeg,"-y"]+inputs+["-filter_complex",";".join(parts),"-map",f"[v{len(clips)-2}]","-c:v",cfg.video_codec,"-crf",str(cfg.video_crf),"-preset",cfg.video_preset,"-pix_fmt","yuv420p",str(out)]
        import subprocess as _sp
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            lambda: _sp.run(cmd, stdout=_sp.PIPE, stderr=_sp.PIPE),
        )
        if result.returncode != 0:
            raise RuntimeError(f"FFmpeg: {result.stderr.decode(errors='replace')[-500:]}")
        return out

    # ── Media recovery (disco + history ComfyUI) ─────────────────────────────

    def _frame_path_ok(self, path: Optional[str]) -> bool:
        if not path:
            return False
        from src.core.utils.comfyui_outputs import is_real_comfy_image

        try:
            return is_real_comfy_image(Path(path))
        except OSError:
            return False

    def _clip_path_ok(self, path: Optional[str]) -> bool:
        if not path:
            return False
        from src.core.utils.comfyui_outputs import is_real_comfy_video

        try:
            return is_real_comfy_video(Path(path))
        except OSError:
            return False

    def all_shots_have_video(self) -> bool:
        state = self._load_state()
        shots = state.get("data", {}).get("shot_list", [])
        if not shots:
            return False
        for s in shots:
            sid = s.get("shot_id")
            dest = self._clips / f"{sid}.mp4"
            cp = s.get("clip_path")
            if self._clip_path_ok(cp):
                continue
            if dest.is_file() and self._clip_path_ok(str(dest)):
                continue
            return False
        return True

    async def reconcile_missing_shot_media(
        self,
        *,
        frames: bool = True,
        videos: bool = True,
    ) -> list[dict]:
        """Recupera frame e clip mancanti da disco o history ComfyUI della run."""
        state = self._load_state()
        shots_raw = state.get("data", {}).get("shot_list", [])
        if not shots_raw:
            return []

        shots = [CinematicShot(**s) for s in shots_raw]
        events: list[dict] = []
        client = await self._pool.get_client()

        from src.core.utils.comfyui_outputs import (
            COMFY_REAL_IMAGE_MIN_BYTES,
            COMFY_REAL_VIDEO_MIN_BYTES,
            download_image_by_prefix_probe,
            download_video_by_prefix_probe,
            is_real_comfy_image,
        )

        for shot in shots:
            ss = state["shot_states"].setdefault(shot.shot_id, {})

            if frames:
                for ftype in ("first", "last"):
                    key = f"frame_{ftype}"
                    if ss.get(key) == "done" and self._frame_path_ok(
                        (shot.first_frame.image_path if ftype == "first" and shot.first_frame else None)
                        or (shot.last_frame.image_path if ftype == "last" and shot.last_frame else None),
                    ):
                        continue

                    prefix = f"{shot.shot_id}_{ftype}"
                    dest = self._frames / f"{prefix}.png"
                    frame = shot.first_frame if ftype == "first" else shot.last_frame
                    if dest.is_file() and is_real_comfy_image(dest, min_bytes=COMFY_REAL_IMAGE_MIN_BYTES):
                        if frame is None:
                            from src.core.models.cinematic import FramePrompt
                            frame = FramePrompt()
                            if ftype == "first":
                                shot.first_frame = frame
                            else:
                                shot.last_frame = frame
                        frame.image_path = str(dest)
                        ss[key] = "done"
                        events.append({
                            "event": "frame_done",
                            "shot_id": shot.shot_id,
                            "frame": ftype,
                            "path": str(dest),
                            "artifact_path": str(dest),
                            "url": f"/api/pipeline/{self.project_id}/frames/{dest.name}",
                            "cached": True,
                        })
                        continue

                    try:
                        saved = await download_image_by_prefix_probe(
                            client,
                            prefix,
                            dest,
                            min_image_bytes=COMFY_REAL_IMAGE_MIN_BYTES,
                            local_folders=[self._frames],
                        )
                        if frame is None:
                            from src.core.models.cinematic import FramePrompt
                            frame = FramePrompt()
                            if ftype == "first":
                                shot.first_frame = frame
                            else:
                                shot.last_frame = frame
                        frame.image_path = str(saved if saved.exists() else dest)
                        ss[key] = "done"
                        events.append({
                            "event": "frame_done",
                            "shot_id": shot.shot_id,
                            "frame": ftype,
                            "path": str(dest),
                            "artifact_path": str(dest),
                            "url": f"/api/pipeline/{self.project_id}/frames/{dest.name}",
                        })
                        log.info("cinematic_frame_recovered", shot_id=shot.shot_id, ftype=ftype)
                    except Exception as exc:
                        log.warning(
                            "cinematic_frame_recover_failed",
                            shot_id=shot.shot_id,
                            ftype=ftype,
                            error=str(exc),
                        )

            if videos:
                if ss.get("video") == "done" and self._clip_path_ok(shot.clip_path):
                    continue

                dest = self._clips / f"{shot.shot_id}.mp4"
                if dest.is_file() and self._clip_path_ok(str(dest)):
                    shot.clip_path = str(dest)
                    ss["video"] = "done"
                    events.append({
                        "event": "clip_done",
                        "shot_id": shot.shot_id,
                        "path": str(dest),
                        "url": f"/api/pipeline/{self.project_id}/clips/{dest.name}",
                        "cached": True,
                    })
                    continue

                prefixes = [shot.shot_id, f"ltx_director/{shot.shot_id}"]
                recovered = False
                for prefix in prefixes:
                    try:
                        await download_video_by_prefix_probe(
                            client,
                            prefix,
                            dest,
                            min_video_bytes=COMFY_REAL_VIDEO_MIN_BYTES,
                            local_folders=[self._clips, self._final],
                        )
                        if self._clip_path_ok(str(dest)):
                            shot.clip_path = str(dest)
                            ss["video"] = "done"
                            events.append({
                                "event": "clip_done",
                                "shot_id": shot.shot_id,
                                "path": str(dest),
                                "url": f"/api/pipeline/{self.project_id}/clips/{dest.name}",
                            })
                            log.info("cinematic_video_recovered", shot_id=shot.shot_id, prefix=prefix)
                            recovered = True
                            break
                    except Exception as exc:
                        log.debug(
                            "cinematic_video_prefix_miss",
                            shot_id=shot.shot_id,
                            prefix=prefix,
                            error=str(exc),
                        )
                if not recovered:
                    log.warning("cinematic_video_recover_failed", shot_id=shot.shot_id)

        state["data"]["shot_list"] = [s.model_dump() for s in shots]
        self._save_state(state)
        return events

    # ── Copilot mode — per-shot helpers ─────────────────────────────────────

    async def copilot_gen_frame(self, shot_id: str, on_progress: Callable) -> Optional[str]:
        """Generate first_frame for a single shot. Returns file path or None."""
        if not self._project_title:
            self._project_title = await self._load_project_title()
        state = self._load_state()
        shots = [CinematicShot(**s) for s in state.get("data", {}).get("shot_list", [])]
        shot = next((s for s in shots if s.shot_id == shot_id), None)
        if not shot or not shot.first_frame:
            return None
        prefix = f"{shot_id}_first"
        wf = build_txt2img_workflow(shot.first_frame, prefix)
        def _comfy_cb(value: int, max_val: int, node=None):
            inner = value / max(max_val, 1) if max_val else 0
            node_s = f" · {node}" if node else ""
            on_progress(PipelineProgress(
                "frame_gen", inner,
                f"ComfyUI {value}/{max_val}{node_s} — {shot_id}",
                shot_id=shot_id,
                extra={
                    "comfyui_value": value,
                    "comfyui_max": max_val,
                    "comfyui_pct": round(inner * 100, 1),
                },
            ))

        try:
            run = await self._pool.run_with_fallback(
                wf,
                timeout=self._cfg.comfyui.execution_timeout_sec,
                progress_cb=_comfy_cb,
            )
            files = extract_output_files(run.history)
            if not files:
                return None
            dest = self._frames / f"{prefix}.png"
            await run.client.download_output(files[0]["filename"], dest, subfolder=files[0].get("subfolder", ""))
            shot.first_frame.image_path = str(dest)
            state["data"]["shot_list"] = [s.model_dump() for s in shots]
            state["shot_states"].setdefault(shot_id, {})["frame_first"] = "done"
            self._save_state(state)
            _fire_register(register_media(
                dest, "image", self.project_id, self._project_title,
                shot_id=shot_id, frame_type="first",
                tags=["copilot", self._project_title],
                generation_prompt=prompt_for_cinematic_shot(shot, "image", "first"),
            ))
            on_progress(PipelineProgress(
                "frame_gen", 1.0, f"Frame generato: {shot_id}",
                event_type="progress", artifact_path=str(dest), shot_id=shot_id,
            ))
            return str(dest)
        except Exception as e:
            on_progress(PipelineProgress(
                "frame_gen", 0.0, f"Errore: {e}",
                event_type="progress", error=str(e),
            ))
            return None

    async def copilot_gen_clip(self, shot_id: str, on_progress: Callable) -> Optional[str]:
        """Generate video clip for a single shot. Returns clip path or None."""
        if not self._project_title:
            self._project_title = await self._load_project_title()
        state = self._load_state()
        shots = [CinematicShot(**s) for s in state.get("data", {}).get("shot_list", [])]
        shot = next((s for s in shots if s.shot_id == shot_id), None)
        if not shot:
            return None
        if not (shot.first_frame and shot.first_frame.image_path and Path(shot.first_frame.image_path).exists()):
            return None
        try:
            c = await self._pool.get_client()
            fn = await c.upload_image(Path(shot.first_frame.image_path))
            if shot.last_frame and shot.last_frame.image_path and Path(shot.last_frame.image_path).exists():
                ln = await c.upload_image(Path(shot.last_frame.image_path))
            else:
                ln = fn
            wf = build_img2video_workflow(shot, fn, ln, shot.shot_id)
            def _comfy_cb(value: int, max_val: int, node=None):
                inner = value / max(max_val, 1) if max_val else 0
                node_s = f" · {node}" if node else ""
                on_progress(PipelineProgress(
                    "video_gen", inner,
                    f"ComfyUI {value}/{max_val}{node_s} — {shot_id}",
                    shot_id=shot_id,
                    extra={
                        "comfyui_value": value,
                        "comfyui_max": max_val,
                        "comfyui_pct": round(inner * 100, 1),
                    },
                ))

            hist, _pid = await self._pool.run_workflow_on(
                c, wf,
                timeout=self._cfg.comfyui.execution_timeout_sec,
                progress_cb=_comfy_cb,
            )
            files = extract_output_files(hist)
            if not files:
                return None
            ext = Path(files[0]["filename"]).suffix or ".mp4"
            dest = self._clips / f"{shot_id}{ext}"
            await c.download_output(files[0]["filename"], dest, subfolder=files[0].get("subfolder", ""))
            shot.clip_path = str(dest)
            state["data"]["shot_list"] = [s.model_dump() for s in shots]
            state["shot_states"].setdefault(shot_id, {})["video"] = "done"
            self._save_state(state)
            _fire_register(register_media(
                dest, "video", self.project_id, self._project_title,
                shot_id=shot_id, frame_type=None,
                tags=["copilot", self._project_title],
                generation_prompt=prompt_for_cinematic_shot(shot, "video"),
            ))
            on_progress(PipelineProgress(
                "video_gen", 1.0, f"Clip pronta: {shot_id}",
                event_type="progress", artifact_path=str(dest), shot_id=shot_id,
            ))
            return str(dest)
        except Exception as e:
            on_progress(PipelineProgress(
                "video_gen", 0.0, f"Errore clip: {e}",
                event_type="progress", error=str(e),
            ))
            return None

    async def copilot_assemble(self, on_progress: Callable) -> str:
        """Run FFmpeg assembly for copilot mode."""
        if not self._project_title:
            self._project_title = await self._load_project_title()
        state = self._load_state()
        shots = [CinematicShot(**s) for s in state.get("data", {}).get("shot_list", [])]
        on_progress(PipelineProgress("assembly", 0.0, "Assemblaggio finale..."))
        final = await self._assembly(shots)
        state["final_deliverable"] = {"video_path": str(final), "pipeline": "cinematic"}
        self._save_state(state)
        _assembly_prompt = prompt_for_assembly_final(
            self._project_title,
            project_input=state.get("project_input"),
            shots=shots,
            logline=(state.get("data", {}).get("story_arc") or {}).get("logline"),
        )
        _fire_register(register_media(
            final, "video", self.project_id, self._project_title,
            frame_type="final",
            tags=["copilot", "final", self._project_title],
            generation_prompt=_assembly_prompt,
        ))
        on_progress(PipelineProgress("assembly", 1.0, "Video finale pronto!", artifact_path=str(final)))
        return str(final)

    async def generate_thumbnails(
        self, width: int, height: int, on_progress: Callable
    ) -> list[dict]:
        """Generate low-res first-frame thumbnails for storyboard review."""
        state = self._load_state()
        shots = [CinematicShot(**s) for s in state.get("data", {}).get("shot_list", [])]
        if not shots:
            return []

        sem = asyncio.Semaphore(self._cfg.comfyui.max_parallel_frame_jobs)
        total = len(shots)
        done_count = 0
        results = []

        async def gen(shot):
            nonlocal done_count
            async with sem:
                if not shot.first_frame or not shot.first_frame.prompt:
                    done_count += 1
                    return
                prefix = f"thumb_{shot.shot_id}"
                wf = build_txt2img_workflow(shot.first_frame, prefix, width=width, height=height)
                try:
                    run = await self._pool.run_with_fallback(wf, timeout=self._cfg.comfyui.execution_timeout_sec)
                    files = extract_output_files(run.history)
                    dest = None
                    if files:
                        dest = self._frames / f"{prefix}.png"
                        await run.client.download_output(files[0]["filename"], dest, subfolder=files[0].get("subfolder", ""))
                    done_count += 1
                    on_progress(PipelineProgress(
                        "frame_gen", done_count / total,
                        f"Anteprima {shot.shot_id}",
                        event_type="progress",
                        shot_id=shot.shot_id,
                        artifact_path=str(dest) if dest else None,
                    ))
                    if dest and dest.exists():
                        results.append({
                            "shot_id": shot.shot_id,
                            "filename": f"{prefix}.png",
                            "path": str(dest),
                        })
                except Exception as e:
                    done_count += 1
                    log.error("thumbnail_gen_failed", shot=shot.shot_id, error=str(e))

        await asyncio.gather(*[gen(s) for s in shots])
        return results


# ── Module-level helper ────────────────────────────────────────────────────────

def _resolve_audio_path(inp: Optional[ProjectInput]) -> Optional[Path]:
    """
    Extract a local audio file path from ProjectInput.

    ProjectInput does not currently carry an audio_path field; this helper
    checks for common attribute names and returns None if nothing is found.
    The audio upload path can be extended here when ProjectInput gains an
    explicit audio_path field.
    """
    if inp is None:
        return None
    # Support future ProjectInput.audio_path attribute
    raw = getattr(inp, "audio_path", None)
    if raw:
        p = Path(raw)
        return p if p.exists() else None
    return None
