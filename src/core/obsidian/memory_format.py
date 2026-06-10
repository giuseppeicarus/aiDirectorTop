"""
Formattazione note Obsidian per memoria regia AI — leggibile da umani e da LLM.
"""

from __future__ import annotations

import json
from typing import Any, Optional


def _bullet_list(items: list[Any], *, limit: int = 24) -> str:
    if not items:
        return "- _(vuoto)_\n"
    lines = []
    for x in items[:limit]:
        lines.append(f"- {x}")
    if len(items) > limit:
        lines.append(f"- _… +{len(items) - limit} altri_")
    return "\n".join(lines) + "\n"


def format_project_brief(inp: dict[str, Any]) -> str:
    """Brief progetto cinematic — Memory/00-Project-Brief.md"""
    chars = inp.get("characters") or []
    char_block = ""
    for c in chars[:12]:
        if isinstance(c, dict):
            char_block += (
                f"\n### {c.get('name', '?')}\n"
                f"- Aspetto: {c.get('description', '')}\n"
                f"- Wardrobe: {c.get('wardrobe', '')}\n"
                f"- Anchor: {c.get('visual_anchor', '')}\n"
            )
    _none_chars = "\n_(nessuno)_\n"
    return (
        f"# Brief produzione\n\n"
        f"## Identità\n"
        f"- **Titolo:** {inp.get('title', '')}\n"
        f"- **Genere:** {inp.get('genre', '')}\n"
        f"- **Aspect:** {inp.get('aspect_ratio', '')}\n"
        f"- **Runtime target:** {inp.get('runtime_target_sec', '')}s\n\n"
        f"## Storia\n{inp.get('story_brief', '')}\n\n"
        f"## Stile & mood\n"
        f"- Riferimenti stile: {', '.join(inp.get('style_references') or []) or '—'}\n"
        f"- Mood: {', '.join(inp.get('mood_references') or []) or '—'}\n\n"
        f"## Personaggi{char_block or _none_chars}\n"
        f"## Lyrics (estratto)\n```\n{(inp.get('lyrics') or '')[:2000]}\n```\n"
    )


def format_story_analysis_md(data: dict[str, Any]) -> str:
    return (
        "# Story Analysis (LLM 1)\n\n"
        f"## Sintesi\n{data.get('narrative_summary', '')}\n\n"
        f"## Temi\n{_bullet_list(data.get('themes') or [])}\n"
        f"## Metafore visive\n{_bullet_list(data.get('visual_metaphors') or [])}\n"
        f"## Motivi suggeriti\n{_bullet_list(data.get('suggested_motifs') or [])}\n"
        f"## Color mood\n{data.get('color_mood', '')}\n\n"
        f"## Pacing\n{data.get('pacing_notes', '')}\n\n"
        f"## Progressione emotiva\n```json\n"
        f"{json.dumps((data.get('emotion_progression') or [])[:30], indent=2, ensure_ascii=False)}\n```\n"
    )


def format_story_arc_md(arc: dict[str, Any]) -> str:
    lines = [
        "# Story Arc (LLM 2)\n",
        f"**Logline:** {arc.get('logline', '')}\n",
        f"**Titolo:** {arc.get('title', '')}\n",
        f"**Motivi:** {', '.join(arc.get('visual_motifs') or [])}\n",
        f"**Palette:** {', '.join(arc.get('color_palette') or [])}\n",
    ]
    for seq in arc.get("sequences") or []:
        lines.append(f"\n## Sequenza `{seq.get('id', '')}` — {seq.get('title', '')}")
        lines.append(f"- Ruolo: {seq.get('narrative_role', '')} | Emotion arc: {seq.get('emotion_arc', '')}")
        for sc in seq.get("scenes") or []:
            lines.append(f"\n### Scena `{sc.get('id', '')}` — {sc.get('title', '')}")
            lines.append(
                f"- Location: {sc.get('location', '')} | "
                f"Time: {sc.get('time_of_day', '')} | Mood: {sc.get('mood', '')} | Trigger: {sc.get('trigger', '')}"
            )
            shots = sc.get("shots") or []
            if shots:
                lines.append(f"- Shot pianificati: {len(shots)}")
    lines.append("\n## JSON completo\n```json\n")
    lines.append(json.dumps(arc, indent=2, ensure_ascii=False)[:12000])
    lines.append("\n```\n")
    return "\n".join(lines)


