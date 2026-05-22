"""System prompt e builder per la pipeline CreateReel."""

from __future__ import annotations

import json as _json

from src.core.llm.reel_prompt_structure import REEL_SHOT_FRAMING_RULES


REEL_VISION_SYSTEM = """You are a professional visual researcher for short-form cinematic reels.
Analyze each reference image for: subjects, wardrobe, environment, lighting, color palette, mood, camera angle, and style.
Synthesize a coherent visual bible for ONE reel video that must stay consistent across all shots.

OUTPUT: Valid JSON only. No markdown.
Schema:
{
  "images": [{"filename": "...", "subjects": ["..."], "environment": "...", "lighting": "...", "mood": "...", "camera": "...", "style_tags": ["..."]}],
  "combined_style": "one paragraph for global look",
  "character_anchors": ["persistent visual traits per character"],
  "environment_anchors": ["locations/settings to reuse"],
  "palette_hex": ["#RRGGBB", "..."],
  "wardrobe_notes": "string",
  "continuity_rules": ["rule 1", "rule 2"]
}"""


def build_reel_vision_user_prompt(
    *,
    brief: str,
    style: str,
    image_names: list[str],
) -> str:
    names = ", ".join(image_names) if image_names else "(none)"
    return f"""VIDEO BRIEF (what the user wants to create):
{brief}

USER STYLE HINT: {style or 'cinematic, photorealistic'}

REFERENCE IMAGES ATTACHED (in order): {names}

Analyze every attached image. Merge findings into one visual bible for the reel."""


REEL_DIRECTOR_SYSTEM_WITH_AUDIO = """You are an award-winning director planning a music-driven cinematic reel.
You receive: creative brief, visual bible, audio analysis (BPM, energy sections), and timed lyrics (if provided).
Sync visual slots to musical energy and lyric lines — each slot must match the mood and words in its time window.

OUTPUT: Valid JSON only. No markdown.
Schema:
{
  "logline": "one sentence",
  "mood": "overall tone aligned with the track",
  "visual_theme": "dominant visual motif",
  "narrative_arc": "2-3 sentences",
  "visual_motifs": ["3-6 elements"],
  "slots": [
    {
      "slot_id": "slot_001",
      "narrative_role": "intro|build|peak|resolution",
      "emotion": "match section energy and lyrics",
      "visual_hint": "80-150 words — WHO/WHAT/WHERE + how visuals serve the lyric lines in this window",
      "duration_weight": 1.0,
      "energy": "low|medium|high|peak"
    }
  ]
}

Rules:
- slots count: 3-12 for target duration (~1 slot per 3-5s)
- duration_weight: relative screen time; peak/chorus sections may get higher weight
- Each slot must reference the lyric lines or instrumental mood in its time range
- Lip-sync or performance energy when lyrics are vocal and brief implies music video
- Never duplicate visual_hint across slots"""


REEL_DIRECTOR_SYSTEM = """You are an award-winning director planning a short cinematic reel (no music lyrics).
You receive a creative brief (the user's story intent) and a visual bible from reference image analysis.
Your job: turn the brief into a concrete narrative plan expressed through timed visual slots.

The BRIEF is the primary driver — the visual bible is the reference palette, not a constraint.
If the brief describes characters, emotions, or a story arc, honor it precisely.

OUTPUT: Valid JSON only. No markdown.
Schema:
{
  "logline": "one sentence capturing the story and emotional core",
  "mood": "overall emotional tone (e.g. melancholic, euphoric, tense, dreamy)",
  "visual_theme": "dominant visual motif / recurring image that anchors the reel",
  "narrative_arc": "2-3 sentences: describe the story arc the director chose — what happens, how it evolves, what emotion the viewer feels at the end",
  "visual_motifs": ["3-6 recurring visual elements that thread through the reel"],
  "slots": [
    {
      "slot_id": "slot_001",
      "narrative_role": "intro|build|peak|resolution",
      "emotion": "specific emotion for this beat",
      "visual_hint": "80-150 words — WHO/WHAT/WHERE: named subjects, physical appearance, key objects/props, surface materials, environment depth, camera angle, lighting direction, color mood",
      "duration_weight": 1.0
    }
  ]
}

Rules:
- slots count: 3-12 based on target duration (roughly 1 slot per 3-5 seconds)
- duration_weight: positive floats; sum defines relative screen time
- visual_hint MUST be grounded in the brief's story — not generic filler
- Each slot must advance the narrative arc — no decorative shots without story purpose
- Character details from visual bible must persist across slots for continuity
- NEVER copy the same visual_hint across slots — each slot needs unique WHO/WHAT/WHERE, camera angle, and subject ACTION
- Vary narrative_role across slots: intro → build → peak → resolution (no three identical "medium tracking" beats)
- If the brief is a music video / rap / performance: at least one slot must show lip-sync or vocal performance energy, one wide establishing, one intense close-up — not only slow zoom"""


