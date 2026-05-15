"""
Tests pipeline — verifica modelli dati, PipelineProgress, e routing corretto.
Non esegue workflow reali (richiede ComfyUI + LLM live).
"""

import pytest
from src.core.models.cinematic import (
    ProjectInput, StoryAnalysis, StoryArc, CinematicShot,
    CameraConfig, LightingConfig, FramePrompt, AudioAnalysis, AudioSection,
    ContinuityReport, CharacterDef, Sequence, Scene, ShotPlaceholder,
)
from src.core.workflow.pipeline import PipelineProgress, STAGE_WEIGHTS


# ── ProjectInput ──────────────────────────────────────────────────────────────

def test_project_input_defaults():
    inp = ProjectInput(title="Test Film", story_brief="A story about hope")
    assert inp.genre == "cinematic"
    assert inp.runtime_target_sec == 60
    assert inp.aspect_ratio == "16:9"
    assert inp.characters == []


def test_project_input_with_audio():
    audio = AudioAnalysis(
        bpm=120.0,
        sections=[
            AudioSection(start_sec=0, end_sec=30, energy="high", emotion="epic")
        ],
    )
    inp = ProjectInput(
        title="Music Video",
        story_brief="Epic journey",
        genre="music_video",
        audio_analysis=audio,
        lyrics="Rise up, rise up...",
    )
    assert inp.audio_analysis.bpm == 120.0
    assert len(inp.audio_analysis.sections) == 1


def test_character_def():
    char = CharacterDef(
        name="Elena",
        description="Tall woman with red hair, 30s",
        wardrobe="Navy peacoat, white scarf",
        personality="Determined, quiet strength",
        visual_anchor="silver ring left index finger",
    )
    assert char.visual_anchor == "silver ring left index finger"


# ── StoryAnalysis ─────────────────────────────────────────────────────────────

def test_story_analysis_model():
    sa = StoryAnalysis(
        themes=["isolation", "redemption"],
        visual_metaphors=["broken mirror", "empty street"],
        emotion_progression=[{"time_sec": 0, "emotion": "melancholy", "intensity": 0.7}],
        pacing_notes="Slow burn, accelerates in third act",
        suggested_motifs=["rain", "reflections"],
        color_mood="desaturated blues and greys",
        narrative_summary="A woman rebuilds herself after loss",
    )
    assert "isolation" in sa.themes
    assert sa.color_mood.startswith("desaturated")


# ── StoryArc ──────────────────────────────────────────────────────────────────

def test_story_arc_model():
    arc = StoryArc(
        title="The Long Road",
        logline="A grieving musician finds redemption through her final recording.",
        visual_motifs=["rain", "empty concert halls", "vintage vinyl"],
        color_palette=["#1a1a2e", "#16213e", "#e94560"],
        sequences=[
            Sequence(
                id="seq_001",
                title="Arrival",
                narrative_role="intro",
                emotion_arc="despair → curiosity",
                duration_sec=20.0,
                scenes=[
                    Scene(
                        id="scene_001",
                        title="Empty Studio",
                        location="Recording studio, downtown",
                        time_of_day="night",
                        mood="melancholic",
                        trigger="lyric",
                        duration_sec=10.0,
                        shots=[ShotPlaceholder(shot_id="shot_001_001", duration_sec=4.0, emotional_intent="desolation")],
                    )
                ],
            )
        ],
    )
    assert len(arc.sequences) == 1
    assert arc.sequences[0].narrative_role == "intro"


# ── CinematicShot ─────────────────────────────────────────────────────────────

def test_cinematic_shot_model():
    shot = CinematicShot(
        shot_id="shot_001_001",
        sequence_id="seq_001",
        scene_id="scene_001",
        time_start="00:00",
        time_end="00:04",
        duration_sec=4.0,
        scene_description="A lone figure walks through rain-soaked streets",
        location="Downtown alley, night",
        camera=CameraConfig(shot_type="wide", movement="dolly_in", lens_mm=35),
        lighting=LightingConfig(time_of_day="night", mood="cold"),
        emotion="solitude",
        first_frame=FramePrompt(
            prompt="Lone figure walking away, rain-soaked alley, night, streetlights reflecting on wet pavement, 35mm, cinematic"
        ),
    )
    assert shot.shot_id == "shot_001_001"
    assert shot.camera.lens_mm == 35
    assert shot.status == "pending"


def test_frame_prompt_defaults():
    fp = FramePrompt(prompt="A beautiful sunset over the ocean, cinematic, wide shot")
    assert fp.cfg_scale == 7.0
    assert fp.steps == 30
    assert "bad anatomy" in fp.negative_prompt


# ── PipelineProgress ──────────────────────────────────────────────────────────

def test_pipeline_progress_to_dict():
    p = PipelineProgress(
        stage="story_analysis",
        stage_progress=0.5,
        message="Analisi in corso...",
    )
    d = p.to_dict()
    assert d["stage"] == "story_analysis"
    assert 0.0 < d["total_progress"] < 1.0
    assert d["message"] == "Analisi in corso..."


def test_pipeline_progress_stage_weights_sum_to_one():
    total = sum(STAGE_WEIGHTS.values())
    assert abs(total - 1.0) < 0.001


def test_pipeline_progress_total_increases_with_stage():
    stages = list(STAGE_WEIGHTS.keys())
    progresses = [
        PipelineProgress(s, 1.0, "done").total_progress
        for s in stages
    ]
    for i in range(1, len(progresses)):
        assert progresses[i] > progresses[i - 1]


# ── ContinuityReport ──────────────────────────────────────────────────────────

def test_continuity_report_approved():
    report = ContinuityReport(
        total_errors=0,
        critical_count=0,
        warning_count=0,
        approved=True,
    )
    assert report.approved is True
    assert report.errors == []
