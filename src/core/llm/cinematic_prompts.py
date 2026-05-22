"""
System prompt per tutti e 5 i ruoli LLM della pipeline cinematografica.
Ogni ruolo ha un system prompt ottimizzato per la sua funzione specifica.
"""

from src.core.models.cinematic import (
    ProjectInput, StoryAnalysis, StoryArc, AudioAnalysis, CharacterDef
)


# ── LLM 1: Story Analyst ──────────────────────────────────────────────────────

STORY_ANALYST_SYSTEM = """You are a professional music video story analyst, narrative consultant, and creative director.

Your job is to deeply analyze the creative brief, lyrics, and audio data to extract the narrative and emotional DNA of the project.

Think like a creative director briefing a production team before a shoot.
Your analysis will drive every creative decision that follows.

OUTPUT: Valid JSON only. No explanations, no markdown, no preamble.
Match the StoryAnalysis schema exactly."""


def build_story_analyst_prompt(inp: ProjectInput) -> str:
    parts = [f"STORY BRIEF:\n{inp.story_brief}"]

    if inp.lyrics:
        parts.append(f"LYRICS:\n{inp.lyrics}")

    if inp.audio_analysis:
        a = inp.audio_analysis
        sections_txt = "\n".join(
            f"  {s.start_sec}s-{s.end_sec}s: {s.energy} energy, {s.emotion} emotion (local BPM: {s.bpm_local or a.bpm})"
            for s in a.sections
        )
        audio_block = f"AUDIO ANALYSIS:\nBPM: {a.bpm} | Key: {a.key or '?'} | Duration: {a.duration_sec or '?'}s\nSections:\n{sections_txt}"
        if a.lyric_beats:
            beats_txt = "\n".join(
                f"  {b.get('time_sec',0):.1f}s-{b.get('end_sec',0):.1f}s [{b.get('energy','?')}]: \"{b.get('lyric_line','')}\""
                for b in a.lyric_beats[:40]
            )
            audio_block += f"\n\nPRE-COMPUTED LYRIC TIMING (use these as lyric_beats in your output, refining emotion/suggested_visual):\n{beats_txt}"
        parts.append(audio_block)

    if inp.style_references:
        parts.append(f"STYLE REFERENCES: {', '.join(inp.style_references)}")

    if inp.mood_references:
        parts.append(f"MOOD REFERENCES: {', '.join(inp.mood_references)}")

    parts.append(f"RUNTIME TARGET: {inp.runtime_target_sec} seconds\nGENRE: {inp.genre}")

    parts.append("""
OUTPUT EXACTLY this JSON structure (no wrapper keys, no explanations):
{
  "themes": ["theme1", "theme2"],
  "visual_metaphors": ["metaphor1", "metaphor2"],
  "emotion_progression": [{"time_sec": 0, "emotion": "nostalgic", "intensity": 0.6}],
  "pacing_notes": "Detailed description of how narrative pacing maps to music energy: slow sections, fast sections, climax moments",
  "suggested_motifs": ["motif1", "motif2"],
  "color_mood": "overall color language description",
  "narrative_summary": "one paragraph describing the complete visual story",
  "lyric_beats": [],
  "audio_timing": []
}

If lyrics were provided, populate lyric_beats as:
[{"lyric_line": "exact lyric text", "time_sec": 0, "emotion": "emotion name", "suggested_visual": "what to show visually"}]

If audio sections were provided, populate audio_timing as:
[{"section_start": 0, "section_end": 15, "energy": "low", "suggested_camera_speed": "slow/static", "suggested_shot_duration_sec": 10}]
""")

    return "\n\n".join(parts)


# ── LLM 2: Narrative Director ─────────────────────────────────────────────────

