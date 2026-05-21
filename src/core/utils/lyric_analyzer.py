"""
Lyric timing analysis — distributes lyric lines across the audio timeline
using section energy data from librosa analysis.
"""

from __future__ import annotations
import math
from typing import List


def compute_lyric_timing(
    lyrics: str,
    sections: list,
    duration_sec: float,
) -> List[dict]:
    """
    Assign time positions to lyric lines using audio section data.

    Strategy:
    - Split lyrics into non-empty lines
    - Distribute lines proportionally across audio sections
    - High-energy sections get shorter lyric slots (faster delivery)
    - Returns list of {lyric_line, time_sec, end_sec, emotion, energy}
    """
    lines = [l.strip() for l in lyrics.splitlines() if l.strip()]
    if not lines or duration_sec <= 0:
        return []

    # Build time slots for each line by mapping sections → lines proportionally
    # Each section contributes a number of lines proportional to its duration
    n = len(lines)
    total_dur = duration_sec

    # Assign each section its share of lines by duration
    section_line_ranges: list[tuple[int, int, dict]] = []
    accumulated_lines = 0
    for sec in sections:
        sec_dur = sec["end_sec"] - sec["start_sec"]
        lines_in_section = max(1, round(n * sec_dur / total_dur))
        start_line = accumulated_lines
        end_line = min(n, accumulated_lines + lines_in_section)
        if start_line < end_line:
            section_line_ranges.append((start_line, end_line, sec))
            accumulated_lines = end_line
        if accumulated_lines >= n:
            break

    # Handle overflow: assign remaining lines to last section
    if accumulated_lines < n and section_line_ranges:
        sl, el, sec = section_line_ranges[-1]
        section_line_ranges[-1] = (sl, n, sec)

    # Convert to beat list
    beats: List[dict] = []
    for start_line, end_line, sec in section_line_ranges:
        sec_lines = lines[start_line:end_line]
        sec_dur = sec["end_sec"] - sec["start_sec"]
        slot = sec_dur / len(sec_lines) if sec_lines else sec_dur

        for i, line in enumerate(sec_lines):
            time_sec = sec["start_sec"] + i * slot
            end_s = min(sec["end_sec"], time_sec + slot)
            beats.append({
                "lyric_line": line,
                "time_sec": round(time_sec, 2),
                "end_sec": round(end_s, 2),
                "emotion": sec.get("emotion", "reflective"),
                "energy": sec.get("energy", "medium"),
                "suggested_visual": _suggest_visual(line, sec.get("energy", "medium")),
            })

    return beats


def _suggest_visual(line: str, energy: str) -> str:
    """Generate a brief visual suggestion based on lyric line and energy level."""
    energy_desc = {
        "low": "slow, intimate close-up",
        "medium": "medium shot, gentle movement",
        "high": "dynamic wide shot",
        "peak": "rapid cuts, extreme angles",
    }.get(energy, "medium shot")
    words = line[:50].strip()
    return f"{energy_desc} — {words}"


def assign_lyrics_to_shots(
    shots: list,
    lyric_beats: List[dict],
) -> list:
    """
    Post-process a shot list to assign lyrics_segment based on timing.

    Builds a cumulative timeline from shot durations, then matches each shot's
    time window to the lyric beats that fall within it.
    """
    if not lyric_beats:
        return shots

    # Build cumulative timeline
    cursor = 0.0
    shot_windows: list[tuple[float, float]] = []
    for shot in shots:
        dur = getattr(shot, "duration_sec", None) or 4.0
        shot_windows.append((cursor, cursor + dur))
        cursor += dur

    total_shot_duration = cursor

    # Rescale lyric beat times to match total shot duration
    lyric_dur = lyric_beats[-1]["end_sec"] if lyric_beats else 0
    scale = total_shot_duration / lyric_dur if lyric_dur > 0 else 1.0

    for shot, (t_start, t_end) in zip(shots, shot_windows):
        matching = []
        for beat in lyric_beats:
            beat_start = beat["time_sec"] * scale
            beat_end = beat["end_sec"] * scale
            # Include beat if it overlaps with shot window
            if beat_start < t_end and beat_end > t_start:
                matching.append(beat["lyric_line"])

        if matching:
            shot.lyrics_segment = " / ".join(matching)

    return shots


