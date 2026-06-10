"""API Music Video — guided creation using LTX Music Video Creator workflow."""

from __future__ import annotations

import asyncio
import json
import re
import uuid
from pathlib import Path
from typing import Any, AsyncGenerator, List, Optional

import structlog
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from src.core.config import get_config
from src.core.utils.http_files import file_response

router = APIRouter()
log = structlog.get_logger("music_video")

_WORKFLOW_FILE = (
    Path(__file__).parents[3] / "base_workflow_comfyui" / "LTX2.3_Music_Video_Creator_I2V_V5_1.json"
)
_JOBS_DIR_NAME = "music_video_jobs"

# Task registry: job_id → asyncio.Task (for cancellation on delete)
_active_tasks: dict[str, "asyncio.Task"] = {}


# ── Models ─────────────────────────────────────────────────────────────────────

class MusicVideoRequest(BaseModel):
    project_id: str = "music_video"
    title: str = ""
    audio_path: str
    srt_content: str
    subjects_text: str = ""
    style_text: str = ""
    reference_prompt: str = ""
    negative_prompt: str = "bad hands, extra fingers, distorted face, blurry, watermark, low quality"
    width: int = Field(default=1920, ge=256, le=3840)
    height: int = Field(default=1080, ge=256, le=3840)
    fps: int = Field(default=24, ge=12, le=60)
    seed: int = Field(default=42, ge=0)
    scene_duration: int = Field(default=0, ge=0, le=60)
    crf: int = Field(default=19, ge=10, le=35)


class SrtGenerateRequest(BaseModel):
    audio_path: str
    description: str
    num_scenes: int = Field(default=8, ge=2, le=30)
    style_hint: str = ""
    duration_sec: float = 0.0


class AudioAnalyzeRequest(BaseModel):
    audio_path: str


class TranscribeAlignRequest(BaseModel):
    audio_path: str
    lyrics: str = ""
    model_size: str = "base"
    language: Optional[str] = None
    max_gap: float = 1.5
    max_words_per_segment: int = 8


class StoryFieldRequest(BaseModel):
    field: str  # "subjects" | "style"
    scenes: List[dict] = []
    lyrics: str = ""
    title: str = ""
    style_hint: str = ""
    audio_duration_sec: float = 0.0


class ReferencePromptRequest(BaseModel):
    scenes: List[dict] = []
    lyrics: str = ""
    subjects_text: str = ""
    style_text: str = ""
    title: str = ""
    resolution_w: int = 1920
    resolution_h: int = 1080


# ── Job persistence ────────────────────────────────────────────────────────────

def _jobs_dir() -> Path:
    d = get_config().app.data_path / _JOBS_DIR_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def _job_path(job_id: str) -> Path:
    return _jobs_dir() / f"{job_id}.json"


def _save_job(job: dict) -> None:
    _job_path(job["job_id"]).write_text(json.dumps(job, indent=2, ensure_ascii=False), encoding="utf-8")


def _load_job(job_id: str) -> Optional[dict]:
    p = _job_path(job_id)
    if not p.exists():
        return None
    return json.loads(p.read_text(encoding="utf-8"))


