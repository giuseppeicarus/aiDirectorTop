"""Local Whisper transcription + torchaudio wav2vec2 forced alignment."""
from __future__ import annotations

from pathlib import Path
from typing import List, Optional


def transcribe_whisper(
    audio_path: str,
    model_size: str = "base",
    language: Optional[str] = None,
) -> dict:
    """Transcribe audio with word-level timestamps using local OpenAI Whisper.

    Returns {"language": str, "words": [{word, start, end}]}.
    Requires: pip install openai-whisper
    """
    try:
        import whisper
    except ImportError as e:
        raise RuntimeError("openai-whisper not installed. Run: pip install openai-whisper") from e

    model = whisper.load_model(model_size)
    kwargs: dict = {"word_timestamps": True}
    if language:
        kwargs["language"] = language

    result = model.transcribe(str(audio_path), **kwargs)

    words: List[dict] = []
    for seg in result.get("segments", []):
        for w in seg.get("words", []):
            words.append({
                "word": w["word"].strip(),
                "start": round(float(w["start"]), 3),
                "end": round(float(w["end"]), 3),
            })

    return {"language": result.get("language", ""), "words": words}


def forced_align_wav2vec2(audio_path: str, lyrics: str) -> List[dict]:
    """Align provided lyrics to audio using torchaudio wav2vec2 forced alignment.

    Returns [{word, start, end, score}] with second-level timestamps.
    Requires: torch + torchaudio (>=0.12)
    Only works well with English lyrics (WAV2VEC2_ASR_BASE_960H is English-only).
    """
    try:
        import torch
        import torchaudio
    except ImportError as e:
        raise RuntimeError("torch/torchaudio not installed") from e

    bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = bundle.get_model().to(device)
    labels = bundle.get_labels()
    label_dict = {c: i for i, c in enumerate(labels)}
    blank_id = label_dict.get("-", 0)

    waveform, sample_rate = torchaudio.load(str(audio_path))
    if sample_rate != bundle.sample_rate:
        waveform = torchaudio.functional.resample(waveform, sample_rate, bundle.sample_rate)
    if waveform.shape[0] > 1:
        waveform = waveform.mean(dim=0, keepdim=True)
    waveform = waveform.to(device)

    with torch.inference_mode():
        emissions, _ = model(waveform)
        emissions = torch.log_softmax(emissions, dim=-1)

    words = [w.upper() for w in lyrics.split() if w.strip()]
    if not words:
        return []

    tokenized: List[int] = []
    word_token_spans: List[tuple] = []
    for word in words:
        start = len(tokenized)
        for c in word:
            tok = label_dict.get(c)
            if tok is not None:
                tokenized.append(tok)
        word_token_spans.append((start, len(tokenized)))

    if not tokenized:
        return []

    targets = torch.tensor(tokenized, dtype=torch.int32).unsqueeze(0).to(device)

    try:
        aligned_tokens, scores = torchaudio.functional.forced_align(
            emissions, targets, blank=blank_id
        )
    except Exception:
        return []

    merged = torchaudio.functional.merge_tokens(aligned_tokens[0], scores[0], blank=blank_id)

    frame_duration = waveform.shape[1] / bundle.sample_rate / emissions.shape[1]

    result: List[dict] = []
    for orig_word, (tok_start, tok_end) in zip(words, word_token_spans):
        span_frames = [m for m in merged if tok_start <= m.token < tok_end]
        if not span_frames:
            continue
        t_start = span_frames[0].start * frame_duration
        t_end = (span_frames[-1].end + 1) * frame_duration
        avg_score = float(sum(m.score for m in span_frames) / len(span_frames))
        result.append({
            "word": orig_word.lower(),
            "start": round(t_start, 3),
            "end": round(t_end, 3),
            "score": round(avg_score, 4),
        })

    return result


def words_to_srt(
    words: List[dict],
    max_gap: float = 1.5,
    max_words_per_segment: int = 8,
) -> str:
    """Group word-level timestamps into SRT subtitle blocks."""
    if not words:
        return ""

    segments: List[List[dict]] = []
    current: List[dict] = [words[0]]

    for w in words[1:]:
        gap = w["start"] - current[-1]["end"]
        if gap > max_gap or len(current) >= max_words_per_segment:
            segments.append(current)
            current = [w]
        else:
            current.append(w)
    if current:
        segments.append(current)

    def _fmt(sec: float) -> str:
        h = int(sec // 3600)
        m = int((sec % 3600) // 60)
        s = int(sec % 60)
        ms = int(round((sec % 1) * 1000))
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

    lines = []
    for i, seg in enumerate(segments, 1):
        t_start = seg[0]["start"]
        t_end = seg[-1]["end"]
        text = " ".join(w["word"] for w in seg)
        lines.append(f"{i}\n{_fmt(t_start)} --> {_fmt(t_end)}\n{text}")

    return "\n\n".join(lines)
