"""
LLM 5 — Continuity Checker
Verifica errori di continuità nell'intera shot list.
Torna a LLM 3/4 con correzioni se trova errori critici (max 2 iterazioni).
"""

import structlog
from typing import List
from src.core.llm.factory import get_llm_adapter
from src.core.llm.cinematic_prompts import CONTINUITY_CHECKER_SYSTEM, build_continuity_checker_prompt
from src.core.models.cinematic import CinematicShot, ContinuityReport, ContinuityError
from src.core.config import get_config

log = structlog.get_logger()

CHUNK_SIZE = 10  # shot per chiamata (analizza coppie consecutive)


async def check_continuity(shot_list: List[CinematicShot]) -> ContinuityReport:
    """LLM 5: analizza la shot list e restituisce un report di continuità."""
    config = get_config()
    role_cfg = config.get_llm_for_role("continuity_checker")
    adapter = get_llm_adapter(role_cfg)

    log.info("continuity_checker_start", shots=len(shot_list))

    all_errors: List[ContinuityError] = []
    analysis_summaries: List[str] = []
    checks_set: set = set()

    # Processa in chunk sovrapposti (ogni chunk include l'ultimo shot del precedente)
    for i in range(0, len(shot_list), CHUNK_SIZE):
        # Includi l'ultimo shot del chunk precedente per verificare la transizione
        start = max(0, i - 1)
        chunk = shot_list[start:i + CHUNK_SIZE]
        chunk_dicts = [s.model_dump() for s in chunk]

        raw = await adapter.generate_json(
            system=CONTINUITY_CHECKER_SYSTEM,
            user=build_continuity_checker_prompt(chunk_dicts),
            temperature=getattr(role_cfg, "temperature", 0.20),
            max_tokens=3000,
        )

        if not isinstance(raw, dict):
            log.warning("continuity_checker_unexpected_type", type=type(raw).__name__)
            raw = {}
        if raw.get("analysis_summary"):
            analysis_summaries.append(raw["analysis_summary"])
        if raw.get("checks_performed"):
            checks_set.update(raw["checks_performed"])

        chunk_errors = raw.get("errors", [])
        for e in chunk_errors:
            try:
                all_errors.append(ContinuityError(**e))
            except Exception as parse_err:
                log.warning("continuity_error_parse_failed", error=str(parse_err))

    critical = [e for e in all_errors if e.severity == "critical"]
    warnings  = [e for e in all_errors if e.severity == "warning"]
    corrected_shots = list({sid for e in critical for sid in e.shot_ids})

    report = ContinuityReport(
        total_errors=len(all_errors),
        critical_count=len(critical),
        warning_count=len(warnings),
        errors=all_errors,
        approved=len(critical) == 0,
        corrected_shots=corrected_shots,
        analysis_summary="\n\n".join(analysis_summaries),
        checks_performed=sorted(checks_set),
    )

    log.info(
        "continuity_checker_done",
        critical=report.critical_count,
        warnings=report.warning_count,
        approved=report.approved,
    )
    return report