def _list_jobs(project_id: str) -> List[dict]:
    jobs = []
    for p in sorted(_jobs_dir().glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
        try:
            j = json.loads(p.read_text(encoding="utf-8"))
            if j.get("project_id", "music_video") == project_id or project_id == "music_video":
                jobs.append(j)
        except Exception:
            pass
    return jobs


# ── SRT parsing ────────────────────────────────────────────────────────────────

def _parse_srt(srt_content: str) -> List[dict]:
    """Parse SRT content → list of {index, start_sec, end_sec, prompt}."""
    scenes = []
    blocks = re.split(r"\n\s*\n", srt_content.strip())
    for block in blocks:
        lines = block.strip().splitlines()
        if len(lines) < 3:
            continue
        # Skip index line (lines[0])
        time_line = lines[1]
        m = re.match(
            r"(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})",
            time_line,
        )
        if not m:
            continue
        h1, m1, s1, ms1, h2, m2, s2, ms2 = (int(x) for x in m.groups())
        start = h1 * 3600 + m1 * 60 + s1 + ms1 / 1000
        end = h2 * 3600 + m2 * 60 + s2 + ms2 / 1000
        prompt = " ".join(lines[2:]).strip()
        if prompt:
            scenes.append({"start_sec": start, "end_sec": end, "prompt": prompt})
    return scenes


# ── Upload audio ───────────────────────────────────────────────────────────────

@router.post("/upload-audio")
async def upload_audio(file: UploadFile = File(...)):
    cfg = get_config()
    upload_dir = cfg.app.data_path / "uploads" / "music_video_audio"
    upload_dir.mkdir(parents=True, exist_ok=True)

    suffix = Path(file.filename or "audio.mp3").suffix.lower() or ".mp3"
    dest = upload_dir / f"{uuid.uuid4().hex[:8]}{suffix}"
    content = await file.read()
    dest.write_bytes(content)

    duration_sec = await _ffprobe_duration(dest)

    return {
        "ok": True,
        "audio_path": str(dest),
        "audio_name": file.filename or dest.name,
        "duration_sec": round(duration_sec, 2),
    }


# ── Analyze audio ──────────────────────────────────────────────────────────────

def _librosa_analyze_sync(audio_path: Path) -> dict:
    import librosa  # type: ignore
    import numpy as np  # type: ignore

    y, sr = librosa.load(str(audio_path), mono=True)
    duration = float(librosa.get_duration(y=y, sr=sr))

    tempo_result, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
    beat_times = librosa.frames_to_time(beat_frames, sr=sr)
    bpm = float(np.atleast_1d(tempo_result)[0])

    k = min(10, max(3, int(duration / 15)))
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
    try:
        boundary_frames = librosa.segment.agglomerative(mfcc, k=k)
        boundary_times = librosa.frames_to_time(boundary_frames, sr=sr)
        boundaries = sorted(set([0.0] + list(boundary_times) + [duration]))
    except Exception:
        step = 15.0
        raw = [i * step for i in range(int(duration / step) + 2)]
        boundaries = [b for b in raw if b < duration] + [duration]

    hop_length = 512
    rms = librosa.feature.rms(y=y, hop_length=hop_length)[0]
    rms_times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop_length)
    rms_max = float(rms.max()) if rms.max() > 0 else 1.0

    sections: list[dict] = []
    for i in range(len(boundaries) - 1):
        t_start, t_end = boundaries[i], boundaries[i + 1]
        seg_dur = t_end - t_start
        mask = (rms_times >= t_start) & (rms_times < t_end)
        seg_rms = float(rms[mask].mean()) if mask.any() else 0.0
        energy_norm = seg_rms / rms_max
        if energy_norm < 0.25:
            energy = "low"
        elif energy_norm < 0.50:
            energy = "medium"
        elif energy_norm < 0.75:
            energy = "high"
        else:
            energy = "peak"
        beat_mask = (beat_times >= t_start) & (beat_times < t_end)
        n_beats = int(beat_mask.sum())
        bpm_local = (n_beats / seg_dur * 60.0) if (seg_dur > 0 and n_beats > 1) else bpm
        sections.append({
            "start_sec": round(t_start, 3),
            "end_sec": round(t_end, 3),
            "energy": energy,
            "bpm_local": round(bpm_local, 2),
        })

    return {
        "ok": True,
        "duration_sec": round(duration, 2),
        "bpm": round(bpm, 1),
        "sections": sections,
    }


@router.post("/analyze-audio")
async def analyze_audio(req: AudioAnalyzeRequest):
    audio_path = Path(req.audio_path)
    if not audio_path.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")

    duration = await _ffprobe_duration(audio_path) or 0.0

    try:
        loop = asyncio.get_running_loop()
        result = await asyncio.wait_for(
            loop.run_in_executor(None, _librosa_analyze_sync, audio_path),
            timeout=120.0,
        )
        return result
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Audio analysis timed out")
    except ImportError:
        log.warning("librosa_not_installed")
        return {
            "ok": True,
            "duration_sec": round(duration, 2),
            "bpm": 0.0,
            "sections": [],
        }
    except Exception as exc:
        log.error("audio_analysis_failed", error=str(exc))
        raise HTTPException(status_code=500, detail=f"Audio analysis failed: {exc}")


# ── Generate SRT via LLM ───────────────────────────────────────────────────────