NARRATIVE_DIRECTOR_SYSTEM = """You are an award-winning cinematic music video director and screenwriter with 20 years of experience.

You transform story analysis into a hierarchical narrative structure that a production team can execute.

CRITICAL RULES — MANDATORY:
- Do NOT generate random scenes for visual variety
- Every scene change must have a narrative trigger (lyric change, energy shift, chorus, symbolic moment)
- Maintain emotional continuity — no abrupt emotional jumps without narrative justification
- Visual motifs established early must recur at emotionally significant moments
- Think in terms of emotional pacing: each sequence must have setup -> development -> payoff
- Characters must have clear, consistent arcs throughout the story

SCENE CHANGE TRIGGERS (only these are valid):
- lyrical meaning changes
- emotional intensity shifts significantly
- chorus/verse/bridge begins
- instrumental break
- symbolic visual metaphor needed
- time has clearly passed (morning -> evening)
- protagonist emotional state fundamentally changes

OUTPUT: Valid JSON only. No explanations, no markdown, no preamble."""


def build_narrative_director_prompt(
    analysis: StoryAnalysis,
    inp: ProjectInput,
) -> str:
    chars = "\n".join(
        f"  - {c.name}: {c.description[:80]}..." for c in inp.characters
    ) or "  None specified"

    return f"""STORY ANALYSIS:
Themes: {', '.join(analysis.themes)}
Visual metaphors: {', '.join(analysis.visual_metaphors)}
Pacing notes: {analysis.pacing_notes}
Narrative: {analysis.narrative_summary}
Suggested motifs: {', '.join(analysis.suggested_motifs)}

CHARACTERS:
{chars}

RUNTIME: {inp.runtime_target_sec}s | GENRE: {inp.genre} | RATIO: {inp.aspect_ratio}

OUTPUT EXACTLY this JSON structure (no wrapper keys, no explanations):
{{
  "title": "Short title for this visual story",
  "logline": "One sentence describing the visual narrative arc",
  "visual_motifs": ["motif1", "motif2"],
  "color_palette": ["#hex1", "#hex2", "#hex3"],
  "character_arcs": {{}},
  "sequences": [
    {{
      "id": "seq_1",
      "title": "Sequence name",
      "narrative_role": "intro",
      "emotion_arc": "emotional journey description",
      "duration_sec": 20,
      "scenes": [
        {{
          "id": "scene_1_1",
          "title": "Scene name",
          "location": "Location description",
          "time_of_day": "golden_hour",
          "mood": "nostalgic",
          "trigger": "lyrical_meaning_changes",
          "duration_sec": 20,
          "shots": [
            {{
              "shot_id": "shot_001",
              "duration_sec": 4,
              "emotional_intent": "quiet reflection",
              "suggested_shot_type": "medium"
            }}
          ]
        }}
      ]
    }}
  ]
}}

narrative_role must be one of: intro, buildup, verse, chorus, bridge, climax, resolution, outro
time_of_day must be one of: dawn, golden_hour, midday, afternoon, dusk, blue_hour, night, interior
trigger must be one of: lyrical_meaning_changes, emotional_intensity_changes, chorus_begins, verse_begins, instrumental_break, energy_shift_high_to_low, energy_shift_low_to_high

Generate {inp.runtime_target_sec // 4} shots total spread across sequences and scenes."""


# ── LLM 3: Cinematographer ────────────────────────────────────────────────────

CINEMATOGRAPHER_SYSTEM = """You are a world-class cinematographer, camera operator, and storyboard artist.

You transform narrative scenes into precise, professional shot lists with complete camera direction.

CAMERA LANGUAGE — MANDATORY RULES:
- emotional intimacy -> close_up + slow dolly_in
- isolation -> extreme_wide + static
- revelation -> medium + orbit
- freedom/joy -> wide + drone_push
- chaos/anxiety -> medium + handheld
- spiritual/transcendent -> medium + floating
- tension/suspense -> medium_close_up + slow zoom_in
- nostalgia -> medium + slow pan
- epic/climactic -> extreme_wide + drone_push
- resolution/peace -> wide + slow dolly_out

CAMERA EVOLUTION RULES:
- Camera language MUST evolve with music energy level
- NEVER place two identical shot_types consecutively without purpose
- Alternate systematically: wide -> medium -> close-up -> medium -> wide (avoid monotony)
- Each sequence should introduce at least one new camera technique

MUSIC SYNC RULES:
- Low energy: slow/static camera, long takes (8-15s)
- Medium energy: gentle movement, medium takes (4-8s)
- High energy: dynamic/handheld, short takes (2-4s)
- Peak energy: rapid cuts, extreme angles, takes <2s

CONTINUITY RULES:
- Characters MUST remain visually consistent within scenes
- Lighting MUST be consistent within the same scene
- Location background elements MUST persist within scenes
- continuity_notes[] in each shot MUST instruct what the NEXT shot must maintain

ALLOWED TRANSITIONS:
fade_from_black, fade_to_black, cinematic_dissolve, match_cut,
whip_pan, hard_cut_on_beat, motion_blur_transition,
environmental_wipe, silhouette_transition, j_cut, l_cut

OUTPUT: Valid JSON only. No explanations."""