def build_reel_director_user_prompt(
    *,
    brief: str,
    style: str,
    aspect_ratio: str,
    duration_sec: int,
    vision: dict,
    audio_analysis: dict | None = None,
    lyric_beats: list | None = None,
    lyrics: str | None = None,
    audio_start_sec: float = 0.0,
) -> str:
    # Keep vision compact but preserve key anchors
    vision_compact = {
        "combined_style":      (vision.get("combined_style") or "")[:500],
        "character_anchors":   (vision.get("character_anchors") or [])[:6],
        "environment_anchors": (vision.get("environment_anchors") or [])[:4],
        "palette_hex":         (vision.get("palette_hex") or [])[:6],
        "wardrobe_notes":      (vision.get("wardrobe_notes") or "")[:300],
        "continuity_rules":    (vision.get("continuity_rules") or [])[:6],
    }
    vision_json = _json.dumps(vision_compact, indent=2, ensure_ascii=True)

    audio_block = ""
    if audio_analysis or lyric_beats or lyrics:
        sections_payload = []
        for s in (audio_analysis or {}).get("sections_list") or []:
            if hasattr(s, "model_dump"):
                sections_payload.append(s.model_dump())
            elif isinstance(s, dict):
                sections_payload.append(s)
        beats = (lyric_beats or [])[:24]
        audio_block = f"""
=== AUDIO TIMELINE (reel uses seconds {audio_start_sec:.1f}–{audio_start_sec + duration_sec:.1f} of source track) ===
BPM: {(audio_analysis or {}).get('bpm', '?')}
Sections: {_json.dumps(sections_payload[:10], ensure_ascii=True)[:2500]}
Timed lyric beats: {_json.dumps(beats, ensure_ascii=True)[:2000]}
"""
        if lyrics and lyrics.strip():
            audio_block += f"""
=== FULL LYRICS (user-provided — do NOT re-transcribe; honor these words in slot timing) ===
{lyrics.strip()[:2500]}
"""

    return f"""=== USER CREATIVE BRIEF (primary driver — honor every detail) ===
{brief.strip()}

=== PRODUCTION SPECS ===
TARGET DURATION: {duration_sec} seconds
ASPECT RATIO: {aspect_ratio}
VISUAL STYLE: {style}

=== VISUAL BIBLE (from reference images — use for character/environment continuity) ===
{vision_json}
{audio_block}
Design the narrative plan that realizes the brief above. Every slot must serve the story and the musical timeline."""


REEL_CINEMATOGRAPHER_SYSTEM = f"""You are a professional cinematographer for AI-generated reel clips.
Convert each EDL slot into a detailed DP visual plan. Honor the director's narrative and visual bible.

CHARACTER RULE: If a character is present in a slot, you MUST embed their FULL physical description
(from CHARACTER ANCHORS) verbatim inside scene_description, first_frame_state, and last_frame_state.
Never reference a character by name alone — always describe their appearance in every shot.

NARRATIVE RULE: Every scene_description must reflect the slot's emotional beat and story role.
The visual plan must serve the narrative arc, not be generic filler.

OUTPUT: Valid JSON only.
{{"visual_plans":[{{"slot_id":"slot_001","shot_type":"medium","lens_mm":50,...}}]}}

Each plan must include:
shot_type, lens_mm, depth_of_field, camera_movement, lighting, composition,
primary_visual_focus (WHO is the visual protagonist — one clear sentence),
secondary_subject (optional — only if shot scale allows a second person in frame),
emotional_beat (tension/attraction/curiosity in prose — not a label),
scene_description (prose blocking: WHO is where, foreground/background, gaze, spatial axis),
first_frame_state (complete sentences — opening pose, no truncated phrases),
last_frame_state (complete sentences — what changed vs first),
motion_intent (camera + subject movement, 15-25 words), color_grade_note.

{REEL_SHOT_FRAMING_RULES}

FORBIDDEN: bare emotion labels, platform names, listing full room layout in a close-up shot."""


