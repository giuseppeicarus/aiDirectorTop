"""Audio analysis — demucs opt-in flag."""

from src.core.workflow.trailer_pipeline import audio_use_demucs_enabled


def test_audio_use_demucs_default_off(monkeypatch):
    monkeypatch.delenv("CINEMATIC_AUDIO_USE_DEMUCS", raising=False)
    assert audio_use_demucs_enabled() is False


def test_audio_use_demucs_env_on(monkeypatch):
    monkeypatch.setenv("CINEMATIC_AUDIO_USE_DEMUCS", "1")
    assert audio_use_demucs_enabled() is True