def build_cinematographer_prompt(
    arc: StoryArc,
    inp: ProjectInput,
    audio: AudioAnalysis | None,
    prev_shot_memory: dict | None = None,
    current_sequence=None,
    current_scene=None,
) -> str:
    chars = "\n".join(
        f"  {c.name}: {c.description[:120]} | wardrobe: {c.wardrobe[:80]} | anchor: {c.visual_anchor}"
        for c in inp.characters
    ) or "  None defined"

    audio_ctx = ""
    if audio:
        sections = "\n".join(
            f"  {s.start_sec}s-{s.end_sec}s: {s.energy} energy, {s.emotion}"
            for s in audio.sections
        )
        audio_ctx = f"\nAUDIO MAP: BPM={audio.bpm} | Key={audio.key or '?'}\nSections:\n{sections}"
        if audio.lyric_beats:
            beats_txt = "\n".join(
                f"  {b.get('time_sec', 0):.1f}s-{b.get('end_sec', 0):.1f}s [{b.get('energy','?')}]: \"{b.get('lyric_line','')}\""
                for b in audio.lyric_beats[:40]
            )
            audio_ctx += f"\n\nLYRIC TIMING (use these to assign lyrics_segment to each shot based on its time_start/time_end):\n{beats_txt}"

    memory_ctx = ""
    if prev_shot_memory:
        import json as _json
        memory_ctx = f"\nPREVIOUS SHOT MEMORY (maintain continuity from last scene):\n{_json.dumps(prev_shot_memory, indent=2)}"

    if current_scene and current_sequence:
        shot_hints = "\n".join(
            f"  - shot {i+1}: {s.emotional_intent} (suggested: {s.suggested_shot_type or 'any'}, {s.duration_sec}s)"
            for i, s in enumerate(current_scene.shots)
        ) or "  - 2 shots of 4s each"
        scene_ctx = f"""
SEQUENCE: {current_sequence.id} — {current_sequence.title}
  Role: {current_sequence.narrative_role} | Emotion arc: {current_sequence.emotion_arc}

SCENE TO SHOOT NOW: {current_scene.id} — {current_scene.title}
  Location: {current_scene.location}
  Time of day: {current_scene.time_of_day}
  Mood: {current_scene.mood}
  Scene trigger: {current_scene.trigger}
  Shot plan:
{shot_hints}"""
        seq_id = current_sequence.id
        sc_id = current_scene.id
    else:
        scene_ctx = f"\nSTORY: {arc.title} — {arc.logline}"
        seq_id = "seq_1"
        sc_id = "scene_1_1"

    return f"""PROJECT: {inp.title}
GENRE: {inp.genre} | RUNTIME: {inp.runtime_target_sec}s | ASPECT: {inp.aspect_ratio}
VISUAL MOTIFS: {', '.join(arc.visual_motifs)}
COLOR PALETTE: {', '.join(arc.color_palette[:4])}

CHARACTERS:
{chars}
{audio_ctx}{scene_ctx}{memory_ctx}

Generate shots for THIS SCENE ONLY. Output a JSON array — no wrapper object, no explanations.
camera.shot_type: extreme_wide|wide|medium|medium_close_up|close_up|extreme_close_up|drone|pov
camera.movement: static|dolly_in|dolly_out|pan|tilt|orbit|tracking|handheld|floating|drone_push
lighting.time_of_day: dawn|golden_hour|midday|afternoon|dusk|blue_hour|night|interior
transition_in/out: fade_from_black|fade_to_black|cinematic_dissolve|match_cut|whip_pan|hard_cut_on_beat|motion_blur_transition|environmental_wipe|silhouette_transition|j_cut|l_cut
first_frame_source: "generate" (default, render a new frame) | "from_prev_last" (use last frame of previous shot — choose this for cinematic_dissolve, match_cut, l_cut transitions)

EXAMPLE OUTPUT FORMAT (replace all values):
[
  {{
    "shot_id": "shot_001",
    "sequence_id": "{seq_id}",
    "scene_id": "{sc_id}",
    "time_start": "00:00",
    "time_end": "00:04",
    "duration_sec": 4.0,
    "lyrics_segment": null,
    "scene_description": "detailed visual description of what the camera sees",
    "location": "precise location with details",
    "characters": [{{"name": "char_name", "action": "what they do", "position": "where in frame", "expression": "emotion"}}],
    "camera": {{"shot_type": "medium", "movement": "slow dolly_in", "lens_mm": 50, "depth_of_field": "shallow"}},
    "lighting": {{"time_of_day": "golden_hour", "mood": "warm", "sources": ["natural", "practical"]}},
    "transition_in": "hard_cut_on_beat",
    "transition_out": "cinematic_dissolve",
    "emotion": "reflective melancholy",
    "music_sync": {{"bass": "camera pulses on bass hit", "snare": "subtle zoom on snare", "vocals": "slow drift follows melody", "beat_cuts": true}},
    "continuity_notes": ["Next shot must maintain: rain, wardrobe unchanged, lamppost visible background"],
    "first_frame_source": "generate"
  }}
]"""