@router.post("/generate-srt")
async def generate_srt(req: SrtGenerateRequest):
    from src.core.llm.factory import get_llm_adapter

    audio_path = Path(req.audio_path) if req.audio_path else None

    duration_sec = req.duration_sec
    if not duration_sec and audio_path and audio_path.exists():
        duration_sec = await _ffprobe_duration(audio_path) or 60.0
    if not duration_sec:
        duration_sec = 60.0

    scene_duration = duration_sec / max(1, req.num_scenes)

    # Pre-compute timings so we can rebuild SRT from any response format
    scene_timings = [
        {"start": i * scene_duration, "end": (i + 1) * scene_duration}
        for i in range(req.num_scenes)
    ]

    def _build_srt_from_descriptions(descriptions: list[str]) -> str:
        lines = []
        for i, (desc, t) in enumerate(zip(descriptions, scene_timings)):
            def fmt(ms: int) -> str:
                h, rem = divmod(ms, 3600000)
                m, rem = divmod(rem, 60000)
                s, cs = divmod(rem, 1000)
                return f"{h:02d}:{m:02d}:{s:02d},{cs:03d}"
            s_ms, e_ms = int(t["start"] * 1000), int(t["end"] * 1000)
            lines.append(f"{i + 1}\n{fmt(s_ms)} --> {fmt(e_ms)}\n{desc.strip()}")
        return "\n\n".join(lines)

    # Ask for a JSON array of scene descriptions — avoids embedding multi-line SRT in JSON
    system_prompt = (
        "You are a professional music video director and cinematographer. "
        "Generate a visual scene list for a music video. "
        "Each scene description should be cinematic and detailed: include shot type, "
        "character action, camera movement, and lighting. "
        'Output ONLY valid JSON: {"scenes": [{"description": "..."}, ...]}'
    )
    user_msg = (
        f"Create exactly {req.num_scenes} scene descriptions for a music video.\n"
        f"Total duration: {duration_sec:.1f} seconds — each scene ~{scene_duration:.1f}s.\n"
        f"Video concept: {req.description}\n"
        f"Visual style: {req.style_hint or 'cinematic, photorealistic'}\n\n"
        f'Output exactly {req.num_scenes} items. JSON: {{"scenes": [{{"description": "scene 1..."}}, ...]}}'
    )

    def _extract_raw(exc: Exception) -> str:
        """Get LLM raw text from a parse-failure exception (direct or wrapped in RetryError)."""
        raw = getattr(exc, "raw_response", None)
        if raw:
            return str(raw).strip()
        try:
            from tenacity import RetryError
            if isinstance(exc, RetryError):
                orig = exc.last_attempt.exception()
                raw = getattr(orig, "raw_response", None)
                if raw:
                    return str(raw).strip()
        except Exception:
            pass
        return ""

    try:
        adapter = get_llm_adapter()
        srt_content = ""

        try:
            result = await adapter.generate_json(
                system=system_prompt,
                user=user_msg,
                temperature=0.75,
                max_tokens=2500,
            )
            scenes_list = result.get("scenes", [])
            if scenes_list:
                descs = [s.get("description") or s.get("desc") or str(s) for s in scenes_list]
                srt_content = _build_srt_from_descriptions(descs[:req.num_scenes])
        except Exception as inner_exc:
            raw = _extract_raw(inner_exc)
            if raw:
                # Try to use raw as SRT directly
                parsed = _parse_srt(raw)
                if parsed:
                    srt_content = raw
                else:
                    # Treat each non-empty, non-SRT line as a scene description
                    desc_lines = [
                        l.strip() for l in raw.splitlines()
                        if l.strip() and not l.strip().isdigit() and "-->" not in l
                    ]
                    if desc_lines:
                        srt_content = _build_srt_from_descriptions(desc_lines[:req.num_scenes])
            if not srt_content:
                raise

        if not srt_content:
            raise ValueError("LLM ha restituito risposta vuota")

        scenes = _parse_srt(srt_content)
        return {"ok": True, "srt_content": srt_content, "scene_count": len(scenes)}

    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"LLM error: {exc}")


# ── Transcribe + align lyrics ──────────────────────────────────────────────────

@router.post("/transcribe-align")
async def transcribe_align(req: TranscribeAlignRequest):
    """Local Whisper transcription + optional wav2vec2 forced alignment."""
    from src.core.utils.lyrics_align import (
        transcribe_whisper, forced_align_wav2vec2, words_to_srt,
    )

    audio_path = Path(req.audio_path)
    if not audio_path.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")

    try:
        if req.lyrics.strip():
            words = await asyncio.to_thread(
                forced_align_wav2vec2, str(audio_path), req.lyrics
            )
            language = "en"
        else:
            result = await asyncio.to_thread(
                transcribe_whisper, str(audio_path), req.model_size, req.language
            )
            words = result["words"]
            language = result["language"]

        srt_content = words_to_srt(words, req.max_gap, req.max_words_per_segment)
        return {
            "ok": True,
            "language": language,
            "words": words,
            "srt_content": srt_content,
            "segment_count": srt_content.count("\n\n") + 1 if srt_content else 0,
        }
    except RuntimeError as e:
        raise HTTPException(status_code=501, detail=str(e))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ── Generate story fields via LLM ──────────────────────────────────────────────

def _extract_sentences_text(raw: str) -> str:
    """Extract the 'sentences' list from LLM JSON and join into a paragraph.
    Falls back to plain-text extraction if JSON is malformed."""
    import json, re
    raw = re.sub(r"```json?\s*", "", raw).replace("```", "").strip()
    # Try normal JSON parse first
    try:
        parsed = json.loads(raw)
        sentences = parsed.get("sentences", [])
        if sentences:
            return " ".join(str(s) for s in sentences)
        text = parsed.get("text", "")
        if text:
            return text
    except Exception:
        pass
    # Fallback: extract array items
    arr_match = re.search(r'"sentences"\s*:\s*\[(.*?)\]', raw, re.DOTALL)
    if arr_match:
        items = re.findall(r'"((?:[^"\\]|\\.)*)"', arr_match.group(1))
        if items:
            return " ".join(items)
    # Last resort: strip JSON punctuation and return bare text
    text_match = re.search(r'"text"\s*:\s*"((?:[^"\\]|\\.|\n)*?)"', raw, re.DOTALL)
    if text_match:
        return text_match.group(1).replace("\\n", "\n").replace('\\"', '"')
    # Give up: return raw stripped of JSON artifacts
    clean = re.sub(r'[{}\[\]"]', " ", raw)
    clean = re.sub(r'"(sentences|text)"\s*:', "", clean)
    return " ".join(clean.split())


