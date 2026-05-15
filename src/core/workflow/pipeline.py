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
)
from src.core import pipeline_registry

log = structlog.get_logger()

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
        base = cfg.app.data_path / "projects" / project_id
        self._frames = base / "frames"
        self._clips  = base / "clips"
        self._final  = base / "final"
        self._state_path = base / "pipeline_state.json"
        for d in (self._frames, self._clips, self._final):
            d.mkdir(parents=True, exist_ok=True)
        self._pool = ComfyUINodePool()

    def _load_state(self):
        return json.loads(self._state_path.read_text()) if self._state_path.exists() \
               else {"completed_stages": [], "shot_states": {}, "data": {}}

    def _save_state(self, s):
        self._state_path.write_text(json.dumps(s, indent=2, ensure_ascii=False))

    async def run(self, inp: ProjectInput, on_progress: Callable, phase: str = "all") -> str:
        """
        Execute the pipeline.

        phase="all"         — run every stage end-to-end (default / FullAuto mode)
        phase="storyboard"  — run only the five LLM stages; stop after continuity_check
                              and return "storyboard_complete"
        phase="production"  — skip LLM stages (already checkpointed); start at frame_gen
        """
        state = self._load_state()
        done = state["completed_stages"]
        cfg = get_config()

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
                             "description": "Analizza brief, liriche e audio → estrae temi, emozioni, metafore visive",
                         })

                    def on_event_sa(data):
                        emit("story_analysis", 0.5, data.get("msg", "LLM 1 in elaborazione"),
                             event_type=data.get("type", "progress"), extra=data)

                    sa = await _with_heartbeat(
                        analyze_story(inp, on_event=on_event_sa),
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
                        generate_narrative_arc(sa, inp),
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
                        generate_shot_list(arc, inp, inp.audio_analysis),
                        "shot_list", 0.3, on_progress,
                    )
                    state["data"]["shot_list"] = [s.model_dump() for s in shots]
                    done.append("shot_list"); self._save_state(state)
                    shot_types = list({s.camera.shot_type for s in shots if s.camera})[:8]
                    emit("shot_list", 1.0, f"{len(shots)} inquadrature cinematografiche",
                         event_type="llm_output",
                         extra={
                             "shot_count": len(shots),
                             "shot_types": shot_types,
                             "transitions": list({s.transition_in for s in shots if s.transition_in})[:6],
                             "duration_total": round(sum(s.duration_sec or 0 for s in shots), 1),
                         })
                    emit("shot_list", 1.0, "Stage completato: Shot list cinematografica", event_type="stage_complete")
                else:
                    shots = [CinematicShot(**s) for s in state["data"]["shot_list"]]

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
                        generate_frame_prompts(shots, inp),
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
                        check_continuity(shots),
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

            # Frame Gen
            if "frame_gen" not in done:
                await self._frame_gen(shots, state, on_progress)
                done.append("frame_gen"); self._save_state(state)

            # Video Gen
            if "video_gen" not in done:
                await self._video_gen(shots, state, on_progress)
                done.append("video_gen"); self._save_state(state)

            # Assembly
            emit("assembly", 0.0, "Assemblaggio finale con FFmpeg...")
            final = await self._assembly(shots)
            done.append("assembly"); self._save_state(state)
            emit("assembly", 1.0, "Video finale pronto!", artifact_path=str(final))

            pipeline_registry.complete_run(self.project_id, status="completed", stages_done=len(done))
            return str(final)

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
                frame = shot.first_frame if ftype == "first" else shot.last_frame
                if not frame:
                    done_count += 1; return
                prefix = f"{shot.shot_id}_{ftype}"
                wf = build_txt2img_workflow(frame, prefix)
                try:
                    hist = await self._pool.run_with_fallback(wf, timeout=self._cfg.comfyui.execution_timeout_sec)
                    files = extract_output_files(hist)
                    dest = None
                    if files:
                        dest = self._frames / f"{prefix}.png"
                        c = await self._pool.get_client()
                        await c.download_output(files[0]["filename"], dest, subfolder=files[0].get("subfolder",""))
                        (shot.first_frame if ftype=="first" else shot.last_frame).image_path = str(dest)
                        ss[key] = "done"
                    done_count += 1
                    on_progress(PipelineProgress("frame_gen", done_count/total, f"Frame {ftype} {shot.shot_id}", shot_id=shot.shot_id, artifact_path=str(dest) if dest else None))
                except Exception as e:
                    ss[key] = "failed"; shot.error = str(e); done_count += 1
                    log.error("frame_gen_failed", shot=shot.shot_id, error=str(e))
                self._save_state(state)

        await asyncio.gather(*[gen(s, ft) for s in shots for ft in ("first","last")])

    async def _video_gen(self, shots, state, on_progress):
        sem = asyncio.Semaphore(self._cfg.comfyui.max_parallel_video_jobs)
        total = len(shots); done_count = 0

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
                    wf = build_img2video_workflow(shot, fn, ln, shot.shot_id)
                    hist = await self._pool.run_with_fallback(wf, timeout=self._cfg.comfyui.execution_timeout_sec)
                    files = extract_output_files(hist)
                    if files:
                        ext = Path(files[0]["filename"]).suffix or ".mp4"
                        dest = self._clips / f"{shot.shot_id}{ext}"
                        await c.download_output(files[0]["filename"], dest, subfolder=files[0].get("subfolder",""))
                        shot.clip_path = str(dest); ss["video"] = "done"
                    done_count += 1
                    on_progress(PipelineProgress("video_gen", done_count/total, f"Clip {shot.shot_id}", shot_id=shot.shot_id, artifact_path=shot.clip_path))
                except Exception as e:
                    ss["video"] = "failed"; shot.error = str(e); done_count += 1
                    log.error("video_gen_failed", shot=shot.shot_id, error=str(e))
                self._save_state(state)

        await asyncio.gather(*[gen(s) for s in shots])

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
        proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        _, err = await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(f"FFmpeg: {err.decode()[-500:]}")
        return out

    # ── Copilot mode — per-shot helpers ─────────────────────────────────────

    async def copilot_gen_frame(self, shot_id: str, on_progress: Callable) -> Optional[str]:
        """Generate first_frame for a single shot. Returns file path or None."""
        state = self._load_state()
        shots = [CinematicShot(**s) for s in state.get("data", {}).get("shot_list", [])]
        shot = next((s for s in shots if s.shot_id == shot_id), None)
        if not shot or not shot.first_frame:
            return None
        prefix = f"{shot_id}_first"
        wf = build_txt2img_workflow(shot.first_frame, prefix)
        on_progress(PipelineProgress("frame_gen", 0.1, f"Invio a ComfyUI: {shot_id}", event_type="progress"))
        try:
            hist = await self._pool.run_with_fallback(wf, timeout=self._cfg.comfyui.execution_timeout_sec)
            files = extract_output_files(hist)
            if not files:
                return None
            dest = self._frames / f"{prefix}.png"
            c = await self._pool.get_client()
            await c.download_output(files[0]["filename"], dest, subfolder=files[0].get("subfolder", ""))
            shot.first_frame.image_path = str(dest)
            # Update state
            state["data"]["shot_list"] = [s.model_dump() for s in shots]
            state["shot_states"].setdefault(shot_id, {})["frame_first"] = "done"
            self._save_state(state)
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
            # Use last_frame if available, else fall back to first_frame upload
            if shot.last_frame and shot.last_frame.image_path and Path(shot.last_frame.image_path).exists():
                ln = await c.upload_image(Path(shot.last_frame.image_path))
            else:
                ln = fn
            wf = build_img2video_workflow(shot, fn, ln, shot.shot_id)
            on_progress(PipelineProgress("video_gen", 0.1, f"Generazione clip: {shot_id}", event_type="progress"))
            hist = await self._pool.run_with_fallback(wf, timeout=self._cfg.comfyui.execution_timeout_sec)
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
        state = self._load_state()
        shots = [CinematicShot(**s) for s in state.get("data", {}).get("shot_list", [])]
        on_progress(PipelineProgress("assembly", 0.0, "Assemblaggio finale..."))
        final = await self._assembly(shots)
        on_progress(PipelineProgress("assembly", 1.0, "Video finale pronto!", artifact_path=str(final)))
        return str(final)