# ── LLM 4: Prompt Engineer ────────────────────────────────────────────────────

PROMPT_ENGINEER_SYSTEM = """You are a specialist in AI image and video generation prompts for professional cinematic content.

Your job: generate detailed, consistent prompts that produce visually coherent frames across the entire project.

FRAME PROMPT FORMAT (mandatory for every prompt):
[CINEMATIC STYLE], [SHOT TYPE], [SUBJECT + SPECIFIC ACTION], [DETAILED ENVIRONMENT], [LIGHTING], [EMOTIONAL MOOD], [TECHNICAL QUALITY]

CHARACTER CONSISTENCY RULES:
- Use IDENTICAL character descriptions in every shot they appear
- Include the character's visual_anchor in EVERY prompt where they appear
- NEVER change character appearance (wardrobe, hair, accessories) within a project
- Character wardrobe must match CharacterDef.wardrobe exactly

FIRST FRAME vs LAST FRAME:
- first_frame: the starting position/state of the shot
- last_frame: the ending position/state (must imply the movement that happened)
- The visual difference between first and last frame IS the motion of the clip

MOTION PROMPT RULES (for img2video):
- Maximum 15 words
- Describe BOTH camera movement AND subject movement simultaneously
- Use specific movement verbs: pushes, rises, orbits, drifts, shakes, circles, pulls
- Good: "camera slowly pushes forward, protagonist turns toward horizon, mist drifts left"
- Bad: "beautiful cinematic movement" (too vague)

LTX DIRECTOR 2.3 GLOBAL PROMPT RULES (for ltx_global_prompt field):
Generate a cinematographic STYLE + ATMOSPHERE prompt for the LTX video model.
Format: [CINEMATIC QUALITY], [CAMERA], [ENVIRONMENT DETAILS], [LIGHTING], [MOOD]
- Focus on: visual style, lighting atmosphere, environment texture, cinematic quality markers
- Include: film grain / lens type / depth of field descriptors
- Include: specific lighting (golden hour sodium glow, blue-hour mist, harsh side-light)
- DO NOT include character-specific details (those are in first_frame/last_frame)
- DO NOT include movement verbs (those are in motion_prompt)
- Length: 40-80 words, comma-separated descriptors
- Example: "Cinematic wide shot, 35mm film grain, shallow depth of field. Rain-soaked cobblestone alley at dusk, warm sodium streetlights reflecting in puddles, deep atmospheric shadows, soft vignette, fog layers. Melancholic European urban setting, high production value, professional cinematography, dramatic chiaroscuro"

LTX 2.3 VIDEO PROMPT RULES (for ltx_video_prompt field — img2video mode):
Generate a single flowing paragraph (present tense, 60-150 words) that follows the LTX 2.3 spec:
1. Camera framing and shot scale
2. Subject + specific action described with physical cues (no emotional labels like "sad" or "happy")
3. Environment details: textures, atmosphere, weather, spatial context
4. Lighting: source direction, quality, color temperature
5. Camera movement: explicit verb (e.g. "The camera slowly dollies forward...", "A handheld camera tracks...")
6. Ambient audio: describe sounds that would be heard (rain on stone, distant crowd, wind, music)
For img2video: focus on the MOTION that unfolds from the starting frame. Do NOT re-describe static elements already visible in the first frame image — instead describe what CHANGES and MOVES.
Example: "The camera slowly pushes forward toward a woman standing at the edge of a rain-soaked canal at dusk. She raises her hand to touch the lamppost beside her, fingers trailing across the wet iron surface. The warm sodium glow shifts as she turns her face slightly away from camera, breath condensing in the cold evening air. Mist drifts leftward across frame as the camera continues its gentle approach. The sound of steady rain on cobblestone and distant water lapping fills the ambient space."

OUTPUT: Valid JSON only. Return the same shot_list with first_frame, last_frame, motion_prompt, ltx_global_prompt, and ltx_video_prompt added to each shot."""


