"""System prompt e builder per la pipeline CreateReel."""

from __future__ import annotations

import json as _json
import re as _re

from src.core.llm.reel_prompt_structure import REEL_SHOT_FRAMING_RULES


REEL_VISION_SYSTEM = """You are a professional visual researcher for short-form cinematic reels.
Analyze each reference image for: subjects, wardrobe, environment, lighting, color palette, mood, camera angle, and style.
Synthesize a coherent visual bible for ONE reel video that must stay consistent across all shots.

IMPORTANT: If the brief describes the subject's ethnicity/nationality (e.g. "Italian male", "young Italian man"),
populate character_anchors with that exact physical description. Do NOT override with Asian or other ethnicities.

OUTPUT: Valid JSON only. No markdown.
Schema:
{
  "images": [{"filename": "...", "subjects": ["..."], "environment": "...", "lighting": "...", "mood": "...", "camera": "...", "style_tags": ["..."]}],
  "combined_style": "one paragraph for global look",
  "character_anchors": ["persistent visual traits per character — include ethnicity, age range, physical features, wardrobe specifics"],
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

Analyze every attached image. Merge findings into one visual bible for the reel.
If no reference images are attached but the brief describes a character, synthesize character_anchors from the brief text."""


REEL_DIRECTOR_SYSTEM_WITH_AUDIO = """You are an award-winning director planning a music-driven cinematic reel.
You receive: creative brief, visual bible, audio analysis (BPM, energy sections), and timed lyrics (if provided).
Sync visual slots to musical energy and lyric lines — each slot must match the mood and words in its time window.

CRITICAL JSON OUTPUT RULES:
- "logline" MUST be a single cinematic sentence (15-25 words) that captures the STORY and EMOTIONAL CORE.
  BAD: copying the brief text verbatim. GOOD: "A restless Italian man scrolls through digital noise, his ironic gaze piercing the neo-noir darkness."
- "narrative_arc" MUST be 2-3 sentences describing emotional journey (NOT a copy of the brief).
- "slots[].visual_hint" MUST describe a SPECIFIC VISUAL MOMENT in English, NOT copy the brief.
  Each slot_hint must be UNIQUE — describe different framings, different moments, different actions.
- NEVER copy the brief text into any JSON field — always transform it into cinematic direction.

ENVIRONMENT AWARENESS: Extract the physical environment from the brief. Map it to REAL lighting conditions:
- Arctic/Antarctic/polar = pale blue-white diffused light, no warm tones, flat polar horizon, ice reflections
- Desert = harsh golden directional light, hard shadows, bleached sky
- Forest = dappled green-filtered light, soft diffusion
- Interior = practical warm sources (lamp, window, candle)
- Urban night = neon mixed color, wet pavement reflections
NEVER use "warm directional" for cold outdoor environments like polar, mountain, or deep water.

SLOT DIFFERENTIATION RULE: Every slot MUST have a different scene_description focus. Advance the story:
- Slot 1 (intro): wide establishing — environment, scale, isolation
- Slot 2 (build): medium — character introduced in context
- Slot 3 (peak): close-up — emotion, detail, intimacy
- Slot 4 (resolution): wide or medium — narrative payoff
Use the brief's specific elements (animals, landscape features, weather, objects) to differentiate each slot.

CHARACTER SPECIFICITY: Always describe the physical subject (clothing color, hair, distinguishing features)
in every visual_hint. NEVER use generic phrases like "the protagonist" alone without physical description.

OUTPUT: Valid JSON only. No markdown.
Schema:
{
  "logline": "one original cinematic sentence — NOT a copy of the brief",
  "mood": "overall tone aligned with the track",
  "visual_theme": "dominant visual motif",
  "narrative_arc": "2-3 sentences describing the emotional journey from first to last slot",
  "visual_motifs": ["3-6 elements"],
  "slots": [
    {
      "slot_id": "slot_001",
      "scene_id": "scene_a",
      "narrative_role": "intro|build|peak|resolution",
      "emotion": "match section energy and lyrics",
      "visual_hint": "80-150 words — WHO/WHAT/WHERE in English. Describe the SPECIFIC visual moment: subject position, action, environment detail, lighting, camera angle. Match to the lyric lines in this time window.",
      "duration_weight": 1.0,
      "energy": "low|medium|high|peak"
    }
  ]
}

Rules:
- slots count: 3-12 for target duration (~1 slot per 3-5s)
- duration_weight: relative screen time; peak/chorus sections may get higher weight
- scene_id: assign the SAME scene_id to 2-3 consecutive slots that share the same LOCATION and TIME OF DAY. Different locations/times get different scene_ids (scene_a, scene_b, etc.)
- Each slot must reference the lyric lines or instrumental mood in its time range
- Lip-sync or performance energy when lyrics are vocal and brief implies music video
- NEVER duplicate visual_hint across slots — each slot is a different shot with different framing and action
- narrative_arc must describe a clear emotional journey: how does the viewer FEEL at start vs end?
- If brief specifies subject ethnicity/nationality, honor it exactly in visual_hints (e.g. "Italian male 25-35")"""