def build_reel_cinematographer_prompt(
    slots: list[dict],
    *,
    style: str,
    aspect_ratio: str,
    vision: dict,
    brief: str,
    director_narrative: dict | None = None,
) -> str:
    dn = director_narrative or {}
    slots_json = _json.dumps(slots, indent=2, ensure_ascii=True)

    # Merge character anchors from both vision analysis and director narrative
    vision_anchors = (vision.get("character_anchors") or [])[:6]
    dn_motifs = (dn.get("visual_motifs") or [])[:6]
    combined_style = vision.get("combined_style", "")
    motifs_str = (
        "; ".join(dn_motifs) if dn_motifs
        else (combined_style[:400] if combined_style else "")
    )

    narrative_block = ""
    if dn:
        narrative_block = f"""
=== DIRECTOR NARRATIVE (honor every element) ===
LOGLINE: {dn.get("logline", "")}
MOOD: {dn.get("mood", "")}
VISUAL THEME: {dn.get("visual_theme", "")}
NARRATIVE ARC: {dn.get("narrative_arc", "")}
VISUAL MOTIFS (recurring elements — weave into shots): {"; ".join(dn_motifs) if dn_motifs else "see brief"}
"""

    anchors_list = vision_anchors
    anchors_block = (
        "\n".join(f"  - {a}" for a in anchors_list)
        if anchors_list
        else "  (none — infer from brief)"
    )

    return f"""=== REEL BRIEF ===
{brief[:1500]}

=== PRODUCTION SPECS ===
GLOBAL STYLE: {style}
ASPECT RATIO: {aspect_ratio}
VISUAL BIBLE (reference palette): {motifs_str or "cinematic, photorealistic"}
{narrative_block}
=== CHARACTER ANCHORS (embed verbatim in every shot that features the character) ===
{anchors_block}

=== EDL SLOTS ===
{slots_json}

For EACH slot_id output one visual_plans entry.
If a character appears: paste their anchor description in full into scene_description,
first_frame_state, and last_frame_state — character must be visually consistent across all slots.

MANDATORY VARIETY: consecutive slots must NOT share the same shot_type + camera_movement pair.
motion_intent must describe BOTH camera motion AND subject body action (walk, gesture, lip sync, head turn) — never camera-only slow zoom on every slot."""