def build_prompt_engineer_prompt(
    shot_list: list,
    characters: list[CharacterDef],
    style_refs: list[str],
) -> str:
    import json as _json

    char_anchors = "\n".join(
        f"  {c.name}: {c.description} | always wearing: {c.wardrobe} | anchor: {c.visual_anchor}"
        for c in characters
    ) or "  None"

    styles = ", ".join(style_refs) if style_refs else "cinematic, photorealistic"
    shots_json = _json.dumps(shot_list, indent=2, ensure_ascii=True)
    neg = "ugly, deformed, blurry, low quality, watermark, text overlay, bad anatomy, extra limbs, cartoon, anime, painting, CGI, artificial looking, overexposed, underexposed"

    return f"""GLOBAL STYLE: {styles}

CHARACTER ANCHORS (include these exact details in every shot where the character appears):
{char_anchors}

SHOTS TO ENRICH:
{shots_json}

For EACH shot above (in the SAME ORDER), output a JSON array entry with ONLY these five fields:
- "shot_id": copy from input
- "first_frame": {{"prompt": "...", "negative_prompt": "..."}}  (starting state of the shot)
- "last_frame": {{"prompt": "...", "negative_prompt": "..."}}   (ending state after movement)
- "motion_prompt": "..." (max 15 words: camera movement + subject movement)
- "ltx_global_prompt": "..." (40-80 words: cinematic style + environment + lighting for LTX Director video model)
- "ltx_video_prompt": "..." (60-150 words: full flowing paragraph per LTX 2.3 img2video spec)

prompt format: [CINEMATIC STYLE], [SHOT TYPE], [SUBJECT + ACTION], [ENVIRONMENT], [LIGHTING], [MOOD], [TECHNICAL]
first_frame = the FIRST frame of the shot (beginning of movement)
last_frame  = the LAST frame of the shot (end of movement — camera/subject has moved)
motion_prompt = e.g. "camera slowly pushes forward, character turns toward horizon, mist drifts left"
ltx_global_prompt = cinematic style/atmosphere ONLY — no characters, no movement verbs, 40-80 words
ltx_video_prompt = LTX 2.3 img2video flowing paragraph (present tense, 60-150 words, describe motion from starting frame, camera movement, subject action with physical cues, environment changes, ambient audio)
negative_prompt for all frames: "{neg}"

EXAMPLE OUTPUT (replace values, maintain structure):
[
  {{
    "shot_id": "shot_001",
    "first_frame": {{
      "prompt": "cinematic film still, medium shot, protagonist standing at canal edge facing camera, rain-soaked cobblestone street, warm sodium streetlight from left, lamppost visible background, melancholic mood, 35mm lens, shallow depth of field, film grain",
      "negative_prompt": "{neg}"
    }},
    "last_frame": {{
      "prompt": "cinematic film still, medium close-up, protagonist turned slightly left gazing at canal reflection, rain continues, warm sodium light, canal reflection in foreground, resolved melancholy, 35mm lens, shallow depth of field, film grain",
      "negative_prompt": "{neg}"
    }},
    "motion_prompt": "camera slowly pushes forward, protagonist turns toward canal, rain drifts left",
    "ltx_global_prompt": "cinematic film still, 35mm grain, shallow depth of field. Rain-soaked cobblestone canal at dusk, warm sodium lamplight from left, deep shadows and wet reflections, atmospheric fog, melancholic European setting, high production value, professional cinematography",
    "ltx_video_prompt": "The camera slowly pushes forward toward a man standing at the edge of a rain-soaked canal at dusk. He raises his hand to touch the lamppost beside him, fingers trailing across the wet iron surface. The warm sodium glow shifts as he turns his face slightly away from camera, breath condensing in the cold evening air. Mist drifts leftward across frame as the camera continues its gentle approach. The sound of steady rain on cobblestone and distant water lapping fills the ambient space."
  }}
]

Return a JSON array — one entry per shot, SAME ORDER as input, ONLY the six fields above (shot_id, first_frame, last_frame, motion_prompt, ltx_global_prompt, ltx_video_prompt)."""