def format_director_narrative_md(dn: dict[str, Any], *, pipeline: str) -> str:
    """Narrativa regia reel/trailer — Story-Arc.md"""
    return (
        f"# Regia narrativa ({pipeline})\n\n"
        f"**Logline:** {dn.get('logline', '')}\n\n"
        f"**Mood:** {dn.get('mood', '')}\n\n"
        f"**Tema visivo:** {dn.get('visual_theme', '')}\n\n"
        f"## Arco\n{dn.get('narrative_arc', '')}\n\n"
        f"## Motivi visivi\n{_bullet_list(dn.get('visual_motifs') or [])}\n"
        f"## Regole continuità\n{_bullet_list(dn.get('continuity_rules') or [])}\n"
        f"## Slot / beat\n```json\n"
        f"{json.dumps(dn.get('slots') or dn.get('beats') or [], indent=2, ensure_ascii=False)[:8000]}\n```\n"
    )


def format_visual_plans_md(plans: Any) -> str:
    if isinstance(plans, dict):
        items = list(plans.values())
    elif isinstance(plans, list):
        items = plans
    else:
        items = []
    body = "# Visual Plans (DP)\n\nPiano visivo per slot — inquadratura, luce, movimento.\n\n"
    for p in items[:40]:
        if not isinstance(p, dict):
            continue
        sid = p.get("slot_id") or p.get("clip_id") or "?"
        body += (
            f"## Slot `{sid}`\n"
            f"- Shot type: {p.get('shot_type', p.get('camera_shot', ''))}\n"
            f"- Camera: {p.get('camera_movement', p.get('movement', ''))}\n"
            f"- Lens: {p.get('lens_mm', '')}mm\n"
            f"- Lighting: {p.get('lighting', '')}\n"
            f"- Emotion: {p.get('emotion', p.get('energy', ''))}\n"
            f"- Scene: {p.get('scene_description', p.get('scene_prompt', ''))[:400]}\n\n"
        )
    if items:
        body += f"\n## JSON\n```json\n{json.dumps(items[:20], indent=2, ensure_ascii=False)[:10000]}\n```\n"
    return body


def format_edl_md(edl: dict[str, Any]) -> str:
    slots = edl.get("slots") or []
    body = (
        f"# EDL — Edit Decision List\n\n"
        f"- Durata totale: {edl.get('total_duration_sec', '—')}s\n"
        f"- Slot: {len(slots)}\n\n"
    )
    for s in slots[:60]:
        if not isinstance(s, dict):
            continue
        body += (
            f"## `{s.get('slot_id', s.get('id', '?'))}`\n"
            f"- Timeline: {s.get('start_sec', '')} → {s.get('end_sec', '')}s "
            f"({s.get('duration_sec', '')}s)\n"
            f"- Audio src: {s.get('audio_src_start_sec', '')} → {s.get('audio_src_end_sec', '')}\n"
            f"- Lyric: {(s.get('lyric_line') or s.get('lyrics_segment') or '')[:120]}\n"
            f"- Energy: {s.get('energy', '')} | Emotion: {s.get('emotion', '')}\n\n"
        )
    return body


def format_continuity_md(report: dict[str, Any]) -> str:
    errors = report.get("errors") or []
    corrections = report.get("corrections") or []
    err_lines = [
        f"{e.get('shot_id', '?')}: {e.get('issue', e.get('message', ''))}"
        for e in errors if isinstance(e, dict)
    ]
    fix_lines = [
        f"{c.get('shot_id', '?')}: {c.get('suggestion', c.get('fix', ''))}"
        for c in corrections if isinstance(c, dict)
    ]
    return (
        "# Continuity Report (LLM 5)\n\n"
        f"- **Approvato:** {report.get('approved', False)}\n"
        f"- **Errori critici:** {report.get('critical_count', 0)}\n\n"
        f"## Errori\n{_bullet_list(err_lines, limit=40)}"
        f"## Correzioni suggerite\n{_bullet_list(fix_lines, limit=40)}"
        f"\n## JSON\n```json\n{json.dumps(report, indent=2, ensure_ascii=False)[:8000]}\n```\n"
    )