@router.post("/generate-story-field")
async def generate_story_field(req: StoryFieldRequest):
    """Generate 'subjects' or 'style' text via LLM based on scenes and lyrics."""
    from src.core.llm.factory import get_llm_adapter
    import traceback

    if req.field not in ("subjects", "style"):
        raise HTTPException(status_code=400, detail="field must be 'subjects' or 'style'")

    scenes_summary = "\n".join(
        f"- {s.get('start','?')} → {s.get('end','?')}: {s.get('desc','')}"
        for s in req.scenes[:20]
    ) or "(nessuna scena definita)"

    if req.field == "subjects":
        system = (
            "You are a professional music video director. "
            "Describe the subjects, characters, and visual story of the music video. "
            "Be specific: appearance, setting, actions, emotional arc. Write in Italian. "
            "Output ONLY valid JSON: {\"text\": \"your description here\"}. "
            "Do NOT use newline characters inside the string value."
        )
        user = (
            f"Title: {req.title or 'Music Video'}\n"
            f"Duration: {req.audio_duration_sec:.0f}s\n"
            f"Scene list:\n{scenes_summary}\n"
            f"Lyrics:\n{req.lyrics or '(none)'}\n\n"
            'Write a 3-4 sentence description. Output JSON: {"text": "..."}'
        )
    else:
        system = (
            "You are a professional cinematographer. "
            "Define the visual style, color palette, mood and aesthetic of the music video. "
            "Mention lighting, color grading, film grain, lens style. Write in Italian. "
            "Output ONLY valid JSON: {\"text\": \"your style description\"}. "
            "Do NOT use newline characters inside the string value."
        )
        user = (
            f"Title: {req.title or 'Music Video'}\n"
            f"Style hint: {req.style_hint or 'cinematic'}\n"
            f"Scene list:\n{scenes_summary}\n"
            f"Lyrics:\n{req.lyrics or '(none)'}\n\n"
            'Write a 2-3 sentence style description. Output JSON: {"text": "..."}'
        )

    def _pick_text(d: dict) -> str:
        if not isinstance(d, dict):
            return ""
        text = (
            d.get("text") or d.get("description") or d.get("style")
            or d.get("subjects") or d.get("content")
            or next((v for v in d.values() if isinstance(v, str) and len(v) > 10), "")
        )
        if not text:
            for v in d.values():
                if isinstance(v, list) and v:
                    text = " ".join(str(s) for s in v)
                    break
        return text or ""

    def _raw_from_retry(exc: Exception) -> str:
        """Extract raw LLM text from parse-failure exceptions (direct ValueError or RetryError)."""
        # Direct raw_response attribute (set by _parse_json on ValueError)
        raw = getattr(exc, "raw_response", None)
        if raw:
            return str(raw).strip()
        try:
            from tenacity import RetryError
            if isinstance(exc, RetryError):
                original = exc.last_attempt.exception()
                raw = getattr(original, "raw_response", None)
                if raw:
                    return str(raw).strip()
        except Exception:
            pass
        return ""

    try:
        adapter = get_llm_adapter()
        try:
            raw_result = await adapter.generate_json(
                system=system, user=user, temperature=0.7, max_tokens=500,
            )
            log.info("story_field_llm_raw", field=req.field, keys=list(raw_result.keys()))
            text = _pick_text(raw_result)
        except Exception as inner_exc:
            # LLM returned plain prose instead of JSON — use it directly
            text = _raw_from_retry(inner_exc)
            if text:
                log.info("story_field_plain_text_fallback", field=req.field, chars=len(text))
            else:
                log.error("story_field_error", field=req.field, exc=str(inner_exc))
                raise

        if not text.strip():
            raise HTTPException(status_code=500, detail="LLM returned empty text")

        return {"ok": True, "text": text.strip()}

    except HTTPException:
        raise
    except Exception as exc:
        tb = traceback.format_exc()
        log.error("story_field_fatal", field=req.field, exc=str(exc), tb=tb[:500])
        raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}")


# ── Generate reference prompt via LLM ─────────────────────────────────────────