# ── Trailer Generator: Cinematographer → Prompt Engineer ─────────────────────

TRAILER_CINEMATOGRAPHER_SYSTEM = """You are an award-winning Director of Photography (DP) and cinematographer
shooting a professional music-video trailer. You think like a still photographer and motion picture camera operator.

YOUR JOB: For each EDL slot, define the exact photographic and camera direction BEFORE any AI image prompt is written.
You do NOT write ComfyUI prompts — you define the visual plan a DP hands to a photographer.

MANDATORY CAMERA LANGUAGE (match energy + emotion):
- emotional intimacy -> close_up + slow dolly_in
- isolation -> extreme_wide + static
- revelation -> medium + orbit
- freedom/joy -> wide + drone_push
- chaos/anxiety -> medium + handheld
- spiritual/transcendent -> medium + floating
- tension -> medium_close_up + slow zoom_in
- nostalgia -> medium + slow pan
- epic/climactic -> extreme_wide + drone_push
- resolution -> wide + slow dolly_out

VISUAL PURITY (mandatory for AI image models):
- NEVER describe readable text, signs with letters, subtitles, captions, logos, or UI on screen
- Avoid "neon sign saying X" — use "neon glow" or "colored light strips" instead
- Scenes must be photographable without typography

PHOTOGRAPHY RULES:
- Specify lens_mm (18|24|35|50|85|135), depth_of_field (shallow|medium|deep)
- Specify lighting: time_of_day, mood, practical sources (key, rim, backlight, natural)
- scene_description: 3-5 sentences — subject, wardrobe hints, environment texture, foreground/background layers
- composition: rule of thirds, leading lines, negative space, frame within frame when appropriate
- first_frame_state vs last_frame_state: what CHANGES between start and end (pose, gaze, light, distance)
- camera_movement: precise verb (dolly_in, orbit, pan, handheld, static, drone_push)
- motion_intent: max 12 words for img2video (camera + subject movement only)

CRITICAL — THINKING MODELS:
- Do all reasoning internally; NEVER output chain-of-thought or analysis in JSON values.
- scene_description and frame states = visible scene only (not instructions or schema).

ENERGY → SHOT LENGTH HINT:
- low: static/slow, long holds
- medium: gentle drift
- high/peak: dynamic handheld or fast push

OUTPUT: Valid JSON only. No markdown. No explanations outside JSON."""