def analyze_audio_full(audio_path: str, lyrics: str | None = None) -> dict:
    """
    Full audio analysis using librosa.
    Returns a dict matching the AudioAnalysis + lyric_beats schema.
    """
    import numpy as np

    try:
        import librosa  # type: ignore
    except ImportError:
        return {"bpm": 120.0, "key": None, "sections": [], "emotion_timeline": [], "lyric_beats": []}

    # Load audio (max 10 min to avoid memory issues)
    y, sr = librosa.load(audio_path, sr=22050, mono=True, duration=600)
    duration = librosa.get_duration(y=y, sr=sr)

    # ── BPM ──────────────────────────────────────────────────────────────────
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr)
    bpm = round(float(np.atleast_1d(tempo)[0]), 1)
    beat_times = librosa.frames_to_time(beats, sr=sr).tolist()

    # ── Key ───────────────────────────────────────────────────────────────────
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    chroma_mean = np.mean(chroma, axis=1)
    key_idx = int(np.argmax(chroma_mean))
    keys = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    key = keys[key_idx]

    # ── Energy / RMS ──────────────────────────────────────────────────────────
    hop = 512
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    max_rms = float(np.max(rms)) or 1e-6

    # ── Sections (structural segmentation) ───────────────────────────────────
    # Target ~15s sections, using energy-based splitting
    target_sec = 15.0
    n_sections = max(2, int(math.ceil(duration / target_sec)))

    _ENERGY_THRESHOLDS = [
        (0.25, "low",    "melancholic"),
        (0.50, "medium", "reflective"),
        (0.75, "high",   "energetic"),
        (1.01, "peak",   "epic"),
    ]

    sections = []
    for i in range(n_sections):
        t0 = i * (duration / n_sections)
        t1 = min((i + 1) * (duration / n_sections), duration)
        f0 = int(t0 * sr / hop)
        f1 = min(int(t1 * sr / hop), len(rms))
        chunk_rms = float(np.mean(rms[f0:f1])) / max_rms if f1 > f0 else 0

        energy, emotion = "medium", "reflective"
        for threshold, e_label, em_label in _ENERGY_THRESHOLDS:
            if chunk_rms < threshold:
                energy, emotion = e_label, em_label
                break

        # Estimate local BPM for section
        y_chunk = y[int(t0 * sr): int(t1 * sr)]
        local_bpm = bpm
        if len(y_chunk) > sr:
            try:
                lt, _ = librosa.beat.beat_track(y=y_chunk, sr=sr)
                local_bpm = round(float(np.atleast_1d(lt)[0]), 1)
            except Exception:
                pass

        sections.append({
            "start_sec": round(t0, 2),
            "end_sec":   round(t1, 2),
            "energy":    energy,
            "emotion":   emotion,
            "bpm_local": local_bpm,
        })

    # ── Emotion timeline (2s resolution) ─────────────────────────────────────
    emotion_timeline = []
    step = 2
    for t in range(0, int(duration), step):
        f = int(t * sr / hop)
        r = float(rms[min(f, len(rms) - 1)]) / max_rms
        _, em = next(
            ((e, em) for thr, e, em in _ENERGY_THRESHOLDS if r < thr),
            ("peak", "epic"),
        )
        emotion_timeline.append({
            "time_sec":  t,
            "emotion":   em,
            "intensity": round(r, 3),
        })

    result: dict = {
        "bpm":            bpm,
        "key":            key,
        "duration_sec":   round(duration, 2),
        "sections":       sections,
        "emotion_timeline": emotion_timeline,
        "beat_times":     [round(b, 3) for b in beat_times[:300]],
        "lyric_beats":    [],
    }

    if lyrics:
        result["lyric_beats"] = compute_lyric_timing(lyrics, sections, duration)

    return result
