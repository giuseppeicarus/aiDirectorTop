"""Analisi audio per CreateReel — finestra [start, start+duration] + timing lirica manuale."""

from __future__ import annotations

from pathlib import Path
from typing import List, Optional, Tuple

from src.core.utils.lyric_analyzer import compute_lyric_timing


async def trim_audio_window(
    src: Path,
    dst: Path,
    start_sec: float,
    duration_sec: float,
) -> None:
    from src.core.workflow.trailer_pipeline import _run_ffmpeg

    dst.parent.mkdir(parents=True, exist_ok=True)
    rc, err = await _run_ffmpeg(
        "-y",
        "-ss", f"{max(0.0, start_sec):.3f}",
        "-t", f"{max(0.5, duration_sec):.3f}",
        "-i", str(src),
        "-ar", "44100",
        "-ac", "2",
        str(dst),
    )
    if rc != 0:
        raise RuntimeError(f"ffmpeg trim failed: {err[-300:]}")


def sections_to_lyric_dicts(sections: list) -> list[dict]:
    out: list[dict] = []
    for s in sections:
        if hasattr(s, "model_dump"):
            d = s.model_dump()
        else:
            d = dict(s)
        em = {
            "low": "melancholic",
            "medium": "reflective",
            "high": "energetic",
            "peak": "epic",
        }.get(d.get("energy", "medium"), "cinematic")
        out.append({
            "start_sec": d.get("start_sec", 0),
            "end_sec": d.get("end_sec", 0),
            "energy": d.get("energy", "medium"),
            "emotion": em,
        })
    return out


def compute_lyric_beats_for_sections(
    lyrics: str,
    sections: list,
    duration_sec: float,
) -> List[dict]:
    if not (lyrics or "").strip():
        return []
    return compute_lyric_timing(
        lyrics.strip(),
        sections_to_lyric_dicts(sections),
        duration_sec,
    )


async def analyze_reel_audio_window(
    audio_path: Path,
    *,
    start_sec: float,
    duration_sec: float,
    work_dir: Path,
    lyrics: Optional[str] = None,
) -> Tuple[list, list, float, List[dict]]:
    """
    Analizza solo la finestra reel sulla traccia sorgente.
    Returns: (sections, downbeats, duration_sec, lyric_beats)
    """
    import asyncio
    from src.core.workflow.trailer_pipeline import TrailerPipeline, TrailerRequest

    window = work_dir / "_analysis_window.wav"
    await trim_audio_window(audio_path, window, start_sec, duration_sec)

    pipeline = TrailerPipeline(
        TrailerRequest(project_id="__reel_analyze__", audio_path=str(window)),
    )
    loop = asyncio.get_event_loop()
    sections, downbeats, _file_dur = await loop.run_in_executor(
        None, pipeline._analyze_audio_sync, window,
    )
    target = float(duration_sec)
    lyric_beats = compute_lyric_beats_for_sections(lyrics or "", sections, target)
    return sections, downbeats, target, lyric_beats
