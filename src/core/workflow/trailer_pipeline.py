"""
TrailerPipeline — 7-phase end-to-end pipeline:
  1. Audio Analysis    (librosa + optional demucs)
  2. Director LLM      (section selection -> EDL draft)
  3. EDL Validator     (deterministic, 7 checks, greedy fallback)
  4. Audio Compositor  (ffmpeg slice + concat)
  5. Prompt Generator  (Cinematographer LLM -> Prompt Engineer LLM -> per-clip prompts)
  5b. Storyboard       (txt2img bassa risoluzione — pausa per approvazione utente)
  6. ComfyUI Generation (txt2img HD + img2video clips, bounded parallelism)
  7. Video Assembler   (ffmpeg concat -> H.264/AAC 9:16)

Usage:
    pipeline = TrailerPipeline(request)
    async for event in pipeline.run():
        send_sse(event)
"""

from __future__ import annotations

import asyncio
import colorsys
import json
import math
import random
import uuid
from pathlib import Path
from typing import Any, AsyncGenerator, Dict, List, Optional

import structlog
from pydantic import BaseModel, Field

from src.core.config import get_config
from src.core.comfyui.pool import ComfyUINodePool, ComfyUIRunResult
from src.core.comfyui.progress import bind_comfy_progress_queue, iter_progress_while
from src.core.comfyui.workflow_builder import (
    build_txt2img_workflow,
    build_img2video_workflow,
    extract_output_files,
)
from src.core.models.cinematic import FramePrompt
from src.core.utils.media_registry import register_media

from src.core.workflow.trailer_jobs import TrailerJobRecord, upsert_job, now_iso

_bg_tasks: set = set()


def _fire_register(coro) -> None:
    task = asyncio.create_task(coro)
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)

log = structlog.get_logger()

# Pausa tra job storyboard ComfyUI (proxy GPU / coda)
STORYBOARD_CLIP_COOLDOWN_SEC = 5.0
STORYBOARD_GENERATION_PASSES = 2


# ── Request / domain models ────────────────────────────────────────────────────

class TrailerRequest(BaseModel):
    project_id: str
    audio_path: str
    audio_name: str = ""      # display name — populated by the route from the filename
    lyrics: Optional[str] = None
    duration_sec: int = 60
    style: str = "cinematic, dramatic lighting"
    aspect_ratio: str = "9:16"
    width: int = 1080
    height: int = 1920
    fps: int = 30
    txt2img_workflow: str = "z_image_txt2img"
    img2video_workflow: str = "ltx_img_audio2video"
    concurrent_jobs: int = 1
    max_clip_sec: float = 9.5
    resume_job_id: Optional[str] = None   # reuse job_id + artifacts
    phase: str = "full"                   # full | production | storyboard (rigenera solo 5b)
    clip_backend: str = "auto"              # auto | comfyui | ffmpeg
    allow_ffmpeg_fallback: bool = True    # se ComfyUI non esegue (es. proxy RunPod), usa Ken Burns
    storyboard_max_side: int = Field(default=320, ge=96, le=768)   # lato lungo anteprima storyboard
    storyboard_steps: int = Field(default=10, ge=4, le=40)         # step ComfyUI txt2img storyboard
    hd_frame_steps: int = Field(default=25, ge=4, le=50)           # step txt2img frame HD (first/last)
    model_overrides: Optional[dict] = None  # {checkpoint?, video_model?, loras?: [...]}


class AudioSection(BaseModel):
    section_id: str
    start_sec: float
    end_sec: float
    duration_sec: float
    section_type: str       # intro | verse | chorus | bridge | hook | drop | outro
    energy: str             # low | medium | high | peak
    bpm_local: float
    has_vocal: bool
    hook_score: float       # 0.0-1.0


class EDLSlot(BaseModel):
    slot_id: str
    section_id: str
    start_sec: float
    end_sec: float
    duration_sec: float
    section_type: str
    energy: str
    emotion: str
    visual_hint: str


class EDL(BaseModel):
    total_duration_sec: float
    slots: List[EDLSlot]
    cut_points: List[float]


class TrailerClip(BaseModel):
    clip_id: str
    slot_id: str
    start_sec: float
    end_sec: float
    duration_sec: float
    clip_index: int
    scene_prompt: str
    first_frame_prompt: str
    last_frame_prompt: str
    motion_prompt: str
    ltx_video_prompt: str = ""
    negative_prompt: str = ""
    first_frame_path: Optional[str] = None
    last_frame_path: Optional[str] = None
    first_frame_comfy: Optional[str] = None   # filename on ComfyUI input (no re-upload)
    last_frame_comfy: Optional[str] = None
    clip_path: Optional[str] = None
    audio_slice_path: Optional[str] = None
    # Posizione nella traccia sorgente per LTX audio (sequenziale, non timeline clip)
    audio_src_start_sec: Optional[float] = None
    audio_src_end_sec: Optional[float] = None
    storyboard_path: Optional[str] = None


# ── Internal helpers ────────────────────────────────────────────────────────────

def _clip_prompt_payload(clip: "TrailerClip", project_id: str = "") -> dict:
    """Payload SSE per UI (prompt immagine + video)."""
    out = {
        "clip_id": clip.clip_id,
        "slot": clip.slot_id,
        "duration_sec": round(clip.duration_sec, 2),
        "scene_prompt": clip.scene_prompt,
        "first_frame_prompt": clip.first_frame_prompt,
        "last_frame_prompt": clip.last_frame_prompt,
        "motion_prompt": clip.motion_prompt,
        "ltx_video_prompt": clip.ltx_video_prompt,
    }
    if project_id and clip.storyboard_path and Path(clip.storyboard_path).exists():
        out["storyboard_url"] = (
            f"/api/trailer/storyboard/{project_id}/{Path(clip.storyboard_path).name}"
        )
    return out


def _normalize_dop_llm_result(raw: Any) -> Dict[str, dict]:
    """Estrae mappa slot_id → piano visivo DP da risposta LLM."""
    from src.core.llm.generation_prompt_sanitize import sanitize_slot_dict_from_llm

    if raw is None:
        return {}
    if isinstance(raw, list):
        items = raw
    elif isinstance(raw, dict):
        items = (
            raw.get("visual_plans")
            or raw.get("slots")
            or raw.get("plans")
            or []
        )
        if not items and "slot_id" in raw:
            items = [raw]
    else:
        return {}
    out: Dict[str, dict] = {}
    for p in items:
        if isinstance(p, dict) and p.get("slot_id"):
            out[str(p["slot_id"])] = sanitize_slot_dict_from_llm(p)
    return out


def _normalize_prompt_llm_result(raw: Any) -> Dict[str, dict]:
    """Estrae mappa slot_id → prompt da risposte LLM eterogenee."""
    from src.core.llm.generation_prompt_sanitize import sanitize_slot_dict_from_llm

    if raw is None:
        return {}
    if isinstance(raw, list):
        items = raw
    elif isinstance(raw, dict):
        items = raw.get("prompts") or raw.get("slots") or raw.get("clips") or []
        if not items and "slot_id" in raw:
            items = [raw]
    else:
        return {}
    out: Dict[str, dict] = {}
    for p in items:
        if isinstance(p, dict) and p.get("slot_id"):
            out[str(p["slot_id"])] = sanitize_slot_dict_from_llm(p)
    return out


def _nearest_downbeat(target: float, downbeats: list, window: float = 0.5) -> float:
    best = target
    best_dist = float("inf")
    for db in downbeats:
        d = abs(db - target)
        if d < best_dist and d <= window:
            best_dist = d
            best = db
    return best


def _snap_start_downbeat(t: float, downbeats: list, window: float = 1.0) -> float:
    """Arrotonda l'inizio al downbeat precedente (o successivo se più vicino)."""
    if not downbeats:
        return max(0.0, t)
    before = [db for db in downbeats if db <= t]
    after = [db for db in downbeats if db > t]
    cand = []
    if before:
        cand.append(before[-1])
    if after and abs(after[0] - t) <= window:
        cand.append(after[0])
    if not cand:
        return max(0.0, t)
    return min(cand, key=lambda db: abs(db - t))


def _snap_end_downbeat(t: float, downbeats: list, window: float = 1.0) -> float:
    """Arrotonda la fine al downbeat successivo (taglio sul beat)."""
    if not downbeats:
        return t
    after = [db for db in downbeats if db >= t]
    if after and abs(after[0] - t) <= window:
        return after[0]
    before = [db for db in downbeats if db < t]
    return before[-1] if before else t


