"""
Modelli Pydantic per la pipeline cinematografica professionale.
Copertura completa: AudioAnalysis → StoryArc → CinematicShot → ContinuityReport
"""

from __future__ import annotations
from typing import List, Literal, Optional
from pydantic import BaseModel, ConfigDict


# ── Audio ─────────────────────────────────────────────────────────────────────

class AudioSection(BaseModel):
    model_config = ConfigDict(extra='ignore')
    start_sec: float
    end_sec: float
    energy: str = "medium"   # low|medium|high|peak
    emotion: str = ""
    bpm_local: Optional[float] = None


class AudioAnalysis(BaseModel):
    bpm: float
    key: Optional[str] = None
    sections: List[AudioSection] = []
    emotion_timeline: List[dict] = []   # [{time_sec, emotion, intensity}]


# ── Characters ────────────────────────────────────────────────────────────────

class CharacterDef(BaseModel):
    name: str
    description: str        # fisico dettagliato e specifico
    wardrobe: str           # abbigliamento INVARIABILE durante la produzione
    personality: str
    visual_anchor: str      # elemento distintivo: "silver ring left index finger"


# ── Project Input ─────────────────────────────────────────────────────────────

class ProjectInput(BaseModel):
    title: str
    story_brief: str
    lyrics: Optional[str] = None
    audio_analysis: Optional[AudioAnalysis] = None
    style_references: List[str] = []    # "noir", "wes anderson", "dogma 95"
    mood_references: List[str] = []     # "melancholic", "epic", "romantic"
    characters: List[CharacterDef] = []
    visual_references: List[str] = []   # URL o descrizioni di riferimenti visivi
    runtime_target_sec: int = 60
    aspect_ratio: str = "16:9"
    genre: str = "cinematic"            # music_video|short_film|commercial|cinematic


# ── LLM 1 Output: Story Analysis ─────────────────────────────────────────────

class StoryAnalysis(BaseModel):
    model_config = ConfigDict(extra='ignore')
    themes: List[str] = []
    visual_metaphors: List[str] = []
    emotion_progression: List[dict] = []
    pacing_notes: str = ""
    suggested_motifs: List[str] = []
    color_mood: str = ""
    narrative_summary: str = ""


# ── LLM 2 Output: Story Arc ──────────────────────────────────────────────────

class ShotPlaceholder(BaseModel):
    model_config = ConfigDict(extra='ignore')
    shot_id: str = ""
    duration_sec: float = 4.0
    emotional_intent: str = ""
    suggested_shot_type: Optional[str] = None


class Scene(BaseModel):
    model_config = ConfigDict(extra='ignore')
    id: str = ""
    title: str = ""
    location: str = ""
    time_of_day: str = "afternoon"
    mood: str = ""
    trigger: str = ""
    duration_sec: float = 10.0
    shots: List[ShotPlaceholder] = []


class Sequence(BaseModel):
    model_config = ConfigDict(extra='ignore')
    id: str = ""
    title: str = ""
    narrative_role: str = "buildup"   # intro|buildup|verse|chorus|bridge|climax|resolution|outro
    emotion_arc: str = ""
    duration_sec: float = 20.0
    audio_section_ref: Optional[str] = None
    scenes: List[Scene] = []


class StoryArc(BaseModel):
    model_config = ConfigDict(extra='ignore')
    title: str = ""
    logline: str = ""
    visual_motifs: List[str] = []
    color_palette: List[str] = []
    character_arcs: dict = {}
    sequences: List[Sequence] = []


# ── LLM 3 Output: Cinematic Shot ─────────────────────────────────────────────

class CameraConfig(BaseModel):
    model_config = ConfigDict(extra='ignore')
    shot_type: str = "medium"       # extreme_wide|wide|medium|close_up|drone|pov etc.
    movement: str = "static"        # static|dolly_in|dolly_out|pan|orbit|handheld etc.
    lens_mm: int = 35
    depth_of_field: str = "medium"  # shallow|medium|deep
    special: Optional[str] = None


class LightingConfig(BaseModel):
    model_config = ConfigDict(extra='ignore')
    time_of_day: str = "afternoon"  # dawn|golden_hour|midday|afternoon|dusk|night etc.
    mood: str = "warm"              # warm|cold|dramatic_contrast|soft_diffused etc.
    sources: List[str] = []


class MusicSync(BaseModel):
    bass: str = ""          # "camera pulse on bass hits"
    snare: str = ""         # "small cuts on snare"
    vocals: str = ""        # "slow camera drift follows vocal melody"
    beat_cuts: bool = False
    cut_frequency: Optional[str] = None  # "every 2 beats", "every bar"


class FramePrompt(BaseModel):
    model_config = ConfigDict(extra='ignore')
    prompt: str = ""
    negative_prompt: str = (
        "ugly, deformed, blurry, low quality, watermark, text, "
        "bad anatomy, extra limbs, cartoon, anime, CGI, artificial"
    )
    seed: Optional[int] = None
    cfg_scale: float = 7.0
    steps: int = 30
    image_path: Optional[str] = None


class CinematicShot(BaseModel):
    model_config = ConfigDict(extra='ignore')
    shot_id: str = ""
    sequence_id: str = ""
    scene_id: str = ""
    time_start: str = "00:00"
    time_end: str = "00:04"
    duration_sec: float = 4.0
    lyrics_segment: Optional[str] = None
    scene_description: str = ""
    location: str = ""
    characters: List[dict] = []
    camera: CameraConfig = CameraConfig()
    lighting: LightingConfig = LightingConfig()
    transition_in: str = "hard_cut"
    transition_out: str = "hard_cut"
    emotion: str = ""
    music_sync: MusicSync = MusicSync()
    continuity_notes: List[str] = []
    first_frame: Optional[FramePrompt] = None
    last_frame: Optional[FramePrompt] = None
    motion_prompt: str = ""
    comfyui_workflow: str = "img2video_wan21"
    clip_path: Optional[str] = None
    status: str = "pending"
    error: Optional[str] = None


# ── LLM 5 Output: Continuity Report ──────────────────────────────────────────

class ContinuityError(BaseModel):
    model_config = ConfigDict(extra='ignore')
    shot_ids: List[str] = []
    error_type: str = "narrative"       # character|lighting|location|narrative|camera|transition|prompt
    description: str = ""
    severity: str = "warning"           # critical|warning|suggestion
    correction: str = ""


class ContinuityReport(BaseModel):
    model_config = ConfigDict(extra='ignore')
    total_errors: int = 0
    critical_count: int = 0
    warning_count: int = 0
    errors: List[ContinuityError] = []
    approved: bool = True
    corrected_shots: List[str] = []


# ── Shot Memory (continuity injection) ───────────────────────────────────────

class ShotMemory(BaseModel):
    """Memoria dello shot precedente, iniettata nel prompt dello shot successivo."""
    shot_id: str
    character_states: dict = {}         # {char_name: {position, expression, wardrobe_note}}
    location_state: dict = {}           # {background_elements, lighting_direction, weather}
    camera_state: dict = {}             # {last_shot_type, last_movement, last_lens}
    emotional_state: str = ""
    active_motifs: List[str] = []
    continuity_constraints: List[str] = []


# ── Complete Project Storyboard ───────────────────────────────────────────────

class CinematicProject(BaseModel):
    """Struttura completa del progetto cinematografico dopo la pipeline LLM."""
    project_id: str
    input: ProjectInput
    story_analysis: Optional[StoryAnalysis] = None
    story_arc: Optional[StoryArc] = None
    shot_list: List[CinematicShot] = []
    continuity_report: Optional[ContinuityReport] = None
    pipeline_stage: str = "pending"