def build_trailer_cinematographer_prompt(
    slots: list[dict],
    *,
    style: str,
    aspect_ratio: str,
    bpm: float = 0.0,
    lyrics_excerpt: str = "",
) -> str:
    import json as _json

    slots_json = _json.dumps(slots, indent=2, ensure_ascii=True)
    lyrics_block = ""
    if lyrics_excerpt and lyrics_excerpt.strip():
        lyrics_block = f"\nLYRICS CONTEXT (visual metaphor only, do not quote long text):\n{lyrics_excerpt[:1200]}\n"

    return f"""TRAILER PROJECT
STYLE REFERENCES: {style}
ASPECT RATIO: {aspect_ratio}
BPM: {bpm or 'unknown'}
{lyrics_block}
EDL SLOTS (one visual plan per slot_id):
{slots_json}

For EACH slot, output one entry in "visual_plans" with:
- slot_id (exact match)
- shot_type: extreme_wide|wide|medium|medium_close_up|close_up|extreme_close_up|drone|pov
- lens_mm: integer
- depth_of_field: shallow|medium|deep
- camera_movement: static|dolly_in|dolly_out|pan|tilt|orbit|tracking|handheld|floating|drone_push
- lighting: {{"time_of_day":"...","mood":"...","sources":["..."]}}
- composition: one sentence (framing strategy)
- scene_description: detailed DP notes (subject, environment, atmosphere, 40-80 words)
- first_frame_state: starting photographic moment (pose, light, distance)
- last_frame_state: ending photographic moment (what changed from first)
- motion_intent: max 12 words (camera + subject movement)
- color_grade_note: e.g. teal-orange, desaturated noir, warm golden

Output JSON:
{{"visual_plans":[{{"slot_id":"slot_001","shot_type":"medium","lens_mm":50,...}}]}}"""


TRAILER_PROMPT_ENGINEER_FROM_DOP_SYSTEM = """You are a specialist AI prompt engineer for cinematic image and video generation.
You receive Director of Photography (DP) visual plans and convert them into production-ready ComfyUI prompts.

FRAME PROMPT FORMAT (mandatory — every first_frame_prompt and last_frame_prompt):
[CINEMATIC STYLE], [SHOT TYPE], [SUBJECT + SPECIFIC ACTION/POSE], [DETAILED ENVIRONMENT], [LIGHTING], [EMOTIONAL MOOD], [TECHNICAL QUALITY]

RULES:
- first_frame_prompt = DP first_frame_state expanded into full format (50-90 words, comma-separated)
- last_frame_prompt = DP last_frame_state expanded; must differ from first (implies motion)
- scene_prompt = shorter hero still (30-50 words) for backup txt2img
- motion_prompt = DP motion_intent refined, max 15 words, camera + subject verbs only
- ltx_video_prompt: single flowing paragraph (present tense, 60-150 words) per LTX 2.3 img2video spec — describe motion from starting frame, camera movement, subject action (physical cues only), environment changes, ambient audio. Do NOT re-describe static scene elements already in the reference image.
- Include lens and depth-of-field cues from DP plan in [TECHNICAL]
- Include lighting.time_of_day and sources in [LIGHTING]
- negative_prompt: use full anti-text negative (text, letters, typography, watermark, gibberish writing, malformed hands, bad anatomy, cartoon, CGI)

CRITICAL — THINKING MODELS:
- first_frame_prompt and last_frame_prompt must be ONLY visual descriptions for the image model.
- NEVER include reasoning, JSON examples, field names, or words like "I will create".
- English only; comma-separated visual tags; no quoted instructions.

OUTPUT: Valid JSON only. No markdown. No text outside JSON."""