async def _run_ffmpeg(*args: str) -> tuple:
    """Execute ffmpeg via run_in_executor to support Windows SelectorEventLoop."""
    import subprocess
    loop = asyncio.get_event_loop()

    def _run():
        result = subprocess.run(
            ["ffmpeg", *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        return result.returncode, result.stderr.decode(errors="replace")

    return await loop.run_in_executor(None, _run)


async def _llm_json(
    system: str,
    user: str,
    role: str = "narrative_director",
    temperature: float = 0.7,
    max_tokens: int = 4096,
) -> dict:
    from src.core.llm.factory import get_llm_adapter
    cfg = get_config()
    role_cfg = cfg.get_llm_for_role(role)
    adapter = get_llm_adapter(role_cfg)
    return await adapter.generate_json(
        system=system,
        user=user,
        temperature=temperature,
        max_tokens=max_tokens,
    )


# ── Pipeline ──────────────────────────────────────────────────────────────────

class TrailerPipeline:

    def __init__(self, request: TrailerRequest) -> None:
        from src.core.utils.project_paths import (
            ensure_project_directory,
            resolve_trailer_storage_project_id,
            trailer_catalog_project_id,
        )
        from src.core.workflow.trailer_jobs import job_storage_project_id, load_jobs

        self._created_at = now_iso()
        self.job_id = request.resume_job_id or uuid.uuid4().hex[:10]
        self._catalog_project_id = trailer_catalog_project_id(request.project_id)

        storage_id: str | None = None
        if request.resume_job_id:
            for cat in {self._catalog_project_id, request.project_id, "trailer_standalone"}:
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

        self._storage_project_id = storage_id or resolve_trailer_storage_project_id(
            request.project_id, self.job_id,
        )
        self.req = request.model_copy(update={"project_id": self._storage_project_id})

        base = ensure_project_directory(
            self._storage_project_id,
            title=f"Trailer {self.job_id}",
        )
        self._frames_dir = base / "frames"
        self._clips_dir  = base / "clips"
        self._final_dir  = base / "final"
        self._audio_dir  = base / "audio"
        self._storyboard_dir = base / "storyboard"
        self._pool = ComfyUINodePool()
        self._sections: List[AudioSection] = []
        self._downbeats: list = []
        self._audio_duration: float = 0.0
        self._edl: Optional[EDL] = None
        self._clips_list: List[TrailerClip] = []
        self._trailer_audio_path: Optional[Path] = None
        self._last_result: Optional[dict] = None
        self._use_ffmpeg_clips: bool = False
        self._storyboard_approved: bool = False

    def _hd_frame_ok(self, path: Path) -> bool:
        """True se il PNG è un frame HD di produzione (non anteprima storyboard)."""
        from src.core.utils.comfyui_outputs import COMFY_REAL_IMAGE_MIN_BYTES, is_real_comfy_image

        if not path.exists() or not is_real_comfy_image(path, min_bytes=COMFY_REAL_IMAGE_MIN_BYTES):
            return False
        try:
            from PIL import Image as PILImage

            with PILImage.open(path) as img:
                w, h = img.size
        except Exception:
            return False
        hd_w, hd_h = self._hd_dimensions()
        target_long = max(hd_w, hd_h)
        long_side = max(w, h)
        # Storyboard usa lato lungo << risoluzione frame HD (es. 320 vs 3840)
        return long_side >= int(target_long * 0.88)

    def _purge_sub_hd_frame_cache(self) -> None:
        """Rimuove frame first/last salvati a risoluzione storyboard (run precedenti)."""
        for clip in self._clips_list:
            for name, attr in (
                (f"{clip.clip_id}_first.png", "first_frame_path"),
                (f"{clip.clip_id}_last.png", "last_frame_path"),
            ):
                p = self._frames_dir / name
                if p.exists() and not self._hd_frame_ok(p):
                    try:
                        p.unlink(missing_ok=True)
                    except OSError:
                        pass
                    setattr(clip, attr, None)

    def _storyboard_dimensions(self) -> tuple[int, int]:
        """Anteprima storyboard: scala dal formato finale al lato lungo configurato."""
        w, h = self.req.width, self.req.height
        max_side = max(96, min(768, int(self.req.storyboard_max_side or 320)))
        scale = max_side / max(w, h, 1)
        return max(96, int(w * scale)), max(96, int(h * scale))

    def _hd_dimensions(self) -> tuple[int, int]:
        """Frame first/last HD: sempre 2× la risoluzione video di uscita."""
        return max(64, int(self.req.width) * 2), max(64, int(self.req.height) * 2)

    def _resolve_storyboard_file(self, clip: TrailerClip, dest: Path) -> Optional[Path]:
        """Trova storyboard ComfyUI reale (ignora placeholder FFmpeg ~836 byte)."""
        from src.core.utils.comfyui_outputs import (
            STORYBOARD_IMAGE_MIN_BYTES,
            is_real_comfy_image,
            pick_largest_real_image,
        )

        image_ext = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
        candidates: list[Path] = []
        if clip.storyboard_path:
            candidates.append(Path(clip.storyboard_path))
        candidates.append(dest)

        direct = pick_largest_real_image(
            [p for p in candidates if p.is_file() and p.suffix.lower() in image_ext],
            min_bytes=STORYBOARD_IMAGE_MIN_BYTES,
        )
        if direct:
            return direct.resolve()

        stems = {dest.stem, clip.clip_id}
        for folder in (self._storyboard_dir, self._frames_dir):
            if not folder.is_dir():
                continue
            matches: list[Path] = []
            for p in folder.iterdir():
                if not p.is_file() or p.suffix.lower() not in image_ext:
                    continue
                if not is_real_comfy_image(p, min_bytes=STORYBOARD_IMAGE_MIN_BYTES):
                    continue
                if any(p.stem.startswith(s) or s in p.stem for s in stems):
                    matches.append(p)
            picked = pick_largest_real_image(matches, min_bytes=STORYBOARD_IMAGE_MIN_BYTES)
            if picked:
                return picked.resolve()
        return None

    def _clear_storyboard_placeholders(self, clip: TrailerClip, dest: Path) -> None:
        """Rimuove PNG placeholder prima di rigenerare con ComfyUI."""
        from src.core.utils.comfyui_outputs import is_ffmpeg_placeholder_image

        image_ext = {".png", ".jpg", ".jpeg", ".webp"}
        stems = {dest.stem, clip.clip_id}
        for folder in (self._storyboard_dir, self._frames_dir):
            if not folder.is_dir():
                continue
            for p in folder.iterdir():
                if not p.is_file() or p.suffix.lower() not in image_ext:
                    continue
                if not any(p.stem.startswith(s) or s in p.stem for s in stems):
                    continue
                if is_ffmpeg_placeholder_image(p):
                    try:
                        p.unlink()
                    except OSError:
                        pass

    def _api_project_id(self) -> str:
        """ID cartella per URL API media (reel/trailer storage)."""
        return getattr(self, "_storage_project_id", None) or self.req.project_id

    async def recover_storyboard_clip(self, clip: TrailerClip) -> Optional[dict]:
        """
        Recupera storyboard da disco o da ComfyUI (/view per prefisso) se il job
        è terminato ma il download SSE non ha aggiornato la clip.
        """
        dest = self._storyboard_dir / f"{clip.clip_id}_sb.png"
        resolved = self._resolve_storyboard_file(clip, dest)
        if resolved:
            clip.storyboard_path = str(resolved)
            return self._storyboard_frame_event(clip, resolved, ok=True)

        if self.req.clip_backend == "ffmpeg":
            return None

        from src.core.utils.comfyui_outputs import (
            STORYBOARD_IMAGE_MIN_BYTES,
            download_image_by_prefix_probe,
        )

        prefix = dest.stem
        try:
            client = await self._pool.get_client()
            saved = await download_image_by_prefix_probe(
                client,
                prefix,
                dest,
                min_image_bytes=STORYBOARD_IMAGE_MIN_BYTES,
            )
            self._canonicalize_downloaded_frame(
                clip,
                dest,
                saved,
                role="storyboard",
                comfy_filename=saved.name,
            )
            resolved = self._resolve_storyboard_file(clip, dest)
            if resolved:
                clip.storyboard_path = str(resolved)
                log.info("storyboard_recovered_comfy", clip_id=clip.clip_id, path=str(resolved))
                return self._storyboard_frame_event(clip, resolved, ok=True)
        except Exception as exc:
            log.warning(
                "storyboard_recover_failed",
                clip_id=clip.clip_id,
                prefix=prefix,
                error=str(exc),
            )
        return None

    async def recover_hd_first_frame(self, clip: TrailerClip) -> Optional[dict]:
        """Recupera frame HD first da disco o ComfyUI se mancante."""
        dest = self._frames_dir / f"{clip.clip_id}_first.png"
        if self._hd_frame_ok(dest):
            clip.first_frame_path = str(dest)
        else:
            resolved = self._resolve_frame_file(clip, dest)
            if resolved and self._hd_frame_ok(resolved):
                import shutil

                if resolved.resolve() != dest.resolve():
                    shutil.copy2(resolved, dest)
                clip.first_frame_path = str(dest)
            elif self.req.clip_backend != "ffmpeg":
                from src.core.utils.comfyui_outputs import (
                    COMFY_REAL_IMAGE_MIN_BYTES,
                    download_image_by_prefix_probe,
                )

                try:
                    client = await self._pool.get_client()
                    saved = await download_image_by_prefix_probe(
                        client,
                        dest.stem,
                        dest,
                        min_image_bytes=COMFY_REAL_IMAGE_MIN_BYTES,
                    )
                    self._canonicalize_downloaded_frame(
                        clip,
                        dest,
                        saved,
                        role="first",
                        comfy_filename=saved.name,
                    )
                    clip.first_frame_path = str(dest)
                    log.info("hd_frame_recovered_comfy", clip_id=clip.clip_id)
                except Exception as exc:
                    log.warning(
                        "hd_frame_recover_failed",
                        clip_id=clip.clip_id,
                        error=str(exc),
                    )
                    return None
            else:
                return None

        pid = self._api_project_id()
        return {
            "event": "frame_done",
            "clip_id": clip.clip_id,
            "frame": "first",
            "path": str(dest),
            "filename": dest.name,
            "frame_url": f"/api/{self._media_api_prefix()}/frames-clip/{pid}/{clip.clip_id}",
            "url": f"/api/{self._media_api_prefix()}/frames/{pid}/{dest.name}",
            "hd_frame_ready": True,
            "cached": True,
        }

    async def reconcile_missing_clip_media(
        self,
        *,
        storyboard: bool = True,
        hd_frames: bool = False,
    ) -> list[dict]:
        """Controlla clip senza file locali e tenta recupero da disco / ComfyUI."""
        events: list[dict] = []
        for clip in self._clips_list:
            if storyboard:
                sb_dest = self._storyboard_dir / f"{clip.clip_id}_sb.png"
                resolved = self._resolve_storyboard_file(clip, sb_dest)
                path_broken = False
                if clip.storyboard_path:
                    try:
                        path_broken = not Path(clip.storyboard_path).is_file()
                    except OSError:
                        path_broken = True
                if not resolved or path_broken:
                    ev = await self.recover_storyboard_clip(clip)
                    if ev:
                        events.append(ev)
            if hd_frames:
                ff = self._frames_dir / f"{clip.clip_id}_first.png"
                if not self._hd_frame_ok(ff):
                    ev = await self.recover_hd_first_frame(clip)
                    if ev:
                        events.append(ev)
        return events

    def _resolve_frame_file(self, clip: TrailerClip, dest: Path) -> Optional[Path]:
        """Trova frame HD su disco (nome ComfyUI tipo proge_* o canonico clip_XXX_first.png)."""
        image_ext = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
        min_bytes = 2000
        candidates: list[Path] = []
        if dest.name.endswith("_first.png") and clip.first_frame_path:
            candidates.append(Path(clip.first_frame_path))
        if dest.name.endswith("_last.png") and clip.last_frame_path:
            candidates.append(Path(clip.last_frame_path))
        candidates.append(dest)

        for p in candidates:
            try:
                if p.is_file() and p.suffix.lower() in image_ext and p.stat().st_size >= min_bytes:
                    return p.resolve()
            except OSError:
                continue

        stems = {
            dest.stem,
            clip.clip_id,
            clip.clip_id.split("_slot")[0] if "_slot" in clip.clip_id else clip.clip_id,
        }
        if "_first" in dest.stem:
            stems.add(f"{clip.clip_id}_first")
        if "_last" in dest.stem:
            stems.add(f"{clip.clip_id}_last")

        for folder in (self._frames_dir, self._storyboard_dir):
            if not folder.is_dir():
                continue
            matches: list[Path] = []
            for p in folder.iterdir():
                if not p.is_file() or p.suffix.lower() not in image_ext:
                    continue
                try:
                    if p.stat().st_size < min_bytes:
                        continue
                except OSError:
                    continue
                stem_l = p.stem.lower()
                if any(s.lower() in stem_l or stem_l.startswith(s.lower()) for s in stems):
                    matches.append(p)
            if matches:
                matches.sort(key=lambda x: x.stat().st_mtime, reverse=True)
                return matches[0].resolve()
        return None

    def _canonicalize_downloaded_frame(
        self,
        clip: TrailerClip,
        dest: Path,
        download_dest: Path,
        *,
        role: str,
        comfy_filename: str,
    ) -> Path:
        """Copia output ComfyUI sul path canonico e aggiorna metadati clip."""
        import shutil
        from src.core.utils.comfyui_outputs import (
            COMFY_REAL_IMAGE_MIN_BYTES,
            STORYBOARD_IMAGE_MIN_BYTES,
            is_real_comfy_image,
        )

        min_real = STORYBOARD_IMAGE_MIN_BYTES if role == "storyboard" else COMFY_REAL_IMAGE_MIN_BYTES
        src: Optional[Path] = None
        for candidate in (download_dest, dest):
            if candidate.exists() and is_real_comfy_image(candidate, min_bytes=min_real):
                src = candidate
                break
        if src is None:
            found = self._resolve_frame_file(clip, dest)
            if found and is_real_comfy_image(found, min_bytes=min_real):
                src = found

        if src is None:
            size_hint = download_dest.stat().st_size if download_dest.exists() else 0
            raise RuntimeError(
                f"Frame {role} per {clip.clip_id} non valido dopo download ({size_hint} bytes)"
            )

        if src.resolve() != dest.resolve():
            shutil.copy2(src, dest)

        if role == "storyboard":
            clip.storyboard_path = str(dest)
            from src.core.utils.comfyui_outputs import prune_storyboard_sidecars_for_stem

            prune_storyboard_sidecars_for_stem(dest.parent, dest.stem)
            if src.resolve() != dest.resolve() and src.exists():
                try:
                    src.unlink()
                except OSError:
                    pass
        elif role == "first":
            clip.first_frame_path = str(dest)
            clip.first_frame_comfy = comfy_filename or src.name
        else:
            clip.last_frame_path = str(dest)
            clip.last_frame_comfy = comfy_filename or src.name
        return dest

    def _media_api_prefix(self) -> str:
        """trailer | reel — path API per servire storyboard/frames."""
        return "trailer"

    def _storyboard_frame_event(self, clip: TrailerClip, path: Path, *, ok: bool = True) -> dict:
        from urllib.parse import quote

        api = self._media_api_prefix()
        if ok:
            clip.storyboard_path = str(path)
        path_str = str(path) if ok else ""
        ev = {
            "event": "storyboard_frame",
            "clip_id": clip.clip_id,
            "slot_id": clip.slot_id,
            "storyboard_ok": ok,
            "storyboard_placeholder": not ok,
        }
        if ok:
            ev.update({
                "path": path_str,
                "storyboard_filename": path.name,
                "url": f"/api/{api}/storyboard/{self._storage_project_id}/{path.name}",
                "preview_url": (
                    f"/api/{self._media_api_prefix()}/source?path={quote(path_str, safe='')}"
                ),
                "storyboard_clip_url": (
                    f"/api/{api}/storyboard-clip/{self._storage_project_id}/{clip.clip_id}"
                ),
            })
        return ev

    def _storyboard_frames_payload(self) -> list[dict]:
        frames = []
        for clip in self._clips_list:
            p = self._resolve_storyboard_file(clip, self._storyboard_dir / f"{clip.clip_id}_sb.png")
            if not p:
                continue
            clip.storyboard_path = str(p)
            from urllib.parse import quote

            path_str = str(p)
            api = self._media_api_prefix()
            frames.append({
                "clip_id": clip.clip_id,
                "slot_id": clip.slot_id,
                "duration_sec": round(clip.duration_sec, 2),
                "scene_prompt": clip.scene_prompt,
                "first_frame_prompt": (clip.first_frame_prompt or "")[:200],
                "path": path_str,
                "storyboard_filename": p.name,
                "storyboard_ok": True,
                "storyboard_placeholder": False,
                "url": f"/api/{api}/storyboard/{self._storage_project_id}/{p.name}",
                "preview_url": (
                    f"/api/{self._media_api_prefix()}/source?path={quote(path_str, safe='')}"
                ),
                "storyboard_clip_url": (
                    f"/api/{api}/storyboard-clip/{self._storage_project_id}/{clip.clip_id}"
                ),
            })
        return frames

    def _after_storyboard_frame_saved(self, clip: TrailerClip) -> None:
        """Hook opzionale (Reel/Trailer) per checkpoint dopo ogni frame storyboard."""
        pass

    def _checkpoint_path(self) -> Path:
        cfg = get_config()
        base = cfg.app.data_path / "projects" / self._storage_project_id
        return base / f"trailer_state_{self.job_id}.json"

    def _checkpoint_path_candidates(self) -> list[Path]:
        """Percorsi checkpoint (cartella nuova + trailer_standalone legacy)."""
        cfg = get_config()
        roots = [self._storage_project_id]
        if (
            self._catalog_project_id == "trailer_standalone"
            and self._storage_project_id != "trailer_standalone"
        ):
            roots.append("trailer_standalone")
        return [
            cfg.app.data_path / "projects" / root / f"trailer_state_{self.job_id}.json"
            for root in roots
        ]

    def _save_checkpoint(self, phase_completed: int) -> None:
        try:
            payload = {
                "job_id": self.job_id,
                "phase_completed": phase_completed,
                "request": self.req.model_dump(),
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
            try:
                from src.core.config import get_config
                from src.core.obsidian.sync import schedule_obsidian_sync_from_checkpoint

                if get_config().obsidian.enabled and get_config().obsidian.auto_sync_on_checkpoint:
                    schedule_obsidian_sync_from_checkpoint(
                        project_id=self.req.project_id,
                        job_id=self.job_id,
                        pipeline_kind="trailer",
                        checkpoint=payload,
                    )
            except Exception:
                pass
        except Exception as e:
            log.warning("trailer_checkpoint_save_failed", error=str(e))

    def _load_checkpoint(self) -> bool:
        path = next((p for p in self._checkpoint_path_candidates() if p.exists()), None)
        if not path:
            return False
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
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
            log.warning("trailer_checkpoint_load_failed", error=str(e))
            return False

    def _job_config(self) -> dict:
        return self.req.model_dump(exclude={"project_id", "audio_path", "audio_name", "lyrics"})

    def _save_job(self, status: str, result: Optional[dict] = None, error: Optional[str] = None) -> None:
        try:
            upsert_job(TrailerJobRecord(
                job_id=self.job_id,
                project_id=self._catalog_project_id,
                storage_project_id=self._storage_project_id,
                created_at=self._created_at,
                updated_at=now_iso(),
                status=status,
                audio_name=self.req.audio_name or Path(self.req.audio_path).name,
                audio_path=self.req.audio_path,
                config=self._job_config(),
                result=result,
                error=error,
            ))
        except Exception as e:
            log.warning("trailer_job_save_failed", error=str(e))

    # ── Public entry point ────────────────────────────────────────────────────

    async def run(self) -> AsyncGenerator[dict, None]:
        self._save_job(status="running")
        phase = self.req.phase
        production = phase == "production" and self._load_checkpoint()
        storyboard_only = phase == "storyboard" and self._load_checkpoint()
        pipeline_completed = False

        from src.core.utils.project_paths import ensure_project_directory as _ensure_proj

        try:
            _proj_base = _ensure_proj(
                self._storage_project_id,
                title=f"Trailer {self.job_id}",
            )
            yield {
                "event": "start",
                "job_id": self.job_id,
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
                    yield {
                        **_clip_prompt_payload(clip, self.req.project_id),
                        "event": "clip_queued", "pct": 0.46,
                    }
                audio_short = False
                if self._trailer_audio_path and self._trailer_audio_path.exists():
                    audio_short = (
                        await self._probe_duration(self._trailer_audio_path)
                        < self.req.duration_sec * 0.92
                    )
                need_audio = (
                    self._edl is not None
                    and (
                        self._edl.total_duration_sec < self.req.duration_sec * 0.92
                        or audio_short
                        or self._trailer_audio_path is None
                        or not self._trailer_audio_path.exists()
                    )
                )
                if need_audio:
                    if self._edl.total_duration_sec < self.req.duration_sec * 0.92:
                        self._edl = self._contiguous_edl_fallback()
                    async for ev in self._phase4_audio_compositor():
                        yield ev
                    self._save_checkpoint(4)
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
                sb_result = {
                    "awaiting_storyboard": True,
                    "storyboard": self._storyboard_frames_payload(),
                    "clip_count": len(self._clips_list),
                }
                self._save_job(status="awaiting_storyboard", result=sb_result)
                yield {
                    "event": "awaiting_storyboard_approval",
                    "job_id": self.job_id,
                    "storyboard": sb_result["storyboard"],
                    "pct": 0.45,
                    "terminal": True,
                }

            else:
                async for ev in self._phase1_audio_analysis():
                    yield ev
                self._save_checkpoint(1)
                async for ev in self._phase2_3_director_and_validate():
                    yield ev
                self._save_checkpoint(3)
                async for ev in self._phase4_audio_compositor():
                    yield ev
                self._save_checkpoint(4)
                async for ev in self._phase5_prompt_generator():
                    yield ev
                self._save_checkpoint(5)
                async for ev in self._phase5b_storyboard_preview():
                    yield ev
                self._save_checkpoint(55)
                sb_result = {
                    "awaiting_storyboard": True,
                    "storyboard": self._storyboard_frames_payload(),
                    "clip_count": len(self._clips_list),
                    "trailer_audio_path": str(self._trailer_audio_path) if self._trailer_audio_path else None,
                }
                self._save_job(status="awaiting_storyboard", result=sb_result)
                yield {
                    "event": "awaiting_storyboard_approval",
                    "job_id": self.job_id,
                    "storyboard": sb_result["storyboard"],
                    "edl": self._edl.model_dump() if self._edl else None,
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
            log.exception("trailer_pipeline_fatal", error=str(exc))
            self._save_job(status="failed", error=str(exc))
            yield {"error": str(exc), "phase": "fatal"}

    # ── Phase 1: Audio Analysis ───────────────────────────────────────────────

    async def _phase1_audio_analysis(self) -> AsyncGenerator[dict, None]:
        yield {"event": "phase", "phase": "audio_analysis", "pct": 0.02}

        audio_path = Path(self.req.audio_path)
        if not audio_path.exists():
            raise FileNotFoundError(f"Audio file not found: {audio_path}")

        loop = asyncio.get_event_loop()
        sections, downbeats, duration = await loop.run_in_executor(
            None, self._analyze_audio_sync, audio_path
        )
        self._sections = sections
        self._downbeats = downbeats
        self._audio_duration = duration

        yield {
            "event": "audio_analysis_done",
            "pct": 0.12,
            "sections": len(sections),
            "duration_sec": round(duration, 2),
            "bpm": sections[0].bpm_local if sections else 0,
        }

    def _analyze_audio_sync(self, audio_path: Path):
        import librosa
        import numpy as np

        y, sr = librosa.load(str(audio_path), mono=True)
        duration = librosa.get_duration(y=y, sr=sr)

        tempo_result, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
        beat_times = librosa.frames_to_time(beat_frames, sr=sr)
        bpm_global = float(np.atleast_1d(tempo_result)[0])

        # Downbeats: every 4th beat approximation
        downbeats: list = list(beat_times[::4])

        # Structural segmentation via agglomerative clustering on MFCCs
        frame_length = 2048
        hop_length = 512
        mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
        k = min(10, max(3, int(duration / 15)))
        try:
            boundary_frames = librosa.segment.agglomerative(mfcc, k=k)
            boundary_times_arr = librosa.frames_to_time(boundary_frames, sr=sr)
            boundary_list = sorted(set([0.0] + list(boundary_times_arr) + [duration]))
        except Exception:
            step = 15.0
            raw = [i * step for i in range(int(duration / step) + 2)]
            boundary_list = [b for b in raw if b < duration] + [duration]

        # RMS energy
        rms = librosa.feature.rms(y=y, frame_length=frame_length, hop_length=hop_length)[0]
        rms_times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop_length)
        rms_max = float(rms.max()) if rms.max() > 0 else 1.0

        # Spectral centroid for vocal heuristic
        spec_centroid = librosa.feature.spectral_centroid(
            y=y, sr=sr, hop_length=hop_length
        )[0]
        centroid_times = librosa.frames_to_time(
            np.arange(len(spec_centroid)), sr=sr, hop_length=hop_length
        )

        # Optional demucs vocal separation
        vocal_rms_by_sec: Dict[int, float] = {}
        try:
            import demucs.api as demucs_api  # type: ignore
            separator = demucs_api.Separator()
            _, separated = separator.separate_audio_file(audio_path)
            vocals = separated.get("vocals")
            if vocals is not None:
                v_mono = vocals.mean(dim=0).numpy() if vocals.ndim > 1 else vocals.numpy()
                v_rms = librosa.feature.rms(
                    y=v_mono, frame_length=frame_length, hop_length=hop_length
                )[0]
                v_times = librosa.frames_to_time(
                    np.arange(len(v_rms)), sr=sr, hop_length=hop_length
                )
                for t, r in zip(v_times, v_rms):
                    vocal_rms_by_sec[int(t)] = float(r)
        except Exception:
            pass

        type_cycle = [
            "intro", "verse", "chorus", "verse", "chorus", "bridge", "chorus", "outro"
        ]
        n_sections = len(boundary_list) - 1
        sections: List[AudioSection] = []

        for i in range(n_sections):
            t_start = boundary_list[i]
            t_end   = boundary_list[i + 1]
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

            if vocal_rms_by_sec:
                seg_secs = [s for s in vocal_rms_by_sec if t_start <= s < t_end]
                if seg_secs:
                    avg_v = sum(vocal_rms_by_sec[s] for s in seg_secs) / len(seg_secs)
                    has_vocal = avg_v > 0.05
                else:
                    has_vocal = False
            else:
                cmask = (centroid_times >= t_start) & (centroid_times < t_end)
                mean_cent = float(spec_centroid[cmask].mean()) if cmask.any() else 0.0
                has_vocal = mean_cent > 2000 and energy_norm > 0.25

            sec_type = type_cycle[i % len(type_cycle)]

            beat_mask = (beat_times >= t_start) & (beat_times < t_end)
            n_beats = int(beat_mask.sum())
            bpm_local = (n_beats / seg_dur * 60.0) if (seg_dur > 0 and n_beats > 1) else bpm_global

            type_bonus = 0.3 if sec_type in {"chorus", "hook", "drop"} else 0.0
            hook_score = min(1.0, 0.3 * energy_norm + 0.4 * float(has_vocal) + type_bonus)

            sections.append(AudioSection(
                section_id=f"sec_{i+1:03d}",
                start_sec=round(t_start, 3),
                end_sec=round(t_end, 3),
                duration_sec=round(seg_dur, 3),
                section_type=sec_type,
                energy=energy,
                bpm_local=round(bpm_local, 2),
                has_vocal=has_vocal,
                hook_score=round(hook_score, 3),
            ))

        return sections, downbeats, duration

    # ── Phase 2+3: Director LLM + EDL Validator ───────────────────────────────

    def _sections_for_director(self) -> List[AudioSection]:
        """Sezioni utilizzabili per EDL (esclude intro/outro < 3s)."""
        return [s for s in self._sections if s.duration_sec >= 3.0]

    def _director_menu_json(self) -> str:
        rows = []
        for s in self._sections_for_director():
            rows.append({
                "section_id": s.section_id,
                "start_sec": s.start_sec,
                "end_sec": s.end_sec,
                "duration_sec": round(s.duration_sec, 1),
                "type": s.section_type,
                "energy": s.energy,
                "hook_score": s.hook_score,
            })
        return json.dumps(rows, indent=2)

    def _slots_from_llm_raw(self, raw: dict) -> list:
        if not isinstance(raw, dict):
            return []
        slots = raw.get("slots") or raw.get("sections") or raw.get("edl_slots") or []
        if isinstance(slots, dict):
            slots = slots.get("slots", [])
        return slots if isinstance(slots, list) else []

    def _resolve_section_id(self, sid: str) -> Optional[str]:
        """Normalizza sec_3 → sec_003 e match case-insensitive."""
        if not sid:
            return None
        sid = str(sid).strip()
        index = {s.section_id: s.section_id for s in self._sections}
        lower = {k.lower(): k for k in index}
        if sid in index:
            return sid
        if sid.lower() in lower:
            return lower[sid.lower()]
        import re
        m = re.match(r"sec[_-]?(\d+)$", sid, re.I)
        if m:
            canonical = f"sec_{int(m.group(1)):03d}"
            if canonical in index:
                return canonical
        return None

    async def _phase2_3_director_and_validate(self) -> AsyncGenerator[dict, None]:
        yield {"event": "phase", "phase": "director_llm", "pct": 0.12}

        usable = self._sections_for_director()
        id_list = ", ".join(s.section_id for s in usable)
        best = max(usable, key=lambda s: s.hook_score) if usable else None
        hint = ""
        if best and best.duration_sec >= self.req.duration_sec * 0.4:
            hint = (
                f"\nRecommended for {self.req.duration_sec}s trailer: ONE slot "
                f'{{"section_id":"{best.section_id}"}} (chorus/hook {best.start_sec:.0f}s–{best.end_sec:.0f}s).'
            )

        system_prompt = (
            "You are a professional music video editor cutting a trailer audio bed. "
            "Use ONLY section_id values from the menu. "
            "Pick sections close together in the song timeline. "
            "Output ONLY valid JSON, no markdown."
        )
        user_template = (
            f"Target trailer length: {self.req.duration_sec} seconds\n"
            f"Allowed section_id values: {id_list}\n\n"
            f"Sections menu:\n{self._director_menu_json()}\n\n"
            f"Rules:\n"
            f"- Prefer 1–3 slots; total trimmed duration should reach ~{self.req.duration_sec}s\n"
            f"- All picks must lie within a {self.req.duration_sec + 15}s window in the original song\n"
            f"- Prefer chorus/hook (high hook_score); order for musical flow\n"
            f"{hint}\n\n"
            'Output: {"slots":[{"section_id":"sec_XXX","emotion":"epic","visual_hint":"..."}]}'
        )

        errors_feedback = ""
        edl: Optional[EDL] = None
        last_errors: list = []

        for attempt in range(3):
            user_prompt = user_template
            if errors_feedback:
                user_prompt += (
                    f"\n\nPrevious attempt failed — fix exactly:\n{errors_feedback}"
                )
            yield {"event": "llm_attempt", "attempt": attempt + 1, "pct": 0.14 + attempt * 0.03}

            try:
                raw = await asyncio.wait_for(
                    _llm_json(
                        system_prompt, user_prompt,
                        role="narrative_director", temperature=0.55, max_tokens=2000,
                    ),
                    timeout=120.0,
                )
                slots_raw = self._slots_from_llm_raw(raw)
            except (Exception, asyncio.TimeoutError) as exc:
                errors_feedback = f"LLM call failed: {exc!r}"
                last_errors = [errors_feedback]
                yield {"event": "edl_validation_error", "attempt": attempt + 1, "errors": last_errors}
                continue

            edl, validation_errors = self._validate_edl(slots_raw)
            if not validation_errors:
                break
            last_errors = validation_errors
            errors_feedback = "\n".join(validation_errors)
            log.warning("edl_validation_failed", attempt=attempt + 1, errors=validation_errors)
            yield {
                "event": "edl_validation_error",
                "attempt": attempt + 1,
                "errors": validation_errors,
            }
            edl = None

        if edl is None:
            edl = self._contiguous_edl_fallback()
            reason = (
                errors_feedback
                if errors_feedback
                else "LLM non ha prodotto un EDL valido"
            )
            log.warning("edl_fallback_contiguous", reason=reason, errors=last_errors)
            yield {
                "event": "edl_fallback",
                "mode": "contiguous",
                "reason": reason[:500],
                "edl": {
                    "total_duration_sec": edl.total_duration_sec,
                    "slots": [s.model_dump() for s in edl.slots],
                },
                "pct": 0.27,
            }

        self._edl = edl
        yield {"event": "phase", "phase": "edl_validator", "pct": 0.27}
        yield {
            "event": "edl_ready",
            "pct": 0.28,
            "edl": {
                "total_duration_sec": edl.total_duration_sec,
                "slots": [s.model_dump() for s in edl.slots],
                "cut_points": edl.cut_points,
            },
        }

    def _slot_has_peak_energy(self, slot: EDLSlot) -> bool:
        sec_index = {s.section_id: s for s in self._sections}
        sec = sec_index.get(slot.section_id)
        if not sec:
            return False
        if sec.energy in {"high", "peak"}:
            return True
        return (
            sec.energy == "medium"
            and sec.section_type in {"chorus", "hook", "drop"}
            and sec.hook_score >= 0.55
        )

    def _validate_edl(self, slots_raw: list) -> tuple:
        errors: list = []
        sec_index = {s.section_id: s for s in self._sections}
        validated: List[EDLSlot] = []
        total_dur = 0.0
        _MAX_SLOT = 30.0
        _MIN_SLOT = 2.0
        unknown_ids: list = []

        if not slots_raw:
            return None, ["LLM returned empty slots list"]

        for raw in slots_raw:
            if not isinstance(raw, dict):
                continue
            sid_raw = raw.get("section_id", "")
            sid = self._resolve_section_id(sid_raw)
            if sid is None:
                unknown_ids.append(str(sid_raw))
                continue
            sec = sec_index.get(sid)
            if sec is None:
                unknown_ids.append(sid)
                continue
            if sec.duration_sec < _MIN_SLOT:
                continue
            if sec.start_sec < 0:
                errors.append(f"Section '{sid}' start_sec < 0")
                continue
            valid_types = {"intro", "verse", "chorus", "bridge", "hook", "drop", "outro"}
            if sec.section_type not in valid_types:
                errors.append(f"Section '{sid}' has invalid section_type '{sec.section_type}'")
                continue

            clamped_dur = min(sec.duration_sec, _MAX_SLOT)
            clamped_end = min(sec.start_sec + clamped_dur, self._audio_duration)
            clamped_dur = clamped_end - sec.start_sec

            remaining = self.req.duration_sec - total_dur
            if remaining < _MIN_SLOT:
                break
            use_dur = min(clamped_dur, remaining)
            if use_dur < _MIN_SLOT:
                continue

            total_dur += use_dur
            validated.append(EDLSlot(
                slot_id=f"slot_{len(validated)+1:03d}",
                section_id=sid,
                start_sec=sec.start_sec,
                end_sec=sec.start_sec + use_dur,
                duration_sec=round(use_dur, 3),
                section_type=sec.section_type,
                energy=sec.energy,
                emotion=raw.get("emotion", "cinematic"),
                visual_hint=raw.get("visual_hint", "cinematic shot"),
            ))

        if unknown_ids:
            allowed = ", ".join(s.section_id for s in self._sections_for_director())
            errors.append(
                f"Unknown section_id(s): {', '.join(unknown_ids)}. Use only: {allowed}"
            )

        if not validated:
            return None, errors or ["No valid sections after filtering"]

        audio_has_high_energy = any(
            s.energy in {"high", "peak"}
            or (s.section_type in {"chorus", "hook", "drop"} and s.hook_score >= 0.55)
            for s in self._sections
        )
        if audio_has_high_energy and not any(self._slot_has_peak_energy(s) for s in validated):
            errors.append(
                "Include at least one chorus/hook section (medium/high energy, hook_score≥0.55)"
            )

        if len(validated) > 1:
            ordered = sorted(validated, key=lambda s: s.start_sec)
            span = ordered[-1].start_sec - ordered[0].start_sec
            max_span = max(float(self.req.duration_sec) + 20.0, 50.0)
            if span > max_span:
                errors.append(
                    f"Sections span {span:.0f}s in the song (max ~{max_span:.0f}s). "
                    "Pick neighboring section_ids or a single long chorus."
                )

        edl = self._finalize_edl(validated)
        if edl.total_duration_sec < self.req.duration_sec * 0.85:
            if len(validated) == 1:
                return edl, []
            errors.append(
                f"After trim, duration {edl.total_duration_sec:.1f}s < target "
                f"{self.req.duration_sec}s — add a section or pick a longer chorus"
            )

        if errors:
            return None, errors

        return edl, []

    def _score_source_window(self, start: float, end: float) -> float:
        """Punteggio qualità di un intervallo nel brano sorgente."""
        if end <= start:
            return 0.0
        score = 0.0
        for sec in self._sections:
            overlap_start = max(start, sec.start_sec)
            overlap_end = min(end, sec.end_sec)
            if overlap_end <= overlap_start:
                continue
            overlap = overlap_end - overlap_start
            energy_w = {"peak": 1.0, "high": 0.85, "medium": 0.55, "low": 0.25}.get(sec.energy, 0.5)
            type_w = 1.15 if sec.section_type in {"chorus", "hook", "drop"} else 1.0
            score += overlap * sec.hook_score * energy_w * type_w
        return score

    def _find_best_contiguous_window(self, target_dur: float) -> tuple[float, float]:
        """Finestra continua migliore per un trailer musicale (un solo estratto coerente)."""
        target_dur = max(4.0, min(target_dur, self._audio_duration))
        if self._audio_duration <= target_dur + 1.0:
            return 0.0, self._audio_duration

        best_start = 0.0
        best_score = -1.0
        step = 0.25 if self._audio_duration < 120 else 0.5
        t = 0.0
        while t + target_dur <= self._audio_duration + 0.01:
            end = min(t + target_dur, self._audio_duration)
            sc = self._score_source_window(t, end)
            if sc > best_score:
                best_score = sc
                best_start = t
            t += step

        start = _snap_start_downbeat(best_start, self._downbeats, window=1.5)
        end = min(start + target_dur, self._audio_duration)
        end = _snap_end_downbeat(end, self._downbeats, window=1.5)
        if end - start < target_dur * 0.85:
            end = min(start + target_dur, self._audio_duration)
        return start, end

    def _snap_slot_bounds(self, start: float, end: float) -> tuple[float, float]:
        start = _snap_start_downbeat(start, self._downbeats, window=1.0)
        end = _snap_end_downbeat(end, self._downbeats, window=1.0)
        end = min(end, self._audio_duration)
        if end <= start:
            end = min(start + 2.0, self._audio_duration)
        return round(start, 3), round(end, 3)

    def _rebuild_cut_points(self, slots: List[EDLSlot]) -> list[float]:
        pts = [0.0]
        acc = 0.0
        for slot in slots:
            acc += slot.duration_sec
            pts.append(round(acc, 3))
        return pts

    def _finalize_edl(self, slots: List[EDLSlot]) -> EDL:
        """Allinea durata al target, snap downbeat, ricostruisce cut_points."""
        if not slots:
            return EDL(total_duration_sec=0.0, slots=[], cut_points=[0.0])

        snapped: List[EDLSlot] = []
        for slot in slots:
            s, e = self._snap_slot_bounds(slot.start_sec, slot.end_sec)
            dur = e - s
            if dur < 1.5:
                continue
            snapped.append(slot.model_copy(update={
                "start_sec": s,
                "end_sec": e,
                "duration_sec": round(dur, 3),
            }))

        if not snapped:
            return self._contiguous_edl_fallback()

        target = float(self.req.duration_sec)
        total = sum(s.duration_sec for s in snapped)

        if len(snapped) == 1:
            slot = snapped[0]
            if total < target - 0.25:
                new_end = min(slot.start_sec + target, self._audio_duration)
                new_end = _snap_end_downbeat(new_end, self._downbeats, window=1.5)
                if new_end - slot.start_sec < target * 0.85:
                    new_end = min(slot.start_sec + target, self._audio_duration)
                snapped[0] = slot.model_copy(update={
                    "end_sec": round(new_end, 3),
                    "duration_sec": round(new_end - slot.start_sec, 3),
                })
        elif total > target + 0.5:
            scale = target / total
            scaled: List[EDLSlot] = []
            for slot in snapped:
                nd = max(2.0, slot.duration_sec * scale)
                ne = min(slot.start_sec + nd, self._audio_duration)
                scaled.append(slot.model_copy(update={
                    "end_sec": round(ne, 3),
                    "duration_sec": round(ne - slot.start_sec, 3),
                }))
            snapped = scaled
        elif total < target - 0.5:
            snapped = self._expand_slots_to_target(snapped, target)
            total = sum(s.duration_sec for s in snapped)
            if total < target * 0.85:
                log.warning(
                    "edl_short_after_expand",
                    total=total,
                    target=target,
                    fallback="contiguous",
                )
                return self._contiguous_edl_fallback()

        total = sum(s.duration_sec for s in snapped)
        return EDL(
            total_duration_sec=round(total, 3),
            slots=snapped,
            cut_points=self._rebuild_cut_points(snapped),
        )

    def _expand_slots_to_target(
        self, slots: List[EDLSlot], target: float,
    ) -> List[EDLSlot]:
        """Allunga gli slot nel brano sorgente fino al target (senza salti caotici)."""
        sec_index = {s.section_id: s for s in self._sections}
        expanded = [s.model_copy() for s in slots]
        total = sum(s.duration_sec for s in expanded)
        deficit = target - total
        if deficit <= 0.25:
            return expanded

        for i, slot in enumerate(expanded):
            if deficit <= 0.25:
                break
            sec = sec_index.get(slot.section_id)
            max_end = sec.end_sec if sec else min(slot.end_sec + 30.0, self._audio_duration)
            room = max(0.0, max_end - slot.end_sec)
            add = min(deficit, room, 12.0)
            if add < 0.35:
                continue
            ne = round(slot.end_sec + add, 3)
            expanded[i] = slot.model_copy(update={
                "end_sec": ne,
                "duration_sec": round(ne - slot.start_sec, 3),
            })
            deficit -= add

        if deficit > 0.5 and expanded:
            slot = expanded[-1]
            ne = min(slot.end_sec + deficit, self._audio_duration)
            ne = _snap_end_downbeat(ne, self._downbeats, window=1.5)
            if ne - slot.start_sec > slot.duration_sec + 0.25:
                expanded[-1] = slot.model_copy(update={
                    "end_sec": round(ne, 3),
                    "duration_sec": round(ne - slot.start_sec, 3),
                })

        return expanded

    def _contiguous_edl_fallback(self) -> EDL:
        """Un unico estratto continuo sul miglior hook — trailer musicale coerente."""
        target = float(self.req.duration_sec)
        start, end = self._find_best_contiguous_window(target)
        start, end = self._snap_slot_bounds(start, end)
        dur = end - start
        sec = max(self._sections, key=lambda s: s.hook_score) if self._sections else None
        slot = EDLSlot(
            slot_id="slot_001",
            section_id=sec.section_id if sec else "sec_001",
            start_sec=start,
            end_sec=end,
            duration_sec=round(dur, 3),
            section_type=sec.section_type if sec else "chorus",
            energy=sec.energy if sec else "high",
            emotion="cinematic",
            visual_hint="cinematic shot, music video highlight",
        )
        return self._finalize_edl([slot])

    def _greedy_edl_fallback(self) -> EDL:
        """Montaggio corto: solo sezioni vicine nel brano (max 25s di gap), non salti caotici."""
        _MAX_SLOT = 20.0
        _MIN_SLOT = 3.0
        _MAX_GAP = 25.0
        target = float(self.req.duration_sec)

        ranked = sorted(self._sections, key=lambda s: s.hook_score, reverse=True)
        if not ranked:
            return self._contiguous_edl_fallback()

        anchor = ranked[0]
        pool = [
            s for s in self._sections
            if abs(s.start_sec - anchor.start_sec) <= _MAX_GAP
            and s.duration_sec >= _MIN_SLOT
        ]
        if len(pool) < 2:
            return self._contiguous_edl_fallback()

        pool.sort(key=lambda s: s.start_sec)
        selected: List[EDLSlot] = []
        total_dur = 0.0
        for sec in pool:
            remaining = target - total_dur
            if remaining < _MIN_SLOT:
                break
            use_dur = min(sec.duration_sec, _MAX_SLOT, remaining)
            if use_dur < _MIN_SLOT:
                continue
            selected.append(EDLSlot(
                slot_id=f"slot_{len(selected)+1:03d}",
                section_id=sec.section_id,
                start_sec=sec.start_sec,
                end_sec=sec.start_sec + use_dur,
                duration_sec=round(use_dur, 3),
                section_type=sec.section_type,
                energy=sec.energy,
                emotion="cinematic",
                visual_hint="cinematic shot",
            ))
            total_dur += use_dur

        if total_dur < target * 0.85:
            return self._contiguous_edl_fallback()

        return self._finalize_edl(selected)

    # ── Phase 4: Audio Compositor ─────────────────────────────────────────────

    async def _phase4_audio_compositor(self) -> AsyncGenerator[dict, None]:
        yield {"event": "phase", "phase": "audio_compositor", "pct": 0.28}

        audio_src = Path(self.req.audio_path)
        target_dur = float(self.req.duration_sec)
        n_slots = len(self._edl.slots)
        FADE_IN = 0.15
        FADE_OUT = 0.35
        # Crossfade breve solo tra spezzoni vicini nel montaggio; 1 slot = nessun crossfade
        XFADE = 0.12 if n_slots > 1 else 0.0

        slot_wavs: list[Path] = []

        # ── 1. Estrai ogni slot (downbeat già applicati in _finalize_edl) ───────
        for i, slot in enumerate(self._edl.slots):
            s, e = self._snap_slot_bounds(slot.start_sec, slot.end_sec)
            dur = max(0.5, e - s)
            out_wav = self._audio_dir / f"slot_{i:03d}_{slot.slot_id}.wav"
            # dynaudnorm per livello uniforme tra tagli
            rc, err = await _run_ffmpeg(
                "-y",
                "-ss", f"{s:.3f}",
                "-t", f"{dur:.3f}",
                "-i", str(audio_src),
                "-af", "dynaudnorm=f=75:g=15",
                "-ar", "44100", "-ac", "2",
                str(out_wav),
            )
            if rc != 0:
                raise RuntimeError(
                    f"ffmpeg audio slice failed for {slot.slot_id}: {err[-300:]}"
                )
            slot_wavs.append(out_wav)
            yield {
                "event": "audio_slice",
                "slot": slot.slot_id,
                "source_start_sec": round(s, 2),
                "source_end_sec": round(e, 2),
                "duration_sec": round(dur, 2),
                "pct": round(0.28 + 0.02 * (i / max(n_slots, 1)), 3),
            }

        trailer_audio = self._audio_dir / f"trailer_audio_{self.job_id}.wav"
        if not slot_wavs:
            raise RuntimeError("No audio slots to composite")

        # ── 2. Montaggio: concat o crossfade corto + durata esatta ─────────────
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
        elif XFADE <= 0:
            concat_list = self._audio_dir / f"concat_{self.job_id}.txt"
            concat_list.write_text(
                "\n".join(f"file '{p.as_posix()}'" for p in slot_wavs),
                encoding="utf-8",
            )
            rc, err = await _run_ffmpeg(
                "-y", "-f", "concat", "-safe", "0", "-i", str(concat_list),
                "-af", f"afade=t=in:st=0:d={FADE_IN},afade=t=out:st={max(0, target_dur - FADE_OUT):.3f}:d={FADE_OUT},"
                f"atrim=0:{target_dur:.3f}",
                "-ar", "44100", "-ac", "2",
                str(trailer_audio),
            )
        else:
            inputs: list = []
            for w in slot_wavs:
                inputs += ["-i", str(w)]
            filter_parts: list = []
            prev = "[0]"
            for i in range(1, len(slot_wavs)):
                label = f"[x{i}]" if i < len(slot_wavs) - 1 else "[xout]"
                filter_parts.append(
                    f"{prev}[{i}]acrossfade=d={XFADE}:c1=exp:c2=exp{label}"
                )
                prev = label
            fo_start = max(0.0, target_dur - FADE_OUT)
            filter_parts.append(
                f"[xout]afade=t=in:st=0:d={FADE_IN},"
                f"afade=t=out:st={fo_start:.3f}:d={FADE_OUT},"
                f"atrim=0:{target_dur:.3f}[final]"
            )
            rc, err = await _run_ffmpeg(
                "-y", *inputs,
                "-filter_complex", ";".join(filter_parts),
                "-map", "[final]",
                "-ar", "44100", "-ac", "2",
                str(trailer_audio),
            )

        if rc != 0:
            raise RuntimeError(f"ffmpeg audio composite failed: {err[-300:]}")

        actual_dur = await self._probe_duration(trailer_audio)

        # Montaggio più corto del target (EDL corto): un estratto continuo da 60s
        if actual_dur < target_dur * 0.92:
            log.warning(
                "trailer_audio_short",
                actual=actual_dur,
                target=target_dur,
                action="contiguous_recompose",
            )
            self._edl = self._contiguous_edl_fallback()
            yield {
                "event": "edl_fallback",
                "reason": f"Audio trailer {actual_dur:.1f}s < target {target_dur}s — estratto continuo",
                "pct": 0.30,
            }
            slot_wavs.clear()
            for i, slot in enumerate(self._edl.slots):
                s, e = self._snap_slot_bounds(slot.start_sec, slot.end_sec)
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
            fo_start = max(0.0, target_dur - FADE_OUT)
            rc, err = await _run_ffmpeg(
                "-y", "-i", str(slot_wavs[0]),
                "-af",
                f"afade=t=in:st=0:d={FADE_IN},afade=t=out:st={fo_start:.3f}:d={FADE_OUT},"
                f"atrim=0:{target_dur:.3f}",
                "-ar", "44100", "-ac", "2",
                str(trailer_audio),
            )
            if rc != 0:
                raise RuntimeError(f"ffmpeg audio recompose failed: {err[-300:]}")
            actual_dur = await self._probe_duration(trailer_audio)

        self._trailer_audio_path = trailer_audio
        _fire_register(register_media(
            trailer_audio, "audio",
            self.req.project_id, "Trailer",
            source="trailer",
            tags=["trailer", "trailer_audio"],
        ))
        yield {
            "event": "audio_ready",
            "path": str(trailer_audio),
            "audio_url": f"/api/trailer/source?path={str(trailer_audio)}",
            "duration_sec": round(actual_dur, 2),
            "target_duration_sec": target_dur,
            "slots": n_slots,
            "edl_mode": "contiguous" if n_slots == 1 else "montage",
            "pct": 0.32,
        }

    # ── Phase 5: Prompt Generator ─────────────────────────────────────────────

    async def _phase5_prompt_generator(self) -> AsyncGenerator[dict, None]:
        yield {"event": "phase", "phase": "prompt_gen", "pct": 0.32}

        from src.core.llm.cinematic_prompts import (
            TRAILER_CINEMATOGRAPHER_SYSTEM,
            TRAILER_PROMPT_ENGINEER_FROM_DOP_SYSTEM,
            build_trailer_cinematographer_prompt,
            build_trailer_prompt_engineer_from_dop,
        )

        audio_src = Path(self.req.audio_path)
        bpm = self._sections[0].bpm_local if self._sections else 0.0
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
        yield {"event": "progress", "msg": "Direttore della fotografia — pianificazione visiva…", "pct": 0.33}
        try:
            raw_dop = await asyncio.wait_for(
                _llm_json(
                    TRAILER_CINEMATOGRAPHER_SYSTEM,
                    build_trailer_cinematographer_prompt(
                        slot_descs,
                        style=self.req.style,
                        aspect_ratio=self.req.aspect_ratio,
                        bpm=bpm,
                        lyrics_excerpt=self.req.lyrics or "",
                    ),
                    role="cinematographer",
                    temperature=0.65,
                    max_tokens=4096,
                ),
                timeout=120.0,
            )
            visual_plans = _normalize_dop_llm_result(raw_dop)
            log.info("trailer_dop_ok", slots=len(visual_plans))
            yield {
                "event": "dop_plan_ready",
                "plans": list(visual_plans.values()),
                "pct": 0.36,
            }
        except asyncio.TimeoutError:
            log.warning("trailer_dop_timeout", timeout=120.0)
        except Exception as exc:
            log.warning("trailer_dop_failed", error=str(exc))

        prompt_map: Dict[str, dict] = {}
        if visual_plans:
            yield {"event": "progress", "msg": "Prompt Engineer — prompt immagine da piano DP…", "pct": 0.37}
            try:
                raw_pe = await asyncio.wait_for(
                    _llm_json(
                        TRAILER_PROMPT_ENGINEER_FROM_DOP_SYSTEM,
                        build_trailer_prompt_engineer_from_dop(
                            list(visual_plans.values()),
                            style=self.req.style,
                            aspect_ratio=self.req.aspect_ratio,
                        ),
                        role="prompt_engineer",
                        temperature=0.65,
                        max_tokens=6000,
                    ),
                    timeout=120.0,
                )
                prompt_map = _normalize_prompt_llm_result(raw_pe)
                log.info("trailer_prompt_engineer_ok", slots=len(prompt_map))
            except asyncio.TimeoutError:
                log.warning("trailer_prompt_engineer_timeout", timeout=120.0)
            except Exception as exc:
                log.warning("trailer_prompt_engineer_failed", error=str(exc))

        if not prompt_map and visual_plans:
            from src.core.llm.generation_prompt_sanitize import sanitize_trailer_clip_prompts

            for sid, plan in visual_plans.items():
                prompt_map[sid] = {
                    "slot_id": sid,
                    **sanitize_trailer_clip_prompts(
                        {},
                        plan,
                        style=self.req.style,
                    ),
                }
            log.info("trailer_prompt_fallback_from_dop", slots=len(prompt_map))

        clips: List[TrailerClip] = []
        clip_global_idx = 0

        from src.core.llm.generation_prompt_sanitize import sanitize_trailer_clip_prompts

        for slot in self._edl.slots:
            pdata = prompt_map.get(slot.slot_id, {})
            dop = visual_plans.get(slot.slot_id, {})
            clean = sanitize_trailer_clip_prompts(
                pdata,
                dop,
                style=self.req.style,
                slot_emotion=slot.emotion or slot.visual_hint,
            )
            scene_prompt = clean["scene_prompt"]
            first_frame_p = clean["first_frame_prompt"]
            last_frame_p = clean["last_frame_prompt"]
            motion_prompt = clean["motion_prompt"]
            ltx_video_prompt = clean.get("ltx_video_prompt", "")
            negative_prompt = clean["negative_prompt"]

            clip_count = max(1, math.ceil(slot.duration_sec / self.req.max_clip_sec))

            for c_idx in range(clip_count):
                frac_s = c_idx / clip_count
                frac_e = (c_idx + 1) / clip_count
                raw_s  = slot.start_sec + frac_s * slot.duration_sec
                raw_e  = slot.start_sec + frac_e * slot.duration_sec

                clip_start = _nearest_downbeat(raw_s, self._downbeats)
                clip_end   = _nearest_downbeat(raw_e, self._downbeats)
                if clip_end <= clip_start:
                    clip_end = raw_e
                clip_dur = clip_end - clip_start

                clip_id = f"clip_{clip_global_idx:03d}_{slot.slot_id}"

                audio_slice: Optional[Path] = self._audio_dir / f"{clip_id}_audio.wav"
                rc, err = await _run_ffmpeg(
                    "-y",
                    "-ss", str(clip_start),
                    "-t", str(max(0.1, clip_dur)),
                    "-i", str(audio_src),
                    "-ar", "44100", "-ac", "2",
                    str(audio_slice),
                )
                if rc != 0:
                    log.warning("clip_audio_slice_failed", clip_id=clip_id, err=err[-200:])
                    audio_slice = None

                tc = TrailerClip(
                    clip_id=clip_id,
                    slot_id=slot.slot_id,
                    start_sec=clip_start,
                    end_sec=clip_end,
                    duration_sec=clip_dur,
                    clip_index=c_idx,
                    scene_prompt=scene_prompt,
                    first_frame_prompt=first_frame_p,
                    last_frame_prompt=last_frame_p,
                    motion_prompt=motion_prompt,
                    ltx_video_prompt=ltx_video_prompt,
                    negative_prompt=negative_prompt,
                    audio_slice_path=str(audio_slice) if audio_slice else None,
                )
                clips.append(tc)
                clip_global_idx += 1
                yield {
                    **_clip_prompt_payload(tc, self.req.project_id),
                    "event": "clip_queued",
                    "pct": round(0.32 + 0.10 * (clip_global_idx / max(clip_global_idx + 1, 1)), 3),
                }

        self._clips_list = clips
        yield {
            "event": "prompts_ready",
            "clips": [_clip_prompt_payload(c, self.req.project_id) for c in clips],
            "pct": 0.42,
        }
        yield {"event": "phase_done", "phase": "prompt_gen", "pct": 0.42}

    # ── Phase 5b: Storyboard preview (bassa risoluzione) ────────────────────────

    async def _phase5b_storyboard_preview(self) -> AsyncGenerator[dict, None]:
        yield {"event": "phase", "phase": "storyboard", "pct": 0.43}
        sb_w, sb_h = self._storyboard_dimensions()
        yield {
            "event": "progress",
            "msg": (
                f"Storyboard {sb_w}×{sb_h} · {self.req.storyboard_steps} step — "
                f"{len(self._clips_list)} frame (sequenziale)…"
            ),
            "pct": 0.44,
        }

        from src.core.comfyui.workflow_builder import sync_workflows_from_base
        from src.core.utils.comfyui_outputs import prune_storyboard_folder

        sync_workflows_from_base()
        pruned = prune_storyboard_folder(self._storyboard_dir)
        if pruned:
            log.info("storyboard_folder_pruned", removed=len(pruned), files=pruned[:8])

        use_ffmpeg_storyboard = self.req.clip_backend == "ffmpeg"
        total = len(self._clips_list)
        progress_q: asyncio.Queue = asyncio.Queue()

        async def emit_comfy(clip: TrailerClip, ev: dict) -> None:
            payload = dict(ev)
            payload.setdefault("clip_id", clip.clip_id)
            payload.setdefault("kind", "storyboard")
            await progress_q.put(payload)

        async def render_one_clip(clip: TrailerClip, *, force: bool = False) -> bool:
            dest = self._storyboard_dir / f"{clip.clip_id}_sb.png"
            if not force:
                existing = self._resolve_storyboard_file(clip, dest)
                if existing:
                    clip.storyboard_path = str(existing)
                    return True
            self._clear_storyboard_placeholders(clip, dest)
            if use_ffmpeg_storyboard:
                await self._gen_placeholder_frame(dest, clip, "first")
                return False
            last_err: Exception | None = None
            for attempt in range(4):
                try:

                    async def _emit(ev: dict) -> None:
                        await emit_comfy(clip, ev)

                    await self._gen_storyboard_frame(clip, dest, emit=_emit)
                    last_err = None
                    return bool(self._resolve_storyboard_file(clip, dest))
                except Exception as exc:
                    last_err = exc
                    log.warning(
                        "storyboard_attempt_failed",
                        clip_id=clip.clip_id,
                        attempt=attempt + 1,
                        error=str(exc),
                    )
                    if attempt < 3:
                        await asyncio.sleep(2.5 * (attempt + 1))
            if last_err:
                log.warning("storyboard_frame_failed", clip_id=clip.clip_id, error=str(last_err))
            clip.storyboard_path = None
            return False

        async def drain_progress() -> list[dict]:
            drained: list[dict] = []
            while True:
                try:
                    drained.append(progress_q.get_nowait())
                except asyncio.QueueEmpty:
                    break
            return drained

        for pass_idx in range(STORYBOARD_GENERATION_PASSES):
            pending = list(self._clips_list)
            if pass_idx > 0:
                pending = [
                    c for c in self._clips_list
                    if not self._resolve_storyboard_file(
                        c, self._storyboard_dir / f"{c.clip_id}_sb.png",
                    )
                ]
                if not pending:
                    break
                yield {
                    "event": "progress",
                    "msg": f"Secondo pass storyboard — {len(pending)} frame mancanti…",
                    "pct": 0.44,
                }

            for clip in pending:
                sb_ok = await render_one_clip(clip, force=pass_idx > 0)
                for ev in await drain_progress():
                    yield ev
                dest = self._storyboard_dir / f"{clip.clip_id}_sb.png"
                resolved = (
                    self._resolve_storyboard_file(clip, dest) if sb_ok else None
                )
                if resolved:
                    ev = self._storyboard_frame_event(clip, resolved, ok=True)
                    self._after_storyboard_frame_saved(clip)
                else:
                    ev = self._storyboard_frame_event(clip, dest, ok=False)
                    log.warning("storyboard_file_missing", clip_id=clip.clip_id, dest=str(dest))
                saved_n = sum(
                    1 for c in self._clips_list
                    if self._resolve_storyboard_file(
                        c, self._storyboard_dir / f"{c.clip_id}_sb.png",
                    )
                )
                ev["pct"] = round(0.43 + 0.02 * (saved_n / max(total, 1)), 3)
                yield ev
                if pass_idx == 0 and clip != pending[-1]:
                    await asyncio.sleep(STORYBOARD_CLIP_COOLDOWN_SEC)

        pruned_final = prune_storyboard_folder(self._storyboard_dir)
        if pruned_final:
            log.info("storyboard_folder_pruned_final", removed=len(pruned_final))

        reconcile_events = await self.reconcile_missing_clip_media(storyboard=True)
        for ev in reconcile_events:
            cid = ev.get("clip_id")
            if cid:
                clip_obj = next((c for c in self._clips_list if c.clip_id == cid), None)
                if clip_obj:
                    self._after_storyboard_frame_saved(clip_obj)
            yield ev
        if reconcile_events:
            log.info("storyboard_reconcile_pass", recovered=len(reconcile_events))

        yield {
            "event": "storyboard_ready",
            "frames": self._storyboard_frames_payload(),
            "count": len([c for c in self._clips_list if c.storyboard_path]),
            "pct": 0.45,
        }
        yield {"event": "phase_done", "phase": "storyboard", "pct": 0.45}

    def _comfy_frame_prompt(self, clip: TrailerClip, *, role: str = "first") -> FramePrompt:
        """Prompt immagine dettagliato per ComfyUI (senza thinking/meta LLM)."""
        from src.core.llm.generation_prompt_sanitize import (
            CINEMATIC_NEGATIVE_PROMPT,
            ensure_detailed_frame_prompt,
            sanitize_generation_prompt,
        )

        raw = clip.first_frame_prompt if role == "first" else clip.last_frame_prompt
        prompt = ensure_detailed_frame_prompt(
            raw,
            scene_prompt=clip.scene_prompt,
            style=self.req.style,
            role=role,
            min_chars=90 if role == "first" else 70,
        )
        neg_default = CINEMATIC_NEGATIVE_PROMPT
        return FramePrompt(
            prompt=prompt,
            negative_prompt=sanitize_generation_prompt(
                clip.negative_prompt,
                fallback=neg_default,
                min_len=16,
                max_len=400,
            ) or neg_default,
            seed=random.randint(0, 2 ** 32),
        )

    async def _gen_storyboard_frame(
        self,
        clip: TrailerClip,
        dest: Path,
        *,
        emit=None,
    ) -> Path:
        """Frame storyboard ComfyUI a bassa risoluzione; restituisce path locale risolto."""
        from src.core.utils.comfyui_outputs import (
            STORYBOARD_IMAGE_MIN_BYTES,
            download_comfyui_image_resilient,
        )

        sb_w, sb_h = self._storyboard_dimensions()
        frame = self._comfy_frame_prompt(clip, role="first")
        output_prefix = dest.stem
        wf = build_txt2img_workflow(
            frame,
            output_prefix=output_prefix,
            width=sb_w,
            height=sb_h,
            steps=max(4, min(40, int(self.req.storyboard_steps or 10))),
            workflow_id=self.req.txt2img_workflow,
        )
        run = await self._run_comfy_live(
            wf, timeout=300, label="Storyboard",
            clip_id=clip.clip_id, kind="storyboard",
            emit=emit,
        )
        from src.core.comfyui.workflow_builder import extract_history_error

        err = extract_history_error(run.history)
        if err:
            raise RuntimeError(f"ComfyUI storyboard {clip.clip_id}: {err}")

        try:
            saved = await download_comfyui_image_resilient(
                run.client,
                run.history,
                output_prefix=output_prefix,
                dest=dest,
                prompt_id=run.prompt_id or "",
                min_image_bytes=STORYBOARD_IMAGE_MIN_BYTES,
            )
        except Exception as exc:
            raise RuntimeError(
                f"No storyboard output for {clip.clip_id} "
                f"(prompt_id={run.prompt_id or '?'}): {exc}"
            ) from exc
        remote_name = saved.name
        self._canonicalize_downloaded_frame(
            clip, dest, saved, role="storyboard", comfy_filename=remote_name,
        )
        resolved = self._resolve_storyboard_file(clip, dest) or dest
        clip.storyboard_path = str(resolved)
        return resolved

    # ── Phase 6: ComfyUI Generation ───────────────────────────────────────────

    async def _probe_comfyui_execution(self) -> bool:
        """Verifica che ComfyUI produca e scarichi un'immagine reale (proxy RunPod spesso no-op)."""
        if self.req.clip_backend == "ffmpeg":
            return False
        from src.core.utils.comfyui_outputs import download_comfyui_file

        probe_dest = self._frames_dir / f"_probe_{self.job_id}.png"
        try:
            frame = FramePrompt(prompt="probe frame, cinematic", negative_prompt="bad")
            wf = build_txt2img_workflow(
                frame,
                output_prefix=f"probe_{self.job_id}",
                width=256,
                height=256,
                steps=2,
                workflow_id=self.req.txt2img_workflow,
            )
            run = await self._pool.run_with_fallback(wf, timeout=90)
            files = extract_output_files(run.history)
            if not files:
                log.warning("comfyui_probe_no_outputs")
                return False
            await download_comfyui_file(
                run.client, files[0], probe_dest, expect="image",
            )
            from src.core.utils.comfyui_outputs import is_real_comfy_image

            ok = is_real_comfy_image(probe_dest)
            if ok:
                log.info("comfyui_probe_ok", node=run.node_name, bytes=probe_dest.stat().st_size)
            else:
                log.warning("comfyui_probe_download_invalid", path=str(probe_dest))
            return ok
        except Exception as exc:
            log.warning("comfyui_probe_failed", error=str(exc))
            return False
        finally:
            try:
                probe_dest.unlink(missing_ok=True)
            except OSError:
                pass

    async def _resolve_clip_backend_mode(self) -> None:
        """Preferisce ComfyUI; il probe è solo diagnostico (non forza placeholder globali)."""
        if self.req.clip_backend == "ffmpeg":
            self._use_ffmpeg_clips = True
            return
        if self.req.clip_backend == "comfyui":
            self._use_ffmpeg_clips = False
            return

        self._use_ffmpeg_clips = False
        probe_ok = await self._probe_comfyui_execution()
        if not probe_ok:
            log.warning(
                "comfyui_probe_advisory_failed",
                allow_ffmpeg_fallback=self.req.allow_ffmpeg_fallback,
            )
            if not self.req.allow_ffmpeg_fallback and self.req.clip_backend == "auto":
                raise RuntimeError(
                    "ComfyUI non scarica immagini valide dai nodi configurati. "
                    "Verifica Bearer auth / tunnel :8188, oppure abilita fallback FFmpeg."
                )

    async def _phase6_comfyui_generation(self) -> AsyncGenerator[dict, None]:
        yield {"event": "phase", "phase": "comfyui", "pct": 0.42}

        from src.core.comfyui.workflow_builder import sync_workflows_from_base
        sync_workflows_from_base()
        self._purge_sub_hd_frame_cache()

        yield {"event": "comfyui_probe", "status": "start", "pct": 0.43}
        await self._resolve_clip_backend_mode()
        yield {
            "event": "comfyui_probe",
            "status": "done",
            "backend": "ffmpeg" if self._use_ffmpeg_clips else "comfyui",
            "pct": 0.44,
        }

        if self._use_ffmpeg_clips:
            yield {
                "event": "clip_backend",
                "backend": "ffmpeg",
                "reason": (
                    "ComfyUI non esegue sui nodi configurati — Ken Burns / cut statici"
                    if self.req.clip_backend != "ffmpeg"
                    else "Modalità cut statici"
                ),
            }
        else:
            yield {
                "event": "clip_backend",
                "backend": "comfyui",
                "txt2img": self.req.txt2img_workflow,
                "img2video": self.req.img2video_workflow,
            }

        sem = asyncio.Semaphore(self.req.concurrent_jobs)
        total = len(self._clips_list)
        done_count = 0
        queue: asyncio.Queue = asyncio.Queue()

        def _artifact_ok(path: Path, min_bytes: int = 4096) -> bool:
            from src.core.utils.comfyui_outputs import is_real_comfy_image

            if min_bytes >= 4096:
                return is_real_comfy_image(path, min_bytes=max(min_bytes, 5000))
            return path.exists() and path.stat().st_size >= min_bytes

        def _hd_ok(path: Path) -> bool:
            return self._hd_frame_ok(path)

        def _resolve_frame_paths(clip: TrailerClip) -> tuple[Path, Path]:
            """Solo frame di questo job (clip_id esatto) — mai riusare PNG di run precedenti."""
            ff = self._frames_dir / f"{clip.clip_id}_first.png"
            lf = self._frames_dir / f"{clip.clip_id}_last.png"
            if clip.first_frame_path:
                p = Path(clip.first_frame_path)
                if _hd_ok(p):
                    ff = p
            if clip.last_frame_path:
                p = Path(clip.last_frame_path)
                if _hd_ok(p):
                    lf = p
            if _hd_ok(ff) and not _hd_ok(lf):
                lf = ff
            return ff, lf

        async def process_clip(clip: TrailerClip) -> None:
            async with sem:
                events: list = []
                try:
                    ff_path = self._frames_dir / f"{clip.clip_id}_first.png"
                    lf_path = self._frames_dir / f"{clip.clip_id}_last.png"
                    async def emit_live(ev: dict) -> None:
                        await queue.put(ev)

                    ff_path, lf_path, frame_events = await self._ensure_frame_files(
                        clip, ff_path, lf_path, _hd_ok, emit=emit_live,
                    )
                    # Emit frame preview events immediately to SSE stream
                    _preview_events = {"frame_done", "frames_ready", "frame_skip"}
                    for fe in frame_events:
                        if fe.get("event") in _preview_events:
                            await emit_live(fe)
                        else:
                            events.append(fe)

                    ff_path = self._resolve_frame_file(clip, ff_path) or ff_path
                    lf_path = self._resolve_frame_file(clip, lf_path) or lf_path
                    if not _hd_ok(ff_path):
                        raise RuntimeError(
                            f"Frame first mancante per {clip.clip_id} — "
                            "verifica download ComfyUI (file proge_* in frames/)"
                        )
                    if not _hd_ok(lf_path):
                        lf_path = ff_path

                    # Emit frames_ready immediately so UI shows preview without waiting for video gen
                    await emit_live({
                        "event": "frames_ready",
                        "clip_id": clip.clip_id,
                        "first_path": str(ff_path),
                        "frame_url": f"/api/{self._media_api_prefix()}/frames-clip/{self.req.project_id}/{clip.clip_id}",
                        "hd_frame_ready": True,
                    })

                    clip_dest = self._clips_dir / f"{clip.clip_id}.mp4"
                    skip_video = _artifact_ok(clip_dest, min_bytes=50_000)
                    if skip_video and not self._use_ffmpeg_clips:
                        # Rigenera con LTX (evita clip ffmpeg/statiche di run precedenti)
                        skip_video = False
                        try:
                            clip_dest.unlink(missing_ok=True)
                        except OSError:
                            pass
                    if skip_video:
                        clip.clip_path = str(clip_dest)
                        events.append({"event": "clip_skip", "clip_id": clip.clip_id,
                                       "path": str(clip_dest)})
                    elif self._use_ffmpeg_clips:
                        await self._gen_video_ffmpeg(clip, ff_path, lf_path, clip_dest)
                        clip.clip_path = str(clip_dest)
                        events.append({
                            "event": "clip_done", "clip_id": clip.clip_id,
                            "path": str(clip_dest), "backend": "ffmpeg",
                            "url": f"/api/trailer/clips/{self.req.project_id}/{clip_dest.name}",
                        })
                    else:
                        await self._gen_video(
                            clip, ff_path, lf_path, clip_dest, emit=emit_live,
                        )
                        clip.clip_path = str(clip_dest)
                        events.append({
                            "event": "clip_done", "clip_id": clip.clip_id,
                            "path": str(clip_dest),
                            "url": f"/api/trailer/clips/{self.req.project_id}/{clip_dest.name}",
                        })

                except Exception as exc:
                    err_msg = str(exc) or repr(exc)
                    log.error("clip_generation_failed", clip_id=clip.clip_id, error=err_msg)
                    # Fallback per-clip se abbiamo frame ma LTX/upload fallisce
                    if (
                        not self._use_ffmpeg_clips
                        and self.req.allow_ffmpeg_fallback
                    ):
                        try:
                            ff_path, lf_path = _resolve_frame_paths(clip)
                            if _artifact_ok(ff_path):
                                clip_dest = self._clips_dir / f"{clip.clip_id}.mp4"
                                await self._gen_video_ffmpeg(clip, ff_path, lf_path, clip_dest)
                                clip.clip_path = str(clip_dest)
                                events = [
                                    {"event": "clip_fallback", "clip_id": clip.clip_id,
                                     "backend": "ffmpeg", "reason": err_msg[:200]},
                                    {
                                        "event": "clip_done", "clip_id": clip.clip_id,
                                        "path": str(clip_dest), "backend": "ffmpeg",
                                        "url": f"/api/trailer/clips/{self.req.project_id}/{clip_dest.name}",
                                    },
                                ]
                            else:
                                events.append({"event": "clip_error", "clip_id": clip.clip_id,
                                               "error": err_msg})
                        except Exception as fb_exc:
                            events.append({
                                "event": "clip_error",
                                "clip_id": clip.clip_id,
                                "error": f"{err_msg} | fallback: {fb_exc}",
                            })
                    else:
                        events.append({"event": "clip_error", "clip_id": clip.clip_id,
                                       "error": err_msg})

                self._save_checkpoint(6)
                # Register generated media in the library
                if _artifact_ok(ff_path):
                    _fire_register(register_media(
                        ff_path, "image",
                        self.req.project_id,
                        title=f"{clip.clip_id} frame",
                        source=self._media_api_prefix(),
                        tags=[self._media_api_prefix(), "frame", clip.clip_id],
                    ))
                clip_p = Path(clip.clip_path) if clip.clip_path else None
                if clip_p and clip_p.exists() and clip_p.stat().st_size >= 50_000:
                    _fire_register(register_media(
                        clip_p, "video",
                        self.req.project_id,
                        title=clip.clip_id,
                        source=self._media_api_prefix(),
                        tags=[self._media_api_prefix(), "clip", clip.clip_id],
                    ))
                for ev in events:
                    await queue.put(ev)
                await queue.put({"_done_marker": clip.clip_id})
                # Brief cooldown so ComfyUI can flush its output queue before the next job
                await asyncio.sleep(1.5)

        yield {
            "event": "phase",
            "phase": "video_clips",
            "msg": "Generazione clip LTX / FFmpeg dai frame…",
            "pct": 0.52,
        }

        # Sequential processing: one ComfyUI job at a time.
        # Each clip task must fully complete (including local download) before the next starts.
        for i, clip in enumerate(self._clips_list):
            yield {
                "event": "progress",
                "msg": f"Avvio clip {i + 1}/{total} — {clip.clip_id}",
                "clip_id": clip.clip_id,
                "clip_index": i + 1,
                "clip_total": total,
                "pct": round(0.42 + 0.46 * (i / max(total, 1)), 3),
            }
            task = asyncio.create_task(process_clip(clip))
            clip_done = False
            while not clip_done:
                try:
                    ev = await asyncio.wait_for(queue.get(), timeout=120)
                except asyncio.TimeoutError:
                    if task.done():
                        break
                    yield {"event": "progress", "msg": f"In attesa download ComfyUI — {clip.clip_id}…"}
                    continue
                if "_done_marker" in ev:
                    done_count += 1
                    pct = round(0.42 + 0.46 * (done_count / max(total, 1)), 3)
                    yield {"event": "generation_progress", "completed": done_count,
                           "total": total, "pct": pct}
                    clip_done = True
                else:
                    yield ev
            # Surface any task exception without swallowing it
            try:
                await task
            except Exception as _task_exc:
                log.error("clip_task_exception", clip_id=clip.clip_id, error=str(_task_exc))

        # Recovery: ComfyUI fallito ma frame presenti → rigenera clip in FFmpeg
        if self.req.allow_ffmpeg_fallback:
            missing = [
                c for c in self._clips_list
                if not c.clip_path or not Path(c.clip_path).exists()
                or Path(c.clip_path).stat().st_size < 50_000
            ]
            if missing:
                yield {
                    "event": "clip_recovery",
                    "backend": "ffmpeg",
                    "clips": len(missing),
                    "pct": 0.86,
                }
                for clip in missing:
                    ff_path, lf_path = _resolve_frame_paths(clip)
                    if not _artifact_ok(ff_path):
                        continue
                    clip_dest = self._clips_dir / f"{clip.clip_id}.mp4"
                    try:
                        await self._gen_video_ffmpeg(clip, ff_path, lf_path, clip_dest)
                        clip.clip_path = str(clip_dest)
                        yield {
                            "event": "clip_done",
                            "clip_id": clip.clip_id,
                            "path": str(clip_dest),
                            "backend": "ffmpeg",
                            "url": f"/api/trailer/clips/{self.req.project_id}/{clip_dest.name}",
                        }
                    except Exception as exc:
                        yield {
                            "event": "clip_error",
                            "clip_id": clip.clip_id,
                            "error": str(exc),
                        }

        yield {"event": "generation_complete", "pct": 0.88}

    async def _ensure_frame_files(
        self,
        clip: TrailerClip,
        ff_path: Path,
        lf_path: Path,
        artifact_ok,
        emit=None,
    ) -> tuple[Path, Path, list]:
        """Risolve o genera coppia first/last (ComfyUI, cache disco, placeholder FFmpeg)."""
        events: list = []

        def _resolved() -> tuple[Path, Path]:
            ff = self._frames_dir / f"{clip.clip_id}_first.png"
            lf = self._frames_dir / f"{clip.clip_id}_last.png"
            if clip.first_frame_path:
                p = Path(clip.first_frame_path)
                if artifact_ok(p):
                    ff = p
            if clip.last_frame_path:
                p = Path(clip.last_frame_path)
                if artifact_ok(p):
                    lf = p
            if artifact_ok(ff) and not artifact_ok(lf):
                lf = ff
            return ff, lf

        ff_path, lf_path = _resolved()
        if artifact_ok(ff_path) and artifact_ok(lf_path) and not self._use_ffmpeg_clips:
            clip.first_frame_path = str(ff_path)
            clip.last_frame_path = str(lf_path)
            events.append({
                "event": "frame_skip",
                "clip_id": clip.clip_id,
                "path": str(ff_path),
                "reason": "cached_comfyui",
            })
            events.append({
                "event": "frame_done",
                "clip_id": clip.clip_id,
                "frame": "first",
                "path": str(ff_path),
                "url": f"/api/{self._media_api_prefix()}/frames/{self.req.project_id}/{ff_path.name}",
                "cached": True,
            })
            return ff_path, lf_path, events

        canon_ff = self._frames_dir / f"{clip.clip_id}_first.png"
        canon_lf = self._frames_dir / f"{clip.clip_id}_last.png"

        first_comfy_failed = False
        for role, target, prompt, comfy_attr in (
            ("first", canon_ff, clip.first_frame_prompt, "first_frame_comfy"),
            ("last", canon_lf, clip.last_frame_prompt, "last_frame_comfy"),
        ):
            ff_cur, lf_cur = _resolved()
            if role == "first" and (artifact_ok(canon_ff) or artifact_ok(ff_cur)):
                continue
            if role == "last":
                if artifact_ok(canon_lf) or artifact_ok(lf_cur):
                    continue
                if artifact_ok(ff_cur) and not artifact_ok(lf_cur):
                    import shutil
                    shutil.copy2(ff_cur, canon_lf)
                    clip.last_frame_path = str(canon_lf)
                    continue
                if first_comfy_failed and artifact_ok(canon_ff):
                    import shutil
                    shutil.copy2(canon_ff, canon_lf)
                    clip.last_frame_path = str(canon_lf)
                    continue
            frame_timeout = 240.0 if role == "first" else 180.0
            if emit:
                role_it = "first frame" if role == "first" else "last frame"
                await emit({
                    "event": "progress",
                    "msg": f"Generazione immagine {role_it} — {clip.clip_id}",
                    "clip_id": clip.clip_id,
                    "clip_phase": "frame_gen",
                })
            try:
                await asyncio.wait_for(
                    self._gen_frame(
                        prompt, target,
                        clip_id=clip.clip_id,
                        role=role,
                        negative_prompt=clip.negative_prompt,
                        emit=emit,
                    ),
                    timeout=frame_timeout,
                )
                resolved = self._resolve_frame_file(clip, target) or target
                if resolved.resolve() != target.resolve():
                    import shutil
                    shutil.copy2(resolved, target)
                setattr(clip, comfy_attr, clip.first_frame_comfy if role == "first" else clip.last_frame_comfy)
                events.append({
                    "event": "frame_done",
                    "clip_id": clip.clip_id,
                    "frame": role,
                    "path": str(target),
                    "filename": target.name,
                    "frame_url": (
                        f"/api/{self._media_api_prefix()}/frames-clip/{self.req.project_id}/{clip.clip_id}"
                        if role == "first"
                        else f"/api/{self._media_api_prefix()}/frames/{self.req.project_id}/{target.name}"
                    ),
                    "url": f"/api/{self._media_api_prefix()}/frames/{self.req.project_id}/{target.name}",
                    "hd_frame_ready": role == "first",
                })
            except (asyncio.TimeoutError, TimeoutError) as exc:
                if role == "first":
                    first_comfy_failed = True
                log.warning(
                    "comfyui_frame_timeout",
                    clip_id=clip.clip_id,
                    frame=role,
                    timeout=frame_timeout,
                    error=str(exc),
                )
            except Exception as exc:
                if role == "first":
                    first_comfy_failed = True
                log.warning(
                    "comfyui_frame_failed",
                    clip_id=clip.clip_id,
                    frame=role,
                    error=str(exc),
                )

        ff_path, lf_path = _resolved()
        if artifact_ok(ff_path):
            if not artifact_ok(lf_path):
                lf_path = ff_path
            clip.first_frame_path = str(ff_path)
            clip.last_frame_path = str(lf_path)
            return ff_path, lf_path, events

        # Recovery: file ComfyUI (proge_*, ecc.) presenti ma path canonico mancante
        recovered_ff = self._resolve_frame_file(clip, canon_ff)
        if recovered_ff and artifact_ok(recovered_ff):
            import shutil
            shutil.copy2(recovered_ff, canon_ff)
            clip.first_frame_path = str(canon_ff)
            if not clip.first_frame_comfy:
                clip.first_frame_comfy = recovered_ff.name
            events.append({
                "event": "frame_done",
                "clip_id": clip.clip_id,
                "frame": "first",
                "path": str(canon_ff),
                "filename": canon_ff.name,
                "frame_url": f"/api/{self._media_api_prefix()}/frames-clip/{self.req.project_id}/{clip.clip_id}",
                "url": f"/api/{self._media_api_prefix()}/frames/{self.req.project_id}/{canon_ff.name}",
                "recovered": True,
                "hd_frame_ready": True,
            })
            ff_path, lf_path = _resolved()
            if artifact_ok(ff_path):
                if not artifact_ok(lf_path):
                    lf_path = ff_path
                    clip.last_frame_path = str(lf_path)
                return ff_path, lf_path, events

        if self.req.allow_ffmpeg_fallback:
            await self._gen_placeholder_frame(ff_path, clip, "first")
            if not artifact_ok(lf_path):
                if artifact_ok(ff_path):
                    import shutil
                    shutil.copy2(ff_path, lf_path)
                else:
                    await self._gen_placeholder_frame(lf_path, clip, "last")
            clip.first_frame_path = str(ff_path)
            clip.last_frame_path = str(lf_path)
            self._use_ffmpeg_clips = True
            events.append({
                "event": "frame_placeholder",
                "clip_id": clip.clip_id,
                "path": str(ff_path),
            })
            events.append({
                "event": "frame_done",
                "clip_id": clip.clip_id,
                "frame": "first",
                "path": str(ff_path),
                "url": f"/api/{self._media_api_prefix()}/frames/{self.req.project_id}/{ff_path.name}",
                "placeholder": True,
            })
            return ff_path, lf_path, events

        raise RuntimeError(
            f"Impossibile generare frame per {clip.clip_id}: ComfyUI non disponibile "
            "e fallback FFmpeg disabilitato."
        )

    async def _gen_placeholder_frame(
        self, dest: Path, clip: TrailerClip, role: str,
    ) -> None:
        """Frame sintetico (gradiente) quando ComfyUI non produce output."""
        if self._storyboard_dir in dest.parents or dest.parent == self._storyboard_dir:
            w, h = self._storyboard_dimensions()
        else:
            w, h = self._hd_dimensions()
        # Evita '%' in lavfi (Windows/cmd interpreta male hsl con saturazione %)
        hue = (clip.clip_index * 41 + (18 if role == "last" else 0)) % 360
        sat = 0.25 + (clip.clip_index % 5) * 0.08
        r, g, b = colorsys.hls_to_rgb(hue / 360.0, 0.12, sat)
        hex_c = (
            f"#{int(r * 255):02x}{int(g * 255):02x}{int(b * 255):02x}"
        )
        rc, err = await _run_ffmpeg(
            "-y",
            "-f", "lavfi",
            "-i", f"color=c={hex_c}:s={w}x{h}:d=1",
            "-frames:v", "1",
            "-update", "1",
            str(dest),
        )
        if rc != 0 or not dest.exists():
            raise RuntimeError(
                f"Placeholder frame failed for {clip.clip_id}/{role}: {err[-300:]}"
            )

    async def _run_comfy_live(
        self,
        wf: dict,
        *,
        client=None,
        timeout: int = 300,
        start: float = 0.08,
        end: float = 0.92,
        label: str = "ComfyUI",
        clip_id: str = "",
        kind: str = "frame",
        emit=None,
    ):
        extra = {"clip_id": clip_id, "kind": kind}
        q, progress_cb = bind_comfy_progress_queue(
            start=start, end=end, label=label,
            event="clip_comfyui_progress", extra=extra,
        )
        if client is not None:
            task = asyncio.create_task(
                self._pool.run_workflow_on(client, wf, timeout=timeout, progress_cb=progress_cb)
            )
        else:
            task = asyncio.create_task(
                self._pool.run_with_fallback(wf, timeout=timeout, progress_cb=progress_cb)
            )
        async for ev in iter_progress_while(task, q):
            if emit:
                await emit(ev)
        if client is not None:
            hist, prompt_id = await task
            return ComfyUIRunResult(history=hist, client=client, prompt_id=prompt_id)
        return await task

    async def _gen_frame(
        self,
        prompt_text: str,
        dest: Path,
        *,
        clip_id: str = "",
        role: str = "first",
        negative_prompt: str = "",
        emit=None,
    ) -> str:
        """Genera frame su ComfyUI; scarica localmente e restituisce il filename server."""
        from src.core.utils.comfyui_outputs import download_comfyui_image_resilient

        clip_stub = next((c for c in self._clips_list if c.clip_id == clip_id), None)
        if clip_stub:
            frame = self._comfy_frame_prompt(clip_stub, role=role)
        else:
            from src.core.llm.generation_prompt_sanitize import (
                CINEMATIC_NEGATIVE_PROMPT,
                ensure_detailed_frame_prompt,
                sanitize_generation_prompt,
            )
            frame = FramePrompt(
                prompt=ensure_detailed_frame_prompt(
                    prompt_text, scene_prompt=prompt_text, style=self.req.style, role=role,
                ),
                negative_prompt=sanitize_generation_prompt(
                    negative_prompt, fallback=CINEMATIC_NEGATIVE_PROMPT, min_len=16, max_len=400,
                ) or CINEMATIC_NEGATIVE_PROMPT,
                seed=random.randint(0, 2 ** 32),
            )
        output_prefix = dest.stem
        hd_w, hd_h = self._hd_dimensions()
        wf = build_txt2img_workflow(
            frame,
            output_prefix=output_prefix,
            width=hd_w,
            height=hd_h,
            steps=max(4, min(50, int(getattr(self.req, "hd_frame_steps", None) or 25))),
            workflow_id=self.req.txt2img_workflow,
            model_overrides=getattr(self.req, "model_overrides", None),
        )
        run = await self._run_comfy_live(
            wf, timeout=300, label=f"Frame {role}",
            clip_id=clip_id, kind="frame", emit=emit,
        )
        try:
            download_dest = await download_comfyui_image_resilient(
                run.client,
                run.history,
                output_prefix=output_prefix,
                dest=dest,
                prompt_id=run.prompt_id or "",
            )
        except Exception as exc:
            log.error(
                "gen_frame_no_output",
                clip_id=clip_id,
                role=role,
                prefix=output_prefix,
                error=str(exc),
            )
            raise RuntimeError(f"No frame output from ComfyUI for: {prompt_text[:60]}") from exc
        remote_name = download_dest.name
        log.info(
            "gen_frame_saved",
            clip_id=clip_id,
            role=role,
            dest=str(download_dest),
            size=download_dest.stat().st_size,
        )
        if clip_stub:
            self._canonicalize_downloaded_frame(
                clip_stub, dest, download_dest, role=role, comfy_filename=remote_name,
            )
        else:
            import shutil
            if download_dest.resolve() != dest.resolve():
                shutil.copy2(download_dest, dest)
        return remote_name or dest.name

    async def _resolve_comfyui_upload(self, client, comfy_name: Optional[str], local_path: Path) -> str:
        """Preferisce upload da file locale; altrimenti filename già su ComfyUI (RunPod)."""
        path = local_path
        if not path.exists() or path.stat().st_size < 500:
            alt = path.parent / (comfy_name or "")
            if alt.is_file():
                path = alt
        if path.exists() and await client.supports_upload():
            up = await self._compress_frame_for_upload(path)
            return await client.upload_image(up)
        if comfy_name:
            return comfy_name
        raise RuntimeError(
            "Proxy ComfyUI senza /upload/image e frame non su disco: "
            f"{local_path.name}"
        )

    async def _compress_frame_for_upload(self, path: Path, max_bytes: int = 1_800_000) -> Path:
        if not path.exists() or path.stat().st_size <= max_bytes:
            return path
        out = path.with_suffix(".upload.jpg")
        rc, _ = await _run_ffmpeg("-y", "-i", str(path), "-q:v", "3", "-frames:v", "1", str(out))
        if rc == 0 and out.exists() and out.stat().st_size < path.stat().st_size:
            return out
        return path

    async def _gen_video_ffmpeg(
        self,
        clip: TrailerClip,
        ff_path: Path,
        lf_path: Path,
        dest: Path,
    ) -> None:
        """Ken Burns / crossfade tra first e last frame quando ComfyUI img2video non è disponibile."""
        dur = max(1.0, min(clip.duration_sec, self.req.max_clip_sec))
        w, h = self.req.width, self.req.height
        scale = (
            f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
            f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2"
        )
        half = dur / 2.0
        xfade_off = max(0.1, half - 0.35)
        if ff_path.resolve() == lf_path.resolve():
            rc, err = await _run_ffmpeg(
                "-y", "-loop", "1", "-i", str(ff_path),
                "-vf", f"{scale},format=yuv420p",
                "-t", str(dur), "-r", str(self.req.fps),
                "-c:v", "libx264", "-preset", "fast", "-crf", "23",
                str(dest),
            )
        else:
            fc = (
                f"[0:v]{scale},format=yuv420p,setpts=PTS-STARTPTS[v0];"
                f"[1:v]{scale},format=yuv420p,setpts=PTS-STARTPTS[v1];"
                f"[v0][v1]xfade=transition=fade:duration=0.35:offset={xfade_off:.3f}[v]"
            )
            rc, err = await _run_ffmpeg(
                "-y",
                "-loop", "1", "-t", str(half), "-i", str(ff_path),
                "-loop", "1", "-t", str(half), "-i", str(lf_path),
                "-filter_complex", fc,
                "-map", "[v]", "-r", str(self.req.fps),
                "-c:v", "libx264", "-preset", "fast", "-crf", "23",
                str(dest),
            )
        if rc != 0:
            raise RuntimeError(f"FFmpeg clip failed for {clip.clip_id}: {err[-400:]}")

    async def _gen_video(
        self,
        clip: TrailerClip,
        ff_path: Path,
        lf_path: Path,
        dest: Path,
        emit=None,
    ) -> None:
        client = await self._pool.get_client()
        ff_disk = self._resolve_frame_file(clip, ff_path) or ff_path
        lf_disk = self._resolve_frame_file(clip, lf_path) or lf_path
        ff_name = await self._resolve_comfyui_upload(client, clip.first_frame_comfy, ff_disk)
        lf_name = await self._resolve_comfyui_upload(client, clip.last_frame_comfy, lf_disk)

        # RunPod proxy non espone /upload/image — audio muxato in fase assembly
        audio_filename: Optional[str] = None
        if clip.audio_slice_path and await client.supports_upload():
            audio_p = Path(clip.audio_slice_path)
            if audio_p.exists():
                try:
                    audio_filename = await client.upload_input_file(
                        audio_p, mime="audio/wav"
                    )
                except Exception as exc:
                    log.warning("clip_audio_upload_failed", clip_id=clip.clip_id, error=str(exc))

        class _ClipShot:
            def __init__(self, c: TrailerClip) -> None:
                self.shot_id = c.clip_id
                self.motion_prompt = c.ltx_video_prompt or c.motion_prompt
                self.ltx_video_prompt = c.ltx_video_prompt
                self.first_frame = FramePrompt(prompt=c.first_frame_prompt)
                self.last_frame = FramePrompt(prompt=c.last_frame_prompt)

        video_wf_id = self.req.img2video_workflow
        use_audio_track = bool(audio_filename)
        if not use_audio_track and video_wf_id == "ltx_img_audio2video":
            video_wf_id = "ltx_img2video"

        wf = build_img2video_workflow(
            _ClipShot(clip),
            ff_name,
            lf_name,
            output_prefix=dest.stem,
            audio_filename=audio_filename,
            width=self.req.width,
            height=self.req.height,
            duration_sec=min(clip.duration_sec, self.req.max_clip_sec),
            fps=self.req.fps,
            workflow_id=video_wf_id,
            use_audio_track=use_audio_track,
            model_overrides=getattr(self.req, "model_overrides", None),
        )
        video_timeout = max(600, int(min(clip.duration_sec, self.req.max_clip_sec) * 90))
        if emit:
            await emit({
                "event": "progress",
                "msg": f"Generazione clip video — {clip.clip_id}",
                "clip_id": clip.clip_id,
                "clip_phase": "video_gen",
            })
        run = await self._run_comfy_live(
            wf, client=client, timeout=video_timeout,
            label="Video LTX", clip_id=clip.clip_id, kind="video", emit=emit,
        )
        files = extract_output_files(run.history)
        if not files:
            log.error("gen_video_no_output", clip_id=clip.clip_id, history=str(run.history)[:300])
            raise RuntimeError(f"No video output from ComfyUI for clip {clip.clip_id}")

        from src.core.utils.comfyui_outputs import download_comfyui_file, pick_best_video_output

        best_video = pick_best_video_output(files)
        fname = best_video["filename"]
        ext = Path(fname).suffix or ".mp4"
        tmp_dest = dest.with_suffix(ext)
        log.info("gen_video_downloading", clip_id=clip.clip_id, filename=fname, dest=str(tmp_dest))
        await download_comfyui_file(
            client,
            best_video,
            tmp_dest,
            expect="video",
            download_retries=4,
            min_image_bytes=None,
        )
        if tmp_dest.exists() and tmp_dest.resolve() != dest.resolve():
            tmp_dest.rename(dest)
        if not dest.exists():
            raise RuntimeError(
                f"Video clip non salvato su disco dopo download: {dest} "
                f"(source: {fname})"
            )
        log.info("gen_video_saved", clip_id=clip.clip_id, dest=str(dest), size=dest.stat().st_size)

    # ── Phase 7: Video Assembler ──────────────────────────────────────────────

    async def _phase7_video_assembler(self) -> AsyncGenerator[dict, None]:
        yield {"event": "phase", "phase": "assembly", "pct": 0.88}

        good_clips = [
            c for c in self._clips_list
            if c.clip_path and Path(c.clip_path).exists()
        ]
        if not good_clips:
            failed = [
                c.clip_id for c in self._clips_list
                if not c.clip_path or not Path(c.clip_path).exists()
            ]
            # Ultimo tentativo: frame su disco → clip FFmpeg
            if self.req.allow_ffmpeg_fallback:
                recovered = 0
                for clip in self._clips_list:
                    ff_path = self._frames_dir / f"{clip.clip_id}_first.png"
                    lf_path = self._frames_dir / f"{clip.clip_id}_last.png"
                    if not ff_path.exists() or ff_path.stat().st_size < 4096:
                        continue
                    if not lf_path.exists() or lf_path.stat().st_size < 4096:
                        lf_path = ff_path
                    clip_dest = self._clips_dir / f"{clip.clip_id}.mp4"
                    try:
                        await self._gen_video_ffmpeg(clip, ff_path, lf_path, clip_dest)
                        clip.clip_path = str(clip_dest)
                        good_clips.append(clip)
                        recovered += 1
                        yield {
                            "event": "clip_done",
                            "clip_id": clip.clip_id,
                            "path": str(clip_dest),
                            "backend": "ffmpeg",
                            "url": f"/api/trailer/clips/{self.req.project_id}/{clip_dest.name}",
                        }
                    except Exception as exc:
                        log.warning(
                            "assembly_recovery_clip_failed",
                            clip_id=clip.clip_id,
                            error=str(exc),
                        )
                if good_clips:
                    log.info("assembly_recovered_clips", count=recovered)

        if not good_clips:
            failed = [
                c.clip_id for c in self._clips_list
                if not c.clip_path or not Path(c.clip_path).exists()
            ]
            hint = (
                " Abilita «Fallback FFmpeg» o avvia ComfyUI locale su :8188 "
                "(il proxy RunPod spesso non esegue workflow LTX)."
                if self.req.clip_backend == "comfyui" and not self.req.allow_ffmpeg_fallback
                else " Verifica nodi ComfyUI in Servizi → Nodi o riprova con backend Auto."
            )
            raise RuntimeError(
                f"Nessuna clip generata ({len(failed)} fallite).{hint}"
            )

        concat_file = self._clips_dir / f"concat_{self.job_id}.txt"
        concat_file.write_text(
            "\n".join(f"file '{Path(c.clip_path).as_posix()}'" for c in good_clips),
            encoding="utf-8",
        )

        output_path = self._final_dir / f"trailer_{self.job_id}.mp4"

        ffmpeg_args: list = [
            "-y",
            "-f", "concat", "-safe", "0", "-i", str(concat_file),
        ]
        has_audio = (
            self._trailer_audio_path is not None
            and self._trailer_audio_path.exists()
        )
        if has_audio:
            ffmpeg_args += ["-i", str(self._trailer_audio_path)]

        ffmpeg_args += ["-c:v", "libx264", "-preset", "fast", "-crf", "23"]
        if has_audio:
            ffmpeg_args += ["-c:a", "aac", "-b:a", "128k"]

        scale_filter = (
            f"scale={self.req.width}:{self.req.height}"
            ":force_original_aspect_ratio=decrease,"
            f"pad={self.req.width}:{self.req.height}:(ow-iw)/2:(oh-ih)/2"
        )
        ffmpeg_args += [
            "-vf", scale_filter,
            "-r", str(self.req.fps),
            "-shortest",
            str(output_path),
        ]

        yield {"event": "assembly_start", "clips": len(good_clips), "pct": 0.90}
        rc, err = await _run_ffmpeg(*ffmpeg_args)
        if rc != 0:
            raise RuntimeError(f"FFmpeg assembly failed: {err[-500:]}")

        final_dur = await self._probe_duration(output_path)

        _fire_register(register_media(
            output_path, "video",
            self.req.project_id, "Trailer",
            source="trailer",
            tags=["trailer", self.req.aspect_ratio, f"{self.req.width}x{self.req.height}"],
        ))

        size_bytes = output_path.stat().st_size if output_path.exists() else 0
        good_count = len([c for c in self._clips_list if c.clip_path])
        self._last_result = {
            "video_path":   str(output_path),
            "video_url":    f"/api/trailer/output/{self.req.project_id}/{output_path.name}",
            "filename":     output_path.name,
            "duration_sec": final_dur,
            "width":        self.req.width,
            "height":       self.req.height,
            "fps":          self.req.fps,
            "clip_count":   good_count,
            "size_bytes":   size_bytes,
            "trailer_audio_path": str(self._trailer_audio_path) if self._trailer_audio_path else None,
            "source_audio_path":  self.req.audio_path,
        }
        yield {
            "done": True,
            "video_path": str(output_path),
            "video_url": f"/api/trailer/output/{self.req.project_id}/{output_path.name}",
            "filename": output_path.name,
            "project_id": self.req.project_id,
            "duration_sec": final_dur,
            "width": self.req.width,
            "height": self.req.height,
            "fps": self.req.fps,
            "clip_count": good_count,
            "size_bytes": size_bytes,
            "trailer_audio_path": str(self._trailer_audio_path) if self._trailer_audio_path else None,
            "source_audio_path": self.req.audio_path,
            "pct": 1.0,
        }

    async def _probe_duration(self, path: Path) -> float:
        import subprocess
        loop = asyncio.get_event_loop()

        def _run():
            result = subprocess.run(
                ["ffprobe", "-v", "quiet", "-print_format", "json",
                 "-show_format", str(path)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            return result.stdout

        try:
            out = await loop.run_in_executor(None, _run)
            data = json.loads(out)
            return float(data.get("format", {}).get("duration", 0))
        except Exception:
            return 0.0