REEL_DIRECTOR_SYSTEM = """You are an award-winning director planning a short cinematic reel (no music lyrics).
You receive a creative brief (the user's story intent) and a visual bible from reference image analysis.
Your job: turn the brief into a concrete narrative plan expressed through timed visual slots.

The BRIEF is the primary driver — the visual bible is the reference palette, not a constraint.
If the brief describes characters, emotions, or a story arc, honor it precisely.

CRITICAL JSON OUTPUT RULES:
- "logline" MUST be a single cinematic sentence (15-25 words) capturing the story and emotional core.
  BAD: copying the brief text verbatim. GOOD: "A weary Italian man confronts the digital void of social media in a neo-noir Italian bar."
- "narrative_arc" MUST be 2-3 original sentences describing emotional journey (NOT a copy of the brief).
- "slots[].visual_hint" MUST describe a SPECIFIC VISUAL MOMENT in English. NEVER copy the brief text.
- Each slot must be UNIQUE — different framing, different moment, advancing action.

ENVIRONMENT AWARENESS: Extract the physical environment from the brief. Map it to REAL lighting conditions:
- Arctic/Antarctic/polar = pale blue-white diffused light, no warm tones, flat polar horizon, ice reflections
- Desert = harsh golden directional light, hard shadows, bleached sky
- Forest = dappled green-filtered light, soft diffusion
- Interior = practical warm sources (lamp, window, candle)
- Urban night = neon mixed color, wet pavement reflections
NEVER use "warm directional" for cold outdoor environments like polar, mountain, or deep water.

SLOT DIFFERENTIATION RULE: Every slot MUST advance the story with a different visual focus and a
different combination of shot_type + camera_movement. No two consecutive slots may share the same pairing.
Use EVERY distinct element in the brief (characters, animals, landscape features, weather, objects) —
each element should anchor at least one slot.

CHARACTER SPECIFICITY: Always describe the physical subject (clothing color, hair, distinguishing features)
in every visual_hint. NEVER use phrases like "the protagonist" alone without physical description.

OUTPUT: Valid JSON only. No markdown.
Schema:
{
  "logline": "one sentence capturing the story and emotional core",
  "mood": "overall emotional tone (e.g. melancholic, euphoric, tense, dreamy)",
  "visual_theme": "dominant visual motif / recurring image that anchors the reel",
  "narrative_arc": "2-3 sentences: describe the story arc — what happens, how it evolves, what emotion the viewer feels at the end",
  "visual_motifs": ["3-6 recurring visual elements that thread through the reel"],
  "slots": [
    {
      "slot_id": "slot_001",
      "scene_id": "scene_a",
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
- scene_id: assign the SAME scene_id (scene_a, scene_b, …) to 2-3 consecutive slots that share the same LOCATION and TIME OF DAY — these will be cut together as one continuous scene. Different locations get a NEW scene_id. Most reels should have 2-4 distinct scenes.
- visual_hint MUST be grounded in the brief's story — not generic filler
- Each slot must ADVANCE the narrative arc — no decorative shots without story purpose
- Within the same scene_id: slots must show the same characters and environment evolving (different angles, closer framing, advancing action) — NOT a new place
- Character details from visual bible must persist across slots for continuity
- NEVER copy the same visual_hint across slots — each slot needs unique WHO/WHAT/WHERE, camera angle, and subject ACTION
- Vary narrative_role: intro → build → peak → resolution (no three identical "medium tracking" beats)
- narrative_arc must describe how the viewer's emotion progresses from first to last slot
- If brief specifies subject ethnicity/nationality, honor it exactly in visual_hints"""


