"""
LLM 3 — Cinematographer
Trasforma lo StoryArc in shot list professionale con camera direction completa.
"""

import structlog
from typing import List
from src.core.llm.factory import get_llm_adapter
from src.core.llm.cinematic_prompts import CINEMATOGRAPHER_SYSTEM, build_cinematographer_prompt
from src.core.models.cinematic import StoryArc, CinematicShot, ProjectInput, AudioAnalysis, ShotMemory, StoryAnalysis
from src.core.config import get_config

log = structlog.get_logger()


def _coerce_shot(s: dict) -> dict:
    """Coerce common LLM format deviations into valid CinematicShot fields.

    Some local models return camera/lighting/music_sync as strings instead of
    nested dicts. This converts them to minimal valid dicts so Pydantic
    doesn't raise ValidationError and silently drop the shot.
    """
    if not isinstance(s, dict):
        return s

    # camera: "medium close-up with slow dolly_in" → dict
    if "camera" in s and not isinstance(s["camera"], dict):
        cam_str = str(s.get("camera", ""))
        s = dict(s)
        s["camera"] = {
            "shot_type": "medium",
            "movement": "static",
            "lens_mm": 35,
            "depth_of_field": "medium",
            "_raw": cam_str,  # will be ignored by extra='ignore'
        }

    # lighting: string → dict
    if "lighting" in s and not isinstance(s["lighting"], dict):
        lit_str = str(s.get("lighting", ""))
        s = dict(s)
        s["lighting"] = {
            "time_of_day": "afternoon",
            "mood": "neutral",
            "sources": ["natural"],
            "_raw": lit_str,
        }

    # music_sync: string → dict
    if "music_sync" in s and not isinstance(s["music_sync"], dict):
        s = dict(s)
        s["music_sync"] = {"bass": "", "snare": "", "vocals": "", "beat_cuts": False}

    # characters: dict → list
    if "characters" in s and isinstance(s["characters"], dict):
        s = dict(s)
        s["characters"] = [s["characters"]]

    return s


async def generate_shot_list(
    arc: StoryArc,
    inp: ProjectInput,
    audio: AudioAnalysis | None = None,
    vault_context: str = "",
    analysis: StoryAnalysis | None = None,
) -> List[CinematicShot]:
    """LLM 3: genera la shot list cinematografica completa."""
    config = get_config()
    role_cfg = config.get_llm_for_role("cinematographer")
    adapter = get_llm_adapter(role_cfg)

    log.info("cinematographer_start", sequences=len(arc.sequences))

    if not arc.sequences:
        raise RuntimeError(
            "LLM 2 (Narrative Director) ha restituito un arco narrativo senza sequenze. "
            "Controlla il log del backend per l'output dell'LLM. "
            "Prova a resettare la pipeline da 'narrative_arc' e riprovare."
        )

    # Genera lo shot list in blocchi per scene (memory injection)
    all_shots: List[CinematicShot] = []
    prev_memory: dict | None = None
    # Per-scene max_tokens: 2000 is enough for 2-3 shots; avoids saturating small local models.
    scene_max_tokens = min(getattr(role_cfg, "max_tokens", 2000), 2000)

    for sequence in arc.sequences:
        for scene in sequence.scenes:
            try:
                raw = await adapter.generate_json(
                    system=CINEMATOGRAPHER_SYSTEM,
                    user=(vault_context or "") + build_cinematographer_prompt(
                        arc, inp, audio, prev_memory, sequence, scene,
                        analysis=analysis,
                    ),
                    temperature=getattr(role_cfg, "temperature", 0.55),
                    max_tokens=scene_max_tokens,
                )
            except Exception as e:
                log.error("cinematographer_scene_failed",
                          scene=getattr(scene, 'id', '?'),
                          sequence=getattr(sequence, 'id', '?'),
                          error=str(e))
                # Skip this scene and continue — don't block the whole pipeline
                continue

            # Unwrap response — LLM may return array or wrapped object
            if isinstance(raw, list):
                shots_raw = raw
            else:
                shots_raw = None
                for key in ("shots", "result", "data", "shot_list", "items", "scene_shots", "frames"):
                    if key in raw and isinstance(raw[key], list):
                        shots_raw = raw[key]
                        break
                if shots_raw is None:
                    for v in raw.values():
                        if isinstance(v, list) and v:
                            shots_raw = v
                            break
                if shots_raw is None:
                    shots_raw = []
                    log.warning("cinematographer_no_list_found", keys=list(raw.keys()))

            log.info("cinematographer_scene_raw", count=len(shots_raw),
                     scene=getattr(scene, 'id', '?'))

            scene_shots = []
            for s in shots_raw:
                try:
                    scene_shots.append(CinematicShot(**_coerce_shot(s)))
                except Exception as e:
                    log.warning("cinematographer_shot_parse_failed", error=str(e),
                                shot_keys=list(s.keys()) if isinstance(s, dict) else type(s).__name__)
            all_shots.extend(scene_shots)

            # Aggiorna memory con l'ultimo shot della scena
            if scene_shots:
                last = scene_shots[-1]
                prev_memory = {
                    "shot_id": last.shot_id,
                    "location": last.location,
                    "lighting": last.lighting.model_dump(),
                    "camera_last": last.camera.model_dump(),
                    "emotion": last.emotion,
                    "continuity_notes": last.continuity_notes,
                }

    total_scenes = sum(len(seq.scenes) for seq in arc.sequences)
    log.info("cinematographer_done", total_shots=len(all_shots), scenes=total_scenes)

    if not all_shots:
        raise RuntimeError(
            f"LLM 3 (Cinematographer) ha generato 0 shot su {total_scenes} scene "
            f"({len(arc.sequences)} sequenze). "
            "L'LLM probabilmente non riesce a seguire il formato JSON richiesto. "
            "Prova un modello più grande o resetta lo stage 'shot_list'."
        )

    return all_shots