def format_shot_regia_md(shot: dict[str, Any]) -> str:
    cam = shot.get("camera") or {}
    light = shot.get("lighting") or {}
    ff = shot.get("first_frame") or {}
    lf = shot.get("last_frame") or {}
    chars = shot.get("characters") or []
    char_txt = ""
    for ch in chars[:6]:
        if isinstance(ch, dict):
            char_txt += f"- {ch.get('name', '?')}: {ch.get('action', '')} ({ch.get('expression', '')})\n"
    _none_chars2 = "- _(nessuno)_\n"
    return (
        f"# Shot `{shot.get('shot_id', '')}`\n\n"
        f"## Regia\n"
        f"- Sequence: `{shot.get('sequence_id', '')}` | Scene: `{shot.get('scene_id', '')}`\n"
        f"- Time: {shot.get('time_start', '')} → {shot.get('time_end', '')} ({shot.get('duration_sec', '')}s)\n"
        f"- Location: {shot.get('location', '')}\n"
        f"- Emotion: {shot.get('emotion', '')}\n"
        f"- Lyrics: {(shot.get('lyrics_segment') or '')[:200]}\n\n"
        f"## Camera\n"
        f"- Type: {cam.get('shot_type', '')} | Move: {cam.get('movement', '')}\n"
        f"- Lens: {cam.get('lens_mm', '')}mm | DoF: {cam.get('depth_of_field', '')}\n"
        f"- Special: {cam.get('special', '') or '—'}\n\n"
        f"## Lighting\n"
        f"- Time: {light.get('time_of_day', '')} | Mood: {light.get('mood', '')}\n"
        f"- Sources: {', '.join(light.get('sources') or [])}\n\n"
        f"## Transizioni\n"
        f"- In: {shot.get('transition_in', '')} | Out: {shot.get('transition_out', '')}\n\n"
        f"## Personaggi\n{char_txt or _none_chars2}\n"
        f"## Continuity notes\n{_bullet_list(shot.get('continuity_notes') or [])}\n"
        f"## Prompts\n"
        f"### First frame (seed {ff.get('seed', '')})\n{ff.get('prompt', '')}\n\n"
        f"### Last frame (seed {lf.get('seed', '')})\n{lf.get('prompt', '')}\n\n"
        f"### Motion\n{shot.get('motion_prompt', '')}\n\n"
        f"### LTX global\n{shot.get('ltx_global_prompt', '')}\n\n"
        f"## Scene description\n{shot.get('scene_description', '')}\n"
    )


def format_lyric_timing_md(beats: list[dict]) -> str:
    body = "# Lyric timing\n\nDistribuzione righe testo sulla timeline reel (da testo manuale + sezioni audio).\n\n"
    for b in beats[:80]:
        if not isinstance(b, dict):
            continue
        body += (
            f"## {b.get('time_sec', '?')}s → {b.get('end_sec', '?')}s\n"
            f"- **Riga:** {b.get('lyric_line', '')}\n"
            f"- Energy: {b.get('energy', '')} | Emotion: {b.get('emotion', '')}\n"
            f"- Visual hint: {b.get('suggested_visual', '')}\n\n"
        )
    if len(beats) > 80:
        body += f"_… +{len(beats) - 80} righe_\n"
    body += f"\n## JSON\n```json\n{json.dumps(beats[:40], indent=2, ensure_ascii=False)[:8000]}\n```\n"
    return body


def format_production_config_md(req: dict[str, Any], *, pipeline: str) -> str:
    return (
        f"# Config produzione ({pipeline})\n\n"
        f"- txt2img: `{req.get('txt2img_workflow', '—')}`\n"
        f"- img2video: `{req.get('img2video_workflow', '—')}`\n"
        f"- Aspect: `{req.get('aspect_ratio', '')}` | {req.get('width', '')}×{req.get('height', '')} @ {req.get('fps', '')}fps\n"
        f"- Durata: {req.get('duration_sec', '')}s | max clip: {req.get('max_clip_sec', '')}s\n"
        f"- Backend clip: `{req.get('clip_backend', 'auto')}`\n"
        f"- Style: {req.get('style', '')[:500]}\n\n"
        f"## Model overrides\n```json\n"
        f"{json.dumps(req.get('model_overrides') or {}, indent=2, ensure_ascii=False)[:4000]}\n```\n"
    )