def _build_section_lyric_map(lyrics: str, sections: list[dict], duration_sec: float) -> str:
    """Map lyric lines to audio sections for director context when timed beats are unavailable."""
    if not lyrics.strip() or not sections:
        return ""
    lines = [l.strip() for l in lyrics.splitlines() if l.strip()]
    if not lines:
        return ""
    n = len(lines)
    total = duration_sec or 1.0
    out_parts: list[str] = []
    acc = 0
    for sec in sections:
        s_start = sec.get("start_sec", 0)
        s_end = sec.get("end_sec", total)
        sec_dur = max(0.1, s_end - s_start)
        n_sec = max(1, round(n * sec_dur / total))
        end_idx = min(n, acc + n_sec)
        sec_lines = lines[acc:end_idx]
        if sec_lines:
            energy = sec.get("energy", "medium")
            stype = sec.get("section_type", "")
            label = f"{stype or 'section'} [{s_start:.0f}s–{s_end:.0f}s, energy={energy}]"
            out_parts.append(f"{label}:\n" + "\n".join(f"  {l}" for l in sec_lines[:8]))
        acc = end_idx
        if acc >= n:
            break
    return "\n\n".join(out_parts)[:2000]


def _extract_character_anchor_from_brief(brief: str, style: str = "") -> str | None:
    """
    Extract a character anchor from a user brief in any language.

    Strategy:
    1. Detect a physical person using universal subject keywords (any language).
    2. Extract physical descriptors (hair, clothing, age, color) from the brief text.
    3. Return a structured anchor string, or None if no person-like subject is found.
    """
    combined = (brief + " " + style).lower()

    # --- Step 1: Detect a physical person subject ---
    # Universal subject keywords: English, Italian, French, Spanish, German, Portuguese
    _SUBJECT_FEMALE = [
        "woman", "girl", "female", "lady", "donna", "ragazza", "femme", "fille",
        "mujer", "chica", "frau", "mädchen", "mulher", "menina",
    ]
    _SUBJECT_MALE = [
        "man", "guy", "male", "boy", "gentleman", "uomo", "ragazzo", "maschio",
        "homme", "garçon", "hombre", "chico", "mann", "junge", "homem", "rapaz",
    ]
    _SUBJECT_NEUTRAL = [
        "person", "figure", "subject", "character", "protagonist", "individual",
        "persona", "personaggio", "personne", "personne", "pessoa",
        # self-referential (user refers to themselves)
        "myself", "me ", "my ", "mio", "mia", "miei", "viso", "faccia",
        # professional/role identifiers
        "blogger", "vlogger", "photographer", "filmmaker", "journalist",
        "fotograf", "giornalist", "traveler", "viaggiatrice", "viaggiatore",
        "explorer", "esploratrice", "esploratore", "creator", "influencer",
        "athlete", "atleta", "dancer", "ballerina", "singer", "cantante",
        "artist", "artista", "chef", "detective", "soldier", "soldato",
    ]

    # Use word-boundary aware matching to avoid "man" inside "woman", "boy" inside "nobody", etc.
    import re as _re_local
    def _word_match(text: str, keywords: list[str]) -> bool:
        for kw in keywords:
            if _re_local.search(r"(?<!\w)" + _re_local.escape(kw) + r"(?!\w)", text):
                return True
        return False

    is_female = _word_match(combined, _SUBJECT_FEMALE)
    is_male = _word_match(combined, _SUBJECT_MALE)
    is_person = is_female or is_male or _word_match(combined, _SUBJECT_NEUTRAL)

    if not is_person:
        return None

    # Determine gender
    if is_female and not is_male:
        gender = "female"
    elif is_male and not is_female:
        gender = "male"
    else:
        # Both or neutral — prefer female if explicit female keyword present
        gender = "female" if is_female else "person"

    # --- Step 2: Extract physical descriptors ---

    # Age range
    age_match = _re.search(
        r"(\d{2})\s*[-–]\s*(\d{2})\s*(?:anni|years|años|jahre|ans|yo\b)",
        combined,
    )
    single_age = _re.search(r"\b(\d{2})\s*(?:anni|years|años|jahre|yo\b)", combined)
    if age_match:
        age_str = f"{age_match.group(1)}-{age_match.group(2)} years old"
    elif single_age:
        age_str = f"approximately {single_age.group(1)} years old"
    else:
        age_str = "adult"

    # Hair color
    _HAIR_COLORS: dict[str, str] = {
        "red hair": "red hair", "capelli rossi": "red hair", "rousse": "red hair",
        "roja": "red hair", "rotes haar": "red hair",
        "blonde": "blonde hair", "blond": "blonde hair", "bionda": "blonde hair",
        "rubia": "blonde hair", "blondes haar": "blonde hair",
        "dark hair": "dark hair", "capelli scuri": "dark hair", "capelli neri": "dark black hair",
        "black hair": "dark black hair", "cheveux noirs": "dark black hair",
        "brown hair": "brown hair", "castana": "brown hair", "brünett": "brown hair",
        "white hair": "white hair", "capelli bianchi": "white hair",
        "grey hair": "grey hair", "capelli grigi": "grey hair",
        "curly": "curly hair", "ricci": "curly hair", "frisé": "curly hair",
        "wavy": "wavy hair", "ondulat": "wavy hair",
    }
    hair_desc = ""
    for kw, label in _HAIR_COLORS.items():
        if kw in combined:
            hair_desc = label
            break

    # Clothing color / key garment
    _CLOTHING: dict[str, str] = {
        "orange jacket": "bright orange jacket",
        "giacca arancione": "bright orange jacket",
        "arancione": "bright orange jacket",  # any orange garment
        "red jacket": "red jacket", "giacca rossa": "red jacket",
        "blue jacket": "blue jacket", "giacca blu": "blue jacket",
        "black jacket": "black jacket", "giacca nera": "black jacket",
        "white coat": "white coat", "cappotto bianco": "white coat",
        "red coat": "red coat", "cappotto rosso": "red coat",
        "red dress": "red dress", "vestito rosso": "red dress",
        "white dress": "white dress", "vestito bianco": "white dress",
    }
    clothing_desc = ""
    # First pass: exact substring match
    for kw, label in _CLOTHING.items():
        if kw in combined:
            clothing_desc = label
            break
    # Second pass: color+garment proximity match (e.g. "giacca arctica arancione")
    if not clothing_desc:
        _garments = ["jacket", "giacca", "coat", "cappotto", "dress", "vestito", "suit", "abito"]
        _colors_map = {
            "orange": "orange jacket", "arancione": "orange jacket",
            "red": "red jacket", "rossa": "red jacket", "rosso": "red jacket",
            "blue": "blue jacket", "blu": "blue jacket",
            "black": "black jacket", "nero": "black jacket", "nera": "black jacket",
            "white": "white jacket", "bianco": "white jacket", "bianca": "white jacket",
        }
        words = combined.split()
        for i, w in enumerate(words):
            if any(g in w for g in _garments):
                # Look for color in nearby words (±4 positions)
                window = words[max(0, i-4):i+5]
                for cw, clabel in _colors_map.items():
                    if cw in " ".join(window):
                        clothing_desc = clabel
                        break
            if clothing_desc:
                break

    # Nationality / ethnicity
    _ETHNICITY: dict[str, str] = {
        "italian": "Italian",
        "italiano": "Italian", "italiana": "Italian",
        "mediter": "Mediterranean",
        "french": "French", "français": "French",
        "spanish": "Spanish", "español": "Spanish",
        "german": "German", "deutsch": "German",
        "japanese": "Japanese", "korean": "Korean",
        "chinese": "Chinese", "asian": "Asian",
        "american": "American", "british": "British",
        "russian": "Russian", "brazilian": "Brazilian",
        "nordic": "Nordic", "scandinavian": "Scandinavian",
    }
    ethnicity_desc = ""
    for kw, label in _ETHNICITY.items():
        if kw in combined:
            ethnicity_desc = label
            break

    # Expression / personality traits
    _TRAITS: dict[str, str] = {
        "tired": "tired expression", "stanc": "tired expression", "weary": "weary expression",
        "exhaust": "exhausted expression",
        "ironic": "ironic demeanor", "ironico": "ironic demeanor", "sarcast": "sardonic expression",
        "happy": "bright expression", "felice": "bright expression",
        "sad": "melancholic expression", "triste": "melancholic expression",
        "angry": "intense expression", "arrabbiato": "intense expression",
        "pensive": "pensive gaze", "pensieroso": "pensive gaze",
        "determined": "determined expression", "deciso": "determined expression",
    }
    traits = []
    for kw, label in _TRAITS.items():
        if kw in combined and label not in traits:
            traits.append(label)
    trait_str = ", ".join(traits[:2]) if traits else "expressive presence"

    # --- Step 3: Build the anchor string ---
    parts = []
    if ethnicity_desc:
        parts.append(f"{ethnicity_desc} {gender}")
    else:
        parts.append(gender if gender != "person" else "person")
    parts.append(age_str)
    if hair_desc:
        parts.append(hair_desc)
    if clothing_desc:
        parts.append(clothing_desc)
    parts.append(trait_str)

    # Add ethnicity-specific appearance notes
    if ethnicity_desc in ("Italian", "Mediterranean", "Spanish", "French"):
        parts.append("olive skin, dark eyes, European Mediterranean features")
    elif ethnicity_desc in ("Nordic", "Scandinavian"):
        parts.append("fair skin, light eyes, Northern European features")
    elif ethnicity_desc == "Japanese":
        parts.append("East Asian features, Japanese")
    elif ethnicity_desc == "Korean":
        parts.append("East Asian features, Korean")

    anchor = ", ".join(p for p in parts if p)
    return anchor if anchor else None


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
    # Inject character anchor from brief if vision has no character_anchors
    char_anchors = list(vision.get("character_anchors") or [])
    if not char_anchors:
        extracted = _extract_character_anchor_from_brief(brief)
        if extracted:
            char_anchors = [extracted]

    # Keep vision compact but preserve key anchors
    vision_compact = {
        "combined_style":      (vision.get("combined_style") or "")[:500],
        "character_anchors":   char_anchors[:6],
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
            if not beats and sections_payload:
                section_lyric_map = _build_section_lyric_map(
                    lyrics.strip(),
                    sections_payload,
                    float(duration_sec),
                )
                if section_lyric_map:
                    audio_block += f"""
=== LYRICS BY AUDIO SECTION (use this to sync each slot's narrative to its lyric window) ===
{section_lyric_map}
"""
            audio_block += f"""
=== FULL LYRICS (honor these exact words — sync slot narrative to lyric meaning and section energy) ===
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
REMINDER: logline must be an original cinematic sentence (not a copy of the brief). Each slot visual_hint must describe a UNIQUE, SPECIFIC shot in English.
Design the narrative plan that realizes the brief above. Every slot must serve the story and the musical timeline."""


REEL_CINEMATOGRAPHER_SYSTEM = f"""You are a professional cinematographer for AI-generated reel clips.
Convert each EDL slot into a detailed DP visual plan. Honor the director's narrative and visual bible.

SUBJECT ETHNICITY RULE (CRITICAL — NON-NEGOTIABLE):
- If CHARACTER ANCHORS specify an Italian or Mediterranean subject, that description is ABSOLUTE.
- NEVER generate Asian, Chinese, East Asian, or other non-specified ethnicities.
- The subject MUST match the brief: if the brief says "Italian male", every shot features an Italian male.
- Embed the full character anchor (including "NOT Asian" constraints) in scene_description, first_frame_state, last_frame_state.

CHARACTER RULE: If a character is present in a slot, you MUST embed their FULL physical description
(from CHARACTER ANCHORS) verbatim inside scene_description, first_frame_state, and last_frame_state.
Never reference a character by name alone — always describe their appearance in every shot.

NARRATIVE RULE: Every scene_description must reflect the slot's emotional beat and story role.
The visual plan must serve the narrative arc, not be generic filler.

SHOT VARIETY RULE (MANDATORY):
- Consecutive slots MUST use different shot_type. Forbidden: 3+ consecutive slots with same shot_type.
- Required progression example: close_up → medium → wide → medium_close → extreme_close → medium → wide
- BPM sync: high BPM (>140) → prefer close_up, extreme_close, handheld for fast sections.
  Low BPM or instrumental → prefer medium, wide, slow dolly.
- Each shot must have a distinct camera_movement — no more than 2 identical movements in a row.

SLOT DIFFERENTIATION RULE: Every slot MUST have a different shot_type AND different camera_movement.
No two consecutive slots can share the same shot_type + camera_movement combination.

LIGHTING RULE: lighting_description MUST match the physical environment of the scene.
Extract location cues from scene_description and apply appropriate lighting:
- Polar/Antarctic/Arctic scenes = pale blue-white overcast diffused light, zero warm tones, flat horizon glow
- Desert/arid = harsh golden directional, hard cast shadows, high contrast
- Forest = soft dappled green-filtered light, low contrast
- Interior = practical sources (warm lamp, window blue, candle flicker)
NEVER write "warm directional light" for cold outdoor polar or high-altitude environments.

PHYSICAL MOTION RULE: motion_intent MUST contain physical action verbs (walks, runs, turns, reaches,
looks up, raises camera, bends down, steps forward, lifts arm, exhales, pivots) + camera movement +
environment interaction. NO metaphorical language ("emotional cost becomes visible", "protagonist enters
the world of").

COMPLETE SENTENCES RULE: All text fields must be complete sentences. Never truncate mid-word or
mid-clause. If a sentence ends with a comma, replace it with a period.

SCENE CONTINUITY RULE (CRITICAL):
- Slots that share the same scene_id are parts of the SAME SCENE (same location, continuous time).
- For every slot AFTER the first in a scene_id group: set use_prev_last_frame = true and scene_transition = "continuity".
- The first slot of each new scene_id (or a new location): set use_prev_last_frame = false and scene_transition = "scene_cut".
- Within a continuous scene: vary shot_type aggressively (wide → medium → close_up → extreme_close) to create editorial rhythm.

OUTPUT: Valid JSON only.
{{"visual_plans":[{{"slot_id":"slot_001","shot_type":"medium","lens_mm":50,...}}]}}

Each plan must include:
shot_type, lens_mm, depth_of_field, camera_movement, lighting, composition,
primary_visual_focus (WHO is the visual protagonist — one clear sentence with full physical description),
secondary_subject (optional — only if shot scale allows a second person in frame; include LEFT/RIGHT position and distance),
emotional_beat (tension/attraction/curiosity in prose — not a label),
scene_description (prose blocking: WHO is where LEFT/RIGHT/foreground/background, facing direction, spatial axis, distances),
first_frame_state (complete sentences — opening pose, fabric/material detail, no truncated phrases),
last_frame_state (complete sentences — what CHANGED vs first frame — new pose, head direction, expression shift),
motion_intent (verb-driven, 15-30 words — WHO moves + WHAT body part + HOW + camera action with direction.
  BAD: "slow zoom on subject". GOOD: "subject raises hand turns head right camera tracks left following gaze on 35mm"),
color_grade_note, texture_notes (fabric type, hair texture, surface materials visible at this shot scale),
use_prev_last_frame (boolean — MUST be true for all slots after the first within a same scene_id),
scene_transition ("continuity" if use_prev_last_frame else "scene_cut"),
scene_id (copy from the slot input — carry it forward for continuity tracking).

{REEL_SHOT_FRAMING_RULES}

FORBIDDEN: bare emotion labels, platform names, listing full room layout in a close-up shot.
FORBIDDEN: setting use_prev_last_frame=false for a slot that shares scene_id with the previous slot.
FORBIDDEN: Asian/Chinese/East Asian subjects when brief specifies Italian or Mediterranean characters.
FORBIDDEN: "warm directional" or "golden" lighting for polar, snowy, Antarctic, or Arctic environments."""


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

    # Merge character anchors — also inject from brief if empty
    vision_anchors = list(vision.get("character_anchors") or [])
    if not vision_anchors:
        extracted = _extract_character_anchor_from_brief(brief)
        if extracted:
            vision_anchors = [extracted]
    vision_anchors = vision_anchors[:6]

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
        else "  (none — infer from brief; describe subjects based on brief text)"
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

MANDATORY SHOT VARIETY: each consecutive slot must use a DIFFERENT shot_type.
Suggested progression for {len(slots)} slots: vary between extreme_close, close_up, medium_close, medium, wide, extreme_wide.
BPM is ~155+ (fast track) — prefer close_up and medium_close for high-energy moments, wide for breathing room.
motion_intent must describe BOTH camera motion AND subject body action (walk, gesture, lip sync, head turn) — never camera-only slow zoom on every slot."""


REEL_PROMPT_ENGINEER_SYSTEM = f"""You are a specialist AI prompt engineer for cinematic reel generation (Z-Image txt2img, LTX video).
You receive Director of Photography (DP) visual plans and convert them into production-ready prompts.

SUBJECT ETHNICITY RULE (ABSOLUTE — DO NOT OVERRIDE):
- If CHARACTER ANCHORS describe an Italian, Mediterranean, or European subject: ALL prompts must feature that exact description.
- NEVER generate prompts with Asian, Chinese, Korean, or East Asian subjects unless the brief explicitly specifies it.
- Include explicit ethnicity markers: "Italian male", "Mediterranean complexion", "olive skin tone", "European features".
- If anchor says "NOT Asian": add "Italian male, Mediterranean features, olive skin" prominently in the prompt.
- The negative_prompt MUST include: "asian, chinese, east asian, korean, japanese" when brief specifies Italian/European subject.

FRAME PROMPT FORMAT — mandatory structured prose (NOT comma keyword lists):
Write first_frame_prompt and last_frame_prompt as 4-7 connected sentences in English, in this order:
1. Scene setup (environment scale must match shot_type)
2. Main subject — the visual protagonist from primary_visual_focus WITH FULL PHYSICAL DESCRIPTION
3. Secondary subject (only if shot is medium or wider)
4. Action/pose for this exact frame (complete sentences, never "she is," truncated)
5. Emotional intent (tension, desire, curiosity — show don't label)
6. Camera — ONE shot type + lens_mm + depth_of_field (no contradictory second shot type)
7. Lighting — once
8. Texture/style — film grain, photorealistic skin (NO "8k")
9. Mood

BAD: "close-up shot, medium close-up, man, woman, bar, table, stage, shallow DOF, shallow DOF, 8k, sharp focus"
GOOD: "Inside a dark neo-noir Italian bar with deep blue ambient light and warm amber practicals on wood walls. A 30-year-old Italian male with olive skin, dark eyes, and disheveled dark hair pauses in the left doorway, his ironic gaze directed at the camera with tired resignation. The emotional charge is sardonic self-awareness masking exhaustion. The camera holds a cinematic medium shot on a 50mm lens; shallow depth of field separates him from the blurred bottles behind. High-contrast chiaroscuro with amber rim light on his Mediterranean features. Subtle film grain and photorealistic skin texture."

{REEL_SHOT_FRAMING_RULES}

LTX 2.3 VIDEO PROMPT FORMAT — ltx_video_prompt (img2video or txt2video):
LTX 2.3 KEY INSIGHT: SPECIFICITY WINS. The model handles complex prompts — multiple subjects,
spatial relationships, stylistic constraints, overlapping actions, material textures — better than
previous versions. Do NOT simplify. More detail = more control.
VERBS DRIVE MOVEMENT: static-sounding prompts produce frozen output. Every prompt needs ≥2 distinct
verb-driven subject actions. For img2video: do NOT re-describe the static first frame — describe
only MOTION, CHANGES, and audio.

ONE flowing paragraph, present tense, 5–9 sentences, English only.

STRUCTURE (strict order):
1) [SHOT TYPE] of [SUBJECT with FULL physical description] in [DETAILED SETTING] — include spatial
   positions (left/right of frame), distances, depth layers (foreground/background), facing direction
2) Lighting: quality, direction, color temperature, mood — be specific (not just "warm light")
3) Camera: ONE directional verb + lens — "dolly forward", "track left", "slow orbit", "handheld drift"
   Camera verb must be DIFFERENT from "slow zoom" if used in previous slot
