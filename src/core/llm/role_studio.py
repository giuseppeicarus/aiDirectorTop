"""Studio Regia AI — assegnazione modelli LLM per ruolo pipeline."""

from __future__ import annotations

import json
import re
from typing import Any

from src.core.llm.style_improve import _try_parse_json, openai_message_text

# Allineato a ROLES_META in SettingsScreen (5 agenti regia)
STUDIO_ROLES: list[str] = [
    "story_analyst",
    "narrative_director",
    "cinematographer",
    "prompt_engineer",
    "continuity_checker",
]

ROLE_LABELS: dict[str, tuple[str, str]] = {
    "story_analyst": (
        "Analista Narrativo",
        "Analizza brief, liriche e mappa emotiva; serve creatività linguistica e sensibilità musicale.",
    ),
    "narrative_director": (
        "Regista Narrativo",
        "Costruisce arco narrativo gerarchico; serve ragionamento strutturato e coerenza lunga.",
    ),
    "cinematographer": (
        "Direttore della Fotografia",
        "Shot list, camera, luce; output JSON grande, serve precisione tecnica e vocabolario cinema.",
    ),
    "prompt_engineer": (
        "Prompt Engineer",
        "Prompt immagine/video dettagliati; serve aderenza formato e ricchezza descrittiva visiva.",
    ),
    "continuity_checker": (
        "Supervisore Continuità",
        "Revisione errori tra clip; serve logica, bassa temperatura, attenzione ai dettagli.",
    ),
}

DEFAULT_TEMPS: dict[str, float] = {
    "story_analyst": 0.85,
    "narrative_director": 0.70,
    "cinematographer": 0.55,
    "prompt_engineer": 0.65,
    "continuity_checker": 0.20,
}

DEFAULT_MAX_TOKENS: dict[str, int] = {
    "story_analyst": 2000,
    "narrative_director": 4000,
    "cinematographer": 6000,
    "prompt_engineer": 8000,
    "continuity_checker": 3000,
}


def normalize_model_id(suggested: str, available: list[str]) -> str:
    """Mappa il modello suggerito dall'LLM alla lista reale del provider."""
    s = (suggested or "").strip()
    if not s:
        return available[0] if available else ""
    if s in available:
        return s
    lower_map = {m.lower(): m for m in available}
    if s.lower() in lower_map:
        return lower_map[s.lower()]
    for m in available:
        if s.lower() in m.lower() or m.lower() in s.lower():
            return m
    return available[0] if available else s


def build_role_studio_prompt(provider: str, models: list[str]) -> str:
    roles_block = []
    for key in STUDIO_ROLES:
        label, hint = ROLE_LABELS[key]
        roles_block.append(f"- {key} ({label}): {hint}")
    models_list = "\n".join(f"  - {m}" for m in models[:80])
    if len(models) > 80:
        models_list += f"\n  ... (+{len(models) - 80} altri)"

    return f"""Provider LLM attivo: {provider}

Modelli DISPONIBILI (scegli SOLO da questa lista, id esatto):
{models_list}

Agenti pipeline da configurare:
{chr(10).join(roles_block)}

Task: per ogni agente scegli il modello più adatto tra quelli disponibili.
Considera: capacità reasoning, context window, velocità, qualità JSON, vision se utile.
Assegna temperature coerente col ruolo (analista più alta, continuity più bassa).

Rispondi SOLO con JSON valido:
{{
  "summary": "2-3 frasi in italiano che spiegano la strategia complessiva",
  "assignments": [
    {{
      "role": "story_analyst",
      "model": "id_esatto_dalla_lista",
      "rationale": "una frase in italiano",
      "temperature": 0.85,
      "max_tokens": 2000
    }}
  ]
}}

Includi tutti e 5 i ruoli. Nessun markdown."""


def parse_role_studio_result(raw: Any, available: list[str]) -> dict[str, Any]:
    """Normalizza output LLM in summary + assignments validate."""
    data = raw
    if isinstance(raw, str):
        data = _try_parse_json(raw)
    if not isinstance(data, dict):
        raise ValueError("Risposta LLM non è un oggetto JSON")

    summary = str(data.get("summary") or data.get("studio_summary") or "").strip()
    items = data.get("assignments") or data.get("roles") or data.get("agents")
    if not isinstance(items, list):
        raise ValueError("Campo assignments mancante nella risposta LLM")

    by_role: dict[str, dict] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or item.get("id") or "").strip()
        if role not in STUDIO_ROLES:
            continue
        model = normalize_model_id(str(item.get("model") or ""), available)
        label, _ = ROLE_LABELS[role]
        by_role[role] = {
            "role": role,
            "role_label": label,
            "model": model,
            "rationale": str(item.get("rationale") or item.get("reason") or "").strip(),
            "temperature": float(item.get("temperature", DEFAULT_TEMPS[role])),
            "max_tokens": int(item.get("max_tokens", DEFAULT_MAX_TOKENS[role])),
        }

    missing = [r for r in STUDIO_ROLES if r not in by_role]
    if missing and available:
        fallback = available[0]
        for role in missing:
            label, hint = ROLE_LABELS[role]
            by_role[role] = {
                "role": role,
                "role_label": label,
                "model": fallback,
                "rationale": f"Assegnazione di fallback — {hint[:80]}",
                "temperature": DEFAULT_TEMPS[role],
                "max_tokens": DEFAULT_MAX_TOKENS[role],
            }

    assignments = [by_role[r] for r in STUDIO_ROLES if r in by_role]
    if not assignments:
        raise ValueError("Nessuna assegnazione valida dal modello")

    if not summary:
        summary = "Configurazione ottimizzata per equilibrio tra creatività narrativa, precisione tecnica e controllo continuità."

    return {"summary": summary, "assignments": assignments}


async def call_role_studio_llm(adapter, user_prompt: str) -> dict:
    """Chiamata LLM per lo studio (senza retry Tenacity)."""
    system = (
        "You are a senior AI systems architect for cinematic production pipelines. "
        "Assign the best available LLM model to each specialized agent role. "
        "Respond with a single JSON object only."
    )
    if hasattr(adapter, "_inject_language"):
        system = adapter._inject_language(system)

    return await adapter.generate_json(
        system=system,
        user=user_prompt,
        temperature=0.4,
        max_tokens=2500,
    )