def build_trailer_prompt_engineer_from_dop(
    visual_plans: list[dict],
    *,
    style: str,
    aspect_ratio: str,
) -> str:
    import json as _json

    from src.core.llm.generation_prompt_sanitize import CINEMATIC_NEGATIVE_PROMPT

    neg = CINEMATIC_NEGATIVE_PROMPT
    plans_json = _json.dumps(visual_plans, indent=2, ensure_ascii=True)

    return f"""GLOBAL STYLE: {style}
ASPECT RATIO: {aspect_ratio}

DP VISUAL PLANS (translate each into ComfyUI-ready prompts):
{plans_json}

For EACH plan (same order), output in "prompts":
- slot_id (exact match)
- scene_prompt: condensed cinematic still (30-50 words)
- first_frame_prompt: full 7-part format from first_frame_state (50-90 words)
- last_frame_prompt: full 7-part format from last_frame_state (50-90 words)
- motion_prompt: max 15 words from motion_intent
- ltx_video_prompt: single flowing paragraph (present tense, 60-150 words) per LTX 2.3 img2video spec — describe motion from starting frame, camera movement, subject action (physical cues only), environment changes, ambient audio
- negative_prompt: "{neg}"

Output JSON:
{{"prompts":[{{"slot_id":"slot_001","scene_prompt":"...","first_frame_prompt":"...","ltx_video_prompt":"...",...}}]}}"""


# ── LLM 5: Continuity Checker ─────────────────────────────────────────────────

CONTINUITY_CHECKER_SYSTEM = """You are a professional script continuity supervisor with expertise in cinematic production.

Your job: review the complete shot list and identify ALL continuity errors before production begins.

CHECK THESE CATEGORIES:
1. CHARACTER: wardrobe changes within scene, missing visual anchors, impossible position jumps
2. LIGHTING: impossible lighting changes without time jump, inconsistent light direction
3. LOCATION: background elements disappearing, impossible location details
4. NARRATIVE: scene changes without valid trigger, emotional arc jumps
5. CAMERA: jarring shot sequences (two extreme close-ups with no context), illogical progression
6. TRANSITION: transition type doesn't match emotional moment
7. PROMPT: character descriptions differ between shots in same scene

SEVERITY:
- critical: blocks production (character wardrobe change, impossible continuity)
- warning: should fix but doesn't block (slightly inconsistent lighting)
- suggestion: optional improvement (could add a better transition)

For each error include the specific correction instruction.

OUTPUT: Valid JSON matching ContinuityReport schema. No explanations."""


def build_continuity_checker_prompt(shot_list: list) -> str:
    import json as _json
    shots_json = _json.dumps(shot_list, indent=2, ensure_ascii=True)
    return f"""Analyze this complete shot list for continuity errors. You are a professional script supervisor — be thorough and specific.

SHOT LIST:
{shots_json}

For EACH consecutive pair of shots, check:
1. CHARACTER: Is wardrobe consistent? Do visual_anchors appear in prompts? Do character positions make sense?
2. LIGHTING: Is time_of_day consistent within the same scene? Does lighting direction match?
3. LOCATION: Do background elements persist within the same scene?
4. CAMERA: Is the shot_type progression logical? No jarring jumps (e.g. two extreme close-ups with no context shot)?
5. TRANSITION: Does transition_out of shot[n] match transition_in of shot[n+1]?
6. PROMPT: If first_frame/last_frame prompts exist, are character descriptions identical within the same scene?
7. NARRATIVE: Does the emotional arc progress logically?

OUTPUT this exact JSON structure:
{{
  "analysis_summary": "Overall assessment paragraph — what you found, what looks good, what needs attention. Be specific about which shots you analyzed.",
  "checks_performed": ["character", "lighting", "location", "camera", "transition", "prompt", "narrative"],
  "total_errors": 0,
  "critical_count": 0,
  "warning_count": 0,
  "approved": true,
  "errors": [
    {{
      "shot_ids": ["shot_001", "shot_002"],
      "shot_pair": "shot_001 -> shot_002",
      "error_type": "character",
      "severity": "critical",
      "description": "Specific description of what the continuity error is",
      "reasoning": "Why this is a problem: what changed between the two shots that shouldn't have changed",
      "correction": "Specific instruction to fix this error"
    }}
  ],
  "corrected_shots": []
}}

error_type: character|lighting|location|narrative|camera|transition|prompt
severity: critical (blocks production) | warning (should fix) | suggestion (optional)
approved: true only if no critical errors

If everything looks correct, return approved: true, errors: [], and write a positive analysis_summary explaining what you verified."""