4) Temporal verb sequence — MANDATORY: what subject does in first seconds → mid-clip → before end.
   Name WHO moves, WHAT they move (hand, head, body), HOW (raises, turns, steps, exhales, lifts gaze)
5) Texture/material in motion: fabric ripple, single hair strands catching light, rain on glass,
   surface reflections, environmental wear, edge detail
6) One environment micro-motion (haze drift, crowd blur, flickering practicals, smoke, rain intensity)
7) Portrait (9:16 only): compose top-to-bottom, subject centered vertically, frame fills height
8) Final sentence MUST start with "Sound: " — ambient tone, intensity level, any dialogue clarity,
   musical quality. Be specific: NOT "ambient sound" but "low café hum, ceramic clinking, muffled rain"

VERB-DRIVEN MOVEMENT RULE (mandatory for every prompt):
Specify explicitly: WHO/WHAT moves | HOW it moves | what the CAMERA does alongside it.
BAD: "The man stands at the bar looking thoughtful."
GOOD: "He raises his coffee cup with his right hand and turns his head toward the window; the camera
slowly tracks left to follow his gaze, revealing the rain-streaked glass behind him."

SPATIAL DIRECTION RULE: Be explicit. NOT "two people talking" but:
"The taller man stands to the LEFT with hands in pockets; the woman is to the RIGHT holding a bicycle.
Houses blur in the background. They face each other across a half-meter gap."