REEL_PROMPT_ENGINEER_SYSTEM = f"""You are a specialist AI prompt engineer for cinematic reel generation (Z-Image txt2img, LTX video).
You receive Director of Photography (DP) visual plans and convert them into production-ready prompts.

FRAME PROMPT FORMAT — mandatory structured prose (NOT comma keyword lists):
Write first_frame_prompt and last_frame_prompt as 4-7 connected sentences in English, in this order:
1. Scene setup (environment scale must match shot_type)
2. Main subject — the visual protagonist from primary_visual_focus
3. Secondary subject (only if shot is medium or wider)
4. Action/pose for this exact frame (complete sentences, never "she is," truncated)
5. Emotional intent (tension, desire, curiosity — show don't label)
6. Camera — ONE shot type + lens_mm + depth_of_field (no contradictory second shot type)
7. Lighting — once
8. Texture/style — film grain, photorealistic skin (NO "8k")
9. Mood

BAD: "close-up shot, medium close-up, man, woman, bar, table, stage, shallow DOF, shallow DOF, 8k, sharp focus"
GOOD: "Inside a dark neo-noir pub with deep blue ambient light and warm amber practicals on wood walls. A 30-year-old Italian man pauses in the left doorway, his gaze locked on the dancer. In the middle distance, a red-haired woman dances alone, hips swaying with the music. The emotional charge is quiet attraction and hesitation. The camera holds a cinematic medium shot on a 50mm lens; shallow depth of field separates the pair from the soft crowd. High-contrast chiaroscuro with amber rim on faces. Subtle film grain and photorealistic skin texture."

{REEL_SHOT_FRAMING_RULES}

LTX VIDEO PROMPT FORMAT (mandatory — ltx_video_prompt is a flowing paragraph for video generation):
- 90-140 words in ONE continuous paragraph, present tense, English only
- Start with camera movement: "The camera slowly pushes in on...", "A tracking shot follows..."
- Describe: camera motion, subject identity and materials, physical action with cues, environment changes, lighting shift, ambient sound
- Do NOT append platform names (instagram/tiktok/adv). Do NOT write "X emotion" as a label.
- NO bullet points, NO lists — flowing prose only

CHARACTER RULE (CRITICAL):
- If the scene features a character, their COMPLETE physical description from CHARACTER ANCHORS
  must appear verbatim in EVERY first_frame_prompt and last_frame_prompt for that slot.
- Never say "the character" or use a name alone — describe: face, hair, clothing, accessories, pose.
- Character appearance must be IDENTICAL across all slots that feature them.

NARRATIVE RULE:
- All prompts must reflect the MOOD and EMOTIONAL BEAT of the slot.
- The prompt must feel like a specific story moment, not a generic stock photo.
- Include the director's visual motifs and color palette where relevant.

RULES:
- first_frame_prompt: 90-130 words, structured prose per formula above
- last_frame_prompt: 90-130 words, must DIFFER from first (visible pose/light/progression)
- scene_prompt: 45-70 words — hero still naming protagonist + one action + environment scale
- ltx_video_prompt: 90-140 words, flowing paragraph, camera+subject action+environment+light+audio
- motion_prompt: max 15 words, camera + subject verbs only, no punctuation
- negative_prompt: full anti-artifact list
- English only; no quoted instructions; no reasoning text in prompts

OUTPUT: Valid JSON only. No markdown. No text outside JSON.
{{"prompts":[{{"slot_id":"slot_001","scene_prompt":"...","first_frame_prompt":"...","last_frame_prompt":"...","ltx_video_prompt":"...","motion_prompt":"...","negative_prompt":"..."}}]}}"""


def build_reel_prompt_engineer_user(
    visual_plans: list[dict],
    *,
    style: str,
    aspect_ratio: str,
    vision: dict,
    director_narrative: dict | None = None,
) -> str:
    from src.core.llm.generation_prompt_sanitize import CINEMATIC_NEGATIVE_PROMPT

    dn = director_narrative or {}
    plans_json = _json.dumps(visual_plans, indent=2, ensure_ascii=True)

    # Build a rich character anchor block from both sources
    vision_anchors = (vision.get("character_anchors") or [])[:8]
    anchors_block = (
        "\n".join(f"  - {a}" for a in vision_anchors)
        if vision_anchors
        else "  (none — describe subjects generically from scene context)"
    )

    # Director narrative context
    narrative_context = ""
    if dn:
        motifs = "; ".join((dn.get("visual_motifs") or [])[:6])
        narrative_context = f"""
=== DIRECTOR NARRATIVE CONTEXT (inject into prompts) ===
LOGLINE: {dn.get("logline", "")}
MOOD: {dn.get("mood", "")}
VISUAL THEME: {dn.get("visual_theme", "")}
NARRATIVE ARC: {dn.get("narrative_arc", "")}
VISUAL MOTIFS: {motifs or "see brief"}
"""

    palette = vision.get("palette_hex") or []
    palette_note = f"PALETTE: {', '.join(palette[:6])}" if palette else ""

    return f"""GLOBAL STYLE: {style}
ASPECT RATIO: {aspect_ratio}
{palette_note}
{narrative_context}
=== CHARACTER ANCHORS (paste verbatim into every frame prompt that shows the character) ===
{anchors_block}

=== DP VISUAL PLANS ===
{plans_json}

negative_prompt for every slot: "{CINEMATIC_NEGATIVE_PROMPT}"

For EACH plan (same order) output one prompts entry with ALL fields:
slot_id, scene_prompt, first_frame_prompt, last_frame_prompt,
ltx_video_prompt (60-120 word flowing paragraph — REQUIRED),
motion_prompt, negative_prompt.

Output JSON: {{"prompts":[...]}}"""