@router.post("/generate-reference-prompt")
async def generate_reference_prompt(req: ReferencePromptRequest):
    """Generate a txt2img reference prompt from all project data."""
    from src.core.llm.factory import get_llm_adapter
    import traceback

    aspect = f"{req.resolution_w}×{req.resolution_h}"
    ratio = "portrait" if req.resolution_h > req.resolution_w else "landscape" if req.resolution_w > req.resolution_h else "square"

    first_scene_desc = req.scenes[0].get("desc", "") if req.scenes else ""
    scenes_summary = "\n".join(
        f"- {s.get('start','?')}→{s.get('end','?')}: {s.get('desc','')}"
        for s in req.scenes[:8]
    ) or "(no scenes)"

    system = (
        "You are an expert AI image generation prompt engineer specializing in cinematic music videos. "
        "Generate a single txt2img prompt for the reference frame (first frame / establishing shot) of a music video. "
        "The prompt must be in English, highly detailed, and follow this structure: "
        "[STYLE], [SHOT TYPE], [SUBJECT + ACTION], [ENVIRONMENT], [LIGHTING], [MOOD], [TECHNICAL DETAILS]. "
        "Make it specific to the characters, scene and aesthetic described. "
        "Output ONLY valid JSON: {\"prompt\": \"...\"}. No newlines inside the string."
    )
    user = (
        f"Title: {req.title or 'Music Video'}\n"
        f"Resolution: {aspect} ({ratio})\n\n"
        f"Subjects & scene narrative:\n{req.subjects_text or '(not specified)'}\n\n"
        f"Visual style:\n{req.style_text or '(not specified)'}\n\n"
        f"First scene: {first_scene_desc or '(not specified)'}\n\n"
        f"All scenes:\n{scenes_summary}\n\n"
        f"Lyrics excerpt:\n{req.lyrics[:400] or '(none)'}\n\n"
        "Generate the reference frame prompt. Output JSON: {\"prompt\": \"...\"}"
    )

    def _raw_from_retry(exc: Exception) -> str:
        raw = getattr(exc, "raw_response", None)
        if raw:
            return str(raw).strip()
        try:
            from tenacity import RetryError
            if isinstance(exc, RetryError):
                original = exc.last_attempt.exception()
                raw = getattr(original, "raw_response", None)
                if raw:
                    return str(raw).strip()
        except Exception:
            pass
        return ""

    try:
        adapter = get_llm_adapter()
        try:
            result = await adapter.generate_json(system=system, user=user, temperature=0.65, max_tokens=400)
            prompt = result.get("prompt") or next(
                (v for v in result.values() if isinstance(v, str) and len(v) > 20), ""
            )
        except Exception as inner_exc:
            prompt = _raw_from_retry(inner_exc)
            if not prompt:
                raise

        if not prompt.strip():
            raise HTTPException(status_code=500, detail="LLM returned empty prompt")

        return {"ok": True, "prompt": prompt.strip()}

    except HTTPException:
        raise
    except Exception as exc:
        tb = traceback.format_exc()
        log.error("reference_prompt_error", exc=str(exc), tb=tb[:400])
        raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}")


# ── Jobs list ──────────────────────────────────────────────────────────────────

@router.get("/jobs")
async def list_jobs(project_id: str = "music_video"):
    return {"jobs": _list_jobs(project_id)}


@router.get("/jobs/{project_id}/{job_id}")
async def get_job(project_id: str, job_id: str):
    job = _load_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.delete("/jobs/{project_id}/{job_id}")
async def delete_job(project_id: str, job_id: str):
    p = _job_path(job_id)
    if not p.exists():
        raise HTTPException(status_code=404, detail="Job not found")
    # Force-cancel any running task before removing the file
    task = _active_tasks.pop(job_id, None)
    if task and not task.done():
        task.cancel()
    p.unlink()
    return {"ok": True}


# ── Output serving ─────────────────────────────────────────────────────────────

@router.get("/output/{job_id}/{filename:path}")
async def serve_output(job_id: str, filename: str):
    cfg = get_config()
    p = cfg.app.data_path / "music_video" / job_id / filename
    if not p.is_file():
        raise HTTPException(status_code=404, detail="Output not found")
    return file_response(p, inline=True)


# ── Main generation ────────────────────────────────────────────────────────────

@router.post("/generate")
async def generate(req: MusicVideoRequest):
    job_id = uuid.uuid4().hex[:10]

    job = {
        "job_id": job_id,
        "project_id": req.project_id,
        "title": req.title or f"Music Video {job_id}",
        "status": "running",
        "created_at": _now_iso(),
        "config": req.model_dump(),
        "result": {},
        "error": None,
    }
    _save_job(job)

    q: asyncio.Queue = asyncio.Queue()

    async def _run():
        try:
            async for ev in _run_pipeline(req, job_id):
                await q.put(ev)
                if ev.get("done") or ev.get("error"):
                    status = "done" if ev.get("done") else "failed"
                    job["status"] = status
                    if ev.get("error"):
                        job["error"] = ev["error"]
                    if ev.get("video_url"):
                        job["result"]["video_url"] = ev["video_url"]
                    _save_job(job)
        except asyncio.CancelledError:
            job["status"] = "interrupted"
            _save_job(job)
            await q.put({"cancelled": True, "job_id": job_id})
        except Exception as exc:
            await q.put({"error": str(exc), "job_id": job_id})
            job["status"] = "failed"
            job["error"] = str(exc)
            _save_job(job)
        finally:
            _active_tasks.pop(job_id, None)
            await q.put(None)

    task = asyncio.create_task(_run())
    _active_tasks[job_id] = task

    async def stream() -> AsyncGenerator[str, None]:
        while True:
            try:
                ev = await asyncio.wait_for(q.get(), timeout=30)
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
                continue
            if ev is None:
                break
            yield "data: " + json.dumps(ev) + "\n\n"
            if ev.get("done") or ev.get("error"):
                break

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Pipeline implementation ────────────────────────────────────────────────────

