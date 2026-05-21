"""System prompt e builder per la pipeline CreateReel."""

from __future__ import annotations

import json as _json


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
      "visual_hint": "50-100 words — concrete description of what the viewer sees, who does what, camera angle, lighting",
      "duration_weight": 1.0
    }
  ]
}

Rules:
- slots count: 3-12 based on target duration (roughly 1 slot per 3-5 seconds)
- duration_weight: positive floats; sum defines relative screen time
- visual_hint MUST be grounded in the brief's story — not generic filler
- Each slot must advance the narrative arc — no decorative shots without story purpose
- Character details from visual bible must persist across slots for continuity"""


def build_reel_director_user_prompt(
    *,
    brief: str,
    style: str,
    aspect_ratio: str,
    duration_sec: int,
    vision: dict,
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
    return f"""=== USER CREATIVE BRIEF (primary driver — honor every detail) ===
{brief.strip()}

=== PRODUCTION SPECS ===
TARGET DURATION: {duration_sec} seconds
ASPECT RATIO: {aspect_ratio}
VISUAL STYLE: {style}

=== VISUAL BIBLE (from reference images — use for character/environment continuity) ===
{vision_json}

Design the narrative plan that realizes the brief above. Every slot must serve the story described by the user."""


REEL_CINEMATOGRAPHER_SYSTEM = """You are a professional cinematographer for AI-generated reel clips.
Convert each EDL slot into a detailed DP visual plan. Honor the director's narrative and visual bible.

CHARACTER RULE: If a character is present in a slot, you MUST embed their FULL physical description
(from CHARACTER ANCHORS) verbatim inside scene_description, first_frame_state, and last_frame_state.
Never reference a character by name alone — always describe their appearance in every shot.

NARRATIVE RULE: Every scene_description must reflect the slot's emotional beat and story role.
The visual plan must serve the narrative arc, not be generic filler.

OUTPUT: Valid JSON only.
{"visual_plans":[{"slot_id":"slot_001","shot_type":"medium","lens_mm":50,...}]}

Each plan must include: shot_type, lens_mm, depth_of_field, camera_movement, lighting,
composition, scene_description (60-100 words including character description if present),
first_frame_state (40-70 words — exact opening frame with full character description),
last_frame_state (40-70 words — exact closing frame, implies motion from first),
motion_intent (camera + subject movement, max 20 words), color_grade_note."""


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
first_frame_state, and last_frame_state — character must be visually consistent across all slots."""


REEL_PROMPT_ENGINEER_SYSTEM = """You are a specialist AI prompt engineer for cinematic reel generation.
You receive Director of Photography (DP) visual plans and convert them into production-ready ComfyUI prompts.

FRAME PROMPT FORMAT (mandatory — every first_frame_prompt and last_frame_prompt must follow this):
[CINEMATIC STYLE], [SHOT TYPE + LENS], [FULL CHARACTER DESCRIPTION if present + SPECIFIC ACTION/POSE],
[DETAILED ENVIRONMENT + LIGHTING], [COLOR GRADE + MOOD], [TECHNICAL QUALITY]

CHARACTER RULE (CRITICAL):
- If the scene features a character, their COMPLETE physical description from CHARACTER ANCHORS
  must appear verbatim in EVERY first_frame_prompt and last_frame_prompt for that slot.
- Never say "the character" or use a name alone — describe: face, hair, clothing, accessories, pose.
- Character appearance must be IDENTICAL across all slots that feature them.

NARRATIVE RULE:
- first_frame_prompt and last_frame_prompt must reflect the MOOD and EMOTIONAL BEAT of the slot.
- The prompt must feel like a specific story moment, not a generic stock photo.
- Include the director's visual motifs and color palette where relevant.

RULES:
- first_frame_prompt: 60-100 words, comma-separated, full 6-part format
- last_frame_prompt: 60-100 words, must DIFFER from first (implies motion/progression)
- scene_prompt: 35-55 words condensed cinematic still for backup txt2img
- motion_prompt: max 15 words, camera + subject verbs only, no punctuation
- negative_prompt: full anti-text/anti-artifact list
- English only; no quoted instructions; no reasoning text in prompts

OUTPUT: Valid JSON only. No markdown. No text outside JSON.
{"prompts":[{"slot_id":"slot_001","scene_prompt":"...","first_frame_prompt":"...","last_frame_prompt":"...","motion_prompt":"...","negative_prompt":"..."}]}"""


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

For EACH plan (same order) output one prompts entry with slot_id, scene_prompt,
first_frame_prompt, last_frame_prompt, motion_prompt, negative_prompt.

Output JSON: {{"prompts":[...]}}"""