FORBIDDEN: "The scene shows...", "the scene animates", repeated shot types in same prompt, duplicate
camera sentences, trailing keyword stacks ("cinematic, photorealistic, 8k"), bare emotion labels,
static-portrait descriptions with no verb actions.

GOOD EXAMPLE — 16:9 (6s clip):
"A medium shot of a 30-year-old Italian male with olive skin, dark disheveled hair, and tired dark eyes,
standing to the left of frame inside a small Parisian café; rain streaks down the window glass behind
him on the right, and warm tungsten light from an overhead pendant pools on the wooden tabletop
between them. Lighting: high-contrast, warm amber from overhead against cold blue daylight bleeding
through wet glass; his left cheek catches the warm key, his right side falls into cool shadow. The
camera slowly dollies forward on a 35mm lens, closing the distance to his face over the full clip
duration. In the first seconds he slowly stirs the coffee with his right hand while his eyes stay
down; mid-clip he glances at his phone screen and his jaw tightens visibly; before the end he lifts
his gaze back toward the window with a slow resigned exhale. Single dark hair strands shift across
his forehead as he moves; the coffee steam drifts left in the warm updraft. Rain intensifies slightly
against the glass in the background. Sound: low café interior ambience — soft ceramic against saucer,
muffled street noise, a faint bass-heavy score pulse underneath."