async def _run_pipeline(req: MusicVideoRequest, job_id: str):
    """
    SRT-driven music video pipeline:
    1. Validate & parse SRT → scenes
    2. Upload files to ComfyUI
    3. For each scene: generate reference frame + video clip with audio
    4. Assemble all clips with FFmpeg
    """
    from src.core.comfyui.pool import ComfyUINodePool
    from src.core.config import get_config

    cfg = get_config()
    out_dir = cfg.app.data_path / "music_video" / job_id
    frames_dir = out_dir / "frames"
    clips_dir = out_dir / "clips"
    for d in (out_dir, frames_dir, clips_dir):
        d.mkdir(parents=True, exist_ok=True)

    # ── 1. Parse SRT ──────────────────────────────────────────────────────────
    scenes = _parse_srt(req.srt_content)
    if not scenes:
        yield {"error": "SRT non valido o vuoto — impossibile generare scene"}
        return

    total_scenes = len(scenes)
    log.info("music_video_pipeline_start", job_id=job_id, scenes=total_scenes)

    yield {
        "event": "start",
        "job_id": job_id,
        "msg": f"Avvio pipeline: {total_scenes} scene",
        "progress_pct": 0,
        "total_scenes": total_scenes,
    }

    # ── 2. Get ComfyUI client ─────────────────────────────────────────────────
    try:
        pool = ComfyUINodePool()
        client = await pool.get_client()
    except Exception as exc:
        yield {"error": f"Nessun nodo ComfyUI disponibile: {exc}"}
        return

    # ── 3. Upload audio to ComfyUI ────────────────────────────────────────────
    audio_path = Path(req.audio_path)
    if not audio_path.exists():
        yield {"error": f"File audio non trovato: {req.audio_path}"}
        return

    yield {"event": "upload", "msg": "Upload audio → ComfyUI", "progress_pct": 2}

    try:
        audio_filename = await client.upload_input_file(
            audio_path,
            mime=_audio_mime(audio_path),
            field_name="image",
        )
        log.info("music_video_audio_uploaded", filename=audio_filename)
    except Exception as exc:
        yield {"error": f"Upload audio fallito: {exc}"}
        return

    # ── 4. Upload support files ───────────────────────────────────────────────
    yield {"event": "upload", "msg": "Caricamento file di testo", "progress_pct": 4}

    try:
        subjects_file = out_dir / "subjectsandscenes.txt"
        subjects_file.write_text(req.subjects_text or "Main subject: a person", encoding="utf-8")
        await client.upload_input_file(subjects_file, mime="text/plain", field_name="image")

        style_file = out_dir / "themestyle.txt"
        style_file.write_text(req.style_text or "cinematic, photorealistic", encoding="utf-8")
        await client.upload_input_file(style_file, mime="text/plain", field_name="image")

        srt_file = out_dir / f"music_video_{job_id}.srt"
        srt_file.write_text(req.srt_content, encoding="utf-8")
        await client.upload_input_file(srt_file, mime="text/plain", field_name="image")
    except Exception as exc:
        log.warning("music_video_text_upload_failed", error=str(exc))

    # ── 5. Generate reference frame (shared across scenes) ────────────────────
    yield {"event": "reference_frame", "msg": "Generazione frame di riferimento", "progress_pct": 6}

    ref_frame_path: Optional[Path] = None
    if req.reference_prompt:
        try:
            ref_frame_path = await _generate_reference_frame(
                client=client,
                prompt=req.reference_prompt,
                negative_prompt=req.negative_prompt,
                width=req.width,
                height=req.height,
                seed=req.seed,
                dest=frames_dir / "reference.png",
            )
            log.info("music_video_reference_frame_done", path=str(ref_frame_path))
        except Exception as exc:
            log.warning("music_video_reference_frame_failed", error=str(exc))

    # ── 6. Per-scene video generation ─────────────────────────────────────────
    clip_paths: List[Path] = []
    scene_weight = 88.0 / total_scenes  # 6%→94% distributed across scenes

    for i, scene in enumerate(scenes):
        scene_progress_start = 6 + int(i * scene_weight)
        scene_progress_end = 6 + int((i + 1) * scene_weight)

        yield {
            "event": "scene",
            "scene_index": i + 1,
            "total": total_scenes,
            "msg": f"Scena {i + 1}/{total_scenes} — generazione video",
            "progress_pct": scene_progress_start,
        }

        clip_dest = clips_dir / f"clip_{i:04d}.mp4"

        try:
            duration = req.scene_duration or (scene["end_sec"] - scene["start_sec"])
            duration = max(1.0, min(duration, 30.0))

            await _generate_scene_clip(
                client=client,
                scene_prompt=scene["prompt"],
                style_text=req.style_text,
                negative_prompt=req.negative_prompt,
                reference_image=ref_frame_path,
                audio_path=audio_path,
                audio_start=scene["start_sec"],
                audio_duration=duration,
                width=req.width,
                height=req.height,
                fps=req.fps,
                seed=req.seed + i,
                dest=clip_dest,
                crf=req.crf,
            )
            if clip_dest.is_file() and clip_dest.stat().st_size > 1000:
                clip_paths.append(clip_dest)
            log.info("music_video_scene_done", scene=i + 1, path=str(clip_dest))

            yield {
                "event": "scene_done",
                "scene_index": i + 1,
                "total": total_scenes,
                "msg": f"Scena {i + 1}/{total_scenes} completata",
                "progress_pct": scene_progress_end,
                "clip_path": str(clip_dest),
            }

        except Exception as exc:
            log.error("music_video_scene_failed", scene=i + 1, error=str(exc))
            yield {
                "event": "scene_error",
                "scene_index": i + 1,
                "msg": f"Scena {i + 1} fallita: {exc}",
                "progress_pct": scene_progress_start,
            }

    # ── 7. FFmpeg assembly ────────────────────────────────────────────────────
    if not clip_paths:
        yield {"error": "Nessuna clip generata — impossibile assemblare il video"}
        return

    yield {"event": "assembly", "msg": "Assemblaggio video finale…", "progress_pct": 94}

    final_output = out_dir / "music_video_final.mp4"
    try:
        await _ffmpeg_concat(clip_paths, final_output)
        video_url = f"/api/music-video/output/{job_id}/music_video_final.mp4"
        log.info("music_video_done", job_id=job_id, path=str(final_output))
        yield {
            "event": "done",
            "done": True,
            "job_id": job_id,
            "msg": "Music video completato!",
            "progress_pct": 100,
            "video_url": video_url,
            "video_path": str(final_output),
            "scene_count": len(clip_paths),
        }
    except Exception as exc:
        log.error("music_video_assembly_failed", error=str(exc))
        yield {"error": f"Assemblaggio fallito: {exc}"}


