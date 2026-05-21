"""
LLM 3 — Cinematographer
Trasforma lo StoryArc in shot list professionale con camera direction completa.
"""

import structlog
from typing import List
from src.core.llm.factory import get_llm_adapter
from src.core.llm.cinematic_prompts import CINEMATOGRAPHER_SYSTEM, build_cinematographer_prompt
from src.core.models.cinematic import StoryArc, CinematicShot, ProjectInput, AudioAnalysis, ShotMemory
from src.core.config import get_config

log = structlog.get_logger()


async def generate_shot_list(
    arc: StoryArc,
    inp: ProjectInput,
    audio: AudioAnalysis | None = None,
) -> List[CinematicShot]:
    """LLM 3: genera la shot list cinematografica completa."""
    config = get_config()
    role_cfg = config.get_llm_for_role("cinematographer")
    adapter = get_llm_adapter(role_cfg)

    log.info("cinematographer_start")

    # Genera lo shot list in blocchi per scene (memory injection)
    all_shots: List[CinematicShot] = []
    prev_memory: dict | None = None

    for sequence in arc.sequences:
        for scene in sequence.scenes:
            raw = await adapter.generate_json(
                system=CINEMATOGRAPHER_SYSTEM,
                user=build_cinematographer_prompt(arc, inp, audio, prev_memory, sequence, scene),
                temperature=getattr(role_cfg, "temperature", 0.55),
                max_tokens=6000,
            )

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
                    scene_shots.append(CinematicShot(**s))
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

    log.info("cinematographer_done", total_shots=len(all_shots))
    return all_shots