def format_final_deliverable_md(final: dict[str, Any], *, pipeline: str) -> str:
    return (
        f"# Output finale ({pipeline})\n\n"
        f"- **Video:** `{final.get('video_path', '—')}`\n"
        f"- URL API: `{final.get('video_url', '—')}`\n"
        f"- Durata: {final.get('duration_sec', '—')}s\n"
        f"- Risoluzione: {final.get('width', '')}×{final.get('height', '')} @ {final.get('fps', '')}fps\n"
        f"- Clip usate: {final.get('clip_count', '—')}\n"
        f"- Dimensione: {final.get('size_bytes', '—')} bytes\n"
        f"- Audio master: `{final.get('trailer_audio_path', final.get('audio_path', '—'))}`\n"
    )


def format_shot_list_overview_md(shots: list[dict]) -> str:
    body = "# Shot list (cinematic pipeline)\n\nRiepilogo inquadrature per continuità e prompt.\n\n"
    for sh in shots[:50]:
        if not isinstance(sh, dict):
            continue
        cam = sh.get("camera") or {}
        body += (
            f"## `{sh.get('shot_id', '?')}`\n"
            f"- {sh.get('time_start', '')} → {sh.get('time_end', '')} | {sh.get('location', '')}\n"
            f"- Camera: {cam.get('shot_type', '')} / {cam.get('movement', '')}\n"
            f"- Emotion: {sh.get('emotion', '')} | Lyrics: {(sh.get('lyrics_segment') or '')[:80]}\n"
            f"- Motion: {(sh.get('motion_prompt') or '')[:120]}\n\n"
        )
    return body


def format_execution_journal_append(
    *,
    ts: str,
    phase_label: str,
    phase_num: Any,
    pipeline: str,
    project_id: str,
    job_id: str,
    clips_total: int,
    clips_ready: int,
    storyboard_approved: bool,
    extra: Optional[dict] = None,
) -> str:
    extra = extra or {}
    lines = [
        f"\n## {ts} — `{phase_label}` (phase {phase_num})\n",
        f"- pipeline: {pipeline} | project: `{project_id}` | job: `{job_id}`\n",
        f"- clip pronte: {clips_ready}/{clips_total}\n",
        f"- storyboard approvato: {storyboard_approved}\n",
    ]
    for k, v in extra.items():
        if v is not None:
            lines.append(f"- {k}: {v}\n")
    return "".join(lines)


def format_regia_memory_index(
    *,
    pipeline: str,
    project_id: str,
    job_id: str = "",
    completed_stages: Optional[list[str]] = None,
    phase_label: str = "",
) -> str:
    stages = completed_stages or []
    phase_line = f"- **Fase corrente:** `{phase_label}`\n" if phase_label else ""
    reel_links = ""
    if pipeline in ("reel", "trailer"):
        reel_links = (
            f"- [[Memory/02-Audio-Analysis]]\n"
            f"- [[Memory/03-Lyric-Timing]]\n"
            f"- [[Memory/03-Slot-Lyrics]]\n"
            f"- [[Visual-Plans]]\n"
            f"- [[EDL]]\n"
            f"- [[Memory/06-Production-Config]]\n"
            f"- [[Memory/10-Execution-Journal]]\n"
            f"- [[Memory/08-Final-Deliverable]]\n"
        )
    cinematic_links = ""
    if pipeline == "cinematic":
        cinematic_links = (
            f"- [[Memory/03-Shot-List]]\n"
            f"- [[Memory/09-Pipeline-Stages]]\n"
            f"- [[Memory/08-Final-Deliverable]]\n"
        )
    return (
        f"# Memoria regia — {pipeline}\n\n"
        f"> SSOT per LLM CinematicAI. Aggiornato automaticamente ad ogni checkpoint pipeline.\n\n"
        f"- **project_id:** `{project_id}`\n"
        f"- **job_id:** `{job_id or '—'}`\n"
        f"- **Stage completati:** {', '.join(stages) if stages else '—'}\n"
        f"{phase_line}\n"
        f"## Come usare (agenti LLM)\n"
        f"1. Leggere [[Memory/00-Project-Brief]] e [[Story-Arc]]\n"
        f"2. Audio + lirica → EDL → piano visivo → note clip/shot\n"
        f"3. [[Memory/10-Execution-Journal]] per storico decisioni ed esiti\n"
        f"4. [[00-Studio/LTX-2-3-Prompt-Guide]] per prompt video LTX\n\n"
        f"## Collegamenti rapidi\n"
        f"- [[Story-Arc]]\n"
        f"- [[Memory/01-Story-Analysis]]\n"
        f"- [[Memory/04-Continuity]]\n"
        f"- [[Audio-Timeline]]\n"
        f"{reel_links}{cinematic_links}"
    )