# ── Helpers ────────────────────────────────────────────────────────────────────

async def _ffprobe_duration(path: Path) -> float:
    """Return audio/video duration in seconds via ffprobe."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", str(path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
        return float(stdout.decode().strip())
    except Exception:
        return 0.0


def _audio_mime(path: Path) -> str:
    return {
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".ogg": "audio/ogg",
        ".flac": "audio/flac",
        ".m4a": "audio/mp4",
    }.get(path.suffix.lower(), "audio/mpeg")


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


async def _generate_reference_frame(
    client,
    prompt: str,
    negative_prompt: str,
    width: int,
    height: int,
    seed: int,
    dest: Path,
) -> Optional[Path]:
    """Generate a reference frame via txt2img workflow."""
    from src.core.comfyui.workflow_builder import _get_wf_meta, _load_wf_json
    import copy

    try:
        meta = _get_wf_meta("z_image_turbo_txt2img", "txt2img")
        wf = _load_wf_json(meta)
    except Exception:
        return None

    wf = copy.deepcopy(wf)

    inject_map = (meta.get("inject") or {})
    params = {
        "positive_prompt": prompt,
        "negative_prompt": negative_prompt,
        "width": width,
        "height": height,
        "seed": seed,
    }
    for param_key, mapping in inject_map.items():
        val = params.get(param_key)
        if val is None:
            continue
        node_id = str(mapping["node"])
        field = mapping["field"]
        if node_id in wf:
            wf[node_id]["inputs"][field] = val

    _set_output_prefix(wf, meta, f"mv_ref_{seed}")

    prompt_id = await client.queue_prompt(wf)
    hist = await client.wait_for_completion(prompt_id, timeout=300)

    img_bytes = await _extract_first_image(client, hist)
    if img_bytes:
        dest.write_bytes(img_bytes)
        return dest
    return None


def _set_output_prefix(wf: dict, meta: dict, prefix: str):
    for node_id in (meta.get("output_nodes") or []):
        nid = str(node_id)
        if nid in wf and "filename_prefix" in wf[nid].get("inputs", {}):
            wf[nid]["inputs"]["filename_prefix"] = prefix


async def _extract_first_image(client, hist: dict) -> Optional[bytes]:
    import tempfile
    for node_out in hist.get("outputs", {}).values():
        for img in node_out.get("images", []):
            try:
                tmp = Path(tempfile.mktemp(suffix=".png"))
                await client.download_output(
                    img["filename"], tmp,
                    subfolder=img.get("subfolder", ""),
                    ftype=img.get("type", "output"),
                )
                if tmp.is_file():
                    data = tmp.read_bytes()
                    tmp.unlink(missing_ok=True)
                    return data
            except Exception:
                pass
    return None


async def _generate_scene_clip(
    client,
    scene_prompt: str,
    style_text: str,
    negative_prompt: str,
    reference_image: Optional[Path],
    audio_path: Path,
    audio_start: float,
    audio_duration: float,
    width: int,
    height: int,
    fps: int,
    seed: int,
    dest: Path,
    crf: int = 19,
) -> None:
    """Generate a video clip for a single scene using img+audio→video workflow."""
    from src.core.comfyui.workflow_builder import _get_wf_meta, _load_wf_json
    import copy, tempfile

    full_prompt = f"{scene_prompt}, {style_text}".strip(", ")

    # Upload reference image if available
    uploaded_image: Optional[str] = None
    if reference_image and reference_image.is_file():
        try:
            uploaded_image = await client.upload_image(reference_image)
        except Exception:
            pass

    # Crop audio to scene segment
    cropped_audio: Optional[Path] = None
    try:
        import subprocess
        tmp_audio = Path(tempfile.mktemp(suffix=".wav"))
        cmd = [
            "ffmpeg", "-y",
            "-ss", str(audio_start),
            "-t", str(audio_duration),
            "-i", str(audio_path),
            "-ar", "44100", "-ac", "2",
            str(tmp_audio),
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc.wait(), timeout=60)
        if proc.returncode == 0 and tmp_audio.is_file():
            cropped_audio = tmp_audio
    except Exception as exc:
        log.warning("music_video_audio_crop_failed", error=str(exc))

    # Upload cropped audio
    uploaded_audio: Optional[str] = None
    if cropped_audio:
        try:
            uploaded_audio = await client.upload_input_file(
                cropped_audio, mime="audio/wav", field_name="image"
            )
        except Exception:
            pass

    # Select workflow: prefer img+audio, fallback to img2video
    wf_id = "ltx_img_audio2video" if uploaded_audio else "ltx_img2video"
    try:
        meta = _get_wf_meta(wf_id, "img_audio2video" if uploaded_audio else "img2video")
        wf = _load_wf_json(meta)
    except Exception:
        return

    wf = copy.deepcopy(wf)
    inject_map = meta.get("inject") or {}
    num_frames = max(9, int(audio_duration * fps))
    if num_frames % 8 != 1:
        num_frames = (num_frames // 8) * 8 + 1

    params: dict[str, Any] = {
        "positive_prompt": full_prompt,
        "negative_prompt": negative_prompt,
        "width": width,
        "height": height,
        "seed": seed,
        "num_frames": num_frames,
        "fps": fps,
    }
    if uploaded_image:
        params["image"] = uploaded_image
    if uploaded_audio:
        params["audio"] = uploaded_audio

    for param_key, mapping in inject_map.items():
        val = params.get(param_key)
        if val is None:
            continue
        node_id = str(mapping["node"])
        field = mapping["field"]
        if node_id in wf:
            wf[node_id]["inputs"][field] = val

    _set_output_prefix(wf, meta, f"mv_scene_{seed}")

    prompt_id = await client.queue_prompt(wf)
    hist = await client.wait_for_completion(prompt_id, timeout=600)

    # Download generated video (check gifs, videos, images keys)
    for node_out in hist.get("outputs", {}).values():
        for key in ("gifs", "videos", "images"):
            for vid in node_out.get(key, []):
                fname = vid.get("filename", "")
                if not fname.lower().endswith((".mp4", ".webm", ".gif", ".avi")):
                    continue
                try:
                    await client.download_output(
                        fname, dest,
                        subfolder=vid.get("subfolder", ""),
                        ftype=vid.get("type", "output"),
                    )
                    if dest.is_file() and dest.stat().st_size > 1000:
                        return
                except Exception:
                    pass

    log.warning("music_video_scene_no_video_output", seed=seed)


async def _ffmpeg_concat(clip_paths: List[Path], output: Path) -> None:
    """Concatenate video clips using FFmpeg."""
    import tempfile

    list_file = Path(tempfile.mktemp(suffix=".txt"))
    lines = [f"file '{p.as_posix()}'\n" for p in clip_paths]
    list_file.write_text("".join(lines), encoding="utf-8")

    cmd = [
        "ffmpeg", "-y",
        "-f", "concat", "-safe", "0",
        "-i", str(list_file),
        "-c", "copy",
        str(output),
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await asyncio.wait_for(proc.communicate(), timeout=300)
    list_file.unlink(missing_ok=True)

    if proc.returncode != 0:
        err = stderr.decode(errors="replace") if stderr else "unknown"
        raise RuntimeError(f"FFmpeg concat failed: {err[-500:]}")
    if not output.is_file() or output.stat().st_size < 1000:
        raise RuntimeError("FFmpeg produced no output file")