GOOD EXAMPLE — 9:16 portrait (5s clip):
"A close-up of a young woman's face and shoulders centered vertically in frame; she stands against a
white textured wall with a diagonal shadow line running top-to-bottom behind her; she is positioned
slightly left of center with open space to her right. Soft diffused natural light from camera-left
wraps her features, with a warm golden rim catching her right cheekbone and the edge of her hair.
The camera gently pushes forward on a 50mm lens, moving from chest-up to near face-fill. In the
first seconds her chin lifts and her eyes find the lens directly; mid-clip a half-smile forms on
her lips and her shoulders drop slightly; before the end she turns her head a few degrees left, fine
strands of hair drifting across her cheek. Individual hair strands catch the golden edge light as
they move across her face. Sound: quiet outdoor ambience — distant wind, a faint melodic guitar note."

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
- first_frame_prompt: 90-140 words, structured prose per formula above
- last_frame_prompt: 90-140 words, must DIFFER from first (visible pose/light/progression)
- scene_prompt: 45-70 words — hero still naming protagonist + one action + environment scale
- ltx_video_prompt: 120-200 words, LTX 2.3 structure above (5–9 sentences + Sound:). Specificity wins — complex verb-driven sentences, spatial positions, material textures. NEVER simplify.
- motion_prompt: max 20 words, verb-driven — WHO/WHAT moves + HOW + camera direction. NOT "slow zoom". GOOD: "man raises coffee cup turns toward window camera tracks left on 35mm"
- negative_prompt: comma-separated English terms only, max 80 words. ALWAYS include: "deformed, extra limbs, bad anatomy, extra fingers, three legs, mutated, missing limbs, fused fingers, malformed hands, blurry, low quality, watermark, text, cartoon, anime, 3d render, static, frozen"
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
    brief: str = "",
) -> str:
    from src.core.llm.generation_prompt_sanitize import CINEMATIC_NEGATIVE_PROMPT

    dn = director_narrative or {}
    plans_json = _json.dumps(visual_plans, indent=2, ensure_ascii=True)

    # Build a rich character anchor block — inject from brief if vision anchors are empty
    vision_anchors = list(vision.get("character_anchors") or [])
    if not vision_anchors and brief:
        extracted = _extract_character_anchor_from_brief(brief)
        if extracted:
            vision_anchors = [extracted]
    vision_anchors = vision_anchors[:8]

    anchors_block = (
        "\n".join(f"  - {a}" for a in vision_anchors)
        if vision_anchors
        else "  (none — describe subjects generically from scene context)"
    )

    # Detect if subject is Italian/European for negative prompt instruction
    is_italian_brief = bool(brief and _extract_character_anchor_from_brief(brief))
    ethnicity_note = ""
    if is_italian_brief:
        anchor_check = _extract_character_anchor_from_brief(brief) or ""
        if any(eth in anchor_check.lower() for eth in ("italian", "mediterranean", "spanish", "french", "european")):
            ethnicity_note = "\nETHNICITY ENFORCEMENT: Subject is Italian/Mediterranean/European. Add 'asian, chinese, east asian, korean, japanese' to negative_prompt for EVERY slot."

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
{narrative_context}{ethnicity_note}
=== CHARACTER ANCHORS (paste verbatim into every frame prompt that shows the character) ===
{anchors_block}

=== DP VISUAL PLANS ===
{plans_json}

negative_prompt base for every slot: "{CINEMATIC_NEGATIVE_PROMPT}"

For EACH plan (same order) output one prompts entry with ALL fields:
slot_id, scene_prompt, first_frame_prompt, last_frame_prompt,
ltx_video_prompt (LTX 2.3 paragraph per structure above — REQUIRED),
motion_prompt, negative_prompt.

Output JSON: {{"prompts":[...]}}"""


REEL_SUBJECT_SYSTEM = """You are a professional art director for AI video production.
Given a project brief and story direction, extract the MAIN CHARACTER's visual description.
This will be injected verbatim into every AI image generation prompt for consistency.

Rules:
- Describe physical appearance precisely: face shape, eye color, hair texture/length/color, skin tone, body type, estimated age
- Describe wardrobe: specific clothing items, colors, fabric, fit, accessories
- Name 2-3 unique visual anchors (distinctive elements that identify this character in every frame)
- Write in English, present tense, dense and specific -- no plot descriptions, only visual details
- Keep subject_card to 80-120 words

Output ONLY valid JSON (no markdown):
{"subject_card": "...", "visual_anchors": ["anchor1", "anchor2", "anchor3"], "wardrobe": ""}"""
